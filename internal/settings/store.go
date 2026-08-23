package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"webrtc-gateway/internal/networkbind"

	_ "modernc.org/sqlite"
)

type Repository interface {
	Get(context.Context) (Settings, error)
	Update(context.Context, Settings) error
	SetApplyResult(context.Context, ApplyState, string) error
}

type SQLiteStore struct {
	db *sql.DB
}

func OpenSQLite(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open settings database: %w", err)
	}
	db.SetMaxOpenConns(1)
	store := &SQLiteStore{db: db}
	if err := store.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

func (s *SQLiteStore) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `PRAGMA journal_mode = WAL`); err != nil {
		return fmt.Errorf("enable settings WAL: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `PRAGMA busy_timeout = 5000`); err != nil {
		return fmt.Errorf("set settings busy timeout: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS global_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		settings_json TEXT NOT NULL,
		apply_state TEXT NOT NULL,
		apply_error TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("migrate settings database: %w", err)
	}

	defaults := Defaults(time.Now())
	encoded, err := json.Marshal(defaults)
	if err != nil {
		return fmt.Errorf("encode default settings: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO global_settings (id, settings_json, apply_state, apply_error, updated_at)
		VALUES (1, ?, ?, '', ?)`, string(encoded), defaults.ApplyState, defaults.UpdatedAt.Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("initialize settings database: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Get(ctx context.Context) (Settings, error) {
	var encoded string
	var applyState ApplyState
	var applyError string
	var updatedAt string
	if err := s.db.QueryRowContext(ctx,
		`SELECT settings_json, apply_state, apply_error, updated_at FROM global_settings WHERE id = 1`,
	).Scan(&encoded, &applyState, &applyError, &updatedAt); err != nil {
		return Settings{}, fmt.Errorf("get settings: %w", err)
	}
	value := Defaults(time.Now())
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(encoded), &fields); err != nil {
		return Settings{}, fmt.Errorf("decode settings fields: %w", err)
	}
	if err := json.Unmarshal([]byte(encoded), &value); err != nil {
		return Settings{}, fmt.Errorf("decode settings: %w", err)
	}
	if _, exists := fields["managementBindAddress"]; !exists {
		value.ManagementBindAddress = networkbind.All
	}
	if _, exists := fields["mediaBindAddress"]; !exists {
		value.MediaBindAddress = networkbind.LegacyMediaBinding(
			value.SRTAddress, value.WebRTCLocalUDPAddress, value.WebRTCLocalTCPAddress,
		)
	}
	value.ApplyState = applyState
	value.ApplyError = applyError
	var err error
	value.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Settings{}, fmt.Errorf("decode settings update time: %w", err)
	}
	return value, nil
}

func (s *SQLiteStore) ChannelPortPolicy(ctx context.Context) (int, int, string, []int, error) {
	value, err := s.Get(ctx)
	if err != nil {
		return 0, 0, "", nil, err
	}
	srtPort, err := listenerPort("srtAddress", value.SRTAddress, false)
	if err != nil {
		return 0, 0, "", nil, err
	}
	webrtcPort, err := listenerPort("webRTCLocalUDPAddress", value.WebRTCLocalUDPAddress, false)
	if err != nil {
		return 0, 0, "", nil, err
	}
	return value.RTPPortMin, value.RTPPortMax, value.SRTAddress, []int{srtPort, webrtcPort}, nil
}

func (s *SQLiteStore) MediaBindAddress(ctx context.Context) (string, error) {
	value, err := s.Get(ctx)
	if err != nil {
		return "", err
	}
	return value.MediaBindAddress, nil
}

func (s *SQLiteStore) Update(ctx context.Context, value Settings) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE global_settings SET settings_json = ?, apply_state = ?, apply_error = ?, updated_at = ? WHERE id = 1`,
		string(encoded), value.ApplyState, value.ApplyError, value.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("update settings: %w", err)
	}
	return nil
}

func (s *SQLiteStore) SetApplyResult(ctx context.Context, state ApplyState, applyError string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE global_settings SET apply_state = ?, apply_error = ? WHERE id = 1`, state, applyError)
	if err != nil {
		return fmt.Errorf("set settings apply result: %w", err)
	}
	return nil
}
