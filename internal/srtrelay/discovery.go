package srtrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

const (
	tsEarlyDiscoveryWindow = 200 * time.Millisecond
	tsEarlyProbeTimeout    = 500 * time.Millisecond
	tsDiscoveryWindow      = time.Second
	tsProbeTimeout         = 3 * time.Second
	tsProbeBytes           = 16 * 1024 * 1024
	tsStartupBytes         = 32 * 1024 * 1024
)

type tsStream struct {
	Index      int    `json:"index"`
	ID         string `json:"id"`
	CodecName  string `json:"codec_name"`
	CodecType  string `json:"codec_type"`
	Channels   int    `json:"channels"`
	SampleRate string `json:"sample_rate"`
}

// Retain live bytes while probing a snapshot, then switch atomically to the
// remux pipe. Never silently drop packets if discovery cannot keep up.
type tsStartup struct {
	mu     sync.Mutex
	buffer []byte
	sink   *io.PipeWriter
	pipe   *io.PipeWriter
	err    error
}

func (b *tsStartup) Write(p []byte) (int, error) {
	b.mu.Lock()
	if b.err != nil {
		err := b.err
		b.mu.Unlock()
		return 0, err
	}
	if b.sink != nil {
		sink := b.sink
		b.mu.Unlock()
		return sink.Write(p)
	}
	defer b.mu.Unlock()
	if len(p) > tsStartupBytes-len(b.buffer) {
		b.err = errors.New("MPEG-TS discovery exceeded the 32 MiB startup buffer")
		return 0, b.err
	}
	b.buffer = append(b.buffer, p...)
	return len(p), nil
}

// The caller must cancel reader's context and close the returned pipe before
// joining done. Both packet reads and pipe writes can otherwise be blocked.
func startTSDiscovery(reader *packetReader, initial []byte, mode payloadMode) (*tsStartup, *io.PipeReader, <-chan struct{}) {
	input, output := io.Pipe()
	buffer := &tsStartup{buffer: initial, pipe: output}
	done := make(chan struct{})
	go func() {
		err := streamNormalized(reader, buffer, mode)
		buffer.mu.Lock()
		buffer.err = err
		buffer.mu.Unlock()
		_ = output.CloseWithError(err)
		close(done)
	}()
	return buffer, input, done
}

func (s *Supervisor) discoverTS(ctx context.Context, buffer *tsStartup, done <-chan struct{}) ([]tsStream, []byte, error) {
	return discoverTS(ctx, buffer, done, func(ctx context.Context, snapshot []byte) ([]tsStream, error) {
		return probeTS(ctx, s.ffprobe, snapshot)
	})
}

// Try one short current-connection snapshot, then the original discovery window.
// Both attempts retain every byte and use identical complete-program validation;
// no PID or codec decision is reused from an earlier encoder connection.
func discoverTS(ctx context.Context, buffer *tsStartup, done <-chan struct{}, probe func(context.Context, []byte) ([]tsStream, error)) ([]tsStream, []byte, error) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, tsDiscoveryWindow+tsProbeTimeout)
	defer cancel()
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		select {
		case <-done:
			cancel()
		case <-ctx.Done():
		}
	}()
	defer func() { cancel(); <-watchDone }()
	var streams []tsStream
	for _, window := range []time.Duration{tsEarlyDiscoveryWindow, tsDiscoveryWindow} {
		timer := time.NewTimer(max(0, time.Until(started.Add(window))))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, nil, fmt.Errorf("MPEG-TS discovery interrupted: %w", ctx.Err())
		case <-timer.C:
		}
		buffer.mu.Lock()
		if buffer.err != nil {
			err := buffer.err
			buffer.mu.Unlock()
			return nil, nil, err
		}
		if len(buffer.buffer) > tsProbeBytes {
			buffer.mu.Unlock()
			return nil, nil, errors.New("MPEG-TS discovery exceeded the 16 MiB probe snapshot")
		}
		snapshot := bytes.Clone(buffer.buffer)
		buffer.mu.Unlock()
		budget := tsProbeTimeout
		if window == tsEarlyDiscoveryWindow {
			budget = tsEarlyProbeTimeout
		}
		probeCtx, stopProbe := context.WithTimeout(ctx, budget)
		var err error
		streams, err = probe(probeCtx, snapshot)
		if err == nil {
			err = probeCtx.Err()
		}
		stopProbe()
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		if err == nil {
			break
		}
		if window == tsDiscoveryWindow {
			return nil, nil, err
		}
	}
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	if buffer.err != nil {
		return nil, nil, buffer.err
	}
	replay := buffer.buffer
	buffer.buffer = nil
	buffer.sink = buffer.pipe
	return streams, replay, nil
}

func probeTS(ctx context.Context, executable string, snapshot []byte) ([]tsStream, error) {
	ctx, cancel := context.WithTimeout(ctx, tsProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable,
		"-v", "error", "-threads", "1", "-f", "mpegts",
		"-probesize", strconv.Itoa(tsProbeBytes), "-analyzeduration", "1000000",
		"-i", "pipe:0", "-show_programs", "-show_streams",
		"-show_entries", "stream=index,id,codec_name,codec_type,channels,sample_rate:program=program_id,nb_streams",
		"-of", "json")
	cmd.Stdin = bytes.NewReader(snapshot)
	stdout, stderr := newBoundedWriter(1024*1024), newBoundedWriter(4096)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("MPEG-TS stream discovery failed: %w", errors.Join(ctx.Err(), err, errors.New(stderr.String())))
	}
	return parseTSStreams([]byte(stdout.String()))
}

func parseTSStreams(data []byte) ([]tsStream, error) {
	var report struct {
		Streams  []tsStream `json:"streams"`
		Programs []struct {
			Count   int        `json:"nb_streams"`
			Streams []tsStream `json:"streams"`
		} `json:"programs"`
	}
	if err := json.Unmarshal(data, &report); err != nil {
		return nil, fmt.Errorf("invalid MPEG-TS discovery JSON: %w", err)
	}
	if len(report.Streams) == 0 || len(report.Programs) == 0 {
		return nil, errors.New("MPEG-TS discovery has no complete PAT/PMT and streams")
	}
	indices, pids := make(map[int]tsStream), make(map[uint64]bool)
	for _, stream := range report.Streams {
		pid, err := strconv.ParseUint(stream.ID, 0, 13)
		_, duplicate := indices[stream.Index]
		if err != nil || pid < 16 || pid == 8191 || pids[pid] || duplicate || stream.Index < 0 {
			return nil, errors.New("MPEG-TS discovery has missing or duplicate stream identities")
		}
		pids[pid], indices[stream.Index] = true, stream
		if stream.CodecName == "" || stream.CodecName == "unknown" || stream.CodecType == "" || stream.CodecType == "unknown" {
			return nil, fmt.Errorf("MPEG-TS PID %s codec is unresolved; refusing partial discovery", stream.ID)
		}
		if stream.CodecType == "audio" && (stream.Channels <= 0 || stream.SampleRate == "" || stream.SampleRate == "0") {
			return nil, fmt.Errorf("MPEG-TS PID %s audio parameters are incomplete", stream.ID)
		}
		if stream.CodecName == "s302m" && (stream.CodecType != "audio" || stream.SampleRate != "48000" || (stream.Channels != 2 && stream.Channels != 4 && stream.Channels != 6 && stream.Channels != 8)) {
			return nil, fmt.Errorf("MPEG-TS PID %s has unsupported SMPTE 302M parameters", stream.ID)
		}
	}
	covered := make(map[int]bool)
	for _, program := range report.Programs {
		if program.Count == 0 || program.Count != len(program.Streams) {
			return nil, errors.New("MPEG-TS discovery has an incomplete program map")
		}
		members := make(map[int]bool)
		for _, stream := range program.Streams {
			if found, ok := indices[stream.Index]; !ok || found != stream || members[stream.Index] {
				return nil, errors.New("MPEG-TS program has inconsistent stream identities")
			}
			members[stream.Index], covered[stream.Index] = true, true
		}
	}
	if len(covered) != len(indices) {
		return nil, errors.New("MPEG-TS discovery includes streams outside the program maps")
	}
	var mapped []tsStream
	// Match the existing video-then-audio mapping while preserving audio order.
	for _, kind := range []string{"video", "audio"} {
		for _, stream := range report.Streams {
			if stream.CodecType == kind {
				mapped = append(mapped, stream)
			}
		}
	}
	if len(mapped) == 0 {
		return nil, errors.New("MPEG-TS discovery has no audio or video")
	}
	return mapped, nil
}
