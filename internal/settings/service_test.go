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
	channels      int
	srt           int
	err           error
	validationErr error
}

func (f *fakeChannelReconciler) Reconcile(context.Context) error {
	f.channels++
	return f.err
}

func (f *fakeChannelReconciler) ReconcileSRTListeners(context.Context) error {
	f.srt++
	return f.err
}

func (f *fakeChannelReconciler) ValidatePortPolicy(context.Context, int, int, []int) error {
	return f.validationErr
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
	service := NewService(store, media, nil, nil)
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
	service := NewService(store, media, nil, nil)

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

func TestServiceRejectsChannelPortConflictBeforePersistingSettings(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	current, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	channels := &fakeChannelReconciler{validationErr: errors.New("port conflict")}
	service := NewService(store, &fakeGlobalManager{config: globalConfig(current)}, channels, nil)
	updated := current
	updated.LogLevel = "debug"

	if _, err := service.Update(context.Background(), updated); err == nil || err.Error() != "port conflict" {
		t.Fatalf("Update() error = %v", err)
	}
	persisted, err := store.Get(context.Background())
	if err != nil || persisted.LogLevel != current.LogLevel {
		t.Fatalf("persisted settings = %#v, %v", persisted, err)
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
	service := NewService(store, media, channels, nil)
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

func TestServiceReconcilesEveryChannelWhenSRTPortChanges(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	value, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	media := &fakeGlobalManager{config: globalConfig(value)}
	channels := &fakeChannelReconciler{}
	service := NewService(store, media, channels, nil)
	value.SRTAddress = ":8891"

	if _, err := service.Update(context.Background(), value); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if channels.channels != 1 || channels.srt != 0 {
		t.Fatalf("reconcile calls = channels %d, SRT %d", channels.channels, channels.srt)
	}
}

func TestPendingSettingsRetryForcesCompleteChannelReconcile(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	value, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	media := &fakeGlobalManager{config: globalConfig(value)}
	channels := &fakeChannelReconciler{err: errors.New("channel apply failed")}
	service := NewService(store, media, channels, nil)
	value.SRTAddress = ":8891"

	updated, err := service.Update(context.Background(), value)
	if err == nil || updated.ApplyState != ApplyError {
		t.Fatalf("Update() = %#v, %v", updated, err)
	}
	channels.err = nil
	if err := service.ReconcilePending(context.Background()); err != nil {
		t.Fatalf("ReconcilePending() error = %v", err)
	}
	if channels.channels != 2 || channels.srt != 0 {
		t.Fatalf("reconcile calls = channels %d, SRT %d", channels.channels, channels.srt)
	}
	persisted, err := store.Get(context.Background())
	if err != nil || persisted.ApplyState != ApplyApplied {
		t.Fatalf("settings = %#v, %v", persisted, err)
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
