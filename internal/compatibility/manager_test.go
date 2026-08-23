package compatibility

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/mediamtx"
)

func TestClassifyTracksKeepsCompatibleInputDirect(t *testing.T) {
	called := false
	result, err := classifyTracks(context.Background(), []mediamtx.Track{
		{Codec: "H264", CodecProps: map[string]any{"profile": "Baseline"}},
		{Codec: "Opus"},
	}, func(context.Context) (videoCharacteristics, error) {
		called = true
		return progressiveVideo("h264", "yuv420p", 1920, 1080), nil
	})
	if err != nil || result.required || !called {
		t.Fatalf("classification = %#v, %v; probe called = %v", result, err, called)
	}
}

func TestClassifyTracksConvertsOnlyIncompatibleTracks(t *testing.T) {
	result, err := classifyTracks(context.Background(), []mediamtx.Track{
		{Codec: "H264", CodecProps: map[string]any{"profile": "Main"}},
		{Codec: "MPEG-4 Audio"},
	}, func(context.Context) (videoCharacteristics, error) {
		return progressiveVideo("h264", "yuv420p", 1920, 1080), nil
	})
	if err != nil || !result.required || result.transcodeVideo || !result.transcodeAudio {
		t.Fatalf("classification = %#v, %v", result, err)
	}

	args := ffmpegArgs("rtsp://input/raw", "rtsp://output/compat", result, 8)
	if !containsPair(args, "-c:v", "copy") || !containsPair(args, "-c:a", "libopus") {
		t.Fatalf("FFmpeg args = %#v", args)
	}
	if !containsPair(args, "-fflags", "nobuffer") || !containsPair(args, "-flags", "low_delay") || !containsPair(args, "-max_delay", "0") {
		t.Fatalf("FFmpeg low-latency input args = %#v", args)
	}
}

func TestClassifyTracksRecognizesMediaMTXMPEGNames(t *testing.T) {
	result, err := classifyTracks(context.Background(), []mediamtx.Track{
		{Codec: "MPEG-1/2 Video"},
		{Codec: "MPEG-1/2 Audio"},
	}, func(context.Context) (videoCharacteristics, error) {
		return progressiveVideo("mpeg2video", "yuv420p", 720, 576), nil
	})
	if err != nil || !result.required || !result.transcodeVideo || !result.transcodeAudio {
		t.Fatalf("classification = %#v, %v", result, err)
	}
	if len(result.reasons) != 2 {
		t.Fatalf("reasons = %#v", result.reasons)
	}
}

func TestClassifyTracksConvertsH264BFrames(t *testing.T) {
	result, err := classifyTracks(context.Background(), []mediamtx.Track{
		{Codec: "H264", CodecProps: map[string]any{"profile": "High"}},
	}, func(context.Context) (videoCharacteristics, error) {
		characteristics := progressiveVideo("h264", "yuv420p", 1920, 1080)
		characteristics.hasBFrames = true
		return characteristics, nil
	})
	if err != nil || !result.transcodeVideo || result.transcodeAudio {
		t.Fatalf("classification = %#v, %v", result, err)
	}
	if !reflect.DeepEqual(result.reasons, []string{"H264 contains B-frames and requires low-latency H264 conversion."}) {
		t.Fatalf("reasons = %#v", result.reasons)
	}
}

func TestParseVideoCharacteristics(t *testing.T) {
	tests := []struct {
		name string
		json string
		want videoCharacteristics
	}{
		{
			name: "progressive yuv420p",
			json: `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0}]}`,
			want: progressiveVideo("h264", "yuv420p", 1280, 720),
		},
		{
			name: "B-frame and non-browser pixel format",
			json: `{"streams":[{"codec_name":"h264","pix_fmt":"yuv422p","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":"0","top_field_first":"0"},{"pict_type":"B","interlaced_frame":false,"top_field_first":false}]}`,
			want: videoCharacteristics{codec: "h264", hasBFrames: true, pixelFormat: "yuv422p", width: 1920, height: 1080},
		},
		{
			name: "top-field-first",
			json: `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":1,"top_field_first":1},{"pict_type":"P","interlaced_frame":1,"top_field_first":1}]}`,
			want: videoCharacteristics{codec: "h264", interlaced: true, topFieldFirst: true, pixelFormat: "yuv420p", width: 1920, height: 1080},
		},
		{
			name: "bottom-field-first",
			json: `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":720,"height":576}],"frames":[{"pict_type":"I","interlaced_frame":1,"top_field_first":0},{"pict_type":"P","interlaced_frame":1,"top_field_first":0}]}`,
			want: videoCharacteristics{codec: "h264", interlaced: true, bottomFieldFirst: true, pixelFormat: "yuv420p", width: 720, height: 576},
		},
		{
			name: "alternating half-height HEVC fields",
			json: `{"streams":[{"codec_name":"hevc","pix_fmt":"yuv420p10le","width":1920,"height":1080}],"frames":[{"pict_type":"I","pix_fmt":"yuv420p10le","width":1920,"height":540,"interlaced_frame":1,"top_field_first":1},{"pict_type":"P","interlaced_frame":1,"top_field_first":0},{"pict_type":"P","interlaced_frame":1,"top_field_first":1},{"pict_type":"P","interlaced_frame":1,"top_field_first":0}]}`,
			want: videoCharacteristics{codec: "hevc", interlaced: true, topFieldFirst: true, bottomFieldFirst: true, pixelFormat: "yuv420p10le", width: 1920, height: 540, hevcFieldSequence: true},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseVideoCharacteristics([]byte(test.json))
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("parseVideoCharacteristics() = %#v, %v; want %#v", got, err, test.want)
			}
		})
	}
}

func TestParseVideoCharacteristicsRejectsIncompleteOutput(t *testing.T) {
	for _, input := range []string{
		`not json`,
		`{"streams":[],"frames":[]}`,
		`{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080}],"frames":[]}`,
		`{"streams":[{"codec_name":"h264","width":1920,"height":1080}],"frames":[{"pict_type":"I"}]}`,
	} {
		if result, err := parseVideoCharacteristics([]byte(input)); err == nil {
			t.Fatalf("parseVideoCharacteristics(%q) = %#v, nil", input, result)
		}
	}
}

func TestClassifyTracksSelectsVideoTransformsAndReasons(t *testing.T) {
	tests := []struct {
		name           string
		track          mediamtx.Track
		characteristic videoCharacteristics
		transform      videoTransform
		height         int
		units          int
		reason         string
	}{
		{
			name:           "interlaced Baseline H264",
			track:          mediamtx.Track{Codec: "H264", CodecProps: map[string]any{"profile": "Baseline"}},
			characteristic: videoCharacteristics{codec: "h264", interlaced: true, topFieldFirst: true, pixelFormat: "yuv420p", width: 1920, height: 1080},
			transform:      videoTransformDeinterlace, height: 1080, units: 6, reason: "top-field-first",
		},
		{
			name:           "bottom-field-first H264",
			track:          mediamtx.Track{Codec: "H264", CodecProps: map[string]any{"profile": "Main"}},
			characteristic: videoCharacteristics{codec: "h264", interlaced: true, bottomFieldFirst: true, pixelFormat: "yuv420p", width: 720, height: 576},
			transform:      videoTransformDeinterlace, height: 576, units: 2, reason: "bottom-field-first",
		},
		{
			name:           "half-height HEVC field sequence",
			track:          mediamtx.Track{Codec: "H265", CodecProps: map[string]any{"profile": "Main 10"}},
			characteristic: videoCharacteristics{codec: "hevc", interlaced: true, topFieldFirst: true, bottomFieldFirst: true, pixelFormat: "yuv420p10le", width: 1920, height: 540, hevcFieldSequence: true},
			transform:      videoTransformWeaveDeinterlace, height: 1080, units: 6, reason: "alternating HEVC field sequence",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := classifyTracks(context.Background(), []mediamtx.Track{test.track}, func(context.Context) (videoCharacteristics, error) {
				return test.characteristic, nil
			})
			if err != nil || !result.required || !result.transcodeVideo || result.videoTransform != test.transform || result.videoHeight != test.height || result.workerUnits != test.units {
				t.Fatalf("classification = %#v, %v", result, err)
			}
			if !strings.Contains(strings.Join(result.reasons, " "), test.reason) {
				t.Fatalf("reasons = %#v, want %q", result.reasons, test.reason)
			}
		})
	}
}

func TestClassifyTracksConvertsNonYUV420H264(t *testing.T) {
	for _, pixelFormat := range []string{"yuv422p", "yuv444p", "yuv420p10le"} {
		t.Run(pixelFormat, func(t *testing.T) {
			result, err := classifyTracks(context.Background(), []mediamtx.Track{{Codec: "H264"}}, func(context.Context) (videoCharacteristics, error) {
				return progressiveVideo("h264", pixelFormat, 1920, 1080), nil
			})
			if err != nil || !result.transcodeVideo || result.videoTransform != videoTransformNone {
				t.Fatalf("classification = %#v, %v", result, err)
			}
			if got := strings.Join(result.reasons, " "); !strings.Contains(got, "requires 8-bit yuv420p") {
				t.Fatalf("reasons = %#v", result.reasons)
			}
		})
	}
}

func TestClassifyTracksKeepsFullRangeYUV420H264Direct(t *testing.T) {
	result, err := classifyTracks(context.Background(), []mediamtx.Track{{Codec: "H264"}}, func(context.Context) (videoCharacteristics, error) {
		return progressiveVideo("h264", "yuvj420p", 1920, 1080), nil
	})
	if err != nil || result.required {
		t.Fatalf("classification = %#v, %v", result, err)
	}
}

func TestClassifyTracksProbesDirectVideoButNotAudioOnly(t *testing.T) {
	calls := 0
	probe := func(context.Context) (videoCharacteristics, error) {
		calls++
		return progressiveVideo("vp8", "yuv420p", 1280, 720), nil
	}
	result, err := classifyTracks(context.Background(), []mediamtx.Track{{Codec: "VP8"}}, probe)
	if err != nil || result.required || calls != 1 {
		t.Fatalf("VP8 classification = %#v, %v; calls = %d", result, err, calls)
	}
	_, err = classifyTracks(context.Background(), []mediamtx.Track{{Codec: "Opus"}}, probe)
	if err != nil || calls != 1 {
		t.Fatalf("audio-only classification error = %v; calls = %d", err, calls)
	}
}

func TestFFmpegArgsPreserveCadenceAndForceKeyframes(t *testing.T) {
	args := ffmpegArgs("rtsp://input/raw", "rtsp://output/compat", decision{transcodeVideo: true, videoWidth: 1920, videoHeight: 1080}, 8)
	if !containsPair(args, "-fps_mode:v", "passthrough") {
		t.Fatalf("FFmpeg args do not preserve frame cadence: %#v", args)
	}
	if !containsPair(args, "-force_key_frames", "expr:gte(t,n_forced*1)") {
		t.Fatalf("FFmpeg args do not force one-second keyframes: %#v", args)
	}
	if countPair(args, "-threads:v", "8") != 2 {
		t.Fatalf("FFmpeg args do not limit decoder and encoder threads: %#v", args)
	}
	if !containsPair(args, "-crf:v", "23") || !containsPair(args, "-maxrate:v", "16000k") || !containsPair(args, "-bufsize:v", "8000k") {
		t.Fatalf("FFmpeg args do not apply the 1080p rate policy: %#v", args)
	}
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "qsv") || strings.Contains(joined, "vaapi") {
		t.Fatalf("FFmpeg args unexpectedly require hardware acceleration: %s", joined)
	}
}

func TestFFmpegArgsApplyInterlacedTransforms(t *testing.T) {
	const deinterlace = "bwdif=mode=send_field:parity=auto:deint=interlaced"
	args := ffmpegArgs("input", "output", decision{transcodeVideo: true, videoTransform: videoTransformDeinterlace}, 8)
	if !containsPair(args, "-vf", deinterlace) {
		t.Fatalf("conventional interlace FFmpeg args = %#v", args)
	}

	const weave = "select='not(eq(n\\,0)*eq(interlace_type\\,BOTTOMFIRST))',weave=first_field=top," + deinterlace
	args = ffmpegArgs("input", "output", decision{transcodeVideo: true, videoTransform: videoTransformWeaveDeinterlace}, 8)
	if !containsPair(args, "-vf", weave) {
		t.Fatalf("HEVC field sequence FFmpeg args = %#v", args)
	}
	if !strings.Contains(weave, `n\,0`) || !strings.Contains(weave, `interlace_type\,BOTTOMFIRST`) {
		t.Fatalf("HEVC field selection expression is not filtergraph-escaped: %q", weave)
	}
}

func TestFFmpegArgsUseResolutionRateTiers(t *testing.T) {
	tests := []struct {
		name            string
		width, height   int
		maxrate, buffer string
	}{
		{name: "480p", width: 640, height: 480, maxrate: "2000k", buffer: "1000k"},
		{name: "720p", width: 1280, height: 720, maxrate: "6000k", buffer: "3000k"},
		{name: "1080p", width: 1920, height: 1080, maxrate: "16000k", buffer: "8000k"},
		{name: "1440p", width: 2560, height: 1440, maxrate: "24000k", buffer: "12000k"},
		{name: "2160p", width: 3840, height: 2160, maxrate: "40000k", buffer: "20000k"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			args := ffmpegArgs("input", "output", decision{transcodeVideo: true, videoWidth: test.width, videoHeight: test.height}, 8)
			if !containsPair(args, "-maxrate:v", test.maxrate) || !containsPair(args, "-bufsize:v", test.buffer) {
				t.Fatalf("FFmpeg args = %#v", args)
			}
		})
	}
}

func TestAudioOnlyConversionDoesNotApplyVideoLimits(t *testing.T) {
	args := ffmpegArgs("input", "output", decision{transcodeAudio: true}, 8)
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "-threads:v") || strings.Contains(joined, "-maxrate:v") || strings.Contains(joined, "-bufsize:v") {
		t.Fatalf("audio-only FFmpeg args contain video limits: %#v", args)
	}
}

func TestWorkerUnitsFollowTranscodedVideoResolution(t *testing.T) {
	result, err := classifyTracks(context.Background(), []mediamtx.Track{
		{Codec: "H265", CodecProps: map[string]any{"width": 3840, "height": 2160, "profile": "Main"}},
		{Codec: "MPEG-4 Audio"},
	}, func(context.Context) (videoCharacteristics, error) {
		return progressiveVideo("hevc", "yuv420p", 3840, 2160), nil
	})
	if err != nil || result.workerUnits != 9 || result.videoWidth != 3840 || result.videoHeight != 2160 {
		t.Fatalf("classification = %#v, %v", result, err)
	}

	audioOnly, err := classifyTracks(context.Background(), []mediamtx.Track{{Codec: "MPEG-4 Audio"}}, func(context.Context) (videoCharacteristics, error) {
		t.Fatal("audio-only classification unexpectedly probed video")
		return videoCharacteristics{}, nil
	})
	if err != nil || audioOnly.workerUnits != 1 {
		t.Fatalf("audio-only classification = %#v, %v", audioOnly, err)
	}
}

func TestEnsureTranscodedQueuesWhenCapacityIsBusy(t *testing.T) {
	result := decision{required: true, transcodeVideo: true, workerUnits: 2, reasons: []string{"conversion required"}}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), workerCapacity: 3, encoderThreads: 8,
		entries: map[string]*entry{
			"running": {worker: &worker{units: 2}},
			"queued": {
				fingerprint: "source", classified: true, decision: result,
				state: State{State: StateStarting, Worker: WorkerState{}},
			},
		},
	}

	manager.ensureTranscoded(context.Background(), channel.Channel{ID: "queued"}, result, mediamtx.Channel{Name: "compat-queued"})
	state := manager.Snapshot("queued")
	if state.State != StateStarting || state.Worker.Running || !state.Worker.Queued || state.LastError != "" {
		t.Fatalf("queued state = %#v", state)
	}
	if got := manager.workerReservation(9); got != 3 {
		t.Fatalf("oversized worker reservation = %d, want 3", got)
	}
}

func TestReconcileNonSRTChannelCleansUpTranscodedPathAndRetriesFailure(t *testing.T) {
	const channelID = "channel-id"
	compatPath := CompatibilityPath(channelID)
	configured := channel.Channel{
		ID: channelID, Path: "channel", Enabled: true,
		Input: channel.Input{Mode: channel.InputRTPUnicast},
	}
	media := &reconcileMediaManager{
		status: mediamtx.Status{Channels: []mediamtx.Channel{
			{Name: configured.Path, Available: true, Online: true},
			{Name: compatPath, Available: true, Online: true},
		}},
		deleteErrors: []error{errors.New("temporary delete failure"), nil},
	}
	var logs bytes.Buffer
	workerStopped := false
	manager := &Manager{
		logger:   slog.New(slog.NewTextHandler(&logs, nil)),
		channels: reconcileChannelReader{items: []channel.Channel{configured}},
		media:    media,
		entries: map[string]*entry{channelID: {
			fingerprint: "srt-source", classified: true,
			decision: decision{required: true, transcodeVideo: true},
			state: State{
				State: StateReady, Mode: ModeTranscoded, Required: true,
				Worker: WorkerState{Running: true}, OutputPath: compatPath,
			},
			worker: &worker{cancel: func() { workerStopped = true }},
		}},
	}

	manager.reconcile(context.Background())
	state := manager.Snapshot(channelID)
	if !workerStopped || state.State != StateReady || state.Mode != ModeDirect || state.Required || state.OutputPath != configured.Path {
		t.Fatalf("workerStopped = %v, direct state = %#v", workerStopped, state)
	}
	if !strings.Contains(logs.String(), "stale compatibility path cleanup failed") || !strings.Contains(logs.String(), "temporary delete failure") {
		t.Fatalf("cleanup failure was not logged: %s", logs.String())
	}

	manager.reconcile(context.Background())
	if !reflect.DeepEqual(media.deleted, []string{compatPath, compatPath}) {
		t.Fatalf("deleted paths = %#v, want cleanup retried", media.deleted)
	}
}

func TestFingerprintIgnoresMetadataEnrichment(t *testing.T) {
	available := "2026-08-22T21:00:00Z"
	initial := mediamtx.Channel{
		Source: &mediamtx.PathSource{Type: "srtConn", ID: "source-1"}, AvailableTime: &available,
		Tracks: []mediamtx.Track{{Codec: "H264", CodecProps: map[string]any{"width": 0, "height": 0, "profile": ""}}, {Codec: "Opus"}},
	}
	enriched := initial
	enriched.Tracks = []mediamtx.Track{{Codec: "H264", CodecProps: map[string]any{"width": 1920, "height": 1080, "profile": "Baseline"}}, {Codec: "Opus"}}
	if Fingerprint(initial) != Fingerprint(enriched) {
		t.Fatalf("metadata enrichment changed source fingerprint: %s != %s", Fingerprint(initial), Fingerprint(enriched))
	}

	reconnected := enriched
	reconnectedAt := "2026-08-22T21:01:00Z"
	reconnected.AvailableTime = &reconnectedAt
	if Fingerprint(enriched) == Fingerprint(reconnected) {
		t.Fatal("new availability generation reused source fingerprint")
	}

	changedCodec := enriched
	changedCodec.Tracks = []mediamtx.Track{{Codec: "H265"}, {Codec: "Opus"}}
	if Fingerprint(enriched) == Fingerprint(changedCodec) {
		t.Fatal("codec change reused source fingerprint")
	}
}

func TestTracksMetadataReadyWaitsForVideoProperties(t *testing.T) {
	if tracksMetadataReady(nil) {
		t.Fatal("empty tracks reported ready")
	}
	if tracksMetadataReady([]mediamtx.Track{{Codec: "H265", CodecProps: map[string]any{"width": 0, "height": 0, "profile": ""}}}) {
		t.Fatal("incomplete video metadata reported ready")
	}
	if !tracksMetadataReady([]mediamtx.Track{{Codec: "H265", CodecProps: map[string]any{"width": 1920, "height": 1080, "profile": "Main"}}, {Codec: "MPEG-4 Audio"}}) {
		t.Fatal("complete video metadata did not report ready")
	}
	if !tracksMetadataReady([]mediamtx.Track{{Codec: "Opus"}}) {
		t.Fatal("audio-only metadata did not report ready")
	}
}

func TestNextIntervalAcceleratesTransientStates(t *testing.T) {
	manager := &Manager{
		interval: 2 * time.Second, activeInterval: 250 * time.Millisecond,
		entries: map[string]*entry{"channel": {state: State{State: StateReady}}},
	}
	if got := manager.nextInterval(); got != 2*time.Second {
		t.Fatalf("stable interval = %v", got)
	}
	manager.entries["channel"].state.State = StateStarting
	if got := manager.nextInterval(); got != 250*time.Millisecond {
		t.Fatalf("active interval = %v", got)
	}
}

func TestProbeVideoCharacteristicsReadsFirstVideoJSON(t *testing.T) {
	probe := filepath.Join(t.TempDir(), "ffprobe")
	output := `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":1,"top_field_first":1},{"pict_type":"B","interlaced_frame":1,"top_field_first":1}]}`
	script := "#!/bin/sh\ncase \" $* \" in *\" -select_streams v:0 \"*) ;; *) exit 2;; esac\ncase \" $* \" in *\" -of json \"*) ;; *) exit 3;; esac\nprintf '%s' '" + output + "'\n"
	if err := os.WriteFile(probe, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := &Manager{ffprobe: probe}
	characteristics, err := manager.probeVideoCharacteristics(context.Background(), "rtsp://input/raw")
	if err != nil || !characteristics.hasBFrames || !characteristics.interlaced || !characteristics.topFieldFirst || characteristics.bottomFieldFirst {
		t.Fatalf("probeVideoCharacteristics() = %#v, %v", characteristics, err)
	}
}

func TestWorkerStartupTimeoutStopsWorkerAndSchedulesRetry(t *testing.T) {
	cancelled := false
	result := decision{required: true, transcodeVideo: true, reasons: []string{"conversion required"}}
	manager := &Manager{
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
		entries: map[string]*entry{},
	}
	manager.entries["channel-id"] = &entry{
		fingerprint: "source-id",
		classified:  true,
		decision:    result,
		state: State{
			Worker: WorkerState{Running: true, Restarts: 2},
		},
		worker: &worker{
			cancel:  func() { cancelled = true },
			started: time.Now().Add(-workerStartupTimeout),
		},
	}

	manager.ensureTranscoded(context.Background(), channel.Channel{ID: "channel-id"}, result, mediamtx.Channel{Name: "compat-channel-id"})

	state := manager.Snapshot("channel-id")
	if !cancelled || state.State != StateError || state.Worker.Running || state.Worker.Restarts != 3 {
		t.Fatalf("cancelled = %v, state = %#v", cancelled, state)
	}
	if !strings.Contains(state.LastError, "did not become ready") {
		t.Fatalf("last error = %q", state.LastError)
	}
	if manager.entries["channel-id"].retryAt.Before(time.Now()) {
		t.Fatalf("retry was not scheduled: %v", manager.entries["channel-id"].retryAt)
	}
}

type reconcileChannelReader struct {
	items []channel.Channel
}

func (r reconcileChannelReader) List(context.Context) ([]channel.Channel, error) {
	return r.items, nil
}

type reconcileMediaManager struct {
	status       mediamtx.Status
	deleteErrors []error
	deleted      []string
}

func (m *reconcileMediaManager) Status(context.Context) (mediamtx.Status, error) {
	return m.status, nil
}

func (m *reconcileMediaManager) ReplacePath(context.Context, string, mediamtx.PathConfig) error {
	return nil
}

func (m *reconcileMediaManager) DeletePath(_ context.Context, path string) error {
	m.deleted = append(m.deleted, path)
	if len(m.deleteErrors) == 0 {
		return nil
	}
	err := m.deleteErrors[0]
	m.deleteErrors = m.deleteErrors[1:]
	return err
}

func containsPair(values []string, first, second string) bool {
	for index := 0; index+1 < len(values); index++ {
		if values[index] == first && values[index+1] == second {
			return true
		}
	}
	return false
}

func countPair(values []string, first, second string) int {
	count := 0
	for index := 0; index+1 < len(values); index++ {
		if values[index] == first && values[index+1] == second {
			count++
		}
	}
	return count
}

func progressiveVideo(codec, pixelFormat string, width, height int) videoCharacteristics {
	return videoCharacteristics{codec: codec, pixelFormat: pixelFormat, width: width, height: height}
}
