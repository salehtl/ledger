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
	// Runs after SeedDefaultCategories so it covers both shapes of "no colour
	// yet": rows a migration inherited from a pre-color database, and rows
	// SeedDefaultCategories just inserted on a brand-new one (schema.sql has
	// the column from the start, but the seed INSERT never sets it).
	if err := st.BackfillCategoryColors(); err != nil {
		db.Close()
		return nil, fmt.Errorf("backfill category colors: %w", err)
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
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_tx_project ON transactions(project_id)`); err != nil {
		return err
	}
	// v3: budget vs tracking accounts — tracking (investments, property) counts
	// in net worth only, never in envelopes.
	if err := addColumnIfMissing(db, "accounts", "kind", "TEXT NOT NULL DEFAULT 'budget'"); err != nil {
		return err
	}
	// v3: user memo on a transaction, distinct from the parsed description.
	if err := addColumnIfMissing(db, "transactions", "note", "TEXT"); err != nil {
		return err
	}
	// v3: merchant clean-name piggybacks the rules engine — a rule with a
	// display_name renames every past and future match in transaction listings.
	if err := addColumnIfMissing(db, "rules", "display_name", "TEXT"); err != nil {
		return err
	}
	// v3: notification preferences — budget-threshold pushes on/off and how many
	// days ahead upcoming-bill pushes fire (0 = off).
	if err := addColumnIfMissing(db, "app_settings", "notify_thresholds", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "app_settings", "notify_upcoming_days", "INTEGER NOT NULL DEFAULT 3"); err != nil {
		return err
	}
	// v3: detector provenance for proposed schedules (count, avg interval, last
	// amounts, matched tx ids as JSON). In the CREATE TABLE for fresh databases;
	// guarded here for databases created before the column existed.
	if err := addColumnIfMissing(db, "scheduled_transactions", "provenance", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	// Per-category colour, a palette name (see lib/paletteColor.ts). In the
	// CREATE TABLE for fresh databases; guarded here for databases created
	// before the column existed. Nullable — NULL means "never chosen" and the
	// frontend resolves it to the neutral, so no backfill is required for
	// correctness here; Open runs BackfillCategoryColors separately so
	// existing categories get a starting colour instead of staying neutral.
	if err := addColumnIfMissing(db, "categories", "color", "TEXT"); err != nil {
		return err
	}
	if err := migrateTargetsToVersioned(db); err != nil {
		return err
	}
	return nil
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

// columnExists reports whether table already has column.
func columnExists(db *sql.DB, table, column string) (bool, error) {
	var n int
	err := db.QueryRow(
		`SELECT count(*) FROM pragma_table_info(?) WHERE name=?`, table, column).Scan(&n)
	return n > 0, err
}

// migrateTargetsToVersioned converts the pre-versioning category_targets (one
// row per category, category_id as PRIMARY KEY) into effective-dated version
// rows. A PRIMARY KEY cannot be widened in place, so this rebuilds the table.
//
// Existing rows land at '0000-01' — before every real month — which preserves
// exactly the old semantics: the target applied to all of history.
//
// No-op once the column exists, so it is safe on every start.
func migrateTargetsToVersioned(db *sql.DB) error {
	has, err := columnExists(db, "category_targets", "effective_month")
	if err != nil || has {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`CREATE TABLE category_targets_new (
		  id              INTEGER PRIMARY KEY,
		  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
		  effective_month TEXT NOT NULL,
		  target_type     TEXT NOT NULL,
		  amount_fils     INTEGER NOT NULL,
		  cadence         TEXT NOT NULL DEFAULT 'monthly',
		  due_date        TEXT,
		  created_at      TEXT NOT NULL,
		  updated_at      TEXT NOT NULL
		)`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO category_targets_new
		  (category_id, effective_month, target_type, amount_fils, cadence, due_date, created_at, updated_at)
		SELECT category_id, '0000-01', target_type, amount_fils, cadence, due_date, created_at, updated_at
		FROM category_targets`); err != nil {
		return err
	}
	if _, err := tx.Exec(`DROP TABLE category_targets`); err != nil {
		return err
	}
	if _, err := tx.Exec(`ALTER TABLE category_targets_new RENAME TO category_targets`); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_target_cat_month ON category_targets(category_id, effective_month)`); err != nil {
		return err
	}
	return tx.Commit()
}
