# Categorization Toggle (Global + Per-Rule, AI Opt-In) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user control categorization at runtime — a global "auto-categorize" master switch, per-rule enable/disable, and AI demoted to opt-in *suggestion only* — so manual/rules-based categorization is the default and the source of truth.

**Architecture:** A new DB-backed singleton `app_settings` row (mirroring `budget_config`) holds the toggles; rules gain an `is_active` column. The parse `Processor` stops using a fixed categorizer and instead resolves one **per batch** from current settings + active rules via an injected provider, so toggles take effect on the next ingest/reprocess cycle with no restart. New `/api/settings` (GET/PUT) and a per-rule `/api/rules/{id}/active` (PUT) expose the controls; the Settings screen renders a Categorization card and per-rule switches.

**Tech Stack:** Go 1.22 (`net/http`, `database/sql`, `modernc.org/sqlite`); React 18 + TypeScript + TanStack Query + Tailwind; Vitest + `@testing-library/react`; `go test ./...`.

**Conventions in this codebase (follow them):**
- Money is `int64` fils. Handlers are methods on `*server.Server`; dependencies are narrow interfaces set via `Set*` with a `nil`-guard returning `503` (see `internal/server/budget.go`). Store methods hang off `*store.Store` with `s.DB`. The schema is `internal/store/schema.sql`, embedded and `Exec`'d on `Open` (all `CREATE TABLE IF NOT EXISTS`); a `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table, so new columns need an explicit idempotent migration.
- Frontend lives in `frontend/`; run `bun run test` / `bunx vitest run <path>`; the Settings screen is `frontend/src/screens/Settings.tsx`. API helpers: `getJSON`, `postJSON(url, body, method?)`, `del` from `src/api/client.ts`.
- Current categorization flow: `categorize.New(rules, cats, ai, threshold, autoRule)` → `Categorizer.Categorize(ctx, merchantRaw) (Result, bool)`. A matched **rule** returns `AboveThreshold:true` (→ processor sets `confirmed`); an **AI** hit returns the category with `AboveThreshold = conf >= threshold` (when below, the category is still assigned but status stays `needs_review` — i.e. a suggestion), and writes a proposed rule only when `autoRule` is true. `internal/parse/processor.go#categorizeTransaction` maps `AboveThreshold` → `confirmed` else `needs_review`.

**Settings semantics (the contract this plan implements):**
- `auto_categorize` (default **true**): master switch. When **false**, the processor assigns no category and confirms nothing — every new transaction lands `needs_review`, uncategorized (pure manual).
- `ai_enabled` (default **false**): whether the AI tier runs at all.
- `ai_auto_accept` (default **false**): when AI is enabled, whether an above-threshold AI hit auto-confirms (true) or only *suggests* a category while leaving `needs_review` (false). "AI suggestion only" = this stays false.
- `ai_threshold` (default **0.85**): the confidence cutoff used only when `ai_auto_accept` is true.
- Per-rule `is_active` (default **true**): inactive rules are ignored by the categorizer.

These map onto the existing `Categorizer` with no change to its logic: build it per batch with `ai = DisabledAI{}` when `!ai_enabled`; `threshold = ai_threshold` when `ai_auto_accept` else a value no confidence can exceed (so AI assigns-but-suggests); `autoRule = ai_auto_accept`; and `rules` = active rules only. When `!auto_categorize`, skip categorization entirely.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `internal/store/schema.sql` | Modify | `app_settings` table; `is_active` on the `rules` CREATE (for fresh DBs) |
| `internal/store/store.go` | Modify | After schema exec, run `migrate()` — idempotent `ADD COLUMN rules.is_active` for existing DBs |
| `internal/store/store_test.go` | Modify/Create | Test the migration is idempotent and the column exists |
| `internal/store/settings.go` | Create | `AppSettings` type; `EnsureAppSettings`, `SelectAppSettings`, `UpdateAppSettings` |
| `internal/store/settings_test.go` | Create | Tests for the above |
| `internal/store/categories.go` | Modify | `RuleRow.IsActive`; `SelectRules` returns it; add `SelectActiveRules`, `SetRuleActive` |
| `internal/store/categories_test.go` | Modify | Tests for active-rule filtering + toggle |
| `internal/parse/processor.go` | Modify | Resolve categorizer per batch via an optional provider; skip when auto-categorize off |
| `internal/parse/processor_test.go` | Modify | Tests: provider used; off → no categorization |
| `internal/server/settings.go` | Create | `SettingsStore` interface; `handleGetSettings`, `handlePutSettings` |
| `internal/server/settings_test.go` | Create | httptest coverage |
| `internal/server/rules.go` | Modify | `handleSetRuleActive` (PUT `/api/rules/{id}/active`); `RuleActiveStore` |
| `internal/server/rules_test.go` | Modify | httptest coverage for the toggle |
| `internal/server/server.go` | Modify | Register routes; add `settingsStore`; `SetSettingsStore` |
| `cmd/ledger/main.go` | Modify | `EnsureAppSettings`; wire the per-batch categorizer provider; wire `SetSettingsStore` |
| `frontend/src/api/types.ts` | Modify | `AppSettings` type; `Rule` gains `IsActive` |
| `frontend/src/screens/Settings.tsx` | Modify | Categorization card (3 toggles) + per-rule active switch |
| `frontend/src/screens/Settings.categorization.test.tsx` | Create | Toggle render + PUT behavior |

---

# Phase A — Storage (Go, TDD)

### Task A1: schema + idempotent migration for `rules.is_active` and `app_settings`

**Files:**
- Modify: `internal/store/schema.sql`
- Modify: `internal/store/store.go`
- Test: `internal/store/store_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/store/store_test.go` (create the file if absent; package `store`):

```go
package store

import "testing"

func TestMigrateAddsRuleIsActiveAndSettings(t *testing.T) {
	st := openTestStore(t) // Open already runs schema + migrate
	// rules.is_active must exist and default to 1
	var dflt int
	if err := st.DB.QueryRow(`SELECT count(*) FROM pragma_table_info('rules') WHERE name='is_active'`).Scan(&dflt); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if dflt != 1 {
		t.Fatalf("rules.is_active column missing")
	}
	// app_settings singleton must be ensurable
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("EnsureAppSettings: %v", err)
	}
	var n int
	if err := st.DB.QueryRow(`SELECT count(*) FROM app_settings WHERE id=1`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("app_settings singleton not present, got %d", n)
	}
}
```

(`openTestStore` already exists in the store test package; `EnsureAppSettings` is implemented in Task A2 — this test will compile only after A2, so run it at the end of A2. For A1, verify the column via the migration test below.)

For A1 in isolation, instead assert just the column exists:

```go
func TestMigrateAddsRuleIsActive(t *testing.T) {
	st := openTestStore(t)
	var c int
	if err := st.DB.QueryRow(`SELECT count(*) FROM pragma_table_info('rules') WHERE name='is_active'`).Scan(&c); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if c != 1 {
		t.Fatalf("rules.is_active missing")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestMigrateAddsRuleIsActive`
Expected: FAIL — column absent.

- [ ] **Step 3: Add the schema + migration**

In `internal/store/schema.sql`, add `is_active` to the `rules` CREATE (for fresh DBs) — change the `source` line to keep the trailing comma and append the column:

```sql
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  match_type  TEXT NOT NULL,
  pattern     TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  priority    INTEGER NOT NULL DEFAULT 100,
  source      TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
```

And add the settings table anywhere in the file (e.g. after `budget_config`):

```sql
-- Runtime app settings (singleton). Controls categorization behavior.
CREATE TABLE IF NOT EXISTS app_settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  auto_categorize INTEGER NOT NULL DEFAULT 1,
  ai_enabled      INTEGER NOT NULL DEFAULT 0,
  ai_auto_accept  INTEGER NOT NULL DEFAULT 0,
  ai_threshold    REAL    NOT NULL DEFAULT 0.85
);
```

In `internal/store/store.go`, after the `db.Exec(schemaSQL)` block and before `SeedDefaultCategories`, call a new `migrate`:

```go
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
```

Add at the bottom of `store.go`:

```go
// migrate applies idempotent column additions that CREATE TABLE IF NOT EXISTS
// cannot perform on pre-existing tables.
func migrate(db *sql.DB) error {
	return addColumnIfMissing(db, "rules", "is_active", "INTEGER NOT NULL DEFAULT 1")
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
```

Ensure `database/sql` is imported in `store.go` (it already is, as `*sql.DB` is used).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/ -run TestMigrateAddsRuleIsActive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/schema.sql internal/store/store.go internal/store/store_test.go
git commit -m "feat(store): app_settings table + idempotent rules.is_active migration"
```

---

### Task A2: `AppSettings` CRUD

**Files:**
- Create: `internal/store/settings.go`
- Test: `internal/store/settings_test.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/store/settings_test.go
package store

import "testing"

func TestAppSettingsRoundTrip(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	got, err := st.SelectAppSettings()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	// Defaults: auto-categorize on, AI off, suggestion-only, 0.85.
	if !got.AutoCategorize || got.AIEnabled || got.AIAutoAccept || got.AIThreshold != 0.85 {
		t.Fatalf("defaults wrong: %+v", got)
	}
	got.AutoCategorize = false
	got.AIEnabled = true
	got.AIAutoAccept = true
	got.AIThreshold = 0.9
	if err := st.UpdateAppSettings(got); err != nil {
		t.Fatalf("update: %v", err)
	}
	got2, _ := st.SelectAppSettings()
	if got2.AutoCategorize || !got2.AIEnabled || !got2.AIAutoAccept || got2.AIThreshold != 0.9 {
		t.Fatalf("round-trip wrong: %+v", got2)
	}
}

func TestEnsureAppSettingsIdempotent(t *testing.T) {
	st := openTestStore(t)
	for i := 0; i < 3; i++ {
		if err := st.EnsureAppSettings(); err != nil {
			t.Fatalf("ensure %d: %v", i, err)
		}
	}
	s, _ := st.SelectAppSettings()
	if !s.AutoCategorize {
		t.Fatalf("ensure overwrote an existing row")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run AppSettings`
Expected: FAIL — `AppSettings`/`EnsureAppSettings` undefined.

- [ ] **Step 3: Implement**

```go
// internal/store/settings.go
package store

// AppSettings is the singleton app_settings row controlling categorization.
type AppSettings struct {
	AutoCategorize bool
	AIEnabled      bool
	AIAutoAccept   bool
	AIThreshold    float64
}

// EnsureAppSettings inserts the default singleton row if none exists. It never
// overwrites an existing row.
func (s *Store) EnsureAppSettings() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO app_settings
		   (id, auto_categorize, ai_enabled, ai_auto_accept, ai_threshold)
		 VALUES (1, 1, 0, 0, 0.85)`,
	)
	return err
}

// SelectAppSettings reads the singleton row.
func (s *Store) SelectAppSettings() (AppSettings, error) {
	var a AppSettings
	var auto, aiOn, aiAccept int
	err := s.DB.QueryRow(
		`SELECT auto_categorize, ai_enabled, ai_auto_accept, ai_threshold
		 FROM app_settings WHERE id=1`,
	).Scan(&auto, &aiOn, &aiAccept, &a.AIThreshold)
	a.AutoCategorize = auto == 1
	a.AIEnabled = aiOn == 1
	a.AIAutoAccept = aiAccept == 1
	return a, err
}

// UpdateAppSettings overwrites the singleton row.
func (s *Store) UpdateAppSettings(a AppSettings) error {
	_, err := s.DB.Exec(
		`UPDATE app_settings
		   SET auto_categorize=?, ai_enabled=?, ai_auto_accept=?, ai_threshold=?
		 WHERE id=1`,
		boolToInt(a.AutoCategorize), boolToInt(a.AIEnabled), boolToInt(a.AIAutoAccept), a.AIThreshold,
	)
	return err
}
```

(`boolToInt` already exists in `internal/store/budget.go`, same package.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/ -run AppSettings`
Expected: PASS. Also re-run the A1 settings test now that `EnsureAppSettings` exists: `go test ./internal/store/ -run TestMigrateAddsRuleIsActiveAndSettings` (if you kept it).

- [ ] **Step 5: Commit**

```bash
git add internal/store/settings.go internal/store/settings_test.go
git commit -m "feat(store): AppSettings ensure/select/update"
```

---

### Task A3: per-rule `is_active` — struct, queries, toggle

**Files:**
- Modify: `internal/store/categories.go`
- Test: `internal/store/categories_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/store/categories_test.go`:

```go
func TestRuleActiveToggleAndSelect(t *testing.T) {
	st := openTestStore(t)
	cats, _ := st.SelectCategories()
	cat := cats[0]
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "spinneys", CategoryID: cat.ID, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	all, _ := st.SelectRules()
	if len(all) != 1 || !all[0].IsActive {
		t.Fatalf("new rule should be active by default: %+v", all)
	}
	if err := st.SetRuleActive(all[0].ID, false); err != nil {
		t.Fatalf("toggle: %v", err)
	}
	active, _ := st.SelectActiveRules()
	if len(active) != 0 {
		t.Fatalf("disabled rule must be excluded from SelectActiveRules, got %d", len(active))
	}
	all2, _ := st.SelectRules()
	if all2[0].IsActive {
		t.Fatalf("SelectRules should report is_active=false after toggle")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestRuleActiveToggleAndSelect`
Expected: FAIL — `RuleRow.IsActive` / `SetRuleActive` / `SelectActiveRules` undefined.

- [ ] **Step 3: Implement**

In `internal/store/categories.go`, add the field to `RuleRow`:

```go
type RuleRow struct {
	ID         int64
	MatchType  string
	Pattern    string
	CategoryID int64
	Priority   int
	Source     string
	IsActive   bool
}
```

Update `SelectRules` to read `is_active`:

```go
func (s *Store) SelectRules() ([]RuleRow, error) {
	return scanRules(s.DB.Query(
		`SELECT id, match_type, pattern, category_id, priority, source, is_active
		 FROM rules ORDER BY priority ASC`,
	))
}

// SelectActiveRules returns only enabled rules, priority ascending — for the categorizer.
func (s *Store) SelectActiveRules() ([]RuleRow, error) {
	return scanRules(s.DB.Query(
		`SELECT id, match_type, pattern, category_id, priority, source, is_active
		 FROM rules WHERE is_active=1 ORDER BY priority ASC`,
	))
}

func scanRules(rows *sql.Rows, qerr error) ([]RuleRow, error) {
	if qerr != nil {
		return nil, qerr
	}
	defer rows.Close()
	var out []RuleRow
	for rows.Next() {
		var r RuleRow
		var active int
		if err := rows.Scan(&r.ID, &r.MatchType, &r.Pattern, &r.CategoryID, &r.Priority, &r.Source, &active); err != nil {
			return nil, err
		}
		r.IsActive = active == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetRuleActive enables/disables a rule.
func (s *Store) SetRuleActive(id int64, active bool) error {
	_, err := s.DB.Exec(`UPDATE rules SET is_active=? WHERE id=?`, boolToInt(active), id)
	return err
}
```

Remove the old inline body of `SelectRules` (the manual `rows.Scan(...)` loop) — it's replaced by `scanRules`. Ensure `database/sql` is imported (it is, from Task A1-area usage / existing `sql.NullInt64`).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/`
Expected: PASS — the new test plus all existing store tests (existing `SelectRules` callers now also get `IsActive`, which is additive).

- [ ] **Step 5: Commit**

```bash
git add internal/store/categories.go internal/store/categories_test.go
git commit -m "feat(store): rules.is_active — SelectActiveRules, SetRuleActive, IsActive on RuleRow"
```

---

# Phase B — Processor honors settings (Go, TDD)

### Task B1: per-batch categorizer provider + skip-when-off

**Files:**
- Modify: `internal/parse/processor.go`
- Test: `internal/parse/processor_test.go`

The `Processor` currently holds one static `*categorize.Categorizer`. Add an optional **provider** that returns a categorizer (built from current settings + active rules) and an `enabled` flag, resolved once per `ProcessPending` call. When a provider is set it wins; otherwise the static categorizer is used (so existing tests are unaffected).

- [ ] **Step 1: Write the failing test**

Add to `internal/parse/processor_test.go` (reuse the file's existing stub categorizer/store patterns; this test asserts the provider gates categorization):

```go
func TestProcessorCategorizerProvider(t *testing.T) {
	// A processor with NO static categorizer but a provider that is "disabled"
	// must not categorize: transactions stay needs_review, uncategorized.
	st := newTestStore(t) // use the helper the other processor tests use
	cascade := &Cascade{Heuristic: HeuristicParser{}}
	p := NewProcessor(st, cascade) // categorizer-less constructor (see impl)

	called := false
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		called = true
		return nil, false // auto-categorize OFF
	})

	// Seed one parseable ingest row, then process.
	seedParseableIngest(t, st) // helper that inserts an ingest_log row the heuristic can parse
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatalf("process: %v", err)
	}
	if !called {
		t.Fatal("provider should be consulted once per batch")
	}
	items, _ := st.SelectNeedsReview()
	if len(items) == 0 {
		t.Fatal("expected an uncategorized needs_review transaction")
	}
	for _, it := range items {
		if it.CategoryID != nil {
			t.Fatalf("auto_categorize OFF must leave category unset, got %v", it.CategoryID)
		}
	}
}
```

If the existing processor tests use different helper names (`newTestStore`, `seedParseableIngest`), adapt to the real helpers in `processor_test.go`; if none exist, build a real store via `store.Open(t.TempDir())`, insert an `ingest_log` row whose body the `HeuristicParser` parses (an amount + a `dd-mm-yyyy` date), and assert via `SelectNeedsReview()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/parse/ -run TestProcessorCategorizerProvider`
Expected: FAIL — `NewProcessor` / `SetCategorizerProvider` undefined.

- [ ] **Step 3: Implement**

In `internal/parse/processor.go`, add the provider field, a categorizer-less constructor, the setter, and resolve-per-batch logic. Add to the `Processor` struct:

```go
type Processor struct {
	store       *store.Store
	cascade     *Cascade
	categorizer *categorize.Categorizer
	provider    func(ctx context.Context) (*categorize.Categorizer, bool)
}
```

Add the constructor + setter (keep `NewProcessorWithCategorizer` as-is for existing callers/tests):

```go
// NewProcessor builds a Processor with no static categorizer. Use
// SetCategorizerProvider to supply one resolved per batch from runtime settings.
func NewProcessor(st *store.Store, c *Cascade) *Processor {
	return &Processor{store: st, cascade: c}
}

// SetCategorizerProvider installs a per-batch categorizer resolver. The bool it
// returns is whether auto-categorization is enabled; false skips it entirely.
func (p *Processor) SetCategorizerProvider(f func(ctx context.Context) (*categorize.Categorizer, bool)) {
	p.provider = f
}

// resolveCategorizer returns the categorizer for this batch and whether to run it.
func (p *Processor) resolveCategorizer(ctx context.Context) (*categorize.Categorizer, bool) {
	if p.provider != nil {
		return p.provider(ctx)
	}
	if p.categorizer != nil {
		return p.categorizer, true
	}
	return nil, false
}
```

In `ProcessPending`, resolve once at the top of the function (after opening, before the per-row loop) and pass the resolved categorizer into the per-row categorize call. Replace the body of `categorizeTransaction` to take the categorizer as a parameter:

```go
// inside ProcessPending, before the loop over rows:
	cz, autoCat := p.resolveCategorizer(ctx)

// ...where the code currently calls p.categorizeTransaction(ctx, txID, merchantRaw):
	if autoCat && cz != nil {
		p.categorizeWith(ctx, cz, txID, merchantRaw)
	}
```

```go
func (p *Processor) categorizeWith(ctx context.Context, cz *categorize.Categorizer, txID int64, merchantRaw string) {
	result, ok := cz.Categorize(ctx, merchantRaw)
	if !ok {
		return
	}
	status := "needs_review"
	if result.AboveThreshold {
		status = "confirmed"
	}
	_ = p.store.UpdateTransactionCategory(txID, result.CategoryID, status)
	if result.ProposedRule != nil {
		_ = p.store.InsertRule(store.RuleRow{
			MatchType:  result.ProposedRule.MatchType,
			Pattern:    result.ProposedRule.Pattern,
			CategoryID: result.ProposedRule.CategoryID,
			Priority:   result.ProposedRule.Priority,
			Source:     "ai_confirmed",
		})
	}
}
```

Keep the old `categorizeTransaction` only if other code references it; otherwise delete it (its logic moved to `categorizeWith`). For `NewProcessorWithCategorizer`, the static `p.categorizer` path now flows through `resolveCategorizer` → `categorizeWith`, so existing behavior is preserved.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/parse/`
Expected: PASS — the new provider test plus all existing processor tests (the static-categorizer path is unchanged behaviorally).

- [ ] **Step 5: Commit**

```bash
git add internal/parse/processor.go internal/parse/processor_test.go
git commit -m "feat(parse): per-batch categorizer provider; skip categorization when disabled"
```

---

### Task B2: wire the settings-driven provider in `main.go`

**Files:**
- Modify: `cmd/ledger/main.go`

This is integration glue (covered end-to-end by the smoke in Phase D). It builds the provider closure that, each batch, reads settings + active rules and constructs a categorizer honoring the toggles.

- [ ] **Step 1: Ensure settings exist at startup**

Near where `EnsureBudgetConfig` is called in `main.go`, add:

```go
	if err := st.EnsureAppSettings(); err != nil {
		log.Fatalf("ensure app settings: %v", err)
	}
```

- [ ] **Step 2: Replace the static categorizer wiring with the provider**

Find where the processor is built. Currently:

```go
	cat := categorize.New(domainRules, domainCats, aiCat, cfg.AI.AutoAcceptThreshold, cfg.AI.AutoRule)
	processor := parse.NewProcessorWithCategorizer(st, cascade, cat)
```

Replace with the provider form (keep `aiCat` — the AI client built earlier — and `domainCats`):

```go
	processor := parse.NewProcessor(st, cascade)
	processor.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		settings, err := st.SelectAppSettings()
		if err != nil {
			log.Printf("categorizer: settings read failed, skipping categorization: %v", err)
			return nil, false
		}
		if !settings.AutoCategorize {
			return nil, false
		}
		ruleRows, err := st.SelectActiveRules()
		if err != nil {
			log.Printf("categorizer: active rules read failed: %v", err)
			return nil, false
		}
		rules := make([]categorize.Rule, 0, len(ruleRows))
		for _, r := range ruleRows {
			rules = append(rules, categorize.Rule{
				MatchType: r.MatchType, Pattern: r.Pattern, CategoryID: r.CategoryID, Priority: r.Priority,
			})
		}
		ai := categorize.AICategorizer(categorize.DisabledAI{})
		threshold := math.MaxFloat64 // AI suggests a category but never auto-confirms
		if settings.AIEnabled {
			ai = aiCat
			if settings.AIAutoAccept {
				threshold = settings.AIThreshold
			}
		}
		return categorize.New(rules, domainCats, ai, threshold, settings.AIAutoAccept), true
	})
```

Add `"math"` to the import block. Remove the now-unused `cat` variable and `domainRules` if nothing else uses them (the categorizer now loads rules from the DB each batch); if `domainRules` is used elsewhere, leave it.

- [ ] **Step 3: Build**

Run: `go build ./...`
Expected: clean. (`go vet ./...` should also be clean.)

- [ ] **Step 4: Commit**

```bash
git add cmd/ledger/main.go
git commit -m "feat(main): settings-driven categorizer provider (global toggle + AI opt-in)"
```

---

# Phase C — API (Go, TDD)

### Task C1: `GET`/`PUT /api/settings`

**Files:**
- Create: `internal/server/settings.go`
- Test: `internal/server/settings_test.go`
- Modify: `internal/server/server.go`
- Modify: `cmd/ledger/main.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/server/settings_test.go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ledger/internal/store"
)

type stubSettings struct{ s store.AppSettings }

func (st *stubSettings) SelectAppSettings() (store.AppSettings, error) { return st.s, nil }
func (st *stubSettings) UpdateAppSettings(a store.AppSettings) error   { st.s = a; return nil }

func TestGetSettings(t *testing.T) {
	srv := New(nil, fstest()) // mirror existing server-test construction
	srv.SetSettingsStore(&stubSettings{s: store.AppSettings{AutoCategorize: true, AIThreshold: 0.85}})
	req := httptest.NewRequest("GET", "/api/settings", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d", rec.Code)
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["auto_categorize"] != true {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestPutSettings(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AutoCategorize: true}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)
	body := `{"auto_categorize":false,"ai_enabled":true,"ai_auto_accept":false,"ai_threshold":0.9}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.AutoCategorize || !stub.s.AIEnabled || stub.s.AIAutoAccept || stub.s.AIThreshold != 0.9 {
		t.Fatalf("stored wrong: %+v", stub.s)
	}
}

func TestSettingsUnset503(t *testing.T) {
	srv := New(nil, fstest())
	req := httptest.NewRequest("GET", "/api/settings", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d want 503", rec.Code)
	}
}
```

Use the exact `New(...)` construction the other server tests use (e.g. `New(nil, fstest())` — confirm `fstest()` helper name in `internal/server/spa_test.go`).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run Settings`
Expected: FAIL — `SetSettingsStore` undefined.

- [ ] **Step 3: Implement the handlers + interface**

```go
// internal/server/settings.go
package server

import (
	"encoding/json"
	"net/http"

	"ledger/internal/store"
)

// SettingsStore is the read/write surface the settings endpoints need.
type SettingsStore interface {
	SelectAppSettings() (store.AppSettings, error)
	UpdateAppSettings(store.AppSettings) error
}

// SetSettingsStore wires the settings store. Required for /api/settings.
func (s *Server) SetSettingsStore(ss SettingsStore) { s.settingsStore = ss }

type settingsDTO struct {
	AutoCategorize bool    `json:"auto_categorize"`
	AIEnabled      bool    `json:"ai_enabled"`
	AIAutoAccept   bool    `json:"ai_auto_accept"`
	AIThreshold    float64 `json:"ai_threshold"`
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsStore == nil {
		http.Error(w, "settings unavailable", http.StatusServiceUnavailable)
		return
	}
	a, err := s.settingsStore.SelectAppSettings()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(settingsDTO{a.AutoCategorize, a.AIEnabled, a.AIAutoAccept, a.AIThreshold})
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsStore == nil {
		http.Error(w, "settings unavailable", http.StatusServiceUnavailable)
		return
	}
	var dto settingsDTO
	if err := json.NewDecoder(r.Body).Decode(&dto); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if dto.AIThreshold <= 0 || dto.AIThreshold > 1 {
		dto.AIThreshold = 0.85
	}
	if err := s.settingsStore.UpdateAppSettings(store.AppSettings{
		AutoCategorize: dto.AutoCategorize, AIEnabled: dto.AIEnabled,
		AIAutoAccept: dto.AIAutoAccept, AIThreshold: dto.AIThreshold,
	}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

In `internal/server/server.go`: add `settingsStore SettingsStore` to the `Server` struct, and register routes near the others:

```go
	s.mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	s.mux.HandleFunc("PUT /api/settings", s.handlePutSettings)
```

In `cmd/ledger/main.go`, after `srv.SetBudgetStore(st)`:

```go
	srv.SetSettingsStore(st)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/settings.go internal/server/settings_test.go internal/server/server.go cmd/ledger/main.go
git commit -m "feat(server): GET/PUT /api/settings (categorization toggles)"
```

---

### Task C2: `PUT /api/rules/{id}/active`

**Files:**
- Modify: `internal/server/rules.go`
- Test: `internal/server/rules_test.go`
- Modify: `internal/server/server.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/server/rules_test.go` (mirror its existing stub for the rules store):

```go
type stubRuleActive struct{ id int64; active bool; called bool }

func (s *stubRuleActive) SetRuleActive(id int64, active bool) error {
	s.id, s.active, s.called = id, active, true
	return nil
}

func TestSetRuleActive(t *testing.T) {
	stub := &stubRuleActive{}
	srv := New(nil, fstest())
	srv.SetRuleActiveStore(stub)
	req := httptest.NewRequest("PUT", "/api/rules/7/active", strings.NewReader(`{"active":false}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if !stub.called || stub.id != 7 || stub.active != false {
		t.Fatalf("stub got id=%d active=%v called=%v", stub.id, stub.active, stub.called)
	}
}
```

If `internal/server/rules.go` already keeps its store on a field (e.g. `ruleStore`), add `SetRuleActive` to that interface instead of adding a new `RuleActiveStore`; check the file and follow its existing pattern. The test above assumes a dedicated `SetRuleActiveStore` setter — adapt to whatever exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestSetRuleActive`
Expected: FAIL — handler/route/setter missing.

- [ ] **Step 3: Implement**

In `internal/server/rules.go`, add (or extend the existing rules-store interface with) the toggle:

```go
// RuleActiveStore toggles a rule's enabled flag.
type RuleActiveStore interface {
	SetRuleActive(id int64, active bool) error
}

func (s *Server) SetRuleActiveStore(r RuleActiveStore) { s.ruleActiveStore = r }

func (s *Server) handleSetRuleActive(w http.ResponseWriter, r *http.Request) {
	if s.ruleActiveStore == nil {
		http.Error(w, "rules unavailable", http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	var body struct {
		Active bool `json:"active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if err := s.ruleActiveStore.SetRuleActive(id, body.Active); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}
```

Add `ruleActiveStore RuleActiveStore` to the `Server` struct in `server.go`, register the route, and wire the store in `main.go`:

```go
// server.go (route block):
	s.mux.HandleFunc("PUT /api/rules/{id}/active", s.handleSetRuleActive)
```
```go
// main.go (near other Set* calls):
	srv.SetRuleActiveStore(st)
```

Ensure `encoding/json` and `strconv` are imported in `rules.go` (they likely are).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/rules.go internal/server/rules_test.go internal/server/server.go cmd/ledger/main.go
git commit -m "feat(server): PUT /api/rules/{id}/active to enable/disable a rule"
```

---

# Phase D — Frontend (TDD where logic, then ship)

### Task D1: types + Settings categorization card + per-rule switch

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/screens/Settings.tsx`
- Test: `frontend/src/screens/Settings.categorization.test.tsx`

- [ ] **Step 1: Extend types**

In `frontend/src/api/types.ts`, add `AppSettings` and extend `Rule`:

```ts
export interface AppSettings {
  auto_categorize: boolean;
  ai_enabled: boolean;
  ai_auto_accept: boolean;
  ai_threshold: number;
}
export interface Rule {
  ID: number; MatchType: string; Pattern: string; CategoryID: number; Priority: number; Source: string;
  IsActive: boolean;
}
```

- [ ] **Step 2: Write the failing test**

```tsx
// frontend/src/screens/Settings.categorization.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

const calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings") {
      if (init?.method === "PUT") {
        calls.push({ url, method: "PUT", body: JSON.parse(init.body as string) });
        return new Response("{}");
      }
      return new Response(JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85 }));
    }
    if (url === "/api/budget") return new Response(JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }));
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Settings /></ToastProvider></QueryClientProvider>);
}

describe("Settings categorization", () => {
  it("renders the auto-categorize switch reflecting current state", async () => {
    wrap();
    const toggle = await screen.findByLabelText(/auto-categorize/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("PUTs the new value when toggled off", async () => {
    wrap();
    const toggle = await screen.findByLabelText(/auto-categorize/i);
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && (c.body as { auto_categorize: boolean }).auto_categorize === false)).toBe(true));
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run src/screens/Settings.categorization.test.tsx`
Expected: FAIL — no `/auto-categorize/i` control yet.

- [ ] **Step 4: Implement the Categorization card + per-rule switch**

In `frontend/src/screens/Settings.tsx`, import the type and add a settings query + mutation. Near the other queries:

```tsx
import type { AppSettings } from "../api/types";
// ...
const settings = useQuery({ queryKey: ["settings"], queryFn: () => getJSON<AppSettings>("/api/settings") });
const saveSettings = async (next: AppSettings) => {
  try {
    await postJSON("/api/settings", next, "PUT");
    qc.invalidateQueries({ queryKey: ["settings"] });
  } catch { show({ message: "Couldn’t save settings", tone: "error" }); }
};
```

Add a Categorization `Card` (place it above the Categories→buckets card). The switches are plain checkboxes with associated labels (the test uses `getByLabelText`):

```tsx
{settings.data && (
  <Card>
    <p className="text-sm font-medium mb-3">Categorization</p>
    <label className="flex items-center justify-between gap-3 text-sm py-1.5">
      <span>Auto-categorize new transactions
        <span className="block text-xs text-muted">Off = everything waits in Needs review for you to categorize.</span>
      </span>
      <input type="checkbox" aria-label="Auto-categorize"
        checked={settings.data.auto_categorize}
        onChange={(e) => saveSettings({ ...settings.data!, auto_categorize: e.target.checked })} />
    </label>
    <label className="flex items-center justify-between gap-3 text-sm py-1.5">
      <span>AI suggestions
        <span className="block text-xs text-muted">Let AI propose a category when no rule matches.</span>
      </span>
      <input type="checkbox" aria-label="AI suggestions"
        checked={settings.data.ai_enabled}
        onChange={(e) => saveSettings({ ...settings.data!, ai_enabled: e.target.checked })} />
    </label>
    <label className="flex items-center justify-between gap-3 text-sm py-1.5">
      <span>AI auto-accept
        <span className="block text-xs text-muted">Auto-confirm confident AI suggestions instead of just suggesting.</span>
      </span>
      <input type="checkbox" aria-label="AI auto-accept"
        disabled={!settings.data.ai_enabled}
        checked={settings.data.ai_auto_accept}
        onChange={(e) => saveSettings({ ...settings.data!, ai_auto_accept: e.target.checked })} />
    </label>
  </Card>
)}
```

In the existing Rules card, add a per-rule active switch next to the delete button. The rules query type is now `Rule` with `IsActive`. Add a toggle handler and render a checkbox:

```tsx
const toggleRule = async (r: Rule) => {
  try {
    await postJSON(`/api/rules/${r.ID}/active`, { active: !r.IsActive }, "PUT");
    qc.invalidateQueries({ queryKey: ["rules"] });
  } catch { show({ message: "Couldn’t update rule", tone: "error" }); }
};
// ...inside the rules <li>, before the delete button:
<label className="flex items-center gap-1 text-xs text-muted">
  <input type="checkbox" aria-label={`Rule ${r.ID} active`} checked={r.IsActive} onChange={() => toggleRule(r)} />
  on
</label>
```

(Render disabled rules with reduced emphasis, e.g. add `className={r.IsActive ? "" : "opacity-50"}` to the `<li>`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run src/screens/Settings.categorization.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full suite + type-check**

Run: `bun run test` then `bunx tsc -b`
Expected: green; clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/screens/Settings.tsx frontend/src/screens/Settings.categorization.test.tsx
git commit -m "feat(pwa): Settings categorization toggles + per-rule enable switch"
```

---

### Task D2: build, verify, ship

**Files:** regenerates `internal/web/dist`.

- [ ] **Step 1: Full suites**

Run: `cd frontend && bun run test` (green) then `cd /root/Coding/ledger && go test ./...` (all ok).

- [ ] **Step 2: Build the bundle**

Run: `cd frontend && bun run build`
Expected: `tsc -b` clean; Vite writes `../internal/web/dist`.

- [ ] **Step 3: Go build + embed**

Run: `cd /root/Coding/ledger && go build ./... && go test ./internal/web/...`
Expected: clean.

- [ ] **Step 4: Isolated runtime smoke (settings + toggle behavior)**

```bash
cd /root/Coding/ledger
go build -o /tmp/ledger-smoke ./cmd/ledger
D=$(mktemp -d); LEDGER_LISTEN=127.0.0.1:8099 LEDGER_DATA_DIR="$D" /tmp/ledger-smoke >/tmp/smoke.log 2>&1 &
P=$!; sleep 1
echo "GET settings: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/settings)"
echo "PUT settings: $(curl -s -o /dev/null -w '%{http_code}' -X PUT http://127.0.0.1:8099/api/settings -d '{"auto_categorize":false,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85}')"
echo "settings now: $(curl -s http://127.0.0.1:8099/api/settings)"
kill $P; rm -rf "$D" /tmp/ledger-smoke
```
Expected: `200`, `200`, and the GET reflects `auto_categorize:false`.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
cd /root/Coding/ledger
git add internal/web/dist frontend
git commit -m "build(pwa): rebuild embedded dist with categorization toggles"
```

- [ ] **Step 6: Deploy (this box is prod — confirm with the user first)**

```bash
go build -o /tmp/ledger-new ./cmd/ledger
sudo install -m 0755 /tmp/ledger-new /usr/local/bin/ledger
sudo systemctl restart ledger.service
systemctl is-active ledger.service
curl -s http://127.0.0.1:8080/api/settings
```
Expected: `active`; settings JSON returned. Toggling auto-categorize off in the UI then means new transactions (next ingest poll) stay uncategorized in Needs review.

---

## Self-Review

**1. Spec coverage:**
- Global on/off → `app_settings.auto_categorize` (A1/A2) + processor skip (B1) + main wiring (B2) + `/api/settings` (C1) + Settings toggle (D1). ✅
- Per-rule (fine) → `rules.is_active` (A1/A3) + `SelectActiveRules` feeding the categorizer (B2) + `PUT /api/rules/{id}/active` (C2) + per-rule switch (D1). ✅
- AI opt-in suggestion only → `ai_enabled`/`ai_auto_accept`/`ai_threshold` mapped to `(ai, threshold, autoRule)` so AI suggests-but-doesn't-confirm unless explicitly auto-accepting (B2 + the semantics table). ✅
- "Rely on your own manual/rules-based categorization" → rules always win and are the default; AI off by default; auto-categorize default true so existing rule behavior is preserved. ✅

**2. Placeholder scan:** every code step has complete code; no "TBD"/"handle errors"/"similar to". The few "mirror the existing test helper / store-interface pattern" notes point at concrete files to copy from (server test construction, rules-store field) because those depend on repo-local scaffolding the engineer must read — each names the exact file. ✅

**3. Type/identifier consistency:**
- `store.AppSettings{AutoCategorize, AIEnabled, AIAutoAccept, AIThreshold}` is identical across A2, B2, C1. ✅
- JSON DTO keys (`auto_categorize`, `ai_enabled`, `ai_auto_accept`, `ai_threshold`) match the frontend `AppSettings` (D1). ✅
- `RuleRow.IsActive` (A3) ↔ `SelectActiveRules`/`SetRuleActive` (A3) ↔ provider mapping (B2) ↔ `Rule.IsActive` JSON (PascalCase, no tags) ↔ frontend `Rule.IsActive` (D1). ✅
- `NewProcessor`/`SetCategorizerProvider`/`resolveCategorizer`/`categorizeWith` defined in B1 and used in B2. ✅
- `SetSettingsStore`/`settingsStore`/`SettingsStore` (C1) and `SetRuleActiveStore`/`ruleActiveStore`/`RuleActiveStore` (C2) consistent across server.go + main.go. ✅

Gap found & resolved inline: the static `NewProcessorWithCategorizer` path is preserved (existing tests unaffected) because `resolveCategorizer` falls back to `p.categorizer` when no provider is set.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-15-categorization-toggle.md`.**
</content>
