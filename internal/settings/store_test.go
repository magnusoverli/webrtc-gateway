package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
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
	value.ManagementBindAddress = "interface:ipv4:eth0"
	value.MediaBindAddress = "interface:ipv4:eth0"
	value.ApplyState = ApplyApplied
	previousRevision := value.Revision
	value.Revision++
	if err := store.Update(context.Background(), value, previousRevision); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	store.Close()

	reopened, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite() after close error = %v", err)
	}
	defer reopened.Close()
	loaded, err := reopened.Get(context.Background())
	if err != nil || loaded.LogLevel != "debug" || loaded.ApplyState != ApplyApplied ||
		loaded.ManagementBindAddress != "interface:ipv4:eth0" || loaded.MediaBindAddress != "interface:ipv4:eth0" {
		t.Fatalf("persisted settings = %#v, %v", loaded, err)
	}
}

func TestSQLiteStoreMigratesRevisionAndProtectsCurrentGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	legacy := Defaults(time.Now())
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE global_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL,
		apply_state TEXT NOT NULL, apply_error TEXT NOT NULL, updated_at TEXT NOT NULL
	)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO global_settings VALUES (1, ?, ?, '', ?)`,
		string(encoded), ApplyPending, legacy.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	current, err := store.Get(context.Background())
	if err != nil || current.Revision != 1 {
		t.Fatalf("migrated settings = %#v, %v", current, err)
	}
	next := current
	next.LogLevel = "debug"
	next.Revision = 2
	if err := store.Update(context.Background(), next, 1); err != nil {
		t.Fatal(err)
	}
	stale := current
	stale.LogLevel = "error"
	stale.Revision = 2
	if err := store.Update(context.Background(), stale, 1); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale Update() error = %v", err)
	}
	if err := store.SetApplyResult(context.Background(), 1, ApplyError, "old failure"); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("old SetApplyResult() error = %v", err)
	}
	loaded, err := store.Get(context.Background())
	if err != nil || loaded.Revision != 2 || loaded.LogLevel != "debug" || loaded.ApplyState != ApplyPending {
		t.Fatalf("settings after stale writes = %#v, %v", loaded, err)
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

func TestSQLiteStoreNormalizesNullAdditionalHosts(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.db.Exec(`UPDATE global_settings SET settings_json = json_set(settings_json, '$.webRTCAdditionalHosts', json('null')) WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(loaded)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WebRTCAdditionalHosts == nil || !strings.Contains(string(encoded), `"webRTCAdditionalHosts":[]`) {
		t.Fatalf("additional hosts were not normalized: %s", encoded)
	}
}
