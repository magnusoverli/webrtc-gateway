package channel

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("channel not found")

type Repository interface {
	List(context.Context) ([]Channel, error)
	Get(context.Context, string) (Channel, error)
	Create(context.Context, Channel) error
	Update(context.Context, Channel) error
	Delete(context.Context, string) error
	SetApplyResult(context.Context, string, ApplyState, string) error
}

type SQLiteStore struct {
	db *sql.DB
}

func OpenSQLite(path string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open channel database: %w", err)
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
	statements := []string{
		`PRAGMA journal_mode = WAL`,
		`PRAGMA busy_timeout = 5000`,
		`CREATE TABLE IF NOT EXISTS channels (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			path TEXT NOT NULL UNIQUE,
			enabled INTEGER NOT NULL,
			input_json TEXT NOT NULL,
			max_readers INTEGER NOT NULL,
			use_absolute_timestamp INTEGER NOT NULL,
			apply_state TEXT NOT NULL,
			apply_error TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("migrate channel database: %w", err)
		}
	}
	if err := s.addAutomaticPreviewColumn(ctx); err != nil {
		return err
	}
	return nil
}

func (s *SQLiteStore) addAutomaticPreviewColumn(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(channels)`)
	if err != nil {
		return fmt.Errorf("inspect channel schema: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, notNull, primaryKey int
		var name, kind string
		var defaultValue sql.NullString
		if err := rows.Scan(&id, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return fmt.Errorf("inspect channel column: %w", err)
		}
		if name == "automatic_preview" {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("inspect channel schema: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close channel schema inspection: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE channels ADD COLUMN automatic_preview INTEGER NOT NULL DEFAULT 1`); err != nil {
		return fmt.Errorf("add channel automatic preview setting: %w", err)
	}
	return nil
}

func (s *SQLiteStore) List(ctx context.Context) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, path, enabled, automatic_preview, input_json, max_readers,
		       use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		FROM channels ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	defer rows.Close()

	channels := make([]Channel, 0)
	for rows.Next() {
		item, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	return channels, nil
}

func (s *SQLiteStore) Get(ctx context.Context, id string) (Channel, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, path, enabled, automatic_preview, input_json, max_readers,
		       use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		FROM channels WHERE id = ?`, id)
	item, err := scanChannel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return item, err
}

func (s *SQLiteStore) Create(ctx context.Context, item Channel) error {
	input, err := json.Marshal(item.Input)
	if err != nil {
		return fmt.Errorf("encode channel input: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO channels (
			id, name, path, enabled, automatic_preview, input_json, max_readers,
			use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, item.Name, item.Path, item.Enabled, item.AutomaticPreview, string(input), item.MaxReaders,
		item.UseAbsoluteTimestamp, item.ApplyState, item.ApplyError,
		item.CreatedAt.Format(time.RFC3339Nano), item.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("create channel: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Update(ctx context.Context, item Channel) error {
	input, err := json.Marshal(item.Input)
	if err != nil {
		return fmt.Errorf("encode channel input: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE channels SET
			name = ?, enabled = ?, automatic_preview = ?, input_json = ?, max_readers = ?,
			use_absolute_timestamp = ?, apply_state = ?, apply_error = ?, updated_at = ?
		WHERE id = ?`,
		item.Name, item.Enabled, item.AutomaticPreview, string(input), item.MaxReaders,
		item.UseAbsoluteTimestamp, item.ApplyState, item.ApplyError,
		item.UpdatedAt.Format(time.RFC3339Nano), item.ID)
	if err != nil {
		return fmt.Errorf("update channel: %w", err)
	}
	return requireChanged(result)
}

func (s *SQLiteStore) Delete(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete channel: %w", err)
	}
	return requireChanged(result)
}

func (s *SQLiteStore) SetApplyResult(ctx context.Context, id string, state ApplyState, applyError string) error {
	result, err := s.db.ExecContext(ctx,
		`UPDATE channels SET apply_state = ?, apply_error = ? WHERE id = ?`,
		state, applyError, id)
	if err != nil {
		return fmt.Errorf("set channel apply result: %w", err)
	}
	return requireChanged(result)
}

type scanner interface {
	Scan(...any) error
}

func scanChannel(row scanner) (Channel, error) {
	var item Channel
	var enabled bool
	var automaticPreview bool
	var useAbsoluteTimestamp bool
	var inputJSON string
	var createdAt string
	var updatedAt string
	if err := row.Scan(
		&item.ID, &item.Name, &item.Path, &enabled, &automaticPreview, &inputJSON, &item.MaxReaders,
		&useAbsoluteTimestamp, &item.ApplyState, &item.ApplyError, &createdAt, &updatedAt,
	); err != nil {
		return Channel{}, err
	}
	item.Enabled = enabled
	item.AutomaticPreview = automaticPreview
	item.UseAbsoluteTimestamp = useAbsoluteTimestamp
	if err := json.Unmarshal([]byte(inputJSON), &item.Input); err != nil {
		return Channel{}, fmt.Errorf("decode channel input: %w", err)
	}
	var err error
	item.CreatedAt, err = time.Parse(time.RFC3339Nano, createdAt)
	if err != nil {
		return Channel{}, fmt.Errorf("decode channel created time: %w", err)
	}
	item.UpdatedAt, err = time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		return Channel{}, fmt.Errorf("decode channel updated time: %w", err)
	}
	return item, nil
}

func requireChanged(result sql.Result) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read affected rows: %w", err)
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}
