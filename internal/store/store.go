// Package store owns the SQLite database: opening it, applying the schema
// idempotently on startup, and exposing the connection to the rest of the app.
package store

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver, registered as "sqlite"
)

//go:embed schema.sql
var schemaSQL string

// Store wraps the application's single SQLite connection pool.
type Store struct {
	DB  *sql.DB
	now func() int64
}

// SetNow overrides the clock used for usage timestamps and cap windows (tests only).
func (s *Store) SetNow(fn func() int64) { s.now = fn }

// Open opens (creating if needed) dataDir/ledger.db, sets pragmas, and applies
// the schema idempotently. The data directory is created 0700 if absent.
func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir %q: %w", dataDir, err)
	}
	// These pragmas ride on the DSN so every pooled connection gets them —
	// a PRAGMA via db.Exec only reaches the one connection that runs it.
	// busy_timeout: a second concurrent writer waits instead of failing with
	// SQLITE_BUSY. synchronous(NORMAL): crash-safe under WAL at roughly half
	// the fsync cost of the FULL default. foreign_keys: enforced everywhere,
	// not just on whichever connection ran a one-shot Exec.
	dsn := filepath.Join(dataDir, "ledger.db") +
		"?_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// WAL improves concurrent read/write; foreign keys are now set on the DSN.
	if _, err := db.Exec("PRAGMA journal_mode=WAL;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set journal_mode: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	st := &Store{DB: db, now: func() int64 { return time.Now().Unix() }}
	if err := st.SeedDefaultCategories(); err != nil {
		db.Close()
		return nil, fmt.Errorf("seed categories: %w", err)
	}
	if err := st.seedFXRates(); err != nil {
		db.Close()
		return nil, fmt.Errorf("seed fx rates: %w", err)
	}
	if _, err := st.ConvertUnconverted(); err != nil {
		db.Close()
		return nil, fmt.Errorf("backfill amount_aed: %w", err)
	}
	return st, nil
}

// Close releases the connection pool.
func (s *Store) Close() error { return s.DB.Close() }

// Ping verifies the database is reachable (used by /api/health).
func (s *Store) Ping() error { return s.DB.Ping() }

// migrate applies idempotent column additions that CREATE TABLE IF NOT EXISTS
// cannot perform on pre-existing tables.
func migrate(db *sql.DB) error {
	if err := addColumnIfMissing(db, "rules", "is_active", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "transactions", "archived_from", "TEXT"); err != nil {
		return err
	}
	// AED snapshot of amount; NULL when the currency has no fx rate yet.
	if err := addColumnIfMissing(db, "transactions", "amount_aed", "INTEGER"); err != nil {
		return err
	}
	// Refund linking: a credit that refunds an earlier purchase points at it.
	if err := addColumnIfMissing(db, "transactions", "refund_of_id", "INTEGER REFERENCES transactions(id)"); err != nil {
		return err
	}
	// Days of mailbox silence before /api/health reports mail_silent.
	if err := addColumnIfMissing(db, "app_settings", "ingest_silence_days", "INTEGER NOT NULL DEFAULT 3"); err != nil {
		return err
	}
	// Account last-4 captured at parse time; used by self-transfer matching.
	if err := addColumnIfMissing(db, "transactions", "last4", "TEXT"); err != nil {
		return err
	}
	// Monthly AI spend cap in micro-USD (0 = disabled) and whether the cap has
	// already latched AI off (cleared when the user re-enables AI).
	if err := addColumnIfMissing(db, "app_settings", "ai_spend_cap_musd", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "app_settings", "ai_cap_latched", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	// Automatic parse retries are capped; the periodic ingest hook skips rows
	// whose budget is spent. Manual reprocess ignores the cap.
	if err := addColumnIfMissing(db, "ingest_log", "parse_attempts", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	// project_id links a transaction to a temporary life-project (projects
	// table); the index is created here, not in schema.sql, since the column
	// doesn't exist yet when schema.sql first runs on a pre-existing DB.
	if err := addColumnIfMissing(db, "transactions", "project_id", "INTEGER REFERENCES projects(id)"); err != nil {
		return err
	}
	_, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_tx_project ON transactions(project_id)`)
	return err
}

func addColumnIfMissing(db *sql.DB, table, column, ddl string) error {
	var n int
	if err := db.QueryRow(
		`SELECT count(*) FROM pragma_table_info(?) WHERE name=?`, table, column,
	).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := db.Exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + ddl)
	return err
}
