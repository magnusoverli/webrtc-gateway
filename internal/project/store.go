package project

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"webrtc-gateway/internal/channel"

	_ "modernc.org/sqlite"
)

type Repository interface {
	List(context.Context) ([]Project, error)
	Get(context.Context, string) (Project, error)
	Create(context.Context, string, Configuration, time.Time) (Project, error)
	Update(context.Context, Project, int) error
	Delete(context.Context, string, int) error
	ReplaceLive(context.Context, Configuration, time.Time) error
}

type SQLiteStore struct{ db *sql.DB }

func OpenSQLite(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open project database: %w", err)
	}
	db.SetMaxOpenConns(1)
	store := &SQLiteStore{db: db}
	if err := store.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *SQLiteStore) Close() error { return s.db.Close() }

func (s *SQLiteStore) migrate(ctx context.Context) error {
	statements := []string{
		`PRAGMA journal_mode = WAL`,
		`PRAGMA busy_timeout = 5000`,
		`CREATE TABLE IF NOT EXISTS projects (
			id TEXT PRIMARY KEY,
			revision INTEGER NOT NULL,
			name TEXT NOT NULL COLLATE NOCASE UNIQUE,
			configuration_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate project database: %w", err)
		}
	}
	return nil
}

func (s *SQLiteStore) List(ctx context.Context) ([]Project, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, revision, name, configuration_json, created_at, updated_at FROM projects ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", err)
	}
	defer rows.Close()
	items := make([]Project, 0)
	for rows.Next() {
		item, scanErr := scanProject(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *SQLiteStore) Get(ctx context.Context, id string) (Project, error) {
	item, err := scanProject(s.db.QueryRowContext(ctx, `SELECT id, revision, name, configuration_json, created_at, updated_at FROM projects WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	return item, err
}

func (s *SQLiteStore) Create(ctx context.Context, name string, configuration Configuration, now time.Time) (Project, error) {
	id, err := newID()
	if err != nil {
		return Project{}, err
	}
	encoded, err := json.Marshal(configuration)
	if err != nil {
		return Project{}, fmt.Errorf("encode project: %w", err)
	}
	item := Project{ID: id, Revision: 1, Name: name, Configuration: configuration, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
	_, err = s.db.ExecContext(ctx, `INSERT INTO projects (id, revision, name, configuration_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		item.ID, item.Revision, item.Name, string(encoded), item.CreatedAt.Format(time.RFC3339Nano), item.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		if isUniqueError(err) {
			return Project{}, ErrNameConflict
		}
		return Project{}, fmt.Errorf("create project: %w", err)
	}
	return item, nil
}

func (s *SQLiteStore) Update(ctx context.Context, item Project, expectedRevision int) error {
	encoded, err := json.Marshal(item.Configuration)
	if err != nil {
		return fmt.Errorf("encode project: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `UPDATE projects SET revision = ?, name = ?, configuration_json = ?, updated_at = ? WHERE id = ? AND revision = ?`,
		item.Revision, item.Name, string(encoded), item.UpdatedAt.Format(time.RFC3339Nano), item.ID, expectedRevision)
	if err != nil {
		if isUniqueError(err) {
			return ErrNameConflict
		}
		return fmt.Errorf("update project: %w", err)
	}
	return s.requireProjectCAS(ctx, result, item.ID)
}

func (s *SQLiteStore) Delete(ctx context.Context, id string, expectedRevision int) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM projects WHERE id = ? AND revision = ?`, id, expectedRevision)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	return s.requireProjectCAS(ctx, result, id)
}

func (s *SQLiteStore) ReplaceLive(ctx context.Context, configuration Configuration, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin live configuration replacement: %w", err)
	}
	defer tx.Rollback()

	var settingsRevision int
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM global_settings WHERE id = 1`).Scan(&settingsRevision); err != nil {
		return fmt.Errorf("read live settings revision: %w", err)
	}
	settingsValue := configuration.Settings.Live(now)
	settingsValue.Revision = settingsRevision + 1
	settingsJSON, err := json.Marshal(settingsValue)
	if err != nil {
		return fmt.Errorf("encode live settings: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE global_settings SET revision = ?, settings_json = ?, apply_state = ?, apply_error = '', updated_at = ? WHERE id = 1`,
		settingsValue.Revision, string(settingsJSON), settingsValue.ApplyState, now.UTC().Format(time.RFC3339Nano)); err != nil {
		return fmt.Errorf("replace live settings: %w", err)
	}

	maxRevision := settingsRevision
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(revision), 0) FROM channels`).Scan(&maxRevision); err != nil {
		return fmt.Errorf("read live channel generation: %w", err)
	}
	if maxRevision < settingsRevision {
		maxRevision = settingsRevision
	}
	generation := maxRevision + 1
	if _, err := tx.ExecContext(ctx, `DELETE FROM channels`); err != nil {
		return fmt.Errorf("clear live channels: %w", err)
	}
	for _, snapshot := range configuration.Channels {
		item := snapshot.Live(generation, now)
		input, marshalErr := json.Marshal(item.Input)
		if marshalErr != nil {
			return fmt.Errorf("encode live channel input: %w", marshalErr)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO channels (
			id, revision, channel_number, name, path, enabled, automatic_preview, input_json, max_readers,
			use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
			item.ID, item.Revision, item.Number, item.Name, item.Path, item.Enabled, item.AutomaticPreview,
			string(input), item.MaxReaders, item.UseAbsoluteTimestamp, channel.ApplyPending,
			item.CreatedAt.Format(time.RFC3339Nano), item.UpdatedAt.Format(time.RFC3339Nano)); err != nil {
			return fmt.Errorf("replace live channel %s: %w", item.Name, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit live configuration replacement: %w", err)
	}
	return nil
}

type scanner interface{ Scan(...any) error }

func scanProject(row scanner) (Project, error) {
	var item Project
	var encoded, createdAt, updatedAt string
	if err := row.Scan(&item.ID, &item.Revision, &item.Name, &encoded, &createdAt, &updatedAt); err != nil {
		return Project{}, err
	}
	if err := json.Unmarshal([]byte(encoded), &item.Configuration); err != nil {
		return Project{}, fmt.Errorf("decode project %s: %w", item.ID, err)
	}
	if item.Configuration.Settings.WebRTCAdditionalHosts == nil {
		item.Configuration.Settings.WebRTCAdditionalHosts = []string{}
	}
	var err error
	item.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Project{}, err
	}
	item.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	return item, err
}

func (s *SQLiteStore) requireProjectCAS(ctx context.Context, result sql.Result, id string) error {
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		var exists int
		if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM projects WHERE id = ?`, id).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("check project revision: %w", err)
		}
		return ErrRevisionConflict
	}
	return nil
}

func isUniqueError(err error) bool {
	return err != nil && (contains(err.Error(), "UNIQUE constraint failed") || contains(err.Error(), "constraint failed"))
}

func contains(value, substring string) bool {
	for index := 0; index+len(substring) <= len(value); index++ {
		if value[index:index+len(substring)] == substring {
			return true
		}
	}
	return false
}

func newID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate project ID: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}
