package srtrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func discoveryReport(streams []tsStream) []byte {
	data, _ := json.Marshal(map[string]any{"streams": streams, "programs": []any{map[string]any{"nb_streams": len(streams), "streams": streams}}})
	return data
}

func fakeTSProbe(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ffprobe")
	data := discoveryReport([]tsStream{{Index: 0, ID: "0x100", CodecType: "video", CodecName: "h264"}})
	if err := os.WriteFile(path, []byte("#!/bin/sh\ncat >/dev/null\nprintf '%s' '"+string(data)+"'\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTSDiscoveryRejectsIncompleteReports(t *testing.T) {
	audio := tsStream{Index: 1, ID: "0x101", CodecType: "audio", CodecName: "s302m", Channels: 2, SampleRate: "48000"}
	video := tsStream{ID: "0x100", CodecType: "video", CodecName: "h264"}
	valid := discoveryReport([]tsStream{audio, video})
	got, err := parseTSStreams(valid)
	if err != nil || !reflect.DeepEqual(got, []tsStream{video, audio}) {
		t.Fatalf("mapping = %v, %v", got, err)
	}
	for name, data := range map[string][]byte{
		"truncated":          valid[:len(valid)-1],
		"no PAT":             []byte(`{"streams":[{"index":0}]}`),
		"missing PMT":        bytes.Replace(valid, []byte(`"nb_streams":2`), []byte(`"nb_streams":3`), 1),
		"duplicate PID":      bytes.ReplaceAll(valid, []byte(`0x101`), []byte(`0x100`)),
		"unknown codec":      bytes.ReplaceAll(valid, []byte(`"s302m"`), []byte(`"unknown"`)),
		"missing parameters": bytes.ReplaceAll(valid, []byte(`"channels":2`), []byte(`"channels":0`)),
		"unsupported 302M":   bytes.ReplaceAll(valid, []byte(`"channels":2`), []byte(`"channels":3`)),
		"inconsistent PMT":   bytes.Replace(valid, []byte(`0x101`), []byte(`0x102`), 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseTSStreams(data); err == nil {
				t.Fatal("accepted incomplete discovery")
			}
		})
	}
}

func TestTSDiscoveryReplayAndCancellation(t *testing.T) {
	for _, mode := range []payloadMode{payloadMPEGTS, payloadRTPMP2T} {
		t.Run(mode.String(), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			packets := newFakePacketConn()
			reader := newPacketReader(ctx, packets)
			initial, during, after := []byte("initial"), bytes.Repeat([]byte{0x47}, 188), bytes.Repeat([]byte{0x47}, 376)
			buffer, pipe, done := startTSDiscovery(reader, initial, mode)
			defer func() { cancel(); pipe.Close(); <-done; reader.close() }()
			send := func(data []byte) {
				if mode == payloadRTPMP2T {
					data = testRTPPacket(33, data)
				}
				packets.reads <- packetRead{data: data}
			}
			send(during)
			s := &Supervisor{ffprobe: fakeTSProbe(t)}
			_, replay, err := s.discoverTS(ctx, buffer, done)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(replay, append(bytes.Clone(initial), during...)) {
				t.Fatal("startup bytes lost or reordered")
			}
			send(after)
			live := make([]byte, len(after))
			if _, err := io.ReadFull(pipe, live); err != nil || !bytes.Equal(live, after) {
				t.Fatalf("live replay = %x, %v", live, err)
			}
			// Cancel with a producer blocked on a pipe write, not just a UDP read.
			send(after)
			cancel()
			pipe.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("blocked startup producer")
			}
		})
	}
}

func TestTSDiscoveryBounds(t *testing.T) {
	buffer := &tsStartup{buffer: make([]byte, tsStartupBytes)}
	if n, err := buffer.Write([]byte{1}); n != 0 || err == nil {
		t.Fatal("startup buffer not bounded")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s := &Supervisor{ffprobe: "unused"}
	if _, _, err := s.discoverTS(ctx, &tsStartup{}, make(chan struct{})); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, _, err := s.discoverTS(context.Background(), &tsStartup{buffer: make([]byte, tsProbeBytes+1)}, make(chan struct{})); err == nil {
		t.Fatal("probe snapshot not bounded")
	}
	path := filepath.Join(t.TempDir(), "stalled-probe")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexec sleep 30\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := probeTS(context.Background(), path, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("probe timeout exceeded")
	}
	ctx, cancel = context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := probeTS(ctx, path, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
}

// Runs with the same Alpine FFmpeg as the deployed image; no live source needed.
func TestSelective302MFFmpeg(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		if os.Getenv("REQUIRE_FFMPEG_TESTS") == "1" {
			t.Fatal(err)
		}
		t.Skip("FFmpeg integration requires ffmpeg and ffprobe")
	}
	run := func(input []byte, executable string, args ...string) []byte {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, executable, args...)
		cmd.Stdin = bytes.NewReader(input)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", executable, args, err, stderr.String())
		}
		return out
	}
	for _, tc := range []struct {
		name     string
		codecs   []string
		channels int
		multi    bool
	}{
		{"eight-pairs", []string{"s302m", "s302m", "s302m", "s302m", "s302m", "s302m", "s302m", "s302m"}, 2, false},
		{"mixed-nonfirst-multiprogram", []string{"aac", "ac3", "s302m", "libopus", "s302m"}, 2, true},
		{"AAC", []string{"aac"}, 2, false}, {"AC3-surround", []string{"ac3"}, 6, false},
		{"Opus", []string{"libopus"}, 2, false}, {"video-only", nil, 2, false},
		{"302M-four", []string{"s302m"}, 4, false}, {"302M-six", []string{"s302m"}, 6, false}, {"302M-eight", []string{"s302m"}, 8, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := []string{"-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-f", "lavfi", "-i", "aevalsrc=0.2*sin(2*PI*440*t)|0.05*sin(2*PI*880*t):s=48000", "-map", "0:v"}
			for range tc.codecs {
				args = append(args, "-map", "1:a")
			}
			args = append(args, "-c:v", "libx264", "-threads:v", "1", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "25")
			for i, codec := range tc.codecs {
				spec := strconv.Itoa(i)
				args = append(args, "-c:a:"+spec, codec, "-ac:a:"+spec, strconv.Itoa(tc.channels), "-threads:a:"+spec, "1")
			}
			if tc.multi {
				args = append(args, "-program", "program_num=1:st=0:st=1:st=2", "-program", "program_num=2:st=3:st=4:st=5")
			}
			args = append(args, "-strict", "-2", "-t", "2", "-output_ts_offset", "17", "-f", "mpegts", "pipe:1")
			input := run(nil, "ffmpeg", args...)
			streams, err := probeTS(context.Background(), "ffprobe", input)
			if err != nil {
				t.Fatal(err)
			}
			if len(streams) != len(tc.codecs)+1 {
				t.Fatalf("discovered %d streams", len(streams))
			}
			if tc.name == "eight-pairs" {
				ctx, cancel := context.WithCancel(context.Background())
				packets := &fakePacketConn{reads: make(chan packetRead, len(input)/1316+2)}
				reader := newPacketReader(ctx, packets)
				buffer, pipe, done := startTSDiscovery(reader, input[:564], payloadMPEGTS)
				defer func() { cancel(); pipe.Close(); <-done; reader.close() }()
				for offset := 564; offset < len(input); offset += 1316 {
					packets.reads <- packetRead{data: input[offset:min(offset+1316, len(input))]}
				}
				found, replay, err := (&Supervisor{ffprobe: "ffprobe"}).discoverTS(ctx, buffer, done)
				if err != nil || !reflect.DeepEqual(found, streams) || !bytes.Equal(input, replay) {
					t.Fatalf("real discovery/replay failed: %v", err)
				}
				input = replay
			}
			if tc.multi {
				// PAT still announces both programs, but the second PMT never arrives.
				var partial []byte
				for offset := 0; offset+188 <= len(input); offset += 188 {
					pid := int(input[offset+1]&31)<<8 | int(input[offset+2])
					if pid != 4097 {
						partial = append(partial, input[offset:offset+188]...)
					}
				}
				if _, err := probeTS(context.Background(), "ffprobe", partial); err == nil {
					t.Fatal("accepted absent second PMT")
				}
			}
			output := run(input, "ffmpeg", remuxArgs("pipe:1", "", streams)...)
			converted, err := probeTS(context.Background(), "ffprobe", output)
			if err != nil || len(converted) != len(streams) {
				t.Fatalf("output streams %v: %v", converted, err)
			}
			if tc.name == "AC3-surround" {
				layoutArgs := []string{"-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channel_layout", "-of", "json", "-i", "pipe:0"}
				for _, data := range [][]byte{input, output} {
					if layout := run(data, "ffprobe", layoutArgs...); !bytes.Contains(layout, []byte("5.1(side)")) {
						t.Fatalf("AC3 surround layout lost: %s", layout)
					}
				}
			}
			for i, stream := range streams {
				out := converted[i]
				if stream.CodecName == "s302m" {
					if out.CodecName != "opus" || out.Channels != 2 || out.SampleRate != "48000" {
						t.Fatalf("302M output %+v", out)
					}
					levels := run(output, "ffmpeg", "-v", "info", "-i", "pipe:0", "-map", "0:"+strconv.Itoa(i), "-af", "astats=metadata=1:reset=0,ametadata=print:file=-", "-f", "null", "-")
					if !strings.Contains(string(levels), "lavfi.astats.1.RMS_level=-17.") || !strings.Contains(string(levels), "lavfi.astats.2.RMS_level=-29.") {
						t.Fatalf("known independent stereo levels not retained: %.500s", levels)
					}
					continue
				}
				if stream.CodecName != out.CodecName || stream.Channels != out.Channels {
					t.Fatalf("copy changed %+v to %+v", stream, out)
				}
				// Packet hashes AND PTS/DTS prove copy, including AC3 5.1(side).
				packetArgs := []string{"-v", "error", "-select_streams", strconv.Itoa(i), "-show_packets", "-show_data_hash", "sha256", "-show_entries", "packet=pts,dts,data_hash", "-of", "json", "-i", "pipe:0"}
				before := run(input, "ffprobe", packetArgs...)
				after := run(output, "ffprobe", packetArgs...)
				// PES framing changes stream-ID side data; compare media packets only.
				type packet struct {
					PTS  int64  `json:"pts"`
					DTS  int64  `json:"dts"`
					Hash string `json:"data_hash"`
				}
				var a, b struct {
					Packets []packet `json:"packets"`
				}
				if err := json.Unmarshal(before, &a); err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(after, &b); err != nil {
					t.Fatal(err)
				}
				if len(a.Packets) == 0 || !reflect.DeepEqual(a, b) {
					t.Fatalf("copied %s packet hashes/timestamps changed\nbefore %.500s\nafter %.500s", stream.CodecName, before, after)
				}
			}
			t.Logf("verified %d tracks; converted only 302M, copied video/other audio with identical packet hashes and timestamps", len(streams))
		})
	}
}
