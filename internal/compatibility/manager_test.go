package compatibility

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/exec"
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

func TestParseH264StreamMetadataAcceptsCompleteSafeStream(t *testing.T) {
	for _, pixelFormat := range []string{"yuv420p", "yuvj420p"} {
		t.Run(pixelFormat, func(t *testing.T) {
			input := `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"` + pixelFormat + `","width":1920,"height":1080,"field_order":"progressive"}]}`
			got, err := parseH264StreamMetadata([]byte(input))
			want := progressiveVideo("h264", pixelFormat, 1920, 1080)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("parseH264StreamMetadata() = %#v, %v; want %#v", got, err, want)
			}
		})
	}
}

func TestParseH264StreamMetadataRejectsUnsafeOrIncompleteStream(t *testing.T) {
	tests := []struct {
		name string
		json string
	}{
		{name: "malformed JSON", json: `not json`},
		{name: "missing stream", json: `{"streams":[]}`},
		{name: "multiple streams", json: `{"streams":[{},{}]}`},
		{name: "missing B-frame metadata", json: `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "non-Baseline profile", json: `{"streams":[{"codec_name":"h264","profile":"High","has_b_frames":0,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "unknown B-frame metadata", json: `{"streams":[{"codec_name":"h264","has_b_frames":"N/A","pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "malformed B-frame metadata", json: `{"streams":[{"codec_name":"h264","has_b_frames":false,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "contradictory codec", json: `{"streams":[{"codec_name":"hevc","has_b_frames":0,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "positive B-frame metadata", json: `{"streams":[{"codec_name":"h264","has_b_frames":2,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "incompatible pixel format", json: `{"streams":[{"codec_name":"h264","has_b_frames":0,"pix_fmt":"yuv422p","width":1920,"height":1080,"field_order":"progressive"}]}`},
		{name: "missing dimensions", json: `{"streams":[{"codec_name":"h264","has_b_frames":0,"pix_fmt":"yuv420p","field_order":"progressive"}]}`},
		{name: "unknown field order", json: `{"streams":[{"codec_name":"h264","has_b_frames":0,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"unknown"}]}`},
		{name: "interlaced field order", json: `{"streams":[{"codec_name":"h264","has_b_frames":0,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"tt"}]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got, err := parseH264StreamMetadata([]byte(test.json)); err == nil {
				t.Fatalf("parseH264StreamMetadata() = %#v, nil", got)
			}
		})
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
				fingerprint: "source", classified: true, decision: result, compatConfigured: true,
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

func TestFingerprintEncodingSeparatesNullableAndVariableLengthFields(t *testing.T) {
	empty := ""
	tests := []struct {
		name   string
		first  mediamtx.Channel
		second mediamtx.Channel
	}{
		{
			name:   "nil and empty source",
			first:  mediamtx.Channel{},
			second: mediamtx.Channel{Source: &mediamtx.PathSource{}},
		},
		{
			name:   "nil and empty availability",
			first:  mediamtx.Channel{},
			second: mediamtx.Channel{AvailableTime: &empty},
		},
		{
			name:   "source field boundaries",
			first:  mediamtx.Channel{Source: &mediamtx.PathSource{Type: "a", ID: "bc"}},
			second: mediamtx.Channel{Source: &mediamtx.PathSource{Type: "ab", ID: "c"}},
		},
		{
			name:   "codec boundaries",
			first:  mediamtx.Channel{Tracks: []mediamtx.Track{{Codec: "a"}, {Codec: "bc"}}},
			second: mediamtx.Channel{Tracks: []mediamtx.Track{{Codec: "ab"}, {Codec: "c"}}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			first := Fingerprint(test.first)
			if first == Fingerprint(test.second) {
				t.Fatalf("fingerprint collision: %q", first)
			}
			if first != Fingerprint(test.first) {
				t.Fatal("fingerprint encoding is not deterministic")
			}
		})
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

func TestCompatibilityPathReanchorsConvertedTimestamps(t *testing.T) {
	media := &pathRetryMedia{}
	result := decision{required: true, transcodeVideo: true, workerUnits: 1}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), media: media, workerCapacity: 1,
		entries: map[string]*entry{
			"channel": {
				fingerprint: "source", classified: true, decision: result,
				state: State{State: StateStarting, Mode: ModeTranscoded, Required: true},
			},
			"blocker": {worker: &worker{units: 1}},
		},
	}
	configured := channel.Channel{ID: "channel", MaxReaders: 0, UseAbsoluteTimestamp: true}
	output := mediamtx.Channel{Name: CompatibilityPath(configured.ID)}

	manager.ensureTranscoded(context.Background(), configured, result, output)
	configs := media.Configs()
	if len(configs) != 1 || configs[0].UseAbsoluteTimestamp || configs[0].MaxReaders != 0 {
		t.Fatalf("initial compatibility configs = %#v", configs)
	}
	manager.ensureTranscoded(context.Background(), configured, result, output)
	configured.UseAbsoluteTimestamp = false
	manager.ensureTranscoded(context.Background(), configured, result, output)
	if configs = media.Configs(); len(configs) != 1 {
		t.Fatalf("timestamp toggle refreshed compatibility path: %#v", configs)
	}
	configured.MaxReaders = 5
	manager.ensureTranscoded(context.Background(), configured, result, output)
	configs = media.Configs()
	if len(configs) != 2 || configs[1].UseAbsoluteTimestamp || configs[1].MaxReaders != 5 {
		t.Fatalf("reader-limit compatibility configs = %#v", configs)
	}
}

func TestStaleOutputDoesNotBecomeReadyWithoutCurrentWorker(t *testing.T) {
	result := decision{required: true, transcodeVideo: true, workerUnits: 1, reasons: []string{"conversion required"}}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), workerCapacity: 1,
		entries: map[string]*entry{
			"channel": {
				fingerprint: "new-source", srt: true, classified: true, decision: result, compatConfigured: true,
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

func TestNextIntervalUsesEventsDeadlinesAndFallback(t *testing.T) {
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	manager := &Manager{
		interval: 2 * time.Second, activeInterval: 250 * time.Millisecond,
		now:     func() time.Time { return now },
		entries: map[string]*entry{"channel": {classified: true, state: State{State: StateReady}}},
	}
	if got := manager.nextInterval(); got != 2*time.Second {
		t.Fatalf("stable interval = %v", got)
	}
	manager.discovering = map[string]inputDiscovery{"channel": {deadline: now.Add(time.Second)}}
	if got := manager.nextInterval(); got != 250*time.Millisecond {
		t.Fatalf("input discovery interval = %v", got)
	}
	manager.discovering["channel"] = inputDiscovery{deadline: now.Add(-time.Millisecond)}
	if got := manager.nextInterval(); got != 2*time.Second {
		t.Fatalf("expired input discovery interval = %v", got)
	}
	clear(manager.discovering)
	manager.entries["channel"].state.State = StateStarting
	if got := manager.nextInterval(); got != 250*time.Millisecond {
		t.Fatalf("active interval = %v", got)
	}
	manager.entries["channel"].state.Worker.Queued = true
	if got := manager.nextInterval(); got != 2*time.Second {
		t.Fatalf("capacity-queued interval = %v, want periodic fallback", got)
	}
	manager.entries["channel"] = &entry{
		state: State{State: StateProbing},
		probe: &probeTask{},
	}
	if got := manager.nextInterval(); got != 2*time.Second {
		t.Fatalf("in-flight probe interval = %v, want event-driven fallback", got)
	}
	manager.entries["channel"] = &entry{
		state:            State{State: StateProbing},
		metadataDeadline: now.Add(40 * time.Millisecond),
	}
	if got := manager.nextInterval(); got != 40*time.Millisecond {
		t.Fatalf("metadata deadline interval = %v", got)
	}
	manager.entries["channel"] = &entry{
		classified: true,
		state:      State{State: StateError},
		retryAt:    now.Add(60 * time.Millisecond),
	}
	if got := manager.nextInterval(); got != 60*time.Millisecond {
		t.Fatalf("retry deadline interval = %v", got)
	}
	manager.entries["channel"].retryAt = now.Add(-time.Millisecond)
	if got := manager.nextInterval(); got != 250*time.Millisecond {
		t.Fatalf("elapsed retry deadline interval = %v, want active interval", got)
	}
	manager.entries["channel"] = &entry{
		classified: true,
		state:      State{State: StateStarting},
		worker: &worker{
			started: now.Add(-workerStartupTimeout + 80*time.Millisecond),
		},
	}
	if got := manager.nextInterval(); got != 80*time.Millisecond {
		t.Fatalf("startup deadline interval = %v", got)
	}
	manager.entries["channel"].worker.started = now.Add(-workerStartupTimeout)
	if got := manager.nextInterval(); got != 250*time.Millisecond {
		t.Fatalf("elapsed startup deadline interval = %v, want active interval", got)
	}
	manager.entries["channel"] = &entry{
		state:            State{State: StateProbing},
		metadataDeadline: now.Add(-time.Millisecond),
	}
	if got := manager.nextInterval(); got != 250*time.Millisecond {
		t.Fatalf("elapsed metadata deadline interval = %v, want active interval", got)
	}
}

func TestSRTInputStartedWakesWithFreshStatus(t *testing.T) {
	configured := srtChannel("channel", "raw")
	media := &wakeMediaManager{
		status:      mediamtx.Status{Channels: []mediamtx.Channel{{Name: "raw"}}},
		freshStatus: mediamtx.Status{Channels: []mediamtx.Channel{srtRuntime("generation-a", []mediamtx.Track{{Codec: "Opus"}})}},
		statusCalls: make(chan struct{}, 4),
		freshCalls:  make(chan struct{}, 4),
	}
	manager, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Channels: reconcileChannelReader{items: []channel.Channel{configured}}, MediaMTX: media,
		MediaRTSPURL: "rtsp://127.0.0.1:8554", Interval: time.Hour, ActiveInterval: 10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		manager.Run(ctx)
		close(runDone)
	}()
	waitClosed(t, media.statusCalls, "initial cached status")

	manager.SRTInputStarted(configured.ID)
	waitClosed(t, media.freshCalls, "fresh status after SRT input")
	waitForState(t, manager, configured.ID, func(state State) bool {
		return state.State == StateReady && state.Mode == ModeDirect
	})
	manager.mu.RLock()
	_, discovering := manager.discovering[configured.ID]
	manager.mu.RUnlock()
	if discovering {
		t.Fatal("input discovery remained active after MediaMTX reported the path online")
	}

	cancel()
	waitClosed(t, runDone, "manager run")
	manager.SRTInputStarted(configured.ID)
	assertNoSignal(t, media.freshCalls, "fresh status requested after manager close")
}

func TestInputDiscoveryWaitsForNewSourceFingerprint(t *testing.T) {
	configured := srtChannel("channel", "raw")
	oldRuntime := srtRuntime("old-generation", []mediamtx.Track{{Codec: "Opus"}})
	newRuntime := srtRuntime("new-generation", []mediamtx.Track{{Codec: "Opus"}})
	media := &reconcileMediaManager{status: mediamtx.Status{Channels: []mediamtx.Channel{oldRuntime}}}
	rtspURL, err := url.Parse("rtsp://127.0.0.1:8554")
	if err != nil {
		t.Fatal(err)
	}
	manager := &Manager{
		logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		channels: reconcileChannelReader{items: []channel.Channel{configured}}, media: media, rtspURL: rtspURL,
		entries: map[string]*entry{configured.ID: {
			fingerprint: fingerprint(oldRuntime), srt: true, classified: true,
			state: State{State: StateReady, Mode: ModeDirect},
		}},
		discovering: map[string]inputDiscovery{configured.ID: {
			deadline: time.Now().Add(time.Second), previousFingerprint: fingerprint(oldRuntime),
		}},
	}

	manager.reconcile(context.Background())
	if _, ok := manager.discovering[configured.ID]; !ok {
		t.Fatal("discovery ended while MediaMTX still exposed the previous source")
	}
	media.status = mediamtx.Status{Channels: []mediamtx.Channel{newRuntime}}
	manager.reconcile(context.Background())
	manager.workers.Wait()
	if _, ok := manager.discovering[configured.ID]; ok {
		t.Fatal("discovery remained active after MediaMTX exposed the new source")
	}
}

func TestH264ProfileExcludesBFrames(t *testing.T) {
	for _, profile := range []string{"Baseline", "Constrained Baseline", "constrained-baseline"} {
		if !h264ProfileExcludesBFrames(profile) {
			t.Errorf("h264ProfileExcludesBFrames(%q) = false", profile)
		}
	}
	for _, profile := range []string{"", "Main", "High", "High 4:2:2"} {
		if h264ProfileExcludesBFrames(profile) {
			t.Errorf("h264ProfileExcludesBFrames(%q) = true", profile)
		}
	}
}

func TestRunWakesImmediatelyWhenProbeCompletes(t *testing.T) {
	configured := srtChannel("channel", "raw")
	media := &wakeMediaManager{
		status: mediamtx.Status{Channels: []mediamtx.Channel{srtRuntime("generation-a", []mediamtx.Track{{
			Codec: "H264", CodecProps: map[string]any{"width": 1920, "height": 1080, "profile": "Baseline"},
		}})}},
		statusCalls: make(chan struct{}, 4),
	}
	manager, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Channels: reconcileChannelReader{items: []channel.Channel{configured}}, MediaMTX: media,
		MediaRTSPURL: "rtsp://127.0.0.1:8554", Interval: 3 * time.Second, ActiveInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	probeStarted := make(chan struct{})
	releaseProbe := make(chan struct{})
	manager.probeVideo = func(context.Context, string) (videoCharacteristics, error) {
		close(probeStarted)
		<-releaseProbe
		return progressiveVideo("h264", "yuv420p", 1920, 1080), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		manager.Run(ctx)
		close(runDone)
	}()
	waitClosed(t, probeStarted, "probe start")
	waitClosed(t, media.statusCalls, "initial status")
	close(releaseProbe)
	select {
	case <-media.statusCalls:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("probe completion did not wake reconciliation before fallback interval")
	}
	cancel()
	waitClosed(t, runDone, "manager run")
}

func TestCloseStopsWakeReconcileBeforeMediaMutation(t *testing.T) {
	media := &wakeMediaManager{
		statusCalls: make(chan struct{}, 2),
		deleteCalls: make(chan string, 1),
	}
	manager, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Channels: reconcileChannelReader{}, MediaMTX: media,
		MediaRTSPURL: "rtsp://127.0.0.1:8554", Interval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		manager.Run(ctx)
		close(runDone)
	}()
	waitClosed(t, media.statusCalls, "initial reconciliation")

	media.mu.Lock()
	media.status.Channels = []mediamtx.Channel{{Name: "compat-orphan"}}
	media.mu.Unlock()
	manager.Close()
	manager.notify()

	select {
	case path := <-media.deleteCalls:
		t.Fatalf("wake reconciliation deleted %q after Close returned", path)
	case <-runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not exit promptly after Close")
	}
	assertNoSignal(t, media.deleteCalls, "MediaMTX mutation after Close")
}

func TestCloseCancelsBlockedReconciliation(t *testing.T) {
	channels := &cancelBlockingChannelReader{
		started:  make(chan struct{}),
		canceled: make(chan struct{}),
	}
	manager, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Channels: channels, MediaMTX: &reconcileMediaManager{},
		MediaRTSPURL: "rtsp://127.0.0.1:8554",
	})
	if err != nil {
		t.Fatal(err)
	}
	runDone := make(chan struct{})
	go func() {
		manager.Run(context.Background())
		close(runDone)
	}()
	waitClosed(t, channels.started, "blocked reconciliation")

	closeDone := make(chan struct{}, 3)
	for range 3 {
		go func() {
			manager.Close()
			closeDone <- struct{}{}
		}()
	}
	waitClosed(t, channels.canceled, "reconciliation context cancellation")
	for range 3 {
		waitClosed(t, closeDone, "concurrent Close")
	}
	waitClosed(t, runDone, "Run after reconciliation cancellation")

	afterClose := make(chan struct{})
	go func() {
		manager.Run(context.Background())
		close(afterClose)
	}()
	waitClosed(t, afterClose, "Run after Close")
}

func TestWorkerExitWakesCapacityWaiters(t *testing.T) {
	workerCtx, cancelWorker := context.WithCancel(context.Background())
	cmd := exec.CommandContext(workerCtx, "/bin/sh", "-c", "exit 0")
	stderr := newRingWriter(128)
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	running := &worker{cancel: cancelWorker, cmd: cmd, stderr: stderr, started: time.Now(), units: 1}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), wake: make(chan struct{}, 1),
		entries: map[string]*entry{
			"running": {worker: running, state: State{State: StateReady}},
			"queued":  {state: State{State: StateStarting, Worker: WorkerState{Queued: true}}},
		},
	}
	manager.workers.Add(1)
	go manager.waitWorker("running", running)
	waitClosed(t, manager.wake, "worker-exit capacity wake")
	manager.workers.Wait()
	manager.mu.RLock()
	used := manager.usedWorkerCapacityLocked()
	worker := manager.entries["running"].worker
	manager.mu.RUnlock()
	if used != 0 || worker != nil {
		t.Fatalf("worker capacity after exit = %d, worker = %#v", used, worker)
	}
}

func TestCloseWaitsForSpawnOutsideManagerLock(t *testing.T) {
	rtspURL, err := url.Parse("rtsp://127.0.0.1:8554")
	if err != nil {
		t.Fatal(err)
	}
	spawnEntered := make(chan struct{})
	releaseSpawn := make(chan struct{})
	result := decision{required: true, transcodeVideo: true, workerUnits: 1}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), rtspURL: rtspURL, ffmpeg: "/bin/true",
		workerCapacity: 1, entries: map[string]*entry{
			"channel": {
				fingerprint: "source", generation: 7, classified: true, decision: result, compatConfigured: true,
				state: State{State: StateStarting, Mode: ModeTranscoded, Required: true},
			},
		},
		wake: make(chan struct{}, 1),
		startCommand: func(cmd *exec.Cmd) error {
			close(spawnEntered)
			<-releaseSpawn
			return cmd.Start()
		},
	}
	spawnDone := make(chan struct{})
	go func() {
		manager.ensureTranscoded(context.Background(), channel.Channel{ID: "channel", Path: "raw"}, result, mediamtx.Channel{Name: CompatibilityPath("channel")})
		close(spawnDone)
	}()
	waitClosed(t, spawnEntered, "worker spawn")
	snapshotDone := make(chan struct{})
	go func() {
		_ = manager.Snapshot("channel")
		close(snapshotDone)
	}()
	waitClosed(t, snapshotDone, "snapshot during worker spawn")

	closeDone := make(chan struct{})
	go func() {
		manager.Close()
		close(closeDone)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		manager.mu.RLock()
		closed := manager.closed
		manager.mu.RUnlock()
		if closed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Close did not synchronize with spawn reservation")
		}
		time.Sleep(time.Millisecond)
	}
	assertNoSignal(t, closeDone, "Close returned while spawn was in flight")
	close(releaseSpawn)
	waitClosed(t, spawnDone, "worker spawn completion")
	waitClosed(t, closeDone, "Close after worker spawn")
	manager.mu.RLock()
	worker := manager.entries["channel"].worker
	restarts := manager.entries["channel"].state.Worker.Restarts
	manager.mu.RUnlock()
	if worker != nil || restarts != 0 {
		t.Fatalf("closed spawn committed worker %#v or changed restarts to %d", worker, restarts)
	}
}

func TestWorkerStartFailureCommitsCoherentErrorState(t *testing.T) {
	clock := newTestClock()
	rtspURL, err := url.Parse("rtsp://127.0.0.1:8554")
	if err != nil {
		t.Fatal(err)
	}
	startErr := errors.New("start failed")
	result := decision{required: true, transcodeVideo: true, workerUnits: 1, reasons: []string{"conversion required"}}
	manager := &Manager{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), rtspURL: rtspURL,
		ffmpeg: "/bin/true", workerCapacity: 1, now: clock.Now,
		startCommand: func(*exec.Cmd) error { return startErr },
		entries: map[string]*entry{"channel": {
			fingerprint: "source", generation: 7, classified: true, decision: result,
			state: State{State: StateStarting, Worker: WorkerState{Restarts: 2}},
		}},
	}
	manager.mu.Lock()
	running := manager.reserveWorkerLocked(context.Background(), channel.Channel{ID: "channel", Path: "raw"}, manager.entries["channel"], result, 1)
	manager.mu.Unlock()
	manager.startReservedWorker("channel", running, result)
	state := manager.Snapshot("channel")
	manager.mu.RLock()
	retryAt := manager.entries["channel"].retryAt
	worker := manager.entries["channel"].worker
	manager.mu.RUnlock()
	if state.State != StateError || state.Mode != ModeTranscoded || !state.Required ||
		!reflect.DeepEqual(state.Reasons, result.reasons) || state.LastError != startErr.Error() ||
		state.Worker.Running || state.Worker.Queued || state.Worker.Restarts != 3 || state.Worker.Error != startErr.Error() ||
		state.OutputPath != CompatibilityPath("channel") || state.InputFingerprint != "source" || worker != nil {
		t.Fatalf("start failure state = %#v", state)
	}
	if want := clock.Now().Add(retryDelay(2)); !retryAt.Equal(want) {
		t.Fatalf("start failure retry = %v, want %v", retryAt, want)
	}
}

func TestRingWriterKeepsExactTailAcrossWraps(t *testing.T) {
	writer := newRingWriter(7)
	var reference []byte
	for _, chunk := range [][]byte{[]byte("  ab"), []byte("c"), []byte("defgh"), []byte("ij\n"), []byte("0123456789 "), []byte("XY")} {
		written, err := writer.Write(chunk)
		if err != nil || written != len(chunk) {
			t.Fatalf("Write(%q) = %d, %v", chunk, written, err)
		}
		reference = append(reference, chunk...)
		if len(reference) > 7 {
			reference = reference[len(reference)-7:]
		}
		if got, want := writer.String(), string(bytes.TrimSpace(reference)); got != want {
			t.Fatalf("tail after %q = %q, want %q", chunk, got, want)
		}
	}
	zero := newRingWriter(0)
	if written, err := zero.Write([]byte("discarded")); err != nil || written != len("discarded") || zero.String() != "" {
		t.Fatalf("zero-limit writer = %d, %v, %q", written, err, zero.String())
	}
}

func TestProbeVideoCharacteristicsUsesH264StreamMetadataWithoutFrameScan(t *testing.T) {
	directory := t.TempDir()
	probe := filepath.Join(directory, "ffprobe")
	calls := filepath.Join(directory, "calls")
	output := `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + calls + "'\n" +
		"case \" $* \" in *\" -select_streams v:0 \"*) ;; *) exit 2;; esac\n" +
		"case \" $* \" in *\" -show_entries stream=codec_name,profile,has_b_frames,pix_fmt,width,height,field_order \"*) ;; *) exit 3;; esac\n" +
		"case \" $* \" in *\" -read_intervals \"*|*\" -show_frames \"*) exit 4;; esac\n" +
		"printf '%s' '" + output + "'\n"
	writeExecutable(t, probe, script)

	manager := &Manager{ffprobe: probe}
	characteristics, err := manager.probeVideoCharacteristics(context.Background(), "rtsp://input/raw", "H264")
	if err != nil || !reflect.DeepEqual(characteristics, progressiveVideo("h264", "yuv420p", 1920, 1080)) {
		t.Fatalf("probeVideoCharacteristics() = %#v, %v", characteristics, err)
	}
	if got := readLines(t, calls); len(got) != 1 || !strings.Contains(got[0], "-show_streams") || strings.Contains(got[0], "-show_frames") {
		t.Fatalf("ffprobe calls = %#v", got)
	}
}

func TestProbeVideoCharacteristicsFallsBackForUntrustedH264Metadata(t *testing.T) {
	metadata := []struct {
		name   string
		output string
	}{
		{name: "missing", output: `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}]}`},
		{name: "unknown", output: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":"N/A","pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"unknown"}]}`},
		{name: "contradictory", output: `{"streams":[{"codec_name":"hevc","has_b_frames":0,"pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}]}`},
		{name: "positive B-frame", output: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":1,"pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}]}`},
		{name: "incompatible pixel format", output: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"yuv444p","width":1280,"height":720,"field_order":"progressive"}]}`},
		{name: "interlaced", output: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"tt"}]}`},
		{name: "malformed", output: `not json`},
	}
	frames := `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0}]}`
	for _, test := range metadata {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			probe := filepath.Join(directory, "ffprobe")
			calls := filepath.Join(directory, "calls")
			script := "#!/bin/sh\n" +
				"printf '%s\\n' \"$*\" >> '" + calls + "'\n" +
				"case \" $* \" in\n" +
				"  *\"has_b_frames\"*) printf '%s' '" + test.output + "' ;;\n" +
				"  *) printf '%s' '" + frames + "' ;;\n" +
				"esac\n"
			writeExecutable(t, probe, script)

			manager := &Manager{ffprobe: probe}
			characteristics, err := manager.probeVideoCharacteristics(context.Background(), "rtsp://input/raw", "h264")
			if err != nil || !reflect.DeepEqual(characteristics, progressiveVideo("h264", "yuv420p", 1280, 720)) {
				t.Fatalf("probeVideoCharacteristics() = %#v, %v", characteristics, err)
			}
			assertMetadataThenFrameScan(t, readLines(t, calls))
		})
	}
}

func TestProbeVideoCharacteristicsFallsBackAfterMetadataCommandFailure(t *testing.T) {
	directory := t.TempDir()
	probe := filepath.Join(directory, "ffprobe")
	calls := filepath.Join(directory, "calls")
	frames := `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":480}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0}]}`
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + calls + "'\n" +
		"case \" $* \" in\n" +
		"  *\"has_b_frames\"*) printf '%s\\n' 'metadata unavailable' >&2; exit 12 ;;\n" +
		"  *) printf '%s' '" + frames + "' ;;\n" +
		"esac\n"
	writeExecutable(t, probe, script)

	manager := &Manager{ffprobe: probe}
	characteristics, err := manager.probeVideoCharacteristics(context.Background(), "rtsp://input/raw", "h264")
	if err != nil || !reflect.DeepEqual(characteristics, progressiveVideo("h264", "yuv420p", 640, 480)) {
		t.Fatalf("probeVideoCharacteristics() = %#v, %v", characteristics, err)
	}
	assertMetadataThenFrameScan(t, readLines(t, calls))
}

func TestProbeVideoCharacteristicsFallsBackWhenMediaMTXDimensionsDiffer(t *testing.T) {
	directory := t.TempDir()
	probe := filepath.Join(directory, "ffprobe")
	calls := filepath.Join(directory, "calls")
	metadata := `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}]}`
	frames := `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"field_order":"progressive"}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0}]}`
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + calls + "'\n" +
		"case \" $* \" in\n" +
		"  *\"has_b_frames\"*) printf '%s' '" + metadata + "' ;;\n" +
		"  *) printf '%s' '" + frames + "' ;;\n" +
		"esac\n"
	writeExecutable(t, probe, script)

	manager := &Manager{ffprobe: probe}
	characteristics, err := manager.probeVideoCharacteristics(context.Background(), "rtsp://input/raw", "h264", 1920, 1080)
	if err != nil || characteristics.width != 1280 || characteristics.height != 720 {
		t.Fatalf("probeVideoCharacteristics() = %#v, %v", characteristics, err)
	}
	assertMetadataThenFrameScan(t, readLines(t, calls))
}

func TestProbeVideoCharacteristicsSkipsMetadataForNonH264ExpectedVideo(t *testing.T) {
	directory := t.TempDir()
	probe := filepath.Join(directory, "ffprobe")
	calls := filepath.Join(directory, "calls")
	frames := `{"streams":[{"codec_name":"hevc","pix_fmt":"yuv420p10le","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0}]}`
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + calls + "'\n" +
		"case \" $* \" in *\"has_b_frames\"*) exit 9;; esac\n" +
		"printf '%s' '" + frames + "'\n"
	writeExecutable(t, probe, script)

	manager := &Manager{ffprobe: probe}
	characteristics, err := manager.probeVideoCharacteristics(context.Background(), "rtsp://input/raw", "H265")
	if err != nil || characteristics.codec != "hevc" {
		t.Fatalf("probeVideoCharacteristics() = %#v, %v", characteristics, err)
	}
	if got := readLines(t, calls); len(got) != 1 || strings.Contains(got[0], "has_b_frames") || !strings.Contains(got[0], "-read_intervals %+2") {
		t.Fatalf("ffprobe calls = %#v", got)
	}
}

func TestProbeVideoCharacteristicsCancellationDoesNotStartFallback(t *testing.T) {
	directory := t.TempDir()
	probe := filepath.Join(directory, "ffprobe")
	calls := filepath.Join(directory, "calls")
	metadataStarted := filepath.Join(directory, "metadata-started")
	script := "#!/bin/sh\n" +
		"printf '%s\\n' \"$*\" >> '" + calls + "'\n" +
		"case \" $* \" in\n" +
		"  *\"has_b_frames\"*) : > '" + metadataStarted + "'; exec sleep 10 ;;\n" +
		"  *) exit 17 ;;\n" +
		"esac\n"
	writeExecutable(t, probe, script)

	ctx, cancel := context.WithCancel(context.Background())
	manager := &Manager{ffprobe: probe}
	done := make(chan error, 1)
	go func() {
		_, err := manager.probeVideoCharacteristics(ctx, "rtsp://input/raw", "h264")
		done <- err
	}()
	waitForFile(t, metadataStarted)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("probe error = %v, want context cancellation", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled metadata probe did not exit")
	}
	if got := readLines(t, calls); len(got) != 1 || !strings.Contains(got[0], "has_b_frames") {
		t.Fatalf("ffprobe calls after cancellation = %#v", got)
	}
}

func TestH264MetadataFallbackPreservesClassificationReasons(t *testing.T) {
	tests := []struct {
		name     string
		metadata string
		frames   string
		reason   string
	}{
		{
			name:     "B-frames",
			metadata: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":1,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"progressive"}]}`,
			frames:   `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0},{"pict_type":"B","interlaced_frame":0,"top_field_first":0}]}`,
			reason:   "H264 contains B-frames and requires low-latency H264 conversion.",
		},
		{
			name:     "pixel format",
			metadata: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"yuv422p","width":1920,"height":1080,"field_order":"progressive"}]}`,
			frames:   `{"streams":[{"codec_name":"h264","pix_fmt":"yuv422p","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":0,"top_field_first":0}]}`,
			reason:   "H264 uses yuv422p; browser-compatible H264 requires 8-bit yuv420p.",
		},
		{
			name:     "interlace",
			metadata: `{"streams":[{"codec_name":"h264","profile":"Constrained Baseline","has_b_frames":0,"pix_fmt":"yuv420p","width":1920,"height":1080,"field_order":"tt"}]}`,
			frames:   `{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1920,"height":1080}],"frames":[{"pict_type":"I","interlaced_frame":1,"top_field_first":1}]}`,
			reason:   "H264 is interlaced (top-field-first) and requires send-field deinterlacing.",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := filepath.Join(t.TempDir(), "ffprobe")
			script := "#!/bin/sh\ncase \" $* \" in\n" +
				"  *\"has_b_frames\"*) printf '%s' '" + test.metadata + "' ;;\n" +
				"  *) printf '%s' '" + test.frames + "' ;;\n" +
				"esac\n"
			writeExecutable(t, probe, script)
			manager := &Manager{ffprobe: probe}

			result, err := classifyTracks(context.Background(), []mediamtx.Track{{Codec: "H264"}}, func(ctx context.Context) (videoCharacteristics, error) {
				return manager.probeVideoCharacteristics(ctx, "rtsp://input/raw", "h264")
			})
			if err != nil || !result.required || !result.transcodeVideo || !reflect.DeepEqual(result.reasons, []string{test.reason}) {
				t.Fatalf("classification = %#v, %v", result, err)
			}
		})
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
		fingerprint:      "source-id",
		classified:       true,
		decision:         result,
		compatConfigured: true,
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

type cancelBlockingChannelReader struct {
	started  chan struct{}
	canceled chan struct{}
}

func (r *cancelBlockingChannelReader) List(ctx context.Context) ([]channel.Channel, error) {
	close(r.started)
	<-ctx.Done()
	close(r.canceled)
	return nil, ctx.Err()
}

type reconcileMediaManager struct {
	status       mediamtx.Status
	deleteErrors []error
	deleted      []string
}

type wakeMediaManager struct {
	mu          sync.Mutex
	status      mediamtx.Status
	freshStatus mediamtx.Status
	statusCalls chan struct{}
	freshCalls  chan struct{}
	deleteCalls chan string
}

func (m *wakeMediaManager) Status(context.Context) (mediamtx.Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.statusCalls != nil {
		m.statusCalls <- struct{}{}
	}
	return m.status, nil
}

func (m *wakeMediaManager) StatusFresh(context.Context) (mediamtx.Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.freshStatus.Channels != nil {
		m.status = m.freshStatus
	}
	if m.freshCalls != nil {
		m.freshCalls <- struct{}{}
	}
	return m.status, nil
}

func (m *wakeMediaManager) ReplacePath(context.Context, string, mediamtx.PathConfig) error {
	return nil
}

func (m *wakeMediaManager) DeletePath(_ context.Context, path string) error {
	if m.deleteCalls != nil {
		m.deleteCalls <- path
	}
	return nil
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
	configs       []mediamtx.PathConfig
}

func (m *pathRetryMedia) Status(context.Context) (mediamtx.Status, error) {
	return mediamtx.Status{}, nil
}

func (m *pathRetryMedia) StatusFresh(ctx context.Context) (mediamtx.Status, error) {
	return m.Status(ctx)
}

func (m *pathRetryMedia) ReplacePath(_ context.Context, _ string, config mediamtx.PathConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.replaceCount++
	m.configs = append(m.configs, config)
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

func (m *pathRetryMedia) Configs() []mediamtx.PathConfig {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]mediamtx.PathConfig(nil), m.configs...)
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

func (m *reconcileMediaManager) StatusFresh(ctx context.Context) (mediamtx.Status, error) {
	return m.Status(ctx)
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

func writeExecutable(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
		t.Fatal(err)
	}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	trimmed := strings.TrimSpace(string(contents))
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}

func assertMetadataThenFrameScan(t *testing.T, calls []string) {
	t.Helper()
	if len(calls) != 2 ||
		!strings.Contains(calls[0], "-show_entries stream=codec_name,profile,has_b_frames,pix_fmt,width,height,field_order") ||
		strings.Contains(calls[0], "-read_intervals") ||
		!strings.Contains(calls[1], "-read_intervals %+2") ||
		!strings.Contains(calls[1], "-show_frames") {
		t.Fatalf("ffprobe calls = %#v", calls)
	}
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", path)
}

func progressiveVideo(codec, pixelFormat string, width, height int) videoCharacteristics {
	return videoCharacteristics{codec: codec, pixelFormat: pixelFormat, width: width, height: height}
}
