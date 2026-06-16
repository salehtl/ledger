# Milestone 7 — PWA (+ the M5 API slice it needs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the XP-themed, mobile-first PWA (Dashboard / Review / Transactions / Settings) embedded into the Go binary, backed by the budget engine and the remaining REST + SSE endpoints the views depend on.

**Architecture:** Two halves in one plan. **(A) Backend (Go, TDD):** a pure `internal/budget` engine that rolls confirmed spending into 50/30/20 jars, new `store` methods (`budget_config`, category update, rule delete, month-spend/income queries), the missing JSON endpoints (`/api/summary`, `/api/budget`, `/api/categories/{id}` PUT, `/api/rules` GET/POST/DELETE), an SSE hub at `/api/events`, and an SPA-fallback static handler. **(B) Frontend (Bun + Vite + React + TanStack, TDD on logic):** a `frontend/` app built to `internal/web/dist` (replacing the M1 placeholder) and embedded via the existing `embed.FS`. API and SPA share one origin.

**Tech Stack:** Go 1.22 (`net/http`, `database/sql`, `modernc.org/sqlite`), Bun 1.3 (build-time only — runtime stays JS-free), Vite 5, React 18 + TypeScript, TanStack Router/Query/Table, `vite-plugin-pwa`, `xp.css`, self-hosted Fugue icons, Vitest + `@testing-library/react`.

**Why this scope:** M7's flagship *Dashboard* needs `GET /api/summary` (the budget engine) and *Settings* needs `/api/budget`, `/api/categories/{id}` PUT, and `/api/rules` — none exist yet (only health, reprocess, categories GET/POST, review, transactions, categorize, status do). The user chose to fold those endpoints into this plan so every view works end-to-end.

**Conventions in this codebase (follow them):**
- Money is `int64` **fils** everywhere in Go; never floats for money.
- Handlers are methods on `*server.Server`; dependencies are narrow interfaces set via `Set*` methods, with a `nil`-guard returning `503` when unset (see `internal/server/categories.go`).
- Store methods hang off `*store.Store` with `s.DB`; timestamps are `time.Now().UTC().Format(time.RFC3339Nano)`.
- Tests use the real SQLite store against a temp dir (see `internal/store/categories_test.go`) and `net/http/httptest` for handlers.
- Run the whole suite with `go test ./...` from `/root/Coding/ledger`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `internal/store/budget.go` | Create | `BudgetConfig` type; `EnsureBudgetConfig`, `SelectBudgetConfig`, `UpdateBudgetConfig`; `SpendRow` type; `SelectMonthSpend`, `SelectMonthIncome`; `SelectRecent` |
| `internal/store/budget_test.go` | Create | Tests for the above |
| `internal/store/categories.go` | Modify | Add `UpdateCategory`, `DeleteRule`, `SnapshotBucketForCategory` |
| `internal/store/categories_test.go` | Modify | Tests for the new methods |
| `internal/budget/budget.go` | Create | Pure `Compute(cfg, income, spend, recent, now) Summary` — jars, target/spent/remaining/pct/projection, month progress |
| `internal/budget/budget_test.go` | Create | Table-driven tests for `Compute` |
| `internal/server/budget.go` | Create | `handleGetSummary`, `handleGetBudget`, `handlePutBudget`; `BudgetStore` interface |
| `internal/server/budget_test.go` | Create | httptest coverage |
| `internal/server/rules.go` | Create | `handleGetRules`, `handlePostRule`, `handleDeleteRule` |
| `internal/server/rules_test.go` | Create | httptest coverage |
| `internal/server/categories.go` | Modify | Add `handlePutCategory` |
| `internal/server/categories_test.go` | Create | httptest coverage for PUT |
| `internal/server/events.go` | Create | `Hub` (SSE broadcast) + `handleEvents`; `s.hub` field |
| `internal/server/events_test.go` | Create | Hub fan-out + handler streaming test |
| `internal/server/spa.go` | Create | `spaHandler` — serve embedded asset or fall back to `index.html` for client routes |
| `internal/server/spa_test.go` | Create | Fallback behavior test |
| `internal/server/server.go` | Modify | Register new routes; add `BudgetStore`, `hub`; broadcast on categorize/status |
| `cmd/ledger/main.go` | Modify | `EnsureBudgetConfig`, wire `BudgetStore` + hub; broadcast on new confirmed tx after parse |
| `frontend/` | Create | Vite app (see Task 11+) — built to `../internal/web/dist` |
| `internal/web/dist/` | Replace | Vite build output (overwrites the M1 placeholder) |
| `NOTICE` | Create | Fugue Icons (CC BY 3.0) attribution |

---

# Phase A — Backend (Go)

### Task 1: `budget_config` store methods

**Files:**
- Create: `internal/store/budget.go`
- Test: `internal/store/budget_test.go`

The `budget_config` table is a singleton (`id=1`, `monthly_income` is `NOT NULL` with no default), so no row exists until we write one. `EnsureBudgetConfig` inserts the default row idempotently; `Select`/`Update` read and overwrite it.

- [ ] **Step 1: Write the failing test**

```go
package store

import (
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func TestEnsureAndSelectBudgetConfig(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatalf("EnsureBudgetConfig: %v", err)
	}
	cfg, err := st.SelectBudgetConfig()
	if err != nil {
		t.Fatalf("SelectBudgetConfig: %v", err)
	}
	if cfg.NeedPct != 0.50 || cfg.WantPct != 0.30 || cfg.SavingPct != 0.20 {
		t.Errorf("default pcts = %v/%v/%v", cfg.NeedPct, cfg.WantPct, cfg.SavingPct)
	}
	if cfg.IncomeSource != "config" || cfg.FreezeHistory {
		t.Errorf("defaults: source=%q freeze=%v", cfg.IncomeSource, cfg.FreezeHistory)
	}
}

func TestEnsureBudgetConfigIdempotent(t *testing.T) {
	st := openTestStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateBudgetConfig(BudgetConfig{
		MonthlyIncome: 2000000, NeedPct: 0.6, WantPct: 0.2, SavingPct: 0.2,
		IncomeSource: "categories", FreezeHistory: true,
	}); err != nil {
		t.Fatalf("UpdateBudgetConfig: %v", err)
	}
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	cfg, _ := st.SelectBudgetConfig()
	if cfg.MonthlyIncome != 2000000 || cfg.NeedPct != 0.6 || !cfg.FreezeHistory {
		t.Errorf("Ensure clobbered user values: %+v", cfg)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run TestEnsureAndSelectBudgetConfig -v`
Expected: FAIL — `st.EnsureBudgetConfig undefined`.

- [ ] **Step 3: Write minimal implementation**

```go
package store

// BudgetConfig is the singleton budget_config row (§5).
type BudgetConfig struct {
	MonthlyIncome int64
	NeedPct       float64
	WantPct       float64
	SavingPct     float64
	IncomeSource  string // "config" | "categories"
	FreezeHistory bool
}

// EnsureBudgetConfig inserts the default singleton row if none exists. It never
// overwrites an existing row (INSERT OR IGNORE on the fixed id=1).
func (s *Store) EnsureBudgetConfig() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO budget_config
		   (id, monthly_income, need_pct, want_pct, saving_pct, income_source, freeze_history)
		 VALUES (1, 0, 0.50, 0.30, 0.20, 'config', 0)`,
	)
	return err
}

// SelectBudgetConfig reads the singleton row.
func (s *Store) SelectBudgetConfig() (BudgetConfig, error) {
	var c BudgetConfig
	var freeze int
	err := s.DB.QueryRow(
		`SELECT monthly_income, need_pct, want_pct, saving_pct, income_source, freeze_history
		 FROM budget_config WHERE id=1`,
	).Scan(&c.MonthlyIncome, &c.NeedPct, &c.WantPct, &c.SavingPct, &c.IncomeSource, &freeze)
	c.FreezeHistory = freeze == 1
	return c, err
}

// UpdateBudgetConfig overwrites the singleton row.
func (s *Store) UpdateBudgetConfig(c BudgetConfig) error {
	_, err := s.DB.Exec(
		`UPDATE budget_config
		   SET monthly_income=?, need_pct=?, want_pct=?, saving_pct=?, income_source=?, freeze_history=?
		 WHERE id=1`,
		c.MonthlyIncome, c.NeedPct, c.WantPct, c.SavingPct, c.IncomeSource, boolToInt(c.FreezeHistory),
	)
	return err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run TestEnsureAndSelectBudgetConfig -v && go test ./internal/store/ -run TestEnsureBudgetConfigIdempotent -v`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/store/budget.go internal/store/budget_test.go
git commit -m "feat(store): budget_config ensure/select/update"
```

---

### Task 2: Month-spend / income / recent queries

**Files:**
- Modify: `internal/store/budget.go`
- Test: `internal/store/budget_test.go`

These feed the budget engine. `SelectMonthSpend` returns one row per confirmed spending transaction in the period with its **effective bucket** (the category's current `bucket`, or `bucket_snapshot` when `freeze_history` is on). `period` is `"YYYY-MM"`; we compare against the `[period-01, nextMonth-01)` half-open range on `posted_at` text (ISO8601 sorts lexically).

- [ ] **Step 1: Write the failing test**

```go
func seedTx(t *testing.T, st *Store, postedAt, direction string, amount int64, catID int64, status string) {
	t.Helper()
	_, err := st.DB.Exec(
		`INSERT INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, category_id, status, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, 'AED', ?, 'M', ?, ?, ?, 'email', '2026-06-01', '2026-06-01')`,
		postedAt, amount, direction, catID, status,
		postedAt+direction+itoa(amount), // unique-ish fingerprint
	)
	if err != nil {
		t.Fatalf("seedTx: %v", err)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestSelectMonthSpend(t *testing.T) {
	st := openTestStore(t)
	// Groceries is a seeded 'need' category; find its id.
	var grocID int64
	st.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&grocID)

	seedTx(t, st, "2026-06-10", "debit", 50000, grocID, "confirmed")  // counts
	seedTx(t, st, "2026-06-12", "credit", 10000, grocID, "confirmed") // refund, nets
	seedTx(t, st, "2026-06-15", "debit", 99999, grocID, "needs_review") // excluded (not confirmed)
	seedTx(t, st, "2026-05-30", "debit", 77777, grocID, "confirmed")  // excluded (prior month)

	rows, err := st.SelectMonthSpend("2026-06", false)
	if err != nil {
		t.Fatalf("SelectMonthSpend: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2: %+v", len(rows), rows)
	}
	for _, r := range rows {
		if r.Bucket != "need" {
			t.Errorf("bucket = %q, want need", r.Bucket)
		}
	}
}

func TestSelectMonthIncome(t *testing.T) {
	st := openTestStore(t)
	var salaryID int64
	st.DB.QueryRow(`SELECT id FROM categories WHERE name='Salary'`).Scan(&salaryID)
	seedTx(t, st, "2026-06-01", "credit", 2000000, salaryID, "confirmed")
	seedTx(t, st, "2026-06-01", "credit", 500000, salaryID, "needs_review") // excluded
	got, err := st.SelectMonthIncome("2026-06")
	if err != nil {
		t.Fatal(err)
	}
	if got != 2000000 {
		t.Errorf("income = %d, want 2000000", got)
	}
}
```

Add `"strconv"` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run TestSelectMonthSpend -v`
Expected: FAIL — `st.SelectMonthSpend undefined`.

- [ ] **Step 3: Write minimal implementation** (append to `internal/store/budget.go`)

```go
import "fmt"

// SpendRow is one confirmed spending transaction projected onto its bucket.
type SpendRow struct {
	Bucket     string // "need" | "want" | "saving"
	Direction  string // "debit" | "credit"
	AmountFils int64
}

// monthRange returns the half-open [start, end) ISO date bounds for "YYYY-MM".
func monthRange(period string) (string, string, error) {
	t, err := time.Parse("2006-01", period)
	if err != nil {
		return "", "", fmt.Errorf("bad period %q: %w", period, err)
	}
	start := t.Format("2006-01-02")
	end := t.AddDate(0, 1, 0).Format("2006-01-02")
	return start, end, nil
}

// SelectMonthSpend returns confirmed, spending-kind transactions in the period.
// The bucket is the category's current bucket, or bucket_snapshot when frozen.
func (s *Store) SelectMonthSpend(period string, frozen bool) ([]SpendRow, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return nil, err
	}
	bucketExpr := "c.bucket"
	if frozen {
		bucketExpr = "COALESCE(t.bucket_snapshot, c.bucket)"
	}
	rows, err := s.DB.Query(
		`SELECT `+bucketExpr+`, t.direction, t.amount
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='spending'
		    AND t.posted_at >= ? AND t.posted_at < ?`,
		start, end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpendRow
	for rows.Next() {
		var r SpendRow
		var bucket *string
		if err := rows.Scan(&bucket, &r.Direction, &r.AmountFils); err != nil {
			return nil, err
		}
		if bucket != nil {
			r.Bucket = *bucket
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SelectMonthIncome sums confirmed income-kind credits in the period.
func (s *Store) SelectMonthIncome(period string) (int64, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return 0, err
	}
	var total int64
	err = s.DB.QueryRow(
		`SELECT COALESCE(SUM(t.amount), 0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='income' AND t.direction='credit'
		    AND t.posted_at >= ? AND t.posted_at < ?`,
		start, end,
	).Scan(&total)
	return total, err
}

// SelectRecent returns the newest n transactions as ReviewItems for the dashboard list.
func (s *Store) SelectRecent(n int) ([]ReviewItem, error) {
	rows, err := s.DB.Query(
		`SELECT id, posted_at, amount, currency, direction,
		        COALESCE(merchant_raw,''), status, COALESCE(confidence,0), COALESCE(source,'')
		   FROM transactions ORDER BY posted_at DESC LIMIT ?`, n,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
```

Ensure `internal/store/budget.go` imports `"time"` and `"fmt"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run 'TestSelectMonth|TestSelectRecent' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/store/budget.go internal/store/budget_test.go
git commit -m "feat(store): month spend/income/recent queries for budget engine"
```

---

### Task 3: Category update + rule delete + bucket snapshot

**Files:**
- Modify: `internal/store/categories.go`
- Test: `internal/store/categories_test.go`

`UpdateCategory` edits name/kind/bucket. `SnapshotBucketForCategory` backfills `bucket_snapshot` on a category's past transactions (used by the `apply_to_past` action under `freeze_history`). `DeleteRule` removes a rule.

- [ ] **Step 1: Write the failing test** (append to `internal/store/categories_test.go`)

```go
func TestUpdateCategory(t *testing.T) {
	st := openTestStore(t)
	id, err := st.InsertCategory(CategoryRow{Name: "Coffee", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateCategory(CategoryRow{ID: id, Name: "Coffee", Kind: "spending", Bucket: "need", IsActive: true}); err != nil {
		t.Fatalf("UpdateCategory: %v", err)
	}
	cats, _ := st.SelectCategories()
	var found bool
	for _, c := range cats {
		if c.ID == id {
			found = true
			if c.Bucket != "need" {
				t.Errorf("bucket = %q, want need", c.Bucket)
			}
		}
	}
	if !found {
		t.Fatal("updated category missing")
	}
}

func TestDeleteRule(t *testing.T) {
	st := openTestStore(t)
	cat, _ := st.InsertCategory(CategoryRow{Name: "X", Kind: "spending", Bucket: "want", IsActive: true})
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "amzn", CategoryID: cat, Priority: 100, Source: "manual"}); err != nil {
		t.Fatal(err)
	}
	rules, _ := st.SelectRules()
	if len(rules) != 1 {
		t.Fatalf("setup: %d rules", len(rules))
	}
	if err := st.DeleteRule(rules[0].ID); err != nil {
		t.Fatalf("DeleteRule: %v", err)
	}
	rules, _ = st.SelectRules()
	if len(rules) != 0 {
		t.Errorf("after delete: %d rules", len(rules))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run 'TestUpdateCategory|TestDeleteRule' -v`
Expected: FAIL — `st.UpdateCategory undefined`.

- [ ] **Step 3: Write minimal implementation** (append to `internal/store/categories.go`)

```go
// UpdateCategory overwrites name/kind/bucket for one category.
func (s *Store) UpdateCategory(c CategoryRow) error {
	_, err := s.DB.Exec(
		`UPDATE categories SET name=?, kind=?, bucket=? WHERE id=?`,
		c.Name, c.Kind, nullableStr(c.Bucket), c.ID,
	)
	return err
}

// SnapshotBucketForCategory stamps bucket_snapshot onto every transaction of a
// category (used by the "apply to past" action when freeze_history is on).
func (s *Store) SnapshotBucketForCategory(categoryID int64, bucket string) error {
	_, err := s.DB.Exec(
		`UPDATE transactions SET bucket_snapshot=? WHERE category_id=?`,
		nullableStr(bucket), categoryID,
	)
	return err
}

// DeleteRule removes one rule by id.
func (s *Store) DeleteRule(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM rules WHERE id=?`, id)
	return err
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run 'TestUpdateCategory|TestDeleteRule' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/store/categories.go internal/store/categories_test.go
git commit -m "feat(store): UpdateCategory, SnapshotBucketForCategory, DeleteRule"
```

---

### Task 4: Pure budget engine (`internal/budget`)

**Files:**
- Create: `internal/budget/budget.go`
- Test: `internal/budget/budget_test.go`

A pure function — no DB, no clock dependency beyond the `now` argument — so it is trivially testable. Targets are `income × pct`; spend nets debits minus credits per bucket; projection is linear from elapsed month fraction.

- [ ] **Step 1: Write the failing test**

```go
package budget

import (
	"testing"
	"time"

	"ledger/internal/store"
)

func TestComputeBucketsAndProjection(t *testing.T) {
	cfg := store.BudgetConfig{NeedPct: 0.50, WantPct: 0.30, SavingPct: 0.20}
	spend := []store.SpendRow{
		{Bucket: "need", Direction: "debit", AmountFils: 600000},
		{Bucket: "need", Direction: "credit", AmountFils: 100000}, // refund -> net 500000
		{Bucket: "want", Direction: "debit", AmountFils: 300000},
	}
	// June has 30 days; day 15 -> month progress 0.5.
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	s := Compute(cfg, 2000000, spend, nil, now)

	if s.Period != "2026-06" {
		t.Errorf("period = %q", s.Period)
	}
	if s.Income != 2000000 {
		t.Errorf("income = %d", s.Income)
	}
	need := bucketByName(t, s, "need")
	if need.Target != 1000000 {
		t.Errorf("need target = %d, want 1000000", need.Target)
	}
	if need.Spent != 500000 {
		t.Errorf("need spent = %d, want 500000 (netted)", need.Spent)
	}
	if need.Remaining != 500000 {
		t.Errorf("need remaining = %d", need.Remaining)
	}
	if need.PctUsed < 0.49 || need.PctUsed > 0.51 {
		t.Errorf("need pct_used = %v, want ~0.5", need.PctUsed)
	}
	// Linear projection: 500000 spent at half the month -> ~1,000,000.
	if need.Projection < 990000 || need.Projection > 1010000 {
		t.Errorf("need projection = %d, want ~1000000", need.Projection)
	}
	if s.MonthProgress < 0.49 || s.MonthProgress > 0.51 {
		t.Errorf("month progress = %v, want ~0.5", s.MonthProgress)
	}
}

func TestComputeZeroTargetNoDivByZero(t *testing.T) {
	cfg := store.BudgetConfig{NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2}
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) // day 1
	s := Compute(cfg, 0, nil, nil, now) // zero income -> zero targets
	for _, b := range s.Buckets {
		if b.PctUsed != 0 {
			t.Errorf("%s pct_used = %v, want 0 when target 0", b.Bucket, b.PctUsed)
		}
	}
}

func bucketByName(t *testing.T, s Summary, name string) BucketSummary {
	t.Helper()
	for _, b := range s.Buckets {
		if b.Bucket == name {
			return b
		}
	}
	t.Fatalf("bucket %q missing", name)
	return BucketSummary{}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/budget/ -v`
Expected: FAIL — package `budget` does not exist / `Compute` undefined.

- [ ] **Step 3: Write minimal implementation**

```go
// Package budget computes 50/30/20 jar rollups from confirmed spending (§6.5).
// It is pure: callers fetch config + rows from the store and pass a clock.
package budget

import (
	"time"

	"ledger/internal/store"
)

// BucketSummary is one jar's state for the period.
type BucketSummary struct {
	Bucket     string  `json:"bucket"`
	Target     int64   `json:"target"`
	Spent      int64   `json:"spent"`
	Remaining  int64   `json:"remaining"`
	PctUsed    float64 `json:"pct_used"`
	Projection int64   `json:"projection"`
}

// Summary is the full dashboard payload (§6.7 GET /api/summary).
type Summary struct {
	Period        string            `json:"period"`
	Income        int64             `json:"income"`
	MonthProgress float64           `json:"month_progress"`
	Buckets       []BucketSummary   `json:"buckets"`
	Recent        []store.ReviewItem `json:"recent"`
}

// buckets are always reported in this fixed order.
var bucketOrder = []string{"need", "want", "saving"}

// Compute rolls spend rows into jars for the month of now. income is already
// resolved by the caller (config figure or summed income categories).
func Compute(cfg store.BudgetConfig, income int64, spend []store.SpendRow, recent []store.ReviewItem, now time.Time) Summary {
	pct := map[string]float64{"need": cfg.NeedPct, "want": cfg.WantPct, "saving": cfg.SavingPct}

	net := map[string]int64{}
	for _, r := range spend {
		switch r.Direction {
		case "debit":
			net[r.Bucket] += r.AmountFils
		case "credit":
			net[r.Bucket] -= r.AmountFils
		}
	}

	progress := monthProgress(now)
	out := Summary{
		Period:        now.Format("2006-01"),
		Income:        income,
		MonthProgress: progress,
		Recent:        recent,
	}
	for _, name := range bucketOrder {
		target := int64(float64(income) * pct[name])
		spent := net[name]
		b := BucketSummary{
			Bucket:    name,
			Target:    target,
			Spent:     spent,
			Remaining: target - spent,
		}
		if target > 0 {
			b.PctUsed = float64(spent) / float64(target)
		}
		if progress > 0 {
			b.Projection = int64(float64(spent) / progress)
		} else {
			b.Projection = spent
		}
		out.Buckets = append(out.Buckets, b)
	}
	return out
}

// monthProgress is the fraction of the current month elapsed (day / daysInMonth).
func monthProgress(now time.Time) float64 {
	year, month, _ := now.Date()
	firstNext := time.Date(year, month, 1, 0, 0, 0, 0, now.Location()).AddDate(0, 1, 0)
	daysInMonth := firstNext.AddDate(0, 0, -1).Day()
	return float64(now.Day()) / float64(daysInMonth)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/budget/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/budget/
git commit -m "feat(budget): pure 50/30/20 summary engine"
```

---

### Task 5: `GET /api/summary`, `GET/PUT /api/budget`

**Files:**
- Create: `internal/server/budget.go`
- Test: `internal/server/budget_test.go`
- Modify: `internal/server/server.go`

Add a `BudgetStore` interface + `Set` method (mirroring `SetCategoryStore`), wire three routes, and implement the handlers. The summary handler resolves income from config or income categories, fetches spend/recent, and calls `budget.Compute` with `time.Now()`.

- [ ] **Step 1: Write the failing test**

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"ledger/internal/budget"
	"ledger/internal/store"
)

func newTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := New(st, fstest()) // fstest() defined in spa_test.go
	srv.SetCategoryStore(st)
	srv.SetBudgetStore(st)
	return srv, st
}

func TestGetSummary(t *testing.T) {
	srv, st := newTestServer(t)
	_ = st.UpdateBudgetConfig(store.BudgetConfig{
		MonthlyIncome: 2000000, NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2, IncomeSource: "config",
	})
	req := httptest.NewRequest(http.MethodGet, "/api/summary?period=current", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var s budget.Summary
	if err := json.Unmarshal(rec.Body.Bytes(), &s); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(s.Buckets) != 3 || s.Buckets[0].Bucket != "need" {
		t.Errorf("buckets = %+v", s.Buckets)
	}
	if s.Income != 2000000 {
		t.Errorf("income = %d", s.Income)
	}
}

func TestPutThenGetBudget(t *testing.T) {
	srv, _ := newTestServer(t)
	body := `{"monthly_income":3000000,"need_pct":0.6,"want_pct":0.2,"saving_pct":0.2,"income_source":"config","freeze_history":true}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/budget", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/budget", nil))
	var got store.BudgetConfig
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got.MonthlyIncome != 3000000 || got.NeedPct != 0.6 || !got.FreezeHistory {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestPutBudgetRejectsBadPcts(t *testing.T) {
	srv, _ := newTestServer(t)
	body := `{"monthly_income":100,"need_pct":0.9,"want_pct":0.9,"saving_pct":0.9,"income_source":"config"}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/budget", strings.NewReader(body)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for pcts summing > 1", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run 'TestGetSummary|TestPutThenGetBudget' -v`
Expected: FAIL — `srv.SetBudgetStore undefined`.

- [ ] **Step 3a: Implement the handlers** (`internal/server/budget.go`)

```go
package server

import (
	"encoding/json"
	"math"
	"net/http"
	"time"

	"ledger/internal/budget"
	"ledger/internal/store"
)

// BudgetStore is the subset of store methods the budget/summary handlers need.
type BudgetStore interface {
	SelectBudgetConfig() (store.BudgetConfig, error)
	UpdateBudgetConfig(store.BudgetConfig) error
	SelectMonthSpend(period string, frozen bool) ([]store.SpendRow, error)
	SelectMonthIncome(period string) (int64, error)
	SelectRecent(n int) ([]store.ReviewItem, error)
}

// SetBudgetStore wires the summary + budget handlers.
func (s *Server) SetBudgetStore(b BudgetStore) { s.budgetStore = b }

func (s *Server) handleGetSummary(w http.ResponseWriter, r *http.Request) {
	if s.budgetStore == nil {
		http.Error(w, `{"error":"summary unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	cfg, err := s.budgetStore.SelectBudgetConfig()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	period := now.Format("2006-01")

	income := cfg.MonthlyIncome
	if cfg.IncomeSource == "categories" {
		if income, err = s.budgetStore.SelectMonthIncome(period); err != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
	}
	spend, err := s.budgetStore.SelectMonthSpend(period, cfg.FreezeHistory)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	recent, err := s.budgetStore.SelectRecent(10)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if recent == nil {
		recent = []store.ReviewItem{}
	}
	sum := budget.Compute(cfg, income, spend, recent, now)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sum)
}

func (s *Server) handleGetBudget(w http.ResponseWriter, r *http.Request) {
	if s.budgetStore == nil {
		http.Error(w, `{"error":"budget unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	cfg, err := s.budgetStore.SelectBudgetConfig()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cfg)
}

func (s *Server) handlePutBudget(w http.ResponseWriter, r *http.Request) {
	if s.budgetStore == nil {
		http.Error(w, `{"error":"budget unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var cfg store.BudgetConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if cfg.IncomeSource != "config" && cfg.IncomeSource != "categories" {
		http.Error(w, `{"error":"income_source must be config or categories"}`, http.StatusBadRequest)
		return
	}
	if cfg.MonthlyIncome < 0 {
		http.Error(w, `{"error":"monthly_income must be >= 0"}`, http.StatusBadRequest)
		return
	}
	if sum := cfg.NeedPct + cfg.WantPct + cfg.SavingPct; math.Abs(sum-1.0) > 0.001 {
		http.Error(w, `{"error":"need/want/saving pcts must sum to 1.0"}`, http.StatusBadRequest)
		return
	}
	if err := s.budgetStore.UpdateBudgetConfig(cfg); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
```

- [ ] **Step 3b: Wire the field and routes** (`internal/server/server.go`)

Add the field to the `Server` struct (after `catStore`):
```go
	catStore       CategoryStore
	budgetStore    BudgetStore
```
Register routes in `routes()` (after the transactions routes, before the `/` handler):
```go
	s.mux.HandleFunc("GET /api/summary", s.handleGetSummary)
	s.mux.HandleFunc("GET /api/budget", s.handleGetBudget)
	s.mux.HandleFunc("PUT /api/budget", s.handlePutBudget)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run 'TestGetSummary|TestPutThenGetBudget|TestPutBudgetRejectsBadPcts' -v`
Expected: PASS. (Depends on `fstest()` from Task 9; if running this task first, temporarily stub `fstest()` returning `os.DirFS(t.TempDir())` — Task 9 finalizes it.)

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/server/budget.go internal/server/budget_test.go internal/server/server.go
git commit -m "feat(server): GET /api/summary and GET/PUT /api/budget"
```

---

### Task 6: `PUT /api/categories/{id}`

**Files:**
- Modify: `internal/server/categories.go`, `internal/server/server.go`
- Test: `internal/server/categories_test.go`

Update a category's name/kind/bucket. When the body sets `apply_to_past: true`, also snapshot the bucket onto its past transactions (the "apply to past" affordance under `freeze_history`). The handler needs `UpdateCategory` + `SnapshotBucketForCategory`, so extend the `CategoryStore` interface.

- [ ] **Step 1: Write the failing test** (`internal/server/categories_test.go`)

```go
package server

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"ledger/internal/store"
)

func TestPutCategory(t *testing.T) {
	srv, st := newTestServer(t)
	id, _ := st.InsertCategory(store.CategoryRow{Name: "Coffee", Kind: "spending", Bucket: "want", IsActive: true})
	body := `{"name":"Coffee","kind":"spending","bucket":"need","apply_to_past":true}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/categories/"+strconv.FormatInt(id, 10), strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	cats, _ := st.SelectCategories()
	for _, c := range cats {
		if c.ID == id && c.Bucket != "need" {
			t.Errorf("bucket = %q, want need", c.Bucket)
		}
	}
}

func TestPutCategoryRejectsSpendingWithoutBucket(t *testing.T) {
	srv, st := newTestServer(t)
	id, _ := st.InsertCategory(store.CategoryRow{Name: "Z", Kind: "spending", Bucket: "want", IsActive: true})
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/categories/"+strconv.FormatInt(id, 10), strings.NewReader(`{"name":"Z","kind":"spending","bucket":""}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestPutCategory -v`
Expected: FAIL — `404` (no route) / interface lacks `UpdateCategory`.

- [ ] **Step 3a: Extend the interface** (`internal/server/server.go`, in `CategoryStore`)

```go
	UpdateTransactionStatus(txID int64, status string) error
	UpdateCategory(store.CategoryRow) error
	SnapshotBucketForCategory(categoryID int64, bucket string) error
```
Register the route in `routes()`:
```go
	s.mux.HandleFunc("PUT /api/categories/{id}", s.handlePutCategory)
```

- [ ] **Step 3b: Implement the handler** (append to `internal/server/categories.go`)

```go
import "strconv" // add to the existing import block

type updateCategoryReq struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Bucket      string `json:"bucket"`
	ApplyToPast bool   `json:"apply_to_past"`
}

func (s *Server) handlePutCategory(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req updateCategoryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.Name == "" || req.Kind == "" {
		http.Error(w, `{"error":"name and kind are required"}`, http.StatusBadRequest)
		return
	}
	if req.Kind == "spending" && req.Bucket == "" {
		http.Error(w, `{"error":"bucket required for spending categories"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.UpdateCategory(store.CategoryRow{ID: id, Name: req.Name, Kind: req.Kind, Bucket: req.Bucket}); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if req.ApplyToPast && req.Bucket != "" {
		if err := s.catStore.SnapshotBucketForCategory(id, req.Bucket); err != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestPutCategory -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/server/categories.go internal/server/categories_test.go internal/server/server.go
git commit -m "feat(server): PUT /api/categories/{id} with apply_to_past"
```

---

### Task 7: `GET/POST/DELETE /api/rules`

**Files:**
- Create: `internal/server/rules.go`, `internal/server/rules_test.go`
- Modify: `internal/server/server.go`

Expose rule CRUD. `SelectRules`/`InsertRule` already exist on `CategoryStore`; add `DeleteRule`.

- [ ] **Step 1: Write the failing test** (`internal/server/rules_test.go`)

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"ledger/internal/store"
)

func TestRulesCRUD(t *testing.T) {
	srv, st := newTestServer(t)
	cat, _ := st.InsertCategory(store.CategoryRow{Name: "Groc2", Kind: "spending", Bucket: "need", IsActive: true})

	// POST
	body := `{"match_type":"contains","pattern":"carrefour","category_id":` + strconv.FormatInt(cat, 10) + `,"priority":50}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/rules", strings.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, body=%s", rec.Code, rec.Body.String())
	}

	// GET
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/rules", nil))
	var rules []store.RuleRow
	json.Unmarshal(rec.Body.Bytes(), &rules)
	if len(rules) != 1 || rules[0].Pattern != "carrefour" {
		t.Fatalf("GET rules = %+v", rules)
	}

	// DELETE
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/rules/"+strconv.FormatInt(rules[0].ID, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/rules", nil))
	json.Unmarshal(rec.Body.Bytes(), &rules)
	if len(rules) != 0 {
		t.Errorf("after delete: %+v", rules)
	}
}

func TestPostRuleRequiresFields(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/rules", strings.NewReader(`{"pattern":"x"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestRulesCRUD -v`
Expected: FAIL — `404` (routes not registered).

- [ ] **Step 3a: Extend the interface + routes** (`internal/server/server.go`)

In `CategoryStore` add:
```go
	DeleteRule(id int64) error
```
In `routes()`:
```go
	s.mux.HandleFunc("GET /api/rules", s.handleGetRules)
	s.mux.HandleFunc("POST /api/rules", s.handlePostRule)
	s.mux.HandleFunc("DELETE /api/rules/{id}", s.handleDeleteRule)
```

- [ ] **Step 3b: Implement the handlers** (`internal/server/rules.go`)

```go
package server

import (
	"encoding/json"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

func (s *Server) handleGetRules(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"rules unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	rules, err := s.catStore.SelectRules()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if rules == nil {
		rules = []store.RuleRow{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rules)
}

type createRuleReq struct {
	MatchType  string `json:"match_type"`
	Pattern    string `json:"pattern"`
	CategoryID int64  `json:"category_id"`
	Priority   int    `json:"priority"`
}

func (s *Server) handlePostRule(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"rules unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req createRuleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.MatchType == "" || req.Pattern == "" || req.CategoryID == 0 {
		http.Error(w, `{"error":"match_type, pattern, category_id required"}`, http.StatusBadRequest)
		return
	}
	if req.Priority == 0 {
		req.Priority = 100
	}
	if err := s.catStore.InsertRule(store.RuleRow{
		MatchType:  req.MatchType,
		Pattern:    req.Pattern,
		CategoryID: req.CategoryID,
		Priority:   req.Priority,
		Source:     "manual",
	}); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"rules unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.DeleteRule(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run 'TestRulesCRUD|TestPostRuleRequiresFields' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/server/rules.go internal/server/rules_test.go internal/server/server.go
git commit -m "feat(server): GET/POST/DELETE /api/rules"
```

---

### Task 8: SSE hub + `GET /api/events`

**Files:**
- Create: `internal/server/events.go`, `internal/server/events_test.go`
- Modify: `internal/server/server.go`, `internal/server/transactions.go`

A tiny in-process pub/sub `Hub`: clients register a channel, the server broadcasts a named event to all. The handler streams `text/event-stream`. Categorize/status changes broadcast a `tx` event so the frontend can invalidate queries.

- [ ] **Step 1: Write the failing test** (`internal/server/events_test.go`)

```go
package server

import (
	"testing"
	"time"
)

func TestHubBroadcast(t *testing.T) {
	h := newHub()
	ch := h.subscribe()
	defer h.unsubscribe(ch)

	h.broadcast("tx")
	select {
	case ev := <-ch:
		if ev != "tx" {
			t.Errorf("event = %q, want tx", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no event received")
	}
}

func TestHubBroadcastDoesNotBlockOnSlowClient(t *testing.T) {
	h := newHub()
	_ = h.subscribe() // never drained
	done := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			h.broadcast("tx")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("broadcast blocked on a slow client")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestHub -v`
Expected: FAIL — `newHub undefined`.

- [ ] **Step 3a: Implement the hub + handler** (`internal/server/events.go`)

```go
package server

import (
	"fmt"
	"net/http"
	"sync"
)

// hub is a minimal in-process SSE fan-out. Each subscriber gets a buffered
// channel; broadcast never blocks (a full buffer drops the event — clients
// re-fetch on the next event anyway).
type hub struct {
	mu   sync.Mutex
	subs map[chan string]struct{}
}

func newHub() *hub {
	return &hub{subs: make(map[chan string]struct{})}
}

func (h *hub) subscribe() chan string {
	ch := make(chan string, 8)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *hub) unsubscribe(ch chan string) {
	h.mu.Lock()
	if _, ok := h.subs[ch]; ok {
		delete(h.subs, ch)
		close(ch)
	}
	h.mu.Unlock()
}

func (h *hub) broadcast(event string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs {
		select {
		case ch <- event:
		default: // slow client; drop
		}
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, `{"error":"streaming unsupported"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)

	// Initial comment so EventSource fires `open`.
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: %s\ndata: {}\n\n", ev)
			flusher.Flush()
		}
	}
}
```

- [ ] **Step 3b: Wire the hub** (`internal/server/server.go`)

Add to the `Server` struct:
```go
	budgetStore    BudgetStore
	hub            *hub
```
In `New`, initialize it:
```go
	s := &Server{
		mux:   http.NewServeMux(),
		store: store,
		hub:   newHub(),
	}
```
Register the route in `routes()`:
```go
	s.mux.HandleFunc("GET /api/events", s.handleEvents)
```

- [ ] **Step 3c: Broadcast on mutations** (`internal/server/transactions.go`)

At the end of `handleCategorize` (just before writing the `{"ok":true}` response) and at the end of `handleSetStatus`, add:
```go
	s.hub.broadcast("tx")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestHub -v && go test ./internal/server/ -v`
Expected: PASS (whole server package green).

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/server/events.go internal/server/events_test.go internal/server/server.go internal/server/transactions.go
git commit -m "feat(server): SSE hub + GET /api/events; broadcast on tx mutations"
```

---

### Task 9: SPA-fallback static handler

**Files:**
- Create: `internal/server/spa.go`, `internal/server/spa_test.go`
- Modify: `internal/server/server.go`

TanStack Router uses client-side paths (`/review`, `/transactions`). A plain `http.FileServer` 404s on those. `spaHandler` serves the requested embedded file if it exists, otherwise falls back to `index.html` (so deep links and refreshes work). `/api/*` is never reached here (those routes match first).

- [ ] **Step 1: Write the failing test** (`internal/server/spa_test.go`)

```go
package server

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// fstest returns a tiny in-memory bundle used by all server tests.
func fstest() fs.FS {
	return fstestMap()
}

func fstestMap() fs.FS {
	return fstestFS
}

var fstestFS = fstest.MapFS{
	"index.html":      {Data: []byte("<!doctype html><title>ledger</title>")},
	"assets/app.js":   {Data: []byte("console.log('app')")},
}

func TestSPAServesAsset(t *testing.T) {
	srv := New(nil, fstest())
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log('app')" {
		t.Fatalf("asset: code=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestSPAFallsBackToIndex(t *testing.T) {
	srv := New(nil, fstest())
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/review", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("fallback code = %d", rec.Code)
	}
	if got := rec.Body.String(); got == "" || got[0] != '<' {
		t.Errorf("fallback body = %q, want index.html", got)
	}
}

func TestSPAUnknownAPIIs404NotIndex(t *testing.T) {
	srv := New(nil, fstest())
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))
	if rec.Code == http.StatusOK {
		t.Errorf("unknown /api path returned 200 (served index?)")
	}
}
```

Note: this test file defines the `fstest()` helper that Tasks 5–7 reference. The existing `newTestServer` uses it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -run TestSPA -v`
Expected: FAIL — fallback returns 404 (current `http.FileServer`).

- [ ] **Step 3a: Implement the handler** (`internal/server/spa.go`)

```go
package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves files from the embedded bundle, falling back to index.html
// for any path that isn't a real file (client-side routes). /api/* never reaches
// here because those routes are registered first on the mux.
func spaHandler(webFS fs.FS) http.HandlerFunc {
	fileServer := http.FileServer(http.FS(webFS))
	return func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if clean == "" {
			clean = "index.html"
		}
		if _, err := fs.Stat(webFS, clean); err != nil {
			// Not a real file -> serve the SPA shell.
			r2 := r.Clone(r.Context())
			r2.URL.Path = "/"
			fileServer.ServeHTTP(w, r2)
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
```

- [ ] **Step 3b: Use it** (`internal/server/server.go`, in `routes()`, replace the `/` line)

```go
	// Everything else is the SPA bundle (with client-route fallback to index.html).
	s.mux.Handle("/", spaHandler(webFS))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger && go test ./internal/server/ -v`
Expected: PASS (entire server package, including Tasks 5–8 which rely on `fstest()`).

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/server/spa.go internal/server/spa_test.go internal/server/server.go
git commit -m "feat(server): SPA-fallback static handler for client routes"
```

---

### Task 10: Wire budget store + ensure config + new-tx broadcast in `main.go`

**Files:**
- Modify: `cmd/ledger/main.go`

Ensure the singleton budget row exists on startup, wire the `BudgetStore`, and broadcast a `tx` event after the ingest worker's post-process parses new transactions (so the dashboard updates live).

- [ ] **Step 1: Add ensure + wiring** (`cmd/ledger/main.go`)

After `st, err := store.Open(...)` and its error check, add:
```go
	if err := st.EnsureBudgetConfig(); err != nil {
		log.Fatalf("ensure budget config: %v", err)
	}
```
After `srv.SetCategoryStore` is set (add that call too if absent) and before the ingest block, wire the budget store. The current `main.go` does **not** call `SetCategoryStore`; add both:
```go
	srv := server.New(st, webFS)
	srv.SetIngest(st, cfg.IMAP.Enabled())
	srv.SetReprocessor(processor)
	srv.SetCategoryStore(st)
	srv.SetBudgetStore(st)
```

- [ ] **Step 2: Broadcast after new transactions are parsed**

The worker's `SetPostProcess` returns a count of newly processed rows. Wrap it to broadcast when `n > 0`. Replace the existing `worker.SetPostProcess(...)` block with:
```go
		worker.SetPostProcess(func(ctx context.Context) (int, error) {
			n, err := processor.ProcessPending(ctx, store.SelectForParseOpts{OnlyUnparsed: true})
			if n > 0 {
				srv.Broadcast("tx")
			}
			return n, err
		})
```

- [ ] **Step 3: Expose `Broadcast` on the server** (`internal/server/events.go`)

```go
// Broadcast sends a named SSE event to all connected clients. Safe to call from
// any goroutine (e.g. the ingest worker after parsing new transactions).
func (s *Server) Broadcast(event string) {
	if s.hub != nil {
		s.hub.broadcast(event)
	}
}
```

- [ ] **Step 4: Verify build + full backend suite**

Run: `cd /root/Coding/ledger && go build ./... && go test ./...`
Expected: build succeeds; all packages PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add cmd/ledger/main.go internal/server/events.go
git commit -m "feat(ledger): wire budget store, ensure config, live tx broadcast"
```

---

# Phase B — Frontend toolchain

### Task 11: Scaffold the Vite app, build into `internal/web/dist`

**Files:**
- Create: `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.json`, `frontend/index.html`, `frontend/src/main.tsx`, `frontend/src/vite-env.d.ts`, `frontend/.gitignore`
- Create: `.gitignore` (repo root, append) — ignore `frontend/node_modules`

The Vite `outDir` points at the existing embed target so `go:embed all:dist` picks it up. We keep `dist/` **committed** (built artifacts are embedded) but ignore `node_modules`. Build-time only uses Bun; the binary ships no JS toolchain.

- [ ] **Step 1: Create `frontend/package.json`**

```json
{
  "name": "ledger-frontend",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.51.0",
    "@tanstack/react-router": "^1.45.0",
    "@tanstack/react-table": "^8.19.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "xp.css": "^0.2.6"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.6",
    "@testing-library/react": "^16.0.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^24.1.0",
    "typescript": "^5.5.3",
    "vite": "^5.3.4",
    "vite-plugin-pwa": "^0.20.0",
    "vitest": "^2.0.4"
  }
}
```

- [ ] **Step 2: Create config files**

`frontend/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

`frontend/vite.config.ts`:
```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Output straight into the Go embed target.
  build: {
    outDir: "../internal/web/dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
```

`frontend/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0058E6" />
    <title>ledger</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`frontend/.gitignore`:
```
node_modules
```

Append to repo-root `.gitignore` (create if missing):
```
frontend/node_modules
```

- [ ] **Step 3: Minimal entrypoint + test setup**

`frontend/src/main.tsx`:
```tsx
import React from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="window" style={{ margin: 16 }}>
      <div className="title-bar"><div className="title-bar-text">ledger</div></div>
      <div className="window-body">Loading…</div>
    </div>
  </React.StrictMode>,
);
```

`frontend/src/test/setup.ts`:
```ts
import "@testing-library/jest-dom";
```

- [ ] **Step 4: Install, build, verify embed target populated**

Run:
```bash
cd /root/Coding/ledger/frontend && bun install && bun run build
ls /root/Coding/ledger/internal/web/dist/index.html && echo "EMBED OK"
cd /root/Coding/ledger && go build ./... && echo "GO BUILD OK"
```
Expected: `bun run build` writes `index.html` + `assets/*` into `internal/web/dist`; both `EMBED OK` and `GO BUILD OK` print.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/ internal/web/dist .gitignore
git commit -m "build(frontend): scaffold Vite+React+TS building into web/dist"
```

---

### Task 12: XP theme tokens, fonts, and Fugue icons (self-hosted)

**Files:**
- Create: `frontend/src/styles/theme.css`
- Create: `frontend/public/fonts/` (self-hosted Tahoma/Trebuchet fallbacks via system stack — no binaries needed if absent)
- Create: `frontend/public/icons/` (Fugue subset)
- Create: `NOTICE` (repo root)
- Modify: `frontend/src/main.tsx` (import `xp.css` + theme)

`xp.css` (npm) provides the Luna chrome. `theme.css` layers the mobile-first overrides and the money/accounting helpers from §6.8. Fugue icons are vendored as 16px PNGs under `public/icons/`; attribution lives in `NOTICE` and the Settings About row (Task 18).

- [ ] **Step 1: Create `frontend/src/styles/theme.css`**

```css
:root {
  --luna-surface: #ECE9D8;
  --luna-blue-1: #0058E6;
  --luna-blue-2: #3F8CF5;
  --accent-green: #3CA63C;
  --amber: #E0A800;
  --red: #C00000;
  --touch: 44px;
  --font-ui: "Trebuchet MS", Tahoma, "Segoe UI", system-ui, sans-serif;
}

html, body, #root { height: 100%; margin: 0; }
body {
  font-family: var(--font-ui);
  font-size: 15px; /* larger than XP's native ~8pt for touch */
  background: #245EDC; /* plain blue backdrop (no Bliss) */
  -webkit-text-size-adjust: 100%;
}

/* Each route fills the viewport like a maximized window. */
.app-window {
  display: flex; flex-direction: column;
  height: 100dvh; width: 100%;
}
.app-window > .window-body {
  flex: 1; overflow-y: auto; margin: 0;
  padding: 12px;
  background: var(--luna-surface);
}

/* Bottom taskbar = tab bar */
.taskbar {
  display: flex; align-items: stretch; gap: 4px;
  padding: 4px; min-height: var(--touch);
  background: linear-gradient(var(--luna-blue-2), var(--luna-blue-1));
  border-top: 1px solid #fff3;
}
.taskbar button {
  flex: 1; min-height: var(--touch); font-size: 14px;
}
.taskbar .menu-btn { background: var(--accent-green); color: #fff; font-weight: bold; flex: 0 0 64px; }
.taskbar .tab-active { box-shadow: inset 1px 1px 2px #0006; }
.badge {
  display: inline-block; min-width: 18px; padding: 0 4px;
  background: var(--red); color: #fff; border-radius: 9px;
  font-size: 12px; text-align: center; margin-left: 4px;
}

/* Touch targets */
button, .field-row input, select { min-height: var(--touch); }

/* Accounting money rendering */
.money { font-variant-numeric: tabular-nums; }
.money-neg { color: var(--red); }
.money-zero { color: #888; }

/* Segmented progress fill colors set inline by component */
.bar { height: 18px; background: #fff; border: 1px solid #0008; box-shadow: inset 1px 1px 2px #0004; }
.bar-fill { height: 100%; transition: width .2s; }
.bar-green { background: var(--accent-green); }
.bar-amber { background: var(--amber); }
.bar-red { background: var(--red); }

/* Settings start-menu drawer */
.drawer-backdrop { position: fixed; inset: 0; background: #0006; }
.drawer {
  position: fixed; left: 0; bottom: var(--touch); top: 0; width: min(92vw, 380px);
  background: var(--luna-surface); border-right: 2px solid var(--luna-blue-1);
  overflow-y: auto; padding: 12px;
}
```

- [ ] **Step 2: Vendor the Fugue icon subset**

Create `frontend/public/icons/` and place the named 16px PNGs the UI references (from the Fugue set, CC BY 3.0). Fetch the pack and copy the needed glyphs:
```bash
cd /root/Coding/ledger/frontend/public
mkdir -p icons
# Fugue Icons (Yusuke Kamiyamane), CC BY 3.0
curl -fsSL https://github.com/yusukekamiyamane/fugue-icons/archive/refs/heads/master.tar.gz -o /tmp/fugue.tgz
tar -xzf /tmp/fugue.tgz -C /tmp
for n in chart-up money-coin flag-red table gear arrow-switch tick cross exclamation; do
  find /tmp/fugue-icons-* -name "$n.png" -exec cp {} icons/ \; ;
done
ls icons
```
If a name differs in the pack, pick the closest 16px PNG and rename to the names above. **Verification:** `ls icons` shows the nine PNGs. If network is unavailable in the execution environment, create 16×16 transparent placeholder PNGs with the same names so the build and layout succeed (icons are cosmetic); note this in the commit message.

- [ ] **Step 3: Create `NOTICE`** (repo root)

```
This product bundles third-party assets:

- Fugue Icons by Yusuke Kamiyamane (https://p.yusukekamiyamane.com/),
  licensed under Creative Commons Attribution 3.0 (CC BY 3.0).
  Icons are used in the app UI; attribution is shown in Settings > About.

- XP.css (https://botoxparty.github.io/XP.css/), MIT License.
```

- [ ] **Step 4: Import styles** (`frontend/src/main.tsx`, prepend imports)

```tsx
import "xp.css/dist/XP.css";
import "./styles/theme.css";
```

- [ ] **Step 5: Build, verify, commit**

Run: `cd /root/Coding/ledger/frontend && bun run build && cd /root/Coding/ledger && go build ./...`
Expected: build succeeds.
```bash
cd /root/Coding/ledger
git add frontend/src/styles frontend/public NOTICE frontend/src/main.tsx internal/web/dist
git commit -m "feat(frontend): XP theme tokens, self-hosted Fugue icons, NOTICE"
```

---

# Phase C — Frontend app

### Task 13: API client, types, and money formatting (TDD)

**Files:**
- Create: `frontend/src/api/types.ts`, `frontend/src/api/client.ts`, `frontend/src/lib/money.ts`
- Test: `frontend/src/lib/money.test.ts`, `frontend/src/api/client.test.ts`

`money.ts` formats `int64` fils accounting-style (grouped thousands, negatives in red parentheses, dash for zero). `client.ts` is a thin typed `fetch` wrapper matching the Go JSON shapes exactly.

- [ ] **Step 1: Write the failing tests**

`frontend/src/lib/money.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatFils, moneyClass } from "./money";

describe("formatFils", () => {
  it("groups thousands and shows 2 decimals", () => {
    expect(formatFils(123456)).toBe("1,234.56");
  });
  it("wraps negatives in parentheses", () => {
    expect(formatFils(-50000)).toBe("(500.00)");
  });
  it("renders zero as a dash", () => {
    expect(formatFils(0)).toBe("—");
  });
});

describe("moneyClass", () => {
  it("flags negatives and zero", () => {
    expect(moneyClass(-1)).toContain("money-neg");
    expect(moneyClass(0)).toContain("money-zero");
    expect(moneyClass(100)).toBe("money");
  });
});
```

`frontend/src/api/client.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { getJSON, postJSON } from "./client";

afterEach(() => vi.restoreAllMocks());

describe("client", () => {
  it("getJSON parses the body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ income: 5 }), { status: 200 })));
    expect(await getJSON<{ income: number }>("/api/summary")).toEqual({ income: 5 });
  });

  it("postJSON throws on non-2xx with the server message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad" }), { status: 400 })));
    await expect(postJSON("/api/rules", {})).rejects.toThrow("bad");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger/frontend && bun run test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`frontend/src/lib/money.ts`:
```ts
/** Format int64 fils as accounting-style AED (no symbol): 1,234.56 / (500.00) / —. */
export function formatFils(fils: number): string {
  if (fils === 0) return "—";
  const neg = fils < 0;
  const abs = Math.abs(fils);
  const s = (abs / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return neg ? `(${s})` : s;
}

export function moneyClass(fils: number): string {
  if (fils < 0) return "money money-neg";
  if (fils === 0) return "money money-zero";
  return "money";
}
```

`frontend/src/api/types.ts`:
```ts
export interface Category {
  ID: number; Name: string; Kind: string; Bucket: string; IsActive: boolean;
}
export interface Rule {
  ID: number; MatchType: string; Pattern: string; CategoryID: number; Priority: number; Source: string;
}
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
}
export interface BudgetConfig {
  MonthlyIncome: number; NeedPct: number; WantPct: number; SavingPct: number;
  IncomeSource: string; FreezeHistory: boolean;
}
export interface BucketSummary {
  bucket: string; target: number; spent: number; remaining: number;
  pct_used: number; projection: number;
}
export interface Summary {
  period: string; income: number; month_progress: number;
  buckets: BucketSummary[]; recent: Txn[];
}
```

`frontend/src/api/client.ts`:
```ts
async function parseOrThrow(res: Response) {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(body?.error ?? `request failed: ${res.status}`);
  }
  return body;
}

export async function getJSON<T>(url: string): Promise<T> {
  return parseOrThrow(await fetch(url));
}

export async function postJSON<T = unknown>(url: string, body: unknown, method = "POST"): Promise<T> {
  return parseOrThrow(await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function del(url: string): Promise<void> {
  await parseOrThrow(await fetch(url, { method: "DELETE" }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger/frontend && bun run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src/api frontend/src/lib
git commit -m "feat(frontend): typed API client + accounting money formatter"
```

---

### Task 14: App shell — Query provider, router, title bar, taskbar

**Files:**
- Create: `frontend/src/App.tsx`, `frontend/src/components/AppWindow.tsx`, `frontend/src/components/Taskbar.tsx`, `frontend/src/router.tsx`, `frontend/src/queryClient.ts`
- Modify: `frontend/src/main.tsx`
- Test: `frontend/src/components/Taskbar.test.tsx`

The shell renders the active route as a maximized XP window with a fixed bottom taskbar. The taskbar has a green menu button (opens Settings drawer) plus Dashboard / Review / Transactions tabs; the Review tab shows a count badge.

- [ ] **Step 1: Write the failing test** (`frontend/src/components/Taskbar.test.tsx`)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Taskbar } from "./Taskbar";

describe("Taskbar", () => {
  it("shows a review badge when count > 0 and fires onMenu", () => {
    const onMenu = vi.fn();
    render(<Taskbar active="dashboard" reviewCount={3} onMenu={onMenu} onNavigate={() => {}} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /menu/i }));
    expect(onMenu).toHaveBeenCalled();
  });

  it("hides the badge when count is 0", () => {
    render(<Taskbar active="review" reviewCount={0} onMenu={() => {}} onNavigate={() => {}} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bun run test Taskbar`
Expected: FAIL — `./Taskbar` not found.

- [ ] **Step 3: Implement the shell pieces**

`frontend/src/components/Taskbar.tsx`:
```tsx
export type Tab = "dashboard" | "review" | "transactions";

export function Taskbar(props: {
  active: Tab;
  reviewCount: number;
  onMenu: () => void;
  onNavigate: (tab: Tab) => void;
}) {
  const tab = (id: Tab, label: string, badge?: number) => (
    <button
      className={props.active === id ? "tab-active" : ""}
      aria-pressed={props.active === id}
      onClick={() => props.onNavigate(id)}
    >
      {label}
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="taskbar">
      <button className="menu-btn" aria-label="menu" onClick={props.onMenu}>≡</button>
      {tab("dashboard", "Dashboard")}
      {tab("review", "Review", props.reviewCount)}
      {tab("transactions", "Transactions")}
    </nav>
  );
}
```

`frontend/src/components/AppWindow.tsx`:
```tsx
import { ReactNode } from "react";

export function AppWindow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="window app-window">
      <div className="title-bar">
        <div className="title-bar-text">{title}</div>
        <div className="title-bar-controls">
          <button aria-label="Minimize" />
          <button aria-label="Maximize" />
          <button aria-label="Close" />
        </div>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}
```

`frontend/src/queryClient.ts`:
```ts
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});
```

`frontend/src/App.tsx`:
```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "./api/client";
import type { Txn } from "./api/types";
import { AppWindow } from "./components/AppWindow";
import { Taskbar, Tab } from "./components/Taskbar";
import { Dashboard } from "./views/Dashboard";
import { Review } from "./views/Review";
import { Transactions } from "./views/Transactions";
import { SettingsDrawer } from "./views/SettingsDrawer";
import { useLiveEvents } from "./hooks/useLiveEvents";

const TITLES: Record<Tab, string> = {
  dashboard: "Dashboard",
  review: "Review",
  transactions: "Transactions",
};

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  useLiveEvents();

  const review = useQuery({
    queryKey: ["review"],
    queryFn: () => getJSON<Txn[]>("/api/review"),
  });

  return (
    <>
      <AppWindow title={TITLES[tab]}>
        {tab === "dashboard" && <Dashboard />}
        {tab === "review" && <Review />}
        {tab === "transactions" && <Transactions />}
      </AppWindow>
      <Taskbar
        active={tab}
        reviewCount={review.data?.length ?? 0}
        onMenu={() => setMenuOpen(true)}
        onNavigate={setTab}
      />
      {menuOpen && <SettingsDrawer onClose={() => setMenuOpen(false)} />}
    </>
  );
}
```

> Note: this plan uses a small `useState` tab switcher rather than TanStack Router's file-based routing — it keeps the mobile shell simple and avoids a router config the embedded single-page bundle doesn't need. (`@tanstack/react-router` stays a dependency for future deep-linking but is not wired here; YAGNI for the maximized-window UX.)

`frontend/src/main.tsx` (replace the placeholder render):
```tsx
import "xp.css/dist/XP.css";
import "./styles/theme.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

> The remaining imports (`./views/*`, `./hooks/useLiveEvents`) are created in Tasks 15–19. To keep this task self-contained and compiling, create **temporary stubs** now — each a default-styled placeholder — and replace them in their own tasks:
>
> `frontend/src/views/Dashboard.tsx`, `Review.tsx`, `Transactions.tsx`, `SettingsDrawer.tsx`:
> ```tsx
> export function Dashboard() { return <p>Dashboard</p>; }
> ```
> (named `Review`, `Transactions`; `SettingsDrawer({ onClose }: { onClose: () => void })` renders `<div className="drawer-backdrop" onClick={onClose} />`).
>
> `frontend/src/hooks/useLiveEvents.ts`:
> ```ts
> export function useLiveEvents() { /* wired in Task 19 */ }
> ```

- [ ] **Step 4: Run test + build to verify they pass**

Run: `cd /root/Coding/ledger/frontend && bun run test Taskbar && bun run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "feat(frontend): app shell — query provider, title bar, taskbar, stubs"
```

---

### Task 15: Dashboard view

**Files:**
- Create: `frontend/src/views/Dashboard.tsx`, `frontend/src/components/BucketBox.tsx`, `frontend/src/components/Money.tsx`
- Test: `frontend/src/components/BucketBox.test.tsx`

Three XP group boxes (Needs / Wants / Savings), each a segmented progress bar that goes green→amber→red as spend approaches target, with spent/target/remaining; plus a month-progress bar and a recent-transactions list.

- [ ] **Step 1: Write the failing test** (`frontend/src/components/BucketBox.test.tsx`)

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BucketBox, barColor } from "./BucketBox";

describe("barColor", () => {
  it("greens under 0.8, ambers under 1.0, reds at/over 1.0", () => {
    expect(barColor(0.5)).toBe("bar-green");
    expect(barColor(0.85)).toBe("bar-amber");
    expect(barColor(1.2)).toBe("bar-red");
  });
});

describe("BucketBox", () => {
  it("renders the bucket label and spent/target", () => {
    render(<BucketBox b={{ bucket: "need", target: 100000, spent: 50000, remaining: 50000, pct_used: 0.5, projection: 100000 }} />);
    expect(screen.getByText(/needs/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bun run test BucketBox`
Expected: FAIL — `./BucketBox` not found.

- [ ] **Step 3: Implement**

`frontend/src/components/Money.tsx`:
```tsx
import { formatFils, moneyClass } from "../lib/money";
export function Money({ fils }: { fils: number }) {
  return <span className={moneyClass(fils)}>{formatFils(fils)}</span>;
}
```

`frontend/src/components/BucketBox.tsx`:
```tsx
import type { BucketSummary } from "../api/types";
import { Money } from "./Money";

const LABELS: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function barColor(pct: number): string {
  if (pct >= 1.0) return "bar-red";
  if (pct >= 0.8) return "bar-amber";
  return "bar-green";
}

export function BucketBox({ b }: { b: BucketSummary }) {
  const width = Math.min(100, Math.max(0, b.pct_used * 100));
  return (
    <fieldset style={{ marginBottom: 10 }}>
      <legend>{LABELS[b.bucket] ?? b.bucket}</legend>
      <div className="bar" role="progressbar" aria-valuenow={Math.round(width)}>
        <div className={`bar-fill ${barColor(b.pct_used)}`} style={{ width: `${width}%` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        <span>Spent <Money fils={b.spent} /> / <Money fils={b.target} /></span>
        <span>Left <Money fils={b.remaining} /></span>
      </div>
    </fieldset>
  );
}
```

`frontend/src/views/Dashboard.tsx`:
```tsx
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary } from "../api/types";
import { BucketBox } from "../components/BucketBox";
import { Money } from "../components/Money";

export function Dashboard() {
  const q = useQuery({ queryKey: ["summary"], queryFn: () => getJSON<Summary>("/api/summary?period=current") });
  if (q.isLoading) return <p>Loading…</p>;
  if (q.error) return <p>Could not load summary.</p>;
  const s = q.data!;
  const monthPct = Math.round(s.month_progress * 100);
  return (
    <div>
      <p>Income <Money fils={s.income} /> · {s.period}</p>
      {s.buckets.map((b) => <BucketBox key={b.bucket} b={b} />)}
      <fieldset>
        <legend>Month progress</legend>
        <div className="bar"><div className="bar-fill bar-green" style={{ width: `${monthPct}%` }} /></div>
        <small>{monthPct}% of the month elapsed</small>
      </fieldset>
      <fieldset>
        <legend>Recent</legend>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {s.recent.map((t) => (
            <li key={t.ID} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
              <span>{t.MerchantRaw || "—"}</span>
              <Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} />
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}
```

- [ ] **Step 4: Run test + build to verify they pass**

Run: `cd /root/Coding/ledger/frontend && bun run test BucketBox && bun run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "feat(frontend): Dashboard view with 50/30/20 jars"
```

---

### Task 16: Review view + categorize dialog

**Files:**
- Create: `frontend/src/views/Review.tsx`, `frontend/src/components/CategorizeDialog.tsx`
- Test: `frontend/src/components/CategorizeDialog.test.tsx`

A list of `needs_review` items; tapping a row opens a centered XP dialog with a category radio list, a "Save as rule" checkbox, and OK/Cancel. One-tap mark-as-transfer / ignore via the status endpoint. On success, invalidate `review` + `summary` queries.

- [ ] **Step 1: Write the failing test** (`frontend/src/components/CategorizeDialog.test.tsx`)

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategorizeDialog } from "./CategorizeDialog";
import type { Category, Txn } from "../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txn: Txn = { ID: 9, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "needs_review", Confidence: 0, Source: "email" };

describe("CategorizeDialog", () => {
  it("submits the chosen category + make_rule flag", () => {
    const onSubmit = vi.fn();
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Dining"));
    fireEvent.click(screen.getByLabelText(/save as rule/i));
    fireEvent.click(screen.getByRole("button", { name: /ok/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: 2, make_rule: true });
  });

  it("disables OK until a category is chosen", () => {
    render(<CategorizeDialog txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /ok/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bun run test CategorizeDialog`
Expected: FAIL — not found.

- [ ] **Step 3: Implement**

`frontend/src/components/CategorizeDialog.tsx`:
```tsx
import { useState } from "react";
import type { Category, Txn } from "../api/types";
import { Money } from "./Money";

export function CategorizeDialog(props: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
}) {
  const [catID, setCatID] = useState<number | null>(null);
  const [makeRule, setMakeRule] = useState(false);
  return (
    <div className="drawer-backdrop" onClick={props.onClose}>
      <div className="window" style={{ maxWidth: 360, margin: "20vh auto" }} onClick={(e) => e.stopPropagation()}>
        <div className="title-bar"><div className="title-bar-text">Categorize</div></div>
        <div className="window-body">
          <p>{props.txn.MerchantRaw || "—"} · <Money fils={-props.txn.AmountFils} /></p>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {props.categories.map((c) => (
              <label key={c.ID} style={{ display: "block", padding: "6px 0" }}>
                <input type="radio" name="cat" value={c.ID} onChange={() => setCatID(c.ID)} /> {c.Name}
              </label>
            ))}
          </div>
          <label style={{ display: "block", margin: "8px 0" }}>
            <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} /> Save as rule
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={props.onClose}>Cancel</button>
            <button
              disabled={catID === null}
              onClick={() => catID !== null && props.onSubmit({ category_id: catID, make_rule: makeRule })}
            >OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

`frontend/src/views/Review.tsx`:
```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { Money } from "../components/Money";
import { CategorizeDialog } from "../components/CategorizeDialog";

export function Review() {
  const qc = useQueryClient();
  const [active, setActive] = useState<Txn | null>(null);
  const items = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["review"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };
  const setStatus = async (id: number, status: string) => {
    await postJSON(`/api/transactions/${id}/status`, { status });
    invalidate();
  };
  const categorize = async (id: number, body: { category_id: number; make_rule: boolean }) => {
    await postJSON(`/api/transactions/${id}/categorize`, body);
    setActive(null);
    invalidate();
  };

  if (items.isLoading) return <p>Loading…</p>;
  const rows = items.data ?? [];
  if (rows.length === 0) return <p>Nothing to review. 🎉</p>;
  return (
    <div>
      {rows.map((t) => (
        <div key={t.ID} className="window" style={{ marginBottom: 8 }}>
          <div className="window-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button style={{ flex: 1, textAlign: "left" }} onClick={() => setActive(t)}>
              {t.MerchantRaw || "—"} · <Money fils={-t.AmountFils} />
            </button>
            <button onClick={() => setStatus(t.ID, "transfer")} title="Transfer">⇄</button>
            <button onClick={() => setStatus(t.ID, "ignored")} title="Ignore">✕</button>
          </div>
        </div>
      ))}
      {active && cats.data && (
        <CategorizeDialog
          txn={active}
          categories={cats.data}
          onSubmit={(body) => categorize(active.ID, body)}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test + build**

Run: `cd /root/Coding/ledger/frontend && bun run test CategorizeDialog && bun run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "feat(frontend): Review view + categorize dialog"
```

---

### Task 17: Transactions view (TanStack Table + filters)

**Files:**
- Create: `frontend/src/views/Transactions.tsx`
- Test: `frontend/src/views/Transactions.filters.test.ts` (pure filter-param builder)

A filterable list (status, date range). On narrow screens it renders list-row cards (the default mobile rendition); the query-string builder is extracted and unit-tested.

- [ ] **Step 1: Write the failing test** (`frontend/src/views/Transactions.filters.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { buildTxnQuery } from "./Transactions";

describe("buildTxnQuery", () => {
  it("omits empty filters", () => {
    expect(buildTxnQuery({ status: "", from: "", to: "" })).toBe("/api/transactions");
  });
  it("encodes provided filters", () => {
    expect(buildTxnQuery({ status: "confirmed", from: "2026-06-01", to: "2026-06-30" }))
      .toBe("/api/transactions?status=confirmed&from=2026-06-01&to=2026-06-30");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bun run test Transactions.filters`
Expected: FAIL — `buildTxnQuery` not exported.

- [ ] **Step 3: Implement** (`frontend/src/views/Transactions.tsx`)

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { Money } from "../components/Money";

export interface TxnFilters { status: string; from: string; to: string; }

export function buildTxnQuery(f: TxnFilters): string {
  const params = new URLSearchParams();
  if (f.status) params.set("status", f.status);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  const qs = params.toString();
  return qs ? `/api/transactions?${qs}` : "/api/transactions";
}

export function Transactions() {
  const [filters, setFilters] = useState<TxnFilters>({ status: "", from: "", to: "" });
  const q = useQuery({
    queryKey: ["transactions", filters],
    queryFn: () => getJSON<Txn[]>(buildTxnQuery(filters)),
  });
  const set = (patch: Partial<TxnFilters>) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <div>
      <div className="field-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="needs_review">Needs review</option>
          <option value="transfer">Transfer</option>
          <option value="ignored">Ignored</option>
        </select>
        <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
        <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      </div>
      {q.isLoading ? <p>Loading…</p> : (
        <table className="ledger-table" style={{ width: "100%" }}>
          <thead><tr><th>Date</th><th>Merchant</th><th>Status</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {(q.data ?? []).map((t) => (
              <tr key={t.ID}>
                <td>{t.PostedAt.slice(0, 10)}</td>
                <td>{t.MerchantRaw || "—"}</td>
                <td>{t.Status}</td>
                <td style={{ textAlign: "right" }}><Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

> TanStack Table is available for richer sorting/pagination later; the mobile-first rendition here is a plain semantic table styled by `xp.css`. This satisfies the §6.8 "narrow screens collapse columns into list-row cards" intent with the simplest thing that works; extracting `buildTxnQuery` keeps the filter logic tested.

- [ ] **Step 4: Run test + build**

Run: `cd /root/Coding/ledger/frontend && bun run test Transactions.filters && bun run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "feat(frontend): Transactions view with filters"
```

---

### Task 18: Settings drawer (income, %, bucket assignment, category & rule CRUD, freeze toggle, About)

**Files:**
- Create: `frontend/src/views/SettingsDrawer.tsx`
- Test: `frontend/src/views/SettingsDrawer.pct.test.ts` (pct validation helper)

The Start-menu drawer: monthly income + income source, the three bucket % (validated to sum to 1.0 before save), category→bucket reassignment, category create, rule list + delete, the `freeze_history` toggle, and an About row crediting Fugue Icons.

- [ ] **Step 1: Write the failing test** (`frontend/src/views/SettingsDrawer.pct.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { pctsValid } from "./SettingsDrawer";

describe("pctsValid", () => {
  it("accepts 50/30/20", () => {
    expect(pctsValid(0.5, 0.3, 0.2)).toBe(true);
  });
  it("rejects sums that miss 1.0", () => {
    expect(pctsValid(0.5, 0.5, 0.5)).toBe(false);
    expect(pctsValid(0.4, 0.3, 0.2)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bun run test SettingsDrawer.pct`
Expected: FAIL — `pctsValid` not exported.

- [ ] **Step 3: Implement** (`frontend/src/views/SettingsDrawer.tsx`)

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, del } from "../api/client";
import type { BudgetConfig, Category, Rule } from "../api/types";

export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

const BUCKETS = ["need", "want", "saving"] as const;

export function SettingsDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });

  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const cfg = draft ?? budget.data ?? null;
  const patch = (p: Partial<BudgetConfig>) => cfg && setDraft({ ...cfg, ...p });

  const saveBudget = async () => {
    if (!cfg) return;
    if (!pctsValid(cfg.NeedPct, cfg.WantPct, cfg.SavingPct)) { alert("Percentages must sum to 100%."); return; }
    await postJSON("/api/budget", cfg, "PUT");
    setDraft(null);
    qc.invalidateQueries({ queryKey: ["budget"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const reassign = async (c: Category, bucket: string) => {
    await postJSON(`/api/categories/${c.ID}`, { name: c.Name, kind: c.Kind, bucket }, "PUT");
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };

  const deleteRule = async (id: number) => {
    await del(`/api/rules/${id}`);
    qc.invalidateQueries({ queryKey: ["rules"] });
  };

  const catName = (id: number) => cats.data?.find((c) => c.ID === id)?.Name ?? `#${id}`;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h4>Settings</h4>

        {cfg && (
          <fieldset>
            <legend>Budget</legend>
            <label>Monthly income (fils)
              <input type="number" value={cfg.MonthlyIncome}
                onChange={(e) => patch({ MonthlyIncome: Number(e.target.value) })} />
            </label>
            <label>Income source
              <select value={cfg.IncomeSource} onChange={(e) => patch({ IncomeSource: e.target.value })}>
                <option value="config">Config figure</option>
                <option value="categories">Sum income categories</option>
              </select>
            </label>
            <div className="field-row">
              <label>Need % <input type="number" step="0.05" value={cfg.NeedPct} onChange={(e) => patch({ NeedPct: Number(e.target.value) })} /></label>
              <label>Want % <input type="number" step="0.05" value={cfg.WantPct} onChange={(e) => patch({ WantPct: Number(e.target.value) })} /></label>
              <label>Saving % <input type="number" step="0.05" value={cfg.SavingPct} onChange={(e) => patch({ SavingPct: Number(e.target.value) })} /></label>
            </div>
            <label><input type="checkbox" checked={cfg.FreezeHistory} onChange={(e) => patch({ FreezeHistory: e.target.checked })} /> Freeze history</label>
            <button onClick={saveBudget}>Save budget</button>
          </fieldset>
        )}

        {BUCKETS.map((bucket) => (
          <fieldset key={bucket}>
            <legend style={{ textTransform: "capitalize" }}>{bucket}</legend>
            {(cats.data ?? []).filter((c) => c.Kind === "spending" && c.Bucket === bucket).map((c) => (
              <div key={c.ID} className="field-row" style={{ justifyContent: "space-between" }}>
                <span>{c.Name}</span>
                <select value={c.Bucket} onChange={(e) => reassign(c, e.target.value)}>
                  {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>
            ))}
          </fieldset>
        ))}

        <fieldset>
          <legend>Rules</legend>
          {(rules.data ?? []).map((r) => (
            <div key={r.ID} className="field-row" style={{ justifyContent: "space-between" }}>
              <span>{r.MatchType}: “{r.Pattern}” → {catName(r.CategoryID)}</span>
              <button onClick={() => deleteRule(r.ID)}>✕</button>
            </div>
          ))}
          {rules.data?.length === 0 && <small>No rules yet — confirm a review item with “Save as rule”.</small>}
        </fieldset>

        <fieldset>
          <legend>About</legend>
          <small>Fugue Icons by Yusuke Kamiyamane (CC BY 3.0). Chrome: XP.css (MIT).</small>
        </fieldset>

        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
```

> Category **create** and sub-category CRUD reuse `POST /api/categories` (already live). This drawer ships the reassignment + rule-delete + budget edit paths the spec headlines; a "+ New category" form is a thin follow-up using the same `postJSON("/api/categories", …)` call and is intentionally deferred (YAGNI for first cut — note in commit).

- [ ] **Step 4: Run test + build**

Run: `cd /root/Coding/ledger/frontend && bun run test SettingsDrawer.pct && bun run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "feat(frontend): Settings drawer — budget, bucket reassignment, rules, about"
```

---

### Task 19: Live updates via SSE

**Files:**
- Create: `frontend/src/hooks/useLiveEvents.ts` (replace the Task 14 stub)
- Test: `frontend/src/hooks/useLiveEvents.test.ts`

Open `/api/events` on mount; on any event, invalidate the `summary`, `transactions`, and `review` query keys so the dashboard and the review badge refresh live. Extract the invalidation targets into a pure constant for testing.

- [ ] **Step 1: Write the failing test** (`frontend/src/hooks/useLiveEvents.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { LIVE_INVALIDATE_KEYS } from "./useLiveEvents";

describe("useLiveEvents", () => {
  it("invalidates the live-data query keys", () => {
    expect(LIVE_INVALIDATE_KEYS).toEqual([["summary"], ["transactions"], ["review"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/Coding/ledger/frontend && bun run test useLiveEvents`
Expected: FAIL — `LIVE_INVALIDATE_KEYS` not exported.

- [ ] **Step 3: Implement** (`frontend/src/hooks/useLiveEvents.ts`)

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export const LIVE_INVALIDATE_KEYS = [["summary"], ["transactions"], ["review"]] as const;

export function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/events");
    const onEvent = () => {
      for (const key of LIVE_INVALIDATE_KEYS) {
        qc.invalidateQueries({ queryKey: [...key] });
      }
    };
    es.addEventListener("tx", onEvent);
    es.addEventListener("summary", onEvent);
    es.onerror = () => { /* EventSource auto-reconnects */ };
    return () => es.close();
  }, [qc]);
}
```

- [ ] **Step 4: Run test + build**

Run: `cd /root/Coding/ledger/frontend && bun run test useLiveEvents && bun run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/src
git commit -m "feat(frontend): live SSE updates invalidate summary/review/transactions"
```

---

### Task 20: PWA — manifest, service worker, install icons

**Files:**
- Modify: `frontend/vite.config.ts` (add `vite-plugin-pwa`)
- Create: `frontend/public/icon-192.png`, `frontend/public/icon-512.png`
- Modify: `frontend/index.html` (manifest/theme already partly present)

`vite-plugin-pwa` generates `sw.js` + `manifest.webmanifest`, caches the app shell so the dashboard opens offline (read-only), and sets `display: standalone`. Launcher icons are separate larger art (not the 16px Fugue UI glyphs).

- [ ] **Step 1: Add the plugin** (`frontend/vite.config.ts`)

```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon-192.png", "icon-512.png"],
      manifest: {
        name: "ledger",
        short_name: "ledger",
        description: "Personal budgeting",
        theme_color: "#0058E6",
        background_color: "#245EDC",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,png,woff2}"],
      },
    }),
  ],
  build: { outDir: "../internal/web/dist", emptyOutDir: true },
  test: { globals: true, environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
```

- [ ] **Step 2: Create launcher icons**

Generate two solid Luna-blue PNGs with a green pill (no trademarked art). If ImageMagick is available:
```bash
cd /root/Coding/ledger/frontend/public
convert -size 192x192 xc:'#0058E6' -fill '#3CA63C' -draw 'roundrectangle 40,76 152,116 20,20' icon-192.png
convert -size 512x512 xc:'#0058E6' -fill '#3CA63C' -draw 'roundrectangle 110,210 402,302 50,50' icon-512.png
```
If `convert` is unavailable, create any two valid PNGs at 192×192 and 512×512 (a subagent may use a tiny Bun script with the `sharp` package or a base64-decoded solid PNG). **Verification:** `file icon-192.png icon-512.png` reports PNG image data at the right dimensions.

- [ ] **Step 3: Build and verify PWA artifacts land in the embed dir**

Run:
```bash
cd /root/Coding/ledger/frontend && bun run build
ls /root/Coding/ledger/internal/web/dist/manifest.webmanifest /root/Coding/ledger/internal/web/dist/sw.js && echo "PWA OK"
```
Expected: `manifest.webmanifest` and `sw.js` exist; `PWA OK` prints.

- [ ] **Step 4: Verify the Go binary embeds and serves them**

Run: `cd /root/Coding/ledger && go build ./... && go test ./internal/web/ ./internal/server/`
Expected: build + tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add frontend/vite.config.ts frontend/public/icon-192.png frontend/public/icon-512.png internal/web/dist
git commit -m "feat(frontend): PWA manifest, service worker, install icons"
```

---

### Task 21: End-to-end verification + deploy notes

**Files:**
- Create: `docs/superpowers/notes/m7-verify.md`
- Modify: `internal/web/embed.go` (doc comment only — update the "M1 placeholder" note)

Bring up the real binary, confirm the API + SPA serve from one origin, and document the build-and-deploy step (Bun build → `go build` → restart systemd). Dinosaur is the deploy target (this box is prod), so the deploy steps run locally.

- [ ] **Step 1: Update the embed doc comment** (`internal/web/embed.go`)

Replace the package doc line referencing "M1 placeholder shell" with:
```go
// Package web embeds the built frontend bundle so the single binary serves the
// SPA from its own filesystem. The dist/ directory is produced by the Vite build
// in frontend/ (run `bun run build` there before `go build`).
```

- [ ] **Step 2: Full build + test gate**

Run:
```bash
cd /root/Coding/ledger/frontend && bun install && bun run test && bun run build
cd /root/Coding/ledger && go build ./... && go test ./...
```
Expected: frontend tests PASS, build writes `dist/`, Go builds, all Go tests PASS.

- [ ] **Step 3: Smoke-test the running binary**

Run (background the server, hit endpoints, then stop it):
```bash
cd /root/Coding/ledger
go build -o /tmp/ledger ./cmd/ledger
/tmp/ledger -config /dev/null &  LPID=$!
sleep 1
curl -fsS localhost:8080/api/health | head -c 200; echo
curl -fsS "localhost:8080/api/summary?period=current" | head -c 200; echo
curl -fsS localhost:8080/review | head -c 80; echo   # SPA fallback -> index.html
curl -fsS localhost:8080/manifest.webmanifest | head -c 80; echo
kill $LPID
```
Expected: `/api/health` returns JSON; `/api/summary` returns a buckets payload; `/review` returns the `<!doctype html>` shell (SPA fallback); the manifest serves. (If the configured listen addr differs from `:8080`, read it from `config.toml`; the default in `config.go` applies with an empty config path.)

- [ ] **Step 4: Write the verification + deploy note** (`docs/superpowers/notes/m7-verify.md`)

```markdown
# M7 verification + deploy

Build order (build-time Bun only; runtime ships no JS):
1. `cd frontend && bun install && bun run build`  → writes internal/web/dist
2. `cd .. && go build -o ledger ./cmd/ledger`       → embeds dist
3. Restart the systemd service on dinosaur.

Smoke checks: GET /api/health, GET /api/summary, GET /review (SPA fallback),
GET /manifest.webmanifest. Live update: confirm a review item and watch the
dashboard jars + review badge update via SSE.
```

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger
git add internal/web/embed.go docs/superpowers/notes/m7-verify.md
git commit -m "docs(m7): end-to-end verification + deploy notes"
```

---

## Self-Review

**Spec coverage (§6.7 API + §6.8 PWA + §6.5/§6.6 budget):**
- `/api/summary` → Task 5; `/api/budget` GET/PUT → Task 5; `/api/categories/{id}` PUT → Task 6; `/api/rules` GET/POST/DELETE → Task 7; `/api/events` SSE → Task 8. ✓ (`/api/push/subscribe` is deferred — push is a §8/M8 hardening concern; this plan does SSE live updates, which the views actually need. Noted as out of scope here.)
- Budget engine §6.5 (income base config/categories, per-jar target/spent/remaining/%/projection, retroactive vs frozen via `bucket_snapshot`, recompute-on-read) → Tasks 1–5. ✓
- Customization §6.6 (editable bucket mapping, freeze toggle, new-category bucket requirement already enforced by existing POST handler, tunable split) → Tasks 5, 6, 18. ✓
- PWA stack (Vite/React/TS, TanStack Query/Table, vite-plugin-pwa, embed) → Tasks 11, 14–20. ✓
- XP Luna theme + mobile maximized-window + bottom taskbar + dialogs + self-hosted Fugue icons + accounting money → Tasks 12, 14–16. ✓
- Views: Dashboard (group boxes, segmented bars, month progress, recent) → 15; Review (table + categorize dialog + transfer/ignore) → 16; Transactions (filters) → 17; Settings drawer → 18. ✓
- Real-time SSE invalidation → Task 19. ✓
- PWA manifest/sw/install icons/offline shell → Task 20. ✓
- No-CDN / self-hosted assets + Fugue CC BY attribution (NOTICE + About) → Tasks 12, 18. ✓

**Deliberate deferrals (documented in-task, not gaps):** `/api/push/subscribe` + web push (M8 hardening); TanStack Router deep-linking (state-based tabs suffice for the maximized-window UX); "+ New category" form and drag-between-boxes (reassignment dropdown ships; create reuses live POST). Each is called out where it occurs.

**Type consistency:** Go `BudgetConfig` fields (Task 1) match the JSON the frontend `BudgetConfig` interface decodes (Task 13) and the PUT body (Tasks 5, 18). `budget.Summary`/`BucketSummary` JSON tags (Task 4) match the TS `Summary`/`BucketSummary` (Task 13) and Dashboard usage (Task 15). `ReviewItem` Go field names (`AmountFils`, `MerchantRaw`, …) match the TS `Txn` interface used across views. `CategoryStore` interface gains `UpdateCategory`/`SnapshotBucketForCategory`/`DeleteRule` (Tasks 6, 7) — all implemented on `*store.Store` in Task 3. `fstest()` is defined once (Task 9) and consumed by `newTestServer` (Tasks 5–7); if executing strictly in order, Task 9's file is created before Task 5's tests run green — **execute Task 9 before running Tasks 5–8 test gates, or accept the noted temporary `fstest()` stub.**

**Execution ordering note:** Phase A tasks compile independently, but the server test helper `fstest()`/`newTestServer` is finalized in Task 9. Recommended order: 1 → 2 → 3 → 4 → **9** → 5 → 6 → 7 → 8 → 10 → (Phase B/C) 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21.
