package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/compatibility"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/project"
	"webrtc-gateway/internal/settings"
	"webrtc-gateway/internal/srtrelay"
	"webrtc-gateway/internal/telemetry"
)

type fakeMediaMTX struct {
	status mediamtx.Status
	global mediamtx.GlobalConfig
	err    error
}

type fakeStatusSnapshot struct {
	status       mediamtx.Status
	byPath       map[string]mediamtx.Channel
	channelCalls *atomic.Int32
}

func (f fakeStatusSnapshot) Status() mediamtx.Status {
	return f.status
}

func (f fakeStatusSnapshot) Channel(name string) (mediamtx.Channel, bool) {
	if f.channelCalls != nil {
		f.channelCalls.Add(1)
	}
	if f.byPath != nil {
		value, ok := f.byPath[name]
		return value, ok
	}
	for _, value := range f.status.Channels {
		if value.Name == name {
			return value, true
		}
	}
	return mediamtx.Channel{}, false
}

func (f fakeMediaMTX) Snapshot(context.Context) (mediamtx.StatusSnapshot, error) {
	return fakeStatusSnapshot{status: f.status}, f.err
}

func (f fakeMediaMTX) GetGlobal(context.Context) (mediamtx.GlobalConfig, error) {
	return f.global, f.err
}

func (f fakeMediaMTX) Reachable(context.Context) error { return f.err }

type indexedFakeMediaMTX struct {
	status        mediamtx.Status
	global        mediamtx.GlobalConfig
	byPath        map[string]mediamtx.Channel
	snapshotCalls atomic.Int32
	channelCalls  atomic.Int32
}

func (f *indexedFakeMediaMTX) Snapshot(context.Context) (mediamtx.StatusSnapshot, error) {
	f.snapshotCalls.Add(1)
	return fakeStatusSnapshot{status: f.status, byPath: f.byPath, channelCalls: &f.channelCalls}, nil
}

func (f *indexedFakeMediaMTX) GetGlobal(context.Context) (mediamtx.GlobalConfig, error) {
	return f.global, nil
}

type generationFakeMediaMTX struct {
	snapshotCalls atomic.Int32
}

func (f *generationFakeMediaMTX) Snapshot(context.Context) (mediamtx.StatusSnapshot, error) {
	generation := f.snapshotCalls.Add(1)
	raw := mediamtx.Channel{Name: "demo", Available: true, Online: true, InboundBytes: uint64(generation*100 + 1)}
	output := mediamtx.Channel{Name: "compat-channel-1", Available: true, Online: true, InboundBytes: uint64(generation*100 + 2)}
	return fakeStatusSnapshot{
		status: mediamtx.Status{Info: mediamtx.Info{Version: "generation-test"}, Channels: []mediamtx.Channel{raw, output}},
		byPath: map[string]mediamtx.Channel{raw.Name: raw, output.Name: output},
	}, nil
}

func (*generationFakeMediaMTX) GetGlobal(context.Context) (mediamtx.GlobalConfig, error) {
	return mediamtx.GlobalConfig{}, nil
}

type fakeChannels struct {
	items     []channel.Channel
	err       error
	deleteErr error
}

type fakePathManager struct{}

func (fakePathManager) ReplacePath(context.Context, string, mediamtx.PathConfig) error { return nil }
func (fakePathManager) DeletePath(context.Context, string) error                       { return nil }

type countingPathManager struct {
	replacements int
	deletions    int
}

func (f *countingPathManager) ReplacePath(context.Context, string, mediamtx.PathConfig) error {
	f.replacements++
	return nil
}

func (f *countingPathManager) DeletePath(context.Context, string) error {
	f.deletions++
	return nil
}

type fakeSettings struct {
	value settings.Settings
	err   error
}

type fakeProjects struct {
	item    project.Project
	loadErr error
}

func (f *fakeProjects) List(context.Context) ([]project.Summary, error) {
	return []project.Summary{f.item.Summary()}, nil
}
func (f *fakeProjects) Get(context.Context, string) (project.Project, error)  { return f.item, nil }
func (f *fakeProjects) Save(context.Context, string) (project.Project, error) { return f.item, nil }
func (f *fakeProjects) Import(context.Context, project.Manifest) (project.Project, error) {
	return f.item, nil
}
func (f *fakeProjects) Rename(context.Context, string, string, int) (project.Project, error) {
	return f.item, nil
}
func (f *fakeProjects) Overwrite(context.Context, string, string, int) (project.Project, error) {
	return f.item, nil
}
func (f *fakeProjects) Delete(context.Context, string, int) error { return nil }
func (f *fakeProjects) Load(context.Context, string, int) (project.LoadResult, error) {
	return project.LoadResult{ProjectID: f.item.ID, ProjectRevision: f.item.Revision, ChannelCount: len(f.item.Configuration.Channels)}, f.loadErr
}

type fakeCompatibility struct {
	state compatibility.State
}

func (f *fakeCompatibility) Snapshot(string) compatibility.State { return f.state }

type fakeRelays struct {
	status srtrelay.Status
}

type fakeResources struct {
	snapshot telemetry.Snapshot
}

func (f fakeResources) Snapshot() telemetry.Snapshot { return f.snapshot }

func (f fakeRelays) Snapshot(string) srtrelay.Status { return f.status }

func (f fakeSettings) Get(context.Context) (settings.Settings, error) {
	return f.value, f.err
}

func (f fakeSettings) Update(_ context.Context, value settings.Settings) (settings.Settings, error) {
	return value, f.err
}

func (f fakeSettings) UpdateExpected(_ context.Context, value settings.Settings, expectedRevision int) (settings.Settings, error) {
	if f.err != nil {
		return settings.Settings{}, f.err
	}
	if f.value.Revision != expectedRevision {
		return settings.Settings{}, settings.ErrRevisionConflict
	}
	value.Revision = expectedRevision + 1
	return value, nil
}

func (f fakeChannels) List(context.Context) ([]channel.Channel, error) {
	return f.items, f.err
}

func (f fakeChannels) Get(_ context.Context, id string) (channel.Channel, error) {
	for _, item := range f.items {
		if item.ID == id || (item.Number > 0 && strconv.Itoa(item.Number) == id) {
			return item, nil
		}
	}
	return channel.Channel{}, channel.ErrNotFound
}

func (f fakeChannels) Create(context.Context, channel.Draft) (channel.Channel, error) {
	return channel.Channel{}, errors.New("not implemented")
}

func (f fakeChannels) Update(context.Context, string, channel.Draft) (channel.Channel, error) {
	return channel.Channel{}, errors.New("not implemented")
}

func (f fakeChannels) UpdateExpected(ctx context.Context, id string, draft channel.Draft, _ int) (channel.Channel, error) {
	return f.Update(ctx, id, draft)
}

func (f fakeChannels) UpdateAutomaticPreview(_ context.Context, id string, enabled bool, _ *int) (channel.Channel, error) {
	item, err := f.Get(context.Background(), id)
	if err != nil {
		return channel.Channel{}, err
	}
	item.AutomaticPreview = enabled
	item.Revision++
	return item, nil
}

func (f fakeChannels) Delete(context.Context, string) error {
	if f.deleteErr != nil {
		return f.deleteErr
	}
	return errors.New("not implemented")
}

func TestDeleteReportsAcceptedWhileCleanupIsPending(t *testing.T) {
	handler := newTestHandler(t, fakeMediaMTX{}, fakeChannels{deleteErr: channel.ErrDeleting}, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodDelete, "/api/v1/channels/channel-1", nil))
	if res.Code != http.StatusAccepted || !strings.Contains(res.Body.String(), `"status":"deleting"`) {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
}

func TestProjectListRedactsSecretsAndExportIncludesThem(t *testing.T) {
	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	projects := &fakeProjects{item: project.Project{
		ID: "project-1", Revision: 2, Name: "Studio", CreatedAt: now, UpdatedAt: now,
		Configuration: project.Configuration{Channels: []project.Channel{{
			ID: "12345678-1234-4234-8234-123456789abc", Number: 1, Name: "Camera", Path: "camera-12345678",
			Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000, Passphrase: "secret-passphrase"}},
		}}},
	}}
	handler := newProjectTestHandler(t, projects)

	list := httptest.NewRecorder()
	handler.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	if list.Code != http.StatusOK || strings.Contains(list.Body.String(), "secret-passphrase") || !strings.Contains(list.Body.String(), `"channelCount":1`) {
		t.Fatalf("list response = %d %s", list.Code, list.Body.String())
	}

	export := httptest.NewRecorder()
	handler.ServeHTTP(export, httptest.NewRequest(http.MethodGet, "/api/v1/projects/project-1/export", nil))
	if export.Code != http.StatusOK || !strings.Contains(export.Body.String(), "secret-passphrase") || !strings.Contains(export.Header().Get("Content-Disposition"), "Studio.json") {
		t.Fatalf("export response = %d %s", export.Code, export.Body.String())
	}
}

func TestProjectLoadReportsSuccessfulRollback(t *testing.T) {
	projects := &fakeProjects{item: project.Project{ID: "project-1", Revision: 2, Name: "Studio"}}
	projects.loadErr = &project.LoadError{Cause: errors.New("listener unavailable")}
	handler := newProjectTestHandler(t, projects)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/project-1/load", nil)
	request.Header.Set("If-Match", `"2"`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"rollbackSucceeded":true`) {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestStatusEndpoint(t *testing.T) {
	channels := fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Name: "Demo", Path: "demo", Enabled: true,
		Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{}},
	}}}
	handler := newTestHandler(t, fakeMediaMTX{status: mediamtx.Status{
		Info:     mediamtx.Info{Version: "1.20.1"},
		Channels: []mediamtx.Channel{{Name: "demo", Online: true}},
	}}, channels, "http://127.0.0.1:1")

	req := httptest.NewRequest(http.MethodGet, "/api/v1/status", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.Code)
	}
	if body := res.Body.String(); !strings.Contains(body, `"name":"Demo"`) || !strings.Contains(body, `"version":"1.20.1"`) || !strings.Contains(body, `"management":{"activeAddress":"*","activeSelection":"*","desiredAddress":"*","resolvedAddress":"*","port":8080`) {
		t.Fatalf("unexpected response body: %s", body)
	}
}

func TestStatusIncludesResourceSnapshot(t *testing.T) {
	cpuPercent := 12.5
	usedCores := 2.5
	memoryTotal := uint64(8 * 1024 * 1024 * 1024)
	sampledAt := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	resources := telemetry.Snapshot{
		SampledAt: sampledAt,
		Gateway: telemetry.ResourceScope{
			Status: telemetry.StatusOK, Scope: "gateway-cgroup", SampledAt: &sampledAt, WindowMS: 1000,
			CPU:    telemetry.CPU{Percent: &cpuPercent, UsedCores: &usedCores, CapacityCores: 20},
			Memory: telemetry.Memory{UsedBytes: 512 * 1024 * 1024, TotalBytes: &memoryTotal},
		},
		Host:  telemetry.ResourceScope{Status: telemetry.StatusStale, Scope: "host", ErrorCode: "sample_failed"},
		Media: telemetry.ResourceAvailability{Status: telemetry.StatusUnavailable, Scope: "mediamtx-cgroup", ErrorCode: "isolated_scope"},
	}
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MediaMTX: fakeMediaMTX{}, Channels: fakeChannels{},
		Settings: fakeSettings{value: settings.Defaults(time.Now())}, Resources: fakeResources{snapshot: resources},
		MediaMTXWHEPURL: "http://127.0.0.1:1", Management: ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	body := res.Body.String()
	for _, expected := range []string{`"resources":`, `"status":"ok"`, `"windowMs":1000`, `"percent":12.5`, `"usedBytes":536870912`, `"errorCode":"isolated_scope"`} {
		if !strings.Contains(body, expected) {
			t.Fatalf("response missing %s: %s", expected, body)
		}
	}
}

func TestStatusResolvesInterfaceFollowingBindings(t *testing.T) {
	value := settings.Defaults(time.Now())
	value.ManagementBindAddress = "interface:ipv4:eth0"
	value.MediaBindAddress = "interface:ipv4:eth0"
	value.ApplyState = settings.ApplyApplied
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX: fakeMediaMTX{global: mediamtx.GlobalConfig{
			SRTAddress: "192.0.2.20:8890", RTMPAddress: "127.0.0.1:1935",
			WebRTCLocalUDPAddress: "192.0.2.20:8189", WebRTCLocalTCPAddress: "192.0.2.20:8189",
		}},
		Channels:        fakeChannels{},
		Settings:        fakeSettings{value: value},
		MediaMTXWHEPURL: "http://127.0.0.1:1",
		Management:      ManagementBinding{ActiveAddress: "192.0.2.20", Selection: "interface:ipv4:eth0", Port: 8080},
		Interfaces: func() ([]networkbind.InterfaceAddress, error) {
			return []networkbind.InterfaceAddress{{Name: "eth0", Address: "192.0.2.20", Family: networkbind.IPv4}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	body := res.Body.String()
	if res.Code != http.StatusOK || !strings.Contains(body, `"desiredAddress":"interface:ipv4:eth0","resolvedAddress":"192.0.2.20"`) ||
		!strings.Contains(body, `"media":{"activeAddress":"192.0.2.20","activeListeners":{"srt":"192.0.2.20:8890","webRTCUDP":"192.0.2.20:8189","webRTCTCP":"192.0.2.20:8189","rtmp":"127.0.0.1:1935"}`) {
		t.Fatalf("response = %d %s", res.Code, body)
	}
}

func TestInterfaceEnumerationIsCachedUntilExpiry(t *testing.T) {
	calls := 0
	s := &server{interfaces: func() ([]networkbind.InterfaceAddress, error) {
		calls++
		return []networkbind.InterfaceAddress{{Name: "eth0", Address: fmt.Sprintf("192.0.2.%d", calls), Family: networkbind.IPv4}}, nil
	}}
	first, err := s.cachedInterfaces()
	if err != nil {
		t.Fatal(err)
	}
	first[0].Address = "changed-by-caller"
	second, err := s.cachedInterfaces()
	if err != nil || calls != 1 || second[0].Address != "192.0.2.1" {
		t.Fatalf("cached interfaces = %#v, %v, calls %d", second, err, calls)
	}

	s.interfaceCacheMu.Lock()
	s.interfaceCacheExpiresAt = time.Now().Add(-time.Millisecond)
	s.interfaceCacheMu.Unlock()
	third, err := s.cachedInterfaces()
	if err != nil || calls != 2 || third[0].Address != "192.0.2.2" {
		t.Fatalf("refreshed interfaces = %#v, %v, calls %d", third, err, calls)
	}
}

func TestSettingsMutationUsesFreshInterfaceEnumeration(t *testing.T) {
	interfaceName := "eth0"
	interfaceAddress := "192.0.2.10"
	calls := 0
	value := settings.Defaults(time.Now())
	s := &server{
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), channels: fakeChannels{}, settings: fakeSettings{value: value},
		management: ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
		interfaces: func() ([]networkbind.InterfaceAddress, error) {
			calls++
			return []networkbind.InterfaceAddress{{Name: interfaceName, Address: interfaceAddress, Family: networkbind.IPv4}}, nil
		},
	}
	_, err := s.cachedInterfaces()
	if err != nil {
		t.Fatal(err)
	}
	s.interfaceCacheMu.Lock()
	s.interfaceCacheExpiresAt = time.Now().Add(time.Hour)
	s.interfaceCacheMu.Unlock()
	if calls != 1 {
		t.Fatalf("cached interface calls = %d, want 1", calls)
	}

	interfaceName = "eth1"
	interfaceAddress = "192.0.2.20"
	value.ManagementBindAddress = "interface:ipv4:eth1"
	body, err := json.Marshal(settingsRequestFrom(value))
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, "/api/v1/settings", bytes.NewReader(body))
	request.Header.Set("If-Match", `"1"`)
	response := httptest.NewRecorder()
	s.updateSettings(response, request)
	if response.Code != http.StatusOK || calls != 2 {
		t.Fatalf("settings response = %d %s, interface calls %d", response.Code, response.Body.String(), calls)
	}
}

func TestStatusKeepsAppliedMediaAddressUntilReconciliation(t *testing.T) {
	value := settings.Defaults(time.Now())
	value.MediaBindAddress = "interface:ipv4:eth0"
	value.ApplyState = settings.ApplyApplied
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX: fakeMediaMTX{global: mediamtx.GlobalConfig{
			SRTAddress: "192.0.2.20:8890", WebRTCLocalUDPAddress: "192.0.2.20:8189", WebRTCLocalTCPAddress: "192.0.2.20:8189",
		}},
		Channels: fakeChannels{}, Settings: fakeSettings{value: value}, MediaMTXWHEPURL: "http://127.0.0.1:1",
		Management: ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
		Interfaces: func() ([]networkbind.InterfaceAddress, error) {
			return []networkbind.InterfaceAddress{{Name: "eth0", Address: "192.0.2.30", Family: networkbind.IPv4}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	body := res.Body.String()
	if res.Code != http.StatusOK || !strings.Contains(body, `"media":{"activeAddress":"192.0.2.20"`) ||
		!strings.Contains(body, `"desiredAddress":"interface:ipv4:eth0","resolvedAddress":"192.0.2.30"`) {
		t.Fatalf("response = %d %s", res.Code, body)
	}
}

func TestStatusRequiresRestartWhenBindingModeChangesAtSameAddress(t *testing.T) {
	value := settings.Defaults(time.Now())
	value.ManagementBindAddress = "interface:ipv4:eth0"
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MediaMTX: fakeMediaMTX{},
		Channels: fakeChannels{}, Settings: fakeSettings{value: value}, MediaMTXWHEPURL: "http://127.0.0.1:1",
		Management: ManagementBinding{ActiveAddress: "192.0.2.20", Selection: "192.0.2.20", Port: 8080},
		Interfaces: func() ([]networkbind.InterfaceAddress, error) {
			return []networkbind.InterfaceAddress{{Name: "eth0", Address: "192.0.2.20", Family: networkbind.IPv4}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"restartRequired":true`) {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
}

func TestFocusedChannelEndpointIncludesRuntimeAndPlayerPaths(t *testing.T) {
	channels := fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Number: 7, Name: "Demo", Path: "demo", Enabled: true, AutomaticPreview: true,
		Input:      channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000}},
		ApplyState: channel.ApplyApplied,
	}}}
	handler := newTestHandler(t, fakeMediaMTX{status: mediamtx.Status{
		Channels: []mediamtx.Channel{{Name: "demo", Available: true, Online: true}},
	}}, channels, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/channels/channel-1", nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"outputReady":true`) ||
		!strings.Contains(res.Body.String(), `"number":7`) ||
		!strings.Contains(res.Body.String(), `"viewerPath":"/view"`) ||
		!strings.Contains(res.Body.String(), `"embedPath":"/embed/7"`) ||
		!strings.Contains(res.Body.String(), `"automaticPreview":true`) {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
	numeric := httptest.NewRecorder()
	handler.ServeHTTP(numeric, httptest.NewRequest(http.MethodGet, "/api/v1/channels/7", nil))
	if numeric.Code != http.StatusOK || !strings.Contains(numeric.Body.String(), `"id":"channel-1"`) {
		t.Fatalf("numeric response = %d %s", numeric.Code, numeric.Body.String())
	}
}

func TestStatusExposesDistinctInputOutputAndDeliveryCounters(t *testing.T) {
	inputTime := "2026-08-23T20:00:00Z"
	outputTime := "2026-08-23T20:00:01Z"
	channels := fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Name: "Demo", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied,
	}}}
	router := &fakeCompatibility{state: compatibility.State{
		State: compatibility.StateReady, Mode: compatibility.ModeTranscoded,
		OutputPath: "compat-channel-1", Reasons: []string{},
		InputVideo:  &compatibility.VideoMetadata{Width: 1920, Height: 1080, FrameRate: "24000/1001"},
		InputAudio:  &compatibility.AudioMetadata{SampleRate: 44100, ChannelCount: 1},
		OutputAudio: &compatibility.AudioMetadata{SampleRate: 48000, ChannelCount: 2},
	}}
	handler := newTestHandlerWithCompatibility(t, fakeMediaMTX{status: mediamtx.Status{
		Channels: []mediamtx.Channel{
			{Name: "demo", Available: true, Online: true, AvailableTime: &inputTime, InboundBytes: 1000,
				Tracks: []mediamtx.Track{{Codec: "H264"}, {Codec: "MPEG-1/2 Audio"}}},
			{Name: "compat-channel-1", Available: true, Online: true, AvailableTime: &outputTime, InboundBytes: 700, OutboundBytes: 1400,
				Tracks: []mediamtx.Track{{Codec: "H264"}, {Codec: "Opus", CodecProps: map[string]any{"channelCount": float64(2)}}}},
		},
	}}, channels, "http://127.0.0.1:1", router)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	body := res.Body.String()
	if res.Code != http.StatusOK || !strings.Contains(body, `"inboundBytes":1000`) ||
		!strings.Contains(body, `"outputInboundBytes":700`) ||
		!strings.Contains(body, `"outputAvailableTime":"2026-08-23T20:00:01Z"`) ||
		!strings.Contains(body, `"outboundBytes":1400`) ||
		!strings.Contains(body, `"inputVideo":{"width":1920,"height":1080,"frameRate":"24000/1001"}`) ||
		!strings.Contains(body, `{"codec":"MPEG-1/2 Audio","codecProps":{"channelCount":1,"sampleRate":44100}}`) ||
		!strings.Contains(body, `{"codec":"Opus","codecProps":{"channelCount":2,"sampleRate":48000}}`) {
		t.Fatalf("response = %d %s", res.Code, body)
	}
	runtime := httptest.NewRecorder()
	handler.ServeHTTP(runtime, httptest.NewRequest(http.MethodGet, "/api/v1/status/runtime", nil))
	if runtime.Code != http.StatusOK || !strings.Contains(runtime.Body.String(), `"sampleRate":44100`) ||
		!strings.Contains(runtime.Body.String(), `"sampleRate":48000`) {
		t.Fatalf("runtime response = %d %s", runtime.Code, runtime.Body.String())
	}
}

func TestStatusIncludesRelayRuntimeStateForSRTChannels(t *testing.T) {
	firstSeen := time.Date(2026, 8, 26, 10, 46, 42, 0, time.UTC)
	handler, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX: fakeMediaMTX{},
		Channels: fakeChannels{items: []channel.Channel{{
			ID: "channel-1", Name: "SRT", Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000}},
		}}},
		Settings: fakeSettings{value: settings.Defaults(time.Now())},
		Relays: fakeRelays{status: srtrelay.Status{
			State: srtrelay.StateRetrying, Restarts: 3, LastError: "bind failed",
			Issue: &srtrelay.Issue{
				Code: "srt.unsupported_payload", Source: "ingest", Summary: "Input rejected", Message: "unsupported payload", FirstSeenAt: firstSeen,
				LastSeenAt: firstSeen, Occurrences: 1,
			},
		}},
		MediaMTXWHEPURL: "http://127.0.0.1:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"relay":{"state":"retrying","restarts":3,"lastError":"bind failed","listenerActive":false}`) ||
		!strings.Contains(res.Body.String(), `"issues":[{"code":"srt.unsupported_payload","source":"ingest","severity":"error","summary":"Input rejected","message":"unsupported payload"`) {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
	runtime := httptest.NewRecorder()
	handler.ServeHTTP(runtime, httptest.NewRequest(http.MethodGet, "/api/v1/channels/runtime", nil))
	if runtime.Code != http.StatusOK || !strings.Contains(runtime.Body.String(), `"issues":[{"code":"srt.unsupported_payload"`) {
		t.Fatalf("runtime response = %d %s", runtime.Code, runtime.Body.String())
	}
}

func TestListChannelsMergesRuntimeStatus(t *testing.T) {
	available := "2026-08-25T11:00:00Z"
	handler := newTestHandler(t, fakeMediaMTX{status: mediamtx.Status{Channels: []mediamtx.Channel{{
		Name: "demo", Available: true, AvailableTime: &available, Online: true, OnlineTime: &available,
		InboundBytes: 1200, OutboundBytes: 600, Source: &mediamtx.PathSource{Type: "srtConn", ID: "source-1"},
		Readers: []mediamtx.PathReader{{Type: "webRTCSession", ID: "reader-1"}},
		Tracks:  []mediamtx.Track{{Codec: "H264"}},
	}}}}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Revision: 2, Name: "Demo", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied,
	}}}, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil))
	body := res.Body.String()
	for _, expected := range []string{
		`"name":"Demo"`, `"revision":2`, `"available":true`, `"online":true`, `"inboundBytes":1200`,
		`"outboundBytes":600`, `"source":{"type":"srtConn","id":"source-1"}`,
		`"readers":[{"type":"webRTCSession","id":"reader-1"}]`, `"tracks":[{"codec":"H264"}]`, `"outputReady":true`,
	} {
		if res.Code != http.StatusOK || !strings.Contains(body, expected) {
			t.Fatalf("channel list missing %s: %d %s", expected, res.Code, body)
		}
	}
}

func TestRuntimeChannelsAreCompactAndComplete(t *testing.T) {
	available := "2026-08-25T11:00:00Z"
	handler := newTestHandler(t, fakeMediaMTX{status: mediamtx.Status{Channels: []mediamtx.Channel{{
		Name: "demo", Available: true, AvailableTime: &available, Online: true, OnlineTime: &available,
		InboundBytes: 1200, OutboundBytes: 600, InboundFramesInError: 2,
		Source:  &mediamtx.PathSource{Type: "srtConn", ID: "source-1"},
		Readers: []mediamtx.PathReader{{Type: "webRTCSession", ID: "reader-secret"}},
		Tracks:  []mediamtx.Track{{Codec: "H264"}},
	}}}}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Revision: 3, Number: 7, Name: "Configured name", Path: "demo", Enabled: true,
		Input: channel.Input{Mode: channel.InputRTPUnicast, RTP: &channel.RTPInput{
			Address: "0.0.0.0", Port: 22000, SDP: "secret session description",
		}},
		ApplyState: channel.ApplyApplied, ApplyError: "retained apply error",
	}}}, "http://127.0.0.1:1")

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/channels/runtime", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("runtime response = %d %s", res.Code, res.Body.String())
	}
	var body struct {
		Channels []map[string]any `json:"channels"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || len(body.Channels) != 1 {
		t.Fatalf("decode runtime response = %#v, %v", body, err)
	}
	item := body.Channels[0]
	for _, field := range []string{
		"id", "revision", "applyState", "applyError", "available", "availableTime", "online", "onlineTime",
		"inputGeneration", "inboundBytes", "outputInboundBytes", "outputAvailableTime", "outputGeneration",
		"outboundBytes", "inboundFramesInError", "readerCount", "tracks", "outputReady", "outputTracks",
		"inputVideo", "compatibility",
	} {
		if _, ok := item[field]; !ok {
			t.Errorf("runtime channel omitted %q: %s", field, res.Body.String())
		}
	}
	for _, field := range []string{
		"number", "name", "path", "enabled", "automaticPreview", "input", "maxReaders", "useAbsoluteTimestamp",
		"createdAt", "updatedAt", "whepPath", "viewerPath", "embedPath", "source", "readers",
	} {
		if _, ok := item[field]; ok {
			t.Errorf("runtime channel exposed %q: %s", field, res.Body.String())
		}
	}
	if item["readerCount"] != float64(1) || item["inputGeneration"] != available+":source-1" ||
		item["outputGeneration"] != available+":"+compatibility.ModeDirect || strings.Contains(res.Body.String(), "reader-secret") ||
		strings.Contains(res.Body.String(), "secret session description") {
		t.Fatalf("runtime projection = %s", res.Body.String())
	}
}

func TestRuntimeStatusRetainsOperationalScopesAndRevisionGuards(t *testing.T) {
	value := settings.Defaults(time.Now())
	value.Revision = 4
	value.ApplyState = settings.ApplyError
	value.ApplyError = "apply failed"
	resources := telemetry.Snapshot{SampledAt: time.Now(), Media: telemetry.ResourceAvailability{Status: telemetry.StatusUnavailable}}
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MediaMTX: fakeMediaMTX{}, Channels: fakeChannels{},
		Settings: fakeSettings{value: value}, Resources: fakeResources{snapshot: resources},
		MediaMTXWHEPURL: "http://127.0.0.1:1", Management: ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status/runtime", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("runtime status = %d %s", res.Code, res.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"gateway", "media", "settings", "network", "resources", "channels"} {
		if _, ok := body[field]; !ok {
			t.Errorf("runtime status omitted %q", field)
		}
	}
	compactSettings := body["settings"].(map[string]any)
	if len(compactSettings) != 3 || compactSettings["revision"] != float64(4) ||
		compactSettings["applyState"] != string(settings.ApplyError) || compactSettings["applyError"] != "apply failed" {
		t.Fatalf("runtime settings = %#v", compactSettings)
	}
}

func TestFocusedRuntimeChannelUsesIndexedLookup(t *testing.T) {
	media := &indexedFakeMediaMTX{byPath: map[string]mediamtx.Channel{
		"demo": {Name: "demo", Available: true, Online: true},
	}}
	handler := newTestHandler(t, media, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Revision: 2, Number: 7, Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied,
	}}}, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/channels/7/runtime", nil))
	if res.Code != http.StatusOK || media.snapshotCalls.Load() != 1 || media.channelCalls.Load() != 1 ||
		!strings.Contains(res.Body.String(), `"id":"channel-1"`) || strings.Contains(res.Body.String(), `"path":"demo"`) {
		t.Fatalf("response = %d %s, Snapshot calls %d, snapshot Channel calls %d", res.Code, res.Body.String(), media.snapshotCalls.Load(), media.channelCalls.Load())
	}
}

func TestStatusResponsesUseOneMediaSnapshotForPairedPaths(t *testing.T) {
	paths := []string{
		"/api/v1/status",
		"/api/v1/status/runtime",
		"/api/v1/channels",
		"/api/v1/channels/runtime",
		"/api/v1/channels/channel-1",
		"/api/v1/channels/channel-1/runtime",
	}
	for _, requestPath := range paths {
		t.Run(requestPath, func(t *testing.T) {
			media := &generationFakeMediaMTX{}
			router := &fakeCompatibility{state: compatibility.State{
				State: compatibility.StateReady, Mode: compatibility.ModeTranscoded,
				OutputPath: "compat-channel-1", Reasons: []string{},
			}}
			handler := newTestHandlerWithCompatibility(t, media, fakeChannels{items: []channel.Channel{{
				ID: "channel-1", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied,
			}}}, "http://127.0.0.1:1", router)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, requestPath, nil))
			body := response.Body.String()
			if response.Code != http.StatusOK || media.snapshotCalls.Load() != 1 ||
				!strings.Contains(body, `"inboundBytes":101`) || !strings.Contains(body, `"outputInboundBytes":102`) {
				t.Fatalf("response = %d %s, snapshot calls %d", response.Code, body, media.snapshotCalls.Load())
			}
		})
	}
}

func TestListChannelsReportsUnavailableMediaStatus(t *testing.T) {
	handler := newTestHandler(t, fakeMediaMTX{err: errors.New("offline")}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Name: "Demo", Path: "demo",
	}}}, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil))
	if res.Code != http.StatusServiceUnavailable || !strings.Contains(res.Body.String(), "media status is unavailable") {
		t.Fatalf("channel list response = %d %s", res.Code, res.Body.String())
	}
}

func TestRestartEndpointSignalsAndReportsPendingRestart(t *testing.T) {
	restarted := make(chan struct{}, 1)
	value := settings.Defaults(time.Now())
	value.ManagementBindAddress = "127.0.0.1"
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MediaMTX: fakeMediaMTX{},
		Channels: fakeChannels{}, Settings: fakeSettings{value: value},
		MediaMTXWHEPURL: "http://127.0.0.1:1", Management: ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
		Restart: func() { restarted <- struct{}{} },
	})
	if err != nil {
		t.Fatal(err)
	}
	statusRes := httptest.NewRecorder()
	handler.ServeHTTP(statusRes, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if !strings.Contains(statusRes.Body.String(), `"gateway":{"version":"","startedAt":"0001-01-01T00:00:00Z","restartRequired":true}`) {
		t.Fatalf("status response = %s", statusRes.Body.String())
	}

	restartRes := httptest.NewRecorder()
	handler.ServeHTTP(restartRes, httptest.NewRequest(http.MethodPost, "/api/v1/restart", nil))
	if restartRes.Code != http.StatusAccepted {
		t.Fatalf("restart status = %d, body %s", restartRes.Code, restartRes.Body.String())
	}
	select {
	case <-restarted:
	case <-time.After(time.Second):
		t.Fatal("restart callback was not called")
	}
}

func TestHealthReportsDegradedMediaMTX(t *testing.T) {
	handler := newTestHandler(t, fakeMediaMTX{err: errors.New("offline")}, fakeChannels{}, "http://127.0.0.1:1")
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", res.Code)
	}
}

func TestRequestLogSuppressesSuccessfulPollsButRetainsErrors(t *testing.T) {
	var output bytes.Buffer
	s := &server{logger: slog.New(slog.NewTextHandler(&output, nil))}
	handler := s.requestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Has("fail") {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if r.URL.Query().Has("degraded") {
			markResponseDegraded(w)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	for _, requestPath := range []string{
		"/api/v1/status", "/api/v1/status/runtime", "/api/v1/channels", "/api/v1/channels/runtime",
		"/api/v1/channels/channel-1/runtime",
	} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, requestPath, nil))
	}
	if output.Len() != 0 {
		t.Fatalf("successful poll logs = %q", output.String())
	}

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/status?degraded=1", nil))
	if logOutput := output.String(); !strings.Contains(logOutput, "method=GET") || !strings.Contains(logOutput, "path=/api/v1/status") {
		t.Fatalf("degraded poll log = %q", logOutput)
	}
	output.Reset()

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/channels?fail=1", nil))
	if logOutput := output.String(); !strings.Contains(logOutput, "method=GET") || !strings.Contains(logOutput, "path=/api/v1/channels") {
		t.Fatalf("failed poll log = %q", logOutput)
	}
	output.Reset()

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/channels", nil))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/v1/channels/channel-1/whep", nil))
	if logOutput := output.String(); strings.Count(logOutput, "HTTP request") != 2 ||
		!strings.Contains(logOutput, "path=/api/v1/channels ") || !strings.Contains(logOutput, "path=/api/v1/channels/channel-1/whep") {
		t.Fatalf("mutation/WHEP logs = %q", logOutput)
	}
}

func TestWHEPProxyRewritesSessionLocation(t *testing.T) {
	var receivedPath string
	var receivedContentType string
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedContentType = r.Header.Get("Content-Type")
		w.Header().Set("Location", "/demo/whep/session-1")
		w.Header().Set("Content-Type", "application/sdp")
		w.WriteHeader(http.StatusCreated)
		fmt.Fprint(w, "answer-sdp")
	}))
	defer mediaServer.Close()

	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied}}}
	handler := newTestHandler(t, fakeMediaMTX{status: mediamtx.Status{Channels: []mediamtx.Channel{{Name: "demo", Available: true, Online: true}}}}, channels, mediaServer.URL)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/channel-1/whep", strings.NewReader("offer"))
	req.Header.Set("Content-Type", "application/sdp")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", res.Code)
	}
	if receivedPath != "/demo/whep" {
		t.Fatalf("proxied path = %q, want /demo/whep", receivedPath)
	}
	if location := res.Header().Get("Location"); location != "/api/v1/channels/channel-1/whep/session-1" {
		t.Fatalf("Location = %q", location)
	}
	if receivedContentType != "application/sdp" || res.Body.String() != "answer-sdp" {
		t.Fatalf("proxy content = %q, %q", receivedContentType, res.Body.String())
	}
}

func TestWHEPUsesIndexedOperationalLookup(t *testing.T) {
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))
	defer mediaServer.Close()
	media := &indexedFakeMediaMTX{byPath: map[string]mediamtx.Channel{
		"demo": {Name: "demo", Available: true, Online: true},
	}}
	handler := newTestHandler(t, media, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied,
	}}}, mediaServer.URL)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/v1/channels/channel-1/whep", strings.NewReader("offer")))
	if res.Code != http.StatusCreated || media.snapshotCalls.Load() != 1 || media.channelCalls.Load() != 1 {
		t.Fatalf("response = %d %s, Snapshot calls %d, snapshot Channel calls %d", res.Code, res.Body.String(), media.snapshotCalls.Load(), media.channelCalls.Load())
	}
}

func TestWHEPReusableProxyKeepsConcurrentRoutingIsolated(t *testing.T) {
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", r.URL.Path+"/session")
		w.WriteHeader(http.StatusCreated)
	}))
	defer mediaServer.Close()
	channels := fakeChannels{items: []channel.Channel{
		{ID: "channel-a", Path: "alpha", Enabled: true, ApplyState: channel.ApplyApplied},
		{ID: "channel-b", Path: "beta", Enabled: true, ApplyState: channel.ApplyApplied},
	}}
	media := fakeMediaMTX{status: mediamtx.Status{Channels: []mediamtx.Channel{
		{Name: "alpha", Available: true, Online: true},
		{Name: "beta", Available: true, Online: true},
	}}}
	handler := newTestHandler(t, media, channels, mediaServer.URL)

	const requests = 20
	errorsSeen := make(chan string, requests)
	var wait sync.WaitGroup
	for i := range requests {
		wait.Add(1)
		go func() {
			defer wait.Done()
			id := "channel-a"
			if i%2 != 0 {
				id = "channel-b"
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/v1/channels/"+id+"/whep", strings.NewReader("offer")))
			wantLocation := "/api/v1/channels/" + id + "/whep/session"
			if res.Code != http.StatusCreated || res.Header().Get("Location") != wantLocation {
				errorsSeen <- fmt.Sprintf("%s: %d, Location %q", id, res.Code, res.Header().Get("Location"))
			}
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for message := range errorsSeen {
		t.Error(message)
	}
}

func TestWHEPProxyForwardsSessionDelete(t *testing.T) {
	var method string
	var receivedPath string
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		receivedPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer mediaServer.Close()

	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied}}}
	handler := newTestHandler(t, fakeMediaMTX{}, channels, mediaServer.URL)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/channel-1/whep/session-1", nil)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusNoContent || method != http.MethodDelete || receivedPath != "/demo/whep/session-1" {
		t.Fatalf("proxy delete = %d, %q, %q", res.Code, method, receivedPath)
	}
}

func TestWHEPProxyPinsCompatibilitySessionRoute(t *testing.T) {
	var received []string
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = append(received, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodPost {
			w.Header().Set("Location", "/compat-channel1/whep/session-1")
			w.WriteHeader(http.StatusCreated)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer mediaServer.Close()

	router := &fakeCompatibility{state: compatibility.State{
		State: compatibility.StateReady, Mode: compatibility.ModeTranscoded,
		OutputPath: compatibility.CompatibilityPath("channel-1"), Reasons: []string{},
	}}
	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied}}}
	handler := newTestHandlerWithCompatibility(t, fakeMediaMTX{status: mediamtx.Status{Channels: []mediamtx.Channel{
		{Name: "demo", Available: true, Online: true},
		{Name: compatibility.CompatibilityPath("channel-1"), Available: true, Online: true},
	}}}, channels, mediaServer.URL, router)

	post := httptest.NewRequest(http.MethodPost, "/api/v1/channels/channel-1/whep", strings.NewReader("offer"))
	postRes := httptest.NewRecorder()
	handler.ServeHTTP(postRes, post)
	if location := postRes.Header().Get("Location"); location != "/api/v1/channels/channel-1/whep/c/session-1" {
		t.Fatalf("Location = %q", location)
	}

	router.state = compatibility.State{State: compatibility.StateReady, Mode: compatibility.ModeDirect, OutputPath: "demo", Reasons: []string{}}
	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/channel-1/whep/c/session-1", nil)
	deleteRes := httptest.NewRecorder()
	handler.ServeHTTP(deleteRes, deleteRequest)

	want := []string{"POST /compat-channel1/whep", "DELETE /compat-channel1/whep/session-1"}
	if fmt.Sprint(received) != fmt.Sprint(want) {
		t.Fatalf("requests = %#v, want %#v", received, want)
	}
}

func TestWHEPRejectsDeletingChannel(t *testing.T) {
	handler := newTestHandler(t, fakeMediaMTX{}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Enabled: true, ApplyState: channel.ApplyDeleting,
		Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000}},
	}}}, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/v1/channels/channel-1/whep", strings.NewReader("offer")))
	if res.Code != http.StatusConflict || !strings.Contains(res.Body.String(), "deletion is pending") {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
}

func TestWHEPAllowsSessionDeleteWhileChannelDeletionIsPending(t *testing.T) {
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/demo/whep/session-1" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer mediaServer.Close()
	handler := newTestHandler(t, fakeMediaMTX{}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Path: "demo", Enabled: false, ApplyState: channel.ApplyDeleting,
	}}}, mediaServer.URL)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodDelete, "/api/v1/channels/channel-1/whep/d/session-1", nil))
	if res.Code != http.StatusNoContent {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
}

func TestWHEPAllowsIdempotentSessionDeleteWhileDisabled(t *testing.T) {
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/demo/whep/session-1" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		http.NotFound(w, r)
	}))
	defer mediaServer.Close()
	handler := newTestHandler(t, fakeMediaMTX{}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Path: "demo", Enabled: false, ApplyState: channel.ApplyError,
	}}}, mediaServer.URL)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodDelete, "/api/v1/channels/channel-1/whep/d/session-1", nil))
	if res.Code != http.StatusNoContent {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
}

func TestWHEPRejectsNewSessionUntilChannelIsOperational(t *testing.T) {
	proxied := false
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied = true
		w.WriteHeader(http.StatusCreated)
	}))
	defer mediaServer.Close()
	handler := newTestHandler(t, fakeMediaMTX{status: mediamtx.Status{Channels: []mediamtx.Channel{{
		Name: "demo", Available: true, Online: true,
	}}}}, fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Path: "demo", Enabled: true, ApplyState: channel.ApplyPending,
	}}}, mediaServer.URL)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/v1/channels/channel-1/whep", strings.NewReader("offer")))
	if res.Code != http.StatusConflict || proxied {
		t.Fatalf("response = %d %s, proxied %t", res.Code, res.Body.String(), proxied)
	}
}

func TestStatusDoesNotReuseCompatibilityDecisionForNewSource(t *testing.T) {
	oldRuntime := mediamtx.Channel{
		Name: "demo", Available: true, Online: true,
		Source: &mediamtx.PathSource{Type: "srtConn", ID: "old"},
		Tracks: []mediamtx.Track{{Codec: "H264"}},
	}
	newRuntime := mediamtx.Channel{
		Name: "demo", Available: true, Online: true, InboundBytes: 1000, OutboundBytes: 900,
		Source:  &mediamtx.PathSource{Type: "srtConn", ID: "new"},
		Readers: []mediamtx.PathReader{{Type: "webRTCSession", ID: "reader-1"}},
		Tracks:  []mediamtx.Track{{Codec: "H265"}},
	}
	router := &fakeCompatibility{state: compatibility.State{
		State: compatibility.StateReady, Mode: compatibility.ModeDirect, OutputPath: "demo",
		InputFingerprint: compatibility.Fingerprint(oldRuntime), Reasons: []string{},
	}}
	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true}}}
	handler := newTestHandlerWithCompatibility(t, fakeMediaMTX{status: mediamtx.Status{
		Channels: []mediamtx.Channel{newRuntime},
	}}, channels, "http://127.0.0.1:1", router)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	body := res.Body.String()
	if res.Code != http.StatusOK || !strings.Contains(body, `"state":"probing"`) ||
		!strings.Contains(body, `"outputReady":false`) ||
		!strings.Contains(body, `"outputInboundBytes":0`) ||
		!strings.Contains(body, `"outboundBytes":0`) ||
		!strings.Contains(body, `"readers":[]`) ||
		!strings.Contains(body, `"outputTracks":[]`) {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
	}
}

func TestChannelCRUDMasksAndPreservesPassphrase(t *testing.T) {
	store, err := channel.OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	service := channel.NewService(store, fakePathManager{}, nil, nil, nil)
	handler := newTestHandler(t, fakeMediaMTX{}, service, "http://127.0.0.1:1")

	createBody := `{"name":"Secure input","enabled":true,"input":{"mode":"srt-push","srt":{"port":10000,"passphrase":"0123456789","sdp":"v=0\\nm=video 0 RTP/AVP 96\\na=rtpmap:96 H264/90000"}},"maxReaders":4}`
	createReq := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader(createBody))
	createReq.Header.Set("Content-Type", "application/json")
	createRes := httptest.NewRecorder()
	handler.ServeHTTP(createRes, createReq)
	if createRes.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createRes.Code, createRes.Body.String())
	}
	if strings.Contains(createRes.Body.String(), "0123456789") || !strings.Contains(createRes.Body.String(), `"hasPassphrase":true`) {
		t.Fatalf("create response leaked or omitted secret state: %s", createRes.Body.String())
	}
	if !strings.Contains(createRes.Body.String(), `"automaticPreview":true`) || !strings.Contains(createRes.Body.String(), `"useAbsoluteTimestamp":true`) || !strings.Contains(createRes.Body.String(), `"embedPath":"/embed/1"`) {
		t.Fatalf("create response omitted operator defaults: %s", createRes.Body.String())
	}
	if !strings.Contains(createRes.Body.String(), `"sdp":"v=0\\nm=video 0 RTP/AVP 96`) {
		t.Fatalf("create response omitted elementary RTP SDP: %s", createRes.Body.String())
	}

	items, err := service.List(context.Background())
	if err != nil || len(items) != 1 {
		t.Fatalf("List() = %#v, %v", items, err)
	}
	id := items[0].ID
	updateBody := `{"name":"Renamed","enabled":true,"input":{"mode":"srt-push","srt":{"port":10000,"sdp":"v=0\\nm=video 0 RTP/AVP 96\\na=rtpmap:96 H264/90000"}},"maxReaders":5}`
	updateReq := httptest.NewRequest(http.MethodPut, "/api/v1/channels/"+id, strings.NewReader(updateBody))
	updateReq.Header.Set("Content-Type", "application/json")
	updateReq.Header.Set("If-Match", `"1"`)
	updateRes := httptest.NewRecorder()
	handler.ServeHTTP(updateRes, updateReq)
	if updateRes.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", updateRes.Code, updateRes.Body.String())
	}
	if etag := updateRes.Header().Get("ETag"); etag != `"2"` {
		t.Fatalf("update ETag = %q", etag)
	}
	updated, err := service.Get(context.Background(), id)
	if err != nil || updated.Input.SRT.Passphrase != "0123456789" {
		t.Fatalf("stored passphrase was not preserved: %#v, %v", updated.Input.SRT, err)
	}
	if !updated.AutomaticPreview {
		t.Fatal("automatic preview was not preserved by an older update request")
	}
	if !updated.UseAbsoluteTimestamp {
		t.Fatal("timestamp preservation was not preserved by an older update request")
	}
	passphraseReq := httptest.NewRequest(http.MethodGet, "/api/v1/channels/"+id+"/srt-passphrase", nil)
	passphraseRes := httptest.NewRecorder()
	handler.ServeHTTP(passphraseRes, passphraseReq)
	if passphraseRes.Code != http.StatusOK || !strings.Contains(passphraseRes.Body.String(), `"passphrase":"0123456789"`) ||
		!strings.Contains(passphraseRes.Body.String(), `"revision":2`) || passphraseRes.Header().Get("ETag") != `"2"` {
		t.Fatalf("passphrase response = %d %s", passphraseRes.Code, passphraseRes.Body.String())
	}
	if got := passphraseRes.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	staleReq := httptest.NewRequest(http.MethodPut, "/api/v1/channels/"+id, strings.NewReader(updateBody))
	staleReq.Header.Set("If-Match", `"1"`)
	staleRes := httptest.NewRecorder()
	handler.ServeHTTP(staleRes, staleReq)
	if staleRes.Code != http.StatusPreconditionFailed || !strings.Contains(staleRes.Body.String(), `"code":"revision_conflict"`) {
		t.Fatalf("stale update response = %d %s", staleRes.Code, staleRes.Body.String())
	}

	deleteReq := httptest.NewRequest(http.MethodDelete, "/api/v1/channels/"+id, nil)
	deleteRes := httptest.NewRecorder()
	handler.ServeHTTP(deleteRes, deleteReq)
	if deleteRes.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", deleteRes.Code, deleteRes.Body.String())
	}
}

func TestChannelRequestAllowsTimestampPreservationOptOut(t *testing.T) {
	disabled := false
	draft := (channelRequest{UseAbsoluteTimestamp: &disabled}).toDraft(nil)
	if draft.UseAbsoluteTimestamp {
		t.Fatal("explicit timestamp preservation opt-out was ignored")
	}
}

func TestChannelRequestRejectsSetAndClearPassphrase(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels", strings.NewReader(
		`{"name":"bad","input":{"mode":"srt-push","srt":{"port":10000,"passphrase":"0123456789","clearPassphrase":true}}}`,
	))
	if _, err := decodeChannelRequest(req); err == nil || !strings.Contains(err.Error(), "cannot both be set") {
		t.Fatalf("decodeChannelRequest() error = %v", err)
	}
}

func TestStatusDoesNotRequireRestartWhenManagementBindingLocked(t *testing.T) {
	handler, err := New(Options{
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX:        fakeMediaMTX{},
		Channels:        fakeChannels{},
		Settings:        fakeSettings{value: settings.Defaults(time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC))},
		MediaMTXWHEPURL: "http://127.0.0.1:1",
		Version:         "test",
		StartedAt:       time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC),
		Management:      ManagementBinding{ActiveAddress: "192.0.2.10", Selection: "192.0.2.10", Port: 8080, Locked: true},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", res.Code, res.Body.String())
	}
	if !strings.Contains(res.Body.String(), `"locked":true`) || strings.Contains(res.Body.String(), `"restartRequired":true`) {
		t.Fatalf("locked management binding must not require restart: %s", res.Body.String())
	}
}

func TestSettingsRejectRangeExcludingAChannel(t *testing.T) {
	channels := fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Name: "RTP camera",
		Input: channel.Input{Mode: channel.InputRTPUnicast, RTP: &channel.RTPInput{Port: 22000}},
	}}}
	handler := newTestHandler(t, fakeMediaMTX{}, channels, "http://127.0.0.1:1")
	body := `{"managementPort":8080,"logLevel":"info","readTimeout":"10s","writeTimeout":"10s","writeQueueSize":1024,"udpMaxPayloadSize":1452,"udpReadBufferSize":4194304,"srtAddress":":8890","webRTCLocalUDPAddress":":8189","webRTCLocalTCPAddress":"","webRTCIPsFromInterfaces":true,"webRTCAdditionalHosts":[],"webRTCHandshakeTimeout":"10s","webRTCTrackGatherTimeout":"2s","rtpPortMin":23000,"rtpPortMax":23999,"statisticsIntervalMs":2000,"defaultMaxReaders":0}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"1"`)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "port 22000") {
		t.Fatalf("response = %d %s, want range validation error", res.Code, res.Body.String())
	}
}

func TestSettingsRejectGlobalListenerUsingChannelSRTSlot(t *testing.T) {
	channels := fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Name: "SRT camera",
		Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000}},
	}}}
	handler := newTestHandler(t, fakeMediaMTX{}, channels, "http://127.0.0.1:1")
	body := `{"managementPort":8080,"logLevel":"info","readTimeout":"10s","writeTimeout":"10s","writeQueueSize":1024,"udpMaxPayloadSize":1452,"udpReadBufferSize":4194304,"srtAddress":":10000","webRTCLocalUDPAddress":":8189","webRTCLocalTCPAddress":"","webRTCIPsFromInterfaces":true,"webRTCAdditionalHosts":[],"webRTCHandshakeTimeout":"10s","webRTCTrackGatherTimeout":"2s","rtpPortMin":22000,"rtpPortMax":22999,"statisticsIntervalMs":2000,"defaultMaxReaders":0}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("If-Match", `"1"`)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "port 10000") {
		t.Fatalf("response = %d %s, want SRT listener conflict", res.Code, res.Body.String())
	}
}

func TestFocusedGETsAndFullPUTPreconditions(t *testing.T) {
	value := settings.Defaults(time.Now())
	channels := fakeChannels{items: []channel.Channel{{
		ID: "channel-1", Revision: 7, Path: "demo", Enabled: true, ApplyState: channel.ApplyApplied,
	}}}
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MediaMTX: fakeMediaMTX{}, Channels: channels,
		Settings: fakeSettings{value: value}, MediaMTXWHEPURL: "http://127.0.0.1:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	settingsGET := httptest.NewRecorder()
	handler.ServeHTTP(settingsGET, httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil))
	if settingsGET.Code != http.StatusOK || settingsGET.Header().Get("ETag") != `"1"` ||
		!strings.Contains(settingsGET.Body.String(), `"revision":1`) {
		t.Fatalf("settings GET = %d, ETag %q, %s", settingsGET.Code, settingsGET.Header().Get("ETag"), settingsGET.Body.String())
	}
	channelGET := httptest.NewRecorder()
	handler.ServeHTTP(channelGET, httptest.NewRequest(http.MethodGet, "/api/v1/channels/channel-1", nil))
	if channelGET.Code != http.StatusOK || channelGET.Header().Get("ETag") != `"7"` ||
		!strings.Contains(channelGET.Body.String(), `"revision":7`) {
		t.Fatalf("channel GET = %d, ETag %q, %s", channelGET.Code, channelGET.Header().Get("ETag"), channelGET.Body.String())
	}

	body, err := json.Marshal(settingsRequestFrom(value))
	if err != nil {
		t.Fatal(err)
	}
	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(string(body))))
	if missing.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing If-Match response = %d %s", missing.Code, missing.Body.String())
	}
	staleReq := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(string(body)))
	staleReq.Header.Set("If-Match", `"9"`)
	stale := httptest.NewRecorder()
	handler.ServeHTTP(stale, staleReq)
	if stale.Code != http.StatusPreconditionFailed || !strings.Contains(stale.Body.String(), `"code":"revision_conflict"`) {
		t.Fatalf("stale settings response = %d %s", stale.Code, stale.Body.String())
	}
	successReq := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(string(body)))
	successReq.Header.Set("If-Match", `"1"`)
	success := httptest.NewRecorder()
	handler.ServeHTTP(success, successReq)
	if success.Code != http.StatusOK || success.Header().Get("ETag") != `"2"` ||
		!strings.Contains(success.Body.String(), `"revision":2`) {
		t.Fatalf("settings update = %d, ETag %q, %s", success.Code, success.Header().Get("ETag"), success.Body.String())
	}
}

func TestChannelAutomaticPreviewPatchPreservesConfigurationAndApplyState(t *testing.T) {
	store, err := channel.OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	media := &countingPathManager{}
	service := channel.NewService(store, media, nil, nil, nil)
	item, err := service.Create(context.Background(), channel.Draft{
		Name: "Patch target", Enabled: true, AutomaticPreview: true, MaxReaders: 8,
		Input: channel.Input{Mode: channel.InputSRTPull, SRT: &channel.SRTInput{
			Host: "source.local", Port: 9000, StreamID: "camera", Passphrase: "0123456789", LatencyMS: 200,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := newTestHandler(t, fakeMediaMTX{}, service, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodPatch, "/api/v1/channels/"+item.ID, strings.NewReader(`{"automaticPreview":false}`)))
	if res.Code != http.StatusOK || res.Header().Get("ETag") != `"2"` {
		t.Fatalf("PATCH response = %d, ETag %q, %s", res.Code, res.Header().Get("ETag"), res.Body.String())
	}
	loaded, err := service.Get(context.Background(), item.ID)
	if err != nil || loaded.AutomaticPreview || loaded.Revision != 2 || loaded.ApplyState != channel.ApplyApplied ||
		loaded.Input.SRT.Passphrase != "0123456789" || loaded.Input.SRT.StreamID != "camera" ||
		loaded.MaxReaders != 8 || loaded.UseAbsoluteTimestamp || media.replacements != 1 || media.deletions != 0 {
		t.Fatalf("patched channel = %#v, replacements %d, deletions %d, error %v", loaded, media.replacements, media.deletions, err)
	}
	put := httptest.NewRequest(http.MethodPut, "/api/v1/channels/"+item.ID, strings.NewReader(
		`{"name":"Patch target","enabled":true,"input":{"mode":"srt-pull","srt":{"host":"source.local","port":9000,"streamId":"camera","latencyMs":200}},"maxReaders":8}`,
	))
	put.Header.Set("If-Match", `"2"`)
	putRes := httptest.NewRecorder()
	handler.ServeHTTP(putRes, put)
	loaded, err = service.Get(context.Background(), item.ID)
	if putRes.Code != http.StatusOK || putRes.Header().Get("ETag") != `"3"` || err != nil ||
		loaded.AutomaticPreview || loaded.UseAbsoluteTimestamp || loaded.Input.SRT.Passphrase != "0123456789" ||
		media.replacements != 1 {
		t.Fatalf("compatibility PUT = %d, ETag %q, channel %#v, replacements %d, error %v",
			putRes.Code, putRes.Header().Get("ETag"), loaded, media.replacements, err)
	}
	invalid := httptest.NewRecorder()
	handler.ServeHTTP(invalid, httptest.NewRequest(http.MethodPatch, "/api/v1/channels/"+item.ID,
		strings.NewReader(`{"automaticPreview":true,"enabled":true}`)))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("strict PATCH response = %d %s", invalid.Code, invalid.Body.String())
	}
}

func TestOutputReadyRequiresEnabledAppliedChannel(t *testing.T) {
	runtime := mediamtx.Channel{Available: true, Online: true}
	compatibilityState := compatibility.State{State: compatibility.StateReady, Reasons: []string{}}
	operational := channel.Channel{Enabled: true, ApplyState: channel.ApplyApplied}
	if !channelRuntimeView(operational, runtime, runtime, compatibilityState).OutputReady {
		t.Fatal("operational channel was not ready")
	}
	for _, item := range []channel.Channel{
		{Enabled: false, ApplyState: channel.ApplyApplied},
		{Enabled: true, ApplyState: channel.ApplyPending},
		{Enabled: true, ApplyState: channel.ApplyError},
		{Enabled: true, ApplyState: channel.ApplyDeleting},
	} {
		if channelRuntimeView(item, runtime, runtime, compatibilityState).OutputReady {
			t.Fatalf("non-operational channel was ready: %#v", item)
		}
	}
}

func TestDiagnosticsIsAllowlistedAndRedactsSensitiveState(t *testing.T) {
	available := "2026-08-25T10:00:00Z"
	outputAvailable := "2026-08-25T10:00:01Z"
	value := settings.Defaults(time.Now())
	value.Revision = 3
	compatibilityReader := &fakeCompatibility{state: compatibility.State{
		State: compatibility.StateStarting, Mode: compatibility.ModeTranscoded, Required: true,
		Reasons: []string{"video conversion required"}, LastError: "compatibility process exited",
		Worker:     compatibility.WorkerState{Running: true, Restarts: 2, Error: "ffmpeg exited with status 1"},
		OutputPath: "hidden-secret-output", InputFingerprint: "",
	}}
	handler, err := New(Options{
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX: fakeMediaMTX{
			global: mediamtx.GlobalConfig{SRTAddress: ":8890", RTMPAddress: "127.0.0.1:1935", WebRTCLocalUDPAddress: ":8189", WebRTCLocalTCPAddress: ":8190"},
			status: mediamtx.Status{Info: mediamtx.Info{Version: "1.20.1", Started: available}, Channels: []mediamtx.Channel{
				{
					Name: "demo", ConfiguredSource: "srt://source?passphrase=raw-secret", Available: true, Online: true,
					AvailableTime: &available, OnlineTime: &available, Source: &mediamtx.PathSource{Type: "srtConn", ID: "source-1"},
					Readers: []mediamtx.PathReader{{Type: "webRTCSession", ID: "reader-1"}},
				},
				{Name: "hidden-secret-output", Available: true, Online: true, AvailableTime: &outputAvailable},
			}},
		},
		Channels: fakeChannels{items: []channel.Channel{{
			ID: "channel-1", Revision: 4, Number: 1, Name: "Diagnostic", Path: "demo", Enabled: true,
			ApplyState: channel.ApplyError, ApplyError: "apply-secret-error", CreatedAt: time.Now(), UpdatedAt: time.Now(),
			Input: channel.Input{Mode: channel.InputSRTPull, SRT: &channel.SRTInput{Host: "source", Passphrase: "stored-secret"}},
		}}},
		Settings: fakeSettings{value: value}, Compatibility: compatibilityReader,
		MediaMTXWHEPURL: "http://127.0.0.1:1", Version: "test-version", StartedAt: time.Now(),
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/diagnostics", nil))
	body := res.Body.String()
	if res.Code != http.StatusOK {
		t.Fatalf("diagnostics response = %d %s", res.Code, body)
	}
	for _, expected := range []string{
		`"version":"test-version"`, `"version":"1.20.1"`, `"activeListeners":{"srt":":8890","webRTCUDP":":8189","webRTCTCP":":8190","rtmp":"127.0.0.1:1935"}`,
		`"revision":4`, `"path":"demo"`, `"availableTime":"2026-08-25T10:00:00Z"`, `"source":{"type":"srtConn","id":"source-1"}`,
		`"outputAvailableTime":"2026-08-25T10:00:01Z"`,
		`"readers":[{"type":"webRTCSession","id":"reader-1"}]`, `"lastError":"compatibility process exited"`,
		`"worker":{"running":true,"restarts":2,"error":"ffmpeg exited with status 1"}`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("diagnostics missing %s: %s", expected, body)
		}
	}
	for _, sensitive := range []string{"raw-secret", "stored-secret", "apply-secret-error", "hidden-secret-output", "passphrase="} {
		if strings.Contains(body, sensitive) {
			t.Fatalf("diagnostics leaked %q: %s", sensitive, body)
		}
	}
}

func TestHealthUsesLightweightReachabilityRead(t *testing.T) {
	infoReads := 0
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/info" {
			t.Fatalf("health requested %s", r.URL.Path)
		}
		infoReads++
		fmt.Fprint(w, `{"version":"test"}`)
	}))
	defer mediaServer.Close()
	client, err := mediamtx.NewClient(mediaServer.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	handler := newTestHandler(t, client, fakeChannels{}, "http://127.0.0.1:1")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if res.Code != http.StatusOK || infoReads != 1 {
		t.Fatalf("health response = %d %s, info reads %d", res.Code, res.Body.String(), infoReads)
	}
}

func TestSPAHandlerNegotiatesCompressionAndCaching(t *testing.T) {
	files := fstest.MapFS{
		"index.html":                {Data: []byte("index identity")},
		"index.html.br":             {Data: []byte("index br")},
		"index.html.gz":             {Data: []byte("index gzip")},
		"assets/app-AbCd1234.js":    {Data: []byte("asset identity")},
		"assets/app-AbCd1234.js.br": {Data: []byte("asset br")},
		"assets/app-AbCd1234.js.gz": {Data: []byte("asset gzip")},
		"placeholder.txt":           {Data: []byte("placeholder identity")},
	}
	handler := (&server{staticFiles: files}).spaHandler()

	tests := []struct {
		name            string
		method          string
		path            string
		acceptEncoding  string
		wantStatus      int
		wantEncoding    string
		wantBody        string
		wantCache       string
		wantContentType string
		wantLength      string
	}{
		{
			name: "brotli wins equal quality", method: http.MethodGet, path: "/assets/app-AbCd1234.js",
			acceptEncoding: "gzip, br", wantStatus: http.StatusOK, wantEncoding: "br", wantBody: "asset br",
			wantCache: "public,max-age=31536000,immutable", wantContentType: "text/javascript",
		},
		{
			name: "higher gzip quality wins", method: http.MethodGet, path: "/assets/app-AbCd1234.js",
			acceptEncoding: "br;q=0.4, gzip;q=0.8, identity;q=0.2", wantStatus: http.StatusOK,
			wantEncoding: "gzip", wantBody: "asset gzip", wantCache: "public,max-age=31536000,immutable",
			wantContentType: "text/javascript",
		},
		{
			name: "zero quality coding uses identity", method: http.MethodGet, path: "/assets/app-AbCd1234.js",
			acceptEncoding: "br;q=0, gzip;q=0", wantStatus: http.StatusOK, wantBody: "asset identity",
			wantCache: "public,max-age=31536000,immutable", wantContentType: "text/javascript",
		},
		{
			name: "spa fallback is compressed but revalidated", method: http.MethodGet, path: "/channels/1",
			acceptEncoding: "br", wantStatus: http.StatusOK, wantEncoding: "br", wantBody: "index br",
			wantCache: "no-cache", wantContentType: "text/html",
		},
		{
			name: "root is not cached", method: http.MethodGet, path: "/",
			wantStatus: http.StatusOK, wantBody: "index identity", wantCache: "no-cache", wantContentType: "text/html",
		},
		{
			name: "index keeps canonical redirect", method: http.MethodGet, path: "/index.html",
			acceptEncoding: "br", wantStatus: http.StatusMovedPermanently,
		},
		{
			name: "missing sidecars use identity", method: http.MethodGet, path: "/placeholder.txt",
			acceptEncoding: "gzip, br", wantStatus: http.StatusOK, wantBody: "placeholder identity",
			wantContentType: "text/plain",
		},
		{
			name: "head has representation headers and no body", method: http.MethodHead, path: "/assets/app-AbCd1234.js",
			acceptEncoding: "gzip", wantStatus: http.StatusOK, wantEncoding: "gzip",
			wantCache: "public,max-age=31536000,immutable", wantContentType: "text/javascript", wantLength: "10",
		},
		{
			name: "all representations refused", method: http.MethodGet, path: "/assets/app-AbCd1234.js",
			acceptEncoding: "br;q=0, gzip;q=0, identity;q=0", wantStatus: http.StatusNotAcceptable,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(test.method, test.path, nil)
			req.Header.Set("Accept-Encoding", test.acceptEncoding)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)

			if res.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body = %q", res.Code, test.wantStatus, res.Body.String())
			}
			if got := res.Header().Get("Vary"); got != "Accept-Encoding" {
				if test.wantStatus != http.StatusMovedPermanently {
					t.Errorf("Vary = %q, want Accept-Encoding", got)
				}
			}
			if got := res.Header().Get("Content-Encoding"); got != test.wantEncoding {
				t.Errorf("Content-Encoding = %q, want %q", got, test.wantEncoding)
			}
			if got := res.Body.String(); got != test.wantBody && test.wantStatus == http.StatusOK {
				t.Errorf("body = %q, want %q", got, test.wantBody)
			}
			if got := res.Header().Get("Cache-Control"); got != test.wantCache && test.wantStatus == http.StatusOK {
				t.Errorf("Cache-Control = %q, want %q", got, test.wantCache)
			}
			if got := res.Header().Get("Content-Type"); test.wantContentType != "" && !strings.HasPrefix(got, test.wantContentType) {
				t.Errorf("Content-Type = %q, want prefix %q", got, test.wantContentType)
			}
			if got := res.Header().Get("Content-Length"); test.wantLength != "" && got != test.wantLength {
				t.Errorf("Content-Length = %q, want %q", got, test.wantLength)
			}
			if test.wantStatus == http.StatusMovedPermanently && res.Header().Get("Location") != "./" {
				t.Errorf("Location = %q, want ./", res.Header().Get("Location"))
			}
		})
	}
}

func settingsRequestFrom(value settings.Settings) settingsRequest {
	return settingsRequest{
		ManagementBindAddress: value.ManagementBindAddress, ManagementPort: value.ManagementPort, MediaBindAddress: value.MediaBindAddress,
		LogLevel: value.LogLevel, ReadTimeout: value.ReadTimeout, WriteTimeout: value.WriteTimeout,
		WriteQueueSize: value.WriteQueueSize, UDPMaxPayloadSize: value.UDPMaxPayloadSize,
		UDPReadBufferSize: value.UDPReadBufferSize, SRTAddress: value.SRTAddress,
		WebRTCLocalUDPAddress: value.WebRTCLocalUDPAddress, WebRTCLocalTCPAddress: value.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces: value.WebRTCIPsFromInterfaces, WebRTCAdditionalHosts: value.WebRTCAdditionalHosts,
		WebRTCHandshakeTimeout: value.WebRTCHandshakeTimeout, WebRTCTrackGatherTimeout: value.WebRTCTrackGatherTimeout,
		RTPPortMin: value.RTPPortMin, RTPPortMax: value.RTPPortMax, StatisticsIntervalMS: value.StatisticsIntervalMS,
		DefaultMaxReaders: value.DefaultMaxReaders,
	}
}

func newTestHandler(t *testing.T, media mediaStatusReader, channels channelService, whepURL string) http.Handler {
	return newTestHandlerWithCompatibility(t, media, channels, whepURL, nil)
}

func newTestHandlerWithCompatibility(t *testing.T, media mediaStatusReader, channels channelService, whepURL string, compatibility compatibilityReader) http.Handler {
	t.Helper()
	handler, err := New(Options{
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX:        media,
		Channels:        channels,
		Settings:        fakeSettings{value: settings.Defaults(time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC))},
		Compatibility:   compatibility,
		MediaMTXWHEPURL: whepURL,
		Version:         "test",
		StartedAt:       time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC),
		Management:      ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return handler
}

func newProjectTestHandler(t *testing.T, projects projectService) http.Handler {
	t.Helper()
	handler, err := New(Options{
		Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX:        fakeMediaMTX{},
		Channels:        fakeChannels{},
		Settings:        fakeSettings{value: settings.Defaults(time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC))},
		Projects:        projects,
		MediaMTXWHEPURL: "http://127.0.0.1:1",
		Version:         "test",
		StartedAt:       time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC),
		Management:      ManagementBinding{ActiveAddress: "*", Selection: "*", Port: 8080},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return handler
}
