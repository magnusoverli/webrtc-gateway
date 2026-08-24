package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/compatibility"
	"webrtc-gateway/internal/mediamtx"
	"webrtc-gateway/internal/networkbind"
	"webrtc-gateway/internal/settings"
	"webrtc-gateway/internal/srtrelay"
	"webrtc-gateway/internal/telemetry"
)

type fakeMediaMTX struct {
	status mediamtx.Status
	global mediamtx.GlobalConfig
	err    error
}

func (f fakeMediaMTX) Status(context.Context) (mediamtx.Status, error) {
	return f.status, f.err
}

func (f fakeMediaMTX) GetGlobal(context.Context) (mediamtx.GlobalConfig, error) {
	return f.global, f.err
}

type fakeChannels struct {
	items     []channel.Channel
	err       error
	deleteErr error
}

type fakePathManager struct{}

func (fakePathManager) ReplacePath(context.Context, string, mediamtx.PathConfig) error { return nil }
func (fakePathManager) DeletePath(context.Context, string) error                       { return nil }

type fakeSettings struct {
	value settings.Settings
	err   error
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
			SRTAddress: "192.0.2.20:8890", WebRTCLocalUDPAddress: "192.0.2.20:8189", WebRTCLocalTCPAddress: "192.0.2.20:8189",
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
		!strings.Contains(body, `"media":{"activeAddress":"192.0.2.20","desiredAddress":"interface:ipv4:eth0","resolvedAddress":"192.0.2.20"`) {
		t.Fatalf("response = %d %s", res.Code, body)
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
	if res.Code != http.StatusOK || !strings.Contains(body,
		`"media":{"activeAddress":"192.0.2.20","desiredAddress":"interface:ipv4:eth0","resolvedAddress":"192.0.2.30"`) {
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
		ID: "channel-1", Name: "Demo", Path: "demo", Enabled: true,
	}}}
	router := &fakeCompatibility{state: compatibility.State{
		State: compatibility.StateReady, Mode: compatibility.ModeTranscoded,
		OutputPath: "compat-channel-1", Reasons: []string{},
	}}
	handler := newTestHandlerWithCompatibility(t, fakeMediaMTX{status: mediamtx.Status{
		Channels: []mediamtx.Channel{
			{Name: "demo", Available: true, Online: true, AvailableTime: &inputTime, InboundBytes: 1000},
			{Name: "compat-channel-1", Available: true, Online: true, AvailableTime: &outputTime, InboundBytes: 700, OutboundBytes: 1400},
		},
	}}, channels, "http://127.0.0.1:1", router)

	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	body := res.Body.String()
	if res.Code != http.StatusOK || !strings.Contains(body, `"inboundBytes":1000`) ||
		!strings.Contains(body, `"outputInboundBytes":700`) ||
		!strings.Contains(body, `"outputAvailableTime":"2026-08-23T20:00:01Z"`) ||
		!strings.Contains(body, `"outboundBytes":1400`) {
		t.Fatalf("response = %d %s", res.Code, body)
	}
}

func TestStatusIncludesRelayRuntimeStateForSRTChannels(t *testing.T) {
	handler, err := New(Options{
		Logger:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		MediaMTX: fakeMediaMTX{},
		Channels: fakeChannels{items: []channel.Channel{{
			ID: "channel-1", Name: "SRT", Input: channel.Input{Mode: channel.InputSRTPush, SRT: &channel.SRTInput{Port: 10000}},
		}}},
		Settings:        fakeSettings{value: settings.Defaults(time.Now())},
		Relays:          fakeRelays{status: srtrelay.Status{State: srtrelay.StateRetrying, Restarts: 3, LastError: "bind failed"}},
		MediaMTXWHEPURL: "http://127.0.0.1:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/status", nil))
	if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"relay":{"state":"retrying","restarts":3,"lastError":"bind failed"}`) {
		t.Fatalf("response = %d %s", res.Code, res.Body.String())
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

	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true}}}
	handler := newTestHandler(t, fakeMediaMTX{}, channels, mediaServer.URL)
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

func TestWHEPProxyForwardsSessionDelete(t *testing.T) {
	var method string
	var receivedPath string
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		receivedPath = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	defer mediaServer.Close()

	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true}}}
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
	channels := fakeChannels{items: []channel.Channel{{ID: "channel-1", Path: "demo", Enabled: true}}}
	handler := newTestHandlerWithCompatibility(t, fakeMediaMTX{}, channels, mediaServer.URL, router)

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
	updateRes := httptest.NewRecorder()
	handler.ServeHTTP(updateRes, updateReq)
	if updateRes.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", updateRes.Code, updateRes.Body.String())
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
	if passphraseRes.Code != http.StatusOK || !strings.Contains(passphraseRes.Body.String(), `"passphrase":"0123456789"`) {
		t.Fatalf("passphrase response = %d %s", passphraseRes.Code, passphraseRes.Body.String())
	}
	if got := passphraseRes.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", got)
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
	body := `{"logLevel":"info","readTimeout":"10s","writeTimeout":"10s","writeQueueSize":1024,"udpMaxPayloadSize":1452,"udpReadBufferSize":4194304,"srtAddress":":8890","webRTCLocalUDPAddress":":8189","webRTCLocalTCPAddress":"","webRTCIPsFromInterfaces":true,"webRTCAdditionalHosts":[],"webRTCHandshakeTimeout":"10s","webRTCTrackGatherTimeout":"2s","rtpPortMin":23000,"rtpPortMax":23999,"statisticsIntervalMs":2000,"defaultMaxReaders":0}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
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
	body := `{"logLevel":"info","readTimeout":"10s","writeTimeout":"10s","writeQueueSize":1024,"udpMaxPayloadSize":1452,"udpReadBufferSize":4194304,"srtAddress":":10000","webRTCLocalUDPAddress":":8189","webRTCLocalTCPAddress":"","webRTCIPsFromInterfaces":true,"webRTCAdditionalHosts":[],"webRTCHandshakeTimeout":"10s","webRTCTrackGatherTimeout":"2s","rtpPortMin":22000,"rtpPortMax":22999,"statisticsIntervalMs":2000,"defaultMaxReaders":0}`
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)

	if res.Code != http.StatusBadRequest || !strings.Contains(res.Body.String(), "port 10000") {
		t.Fatalf("response = %d %s, want SRT listener conflict", res.Code, res.Body.String())
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
