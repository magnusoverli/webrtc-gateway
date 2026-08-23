package config

import (
	"runtime"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("GATEWAY_LISTEN_ADDR", "")
	t.Setenv("GATEWAY_HEALTH_LISTEN_ADDR", "")
	t.Setenv("GATEWAY_MEDIAMTX_API_URL", "")
	t.Setenv("GATEWAY_MEDIAMTX_WHEP_URL", "")
	t.Setenv("GATEWAY_MEDIAMTX_RTSP_URL", "")
	t.Setenv("GATEWAY_STATE_PATH", "")
	t.Setenv("GATEWAY_COMPATIBILITY_ENCODER_THREADS", "")
	t.Setenv("GATEWAY_COMPATIBILITY_CAPACITY", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ListenAddr != ":8080" {
		t.Fatalf("ListenAddr = %q, want :8080", cfg.ListenAddr)
	}
	if cfg.HealthAddr != "127.0.0.1:18080" {
		t.Fatalf("HealthAddr = %q", cfg.HealthAddr)
	}
	if cfg.MediaMTXAPIURL != "http://127.0.0.1:9997" {
		t.Fatalf("MediaMTXAPIURL = %q", cfg.MediaMTXAPIURL)
	}
	if cfg.EncoderThreads != min(6, runtime.NumCPU()) || cfg.WorkerCapacity != max(1, runtime.NumCPU()*3/4) {
		t.Fatalf("compatibility defaults = threads %d, capacity %d", cfg.EncoderThreads, cfg.WorkerCapacity)
	}
}

func TestLoadRejectsRelativeMediaURL(t *testing.T) {
	t.Setenv("GATEWAY_MEDIAMTX_API_URL", "/mediamtx")
	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid URL error")
	}
}

func TestLoadCompatibilityOverrides(t *testing.T) {
	t.Setenv("GATEWAY_COMPATIBILITY_ENCODER_THREADS", "6")
	t.Setenv("GATEWAY_COMPATIBILITY_CAPACITY", "12")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EncoderThreads != 6 || cfg.WorkerCapacity != 12 {
		t.Fatalf("compatibility overrides = threads %d, capacity %d", cfg.EncoderThreads, cfg.WorkerCapacity)
	}
}

func TestLoadRejectsInvalidCompatibilityLimits(t *testing.T) {
	t.Setenv("GATEWAY_COMPATIBILITY_ENCODER_THREADS", "0")
	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid encoder thread limit")
	}
}
