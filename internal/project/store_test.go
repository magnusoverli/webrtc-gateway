package project

import (
	"context"
	"testing"
	"time"

	"webrtc-gateway/internal/channel"
	"webrtc-gateway/internal/settings"
)

func TestSQLiteStoreCreatesAndReplacesLiveConfiguration(t *testing.T) {
	path := t.TempDir() + "/gateway.db"
	channelStore, err := channel.OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer channelStore.Close()
	settingsStore, err := settings.OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer settingsStore.Close()
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	now := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)
	configuration := validConfiguration(now)
	configuration.Channels[0].Input.SRT.Passphrase = "secret-passphrase"
	item, err := store.Create(context.Background(), "Studio", configuration, now)
	if err != nil {
		t.Fatal(err)
	}
	if item.Revision != 1 || item.Summary().ChannelCount != 1 {
		t.Fatalf("project = %+v", item)
	}
	if err := store.ReplaceLive(context.Background(), configuration, now); err != nil {
		t.Fatal(err)
	}
	liveChannels, err := channelStore.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(liveChannels) != 1 || liveChannels[0].ID != configuration.Channels[0].ID || liveChannels[0].Number != 1 {
		t.Fatalf("live channels = %+v", liveChannels)
	}
	if liveChannels[0].Input.SRT.Passphrase != "secret-passphrase" || liveChannels[0].ApplyState != channel.ApplyPending {
		t.Fatalf("live channel state = %+v", liveChannels[0])
	}
	liveSettings, err := settingsStore.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if liveSettings.ApplyState != settings.ApplyPending || liveSettings.Revision < 2 {
		t.Fatalf("live settings = %+v", liveSettings)
	}
}

func TestSQLiteStoreRejectsDuplicateProjectNames(t *testing.T) {
	path := t.TempDir() + "/gateway.db"
	channelStore, _ := channel.OpenSQLite(path)
	defer channelStore.Close()
	settingsStore, _ := settings.OpenSQLite(path)
	defer settingsStore.Close()
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	configuration := validConfiguration(time.Now())
	if _, err := store.Create(context.Background(), "Studio", configuration, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Create(context.Background(), "studio", configuration, time.Now()); err != ErrNameConflict {
		t.Fatalf("error = %v", err)
	}
}
