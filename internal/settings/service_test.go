package settings

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"webrtc-gateway/internal/mediamtx"
)

type fakeGlobalManager struct {
	config                 mediamtx.GlobalConfig
	err                    error
	patches                int
	restartReadsAfterPatch int
	restartReads           int
}

type fakeChannelReconciler struct {
	channels int
	srt      int
}

func (f *fakeChannelReconciler) Reconcile(context.Context) error {
	f.channels++
	return nil
}

func (f *fakeChannelReconciler) ReconcileSRTListeners(context.Context) error {
	f.srt++
	return nil
}

func (f *fakeGlobalManager) GetGlobal(context.Context) (mediamtx.GlobalConfig, error) {
	if f.restartReads > 0 {
		f.restartReads--
		return mediamtx.GlobalConfig{}, errors.New("control API restarting")
	}
	return f.config, f.err
}

func (f *fakeGlobalManager) PatchGlobal(_ context.Context, config mediamtx.GlobalConfig) error {
	f.config = config
	f.patches++
	f.restartReads = f.restartReadsAfterPatch
	return f.err
}

func TestServiceSkipsIdenticalGlobalPatch(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	value, err := store.Get(context.Background())
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	media := &fakeGlobalManager{config: mediamtx.GlobalConfig{
		LogLevel: value.LogLevel, ReadTimeout: value.ReadTimeout, WriteTimeout: value.WriteTimeout,
		WriteQueueSize: value.WriteQueueSize, UDPMaxPayloadSize: value.UDPMaxPayloadSize,
		UDPReadBufferSize: value.UDPReadBufferSize, SRTAddress: value.SRTAddress,
		WebRTCLocalUDPAddress: value.WebRTCLocalUDPAddress, WebRTCLocalTCPAddress: value.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces: value.WebRTCIPsFromInterfaces, WebRTCAdditionalHosts: value.WebRTCAdditionalHosts,
		WebRTCHandshakeTimeout: value.WebRTCHandshakeTimeout, WebRTCTrackGatherTimeout: value.WebRTCTrackGatherTimeout,
	}}
	service := NewService(store, media, nil)
	if err := service.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if media.patches != 0 {
		t.Fatalf("PatchGlobal() calls = %d, want 0", media.patches)
	}
}

func TestServiceUpdatesAndAppliesSettings(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	media := &fakeGlobalManager{}
	service := NewService(store, media, nil)

	value, err := service.Get(context.Background())
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	value.LogLevel = "debug"
	value.WebRTCAdditionalHosts = []string{"192.168.1.10"}
	updated, err := service.Update(context.Background(), value)
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.ApplyState != ApplyApplied || media.config.LogLevel != "debug" {
		t.Fatalf("settings were not applied: %#v, %#v", updated, media.config)
	}
	if len(media.config.WebRTCAdditionalHosts) != 1 {
		t.Fatalf("additional hosts = %#v", media.config.WebRTCAdditionalHosts)
	}
}

func TestServiceReconcilesEveryChannelWhenMediaBindingChanges(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	value, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	media := &fakeGlobalManager{config: globalConfig(value), restartReadsAfterPatch: 2}
	channels := &fakeChannelReconciler{}
	service := NewService(store, media, channels)
	value.MediaBindAddress = "127.0.0.1"

	updated, err := service.Update(context.Background(), value)
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.SRTAddress != "127.0.0.1:8890" || media.config.WebRTCLocalUDPAddress != "127.0.0.1:8189" {
		t.Fatalf("media binding was not applied: %#v", updated)
	}
	if channels.channels != 1 || channels.srt != 0 {
		t.Fatalf("reconcile calls = channels %d, SRT %d", channels.channels, channels.srt)
	}
}

func globalConfig(value Settings) mediamtx.GlobalConfig {
	return mediamtx.GlobalConfig{
		LogLevel: value.LogLevel, ReadTimeout: value.ReadTimeout, WriteTimeout: value.WriteTimeout,
		WriteQueueSize: value.WriteQueueSize, UDPMaxPayloadSize: value.UDPMaxPayloadSize,
		UDPReadBufferSize: value.UDPReadBufferSize, SRTAddress: value.SRTAddress,
		WebRTCLocalUDPAddress: value.WebRTCLocalUDPAddress, WebRTCLocalTCPAddress: value.WebRTCLocalTCPAddress,
		WebRTCIPsFromInterfaces: value.WebRTCIPsFromInterfaces, WebRTCAdditionalHosts: value.WebRTCAdditionalHosts,
		WebRTCHandshakeTimeout: value.WebRTCHandshakeTimeout, WebRTCTrackGatherTimeout: value.WebRTCTrackGatherTimeout,
	}
}
