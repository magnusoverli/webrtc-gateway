package mediamtx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var responseDecodeCount atomic.Int32

type decodeCountingResponse string

func (r *decodeCountingResponse) UnmarshalJSON(data []byte) error {
	responseDecodeCount.Add(1)
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*r = decodeCountingResponse(value)
	return nil
}

func TestStatusMergesConfiguredAndRuntimePaths(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"started":"2026-08-22T10:00:00Z","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"standby","source":"publisher"},{"name":"live","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"live","confName":"live","available":true,"online":true,"inboundBytes":1200,"outboundBytes":600,"inboundFramesInError":2,"source":{"type":"srtConn","id":"source-1"},"readers":[{"type":"webRTCSession","id":"reader-1"}],"tracks2":[{"codec":"H264","codecProps":{"width":1920,"height":1080}}]}]}`)
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}

	if status.Info.Version != "1.20.1" {
		t.Fatalf("version = %q", status.Info.Version)
	}
	if len(status.Channels) != 2 {
		t.Fatalf("channel count = %d, want 2", len(status.Channels))
	}
	if status.Channels[0].Name != "live" || !status.Channels[0].Online {
		t.Fatalf("first channel = %#v, want online live channel", status.Channels[0])
	}
	if status.Channels[0].InboundBytes != 1200 || len(status.Channels[0].Tracks) != 1 {
		t.Fatalf("live channel runtime fields were not merged: %#v", status.Channels[0])
	}
	if status.Channels[1].Name != "standby" || status.Channels[1].Online {
		t.Fatalf("second channel = %#v, want offline standby channel", status.Channels[1])
	}
}

func TestStatusMergesAllConfiguredAndRuntimePathPages(t *testing.T) {
	var configPages []string
	var runtimePages []string
	checkQuery := func(t *testing.T, r *http.Request) string {
		t.Helper()
		if token := r.URL.Query().Get("token"); token != "secret" {
			t.Errorf("token query = %q, want secret", token)
		}
		return r.URL.Query().Get("page")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /mediamtx/v3/info", func(w http.ResponseWriter, r *http.Request) {
		checkQuery(t, r)
		fmt.Fprint(w, `{"started":"2026-08-22T10:00:00Z","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /mediamtx/v3/config/paths/list", func(w http.ResponseWriter, r *http.Request) {
		page := checkQuery(t, r)
		configPages = append(configPages, page)
		switch page {
		case "0":
			fmt.Fprint(w, `{"itemCount":2,"pageCount":2,"items":[{"name":"standby","source":"publisher"}]}`)
		case "1":
			fmt.Fprint(w, `{"itemCount":2,"pageCount":2,"items":[{"name":"live","source":"publisher"}]}`)
		default:
			http.Error(w, "unexpected page", http.StatusBadRequest)
		}
	})
	mux.HandleFunc("GET /mediamtx/v3/paths/list", func(w http.ResponseWriter, r *http.Request) {
		page := checkQuery(t, r)
		runtimePages = append(runtimePages, page)
		switch page {
		case "0":
			fmt.Fprint(w, `{"itemCount":2,"pageCount":2,"items":[{"name":"live","available":true,"online":true,"inboundBytes":1200}]}`)
		case "1":
			fmt.Fprint(w, `{"itemCount":2,"pageCount":2,"items":[{"name":"runtime-only","available":true,"online":true,"outboundBytes":600}]}`)
		default:
			http.Error(w, "unexpected page", http.StatusBadRequest)
		}
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL+"/mediamtx?token=secret", time.Second)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}

	if got := fmt.Sprint(configPages); got != "[0 1]" {
		t.Errorf("config pages = %s, want [0 1]", got)
	}
	if got := fmt.Sprint(runtimePages); got != "[0 1]" {
		t.Errorf("runtime pages = %s, want [0 1]", got)
	}
	if len(status.Channels) != 3 {
		t.Fatalf("channel count = %d, want 3: %#v", len(status.Channels), status.Channels)
	}
	if live := status.Channels[0]; live.Name != "live" || live.ConfiguredSource != "publisher" || !live.Online || live.InboundBytes != 1200 {
		t.Errorf("live channel was not merged across pages: %#v", live)
	}
	if runtimeOnly := status.Channels[1]; runtimeOnly.Name != "runtime-only" || !runtimeOnly.Online || runtimeOnly.OutboundBytes != 600 {
		t.Errorf("runtime-only channel missing from second page: %#v", runtimeOnly)
	}
	if standby := status.Channels[2]; standby.Name != "standby" || standby.Online {
		t.Errorf("standby channel missing from first page: %#v", standby)
	}
}

func TestStatusReportsMediaMTXFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "failed", http.StatusInternalServerError)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	if _, err := client.Status(context.Background()); err == nil {
		t.Fatal("Status() error = nil, want MediaMTX failure")
	}
}

func TestReplaceAndDeletePath(t *testing.T) {
	var replaced PathConfig
	var global GlobalConfig
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"logLevel":"info","writeQueueSize":1024,"webrtcIPsFromInterfacesList":["eth0"]}`)
	})
	mux.HandleFunc("POST /v3/config/paths/replace/test-path", func(w http.ResponseWriter, r *http.Request) {
		if contentType := r.Header.Get("Content-Type"); contentType != "application/json" {
			t.Errorf("Content-Type = %q", contentType)
		}
		if err := json.NewDecoder(r.Body).Decode(&replaced); err != nil {
			t.Errorf("decode request: %v", err)
		}
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	mux.HandleFunc("DELETE /v3/config/paths/delete/test-path", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, `{"status":"error","error":"path not found"}`)
	})
	mux.HandleFunc("PATCH /v3/config/global/patch", func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&global); err != nil {
			t.Errorf("decode global request: %v", err)
		}
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	current, err := client.GetGlobal(context.Background())
	if err != nil || current.LogLevel != "info" || current.WriteQueueSize != 1024 || len(current.WebRTCIPsFromInterfacesList) != 1 || current.WebRTCIPsFromInterfacesList[0] != "eth0" {
		t.Fatalf("GetGlobal() = %#v, %v", current, err)
	}
	config := PathConfig{
		Source: "publisher", MaxReaders: 5, UseAbsoluteTimestamp: true,
		SRTPublishPassphrase: "0123456789",
	}
	if err := client.ReplacePath(context.Background(), "test-path", config); err != nil {
		t.Fatalf("ReplacePath() error = %v", err)
	}
	if replaced.Source != "publisher" || replaced.MaxReaders != 5 || replaced.SRTPublishPassphrase != "0123456789" {
		t.Fatalf("replaced config = %#v", replaced)
	}
	if err := client.DeletePath(context.Background(), "test-path"); err != nil {
		t.Fatalf("DeletePath() error = %v, want ignored not found", err)
	}
	if err := client.PatchGlobal(context.Background(), GlobalConfig{
		LogLevel: "debug", WriteQueueSize: 1024, WebRTCLocalUDPAddress: ":8189", WebRTCIPsFromInterfacesList: []string{"wlan0"},
	}); err != nil {
		t.Fatalf("PatchGlobal() error = %v", err)
	}
	if global.LogLevel != "debug" || global.WriteQueueSize != 1024 || global.WebRTCLocalUDPAddress != ":8189" || len(global.WebRTCIPsFromInterfacesList) != 1 || global.WebRTCIPsFromInterfacesList[0] != "wlan0" {
		t.Fatalf("global config = %#v", global)
	}
}

func TestClientCoalescesConcurrentStatusAndGlobalReads(t *testing.T) {
	var infoReads atomic.Int32
	var configReads atomic.Int32
	var runtimeReads atomic.Int32
	var globalReads atomic.Int32
	releaseInfo := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		infoReads.Add(1)
		<-releaseInfo
		fmt.Fprint(w, `{"started":"start-1","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		configReads.Add(1)
		fmt.Fprint(w, `{"items":[{"name":"demo","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		runtimeReads.Add(1)
		fmt.Fprint(w, `{"items":[{"name":"demo","available":true,"online":true}]}`)
	})
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		globalReads.Add(1)
		fmt.Fprint(w, `{"logLevel":"info"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}

	const callers = 12
	start := make(chan struct{})
	errorsSeen := make(chan error, callers)
	var wait sync.WaitGroup
	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, callErr := client.Status(context.Background())
			errorsSeen <- callErr
		}()
	}
	close(start)
	time.Sleep(20 * time.Millisecond)
	close(releaseInfo)
	wait.Wait()
	close(errorsSeen)
	for callErr := range errorsSeen {
		if callErr != nil {
			t.Fatal(callErr)
		}
	}
	if infoReads.Load() != 1 || configReads.Load() != 1 || runtimeReads.Load() != 1 {
		t.Fatalf("status reads = info %d, config %d, runtime %d", infoReads.Load(), configReads.Load(), runtimeReads.Load())
	}

	start = make(chan struct{})
	errorsSeen = make(chan error, callers)
	for range callers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			_, callErr := client.GetGlobal(context.Background())
			errorsSeen <- callErr
		}()
	}
	close(start)
	wait.Wait()
	close(errorsSeen)
	for callErr := range errorsSeen {
		if callErr != nil {
			t.Fatal(callErr)
		}
	}
	if globalReads.Load() != 1 {
		t.Fatalf("global reads = %d, want 1", globalReads.Load())
	}
}

func TestClientCachesDecodedResponse(t *testing.T) {
	responseDecodeCount.Store(0)
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reads.Add(1)
		fmt.Fprint(w, `"decoded"`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	requestURL := client.endpointURL("/decoded")
	clone := func(value decodeCountingResponse) decodeCountingResponse { return value }
	for range 2 {
		value, callErr := getURLCached(context.Background(), client, "/decoded", requestURL, staticCacheTTL, clone)
		if callErr != nil || value != "decoded" {
			t.Fatalf("getURLCached() = %q, %v", value, callErr)
		}
	}
	if reads.Load() != 1 || responseDecodeCount.Load() != 1 {
		t.Fatalf("reads = %d, decodes = %d, want 1 each", reads.Load(), responseDecodeCount.Load())
	}
}

func TestClientCachedResponsesIsolateCallers(t *testing.T) {
	var globalReads atomic.Int32
	var runtimeReads atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"started":"start-1","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"demo","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		runtimeReads.Add(1)
		fmt.Fprint(w, `{"items":[{"name":"demo","availableTime":"available-1","onlineTime":"online-1","source":{"type":"publisher","id":"source-1"},"readers":[{"type":"webRTCSession","id":"reader-1"}],"tracks2":[{"codec":"H264","codecProps":{"profile":"High","nested":{"levels":[{"name":"4.1"}]}}}]}]}`)
	})
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		globalReads.Add(1)
		fmt.Fprint(w, `{"webrtcIPsFromInterfacesList":["eth0"],"webrtcAdditionalHosts":["media.example.com"]}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}

	global, err := client.GetGlobal(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	global.WebRTCIPsFromInterfacesList[0] = "changed"
	global.WebRTCAdditionalHosts[0] = "changed"
	global, err = client.GetGlobal(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if globalReads.Load() != 1 || global.WebRTCIPsFromInterfacesList[0] != "eth0" || global.WebRTCAdditionalHosts[0] != "media.example.com" {
		t.Fatalf("cached global = %#v, reads %d", global, globalReads.Load())
	}

	status, err := client.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	channel := &status.Channels[0]
	*channel.AvailableTime = "changed"
	*channel.OnlineTime = "changed"
	channel.Source.Type = "changed"
	channel.Readers[0].Type = "changed"
	channel.Tracks[0].CodecProps["profile"] = "changed"
	nested := channel.Tracks[0].CodecProps["nested"].(map[string]any)
	nested["levels"].([]any)[0].(map[string]any)["name"] = "changed"

	status, err = client.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	channel = &status.Channels[0]
	nested = channel.Tracks[0].CodecProps["nested"].(map[string]any)
	if runtimeReads.Load() != 1 || *channel.AvailableTime != "available-1" || *channel.OnlineTime != "online-1" || channel.Source.Type != "publisher" || channel.Readers[0].Type != "webRTCSession" || channel.Tracks[0].CodecProps["profile"] != "High" || nested["levels"].([]any)[0].(map[string]any)["name"] != "4.1" {
		t.Fatalf("cached status was mutated: %#v, runtime reads %d", status, runtimeReads.Load())
	}
}

func TestClientCachesIndexedFinalStatusSnapshot(t *testing.T) {
	var runtimeReads atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"standby","source":"publisher"},{"name":"demo","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		runtimeReads.Add(1)
		fmt.Fprint(w, `{"items":[{"name":"demo","available":true,"online":true,"tracks2":[{"codec":"H264","codecProps":{"profile":"High"}}]}]}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	first, err := client.getStatusSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.getStatusSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != second || first.byPath["demo"] != 0 || first.byPath["standby"] != 1 || runtimeReads.Load() != 1 {
		t.Fatalf("snapshot cache/index = same %t, index %#v, reads %d", first == second, first.byPath, runtimeReads.Load())
	}

	value, found, err := client.Channel(context.Background(), "demo")
	if err != nil || !found {
		t.Fatalf("Channel(demo) = %#v, %t, %v", value, found, err)
	}
	value.Tracks[0].CodecProps["profile"] = "changed"
	value, found, err = client.Channel(context.Background(), "demo")
	if err != nil || !found || value.Tracks[0].CodecProps["profile"] != "High" || runtimeReads.Load() != 1 {
		t.Fatalf("cached Channel(demo) = %#v, %t, %v, reads %d", value, found, err, runtimeReads.Load())
	}
	if _, found, err := client.Channel(context.Background(), "missing"); err != nil || found {
		t.Fatalf("Channel(missing) found = %t, error %v", found, err)
	}
}

func TestStatusSnapshotKeepsPairedLookupsInOneGeneration(t *testing.T) {
	var runtimeReads atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"raw","source":"publisher"},{"name":"compat","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		generation := runtimeReads.Add(1)
		fmt.Fprintf(w, `{"items":[{"name":"raw","available":true,"online":true,"inboundBytes":%d},{"name":"compat","available":true,"online":true,"inboundBytes":%d}]}`,
			generation*100+1, generation*100+2)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	first, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	raw, found := first.Channel("raw")
	if !found {
		t.Fatal("first snapshot omitted raw path")
	}

	client.invalidate()
	second, err := client.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	secondRaw, found := second.Channel("raw")
	if !found {
		t.Fatal("second snapshot omitted raw path")
	}
	compat, found := first.Channel("compat")
	if !found {
		t.Fatal("first snapshot omitted compatibility path")
	}
	if runtimeReads.Load() != 2 || raw.InboundBytes != 101 || compat.InboundBytes != 102 || secondRaw.InboundBytes != 201 {
		t.Fatalf("snapshot generations: reads %d, first raw %d, first compat %d, second raw %d",
			runtimeReads.Load(), raw.InboundBytes, compat.InboundBytes, secondRaw.InboundBytes)
	}
}

func TestClientCoalescedResponsesIsolateCallers(t *testing.T) {
	var reads atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		reads.Add(1)
		close(started)
		<-release
		fmt.Fprint(w, `{"webrtcAdditionalHosts":["media.example.com"]}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		config GlobalConfig
		err    error
	}
	results := make(chan result, 2)
	go func() {
		config, callErr := client.GetGlobal(context.Background())
		results <- result{config: config, err: callErr}
	}()
	<-started
	go func() {
		config, callErr := client.GetGlobal(context.Background())
		results <- result{config: config, err: callErr}
	}()
	time.Sleep(20 * time.Millisecond)
	close(release)
	first := <-results
	second := <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("GetGlobal() errors = %v, %v", first.err, second.err)
	}
	first.config.WebRTCAdditionalHosts[0] = "changed"
	if reads.Load() != 1 || second.config.WebRTCAdditionalHosts[0] != "media.example.com" {
		t.Fatalf("coalesced configs share data: first %#v, second %#v, reads %d", first.config, second.config, reads.Load())
	}
}

func TestClientInflightRequestUsesFirstCallerContext(t *testing.T) {
	var reads atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		reads.Add(1)
		close(started)
		<-release
		fmt.Fprint(w, `{"logLevel":"info"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	type result struct {
		config GlobalConfig
		err    error
	}
	firstResult := make(chan result, 1)
	go func() {
		config, callErr := client.GetGlobal(context.Background())
		firstResult <- result{config: config, err: callErr}
	}()
	<-started

	waiterCtx, cancelWaiter := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelWaiter()
	_, waiterErr := client.GetGlobal(waiterCtx)
	readCount := reads.Load()
	close(release)
	first := <-firstResult

	if waiterErr != context.DeadlineExceeded {
		t.Fatalf("waiting GetGlobal() error = %v, want deadline exceeded", waiterErr)
	}
	if first.err != nil || first.config.LogLevel != "info" || readCount != 1 {
		t.Fatalf("first GetGlobal() = %#v, %v, reads %d", first.config, first.err, readCount)
	}
}

func TestClientPreservesCachedDecodeErrors(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reads.Add(1)
		fmt.Fprint(w, `{"version":`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, firstErr := client.Info(context.Background())
	_, secondErr := client.Info(context.Background())
	if firstErr == nil || secondErr == nil || firstErr.Error() != secondErr.Error() {
		t.Fatalf("Info() errors = %v, %v", firstErr, secondErr)
	}
	if reads.Load() != 1 {
		t.Fatalf("info reads = %d, want cached malformed response", reads.Load())
	}
}

func TestClientRuntimeCacheExpiresAndMutationInvalidatesCaches(t *testing.T) {
	var runtimeOnline atomic.Bool
	runtimeOnline.Store(true)
	var runtimeReads atomic.Int32
	var globalReads atomic.Int32
	var globalMu sync.Mutex
	global := GlobalConfig{LogLevel: "info"}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"started":"start-1","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"demo","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		runtimeReads.Add(1)
		fmt.Fprintf(w, `{"items":[{"name":"demo","available":%t,"online":%t}]}`, runtimeOnline.Load(), runtimeOnline.Load())
	})
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		globalReads.Add(1)
		globalMu.Lock()
		defer globalMu.Unlock()
		_ = json.NewEncoder(w).Encode(global)
	})
	mux.HandleFunc("PATCH /v3/config/global/patch", func(w http.ResponseWriter, r *http.Request) {
		var next GlobalConfig
		if err := json.NewDecoder(r.Body).Decode(&next); err != nil {
			t.Errorf("decode patch: %v", err)
		}
		globalMu.Lock()
		global = next
		globalMu.Unlock()
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	status, err := client.Status(context.Background())
	if err != nil || !status.Channels[0].Online {
		t.Fatalf("initial Status() = %#v, %v", status, err)
	}
	runtimeOnline.Store(false)
	time.Sleep(runtimeCacheTTL + 50*time.Millisecond)
	status, err = client.Status(context.Background())
	if err != nil || status.Channels[0].Online || runtimeReads.Load() != 2 {
		t.Fatalf("fresh Status() = %#v, %v, runtime reads %d", status, err, runtimeReads.Load())
	}

	current, err := client.GetGlobal(context.Background())
	if err != nil || current.LogLevel != "info" {
		t.Fatalf("GetGlobal() = %#v, %v", current, err)
	}
	if _, err := client.GetGlobal(context.Background()); err != nil || globalReads.Load() != 1 {
		t.Fatalf("cached GetGlobal() error = %v, reads %d", err, globalReads.Load())
	}
	if err := client.PatchGlobal(context.Background(), GlobalConfig{LogLevel: "debug"}); err != nil {
		t.Fatal(err)
	}
	current, err = client.GetGlobal(context.Background())
	if err != nil || current.LogLevel != "debug" || globalReads.Load() != 2 {
		t.Fatalf("invalidated GetGlobal() = %#v, %v, reads %d", current, err, globalReads.Load())
	}
}

func TestStatusFreshBypassesCachedRuntime(t *testing.T) {
	var runtimeOnline atomic.Bool
	var runtimeReads atomic.Int32
	var infoReads atomic.Int32
	var configReads atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		infoReads.Add(1)
		fmt.Fprint(w, `{"started":"start-1","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		configReads.Add(1)
		fmt.Fprint(w, `{"items":[{"name":"demo","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		runtimeReads.Add(1)
		fmt.Fprintf(w, `{"items":[{"name":"demo","available":%t,"online":%t}]}`, runtimeOnline.Load(), runtimeOnline.Load())
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	status, err := client.Status(context.Background())
	if err != nil || status.Channels[0].Online {
		t.Fatalf("initial Status() = %#v, %v", status, err)
	}
	runtimeOnline.Store(true)
	status, err = client.Status(context.Background())
	if err != nil || status.Channels[0].Online || runtimeReads.Load() != 1 {
		t.Fatalf("cached Status() = %#v, %v, runtime reads %d", status, err, runtimeReads.Load())
	}
	status, err = client.StatusFresh(context.Background())
	if err != nil || !status.Channels[0].Online || runtimeReads.Load() != 2 || infoReads.Load() != 1 || configReads.Load() != 1 {
		t.Fatalf("StatusFresh() = %#v, %v, reads runtime=%d info=%d config=%d",
			status, err, runtimeReads.Load(), infoReads.Load(), configReads.Load())
	}
}

func TestStatusFreshKeepsUnrelatedInflightGeneration(t *testing.T) {
	var globalReads atomic.Int32
	globalStarted := make(chan struct{})
	releaseGlobal := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/info", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"started":"start-1","version":"1.20.1"}`)
	})
	mux.HandleFunc("GET /v3/config/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"demo","source":"publisher"}]}`)
	})
	mux.HandleFunc("GET /v3/paths/list", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"items":[{"name":"demo","available":true,"online":true}]}`)
	})
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		if globalReads.Add(1) == 1 {
			close(globalStarted)
		}
		<-releaseGlobal
		fmt.Fprint(w, `{"logLevel":"info"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	globalResult := make(chan GlobalConfig, 1)
	globalError := make(chan error, 1)
	go func() {
		config, callErr := client.GetGlobal(context.Background())
		globalResult <- config
		globalError <- callErr
	}()
	<-globalStarted
	if _, err := client.StatusFresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	close(releaseGlobal)
	if config := <-globalResult; config.LogLevel != "info" {
		t.Fatalf("in-flight GetGlobal() = %#v", config)
	}
	if err := <-globalError; err != nil {
		t.Fatal(err)
	}
	config, err := client.GetGlobal(context.Background())
	if err != nil || config.LogLevel != "info" || globalReads.Load() != 1 {
		t.Fatalf("cached GetGlobal() = %#v, %v, reads %d", config, err, globalReads.Load())
	}
}

func TestClientMutationInvalidatesEarlierInflightRead(t *testing.T) {
	var reads atomic.Int32
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v3/config/global/get", func(w http.ResponseWriter, _ *http.Request) {
		if reads.Add(1) == 1 {
			close(firstStarted)
			<-releaseFirst
			fmt.Fprint(w, `{"logLevel":"old"}`)
			return
		}
		fmt.Fprint(w, `{"logLevel":"new"}`)
	})
	mux.HandleFunc("PATCH /v3/config/global/patch", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	firstResult := make(chan GlobalConfig, 1)
	firstError := make(chan error, 1)
	go func() {
		config, callErr := client.GetGlobal(context.Background())
		firstResult <- config
		firstError <- callErr
	}()
	<-firstStarted
	if err := client.PatchGlobal(context.Background(), GlobalConfig{LogLevel: "new"}); err != nil {
		t.Fatal(err)
	}
	current, err := client.GetGlobal(context.Background())
	if err != nil || current.LogLevel != "new" {
		t.Fatalf("GetGlobal() after mutation = %#v, %v", current, err)
	}
	close(releaseFirst)
	if first := <-firstResult; first.LogLevel != "old" {
		t.Fatalf("first GetGlobal() = %#v, want its own response", first)
	}
	if err := <-firstError; err != nil {
		t.Fatal(err)
	}
	current, err = client.GetGlobal(context.Background())
	if err != nil || current.LogLevel != "new" || reads.Load() != 2 {
		t.Fatalf("cached GetGlobal() = %#v, %v, reads %d", current, err, reads.Load())
	}
}
