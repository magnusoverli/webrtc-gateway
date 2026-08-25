package compatibility

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/mediamtx"
)

const pathPrefix = "compat-"

const (
	metadataGrace        = 8 * time.Second
	probeRetryDelay      = 3 * time.Second
	workerStartupTimeout = 8 * time.Second
)

const (
	StateOffline  = "offline"
	StateProbing  = "probing"
	StateStarting = "starting"
	StateReady    = "ready"
	StateError    = "error"

	ModeDirect     = "direct"
	ModeTranscoded = "transcoded"
)

type WorkerState struct {
	Running  bool   `json:"running"`
	Queued   bool   `json:"queued,omitempty"`
	Restarts int    `json:"restarts"`
	Error    string `json:"error,omitempty"`
}

type State struct {
	State            string      `json:"state"`
	Mode             string      `json:"mode,omitempty"`
	Required         bool        `json:"required"`
	Reasons          []string    `json:"reasons"`
	LastError        string      `json:"lastError,omitempty"`
	Worker           WorkerState `json:"worker"`
	OutputPath       string      `json:"-"`
	InputFingerprint string      `json:"-"`
}

type ChannelReader interface {
	List(context.Context) ([]channel.Channel, error)
}

type MediaManager interface {
	Status(context.Context) (mediamtx.Status, error)
	ReplacePath(context.Context, string, mediamtx.PathConfig) error
	DeletePath(context.Context, string) error
}

type Options struct {
	Logger         *slog.Logger
	Channels       ChannelReader
	MediaMTX       MediaManager
	MediaRTSPURL   string
	FFmpeg         string
	FFprobe        string
	Interval       time.Duration
	ActiveInterval time.Duration
	EncoderThreads int
	WorkerCapacity int
}

type Manager struct {
	logger         *slog.Logger
	channels       ChannelReader
	media          MediaManager
	rtspURL        *url.URL
	ffmpeg         string
	ffprobe        string
	interval       time.Duration
	activeInterval time.Duration
	encoderThreads int
	workerCapacity int
	probeVideo     func(context.Context, string) (videoCharacteristics, error)
	now            func() time.Time

	mu             sync.RWMutex
	entries        map[string]*entry
	nextGeneration uint64
	nextProbeTask  uint64
	closed         bool
	workers        sync.WaitGroup
}

type entry struct {
	fingerprint             string
	generation              uint64
	srt                     bool
	metadataDeadline        time.Time
	probe                   *probeTask
	outputResetPending      bool
	classified              bool
	decision                decision
	state                   State
	worker                  *worker
	retryAt                 time.Time
	compatLimit             int
	compatAbsoluteTimestamp bool
}

type probeTask struct {
	id         uint64
	generation uint64
	ctx        context.Context
	cancel     context.CancelFunc
	done       chan struct{}
}

type worker struct {
	cancel   context.CancelFunc
	cmd      *exec.Cmd
	stderr   *ringWriter
	started  time.Time
	stopping bool
	units    int
}

type decision struct {
	required       bool
	transcodeVideo bool
	transcodeAudio bool
	videoTransform videoTransform
	reasons        []string
	videoWidth     int
	videoHeight    int
	workerUnits    int
}

type videoTransform uint8

const (
	videoTransformNone videoTransform = iota
	videoTransformDeinterlace
	videoTransformWeaveDeinterlace
)

type videoCharacteristics struct {
	codec             string
	hasBFrames        bool
	interlaced        bool
	topFieldFirst     bool
	bottomFieldFirst  bool
	pixelFormat       string
	width             int
	height            int
	hevcFieldSequence bool
}

func New(options Options) (*Manager, error) {
	if options.Logger == nil || options.Channels == nil || options.MediaMTX == nil {
		return nil, errors.New("compatibility manager dependencies are required")
	}
	parsed, err := url.Parse(options.MediaRTSPURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("MediaMTX RTSP URL must be absolute")
	}
	if options.FFmpeg == "" {
		options.FFmpeg = "ffmpeg"
	}
	if options.FFprobe == "" {
		options.FFprobe = "ffprobe"
	}
	if options.Interval <= 0 {
		options.Interval = time.Second
	}
	if options.ActiveInterval <= 0 {
		options.ActiveInterval = 100 * time.Millisecond
	}
	if options.ActiveInterval > options.Interval {
		options.ActiveInterval = options.Interval
	}
	if options.EncoderThreads <= 0 {
		options.EncoderThreads = min(6, runtime.NumCPU())
	}
	if options.WorkerCapacity <= 0 {
		options.WorkerCapacity = max(1, runtime.NumCPU()*3/4)
	}
	return &Manager{
		logger: options.Logger, channels: options.Channels, media: options.MediaMTX,
		rtspURL: parsed, ffmpeg: options.FFmpeg, ffprobe: options.FFprobe,
		interval: options.Interval, activeInterval: options.ActiveInterval,
		encoderThreads: options.EncoderThreads, workerCapacity: options.WorkerCapacity,
		entries: make(map[string]*entry),
	}, nil
}

func CompatibilityPath(channelID string) string {
	return pathPrefix + strings.ReplaceAll(channelID, "-", "")
}

func (m *Manager) Snapshot(channelID string) State {
	m.mu.RLock()
	defer m.mu.RUnlock()
	item := m.entries[channelID]
	if item == nil {
		return State{State: StateProbing, Reasons: []string{}}
	}
	result := item.state
	result.Reasons = append([]string(nil), result.Reasons...)
	return result
}

func (m *Manager) Run(ctx context.Context) {
	defer m.Close()
	m.reconcile(ctx)
	timer := time.NewTimer(m.nextInterval())
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			m.reconcile(ctx)
			timer.Reset(m.nextInterval())
		}
	}
}

func (m *Manager) nextInterval() time.Duration {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, item := range m.entries {
		if item.state.State == StateProbing || item.state.State == StateStarting || item.probe != nil {
			return m.activeInterval
		}
	}
	return m.interval
}

func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		m.workers.Wait()
		return
	}
	m.closed = true
	for _, item := range m.entries {
		cancelProbeLocked(item)
		stopWorkerLocked(item)
	}
	m.mu.Unlock()
	m.workers.Wait()
}

func (m *Manager) reconcile(ctx context.Context) {
	configured, err := m.channels.List(ctx)
	if err != nil {
		m.logger.Warn("compatibility channel list unavailable", "error", err)
		return
	}
	status, err := m.media.Status(ctx)
	if err != nil {
		m.logger.Warn("compatibility MediaMTX status unavailable", "error", err)
		return
	}
	byPath := make(map[string]mediamtx.Channel, len(status.Channels))
	for _, item := range status.Channels {
		byPath[item.Name] = item
	}

	seen := make(map[string]struct{}, len(configured))
	knownPaths := make(map[string]struct{}, len(configured))
	for _, item := range configured {
		seen[item.ID] = struct{}{}
		knownPaths[item.Path] = struct{}{}
		knownPaths[CompatibilityPath(item.ID)] = struct{}{}
		m.reconcileChannel(ctx, item, byPath)
	}

	m.mu.Lock()
	for id, item := range m.entries {
		if _, ok := seen[id]; ok {
			continue
		}
		cancelProbeLocked(item)
		stopWorkerLocked(item)
		delete(m.entries, id)
	}
	m.mu.Unlock()
	for path := range byPath {
		if strings.HasPrefix(path, pathPrefix) {
			if _, ok := knownPaths[path]; !ok {
				_ = m.media.DeletePath(ctx, path)
			}
		}
	}
}

func (m *Manager) reconcileChannel(ctx context.Context, item channel.Channel, byPath map[string]mediamtx.Channel) {
	raw := byPath[item.Path]
	compatPath := CompatibilityPath(item.ID)
	if !item.Enabled || !raw.Available || !raw.Online {
		m.setInactive(item.ID, item.Path, StateOffline)
		if _, ok := byPath[compatPath]; ok {
			_ = m.media.DeletePath(ctx, compatPath)
		}
		return
	}

	if item.Input.Mode != channel.InputSRTPush && item.Input.Mode != channel.InputSRTPull {
		m.setDirect(item.ID, item.Path, fingerprint(raw), decision{}, false)
		if _, ok := byPath[compatPath]; ok {
			if err := m.media.DeletePath(ctx, compatPath); err != nil {
				m.logger.Warn("stale compatibility path cleanup failed", "channel", item.ID, "path", compatPath, "error", err)
			}
		}
		return
	}

	fingerprint := fingerprint(raw)
	now := m.nowTime()
	tracks := cloneTracks(raw.Tracks)
	m.mu.Lock()
	current := m.entryLocked(item.ID)
	if current.fingerprint != fingerprint || !current.srt {
		cancelProbeLocked(current)
		stopWorkerLocked(current)
		m.nextGeneration++
		current.fingerprint = fingerprint
		current.generation = m.nextGeneration
		current.srt = true
		current.metadataDeadline = now.Add(metadataGrace)
		current.classified = false
		current.decision = decision{}
		current.retryAt = time.Time{}
		current.outputResetPending = byPath[compatPath].Name != ""
		current.state = State{State: StateProbing, Reasons: []string{}, OutputPath: item.Path, InputFingerprint: fingerprint}
	}
	if current.outputResetPending {
		if !current.retryAt.IsZero() && now.Before(current.retryAt) {
			m.mu.Unlock()
			return
		}
		generation := current.generation
		m.mu.Unlock()
		err := m.media.DeletePath(ctx, compatPath)
		m.mu.Lock()
		current = m.entries[item.ID]
		if current != nil && current.generation == generation && current.outputResetPending {
			if err != nil {
				current.retryAt = m.nowTime().Add(probeRetryDelay)
				current.state.State = StateError
				current.state.LastError = fmt.Sprintf("reset compatibility output: %v", err)
			} else {
				current.outputResetPending = false
				current.retryAt = time.Time{}
			}
		}
		m.mu.Unlock()
		return
	}
	if current.classified {
		knownDecision := current.decision
		m.mu.Unlock()
		if knownDecision.required {
			m.ensureTranscoded(ctx, item, knownDecision, byPath[compatPath])
		} else {
			m.setDirect(item.ID, item.Path, fingerprint, knownDecision, true)
			if _, ok := byPath[compatPath]; ok {
				_ = m.media.DeletePath(ctx, compatPath)
			}
		}
		return
	}
	if current.probe != nil || (!tracksMetadataReady(tracks) && now.Before(current.metadataDeadline)) || (!current.retryAt.IsZero() && now.Before(current.retryAt)) {
		m.mu.Unlock()
		return
	}
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.nextProbeTask++
	probeCtx, cancel := context.WithCancel(ctx)
	task := &probeTask{id: m.nextProbeTask, generation: current.generation, ctx: probeCtx, cancel: cancel, done: make(chan struct{})}
	current.probe = task
	if current.state.LastError == "" {
		current.state = State{State: StateProbing, Reasons: []string{}, OutputPath: item.Path, InputFingerprint: fingerprint}
	}
	m.workers.Add(1)
	m.mu.Unlock()
	go m.runProbe(item.ID, item.Path, fingerprint, task, tracks)
}

func (m *Manager) runProbe(channelID, path, fingerprint string, task *probeTask, tracks []mediamtx.Track) {
	defer m.workers.Done()
	defer task.cancel()
	defer close(task.done)
	probeURL := m.pathURL(path)
	result, err := classifyTracks(task.ctx, tracks, func(ctx context.Context) (videoCharacteristics, error) {
		if m.probeVideo != nil {
			return m.probeVideo(ctx, probeURL)
		}
		return m.probeVideoCharacteristics(ctx, probeURL)
	})

	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.entries[channelID]
	if current == nil || current.generation != task.generation || current.fingerprint != fingerprint || current.probe != task || current.probe.id != task.id || task.ctx.Err() != nil {
		return
	}
	current.probe = nil
	if err != nil {
		current.classified = false
		current.retryAt = m.nowTime().Add(probeRetryDelay)
		current.state.State = StateError
		current.state.LastError = err.Error()
		return
	}
	current.classified = true
	current.decision = result
	current.retryAt = time.Time{}
	if result.required {
		current.state = State{
			State: StateStarting, Mode: ModeTranscoded, Required: true,
			Reasons: append([]string(nil), result.reasons...), OutputPath: CompatibilityPath(channelID),
			InputFingerprint: fingerprint,
		}
		return
	}
	current.state = State{State: StateReady, Mode: ModeDirect, Reasons: []string{}, OutputPath: path, InputFingerprint: fingerprint}
}

func (m *Manager) ensureTranscoded(ctx context.Context, item channel.Channel, result decision, output mediamtx.Channel) {
	compatPath := CompatibilityPath(item.ID)
	m.mu.RLock()
	current := m.entries[item.ID]
	refreshPath := current == nil || current.compatLimit != item.MaxReaders || current.compatAbsoluteTimestamp != item.UseAbsoluteTimestamp
	retryAt := time.Time{}
	if current != nil {
		retryAt = current.retryAt
	}
	m.mu.RUnlock()
	if !retryAt.IsZero() && m.nowTime().Before(retryAt) {
		return
	}
	if output.Name == "" || refreshPath {
		if err := m.media.ReplacePath(ctx, compatPath, mediamtx.PathConfig{
			Source: "publisher", MaxReaders: item.MaxReaders, UseAbsoluteTimestamp: item.UseAbsoluteTimestamp,
		}); err != nil {
			m.setWorkerError(item.ID, compatPath, result, fmt.Errorf("create compatibility path: %w", err))
			return
		}
		m.mu.Lock()
		if current := m.entries[item.ID]; current != nil {
			current.compatLimit = item.MaxReaders
			current.compatAbsoluteTimestamp = item.UseAbsoluteTimestamp
			current.retryAt = time.Time{}
		}
		m.mu.Unlock()
	}

	m.mu.Lock()
	current = m.entries[item.ID]
	if m.closed || current == nil || current.fingerprint == "" {
		m.mu.Unlock()
		return
	}
	workerRunning := current.worker != nil && !current.worker.stopping
	if workerRunning && output.Available && output.Online {
		current.state = State{
			State: StateReady, Mode: ModeTranscoded, Required: true,
			Reasons: append([]string(nil), result.reasons...), OutputPath: compatPath, InputFingerprint: current.fingerprint,
			Worker: WorkerState{Running: workerRunning, Restarts: current.state.Worker.Restarts},
		}
		current.retryAt = time.Time{}
		m.mu.Unlock()
		return
	}
	waitingCapacity := false
	if current.worker == nil && (current.retryAt.IsZero() || !m.nowTime().Before(current.retryAt)) {
		reservation := m.workerReservation(result.workerUnits)
		if m.usedWorkerCapacityLocked()+reservation <= m.workerCapacity {
			m.startWorkerLocked(ctx, item, current, result, reservation)
		} else {
			waitingCapacity = true
			if !current.state.Worker.Queued {
				m.logger.Warn("compatibility worker waiting for capacity", "channel", item.ID, "requiredUnits", reservation, "usedUnits", m.usedWorkerCapacityLocked(), "capacityUnits", m.workerCapacity)
			}
		}
	}
	if current.worker != nil && !current.worker.stopping && (!output.Available || !output.Online) && m.nowTime().Sub(current.worker.started) >= workerStartupTimeout {
		detail := fmt.Sprintf("compatibility output did not become ready within %s", workerStartupTimeout)
		restarts := current.state.Worker.Restarts + 1
		current.state = State{
			State: StateError, Mode: ModeTranscoded, Required: true,
			Reasons: append([]string(nil), result.reasons...), LastError: detail,
			Worker: WorkerState{Restarts: restarts, Error: detail}, OutputPath: compatPath,
			InputFingerprint: current.fingerprint,
		}
		current.retryAt = m.nowTime().Add(retryDelay(restarts))
		stopWorkerLocked(current)
		m.logger.Warn("compatibility worker startup timed out", "channel", item.ID, "timeout", workerStartupTimeout)
		m.mu.Unlock()
		return
	}
	workerRunning = current.worker != nil && !current.worker.stopping
	workerState := StateStarting
	if current.state.LastError != "" {
		workerState = StateError
	}
	lastError := current.state.LastError
	workerError := current.state.Worker.Error
	current.state = State{
		State: workerState, Mode: ModeTranscoded, Required: true,
		Reasons: append([]string(nil), result.reasons...), OutputPath: compatPath, InputFingerprint: current.fingerprint,
		LastError: lastError,
		Worker: WorkerState{
			Running: workerRunning, Queued: waitingCapacity,
			Restarts: current.state.Worker.Restarts, Error: workerError,
		},
	}
	m.mu.Unlock()
}

func (m *Manager) startWorkerLocked(ctx context.Context, item channel.Channel, current *entry, result decision, reservation int) {
	workerCtx, cancel := context.WithCancel(ctx)
	stderr := newRingWriter(8192)
	args := ffmpegArgs(m.pathURL(item.Path), m.pathURL(CompatibilityPath(item.ID)), result, m.encoderThreads)
	cmd := exec.CommandContext(workerCtx, m.ffmpeg, args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = stderr
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Signal(syscall.SIGTERM)
	}
	cmd.WaitDelay = 3 * time.Second
	if err := cmd.Start(); err != nil {
		cancel()
		current.retryAt = m.nowTime().Add(retryDelay(current.state.Worker.Restarts))
		current.state.LastError = err.Error()
		current.state.Worker.Error = err.Error()
		current.state.Worker.Restarts++
		return
	}
	running := &worker{cancel: cancel, cmd: cmd, stderr: stderr, started: m.nowTime(), units: reservation}
	current.worker = running
	current.retryAt = time.Time{}
	m.workers.Add(1)
	m.logger.Info("compatibility worker started", "channel", item.ID, "videoTranscode", result.transcodeVideo, "audioTranscode", result.transcodeAudio, "capacityUnits", reservation)
	go m.waitWorker(item.ID, running)
}

func (m *Manager) workerReservation(units int) int {
	if units < 1 {
		units = 1
	}
	return min(units, m.workerCapacity)
}

func (m *Manager) usedWorkerCapacityLocked() int {
	used := 0
	for _, item := range m.entries {
		if item.worker != nil {
			used += item.worker.units
		}
	}
	return used
}

func (m *Manager) waitWorker(channelID string, running *worker) {
	defer m.workers.Done()
	err := running.cmd.Wait()
	running.cancel()
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.entries[channelID]
	if current == nil || current.worker != running {
		return
	}
	current.worker = nil
	if running.stopping {
		return
	}
	detail := strings.TrimSpace(running.stderr.String())
	if detail == "" && err != nil {
		detail = err.Error()
	}
	if detail == "" {
		detail = "compatibility worker exited"
	}
	current.state.State = StateError
	current.state.LastError = detail
	current.state.Worker.Running = false
	current.state.Worker.Error = detail
	current.state.Worker.Restarts++
	current.retryAt = m.nowTime().Add(retryDelay(current.state.Worker.Restarts))
	m.logger.Warn("compatibility worker stopped", "channel", channelID, "error", detail)
}

func (m *Manager) setInactive(channelID, path, state string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.entryLocked(channelID)
	cancelProbeLocked(current)
	stopWorkerLocked(current)
	current.fingerprint = ""
	current.srt = false
	current.outputResetPending = false
	current.classified = false
	current.retryAt = time.Time{}
	current.state = State{State: state, Mode: ModeDirect, Reasons: []string{}, OutputPath: path}
}

func (m *Manager) setDirect(channelID, path, fingerprint string, result decision, srt bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.entryLocked(channelID)
	if current.srt && !srt {
		m.nextGeneration++
		current.generation = m.nextGeneration
	}
	cancelProbeLocked(current)
	stopWorkerLocked(current)
	current.fingerprint = fingerprint
	current.srt = srt
	current.outputResetPending = false
	current.classified = true
	current.decision = result
	current.retryAt = time.Time{}
	current.state = State{State: StateReady, Mode: ModeDirect, Reasons: []string{}, OutputPath: path, InputFingerprint: fingerprint}
}

func (m *Manager) setWorkerError(channelID, outputPath string, result decision, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.entryLocked(channelID)
	current.state = State{
		State: StateError, Mode: ModeTranscoded, Required: true,
		Reasons: append([]string(nil), result.reasons...), LastError: err.Error(),
		Worker: WorkerState{Restarts: current.state.Worker.Restarts, Error: err.Error()}, OutputPath: outputPath,
		InputFingerprint: current.fingerprint,
	}
	current.retryAt = m.nowTime().Add(probeRetryDelay)
}

func (m *Manager) entryLocked(channelID string) *entry {
	current := m.entries[channelID]
	if current == nil {
		current = &entry{}
		m.entries[channelID] = current
	}
	return current
}

func stopWorkerLocked(current *entry) {
	if current.worker == nil {
		return
	}
	running := current.worker
	if running.stopping {
		return
	}
	running.stopping = true
	current.state.Worker.Running = false
	running.cancel()
}

func cancelProbeLocked(current *entry) {
	if current.probe == nil {
		return
	}
	task := current.probe
	current.probe = nil
	task.cancel()
}

func cloneTracks(tracks []mediamtx.Track) []mediamtx.Track {
	result := make([]mediamtx.Track, len(tracks))
	for index, track := range tracks {
		result[index] = track
		if track.CodecProps != nil {
			result[index].CodecProps = make(map[string]any, len(track.CodecProps))
			for name, value := range track.CodecProps {
				result[index].CodecProps[name] = value
			}
		}
	}
	return result
}

func (m *Manager) nowTime() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

func classifyTracks(ctx context.Context, tracks []mediamtx.Track, probeVideo func(context.Context) (videoCharacteristics, error)) (decision, error) {
	if len(tracks) == 0 {
		return decision{}, errors.New("input has no detectable tracks")
	}
	result := decision{}
	firstVideoCodec := ""
	firstVideoLabel := "video"
	for _, track := range tracks {
		width := positiveIntProperty(track.CodecProps, "width")
		height := positiveIntProperty(track.CodecProps, "height")
		if int64(width)*int64(height) > int64(result.videoWidth)*int64(result.videoHeight) {
			result.videoWidth = width
			result.videoHeight = height
		}
		codec := normalizeCodec(track.Codec)
		if firstVideoCodec == "" && isVideoCodec(codec, width, height) {
			firstVideoCodec = codec
			firstVideoLabel = track.Codec
		}
		switch codec {
		case "h264", "vp8", "vp9", "av1", "opus", "g722", "g711", "pcma", "pcmu":
			// Direct WebRTC codecs.
		case "aac", "mpeg4audio", "mp3", "mpeg12audio", "ac3", "eac3", "vorbis", "flac", "lpcm":
			result.transcodeAudio = true
			result.reasons = append(result.reasons, track.Codec+" audio requires conversion to Opus.")
		case "h265", "hevc", "mpeg1video", "mpeg2video", "mpeg12video", "mpeg4video", "mjpeg", "jpeg":
			result.transcodeVideo = true
			result.reasons = append(result.reasons, track.Codec+" video requires conversion to H264.")
		default:
			result.transcodeVideo = true
			result.transcodeAudio = true
			result.reasons = append(result.reasons, track.Codec+" is not a direct WebRTC codec and will be normalized.")
		}
	}
	if firstVideoCodec != "" {
		characteristics, err := probeVideo(ctx)
		if err != nil {
			return decision{}, fmt.Errorf("probe first video characteristics: %w", err)
		}
		if characteristics.width > 0 && characteristics.height > 0 {
			result.videoWidth = characteristics.width
			result.videoHeight = characteristics.height
		}
		probedCodec := normalizeCodec(characteristics.codec)
		if probedCodec == "" {
			probedCodec = firstVideoCodec
		}
		if probedCodec == "h264" && characteristics.hasBFrames {
			result.transcodeVideo = true
			result.reasons = append(result.reasons, "H264 contains B-frames and requires low-latency H264 conversion.")
		}
		if probedCodec == "h264" && !browserCompatibleH264PixelFormat(characteristics.pixelFormat) {
			result.transcodeVideo = true
			result.reasons = append(result.reasons, fmt.Sprintf("H264 uses %s; browser-compatible H264 requires 8-bit yuv420p.", characteristics.pixelFormat))
		}
		if characteristics.hevcFieldSequence {
			result.transcodeVideo = true
			result.videoTransform = videoTransformWeaveDeinterlace
			result.videoHeight *= 2
			result.reasons = append(result.reasons, firstVideoLabel+" uses an alternating HEVC field sequence and requires weaving and send-field deinterlacing.")
		} else if characteristics.interlaced {
			result.transcodeVideo = true
			result.videoTransform = videoTransformDeinterlace
			result.reasons = append(result.reasons, fmt.Sprintf("%s is interlaced (%s) and requires send-field deinterlacing.", firstVideoLabel, fieldOrderDescription(characteristics)))
		}
	}
	result.required = result.transcodeVideo || result.transcodeAudio
	result.workerUnits = 1
	if result.transcodeVideo {
		result.workerUnits = videoWorkerUnits(result.videoWidth, result.videoHeight)
		if result.videoTransform != videoTransformNone {
			result.workerUnits *= 2
		}
	}
	return result, nil
}

func (m *Manager) probeVideoCharacteristics(ctx context.Context, sourceURL string) (videoCharacteristics, error) {
	probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, m.ffprobe,
		"-v", "error", "-rtsp_transport", "tcp", "-select_streams", "v:0",
		"-read_intervals", "%+2", "-show_streams", "-show_frames",
		"-show_entries", "stream=codec_name,pix_fmt,width,height,field_order:frame=pict_type,pix_fmt,width,height,interlaced_frame,top_field_first",
		"-of", "json", sourceURL,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if probeCtx.Err() != nil {
			return videoCharacteristics{}, probeCtx.Err()
		}
		if detail := strings.TrimSpace(stderr.String()); detail != "" {
			return videoCharacteristics{}, errors.New(detail)
		}
		return videoCharacteristics{}, err
	}
	return parseVideoCharacteristics(output)
}

type ffprobeFlag struct {
	set   bool
	value bool
}

func (f *ffprobeFlag) UnmarshalJSON(data []byte) error {
	value := strings.Trim(strings.TrimSpace(string(data)), `"`)
	switch strings.ToLower(value) {
	case "1", "true":
		f.set = true
		f.value = true
	case "0", "false":
		f.set = true
		f.value = false
	case "", "null", "n/a":
		// Leave unavailable values unset.
	default:
		return fmt.Errorf("invalid ffprobe boolean %q", value)
	}
	return nil
}

func parseVideoCharacteristics(data []byte) (videoCharacteristics, error) {
	var output struct {
		Streams []struct {
			CodecName   string `json:"codec_name"`
			PixelFormat string `json:"pix_fmt"`
			Width       int    `json:"width"`
			Height      int    `json:"height"`
			FieldOrder  string `json:"field_order"`
		} `json:"streams"`
		Frames []struct {
			PictureType     string      `json:"pict_type"`
			PixelFormat     string      `json:"pix_fmt"`
			Width           int         `json:"width"`
			Height          int         `json:"height"`
			InterlacedFrame ffprobeFlag `json:"interlaced_frame"`
			TopFieldFirst   ffprobeFlag `json:"top_field_first"`
		} `json:"frames"`
	}
	if err := json.Unmarshal(data, &output); err != nil {
		return videoCharacteristics{}, fmt.Errorf("decode ffprobe JSON: %w", err)
	}
	if len(output.Streams) == 0 {
		return videoCharacteristics{}, errors.New("ffprobe did not return a video stream")
	}
	if len(output.Frames) == 0 {
		return videoCharacteristics{}, errors.New("ffprobe did not return video frames")
	}

	stream := output.Streams[0]
	result := videoCharacteristics{
		codec: stream.CodecName, pixelFormat: stream.PixelFormat,
		width: stream.Width, height: stream.Height,
	}
	sawInterlaceFlag := false
	sawFrameDimensions := false
	fieldSequence := make([]bool, 0, len(output.Frames))
	completeFieldSequence := true
	for _, frame := range output.Frames {
		if !sawFrameDimensions && frame.Width > 0 && frame.Height > 0 {
			result.width = frame.Width
			result.height = frame.Height
			sawFrameDimensions = true
		}
		if frame.PixelFormat != "" {
			result.pixelFormat = frame.PixelFormat
		}
		if strings.EqualFold(frame.PictureType, "B") {
			result.hasBFrames = true
		}
		if frame.InterlacedFrame.set {
			sawInterlaceFlag = true
			result.interlaced = result.interlaced || frame.InterlacedFrame.value
		}
		if frame.InterlacedFrame.value && frame.TopFieldFirst.set {
			result.topFieldFirst = result.topFieldFirst || frame.TopFieldFirst.value
			result.bottomFieldFirst = result.bottomFieldFirst || !frame.TopFieldFirst.value
		}
		if frame.TopFieldFirst.set {
			fieldSequence = append(fieldSequence, frame.TopFieldFirst.value)
		} else {
			completeFieldSequence = false
		}
	}
	if !sawInterlaceFlag {
		switch strings.ToLower(stream.FieldOrder) {
		case "tt", "bt":
			result.interlaced = true
			result.topFieldFirst = true
		case "bb", "tb":
			result.interlaced = true
			result.bottomFieldFirst = true
		}
	}
	if normalizeCodec(result.codec) == "hevc" || normalizeCodec(result.codec) == "h265" {
		result.hevcFieldSequence = completeFieldSequence && len(fieldSequence) >= 3
		for index := 1; result.hevcFieldSequence && index < len(fieldSequence); index++ {
			result.hevcFieldSequence = fieldSequence[index] != fieldSequence[index-1]
		}
		result.interlaced = result.interlaced || result.hevcFieldSequence
		if result.hevcFieldSequence {
			result.topFieldFirst = true
			result.bottomFieldFirst = true
		}
	}
	if strings.TrimSpace(result.codec) == "" {
		return videoCharacteristics{}, errors.New("ffprobe did not return a video codec")
	}
	if strings.TrimSpace(result.pixelFormat) == "" {
		return videoCharacteristics{}, errors.New("ffprobe did not return a video pixel format")
	}
	if result.width <= 0 || result.height <= 0 {
		return videoCharacteristics{}, errors.New("ffprobe did not return valid video dimensions")
	}
	return result, nil
}

func fieldOrderDescription(characteristics videoCharacteristics) string {
	switch {
	case characteristics.topFieldFirst && !characteristics.bottomFieldFirst:
		return "top-field-first"
	case characteristics.bottomFieldFirst && !characteristics.topFieldFirst:
		return "bottom-field-first"
	default:
		return "field order auto-detected"
	}

}

func isVideoCodec(codec string, width, height int) bool {
	switch codec {
	case "h264", "h265", "hevc", "mpeg1video", "mpeg2video", "mpeg12video", "mpeg4video", "mjpeg", "jpeg", "vp8", "vp9", "av1":
		return true
	default:
		return width > 0 && height > 0
	}
}

func browserCompatibleH264PixelFormat(pixelFormat string) bool {
	return pixelFormat == "yuv420p" || pixelFormat == "yuvj420p"
}

func ffmpegArgs(inputURL, outputURL string, result decision, encoderThreads int) []string {
	args := []string{
		"-hide_banner", "-loglevel", "warning", "-rtsp_transport", "tcp",
		"-fflags", "nobuffer", "-flags", "low_delay", "-max_delay", "0",
	}
	if result.transcodeVideo {
		args = append(args, "-threads:v", strconv.Itoa(encoderThreads))
	}
	args = append(args,
		"-i", inputURL,
		"-map", "0:v:0?", "-map", "0:a:0?",
	)
	if result.transcodeVideo {
		maxRateKbps, bufferKbps := videoRateLimit(result.videoWidth, result.videoHeight)
		if filter := videoFilter(result.videoTransform); filter != "" {
			args = append(args, "-vf", filter)
		}
		args = append(args,
			"-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
			"-profile:v", "baseline", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "60",
			"-crf:v", "23", "-maxrate:v", strconv.Itoa(maxRateKbps)+"k", "-bufsize:v", strconv.Itoa(bufferKbps)+"k",
			"-threads:v", strconv.Itoa(encoderThreads),
			"-force_key_frames", "expr:gte(t,n_forced*1)", "-fps_mode:v", "passthrough",
		)
	} else {
		args = append(args, "-c:v", "copy")
	}
	if result.transcodeAudio {
		args = append(args, "-c:a", "libopus", "-application", "lowdelay", "-ac", "2", "-ar", "48000", "-b:a", "128k")
	} else {
		args = append(args, "-c:a", "copy")
	}
	return append(args, "-f", "rtsp", "-rtsp_transport", "tcp", outputURL)
}

func videoFilter(transform videoTransform) string {
	const deinterlace = "bwdif=mode=send_field:parity=auto:deint=interlaced"
	switch transform {
	case videoTransformDeinterlace:
		return deinterlace
	case videoTransformWeaveDeinterlace:
		return "select='not(eq(n\\,0)*eq(interlace_type\\,BOTTOMFIRST))',weave=first_field=top," + deinterlace
	default:
		return ""
	}
}

func videoRateLimit(width, height int) (int, int) {
	pixels := int64(width) * int64(height)
	maxRateKbps := 16000
	switch {
	case pixels > 0 && pixels <= 640*480:
		maxRateKbps = 2000
	case pixels > 0 && pixels <= 1280*720:
		maxRateKbps = 6000
	case pixels > 0 && pixels <= 1920*1080:
		maxRateKbps = 16000
	case pixels > 0 && pixels <= 2560*1440:
		maxRateKbps = 24000
	case pixels > 2560*1440:
		maxRateKbps = 40000
	}
	return maxRateKbps, maxRateKbps / 2
}

func videoWorkerUnits(width, height int) int {
	pixels := int64(width) * int64(height)
	if pixels <= 0 {
		return 4
	}
	return max(1, int((pixels+999999)/1000000))
}

func (m *Manager) pathURL(mediaPath string) string {
	result := *m.rtspURL
	result.Path = strings.TrimSuffix(result.Path, "/") + "/" + url.PathEscape(mediaPath)
	return result.String()
}

func Fingerprint(runtime mediamtx.Channel) string {
	value := struct {
		Source        *mediamtx.PathSource `json:"source"`
		AvailableTime *string              `json:"availableTime"`
		Codecs        []string             `json:"codecs"`
	}{
		Source: runtime.Source, AvailableTime: runtime.AvailableTime,
		Codecs: make([]string, 0, len(runtime.Tracks)),
	}
	for _, track := range runtime.Tracks {
		value.Codecs = append(value.Codecs, normalizeCodec(track.Codec))
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func fingerprint(runtime mediamtx.Channel) string {
	return Fingerprint(runtime)
}

func normalizeCodec(codec string) string {
	return strings.NewReplacer(" ", "", "-", "", "_", "", "/", "").Replace(strings.ToLower(codec))
}

func tracksMetadataReady(tracks []mediamtx.Track) bool {
	if len(tracks) == 0 {
		return false
	}
	for _, track := range tracks {
		switch normalizeCodec(track.Codec) {
		case "h264", "h265", "hevc", "mpeg1video", "mpeg2video", "mpeg12video", "mpeg4video", "mjpeg", "jpeg", "vp8", "vp9", "av1":
			if !positivePropertyIfPresent(track.CodecProps, "width") || !positivePropertyIfPresent(track.CodecProps, "height") {
				return false
			}
			if profile, ok := track.CodecProps["profile"]; ok && (profile == nil || strings.TrimSpace(fmt.Sprint(profile)) == "") {
				return false
			}
		}
	}
	return true
}

func positivePropertyIfPresent(properties map[string]any, name string) bool {
	value, ok := properties[name]
	if !ok {
		return true
	}
	number, err := strconv.ParseFloat(fmt.Sprint(value), 64)
	return err == nil && number > 0
}

func positiveIntProperty(properties map[string]any, name string) int {
	value, ok := properties[name]
	if !ok {
		return 0
	}
	number, err := strconv.ParseFloat(fmt.Sprint(value), 64)
	if err != nil || number <= 0 {
		return 0
	}
	return int(number)
}

func retryDelay(restarts int) time.Duration {
	if restarts > 4 {
		restarts = 4
	}
	return time.Second * time.Duration(1<<restarts)
}

type ringWriter struct {
	mu    sync.Mutex
	limit int
	data  []byte
}

func newRingWriter(limit int) *ringWriter {
	return &ringWriter{limit: limit}
}

func (w *ringWriter) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.data = append(w.data, value...)
	if len(w.data) > w.limit {
		w.data = append([]byte(nil), w.data[len(w.data)-w.limit:]...)
	}
	return len(value), nil
}

func (w *ringWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return string(bytes.TrimSpace(w.data))
}
