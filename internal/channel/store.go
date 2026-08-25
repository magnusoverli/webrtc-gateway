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
	GetByNumber(context.Context, int) (Channel, error)
	Create(context.Context, Channel) error
	Update(context.Context, Channel, int) error
	UpdateAutomaticPreview(context.Context, string, bool, time.Time, int) error
	Delete(context.Context, string, int) error
	SetApplyResult(context.Context, string, int, ApplyState, string) error
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
			revision INTEGER NOT NULL DEFAULT 1,
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
	if err := s.addChannelNumberColumn(ctx); err != nil {
		return err
	}
	if err := s.addRevisionColumn(ctx); err != nil {
		return err
	}
	return nil
}

func (s *SQLiteStore) addRevisionColumn(ctx context.Context) error {
	exists, err := s.channelColumnExists(ctx, "revision")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE channels ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`); err != nil {
		return fmt.Errorf("add channel revision: %w", err)
	}
	return nil
}

func (s *SQLiteStore) addAutomaticPreviewColumn(ctx context.Context) error {
	exists, err := s.channelColumnExists(ctx, "automatic_preview")
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE channels ADD COLUMN automatic_preview INTEGER NOT NULL DEFAULT 1`); err != nil {
		return fmt.Errorf("add channel automatic preview setting: %w", err)
	}
	return nil
}

func (s *SQLiteStore) addChannelNumberColumn(ctx context.Context) error {
	exists, err := s.channelColumnExists(ctx, "channel_number")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE channels ADD COLUMN channel_number INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("add channel number: %w", err)
		}
	}

	rows, err := s.db.QueryContext(ctx, `SELECT id, channel_number FROM channels ORDER BY created_at, id`)
	if err != nil {
		return fmt.Errorf("list channel numbers: %w", err)
	}
	type numberedChannel struct {
		id     string
		number int
	}
	items := make([]numberedChannel, 0)
	used := make(map[int]bool)
	for rows.Next() {
		var item numberedChannel
		if err := rows.Scan(&item.id, &item.number); err != nil {
			rows.Close()
			return fmt.Errorf("scan channel number: %w", err)
		}
		if item.number > 0 {
			used[item.number] = true
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("list channel numbers: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close channel number rows: %w", err)
	}
	for _, item := range items {
		if item.number > 0 {
			continue
		}
		number := firstAvailableNumber(used)
		if _, err := s.db.ExecContext(ctx, `UPDATE channels SET channel_number = ? WHERE id = ?`, number, item.id); err != nil {
			return fmt.Errorf("backfill channel number: %w", err)
		}
		used[number] = true
	}
	if _, err := s.db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS channels_channel_number_unique ON channels(channel_number)`); err != nil {
		return fmt.Errorf("index channel number: %w", err)
	}
	return nil
}

func (s *SQLiteStore) channelColumnExists(ctx context.Context, column string) (bool, error) {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(channels)`)
	if err != nil {
		return false, fmt.Errorf("inspect channel schema: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, notNull, primaryKey int
		var name, kind string
		var defaultValue sql.NullString
		if err := rows.Scan(&id, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, fmt.Errorf("inspect channel column: %w", err)
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("inspect channel schema: %w", err)
	}
	return false, nil
}

func (s *SQLiteStore) List(ctx context.Context) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, revision, channel_number, name, path, enabled, automatic_preview, input_json, max_readers,
		       use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		FROM channels ORDER BY channel_number`)
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
		SELECT id, revision, channel_number, name, path, enabled, automatic_preview, input_json, max_readers,
		       use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		FROM channels WHERE id = ?`, id)
	item, err := scanChannel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return item, err
}

func (s *SQLiteStore) GetByNumber(ctx context.Context, number int) (Channel, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, revision, channel_number, name, path, enabled, automatic_preview, input_json, max_readers,
		       use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		FROM channels WHERE channel_number = ?`, number)
	item, err := scanChannel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Channel{}, ErrNotFound
	}
	return item, err
}

func (s *SQLiteStore) Create(ctx context.Context, item Channel) error {
	if item.Number < 1 {
		return fmt.Errorf("create channel: channel number must be positive")
	}
	if item.Revision < 1 {
		return fmt.Errorf("create channel: revision must be positive")
	}
	input, err := json.Marshal(item.Input)
	if err != nil {
		return fmt.Errorf("encode channel input: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO channels (
			id, revision, channel_number, name, path, enabled, automatic_preview, input_json, max_readers,
			use_absolute_timestamp, apply_state, apply_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		item.ID, item.Revision, item.Number, item.Name, item.Path, item.Enabled, item.AutomaticPreview, string(input), item.MaxReaders,
		item.UseAbsoluteTimestamp, item.ApplyState, item.ApplyError,
		item.CreatedAt.Format(time.RFC3339Nano), item.UpdatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("create channel: %w", err)
	}
	return nil
}

func (s *SQLiteStore) Update(ctx context.Context, item Channel, expectedRevision int) error {
	input, err := json.Marshal(item.Input)
	if err != nil {
		return fmt.Errorf("encode channel input: %w", err)
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE channels SET
			revision = ?, name = ?, enabled = ?, automatic_preview = ?, input_json = ?, max_readers = ?,
			use_absolute_timestamp = ?, apply_state = ?, apply_error = ?, updated_at = ?
		WHERE id = ? AND revision = ?`,
		item.Revision, item.Name, item.Enabled, item.AutomaticPreview, string(input), item.MaxReaders,
		item.UseAbsoluteTimestamp, item.ApplyState, item.ApplyError,
		item.UpdatedAt.Format(time.RFC3339Nano), item.ID, expectedRevision)
	if err != nil {
		return fmt.Errorf("update channel: %w", err)
	}
	return s.requireChannelCAS(ctx, result, item.ID)
}

func (s *SQLiteStore) UpdateAutomaticPreview(ctx context.Context, id string, automaticPreview bool, updatedAt time.Time, expectedRevision int) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE channels SET automatic_preview = ?, updated_at = ?, revision = revision + 1
		WHERE id = ? AND revision = ?`, automaticPreview, updatedAt.Format(time.RFC3339Nano), id, expectedRevision)
	if err != nil {
		return fmt.Errorf("update channel automatic preview: %w", err)
	}
	return s.requireChannelCAS(ctx, result, id)
}

func (s *SQLiteStore) Delete(ctx context.Context, id string, expectedRevision int) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM channels WHERE id = ? AND revision = ?`, id, expectedRevision)
	if err != nil {
		return fmt.Errorf("delete channel: %w", err)
	}
	return s.requireChannelCAS(ctx, result, id)
}

func (s *SQLiteStore) SetApplyResult(ctx context.Context, id string, revision int, state ApplyState, applyError string) error {
	result, err := s.db.ExecContext(ctx,
		`UPDATE channels SET apply_state = ?, apply_error = ? WHERE id = ? AND revision = ?`,
		state, applyError, id, revision)
	if err != nil {
		return fmt.Errorf("set channel apply result: %w", err)
	}
	return s.requireChannelCAS(ctx, result, id)
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
		&item.ID, &item.Revision, &item.Number, &item.Name, &item.Path, &enabled, &automaticPreview, &inputJSON, &item.MaxReaders,
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

func firstAvailableNumber(used map[int]bool) int {
	for number := 1; ; number++ {
		if !used[number] {
			return number
		}
	}
}

func (s *SQLiteStore) requireChannelCAS(ctx context.Context, result sql.Result, id string) error {
	count, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read affected rows: %w", err)
	}
	if count == 0 {
		var exists int
		if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM channels WHERE id = ?`, id).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("check channel revision: %w", err)
		}
		return ErrRevisionConflict
	}
	return nil
}
