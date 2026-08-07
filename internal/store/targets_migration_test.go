package store

import (
	"database/sql"
	"testing"
)

// openRaw opens a bare DB in a temp dir without running schema/migrations, so
// a test can plant the OLD table shape and then prove the migration converts it.
func openRaw(t *testing.T, dir string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", dir+"/ledger.db?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestMigrateTargets_ConvertsOldSingleRowTable(t *testing.T) {
	dir := t.TempDir()
	db := openRaw(t, dir)

	// The pre-versioning shape, verbatim from the old schema.sql.
	if _, err := db.Exec(`
		CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
		INSERT INTO categories (id, name) VALUES (3, 'Groceries');
		CREATE TABLE category_targets (
		  category_id INTEGER PRIMARY KEY,
		  target_type TEXT NOT NULL,
		  amount_fils INTEGER NOT NULL,
		  cadence     TEXT NOT NULL DEFAULT 'monthly',
		  due_date    TEXT,
		  created_at  TEXT NOT NULL,
		  updated_at  TEXT NOT NULL
		);
		INSERT INTO category_targets VALUES (3,'set_aside',150000,'monthly',NULL,'t0','t0');`); err != nil {
		t.Fatal(err)
	}

	if err := migrateTargetsToVersioned(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	var month string
	var amount int64
	if err := db.QueryRow(
		`SELECT effective_month, amount_fils FROM category_targets WHERE category_id=3`,
	).Scan(&month, &amount); err != nil {
		t.Fatalf("existing target did not survive: %v", err)
	}
	// '0000-01' sorts before every real month, so a migrated target keeps
	// applying to all history exactly as it did before versioning.
	if month != "0000-01" {
		t.Errorf("effective_month = %q, want %q", month, "0000-01")
	}
	if amount != 150000 {
		t.Errorf("amount_fils = %d, want 150000", amount)
	}
}

func TestMigrateTargets_IsIdempotent(t *testing.T) {
	dir := t.TempDir()
	db := openRaw(t, dir)
	if _, err := db.Exec(`
		CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT);
		INSERT INTO categories (id, name) VALUES (3, 'Groceries');
		CREATE TABLE category_targets (
		  category_id INTEGER PRIMARY KEY, target_type TEXT NOT NULL,
		  amount_fils INTEGER NOT NULL, cadence TEXT NOT NULL DEFAULT 'monthly',
		  due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
		INSERT INTO category_targets VALUES (3,'set_aside',150000,'monthly',NULL,'t0','t0');`); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := migrateTargetsToVersioned(db); err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM category_targets`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("rows = %d after 3 migrations, want 1", n)
	}
}

// A fresh DB gets the versioned shape from schema.sql, so the migration must
// find nothing to do and must not destroy the table.
func TestMigrateTargets_FreshDBKeepsVersionedShape(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.DB.Exec(
		`INSERT INTO category_targets (category_id, effective_month, target_type, amount_fils, cadence, created_at, updated_at)
		 VALUES (1,'2026-08','set_aside',1000,'monthly','t','t')`); err != nil {
		t.Fatalf("versioned insert failed on a fresh DB: %v", err)
	}
	if err := migrateTargetsToVersioned(st.DB); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := st.DB.QueryRow(`SELECT count(*) FROM category_targets`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("rows = %d, want 1 (migration clobbered a versioned table)", n)
	}
}

// TestOpen_OnPreVersioningDatabase drives the REAL startup path — store.Open
// against a database that still has the pre-versioning category_targets shape,
// which is what every deployed instance looks like. The other tests here call
// migrateTargetsToVersioned directly, so they cannot see failures that happen
// in Open *before* migrate() runs: schema.sql is applied first, and any
// statement in it that touches effective_month executes against the OLD table
// and errors with "no such column", crash-looping the service on start. Hence
// the uniqueness index is created in migrate(), after the conversion.
func TestOpen_OnPreVersioningDatabase(t *testing.T) {
	dir := t.TempDir()

	// Build a realistic current database, then regress category_targets to the
	// old one-row-per-category shape with a real target in it.
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("initial Open: %v", err)
	}
	var catID int64
	if err := st.DB.QueryRow(`SELECT id FROM categories ORDER BY id LIMIT 1`).Scan(&catID); err != nil {
		t.Fatalf("no seeded category: %v", err)
	}
	if _, err := st.DB.Exec(`
		DROP TABLE category_targets;
		CREATE TABLE category_targets (
		  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
		  target_type TEXT NOT NULL,
		  amount_fils INTEGER NOT NULL,
		  cadence     TEXT NOT NULL DEFAULT 'monthly',
		  due_date    TEXT,
		  created_at  TEXT NOT NULL,
		  updated_at  TEXT NOT NULL
		);`); err != nil {
		t.Fatalf("plant old shape: %v", err)
	}
	if _, err := st.DB.Exec(
		`INSERT INTO category_targets VALUES (?,'set_aside',150000,'monthly',NULL,'t0','t0')`, catID); err != nil {
		t.Fatalf("plant old row: %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	// The startup that would crash-loop production.
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("Open on a pre-versioning database must succeed, got: %v", err)
	}
	t.Cleanup(func() { st2.Close() })

	// The existing target survived, at the sentinel month that predates every
	// real month...
	var month string
	if err := st2.DB.QueryRow(
		`SELECT effective_month FROM category_targets WHERE category_id=?`, catID).Scan(&month); err != nil {
		t.Fatalf("existing target did not survive Open: %v", err)
	}
	if month != "0000-01" {
		t.Errorf("effective_month = %q, want %q", month, "0000-01")
	}

	// ...so it still resolves for a present-day month.
	got, ok, err := st2.SelectCategoryTargetForMonth(catID, "2026-08")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !ok {
		t.Fatal("migrated target does not resolve for 2026-08")
	}
	if got.AmountFils != 150000 {
		t.Errorf("amount_fils = %d, want 150000", got.AmountFils)
	}

	// And the uniqueness index migrate() creates is really there.
	ins := func() error {
		_, err := st2.DB.Exec(
			`INSERT INTO category_targets (category_id, effective_month, target_type, amount_fils, cadence, created_at, updated_at)
			 VALUES (?,'0000-01','set_aside',1,'monthly','t','t')`, catID)
		return err
	}
	if err := ins(); err == nil {
		t.Error("duplicate (category, month) accepted after Open; idx_target_cat_month missing")
	}
}

func TestMigrateTargets_UniquePerCategoryMonth(t *testing.T) {
	st := newTestStore(t)
	ins := func(month string) error {
		_, err := st.DB.Exec(
			`INSERT INTO category_targets (category_id, effective_month, target_type, amount_fils, cadence, created_at, updated_at)
			 VALUES (1,?,'set_aside',1000,'monthly','t','t')`, month)
		return err
	}
	if err := ins("2026-08"); err != nil {
		t.Fatal(err)
	}
	if err := ins("2026-08"); err == nil {
		t.Error("second row for the same (category, month) was accepted; unique index missing")
	}
	if err := ins("2026-09"); err != nil {
		t.Errorf("a different month must be allowed: %v", err)
	}
}
