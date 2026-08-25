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
