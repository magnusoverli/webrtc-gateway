package compatibility

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
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

func TestMetadataGraceIsFixedAndFallsBackToIncompleteMetadata(t *testing.T) {
	clock := newTestClock()
	probeCalls := make(chan map[string]any, 1)
	manager := newProbeTestManager(t, clock, func(_ context.Context, _ string) (videoCharacteristics, error) {
		probeCalls <- nil
		return progressiveVideo("h264", "yuv420p", 1920, 1080), nil
	})
	t.Cleanup(manager.Close)
	configured := srtChannel("channel", "raw")
	properties := map[string]any{"width": 0, "height": 0, "profile": ""}
	runtime := srtRuntime("generation-a", []mediamtx.Track{{Codec: "H264", CodecProps: properties}})

	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	manager.mu.RLock()
	deadline := manager.entries[configured.ID].metadataDeadline
	manager.mu.RUnlock()
	if want := clock.Now().Add(metadataGrace); !deadline.Equal(want) {
		t.Fatalf("metadata deadline = %v, want %v", deadline, want)
	}
	assertNoProbeCall(t, probeCalls)

	clock.Advance(metadataGrace - time.Nanosecond)
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	manager.mu.RLock()
	unchangedDeadline := manager.entries[configured.ID].metadataDeadline
	manager.mu.RUnlock()
	if !unchangedDeadline.Equal(deadline) {
		t.Fatalf("metadata deadline moved from %v to %v", deadline, unchangedDeadline)
	}
	assertNoProbeCall(t, probeCalls)

	clock.Advance(time.Nanosecond)
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	receiveProbeCall(t, probeCalls)
	properties["width"] = 3840
	waitForState(t, manager, configured.ID, func(state State) bool { return state.State == StateReady })
	state := manager.Snapshot(configured.ID)
	if state.Mode != ModeDirect || state.LastError != "" {
		t.Fatalf("fallback classification state = %#v", state)
	}
}

func TestMetadataReadyProbesImmediately(t *testing.T) {
	clock := newTestClock()
	probeCalls := make(chan map[string]any, 1)
	manager := newProbeTestManager(t, clock, func(_ context.Context, _ string) (videoCharacteristics, error) {
		probeCalls <- nil
		return progressiveVideo("h264", "yuv420p", 1280, 720), nil
	})
	t.Cleanup(manager.Close)
	configured := srtChannel("channel", "raw")
	runtime := srtRuntime("generation-a", []mediamtx.Track{{Codec: "H264", CodecProps: map[string]any{
		"width": 1280, "height": 720, "profile": "Baseline",
	}}})

	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	receiveProbeCall(t, probeCalls)
	waitForState(t, manager, configured.ID, func(state State) bool { return state.State == StateReady })
}

func TestProbeIsAsynchronousNonblockingAndSingleFlight(t *testing.T) {
	clock := newTestClock()
	probeStarted := make(chan struct{}, 2)
	releaseProbe := make(chan struct{})
	manager := newProbeTestManager(t, clock, func(_ context.Context, _ string) (videoCharacteristics, error) {
		probeStarted <- struct{}{}
		<-releaseProbe
		return progressiveVideo("h264", "yuv420p", 1920, 1080), nil
	})
	t.Cleanup(manager.Close)
	blocked := srtChannel("blocked", "blocked-raw")
	blockedRuntime := srtRuntime("blocked-generation", []mediamtx.Track{{Codec: "H264"}})
	other := srtChannel("other", "other-raw")
	otherRuntime := srtRuntime("other-generation", []mediamtx.Track{{Codec: "Opus"}})

	firstDone := make(chan struct{})
	go func() {
		manager.reconcileChannel(context.Background(), blocked, map[string]mediamtx.Channel{blocked.Path: blockedRuntime})
		close(firstDone)
	}()
	waitClosed(t, firstDone, "blocked channel reconciliation")
	waitClosed(t, probeStarted, "probe start")

	otherDone := make(chan struct{})
	go func() {
		manager.reconcileChannel(context.Background(), other, map[string]mediamtx.Channel{other.Path: otherRuntime})
		close(otherDone)
	}()
	waitClosed(t, otherDone, "other channel reconciliation")
	waitForState(t, manager, other.ID, func(state State) bool { return state.State == StateReady })

	for range 3 {
		manager.reconcileChannel(context.Background(), blocked, map[string]mediamtx.Channel{blocked.Path: blockedRuntime})
	}
	assertNoSignal(t, probeStarted, "duplicate probe")
	close(releaseProbe)
	waitForState(t, manager, blocked.ID, func(state State) bool { return state.State == StateReady })
}

func TestProbeRejectsStaleABAResult(t *testing.T) {
	clock := newTestClock()
	probeCalls := make(chan *controlledProbe, 3)
	manager := newProbeTestManager(t, clock, func(_ context.Context, _ string) (videoCharacteristics, error) {
		call := &controlledProbe{result: make(chan probeResult, 1), done: make(chan struct{})}
		probeCalls <- call
		result := <-call.result
		close(call.done)
		return result.characteristics, result.err
	})
	t.Cleanup(manager.Close)
	configured := srtChannel("channel", "raw")
	tracks := []mediamtx.Track{{Codec: "H264"}}
	generationA := srtRuntime("generation-a", tracks)
	generationB := srtRuntime("generation-b", tracks)

	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": generationA})
	firstA := receiveControlledProbe(t, probeCalls)
	manager.mu.RLock()
	firstTask := manager.entries[configured.ID].probe
	manager.mu.RUnlock()
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": generationB})
	callB := receiveControlledProbe(t, probeCalls)
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": generationA})
	secondA := receiveControlledProbe(t, probeCalls)

	firstA.result <- probeResult{characteristics: progressiveVideo("h264", "yuv422p", 1920, 1080)}
	waitClosed(t, firstA.done, "first generation A probe")
	waitClosed(t, firstTask.done, "first generation A result processing")
	state := manager.Snapshot(configured.ID)
	if state.State != StateProbing || state.Required {
		t.Fatalf("stale ABA result changed state: %#v", state)
	}
	manager.mu.RLock()
	currentTask := manager.entries[configured.ID].probe
	manager.mu.RUnlock()
	if currentTask == nil {
		t.Fatal("current generation probe was cleared by stale result")
	}

	callB.result <- probeResult{characteristics: progressiveVideo("h264", "yuv422p", 1920, 1080)}
	waitClosed(t, callB.done, "generation B probe")
	secondA.result <- probeResult{characteristics: progressiveVideo("h264", "yuv420p", 1920, 1080)}
	waitClosed(t, secondA.done, "second generation A probe")
	waitForState(t, manager, configured.ID, func(state State) bool { return state.State == StateReady })
	if state := manager.Snapshot(configured.ID); state.Mode != ModeDirect || state.Required {
		t.Fatalf("current ABA result state = %#v", state)
	}
}

func TestProbeRetryKeepsErrorVisibleAndRecovers(t *testing.T) {
	clock := newTestClock()
	probeCalls := make(chan *controlledProbe, 2)
	manager := newProbeTestManager(t, clock, func(_ context.Context, _ string) (videoCharacteristics, error) {
		call := &controlledProbe{result: make(chan probeResult, 1), done: make(chan struct{})}
		probeCalls <- call
		result := <-call.result
		close(call.done)
		return result.characteristics, result.err
	})
	t.Cleanup(manager.Close)
	configured := srtChannel("channel", "raw")
	runtime := srtRuntime("generation-a", []mediamtx.Track{{Codec: "H264"}})

	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	first := receiveControlledProbe(t, probeCalls)
	first.result <- probeResult{err: errors.New("temporary probe failure")}
	waitClosed(t, first.done, "failed probe")
	waitForState(t, manager, configured.ID, func(state State) bool { return state.State == StateError })
	failed := manager.Snapshot(configured.ID)
	if !strings.Contains(failed.LastError, "temporary probe failure") {
		t.Fatalf("failed probe state = %#v", failed)
	}

	clock.Advance(probeRetryDelay - time.Nanosecond)
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	assertNoSignal(t, probeCalls, "early retry")
	if state := manager.Snapshot(configured.ID); state.State != StateError || state.LastError != failed.LastError {
		t.Fatalf("waiting retry state = %#v, want error %q", state, failed.LastError)
	}

	clock.Advance(time.Nanosecond)
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	second := receiveControlledProbe(t, probeCalls)
	if state := manager.Snapshot(configured.ID); state.State != StateError || state.LastError != failed.LastError {
		t.Fatalf("in-flight retry state = %#v, want error %q", state, failed.LastError)
	}
	second.result <- probeResult{characteristics: progressiveVideo("h264", "yuv420p", 1920, 1080)}
	waitClosed(t, second.done, "successful retry")
	waitForState(t, manager, configured.ID, func(state State) bool { return state.State == StateReady })
	if state := manager.Snapshot(configured.ID); state.LastError != "" {
		t.Fatalf("recovered probe retained error: %#v", state)
	}
}

func TestCloseCancelsProbeAndWaitsForExit(t *testing.T) {
	clock := newTestClock()
	probeStarted := make(chan struct{})
	probeCancelled := make(chan struct{})
	releaseProbe := make(chan struct{})
	manager := newProbeTestManager(t, clock, func(ctx context.Context, _ string) (videoCharacteristics, error) {
		close(probeStarted)
		<-ctx.Done()
		close(probeCancelled)
		<-releaseProbe
		return videoCharacteristics{}, ctx.Err()
	})
	configured := srtChannel("channel", "raw")
	runtime := srtRuntime("generation-a", []mediamtx.Track{{Codec: "H264"}})
	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{"raw": runtime})
	waitClosed(t, probeStarted, "probe start")

	closed := make(chan struct{})
	go func() {
		manager.Close()
		close(closed)
	}()
	waitClosed(t, probeCancelled, "probe cancellation")
	assertNoSignal(t, closed, "Close returned before probe exit")
	close(releaseProbe)
	waitClosed(t, closed, "Close")
}

func TestPathRetryHonorsDeadlineAndPreservesWorkerError(t *testing.T) {
	clock := newTestClock()
	media := &pathRetryMedia{replaceErrors: []error{errors.New("temporary path failure"), nil}}
	result := decision{required: true, transcodeVideo: true, workerUnits: 1, reasons: []string{"conversion required"}}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), media: media, now: clock.Now,
		workerCapacity: 1, entries: map[string]*entry{
			"channel": {
				fingerprint: "source", srt: true, classified: true, decision: result,
				state: State{State: StateStarting, Mode: ModeTranscoded, Required: true},
			},
			"blocker": {worker: &worker{units: 1}},
		},
	}
	configured := channel.Channel{ID: "channel"}

	manager.ensureTranscoded(context.Background(), configured, result, mediamtx.Channel{})
	failed := manager.Snapshot(configured.ID)
	if failed.State != StateError || !strings.Contains(failed.LastError, "temporary path failure") || media.ReplaceCount() != 1 {
		t.Fatalf("initial path failure state = %#v, replacements = %d", failed, media.ReplaceCount())
	}
	clock.Advance(probeRetryDelay - time.Nanosecond)
	manager.ensureTranscoded(context.Background(), configured, result, mediamtx.Channel{})
	if media.ReplaceCount() != 1 {
		t.Fatalf("ReplacePath called before retry deadline: %d calls", media.ReplaceCount())
	}

	clock.Advance(time.Nanosecond)
	manager.ensureTranscoded(context.Background(), configured, result, mediamtx.Channel{})
	queued := manager.Snapshot(configured.ID)
	if media.ReplaceCount() != 2 || !queued.Worker.Queued || queued.LastError != failed.LastError || queued.Worker.Error == "" {
		t.Fatalf("queued retry state = %#v, replacements = %d", queued, media.ReplaceCount())
	}

	manager.mu.Lock()
	manager.entries["blocker"].worker = nil
	manager.entries[configured.ID].worker = &worker{cancel: func() {}, started: clock.Now(), units: 1}
	manager.mu.Unlock()
	manager.ensureTranscoded(context.Background(), configured, result, mediamtx.Channel{Name: CompatibilityPath(configured.ID)})
	restarting := manager.Snapshot(configured.ID)
	if restarting.State != StateError || !restarting.Worker.Running || restarting.LastError != failed.LastError || restarting.Worker.Error == "" {
		t.Fatalf("restarting worker state = %#v", restarting)
	}

	manager.ensureTranscoded(context.Background(), configured, result, mediamtx.Channel{
		Name: CompatibilityPath(configured.ID), Available: true, Online: true,
	})
	ready := manager.Snapshot(configured.ID)
	if ready.State != StateReady || ready.LastError != "" || ready.Worker.Error != "" || ready.Worker.Queued {
		t.Fatalf("ready worker state = %#v", ready)
	}
}

func TestStaleOutputDoesNotBecomeReadyWithoutCurrentWorker(t *testing.T) {
	result := decision{required: true, transcodeVideo: true, workerUnits: 1, reasons: []string{"conversion required"}}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), workerCapacity: 1,
		entries: map[string]*entry{
			"channel": {
				fingerprint: "new-source", srt: true, classified: true, decision: result,
				state: State{State: StateStarting, Mode: ModeTranscoded, Required: true},
			},
			"blocker": {worker: &worker{units: 1}},
		},
	}

	manager.ensureTranscoded(context.Background(), channel.Channel{ID: "channel"}, result, mediamtx.Channel{
		Name: CompatibilityPath("channel"), Available: true, Online: true,
	})
	state := manager.Snapshot("channel")
	if state.State == StateReady || state.Worker.Running || !state.Worker.Queued {
		t.Fatalf("stale output state = %#v", state)
	}
}

func TestSourceGenerationChangeDeletesStaleCompatibilityOutput(t *testing.T) {
	media := &reconcileMediaManager{}
	workerCancelled := false
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), media: media,
		entries: map[string]*entry{
			"channel": {
				fingerprint: "old-source", srt: true, classified: true,
				worker: &worker{cancel: func() { workerCancelled = true }},
				state:  State{State: StateReady, Mode: ModeTranscoded, Required: true},
			},
		},
	}
	configured := srtChannel("channel", "raw")
	raw := srtRuntime("new-source", []mediamtx.Track{{Codec: "H264"}})
	compatPath := CompatibilityPath(configured.ID)

	manager.reconcileChannel(context.Background(), configured, map[string]mediamtx.Channel{
		configured.Path: raw,
		compatPath:      {Name: compatPath, Available: true, Online: true},
	})
	if !workerCancelled || !reflect.DeepEqual(media.deleted, []string{compatPath}) {
		t.Fatalf("worker cancelled = %v, deleted paths = %#v", workerCancelled, media.deleted)
	}
	state := manager.Snapshot(configured.ID)
	if state.State != StateProbing || state.InputFingerprint != fingerprint(raw) {
		t.Fatalf("new generation state = %#v", state)
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

	manager.ensureTranscoded(context.Background(), channel.Channel{ID: "channel-id"}, result, mediamtx.Channel{
		Name: "compat-channel-id", Available: true, Online: false,
	})

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

type testClock struct {
	mu    sync.Mutex
	value time.Time
}

func newTestClock() *testClock {
	return &testClock{value: time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)}
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.value
}

func (c *testClock) Advance(duration time.Duration) {
	c.mu.Lock()
	c.value = c.value.Add(duration)
	c.mu.Unlock()
}

type probeResult struct {
	characteristics videoCharacteristics
	err             error
}

type controlledProbe struct {
	result chan probeResult
	done   chan struct{}
}

type pathRetryMedia struct {
	mu            sync.Mutex
	replaceErrors []error
	replaceCount  int
}

func (m *pathRetryMedia) Status(context.Context) (mediamtx.Status, error) {
	return mediamtx.Status{}, nil
}

func (m *pathRetryMedia) ReplacePath(context.Context, string, mediamtx.PathConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.replaceCount++
	if len(m.replaceErrors) == 0 {
		return nil
	}
	err := m.replaceErrors[0]
	m.replaceErrors = m.replaceErrors[1:]
	return err
}

func (m *pathRetryMedia) DeletePath(context.Context, string) error {
	return nil
}

func (m *pathRetryMedia) ReplaceCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.replaceCount
}

func newProbeTestManager(t *testing.T, clock *testClock, probe func(context.Context, string) (videoCharacteristics, error)) *Manager {
	t.Helper()
	rtspURL, err := url.Parse("rtsp://127.0.0.1:8554")
	if err != nil {
		t.Fatal(err)
	}
	return &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), rtspURL: rtspURL,
		entries: make(map[string]*entry), workerCapacity: 1, now: clock.Now, probeVideo: probe,
	}
}

func srtChannel(id, path string) channel.Channel {
	return channel.Channel{ID: id, Path: path, Enabled: true, Input: channel.Input{Mode: channel.InputSRTPush}}
}

func srtRuntime(generation string, tracks []mediamtx.Track) mediamtx.Channel {
	return mediamtx.Channel{
		Name: "raw", Available: true, Online: true, AvailableTime: &generation,
		Source: &mediamtx.PathSource{Type: "srtConn", ID: generation}, Tracks: tracks,
	}
}

func waitForState(t *testing.T, manager *Manager, channelID string, ready func(State) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ready(manager.Snapshot(channelID)) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("state did not converge: %#v", manager.Snapshot(channelID))
}

func waitClosed(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func receiveProbeCall(t *testing.T, calls <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for probe call")
		return nil
	}
}

func receiveControlledProbe(t *testing.T, calls <-chan *controlledProbe) *controlledProbe {
	t.Helper()
	select {
	case call := <-calls:
		return call
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for controlled probe")
		return nil
	}
}

func assertNoProbeCall(t *testing.T, calls <-chan map[string]any) {
	t.Helper()
	assertNoSignal(t, calls, "unexpected probe")
}

func assertNoSignal[T any](t *testing.T, signal <-chan T, description string) {
	t.Helper()
	select {
	case <-signal:
		t.Fatal(description)
	default:
	}
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
