package mediamtx

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
		fmt.Fprint(w, `{"logLevel":"info","writeQueueSize":1024}`)
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
	if err != nil || current.LogLevel != "info" || current.WriteQueueSize != 1024 {
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
		LogLevel: "debug", WriteQueueSize: 1024, WebRTCLocalUDPAddress: ":8189",
	}); err != nil {
		t.Fatalf("PatchGlobal() error = %v", err)
	}
	if global.LogLevel != "debug" || global.WriteQueueSize != 1024 || global.WebRTCLocalUDPAddress != ":8189" {
		t.Fatalf("global config = %#v", global)
	}
}
