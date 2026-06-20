// Package store owns the SQLite database: opening it, applying the schema
// idempotently on startup, and exposing the connection to the rest of the app.
package store

import (
	"database/sql"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go driver, registered as "sqlite"
)

//go:embed schema.sql
var schemaSQL string

// Store wraps the application's single SQLite connection pool.
type Store struct {
	DB *sql.DB
}

// Open opens (creating if needed) dataDir/ledger.db, sets pragmas, and applies
// the schema idempotently. The data directory is created 0700 if absent.
func Open(dataDir string) (*Store, error) {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir %q: %w", dataDir, err)
	}
	dsn := filepath.Join(dataDir, "ledger.db")
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// WAL improves concurrent read/write; foreign keys enforce the schema's refs.
	if _, err := db.Exec("PRAGMA journal_mode=WAL;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set journal_mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON;"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set foreign_keys: %w", err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	st := &Store{DB: db}
	if err := st.SeedDefaultCategories(); err != nil {
		db.Close()
		return nil, fmt.Errorf("seed categories: %w", err)
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
	return addColumnIfMissing(db, "transactions", "archived_from", "TEXT")
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
