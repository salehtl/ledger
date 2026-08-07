# Effective-dated Category Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a category target carry forward implicitly to later months, while editing it in month M affects M onward and never any month before M.

**Architecture:** `category_targets` stops being one row per category and becomes **version rows** keyed `(category_id, effective_month)`. Resolving a target for month M means taking the row with the greatest `effective_month <= M`. Removal writes a **tombstone** version (`target_type='none'`) rather than deleting, so an earlier version cannot resurrect. A one-shot guarded rebuild in `store.migrate` converts the old single-row table.

**Tech Stack:** Go 1.22+ (stdlib `net/http` routing, `modernc.org/sqlite`, no cgo), React 19 + TypeScript + Vite, TanStack Query, vitest, Tailwind v4.

Spec: `docs/superpowers/specs/2026-08-07-effective-dated-targets-design.md`

## Global Constraints

- Money is always `int64` minor units (AED fils). Never floats.
- Months are always the string `'YYYY-MM'`. `store.validMonth(month)` (in `internal/store/envelopes.go:25`) is the validator — reuse it, do not write another.
- The sentinel effective month for migrated rows is exactly `'0000-01'` — sorts before every real month, so a migrated target applies to all history.
- The tombstone target type is exactly `'none'`. It is never returned to a caller; resolution filters it out.
- Schema changes go in `internal/store/schema.sql` (`CREATE TABLE IF NOT EXISTS`) plus `internal/store/store.go`'s `migrate(db *sql.DB) error`. There is no migration tool.
- Go tests live beside the code as `*_test.go`. Frontend tests are `*.test.ts(x)` beside the component.
- Run `gofmt -w` on every Go file you touch. Two files are already gofmt-dirty on `main` (`internal/server/rates_test.go`, `internal/ingest/ingest.go`) — do not "fix" them, they are unrelated.
- Do not run `bunx tsc`; it downloads a different TypeScript. Use `./node_modules/.bin/tsc -b --noEmit` from `frontend/`.
- Frontend vitest is pinned single-fork on purpose (`vite.config.ts`). Do not change it.
- **Work in `/root/Coding/ledger/.claude/worktrees/effective-dated-targets` on branch `worktree-effective-dated-targets`.** Your shell may start in the main checkout `/root/Coding/ledger` — `cd` to the worktree first. Confirm with `pwd && git branch --show-current` before your first edit; if the branch is `main` you are in the wrong tree and must `cd` before touching anything.
- Do not deploy, do not restart the `ledger` service, do not touch `/var/lib/ledger/ledger.db`. The orchestrator handles deployment.

---

### Task 1: Versioned targets schema + migration

**Files:**
- Modify: `internal/store/schema.sql` (the `category_targets` block, currently at lines 170–180)
- Modify: `internal/store/store.go` (add a call inside `migrate`, add one helper)
- Test: `internal/store/targets_migration_test.go` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a `category_targets` table with columns `id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, effective_month TEXT NOT NULL, target_type TEXT NOT NULL, amount_fils INTEGER NOT NULL, cadence TEXT NOT NULL DEFAULT 'monthly', due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL` and a unique index `idx_target_cat_month` on `(category_id, effective_month)`. Also produces `func columnExists(db *sql.DB, table, column string) (bool, error)` in `internal/store/store.go`.

- [ ] **Step 1: Write the failing test**

Create `internal/store/targets_migration_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run TestMigrateTargets 2>&1 | tail -20`
Expected: FAIL, build error `undefined: migrateTargetsToVersioned`.

- [ ] **Step 3: Update the schema to the versioned shape**

In `internal/store/schema.sql`, replace the whole `category_targets` block (the comment line `-- v3: per-category budgeting target (envelope depth). One target per category.` plus its `CREATE TABLE`) with:

```sql
-- v3: per-category budgeting target (envelope depth), effective-dated. A row
-- applies from effective_month onward until a later row supersedes it, so a
-- target set once carries forward and an edit made in month M never changes
-- any month before M. target_type 'none' is a tombstone meaning "no target
-- from this month on" — removal writes one of these instead of deleting,
-- because deleting would let the previous version resurrect.
CREATE TABLE IF NOT EXISTS category_targets (
  id              INTEGER PRIMARY KEY,
  category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  effective_month TEXT NOT NULL,                -- 'YYYY-MM'
  target_type     TEXT NOT NULL,                -- 'set_aside'|'refill'|'save_by_date'|'none'
  amount_fils     INTEGER NOT NULL,             -- AED fils; 0 for a tombstone
  cadence         TEXT NOT NULL DEFAULT 'monthly',
  due_date        TEXT,                         -- 'YYYY-MM-DD'; save_by_date only
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_target_cat_month ON category_targets(category_id, effective_month);
```

- [ ] **Step 4: Write the migration**

In `internal/store/store.go`, add next to `addColumnIfMissing`:

```go
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
```

Then call it inside `migrate(db *sql.DB) error`, as the last statement before its final `return nil`:

```go
	if err := migrateTargetsToVersioned(db); err != nil {
		return err
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && gofmt -w internal/store/ && go test ./internal/store/ -run TestMigrateTargets -v 2>&1 | tail -20`
Expected: all four PASS.

- [ ] **Step 6: Run the whole store package**

Run: `cd /root/Coding/ledger && go test ./internal/store/ 2>&1 | tail -20`
Expected: `ok`. If existing target tests fail, that is expected — they are rewritten in Task 2. Note which ones and leave them; do not delete them.

- [ ] **Step 7: Commit**

```bash
cd /root/Coding/ledger
git add internal/store/schema.sql internal/store/store.go internal/store/targets_migration_test.go
git commit -m "feat(store): version category targets by effective month

A PRIMARY KEY on category_id cannot hold two months per category, so this
rebuilds the table. Existing rows land at '0000-01' — before every real
month — preserving exactly the old always-applied semantics.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Month-resolved target reads and writes

**Files:**
- Modify: `internal/store/targets.go` (whole file)
- Test: `internal/store/targets_test.go` (exists — update it)

**Interfaces:**
- Consumes: the versioned `category_targets` table from Task 1; `validMonth(month string) bool` from `internal/store/envelopes.go:25`.
- Produces, all on `*Store`:
  - `UpsertCategoryTarget(t CategoryTargetRow) error` — `CategoryTargetRow` gains field `EffectiveMonth string`. Writes/overwrites the version at that month.
  - `SelectCategoryTargetsForMonth(month string) ([]CategoryTargetRow, error)` — resolved live targets for `month`, category order, tombstones excluded.
  - `SelectCategoryTargetForMonth(categoryID int64, month string) (CategoryTargetRow, bool, error)` — resolved single; `ok=false` when none or tombstoned.
  - `DeleteCategoryTarget(categoryID int64, month string) error` — writes a tombstone at `month`.
  - `ErrTargetInvalid` keeps its current meaning and now also covers a bad month.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/targets_test.go` (keep the existing tests; adapt any that call the old signatures by adding `EffectiveMonth: "2026-01"` and passing a month to `DeleteCategoryTarget`). The new tests use `errors.Is`, so ensure the file imports `"errors"`. `seedCat`, `putTarget` and `resolved` defined here are reused by Task 3's test in the same package — do not rename them.

```go
// seedCat inserts a category and returns its id.
func seedCat(t *testing.T, st *Store, name string) int64 {
	t.Helper()
	res, err := st.DB.Exec(`INSERT INTO categories (name, kind, bucket) VALUES (?, 'spending', 'need')`, name)
	if err != nil {
		t.Fatal(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func putTarget(t *testing.T, st *Store, cat int64, month string, amount int64) {
	t.Helper()
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: cat, EffectiveMonth: month, TargetType: "set_aside",
		AmountFils: amount, Cadence: "monthly",
	}); err != nil {
		t.Fatalf("upsert %s: %v", month, err)
	}
}

func resolved(t *testing.T, st *Store, cat int64, month string) (int64, bool) {
	t.Helper()
	row, ok, err := st.SelectCategoryTargetForMonth(cat, month)
	if err != nil {
		t.Fatal(err)
	}
	return row.AmountFils, ok
}

// The whole point of the feature: a target set once keeps applying to later
// months without being restated.
func TestTargetForMonth_CarriesForwardImplicitly(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-03", 150000)

	for _, m := range []string{"2026-03", "2026-04", "2026-09", "2027-01"} {
		amount, ok := resolved(t, st, cat, m)
		if !ok || amount != 150000 {
			t.Errorf("%s: got (%d, %v), want (150000, true)", m, amount, ok)
		}
	}
}

// Months before the first version have no target at all.
func TestTargetForMonth_NotRetroactiveBeforeFirstVersion(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-03", 150000)

	if _, ok := resolved(t, st, cat, "2026-02"); ok {
		t.Error("2026-02 resolved a target set from 2026-03")
	}
}

// The property the feature exists for: editing in August must not touch July.
func TestTargetForMonth_EditIsScopedForward(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-07", 150000)
	putTarget(t, st, cat, "2026-08", 200000)

	for _, tc := range []struct {
		month string
		want  int64
	}{
		{"2026-07", 150000}, // frozen
		{"2026-08", 200000},
		{"2026-12", 200000}, // carries forward from the edit
	} {
		amount, ok := resolved(t, st, cat, tc.month)
		if !ok || amount != tc.want {
			t.Errorf("%s: got (%d, %v), want (%d, true)", tc.month, amount, ok, tc.want)
		}
	}
}

// Re-editing the same month overwrites that version rather than stacking.
func TestTargetForMonth_SameMonthOverwrites(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-08", 200000)
	putTarget(t, st, cat, "2026-08", 250000)

	amount, ok := resolved(t, st, cat, "2026-08")
	if !ok || amount != 250000 {
		t.Errorf("got (%d, %v), want (250000, true)", amount, ok)
	}
	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM category_targets WHERE category_id=? AND effective_month='2026-08'`, cat).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("versions at 2026-08 = %d, want 1", n)
	}
}

// Removal must not let the previous version resurrect — that is what a plain
// DELETE would do, and it is the opposite of "remove".
func TestDeleteCategoryTarget_TombstonesForwardOnly(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-07", 150000)

	if err := st.DeleteCategoryTarget(cat, "2026-08"); err != nil {
		t.Fatal(err)
	}
	if amount, ok := resolved(t, st, cat, "2026-07"); !ok || amount != 150000 {
		t.Errorf("July: got (%d, %v), want (150000, true) — removal reached backwards", amount, ok)
	}
	if _, ok := resolved(t, st, cat, "2026-08"); ok {
		t.Error("August still resolves a target after removal")
	}
	if _, ok := resolved(t, st, cat, "2026-11"); ok {
		t.Error("November resolves a target: the tombstone did not carry forward")
	}
}

// Setting a target again after a removal wins from its own month.
func TestTargetForMonth_ReAddAfterTombstone(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-07", 150000)
	if err := st.DeleteCategoryTarget(cat, "2026-08"); err != nil {
		t.Fatal(err)
	}
	putTarget(t, st, cat, "2026-10", 300000)

	if _, ok := resolved(t, st, cat, "2026-09"); ok {
		t.Error("September should still be tombstoned")
	}
	if amount, ok := resolved(t, st, cat, "2026-10"); !ok || amount != 300000 {
		t.Errorf("October: got (%d, %v), want (300000, true)", amount, ok)
	}
}

func TestSelectCategoryTargetsForMonth_ExcludesTombstonesAndFuture(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Dining")
	c := seedCat(t, st, "Travel")
	putTarget(t, st, a, "2026-07", 150000)
	putTarget(t, st, b, "2026-07", 500000)
	if err := st.DeleteCategoryTarget(b, "2026-08"); err != nil {
		t.Fatal(err)
	}
	putTarget(t, st, c, "2026-09", 900000) // starts after the queried month

	rows, err := st.SelectCategoryTargetsForMonth("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (Groceries only); rows=%+v", len(rows), rows)
	}
	if rows[0].CategoryID != a || rows[0].AmountFils != 150000 {
		t.Errorf("row = %+v, want Groceries at 150000", rows[0])
	}
	for _, r := range rows {
		if r.TargetType == "none" {
			t.Error("a tombstone leaked into the resolved list")
		}
	}
}

func TestUpsertCategoryTarget_RejectsBadMonth(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	for _, m := range []string{"", "2026", "2026-13", "26-08", "2026-08-01"} {
		err := st.UpsertCategoryTarget(CategoryTargetRow{
			CategoryID: cat, EffectiveMonth: m, TargetType: "set_aside",
			AmountFils: 1000, Cadence: "monthly",
		})
		if !errors.Is(err, ErrTargetInvalid) {
			t.Errorf("month %q: err = %v, want ErrTargetInvalid", m, err)
		}
	}
}

// 'none' is internal. A caller must not be able to plant a tombstone through
// the normal write path and dodge amount validation.
func TestUpsertCategoryTarget_RejectsTombstoneType(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: cat, EffectiveMonth: "2026-08", TargetType: "none", AmountFils: 0,
	})
	if !errors.Is(err, ErrTargetInvalid) {
		t.Errorf("err = %v, want ErrTargetInvalid", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run 'TestTargetForMonth|TestDeleteCategoryTarget|TestSelectCategoryTargetsForMonth|TestUpsertCategoryTarget' 2>&1 | tail -20`
Expected: FAIL — build errors about `EffectiveMonth`, `SelectCategoryTargetForMonth`, and `DeleteCategoryTarget` arity.

- [ ] **Step 3: Rewrite `internal/store/targets.go`**

Replace the file contents with:

```go
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrTargetInvalid reports a category-target payload the store refuses to persist.
var ErrTargetInvalid = errors.New("invalid category target")

// tombstoneTarget marks "no target from this month on". Removal writes one of
// these instead of deleting the row, because deleting would let the previous
// version resurrect and apply forever — the opposite of removing. It is never
// returned to callers; resolution filters it out.
const tombstoneTarget = "none"

// CategoryTargetRow is one *version* of a category's budgeting target. It
// applies from EffectiveMonth ('YYYY-MM') onward until a later version
// supersedes it, so a target set once carries forward and an edit made in
// month M never changes any month before M. AmountFils is integer AED fils.
// DueDate ('YYYY-MM-DD') is set only for save_by_date targets.
type CategoryTargetRow struct {
	CategoryID     int64
	EffectiveMonth string // 'YYYY-MM'
	TargetType     string // 'set_aside' | 'refill' | 'save_by_date'
	AmountFils     int64
	Cadence        string // 'weekly' | 'monthly' | 'yearly'; defaults to 'monthly'
	DueDate        string // "" unless save_by_date
	CreatedAt      string
	UpdatedAt      string
}

func validateTarget(t *CategoryTargetRow) error {
	if t.CategoryID <= 0 {
		return fmt.Errorf("%w: category_id required", ErrTargetInvalid)
	}
	if !validMonth(t.EffectiveMonth) {
		return fmt.Errorf("%w: effective_month %q (want YYYY-MM)", ErrTargetInvalid, t.EffectiveMonth)
	}
	switch t.TargetType {
	case "set_aside", "refill", "save_by_date":
	default:
		// tombstoneTarget lands here too: it is internal, and letting a caller
		// write one through this path would dodge the amount check below.
		return fmt.Errorf("%w: target_type %q", ErrTargetInvalid, t.TargetType)
	}
	if t.AmountFils <= 0 {
		return fmt.Errorf("%w: amount_fils must be > 0", ErrTargetInvalid)
	}
	if t.Cadence == "" {
		t.Cadence = "monthly"
	}
	switch t.Cadence {
	case "weekly", "monthly", "yearly":
	default:
		return fmt.Errorf("%w: cadence %q", ErrTargetInvalid, t.Cadence)
	}
	if t.TargetType == "save_by_date" {
		if t.DueDate == "" {
			return fmt.Errorf("%w: save_by_date requires due_date", ErrTargetInvalid)
		}
		// Malformed dates must 400 here, not degrade later: the engine clamps
		// an unparseable due date to "due now", which would silently turn a
		// long-horizon goal into "entire remainder needed this month" and let
		// auto-assign drain RTA into it.
		if _, err := time.Parse("2006-01-02", t.DueDate); err != nil {
			return fmt.Errorf("%w: due_date %q (want YYYY-MM-DD)", ErrTargetInvalid, t.DueDate)
		}
	} else {
		// due_date exists iff save_by_date (contract §1); a stray value on a
		// set_aside/refill payload is dropped, never stored or echoed.
		t.DueDate = ""
	}
	return nil
}

// UpsertCategoryTarget writes the target version effective from t.EffectiveMonth,
// overwriting an existing version at exactly that month. Earlier months are
// untouched.
func (s *Store) UpsertCategoryTarget(t CategoryTargetRow) error {
	if err := validateTarget(&t); err != nil {
		return err
	}
	return s.writeTargetVersion(t)
}

// writeTargetVersion is the unvalidated insert shared by the normal write path
// and the tombstone path.
func (s *Store) writeTargetVersion(t CategoryTargetRow) error {
	now := isoNow(s)
	_, err := s.DB.Exec(
		`INSERT INTO category_targets
		   (category_id, effective_month, target_type, amount_fils, cadence, due_date, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(category_id, effective_month) DO UPDATE SET
		   target_type=excluded.target_type, amount_fils=excluded.amount_fils,
		   cadence=excluded.cadence, due_date=excluded.due_date, updated_at=excluded.updated_at`,
		t.CategoryID, t.EffectiveMonth, t.TargetType, t.AmountFils, t.Cadence,
		nullableStr(t.DueDate), now, now,
	)
	return err
}

const targetColumns = `category_id, effective_month, target_type, amount_fils, cadence, COALESCE(due_date,''), created_at, updated_at`

func scanTarget(sc interface{ Scan(...any) error }) (CategoryTargetRow, error) {
	var t CategoryTargetRow
	err := sc.Scan(&t.CategoryID, &t.EffectiveMonth, &t.TargetType, &t.AmountFils,
		&t.Cadence, &t.DueDate, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// resolveClause keeps only each category's newest version at or before the
// month, then drops tombstones. Both placeholders take the same month.
const resolveClause = `
	  FROM category_targets t
	 WHERE t.effective_month <= ?
	   AND t.effective_month = (SELECT MAX(x.effective_month) FROM category_targets x
	                             WHERE x.category_id = t.category_id
	                               AND x.effective_month <= ?)
	   AND t.target_type <> '` + tombstoneTarget + `'`

// SelectCategoryTargetsForMonth lists the targets in force during month
// ('YYYY-MM'), category order. A category whose newest version is a tombstone,
// or whose first version starts later, is absent.
func (s *Store) SelectCategoryTargetsForMonth(month string) ([]CategoryTargetRow, error) {
	if !validMonth(month) {
		return nil, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrTargetInvalid, month)
	}
	rows, err := s.DB.Query(
		`SELECT `+targetColumns+resolveClause+` ORDER BY t.category_id`, month, month)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CategoryTargetRow
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SelectCategoryTargetForMonth resolves one category's target for month;
// ok=false when it has none in force.
func (s *Store) SelectCategoryTargetForMonth(categoryID int64, month string) (CategoryTargetRow, bool, error) {
	if !validMonth(month) {
		return CategoryTargetRow{}, false, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrTargetInvalid, month)
	}
	t, err := scanTarget(s.DB.QueryRow(
		`SELECT `+targetColumns+resolveClause+` AND t.category_id = ?`, month, month, categoryID))
	if errors.Is(err, sql.ErrNoRows) {
		return t, false, nil
	}
	if err != nil {
		return t, false, err
	}
	return t, true, nil
}

// DeleteCategoryTarget stops the target from month onward by writing a
// tombstone version. Months before it keep whatever was in force.
func (s *Store) DeleteCategoryTarget(categoryID int64, month string) error {
	if categoryID <= 0 {
		return fmt.Errorf("%w: category_id required", ErrTargetInvalid)
	}
	if !validMonth(month) {
		return fmt.Errorf("%w: month %q (want YYYY-MM)", ErrTargetInvalid, month)
	}
	return s.writeTargetVersion(CategoryTargetRow{
		CategoryID: categoryID, EffectiveMonth: month,
		TargetType: tombstoneTarget, AmountFils: 0, Cadence: "monthly",
	})
}
```

- [ ] **Step 4: Fix the old tests that no longer compile**

`internal/store/targets_test.go` already has tests written against the old signatures. For each: add `EffectiveMonth: "2026-01"` to every `CategoryTargetRow` literal, and pass `"2026-01"` as the second argument to `DeleteCategoryTarget`. A test asserting that delete removes the row must now assert that the month resolves to no target — change `SelectCategoryTarget(id)` to `SelectCategoryTargetForMonth(id, "2026-01")`.

- [ ] **Step 5: Run the store package**

Run: `cd /root/Coding/ledger && gofmt -w internal/store/ && go test ./internal/store/ 2>&1 | tail -20`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger
git add internal/store/targets.go internal/store/targets_test.go
git commit -m "feat(store): resolve category targets by month, tombstone on remove

A target now carries forward from its effective month until superseded,
and removal writes a 'none' version rather than deleting — deleting would
let the previous version resurrect and apply forever.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Category usage count counts categories, not versions

**Files:**
- Modify: `internal/store/categories.go:602-605` (the `u.Targets` query)
- Test: `internal/store/categories_test.go` (append)

**Interfaces:**
- Consumes: the versioned table from Task 1; `UpsertCategoryTarget`/`DeleteCategoryTarget` from Task 2; and the `seedCat` test helper added by Task 2 in the same package (do not redefine it — the package will not compile twice).
- Produces: no new exported symbols. `CategoryUsage.Targets` keeps its meaning — 0 or 1, "does this category currently have a target".

- [ ] **Step 1: Write the failing test**

Append to `internal/store/categories_test.go`:

```go
// CategoryUsage.Targets answers "does this category have a target", used by the
// delete-category confirmation. With version rows a naive count(*) would report
// 3 for a category edited three times, and 1 for one whose target was removed.
func TestCategoryUsage_TargetsCountsCurrentNotVersions(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")

	u, err := st.CategoryUsage(cat)
	if err != nil {
		t.Fatal(err)
	}
	if u.Targets != 0 {
		t.Errorf("no target: Targets = %d, want 0", u.Targets)
	}

	for _, m := range []string{"2026-06", "2026-07", "2026-08"} {
		if err := st.UpsertCategoryTarget(CategoryTargetRow{
			CategoryID: cat, EffectiveMonth: m, TargetType: "set_aside",
			AmountFils: 1000, Cadence: "monthly",
		}); err != nil {
			t.Fatal(err)
		}
	}
	u, err = st.CategoryUsage(cat)
	if err != nil {
		t.Fatal(err)
	}
	if u.Targets != 1 {
		t.Errorf("three versions: Targets = %d, want 1", u.Targets)
	}

	if err := st.DeleteCategoryTarget(cat, "2026-09"); err != nil {
		t.Fatal(err)
	}
	u, err = st.CategoryUsage(cat)
	if err != nil {
		t.Fatal(err)
	}
	if u.Targets != 0 {
		t.Errorf("after removal: Targets = %d, want 0", u.Targets)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run TestCategoryUsage_TargetsCounts 2>&1 | tail -12`
Expected: FAIL — `three versions: Targets = 3, want 1`.

- [ ] **Step 3: Fix the query**

In `internal/store/categories.go`, replace:

```go
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM category_targets WHERE category_id=?`, id).Scan(&u.Targets); err != nil {
		return CategoryUsage{}, err
	}
```

with:

```go
	// Version rows, so count the CURRENT state: 1 when the newest version is a
	// real target, 0 when there is none or the newest version is a tombstone.
	// A plain count(*) would report one per edit.
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM category_targets t
		  WHERE t.category_id = ?
		    AND t.target_type <> 'none'
		    AND t.effective_month = (SELECT MAX(x.effective_month) FROM category_targets x
		                              WHERE x.category_id = t.category_id)`,
		id).Scan(&u.Targets); err != nil {
		return CategoryUsage{}, err
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && gofmt -w internal/store/ && go test ./internal/store/ 2>&1 | tail -12`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/store/categories.go internal/store/categories_test.go
git commit -m "fix(store): count current targets, not target versions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Target endpoints take a month

**Files:**
- Modify: `internal/server/targets.go`
- Modify: `internal/server/envelopes.go:19` (interface) and `:63` (call site)
- Test: `internal/server/targets_test.go` (exists — update and extend)

**Interfaces:**
- Consumes: `SelectCategoryTargetsForMonth`, `SelectCategoryTargetForMonth`, `DeleteCategoryTarget(categoryID int64, month string) error`, and `CategoryTargetRow.EffectiveMonth` from Task 2.
- Produces the wire contract Task 5 codes against:
  - `GET /api/targets?month=YYYY-MM` → `[]targetDTO` resolved for that month. Missing `month` → 400 `{"error":"month required (YYYY-MM)"}`.
  - `GET /api/targets/{categoryId}?month=YYYY-MM` → one `targetDTO`, 404 when none in force.
  - `PUT /api/targets/{categoryId}` body `{"month":"YYYY-MM","target_type":...,"amount_fils":...,"cadence":...,"due_date":...}` → the written `targetDTO`.
  - `DELETE /api/targets/{categoryId}?month=YYYY-MM` → `{"ok":true}`.
  - `targetDTO` gains `"effective_month"`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/server/targets_test.go`:

```go
// putTargetAt PUTs a target effective from month and returns the response code.
func putTargetAt(t *testing.T, srv *Server, catID int64, month string, amount int64) int {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"month": month, "target_type": "set_aside", "amount_fils": amount, "cadence": "monthly",
	})
	r := httptest.NewRequest("PUT", fmt.Sprintf("/api/targets/%d", catID), bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	return w.Code
}

// getTargetsAt returns the resolved target list for month.
func getTargetsAt(t *testing.T, srv *Server, month string) []map[string]any {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/targets?month="+month, nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/targets?month=%s = %d; body: %s", month, w.Code, w.Body)
	}
	var out []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTargets_EditIsScopedForward(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if code := putTargetAt(t, srv, cat, "2026-07", 150000); code != http.StatusOK {
		t.Fatalf("PUT July = %d", code)
	}
	if code := putTargetAt(t, srv, cat, "2026-08", 200000); code != http.StatusOK {
		t.Fatalf("PUT August = %d", code)
	}

	jul := getTargetsAt(t, srv, "2026-07")
	if len(jul) != 1 || jul[0]["amount_fils"].(float64) != 150000 {
		t.Errorf("July = %+v, want a single 150000 target (an August edit changed July)", jul)
	}
	aug := getTargetsAt(t, srv, "2026-08")
	if len(aug) != 1 || aug[0]["amount_fils"].(float64) != 200000 {
		t.Errorf("August = %+v, want a single 200000 target", aug)
	}
	sep := getTargetsAt(t, srv, "2026-09")
	if len(sep) != 1 || sep[0]["amount_fils"].(float64) != 200000 {
		t.Errorf("September = %+v, want August's 200000 carried forward", sep)
	}
}

func TestTargets_DeleteIsScopedForward(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")
	putTargetAt(t, srv, cat, "2026-07", 150000)

	r := httptest.NewRequest("DELETE", fmt.Sprintf("/api/targets/%d?month=2026-08", cat), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE = %d; body: %s", w.Code, w.Body)
	}

	if got := getTargetsAt(t, srv, "2026-07"); len(got) != 1 {
		t.Errorf("July lost its target to an August removal: %+v", got)
	}
	if got := getTargetsAt(t, srv, "2026-08"); len(got) != 0 {
		t.Errorf("August still has a target: %+v", got)
	}
	if got := getTargetsAt(t, srv, "2026-12"); len(got) != 0 {
		t.Errorf("December still has a target — tombstone did not carry: %+v", got)
	}
}

func TestTargets_MonthIsRequired(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	for _, tc := range []struct{ method, url string }{
		{"GET", "/api/targets"},
		{"GET", fmt.Sprintf("/api/targets/%d", cat)},
		{"DELETE", fmt.Sprintf("/api/targets/%d", cat)},
	} {
		r := httptest.NewRequest(tc.method, tc.url, nil)
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s %s = %d, want 400", tc.method, tc.url, w.Code)
		}
	}

	body, _ := json.Marshal(map[string]any{"target_type": "set_aside", "amount_fils": 1000})
	r := httptest.NewRequest("PUT", fmt.Sprintf("/api/targets/%d", cat), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("PUT without month = %d, want 400", w.Code)
	}
}

func TestTargets_ResponseCarriesEffectiveMonth(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")
	putTargetAt(t, srv, cat, "2026-07", 150000)

	got := getTargetsAt(t, srv, "2026-09")
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	// September inherits July's version; the client shows where it came from.
	if got[0]["effective_month"] != "2026-07" {
		t.Errorf("effective_month = %v, want 2026-07", got[0]["effective_month"])
	}
}
```

Add this helper to the same file if it does not already exist:

```go
func seedServerCategory(t *testing.T, st *store.Store, name string) int64 {
	t.Helper()
	res, err := st.DB.Exec(`INSERT INTO categories (name, kind, bucket) VALUES (?, 'spending', 'need')`, name)
	if err != nil {
		t.Fatal(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestTargets_ 2>&1 | tail -20`
Expected: FAIL — build errors on the store interface arity.

- [ ] **Step 3: Update `internal/server/targets.go`**

Change the interface:

```go
// TargetsStore is the store surface the category-target endpoints need.
type TargetsStore interface {
	UpsertCategoryTarget(store.CategoryTargetRow) error
	SelectCategoryTargetsForMonth(month string) ([]store.CategoryTargetRow, error)
	SelectCategoryTargetForMonth(categoryID int64, month string) (store.CategoryTargetRow, bool, error)
	DeleteCategoryTarget(categoryID int64, month string) error
}
```

Add `EffectiveMonth` to the DTO and its mapper:

```go
type targetDTO struct {
	CategoryID int64  `json:"category_id"`
	// The month this version was set from. A later month inheriting it reports
	// the earlier month, which is how the client can say where a target came from.
	EffectiveMonth string `json:"effective_month"`
	TargetType     string `json:"target_type"` // set_aside | refill | save_by_date
	AmountFils     int64  `json:"amount_fils"`
	Cadence        string `json:"cadence"`            // weekly | monthly | yearly
	DueDate        string `json:"due_date,omitempty"` // YYYY-MM-DD, save_by_date only
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

func toTargetDTO(t store.CategoryTargetRow) targetDTO {
	return targetDTO{
		CategoryID: t.CategoryID, EffectiveMonth: t.EffectiveMonth, TargetType: t.TargetType,
		AmountFils: t.AmountFils, Cadence: t.Cadence, DueDate: t.DueDate,
		CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
	}
}
```

Add `Month` to the write DTO:

```go
type targetInputDTO struct {
	Month      string `json:"month"` // 'YYYY-MM'; the version is written here
	TargetType string `json:"target_type"`
	AmountFils int64  `json:"amount_fils"`
	Cadence    string `json:"cadence"`
	DueDate    string `json:"due_date"`
}
```

Add a query-param month reader next to `categoryIDFromPath`:

```go
// monthFromQuery reads ?month=YYYY-MM. Returns ok=false after writing a 400.
// Deliberately required rather than defaulting to the current month: these
// endpoints now change history from a point forward, and guessing which point
// is not a decision the server should make on the client's behalf.
func monthFromQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	m := r.URL.Query().Get("month")
	if !store.ValidMonth(m) {
		errJSON(w, http.StatusBadRequest, "month required (YYYY-MM)")
		return "", false
	}
	return m, true
}
```

Rewrite the four handlers:

```go
func (s *Server) handleGetTargets(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	month, ok := monthFromQuery(w, r)
	if !ok {
		return
	}
	targets, err := s.targetsStore.SelectCategoryTargetsForMonth(month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	out := make([]targetDTO, 0, len(targets))
	for _, t := range targets {
		out = append(out, toTargetDTO(t))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handleGetTarget(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	catID, ok := categoryIDFromPath(w, r)
	if !ok {
		return
	}
	month, ok := monthFromQuery(w, r)
	if !ok {
		return
	}
	t, found, err := s.targetsStore.SelectCategoryTargetForMonth(catID, month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	if !found {
		errJSON(w, http.StatusNotFound, "no target for category")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toTargetDTO(t))
}

func (s *Server) handlePutTarget(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	catID, ok := categoryIDFromPath(w, r)
	if !ok {
		return
	}
	var in targetInputDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !store.ValidMonth(in.Month) {
		errJSON(w, http.StatusBadRequest, "month required (YYYY-MM)")
		return
	}
	err := s.targetsStore.UpsertCategoryTarget(store.CategoryTargetRow{
		CategoryID: catID, EffectiveMonth: in.Month, TargetType: in.TargetType,
		AmountFils: in.AmountFils, Cadence: in.Cadence, DueDate: in.DueDate,
	})
	if errors.Is(err, store.ErrTargetInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFKViolation(err) {
		errJSON(w, http.StatusBadRequest, "unknown category")
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	t, _, err := s.targetsStore.SelectCategoryTargetForMonth(catID, in.Month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toTargetDTO(t))
}

func (s *Server) handleDeleteTarget(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	catID, ok := categoryIDFromPath(w, r)
	if !ok {
		return
	}
	month, ok := monthFromQuery(w, r)
	if !ok {
		return
	}
	if err := s.targetsStore.DeleteCategoryTarget(catID, month); err != nil {
		if errors.Is(err, store.ErrTargetInvalid) {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
```

- [ ] **Step 4: Export `ValidMonth` from the store**

`validMonth` is unexported in `internal/store/envelopes.go:25`. Add an exported wrapper immediately below it (do not rename the original — it has many callers):

```go
// ValidMonth reports whether s is a 'YYYY-MM' month string. Exported for
// handlers that must validate a month before it reaches a store method.
func ValidMonth(s string) bool { return validMonth(s) }
```

- [ ] **Step 5: Point the envelope summary at the month-resolved read**

In `internal/server/envelopes.go`, change the interface member at line 19 from
`SelectCategoryTargets() ([]store.CategoryTargetRow, error)` to
`SelectCategoryTargetsForMonth(month string) ([]store.CategoryTargetRow, error)`,
and the call at line 63 from
`targets, err := s.envelopeStore.SelectCategoryTargets()` to
`targets, err := s.envelopeStore.SelectCategoryTargetsForMonth(month)`.

`budget.ComputeEnvelopes` is unchanged — it already takes a target slice and now receives the month-resolved one. `AutoAssign` reads the same summary and inherits this with no edit.

- [ ] **Step 6: Fix any other compile errors**

Run: `cd /root/Coding/ledger && go build ./... 2>&1 | head -20`
Fix each reported call site by adding the month. Existing tests in `internal/server/targets_test.go` and `internal/server/envelopes_test.go` that use the old shapes need `"month"` added to PUT bodies and `?month=` on GET/DELETE.

- [ ] **Step 7: Run the server package**

Run: `cd /root/Coding/ledger && gofmt -w internal/server/ internal/store/ && go test ./internal/server/ 2>&1 | tail -20`
Expected: `ok`.

- [ ] **Step 8: Run everything**

Run: `cd /root/Coding/ledger && go test ./... 2>&1 | grep -v "^ok\|no test files" | head -20`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
cd /root/Coding/ledger
git add internal/server/ internal/store/envelopes.go
git commit -m "feat(api): target endpoints take the month they apply from

GET/DELETE take ?month=, PUT takes month in the body, and the response
carries effective_month so a client can say which month a target was
inherited from. The Plan summary resolves targets for the month it is
showing, so auto-assign inherits the fix unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: TargetSheet sends and shows the month

**Files:**
- Modify: `frontend/src/api/hooks.ts` (`usePutTarget`, `useDeleteTarget`, and `putTargetOnce`)
- Modify: `frontend/src/api/types.ts` (`TargetBody`, and the target shape on `Envelope`)
- Modify: `frontend/src/screens/plan/TargetSheet.tsx`
- Test: `frontend/src/screens/plan/TargetSheet.test.tsx` (create)

**Interfaces:**
- Consumes the Task 4 contract exactly: `PUT /api/targets/{categoryId}` with `month` in the body; `DELETE /api/targets/{categoryId}?month=YYYY-MM`; responses carry `effective_month`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/screens/plan/TargetSheet.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionProvider } from "../../app/MotionProvider";
import { ToastProvider } from "../../components/Toast";
import type { Envelope } from "../../api/types";
import { TargetSheet } from "./TargetSheet";

const envelope = {
  category_id: 3,
  category_name: "Groceries",
  bucket: "need",
  carryover_fils: 0,
  assigned_fils: 0,
  activity_fils: 0,
  available_fils: 0,
  overspent: false,
  overspend_debt_fils: 0,
} as unknown as Envelope;

function renderSheet(month = "2026-08", env: Envelope = envelope) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MotionProvider>
        <ToastProvider>
          <TargetSheet envelope={env} month={month} onClose={() => {}} />
        </ToastProvider>
      </MotionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TargetSheet", () => {
  it("says which month the target applies from, so a scoped edit isn't a surprise", () => {
    renderSheet("2026-08");
    expect(screen.getByText(/applies from aug 2026 onward/i)).toBeInTheDocument();
  });

  it("sends the month it is editing with the target", async () => {
    renderSheet("2026-08");
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const put = calls.find((c) => c[1]?.method === "PUT");
      expect(put, "expected a PUT to /api/targets").toBeTruthy();
      expect(JSON.parse(put![1].body)).toMatchObject({ month: "2026-08", amount_fils: 150000 });
    });
  });

  it("scopes removal to the month being edited", async () => {
    const withTarget = {
      ...envelope,
      target: { type: "set_aside", amount_fils: 150000, cadence: "monthly", still_needed_fils: 0 },
    } as unknown as Envelope;
    renderSheet("2026-08", withTarget);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const del = calls.find((c) => c[1]?.method === "DELETE");
      expect(del, "expected a DELETE to /api/targets").toBeTruthy();
      expect(String(del![0])).toContain("month=2026-08");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bunx vitest run src/screens/plan/TargetSheet.test.tsx 2>&1 | tail -20`
Expected: FAIL — no "Applies from…" text, and the PUT body has no `month`.

- [ ] **Step 3: Add `month` to the API types**

In `frontend/src/api/types.ts`, add `month: string;` to `TargetBody`, and `effective_month?: string;` to the target shape carried on `Envelope`.

- [ ] **Step 4: Thread the month through the hooks**

In `frontend/src/api/hooks.ts`, replace the two hooks and the one-shot helper. Note the parameters were named `_month` because they were unused — they are used now, so drop the underscore.

```ts
/** PUT /api/targets/{categoryId} — writes the version effective from `month`.
 *  Earlier months keep whatever was in force, so invalidate the whole prefix:
 *  every month from `month` onward may have changed. */
export function usePutTarget(month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, body }: { categoryId: number; body: Omit<TargetBody, "month"> }) =>
      postJSON(`/api/targets/${categoryId}`, { ...body, month }, "PUT"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}

/** DELETE /api/targets/{categoryId}?month= — tombstones from `month` onward. */
export function useDeleteTarget(month: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: number) =>
      del(`/api/targets/${categoryId}?month=${encodeURIComponent(month)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["envelopes"] }),
  });
}
```

`putTargetOnce` (used by the undo path, which outlives the sheet, so it cannot
use a hook) needs no signature change — `TargetBody` now carries `month`, so the
caller supplies it. Confirm it still reads:

```ts
export function putTargetOnce(categoryId: number, body: TargetBody) {
  return postJSON(`/api/targets/${categoryId}`, body, "PUT");
}
```

- [ ] **Step 5: Update `TargetSheet.tsx`**

Add a month formatter above the component:

```tsx
/** "2026-08" → "Aug 2026". Parsed as a local date; the string has no timezone. */
function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(y, m - 1, 1).toLocaleDateString("en-AE", { month: "short", year: "numeric" });
}
```

In `save`, include the month:

```tsx
  const save = () => {
    if (!amountOk || !dateOk) return;
    const body: Omit<TargetBody, "month"> = { target_type: type, amount_fils: parsed!, cadence };
    if (type === "save_by_date") body.due_date = dueDate;
    put.mutate({ categoryId: envelope.category_id, body }, { onSuccess: onClose });
  };
```

In `removeTarget`'s undo closure, add the month to the restore body:

```tsx
                  const body: TargetBody = { month, target_type: old.type, amount_fils: old.amount_fils, cadence: old.cadence };
```

And render the scope line as the first child inside `<Dialog>`, before the `<SegmentedControl>`:

```tsx
      <p className="text-xs text-muted mb-3">
        Applies from {monthLabel(month)} onward. Earlier months keep their current target.
      </p>
```

- [ ] **Step 6: Run the test**

Run: `cd /root/Coding/ledger/frontend && bunx vitest run src/screens/plan/TargetSheet.test.tsx 2>&1 | tail -12`
Expected: 3 PASS.

- [ ] **Step 7: Typecheck and run the whole frontend suite**

Run: `cd /root/Coding/ledger/frontend && ./node_modules/.bin/tsc -b --noEmit && bun run test 2>&1 | tail -8`
Expected: typecheck silent, all test files pass. Fix any other call sites the typechecker names.

- [ ] **Step 8: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/api/hooks.ts frontend/src/api/types.ts frontend/src/screens/plan/TargetSheet.tsx frontend/src/screens/plan/TargetSheet.test.tsx
git commit -m "feat(plan): scope target edits to the month being edited

The sheet now states 'Applies from <month> onward', because a silently
month-scoped edit is exactly what surprises a user three months later.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification (orchestrator, after all tasks)

Not a subagent task — the orchestrator does this.

1. `go test ./... && cd frontend && bun run test && ./node_modules/.bin/tsc -b --noEmit`
2. `cd frontend && bun run build` then `CGO_ENABLED=0 go build -o <scratch>/ledger ./cmd/ledger` — dist is a committed artifact and must match source.
3. Restore a scratch copy of production into a scratch dir and run the new binary on a scratch port (never `:8080`, never `/var/lib/ledger`):
   `sudo sqlite3 /var/lib/ledger/ledger.db ".backup '<scratch>/scratchdata/ledger.db'"`
   Confirm the migration ran: `SELECT count(*) FROM pragma_table_info('category_targets') WHERE name='effective_month'` → 1.
4. Against the scratch instance: PUT a target for July, PUT a different one for August, assert `GET /api/targets?month=2026-07` still shows July's value. This is the whole feature in one check.
5. `GET /api/envelopes?month=2026-08` still returns the verified carryover figures — Investments 800000, Utilities 224272, Entertainment 64050. Carryover must not regress.
6. Browser pass on the Plan screen with `harness/audit.mjs`; expect 0 issues, 0 console errors.
7. Back up production, deploy, verify the running binary by exe link, and confirm the migration applied to the real DB.
