package channel

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestSQLiteStoreRoundTrip(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "gateway.db"))
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	defer store.Close()

	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	item, err := New(Draft{
		Name:             "SRT pull",
		Enabled:          true,
		AutomaticPreview: true,
		MaxReaders:       12,
		Input: Input{Mode: InputSRTPull, SRT: &SRTInput{
			Host: "source.local", Port: 8890, StreamID: "camera", Passphrase: "test+secret", LatencyMS: 200,
		}},
	}, now)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	item.Number = 3
	if err := store.Create(context.Background(), item); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	loaded, err := store.Get(context.Background(), item.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if loaded.Number != 3 || loaded.Input.SRT.Passphrase != "test+secret" || loaded.MaxReaders != 12 || !loaded.AutomaticPreview {
		t.Fatalf("stored channel did not round trip: %#v", loaded)
	}
	byNumber, err := store.GetByNumber(context.Background(), 3)
	if err != nil || byNumber.ID != item.ID {
		t.Fatalf("GetByNumber() = %#v, %v", byNumber, err)
	}

	loaded.Name = "Updated"
	loaded.ApplyState = ApplyApplied
	if err := store.Update(context.Background(), loaded); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	items, err := store.List(context.Background())
	if err != nil || len(items) != 1 || items[0].Name != "Updated" {
		t.Fatalf("List() = %#v, %v", items, err)
	}

	if err := store.Delete(context.Background(), item.ID); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := store.Get(context.Background(), item.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestSQLiteStoreMigratesLegacyColumnsAndNumbers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "gateway.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE channels (
		id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL,
		input_json TEXT NOT NULL, max_readers INTEGER NOT NULL, use_absolute_timestamp INTEGER NOT NULL,
		apply_state TEXT NOT NULL, apply_error TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	)`)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	_, err = db.Exec(`INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"legacy", "Zulu", "legacy-path", true, `{"mode":"srt-push","srt":{"port":10000}}`, 0, false,
		ApplyApplied, "", now, now)
	if err != nil {
		t.Fatal(err)
	}
	later := time.Date(2026, 8, 22, 13, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	_, err = db.Exec(`INSERT INTO channels VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"legacy-2", "Alpha", "legacy-path-2", true, `{"mode":"srt-push","srt":{"port":10001}}`, 0, false,
		ApplyApplied, "", later, later)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite() error = %v", err)
	}
	items, err := store.List(context.Background())
	if err != nil || len(items) != 2 {
		t.Fatalf("List() = %#v, %v", items, err)
	}
	if items[0].ID != "legacy" || items[0].Number != 1 || !items[0].AutomaticPreview ||
		items[1].ID != "legacy-2" || items[1].Number != 2 || !items[1].AutomaticPreview {
		t.Fatalf("migrated channels = %#v", items)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("reopen SQLite: %v", err)
	}
	defer reopened.Close()
	items, err = reopened.List(context.Background())
	if err != nil || len(items) != 2 || items[0].Number != 1 || items[1].Number != 2 {
		t.Fatalf("List() after reopen = %#v, %v", items, err)
	}
}
