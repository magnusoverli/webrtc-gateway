package settings

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteStoreInitializesAndPersistsSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	value, err := store.Get(context.Background())
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	value.LogLevel = "debug"
	value.ApplyState = ApplyApplied
	if err := store.Update(context.Background(), value); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	store.Close()

	reopened, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite() after close error = %v", err)
	}
	defer reopened.Close()
	loaded, err := reopened.Get(context.Background())
	if err != nil || loaded.LogLevel != "debug" || loaded.ApplyState != ApplyApplied {
		t.Fatalf("persisted settings = %#v, %v", loaded, err)
	}
}

func TestSQLiteStoreMigratesLegacyBindingFields(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()
	legacy := Defaults(time.Now())
	legacy.SRTAddress = "192.0.2.10:8890"
	legacy.WebRTCLocalUDPAddress = "192.0.2.11:8189"
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, "managementBindAddress")
	delete(fields, "mediaBindAddress")
	encoded, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE global_settings SET settings_json = ? WHERE id = 1`, string(encoded)); err != nil {
		t.Fatal(err)
	}

	loaded, err := store.Get(context.Background())
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if loaded.ManagementBindAddress != "*" || loaded.MediaBindAddress != "custom" {
		t.Fatalf("migrated bindings = management %q, media %q", loaded.ManagementBindAddress, loaded.MediaBindAddress)
	}
}
