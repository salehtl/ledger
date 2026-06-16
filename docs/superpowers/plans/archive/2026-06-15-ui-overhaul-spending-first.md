# Spending-First UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Windows-XP-themed PWA with a modern, data-dense, mobile-first app where *this month's spending vs. budget* is the hero of the home screen, transaction management (browse/filter/search/categorize/triage) is fast and obvious, and a dedicated Insights screen visualizes category breakdown and month-over-month trend.

**Architecture:** A thin Go **data slice** first adds the three things the new UI needs that the API lacks today: per-category spend, monthly trend totals, and a `category` on each transaction row (plus `/api/summary` honoring `?period=`). Then the React frontend is rebuilt on **Tailwind CSS v4** with **Recharts** for charts and **lucide-react** for icons. `xp.css` and the XP-era components/views are removed. Navigation is four tabs — **Home · Transactions · Insights · Settings** — with review folded into Transactions as a "Needs review" filter. Money stays `int64` fils over the wire; the UI converts only at input boundaries.

**Tech Stack:** Go 1.22 (`net/http`, `database/sql`, `modernc.org/sqlite`); Bun 1.3 (build-time), Vite 5, React 18 + TypeScript, TanStack Query, **Tailwind CSS v4** (`@tailwindcss/vite`), **Recharts**, **lucide-react**, `vite-plugin-pwa`, Vitest + `@testing-library/react`.

**Conventions in this codebase (follow them):**
- Backend money is `int64` **fils**; never floats for money. Handlers are methods on `*server.Server`; dependencies are narrow interfaces set via `Set*` methods with a `nil`-guard returning `503` when unset (see `internal/server/budget.go`). Store methods hang off `*store.Store` with `s.DB`. Timestamps are `time.Now().UTC().Format(time.RFC3339Nano)`. Run the Go suite with `go test ./...` from `/root/Coding/ledger`.
- Frontend: all work under `frontend/`. Run tests with `bun run test` (alias for `vitest run`); a single file with `bunx vitest run <path>`. Tests live beside the unit (`Foo.tsx` → `Foo.test.tsx`; `foo.ts` → `foo.test.ts`). `@testing-library/jest-dom` matchers auto-load via `src/test/setup.ts`, which also calls `afterEach(cleanup)`. The repo runs vitest single-fork (see `vite.config.ts`).
- The built SPA is embedded into the Go binary via `//go:embed all:dist` (`internal/web/embed.go`); the production deploy rebuilds `internal/web/dist` and restarts `ledger.service` (this box is the prod server "dinosaur").
- **Existing JSON shapes you build on:** `GET /api/summary` → `{period, income, month_progress, buckets[], recent[]}` where each bucket is `{bucket, target, spent, remaining, pct_used, projection}` (snake_case). Transactions/`recent` items (Go `store.ReviewItem`, **no json tags** → PascalCase keys) → `{ID, PostedAt, AmountFils, Currency, Direction, MerchantRaw, Status, Confidence, Source}`. `GET /api/categories` → `[{ID, Name, Kind, Bucket, IsActive}]`. `GET /api/transactions?status=&from=&to=`. `POST /api/transactions/{id}/categorize` body `{category_id, make_rule, merchant_raw}`. `POST /api/transactions/{id}/status` body `{status}`. SSE at `GET /api/events`.

---

## Scope Note

This is one plan with six phases. **Each phase produces working, shippable software** and can be merged on its own:
- **Phase A (backend)** ships new endpoints/fields with no UI change.
- **Phase B (foundation)** stands up Tailwind + the new app shell/nav while the old screens still render inside it.
- **Phases C–F** replace screens one at a time; the app stays runnable after each.
The old XP files are deleted only in **Phase F**, after every screen that depended on them is gone.

---

## File Structure

### Backend (Phase A)
| File | Status | Responsibility |
|---|---|---|
| `internal/store/insights.go` | Create | `CategorySpendRow`, `MonthlyTotalRow`; `SelectCategorySpend(period, frozen)`, `SelectMonthlyTotals(months)` |
| `internal/store/insights_test.go` | Create | Tests for both queries |
| `internal/store/categories.go` | Modify | Add `CategoryID *int64`, `CategoryName`, `Bucket` to `ReviewItem`; LEFT JOIN categories in `SelectNeedsReview`/`SelectTransactions`; update `scanReviewItems` |
| `internal/store/categories_test.go` | Modify | Assert the new category fields populate |
| `internal/store/budget.go` | Modify | `SelectRecent` LEFT JOINs categories too (so summary `recent[]` carries category) |
| `internal/server/insights.go` | Create | `InsightsStore` interface; `handleGetCategorySpend`, `handleGetTrend` |
| `internal/server/insights_test.go` | Create | httptest coverage |
| `internal/server/budget.go` | Modify | `handleGetSummary` honors `?period=YYYY-MM` |
| `internal/server/budget_test.go` | Modify | Test the period param |
| `internal/server/server.go` | Modify | Register `/api/insights/*`; add `insightsStore` + `SetInsightsStore` |
| `cmd/ledger/main.go` | Modify | `srv.SetInsightsStore(st)` |

### Frontend (Phases B–F)
| File | Status | Responsibility |
|---|---|---|
| `frontend/package.json` | Modify | Add `tailwindcss`, `@tailwindcss/vite`, `recharts`, `lucide-react`; remove `xp.css` |
| `frontend/vite.config.ts` | Modify | Add the Tailwind Vite plugin |
| `frontend/src/styles/app.css` | Create | `@import "tailwindcss"` + `@theme` design tokens |
| `frontend/src/main.tsx` | Modify | Import `app.css` (not XP); mount `<AppShell>` |
| `frontend/src/app/AppShell.tsx` | Create | Page layout: header, screen outlet, bottom nav, offline banner |
| `frontend/src/app/nav.ts` | Create | Tab definitions (id, label, icon) |
| `frontend/src/app/AppShell.test.tsx` | Create | Renders nav + switches screens |
| `frontend/src/components/ui/Card.tsx` | Create | Surface card |
| `frontend/src/components/ui/Button.tsx` | Create | Button variants |
| `frontend/src/components/ui/Pill.tsx` | Create | Status/bucket pill |
| `frontend/src/components/ui/ProgressBar.tsx` | Create | Budget progress bar (tone by pct) |
| `frontend/src/components/ui/Dialog.tsx` | Create | Accessible modal/sheet (replaces `Modal`) |
| `frontend/src/components/ui/SegmentedControl.tsx` | Create | Segmented toggle (filters, period) |
| `frontend/src/components/ui/BottomNav.tsx` | Create | Icon+label bottom navigation |
| `frontend/src/components/charts/DonutChart.tsx` | Create | Recharts donut wrapper |
| `frontend/src/components/charts/TrendBars.tsx` | Create | Recharts monthly bar wrapper |
| `frontend/src/lib/insights.ts` | Create | Pure data-shaping: donut data, trend data, totals, colors |
| `frontend/src/lib/insights.test.ts` | Create | Tests for the above |
| `frontend/src/api/types.ts` | Modify | Extend `Txn` (category fields); add `CategorySpend`, `MonthlyTotal` |
| `frontend/src/screens/Home.tsx` | Create | Data-dense spending home |
| `frontend/src/screens/Transactions.tsx` | Create | Browse/filter/search/triage/categorize |
| `frontend/src/screens/Insights.tsx` | Create | Donut + trend + category table |
| `frontend/src/screens/Settings.tsx` | Create | Budget, categories, rules (Tailwind rebuild) |
| `frontend/src/components/transactions/TransactionRow.tsx` | Create | One transaction row (tap to categorize, swipe-less actions) |
| `frontend/src/components/transactions/CategorizeSheet.tsx` | Create | Bottom-sheet categorizer with search + grouping |
| **Removed in Phase F** | Delete | `xp.css` dep; `styles/theme.css`; `components/{AppWindow,Taskbar,BucketBox,Modal,Icon}.tsx` (+tests); `views/{Dashboard,Review,Transactions,SettingsDrawer}.tsx` (+tests); `components/CategorizeDialog.tsx` (+test) |
| **Kept/reused** | — | `api/client.ts`, `queryClient.ts`, `lib/money.ts`, `lib/format.ts`, `hooks/{useOnline,useLiveEvents}.ts`, `components/{Money,EmptyState,Skeleton,Toast}.tsx` (Toast/EmptyState/Skeleton get a Tailwind restyle in Phase B) |

---

# Phase A — Backend data slice (Go, TDD)

### Task A1: `ReviewItem` carries its category

**Files:**
- Modify: `internal/store/categories.go`
- Modify: `internal/store/budget.go` (the `SelectRecent` query)
- Test: `internal/store/categories_test.go`

The transaction stream and home "recent" list must show each transaction's category + bucket. `ReviewItem` has none today. Add three fields and LEFT JOIN `categories` in every query that builds `ReviewItem`s.

- [ ] **Step 1: Write the failing test**

Add to `internal/store/categories_test.go`:

```go
func TestSelectTransactionsIncludesCategory(t *testing.T) {
	st := openTestStore(t)
	if err := st.SeedCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, _ := st.SelectCategories()
	var groceries CategoryRow
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceries = c
		}
	}
	id, _, err := st.InsertTransaction(TransactionRow{
		PostedAt: mustTime("2026-06-10T09:00:00Z"), AmountFils: 5000, Currency: "AED",
		Direction: "debit", MerchantRaw: "SPINNEYS", Status: "confirmed", Source: "email",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := st.SetCategory(id, groceries.ID); err != nil {
		t.Fatalf("setcategory: %v", err)
	}
	items, err := st.SelectTransactions("", "", "")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	got := items[0]
	if got.CategoryID == nil || *got.CategoryID != groceries.ID {
		t.Fatalf("CategoryID = %v, want %d", got.CategoryID, groceries.ID)
	}
	if got.CategoryName != "Groceries" || got.Bucket != "need" {
		t.Fatalf("CategoryName/Bucket = %q/%q, want Groceries/need", got.CategoryName, got.Bucket)
	}
}
```

This relies on a `SetCategory(txnID, catID int64) error` helper and `mustTime`. If `SetCategory` does not exist, check `internal/store/categories.go` for the method the categorize handler uses to set a category (it may be named differently, e.g. `Categorize`); use that. If `mustTime` does not exist in the test package, add it:

```go
func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestSelectTransactionsIncludesCategory`
Expected: FAIL — `got.CategoryID undefined` (field doesn't exist).

- [ ] **Step 3: Extend the struct, the queries, and the scanner**

In `internal/store/categories.go`, add fields to `ReviewItem`:

```go
// ReviewItem is a flattened transaction row returned for manual review.
type ReviewItem struct {
	ID           int64
	PostedAt     string
	AmountFils   int64
	Currency     string
	Direction    string
	MerchantRaw  string
	Status       string
	Confidence   float64
	Source       string
	CategoryID   *int64 // nil when uncategorized
	CategoryName string // "" when uncategorized
	Bucket       string // "" when uncategorized or category has no bucket
}
```

Replace the `SELECT` in `SelectNeedsReview`:

```go
func (s *Store) SelectNeedsReview() ([]ReviewItem, error) {
	rows, err := s.DB.Query(
		`SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,'')
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  WHERE t.status='needs_review' ORDER BY t.posted_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
```

Replace the `SELECT` (and qualify columns) in `SelectTransactions`:

```go
func (s *Store) SelectTransactions(status, from, to string) ([]ReviewItem, error) {
	q := `SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
	             COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	             t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,'')
	      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	      WHERE 1=1`
	var args []any
	if status != "" {
		q += " AND t.status=?"
		args = append(args, status)
	}
	if from != "" {
		q += " AND t.posted_at >= ?"
		args = append(args, from)
	}
	if to != "" {
		q += " AND t.posted_at <= ?"
		args = append(args, to)
	}
	q += " ORDER BY t.posted_at DESC"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
```

Update `scanReviewItems` to read the three new columns (category_id is nullable):

```go
func scanReviewItems(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]ReviewItem, error) {
	var out []ReviewItem
	for rows.Next() {
		var r ReviewItem
		var catID sql.NullInt64
		if err := rows.Scan(
			&r.ID, &r.PostedAt, &r.AmountFils, &r.Currency, &r.Direction,
			&r.MerchantRaw, &r.Status, &r.Confidence, &r.Source,
			&catID, &r.CategoryName, &r.Bucket,
		); err != nil {
			return nil, err
		}
		if catID.Valid {
			id := catID.Int64
			r.CategoryID = &id
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
```

Ensure `database/sql` is imported in `categories.go` (add it to the import block if missing).

In `internal/store/budget.go`, update `SelectRecent` to LEFT JOIN so summary `recent[]` carries category too:

```go
func (s *Store) SelectRecent(n int) ([]ReviewItem, error) {
	rows, err := s.DB.Query(
		`SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,'')
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  ORDER BY t.posted_at DESC LIMIT ?`, n,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/store/`
Expected: PASS — including the new test and all pre-existing store tests (the added columns are backward-compatible; `scanReviewItems` now reads 12 columns, and every query was updated to supply them).

- [ ] **Step 5: Commit**

```bash
git add internal/store/categories.go internal/store/budget.go internal/store/categories_test.go
git commit -m "feat(store): ReviewItem carries category id/name/bucket via LEFT JOIN"
```

---

### Task A2: `SelectCategorySpend` + `SelectMonthlyTotals`

**Files:**
- Create: `internal/store/insights.go`
- Test: `internal/store/insights_test.go`

Two read queries powering the Insights screen: spend grouped by category for one month, and per-month spend+income totals for the trend.

- [ ] **Step 1: Write the failing test**

```go
// internal/store/insights_test.go
package store

import "testing"

func TestSelectCategorySpend(t *testing.T) {
	st := openTestStore(t)
	if err := st.SeedCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, _ := st.SelectCategories()
	id := func(name string) int64 {
		for _, c := range cats {
			if c.Name == name {
				return c.ID
			}
		}
		t.Fatalf("no category %q", name)
		return 0
	}
	add := func(merchant string, fils int64, cat int64) {
		tid, _, err := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime("2026-06-10T09:00:00Z"), AmountFils: fils, Currency: "AED",
			Direction: "debit", MerchantRaw: merchant, Status: "confirmed", Source: "email",
		})
		if err != nil {
			t.Fatalf("insert: %v", err)
		}
		if err := st.SetCategory(tid, cat); err != nil {
			t.Fatalf("setcat: %v", err)
		}
	}
	add("SPINNEYS", 5000, id("Groceries"))
	add("CARREFOUR", 3000, id("Groceries"))
	add("NETFLIX", 4000, id("Subscriptions"))

	rows, err := st.SelectCategorySpend("2026-06", false)
	if err != nil {
		t.Fatalf("category spend: %v", err)
	}
	// Sorted by spend desc: Groceries 8000 (need), Subscriptions 4000 (want)
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].Name != "Groceries" || rows[0].AmountFils != 8000 || rows[0].Bucket != "need" {
		t.Fatalf("row0 = %+v", rows[0])
	}
	if rows[1].Name != "Subscriptions" || rows[1].AmountFils != 4000 {
		t.Fatalf("row1 = %+v", rows[1])
	}
}

func TestSelectMonthlyTotals(t *testing.T) {
	st := openTestStore(t)
	if err := st.SeedCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, _ := st.SelectCategories()
	gid, sid := int64(0), int64(0)
	for _, c := range cats {
		if c.Name == "Groceries" {
			gid = c.ID
		}
		if c.Name == "Salary" {
			sid = c.ID
		}
	}
	if sid == 0 {
		t.Skip("no Salary income category in seed; adjust to an income category name present in seedCategories")
	}
	spend := func(ts string, fils int64) {
		tid, _, _ := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime(ts), AmountFils: fils, Currency: "AED",
			Direction: "debit", MerchantRaw: "X", Status: "confirmed", Source: "email",
		})
		st.SetCategory(tid, gid)
	}
	income := func(ts string, fils int64) {
		tid, _, _ := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime(ts), AmountFils: fils, Currency: "AED",
			Direction: "credit", MerchantRaw: "PAY", Status: "confirmed", Source: "email",
		})
		st.SetCategory(tid, sid)
	}
	spend("2026-06-05T09:00:00Z", 5000)
	spend("2026-06-20T09:00:00Z", 3000)
	income("2026-06-01T09:00:00Z", 100000)

	rows, err := st.SelectMonthlyTotals(3)
	if err != nil {
		t.Fatalf("monthly totals: %v", err)
	}
	// Find the 2026-06 bucket.
	var june MonthlyTotalRow
	for _, r := range rows {
		if r.Period == "2026-06" {
			june = r
		}
	}
	if june.SpentFils != 8000 || june.IncomeFils != 100000 {
		t.Fatalf("june = %+v, want spent 8000 income 100000", june)
	}
}
```

If the seed category set has no income category named "Salary", the second test self-skips that assertion path — but check `seedCategories` in `internal/store/categories.go` for the real income category name and use it (replace `"Salary"`). The income kind is `kind='income'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run 'TestSelectCategorySpend|TestSelectMonthlyTotals'`
Expected: FAIL — `SelectCategorySpend` / `MonthlyTotalRow` undefined.

- [ ] **Step 3: Implement**

```go
// internal/store/insights.go
package store

import "time"

// CategorySpendRow is one category's confirmed spend in a period.
type CategorySpendRow struct {
	CategoryID int64
	Name       string
	Bucket     string
	AmountFils int64
}

// SelectCategorySpend returns confirmed spending-kind debits in the period,
// grouped by category, highest spend first. Bucket honors bucket_snapshot when frozen.
func (s *Store) SelectCategorySpend(period string, frozen bool) ([]CategorySpendRow, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return nil, err
	}
	bucketExpr := "c.bucket"
	if frozen {
		bucketExpr = "COALESCE(t.bucket_snapshot, c.bucket)"
	}
	rows, err := s.DB.Query(
		`SELECT c.id, c.name, COALESCE(`+bucketExpr+`,''), SUM(t.amount)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='spending' AND t.direction='debit'
		    AND t.posted_at >= ? AND t.posted_at < ?
		  GROUP BY c.id, c.name
		  ORDER BY SUM(t.amount) DESC`,
		start, end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CategorySpendRow
	for rows.Next() {
		var r CategorySpendRow
		if err := rows.Scan(&r.CategoryID, &r.Name, &r.Bucket, &r.AmountFils); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MonthlyTotalRow is confirmed spend + income for one calendar month.
type MonthlyTotalRow struct {
	Period     string // "YYYY-MM"
	SpentFils  int64
	IncomeFils int64
}

// SelectMonthlyTotals returns the trailing `months` calendar months (oldest first),
// each with confirmed spending debits and income credits. Months with no activity
// are omitted by the GROUP BY; the caller (frontend) fills gaps for display.
func (s *Store) SelectMonthlyTotals(months int) ([]MonthlyTotalRow, error) {
	if months < 1 {
		months = 1
	}
	now := time.Now().UTC()
	firstOfThis := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	start := firstOfThis.AddDate(0, -(months - 1), 0).Format("2006-01-02")
	rows, err := s.DB.Query(
		`SELECT strftime('%Y-%m', t.posted_at) AS ym,
		        COALESCE(SUM(CASE WHEN c.kind='spending' AND t.direction='debit' THEN t.amount END),0),
		        COALESCE(SUM(CASE WHEN c.kind='income'   AND t.direction='credit' THEN t.amount END),0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND t.posted_at >= ?
		  GROUP BY ym ORDER BY ym`,
		start,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MonthlyTotalRow
	for rows.Next() {
		var r MonthlyTotalRow
		if err := rows.Scan(&r.Period, &r.SpentFils, &r.IncomeFils); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
```

`monthRange` already exists in `internal/store/budget.go` (same package) — reuse it.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/insights.go internal/store/insights_test.go
git commit -m "feat(store): SelectCategorySpend + SelectMonthlyTotals for insights"
```

---

### Task A3: Insights HTTP endpoints

**Files:**
- Create: `internal/server/insights.go`
- Test: `internal/server/insights_test.go`
- Modify: `internal/server/server.go`
- Modify: `cmd/ledger/main.go`

- [ ] **Step 1: Write the failing test**

```go
// internal/server/insights_test.go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"ledger/internal/store"
)

type stubInsights struct {
	cats  []store.CategorySpendRow
	trend []store.MonthlyTotalRow
	cfg   store.BudgetConfig
}

func (s stubInsights) SelectCategorySpend(period string, frozen bool) ([]store.CategorySpendRow, error) {
	return s.cats, nil
}
func (s stubInsights) SelectMonthlyTotals(months int) ([]store.MonthlyTotalRow, error) {
	return s.trend, nil
}
func (s stubInsights) SelectBudgetConfig() (store.BudgetConfig, error) { return s.cfg, nil }

func TestHandleGetCategorySpend(t *testing.T) {
	srv := New(nil)
	srv.SetInsightsStore(stubInsights{
		cats: []store.CategorySpendRow{{CategoryID: 1, Name: "Groceries", Bucket: "need", AmountFils: 8000}},
	})
	req := httptest.NewRequest("GET", "/api/insights/categories?period=2026-06", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0]["name"] != "Groceries" || got[0]["spent"].(float64) != 8000 {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHandleGetTrend(t *testing.T) {
	srv := New(nil)
	srv.SetInsightsStore(stubInsights{
		trend: []store.MonthlyTotalRow{{Period: "2026-06", SpentFils: 8000, IncomeFils: 100000}},
	})
	req := httptest.NewRequest("GET", "/api/insights/trend?months=3", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got []map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if len(got) != 1 || got[0]["period"] != "2026-06" || got[0]["spent"].(float64) != 8000 {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestInsightsUnset503(t *testing.T) {
	srv := New(nil)
	req := httptest.NewRequest("GET", "/api/insights/categories", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", rec.Code)
	}
}
```

Check `internal/server/server.go` for the constructor name (`New`) and how other handler tests build a `*Server` (see `internal/server/budget_test.go`); mirror that exactly if `New(nil)` differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run 'Insights|Trend|CategorySpend'`
Expected: FAIL — `SetInsightsStore` undefined.

- [ ] **Step 3: Implement the handlers + interface**

```go
// internal/server/insights.go
package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"ledger/internal/store"
)

// InsightsStore is the read surface the insights endpoints need.
type InsightsStore interface {
	SelectCategorySpend(period string, frozen bool) ([]store.CategorySpendRow, error)
	SelectMonthlyTotals(months int) ([]store.MonthlyTotalRow, error)
	SelectBudgetConfig() (store.BudgetConfig, error)
}

// SetInsightsStore wires the insights read store. Required for /api/insights/*.
func (s *Server) SetInsightsStore(i InsightsStore) { s.insightsStore = i }

type categorySpendDTO struct {
	CategoryID int64  `json:"category_id"`
	Name       string `json:"name"`
	Bucket     string `json:"bucket"`
	Spent      int64  `json:"spent"`
}

type trendDTO struct {
	Period string `json:"period"`
	Spent  int64  `json:"spent"`
	Income int64  `json:"income"`
}

func (s *Server) handleGetCategorySpend(w http.ResponseWriter, r *http.Request) {
	if s.insightsStore == nil {
		http.Error(w, "insights unavailable", http.StatusServiceUnavailable)
		return
	}
	period := r.URL.Query().Get("period")
	if period == "" {
		period = time.Now().UTC().Format("2006-01")
	}
	cfg, err := s.insightsStore.SelectBudgetConfig()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rows, err := s.insightsStore.SelectCategorySpend(period, cfg.FreezeHistory)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]categorySpendDTO, 0, len(rows))
	for _, c := range rows {
		out = append(out, categorySpendDTO{c.CategoryID, c.Name, c.Bucket, c.AmountFils})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handleGetTrend(w http.ResponseWriter, r *http.Request) {
	if s.insightsStore == nil {
		http.Error(w, "insights unavailable", http.StatusServiceUnavailable)
		return
	}
	months := 6
	if v := r.URL.Query().Get("months"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 24 {
			months = n
		}
	}
	rows, err := s.insightsStore.SelectMonthlyTotals(months)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]trendDTO, 0, len(rows))
	for _, m := range rows {
		out = append(out, trendDTO{m.Period, m.SpentFils, m.IncomeFils})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
```

In `internal/server/server.go`: add the field `insightsStore InsightsStore` to the `Server` struct (next to `budgetStore`), and register the routes inside the same block that registers the others (near line 145):

```go
	s.mux.HandleFunc("GET /api/insights/categories", s.handleGetCategorySpend)
	s.mux.HandleFunc("GET /api/insights/trend", s.handleGetTrend)
```

In `cmd/ledger/main.go`, where the store is wired into the server (look for `srv.SetBudgetStore(st)`), add immediately after it:

```go
	srv.SetInsightsStore(st)
```

(The concrete `*store.Store` already satisfies `InsightsStore` because of Tasks A1–A2 plus the existing `SelectBudgetConfig`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/insights.go internal/server/insights_test.go internal/server/server.go cmd/ledger/main.go
git commit -m "feat(server): /api/insights/categories and /api/insights/trend"
```

---

### Task A4: `/api/summary` honors `?period=`

**Files:**
- Modify: `internal/server/budget.go` (`handleGetSummary`)
- Test: `internal/server/budget_test.go`

The Home period selector ("June ▾") needs to request prior months. Today `handleGetSummary` always uses the current month.

- [ ] **Step 1: Write the failing test**

Add to `internal/server/budget_test.go` (mirror the existing summary test's setup for building the server + stub store):

```go
func TestSummaryHonorsPeriodParam(t *testing.T) {
	// Reuse the same stub/store construction the existing summary test uses.
	srv, _ := newSummaryTestServer(t) // <- if the existing test uses a different helper, use that
	req := httptest.NewRequest("GET", "/api/summary?period=2026-05", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d", rec.Code)
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["period"] != "2026-05" {
		t.Fatalf("period = %v, want 2026-05", got["period"])
	}
}
```

If there is no `newSummaryTestServer` helper, read the existing `TestHandleGetSummary` (or similar) in `budget_test.go` and copy its server/stub setup inline into this test. The stub's `SelectMonthSpend`/`SelectMonthIncome` ignore the period, so any valid period string flows straight to the response.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/server/ -run TestSummaryHonorsPeriodParam`
Expected: FAIL — response `period` is the current month, not `2026-05`.

- [ ] **Step 3: Implement**

In `handleGetSummary` (`internal/server/budget.go`), replace the line that sets `period` (currently `period := now.Format("2006-01")`) with:

```go
	now := time.Now().UTC()
	period := r.URL.Query().Get("period")
	if period == "" {
		period = now.Format("2006-01")
	} else if _, err := time.Parse("2006-01", period); err != nil {
		http.Error(w, "bad period", http.StatusBadRequest)
		return
	}
```

Keep the rest of the handler unchanged (it already passes `period` into `SelectMonthSpend`/`SelectMonthIncome` and into the `Summary`). Ensure `time` and `net/http` are imported (they already are).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/budget.go internal/server/budget_test.go
git commit -m "feat(server): /api/summary honors ?period=YYYY-MM"
```

---

### Task A5: Backend phase gate

**Files:** none (verification only)

- [ ] **Step 1: Full Go suite**

Run: `go test ./...`
Expected: all packages `ok`.

- [ ] **Step 2: Build**

Run: `go build ./...`
Expected: clean.

- [ ] **Step 3: Smoke the new endpoints on an isolated instance**

```bash
go build -o /tmp/ledger-smoke ./cmd/ledger
D=$(mktemp -d); LEDGER_LISTEN=127.0.0.1:8099 LEDGER_DATA_DIR="$D" /tmp/ledger-smoke >/tmp/smoke.log 2>&1 &
P=$!; sleep 1
curl -s -o /dev/null -w 'categories=%{http_code}\n' 'http://127.0.0.1:8099/api/insights/categories?period=2026-06'
curl -s -o /dev/null -w 'trend=%{http_code}\n'      'http://127.0.0.1:8099/api/insights/trend?months=3'
curl -s -o /dev/null -w 'summary=%{http_code}\n'    'http://127.0.0.1:8099/api/summary?period=2026-05'
kill $P; rm -rf "$D" /tmp/ledger-smoke
```
Expected: `categories=200`, `trend=200`, `summary=200`.

(No commit — verification only. Phase A is independently mergeable here.)

---

# Phase B — Frontend foundation (Tailwind + shell)

> The old screens keep rendering through this phase; we swap the *frame* and primitives, not the screens yet.

### Task B1: Install Tailwind, Recharts, lucide-react; remove xp.css

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/vite.config.ts`
- Create: `frontend/src/styles/app.css`
- Modify: `frontend/src/main.tsx`

- [ ] **Step 1: Add/remove dependencies**

```bash
cd frontend
bun add tailwindcss @tailwindcss/vite recharts lucide-react
bun remove xp.css
```

Expected: `package.json` gains `tailwindcss`, `@tailwindcss/vite`, `recharts`, `lucide-react`; loses `xp.css`.

- [ ] **Step 2: Wire the Tailwind Vite plugin**

Edit `frontend/vite.config.ts` — add the import and plugin (keep the existing React + PWA plugins and the `test` block exactly as they are):

```ts
import tailwindcss from "@tailwindcss/vite";
// ...
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({ /* unchanged */ }),
  ],
  // build + test blocks unchanged
});
```

- [ ] **Step 3: Create the Tailwind entry + design tokens**

```css
/* frontend/src/styles/app.css */
@import "tailwindcss";

/* Design tokens (Tailwind v4 CSS-first config). Spending-app palette:
   neutral surfaces, one indigo accent, semantic + per-bucket colors. */
@theme {
  --color-bg: #f6f7f9;
  --color-surface: #ffffff;
  --color-border: #e6e8ec;
  --color-fg: #14171f;
  --color-muted: #6b7280;
  --color-accent: #4f46e5;
  --color-accent-fg: #ffffff;

  --color-need: #2563eb;   /* blue */
  --color-want: #d97706;   /* amber */
  --color-save: #059669;   /* green */

  --color-good: #059669;
  --color-warn: #d97706;
  --color-bad: #dc2626;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --radius-card: 16px;
}

html, body, #root { height: 100%; }
body { background: var(--color-bg); color: var(--color-fg); font-family: var(--font-sans);
       -webkit-text-size-adjust: 100%; }
/* tabular figures for money everywhere */
.tnum { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Point the app at the new CSS**

Edit `frontend/src/main.tsx` — replace the first two import lines:

```ts
// remove: import "xp.css/dist/XP.css";
// remove: import "./styles/theme.css";
import "./styles/app.css";
```

Leave the rest of `main.tsx` as-is for now (it still mounts the current `<App>`; Task B3 swaps that). The app will momentarily look unstyled — that's expected mid-phase.

- [ ] **Step 5: Verify build + tests still run**

Run: `cd frontend && bun run test`
Expected: the suite still passes (45 tests). CSS/plugin changes don't affect the existing component tests.
Run: `cd frontend && bun run build`
Expected: Vite build succeeds with Tailwind processing `app.css`.

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/bun.lock frontend/vite.config.ts frontend/src/styles/app.css frontend/src/main.tsx
git commit -m "build(pwa): Tailwind v4 + Recharts + lucide-react; drop xp.css"
```

---

### Task B2: UI primitives (Card, Button, Pill, ProgressBar, SegmentedControl)

**Files:**
- Create: `frontend/src/components/ui/Card.tsx`
- Create: `frontend/src/components/ui/Button.tsx`
- Create: `frontend/src/components/ui/Pill.tsx`
- Create: `frontend/src/components/ui/ProgressBar.tsx`
- Create: `frontend/src/components/ui/SegmentedControl.tsx`
- Test: `frontend/src/components/ui/Pill.test.tsx`, `frontend/src/components/ui/ProgressBar.test.tsx`, `frontend/src/components/ui/SegmentedControl.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/src/components/ui/Pill.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Pill } from "./Pill";

describe("Pill", () => {
  it("renders its label with a tone class", () => {
    const { container } = render(<Pill tone="warn">Needs review</Pill>);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(container.firstChild).toHaveClass("text-warn");
  });
});
```

```tsx
// frontend/src/components/ui/ProgressBar.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("clamps width to 0..100 and sets aria-valuenow", () => {
    const { getByRole } = render(<ProgressBar pct={1.4} />);
    const bar = getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    const fill = bar.firstChild as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });
  it("uses the bad tone at/over 100%", () => {
    const { getByRole } = render(<ProgressBar pct={1.0} />);
    expect((getByRole("progressbar").firstChild as HTMLElement).className).toContain("bg-bad");
  });
});
```

```tsx
// frontend/src/components/ui/SegmentedControl.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SegmentedControl } from "./SegmentedControl";

describe("SegmentedControl", () => {
  it("marks the active option and fires onChange", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        value="all"
        onChange={onChange}
        options={[{ value: "all", label: "All" }, { value: "review", label: "Needs review" }]}
      />,
    );
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Needs review" }));
    expect(onChange).toHaveBeenCalledWith("review");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run src/components/ui/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the primitives**

```tsx
// frontend/src/components/ui/Card.tsx
import type { ReactNode } from "react";
export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`bg-surface border border-border rounded-[var(--radius-card)] p-4 ${className}`}>
      {children}
    </div>
  );
}
```

```tsx
// frontend/src/components/ui/Button.tsx
import type { ButtonHTMLAttributes, ReactNode } from "react";
type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "bg-surface border border-border text-fg hover:bg-bg",
  ghost: "bg-transparent text-fg hover:bg-bg",
  danger: "bg-bad text-white hover:opacity-90",
};
export function Button(
  { variant = "secondary", className = "", children, ...rest }:
  { variant?: Variant; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>,
) {
  return (
    <button
      className={`min-h-11 px-4 rounded-xl text-sm font-medium inline-flex items-center justify-center gap-2 disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
```

```tsx
// frontend/src/components/ui/Pill.tsx
import type { ReactNode } from "react";
export type Tone = "good" | "warn" | "bad" | "muted" | "neutral";
const TONES: Record<Tone, string> = {
  good: "text-good bg-good/10",
  warn: "text-warn bg-warn/10",
  bad: "text-bad bg-bad/10",
  muted: "text-muted bg-muted/10",
  neutral: "text-accent bg-accent/10",
};
export function Pill({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>
      {children}
    </span>
  );
}
```

```tsx
// frontend/src/components/ui/ProgressBar.tsx
/** pct is a fraction (0..1+). Tone: green <0.8, amber <1.0, red >=1.0. */
export function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct * 100));
  const tone = pct >= 1.0 ? "bg-bad" : pct >= 0.8 ? "bg-warn" : "bg-good";
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-2.5 w-full rounded-full bg-border overflow-hidden"
    >
      <div className={`h-full rounded-full transition-[width] duration-300 ${tone}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}
```

```tsx
// frontend/src/components/ui/SegmentedControl.tsx
export function SegmentedControl<T extends string>({
  value, onChange, options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div role="tablist" className="inline-flex p-1 bg-bg border border-border rounded-xl gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/components/ui/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/Card.tsx frontend/src/components/ui/Button.tsx frontend/src/components/ui/Pill.tsx frontend/src/components/ui/ProgressBar.tsx frontend/src/components/ui/SegmentedControl.tsx frontend/src/components/ui/Pill.test.tsx frontend/src/components/ui/ProgressBar.test.tsx frontend/src/components/ui/SegmentedControl.test.tsx
git commit -m "feat(pwa): Tailwind UI primitives — Card, Button, Pill, ProgressBar, SegmentedControl"
```

---

### Task B3: App shell + bottom nav

**Files:**
- Create: `frontend/src/app/nav.ts`
- Create: `frontend/src/components/ui/BottomNav.tsx`
- Create: `frontend/src/app/AppShell.tsx`
- Test: `frontend/src/app/AppShell.test.tsx`
- Modify: `frontend/src/main.tsx`

The shell owns the four-tab navigation, the header (title + offline state), the toast outlet, and SSE wiring. During Phases B–E it renders the *existing* views as placeholders for tabs not yet rebuilt, so the app always works.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/app/AppShell.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { AppShell } from "./AppShell";

beforeEach(() => {
  // Every screen hits the API on mount; return empty payloads.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify({ period: "2026-06", income: 0, month_progress: 0, buckets: [], recent: [] }));
    if (url.includes("/api/events")) return new Response("");
    return new Response("[]");
  }));
  // EventSource isn't in jsdom; stub it so useLiveEvents doesn't throw.
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} set onerror(_v: unknown) {} });
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><ToastProvider><AppShell /></ToastProvider></QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("shows four tabs and starts on Home", async () => {
    wrap();
    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("switches screens when a tab is tapped", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    // Settings screen renders a "Settings" heading.
    expect(await screen.findByRole("heading", { name: /settings/i })).toBeInTheDocument();
  });
});
```

Note: this test imports screens that don't exist until Phases C–F. To keep Phase B self-contained, the shell initially maps every tab to a tiny inline placeholder that renders the tab's label as an `<h1>` (see Step 3). The test's "Settings" heading assertion passes against that placeholder. Phases C–F replace the placeholders with real screens and update this test if the heading text changes (Settings keeps an `<h1>Settings</h1>`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/app/AppShell.test.tsx`
Expected: FAIL — `./AppShell` not found.

- [ ] **Step 3: Implement nav, BottomNav, and the shell**

```ts
// frontend/src/app/nav.ts
import { Home, ListOrdered, PieChart, Settings, type LucideIcon } from "lucide-react";

export type TabId = "home" | "transactions" | "insights" | "settings";

export const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "transactions", label: "Transactions", icon: ListOrdered },
  { id: "insights", label: "Insights", icon: PieChart },
  { id: "settings", label: "Settings", icon: Settings },
];
```

```tsx
// frontend/src/components/ui/BottomNav.tsx
import { TABS, type TabId } from "../../app/nav";

export function BottomNav({
  active, reviewCount, onNavigate,
}: { active: TabId; reviewCount: number; onNavigate: (id: TabId) => void }) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface border-t border-border grid grid-cols-4 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            aria-label={t.label}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onNavigate(t.id)}
            className={`min-h-14 flex flex-col items-center justify-center gap-0.5 text-xs ${isActive ? "text-accent" : "text-muted"}`}
          >
            <span className="relative">
              <Icon size={22} aria-hidden />
              {t.id === "transactions" && reviewCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full bg-bad text-white text-[10px] leading-4 text-center">
                  {reviewCount}
                </span>
              )}
            </span>
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
```

```tsx
// frontend/src/app/AppShell.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { BottomNav } from "../components/ui/BottomNav";
import { TABS, type TabId } from "./nav";
import { useOnline } from "../hooks/useOnline";
import { useLiveEvents } from "../hooks/useLiveEvents";

// Phase B placeholder — replaced by real screens in Phases C–F.
function Placeholder({ title }: { title: string }) {
  return <h1 className="text-xl font-semibold">{title}</h1>;
}

const TITLES: Record<TabId, string> = {
  home: "Home", transactions: "Transactions", insights: "Insights", settings: "Settings",
};

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const reviewCount = review.data?.length ?? 0;

  return (
    <div className="min-h-[100dvh] flex flex-col">
      {!online && (
        <div role="status" className="bg-warn/15 text-warn text-sm text-center py-1">Offline — showing last loaded data</div>
      )}
      <main className="flex-1 max-w-screen-sm w-full mx-auto px-4 pt-4 pb-24">
        {TABS.map((t) => (tab === t.id ? <Placeholder key={t.id} title={TITLES[t.id]} /> : null))}
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />
    </div>
  );
}
```

Edit `frontend/src/main.tsx` to mount `<AppShell>` instead of `<App>` (keep the providers):

```tsx
import "./styles/app.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./queryClient";
import { ToastProvider } from "./components/Toast";
import { AppShell } from "./app/AppShell";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

`frontend/src/App.tsx` is now unused; it (and the old views) are deleted in Phase F.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/app/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `bun run test`
Expected: green (old view tests still pass — those views are untouched until Phase F; `App.test`-style tests don't exist, and `AppShell` is additive).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/nav.ts frontend/src/components/ui/BottomNav.tsx frontend/src/app/AppShell.tsx frontend/src/app/AppShell.test.tsx frontend/src/main.tsx
git commit -m "feat(pwa): app shell with four-tab bottom nav + offline banner"
```

---

### Task B4: Restyle Toast / EmptyState / Skeleton with Tailwind

**Files:**
- Modify: `frontend/src/components/Toast.tsx`, `frontend/src/components/EmptyState.tsx`, `frontend/src/components/Skeleton.tsx`

These three are reused by the new screens; they currently use `theme.css` class names that disappear in Phase F. Re-skin them with Tailwind so they look right and don't depend on `theme.css`. **Do not change their props or exported APIs** — only the JSX `className`s. Their existing tests assert on text/roles, not classes, so they stay green.

- [ ] **Step 1: Re-skin EmptyState**

```tsx
// frontend/src/components/EmptyState.tsx
import { type LucideIcon } from "lucide-react";
export function EmptyState({ icon: Icon, title, hint }: { icon?: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="text-center py-10 px-4 text-muted">
      {Icon && <Icon className="mx-auto mb-2" size={36} aria-hidden />}
      <p className="font-semibold text-fg">{title}</p>
      {hint && <p className="text-sm mt-1">{hint}</p>}
    </div>
  );
}
```

NOTE: this changes `EmptyState`'s `icon` prop type from the old string-name union to a `LucideIcon` component. Update `EmptyState.test.tsx` to import and pass a lucide icon:

```tsx
import { CheckCircle2 } from "lucide-react";
// ...
render(<EmptyState icon={CheckCircle2} title="All caught up" hint="Nothing to review" />);
```

The old `Icon` (XP PNG) component is removed in Phase F; new screens pass lucide icons.

- [ ] **Step 2: Re-skin Skeleton**

```tsx
// frontend/src/components/Skeleton.tsx
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 rounded bg-border animate-pulse" />
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Re-skin Toast (JSX classes only — keep reducer/provider/useToast/exports identical)**

In `frontend/src/components/Toast.tsx`, replace the rendered toast markup (the `.toast-stack` / `.toast` block) with Tailwind, preserving all logic, `toastReducer`, `ToastProvider`, `useToast`, `ToastItem`, the `useRef` id counter, the try/finally action handler, and the effect-based dismiss:

```tsx
// inside ToastProvider's return — replace the stack container + ToastItem markup:
<div className="fixed inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4 pointer-events-none" role="region" aria-label="Notifications">
  {toasts.map((t) => (
    <ToastItem key={t.id} toast={t} onDismiss={() => dispatch({ type: "remove", id: t.id })} />
  ))}
</div>
```

and `ToastItem`'s markup:

```tsx
const tone = toast.tone === "success" ? "bg-good" : toast.tone === "error" ? "bg-bad" : "bg-fg";
return (
  <div className={`pointer-events-auto flex items-center gap-3 max-w-[92vw] text-white px-3 py-2.5 rounded-xl shadow-lg ${tone}`}>
    <span className="flex-1 text-sm">{toast.message}</span>
    {toast.action && (
      <button
        className="text-sm font-semibold text-white/90 underline"
        onClick={() => { try { toast.action!.onAction(); } finally { onDismiss(); } }}
      >
        {toast.action.label}
      </button>
    )}
    <button aria-label="Dismiss" className="text-white/70" onClick={onDismiss}>×</button>
  </div>
);
```

(If the current `ToastItem` owns its own dismiss timer via `useEffect`, keep that effect; just swap the className/markup. Ensure `ToastItem` accepts an `onDismiss` prop.)

- [ ] **Step 4: Run the suite**

Run: `bun run test`
Expected: green — `Toast.test.tsx`, `EmptyState.test.tsx` (updated import), `Skeleton` consumers all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Toast.tsx frontend/src/components/EmptyState.tsx frontend/src/components/EmptyState.test.tsx frontend/src/components/Skeleton.tsx
git commit -m "feat(pwa): Tailwind re-skin of Toast, EmptyState, Skeleton"
```

---

# Phase C — Home (spending front and center)

### Task C1: Insights/data-shaping helpers + types

**Files:**
- Modify: `frontend/src/api/types.ts`
- Create: `frontend/src/lib/insights.ts`
- Test: `frontend/src/lib/insights.test.ts`

- [ ] **Step 1: Extend types**

```ts
// frontend/src/api/types.ts — extend Txn, add insight types
export interface Category { ID: number; Name: string; Kind: string; Bucket: string; IsActive: boolean; }
export interface Rule { ID: number; MatchType: string; Pattern: string; CategoryID: number; Priority: number; Source: string; }
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
  CategoryID: number | null; CategoryName: string; Bucket: string;
}
export interface BudgetConfig {
  monthly_income: number; need_pct: number; want_pct: number; saving_pct: number;
  income_source: string; freeze_history: boolean;
}
export interface BucketSummary {
  bucket: string; target: number; spent: number; remaining: number; pct_used: number; projection: number;
}
export interface Summary {
  period: string; income: number; month_progress: number; buckets: BucketSummary[]; recent: Txn[];
}
export interface CategorySpend { category_id: number; name: string; bucket: string; spent: number; }
export interface MonthlyTotal { period: string; spent: number; income: number; }
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/src/lib/insights.test.ts
import { describe, it, expect } from "vitest";
import {
  totalSpent, totalBudget, donutSlices, trendSeries, bucketColor, monthLabel,
} from "./insights";
import type { BucketSummary, CategorySpend, MonthlyTotal } from "../api/types";

const buckets: BucketSummary[] = [
  { bucket: "need", target: 300000, spent: 210000, remaining: 90000, pct_used: 0.7, projection: 300000 },
  { bucket: "want", target: 200000, spent: 180000, remaining: 20000, pct_used: 0.9, projection: 240000 },
  { bucket: "saving", target: 100000, spent: 92000, remaining: 8000, pct_used: 0.92, projection: 100000 },
];

describe("totals", () => {
  it("sums spent and target across buckets", () => {
    expect(totalSpent(buckets)).toBe(482000);
    expect(totalBudget(buckets)).toBe(600000);
  });
});

describe("donutSlices", () => {
  it("keeps top N and rolls the rest into 'Other'", () => {
    const cats: CategorySpend[] = [
      { category_id: 1, name: "Groceries", bucket: "need", spent: 5000 },
      { category_id: 2, name: "Dining", bucket: "want", spent: 4000 },
      { category_id: 3, name: "Transport", bucket: "need", spent: 3000 },
      { category_id: 4, name: "Misc", bucket: "want", spent: 1000 },
    ];
    const slices = donutSlices(cats, 2);
    expect(slices.map((s) => s.name)).toEqual(["Groceries", "Dining", "Other"]);
    expect(slices[2].value).toBe(4000); // 3000 + 1000
  });
});

describe("trendSeries", () => {
  it("fills missing months with zeros, oldest→newest, with labels", () => {
    const totals: MonthlyTotal[] = [{ period: "2026-06", spent: 8000, income: 100000 }];
    const series = trendSeries(totals, ["2026-04", "2026-05", "2026-06"]);
    expect(series.map((p) => p.spent)).toEqual([0, 0, 8000]);
    expect(series.map((p) => p.label)).toEqual(["Apr", "May", "Jun"]);
  });
});

describe("helpers", () => {
  it("maps buckets to colors and months to short labels", () => {
    expect(bucketColor("need")).toBe("var(--color-need)");
    expect(monthLabel("2026-01")).toBe("Jan");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run src/lib/insights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// frontend/src/lib/insights.ts
import type { BucketSummary, CategorySpend, MonthlyTotal } from "../api/types";

export function totalSpent(buckets: BucketSummary[]): number {
  return buckets.reduce((s, b) => s + b.spent, 0);
}
export function totalBudget(buckets: BucketSummary[]): number {
  return buckets.reduce((s, b) => s + b.target, 0);
}

export function bucketColor(bucket: string): string {
  switch (bucket) {
    case "need": return "var(--color-need)";
    case "want": return "var(--color-want)";
    case "saving": return "var(--color-save)";
    default: return "var(--color-muted)";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(period: string): string {
  const m = Number(period.slice(5, 7));
  return MONTHS[m - 1] ?? period;
}

export interface DonutSlice { name: string; value: number; color: string; }

/** Top `topN` categories by spend; everything else folded into "Other". */
export function donutSlices(cats: CategorySpend[], topN = 6): DonutSlice[] {
  const sorted = [...cats].sort((a, b) => b.spent - a.spent);
  const head = sorted.slice(0, topN).map((c) => ({ name: c.name, value: c.spent, color: bucketColor(c.bucket) }));
  const rest = sorted.slice(topN).reduce((s, c) => s + c.spent, 0);
  if (rest > 0) head.push({ name: "Other", value: rest, color: "var(--color-muted)" });
  return head;
}

export interface TrendPoint { period: string; label: string; spent: number; income: number; }

/** Project totals onto an explicit ordered list of periods, filling gaps with 0. */
export function trendSeries(totals: MonthlyTotal[], periods: string[]): TrendPoint[] {
  const byPeriod = new Map(totals.map((t) => [t.period, t]));
  return periods.map((p) => {
    const t = byPeriod.get(p);
    return { period: p, label: monthLabel(p), spent: t?.spent ?? 0, income: t?.income ?? 0 };
  });
}

/** The trailing `n` period strings ("YYYY-MM"), oldest first, ending at `end` (a YYYY-MM). */
export function trailingPeriods(end: string, n: number): string[] {
  const [y, m] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bunx vitest run src/lib/insights.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/lib/insights.ts frontend/src/lib/insights.test.ts
git commit -m "feat(pwa): insight data-shaping helpers + extended types"
```

---

### Task C2: Chart wrappers (DonutChart, TrendBars)

**Files:**
- Create: `frontend/src/components/charts/DonutChart.tsx`
- Create: `frontend/src/components/charts/TrendBars.tsx`

Thin Recharts wrappers. Recharts' `ResponsiveContainer` measures 0×0 under jsdom, so these are **not** unit-tested for SVG output — their input data is produced by the Phase-C1 helpers, which *are* tested. Keep them dumb (props in, chart out).

- [ ] **Step 1: Implement DonutChart**

```tsx
// frontend/src/components/charts/DonutChart.tsx
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import type { DonutSlice } from "../../lib/insights";
import { formatFils } from "../../lib/money";

export function DonutChart({ slices, centerLabel, centerValue }: {
  slices: DonutSlice[]; centerLabel: string; centerValue: number;
}) {
  return (
    <div className="relative h-44">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={slices} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%"
               stroke="none" paddingAngle={1}>
            {slices.map((s, i) => <Cell key={i} fill={s.color} />)}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span className="text-xs text-muted">{centerLabel}</span>
        <span className="text-lg font-semibold tnum">{formatFils(centerValue)}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement TrendBars**

```tsx
// frontend/src/components/charts/TrendBars.tsx
import { BarChart, Bar, XAxis, ResponsiveContainer, Cell } from "recharts";
import type { TrendPoint } from "../../lib/insights";

export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  return (
    <div className="h-32">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} stroke="var(--color-muted)" />
          <Bar dataKey="spent" radius={[4, 4, 0, 0]}>
            {points.map((p, i) => (
              <Cell key={i} fill={p.period === activePeriod ? "var(--color-accent)" : "var(--color-border)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && bunx tsc -b`
Expected: no errors (confirms Recharts types resolve and props line up).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/charts/DonutChart.tsx frontend/src/components/charts/TrendBars.tsx
git commit -m "feat(pwa): Recharts donut + trend-bar wrappers"
```

---

### Task C3: Home screen

**Files:**
- Create: `frontend/src/screens/Home.tsx`
- Test: `frontend/src/screens/Home.test.tsx`
- Modify: `frontend/src/app/AppShell.tsx` (render `<Home>` for the home tab)

The hero is the month's spend vs budget. Below it: a period selector, the donut by category, per-bucket progress bars, a small trend, and the recent stream.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/screens/Home.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Home } from "./Home";
import type { Summary, CategorySpend, MonthlyTotal } from "../api/types";

const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [
    { bucket: "need", target: 300000, spent: 210000, remaining: 90000, pct_used: 0.7, projection: 300000 },
    { bucket: "want", target: 200000, spent: 180000, remaining: 20000, pct_used: 0.9, projection: 240000 },
    { bucket: "saving", target: 100000, spent: 92000, remaining: 8000, pct_used: 0.92, projection: 100000 },
  ],
  recent: [
    { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 1, CategoryName: "Groceries", Bucket: "need" },
  ],
};
const cats: CategorySpend[] = [{ category_id: 1, name: "Groceries", bucket: "need", spent: 210000 }];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 482000, income: 1500000 }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Home /></QueryClientProvider>);
}

describe("Home", () => {
  it("shows the spent-this-month hero and budget", async () => {
    wrap();
    // 482000 fils => 4,820.00; 600000 => 6,000.00
    expect(await screen.findByText(/4,820\.00/)).toBeInTheDocument();
    expect(screen.getByText(/spent of/i)).toBeInTheDocument();
  });

  it("lists the recent transactions", async () => {
    wrap();
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/screens/Home.test.tsx`
Expected: FAIL — `./Home` not found.

- [ ] **Step 3: Implement Home**

```tsx
// frontend/src/screens/Home.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Summary, CategorySpend, MonthlyTotal } from "../api/types";
import { Money } from "../components/Money";
import { Card } from "../components/ui/Card";
import { ProgressBar } from "../components/ui/ProgressBar";
import { Pill } from "../components/ui/Pill";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import {
  totalSpent, totalBudget, donutSlices, trendSeries, trailingPeriods, monthLabel, bucketColor,
} from "../lib/insights";
import { AlertTriangle } from "lucide-react";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Home() {
  const [period, setPeriod] = useState(currentPeriod());
  const periods = trailingPeriods(period, 6);

  const summary = useQuery({ queryKey: ["summary", period], queryFn: () => getJSON<Summary>(`/api/summary?period=${period}`) });
  const catSpend = useQuery({ queryKey: ["insights-categories", period], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${period}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  if (summary.isLoading) return <Skeleton rows={8} />;
  if (summary.isError) return <EmptyState icon={AlertTriangle} title="Couldn’t load your spending" hint="Check your connection and try again." />;

  const s = summary.data!;
  const spent = totalSpent(s.buckets);
  const budget = totalBudget(s.buckets);
  const pct = budget > 0 ? spent / budget : 0;
  const slices = donutSlices(catSpend.data ?? []);
  const points = trendSeries(trend.data ?? [], periods);

  return (
    <div className="space-y-4">
      {/* period selector */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{monthLabel(period)} {period.slice(0, 4)}</h1>
        <select
          aria-label="Period"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="bg-surface border border-border rounded-lg px-2 py-1 text-sm"
        >
          {periods.slice().reverse().map((p) => (
            <option key={p} value={p}>{monthLabel(p)} {p.slice(0, 4)}</option>
          ))}
        </select>
      </div>

      {/* hero: spent vs budget */}
      <Card>
        <p className="text-sm text-muted">Spent this month</p>
        <p className="text-3xl font-bold tnum"><Money fils={spent} /></p>
        <p className="text-sm text-muted mt-1">spent of <span className="tnum"><Money fils={budget} /></span> budget</p>
        <div className="mt-3"><ProgressBar pct={pct} /></div>
      </Card>

      {/* donut by category + trend */}
      <div className="grid grid-cols-1 gap-4">
        <Card>
          <p className="text-sm font-medium mb-2">By category</p>
          {slices.length === 0
            ? <EmptyState title="No spending yet" />
            : <DonutChart slices={slices} centerLabel="Spent" centerValue={spent} />}
        </Card>
        <Card>
          <p className="text-sm font-medium mb-2">6-month trend</p>
          <TrendBars points={points} activePeriod={period} />
        </Card>
      </div>

      {/* bucket bars */}
      <Card>
        <p className="text-sm font-medium mb-3">Budget buckets</p>
        <div className="space-y-3">
          {s.buckets.map((b) => (
            <div key={b.bucket}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="flex items-center gap-2">
                  <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: bucketColor(b.bucket) }} />
                  {BUCKET_LABEL[b.bucket] ?? b.bucket}
                </span>
                <span className="tnum text-muted"><Money fils={b.spent} /> / <Money fils={b.target} /></span>
              </div>
              <ProgressBar pct={b.pct_used} />
            </div>
          ))}
        </div>
      </Card>

      {/* recent stream */}
      <Card>
        <p className="text-sm font-medium mb-2">Recent</p>
        {s.recent.length === 0 ? (
          <EmptyState title="No recent activity" hint="New transactions will appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {s.recent.map((t) => (
              <li key={t.ID} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{t.MerchantRaw || "—"}</p>
                  <p className="text-xs text-muted">{t.PostedAt.slice(0, 10)}{t.CategoryName ? ` · ${t.CategoryName}` : ""}</p>
                </div>
                <span className="tnum"><Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

Wire it into the shell: in `frontend/src/app/AppShell.tsx`, import `Home` and render it for the home tab (replace the `home` placeholder branch):

```tsx
import { Home } from "../screens/Home";
// ...in the <main> body, replace the placeholder mapping with explicit screens:
{tab === "home" && <Home />}
{tab === "transactions" && <Placeholder title="Transactions" />}
{tab === "insights" && <Placeholder title="Insights" />}
{tab === "settings" && <Placeholder title="Settings" />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/screens/Home.test.tsx src/app/AppShell.test.tsx`
Expected: PASS (Home tests pass; AppShell test still passes — Home renders given the stubbed summary).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Home.tsx frontend/src/screens/Home.test.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(pwa): data-dense Home — spend hero, donut, trend, buckets, recent"
```

---

# Phase D — Transactions management

### Task D1: CategorizeSheet (search + bucket grouping on Dialog)

**Files:**
- Create: `frontend/src/components/ui/Dialog.tsx`
- Create: `frontend/src/components/transactions/CategorizeSheet.tsx`
- Test: `frontend/src/components/transactions/CategorizeSheet.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/transactions/CategorizeSheet.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CategorizeSheet } from "./CategorizeSheet";
import type { Category, Txn } from "../../api/types";

const cats: Category[] = [
  { ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true },
  { ID: 2, Name: "Dining", Kind: "spending", Bucket: "want", IsActive: true },
];
const txn: Txn = { ID: 9, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "CARREFOUR", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" };

describe("CategorizeSheet", () => {
  it("submits the chosen category + make_rule", () => {
    const onSubmit = vi.fn();
    render(<CategorizeSheet txn={txn} categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Dining"));
    fireEvent.click(screen.getByLabelText(/make a rule/i));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onSubmit).toHaveBeenCalledWith({ category_id: 2, make_rule: true });
  });

  it("filters by search", () => {
    render(<CategorizeSheet txn={txn} categories={cats} onSubmit={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "din" } });
    expect(screen.getByLabelText("Dining")).toBeInTheDocument();
    expect(screen.queryByLabelText("Groceries")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/transactions/CategorizeSheet.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement Dialog + CategorizeSheet**

```tsx
// frontend/src/components/ui/Dialog.tsx
import { useEffect, useId, useRef, type ReactNode } from "react";

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl p-4 max-h-[85vh] overflow-y-auto outline-none"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 id={titleId} className="text-lg font-semibold">{title}</h2>
          <button aria-label="Close" className="text-muted text-xl" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

```tsx
// frontend/src/components/transactions/CategorizeSheet.tsx
import { useMemo, useState } from "react";
import type { Category, Txn } from "../../api/types";
import { Money } from "../Money";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";

const BUCKET_LABEL: Record<string, string> = { need: "Needs", want: "Wants", saving: "Savings" };

export function CategorizeSheet({ txn, categories, onSubmit, onClose }: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
}) {
  const [catID, setCatID] = useState<number | null>(null);
  const [makeRule, setMakeRule] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = categories.filter((c) => !q || c.Name.toLowerCase().includes(q));
    const byBucket = new Map<string, Category[]>();
    for (const c of matched) {
      const list = byBucket.get(c.Bucket) ?? [];
      list.push(c);
      byBucket.set(c.Bucket, list);
    }
    return [...byBucket.entries()];
  }, [categories, query]);

  return (
    <Dialog title="Categorize" onClose={onClose}>
      <p className="text-sm text-muted mb-3">{txn.MerchantRaw || "—"} · <Money fils={-txn.AmountFils} /></p>
      <input
        type="search"
        placeholder="Search categories…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full mb-3 px-3 py-2 rounded-lg border border-border bg-bg text-sm"
      />
      <div className="space-y-3">
        {groups.map(([bucket, list]) => (
          <fieldset key={bucket}>
            <legend className="text-xs uppercase tracking-wide text-muted mb-1">{BUCKET_LABEL[bucket] ?? bucket}</legend>
            <div className="space-y-1">
              {list.map((c) => (
                <label key={c.ID} className="flex items-center gap-3 py-1.5 cursor-pointer">
                  <input type="radio" name="cat" onChange={() => setCatID(c.ID)} />
                  {c.Name}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        {groups.length === 0 && <p className="text-sm text-muted">No matching categories.</p>}
      </div>
      <label className="flex items-center gap-2 my-3 text-sm">
        <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} />
        Make a rule for future “{txn.MerchantRaw || "—"}”
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={catID === null} onClick={() => catID !== null && onSubmit({ category_id: catID, make_rule: makeRule })}>Save</Button>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/transactions/CategorizeSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ui/Dialog.tsx frontend/src/components/transactions/CategorizeSheet.tsx frontend/src/components/transactions/CategorizeSheet.test.tsx
git commit -m "feat(pwa): Dialog + CategorizeSheet (search + bucket grouping)"
```

---

### Task D2: TransactionRow

**Files:**
- Create: `frontend/src/components/transactions/TransactionRow.tsx`
- Test: `frontend/src/components/transactions/TransactionRow.test.tsx`

One row: merchant + date + category, amount, status pill, and quick Transfer/Ignore actions for `needs_review` items. Tapping the row opens categorization.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/transactions/TransactionRow.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionRow } from "./TransactionRow";
import type { Txn } from "../../api/types";

const review: Txn = { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" };
const confirmed: Txn = { ...review, ID: 2, Status: "confirmed", CategoryID: 1, CategoryName: "Groceries", Bucket: "need" };

describe("TransactionRow", () => {
  it("shows merchant, human status, and category", () => {
    render(<TransactionRow txn={confirmed} onOpen={() => {}} onStatus={() => {}} />);
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText(/Groceries/)).toBeInTheDocument();
  });

  it("offers Transfer/Ignore only for needs_review and opens on tap", () => {
    const onOpen = vi.fn();
    const onStatus = vi.fn();
    render(<TransactionRow txn={review} onOpen={onOpen} onStatus={onStatus} />);
    fireEvent.click(screen.getByRole("button", { name: /ignore/i }));
    expect(onStatus).toHaveBeenCalledWith(review, "ignored");
    fireEvent.click(screen.getByRole("button", { name: /categorize/i }));
    expect(onOpen).toHaveBeenCalledWith(review);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/components/transactions/TransactionRow.tsx
import type { Txn } from "../../api/types";
import { Money } from "../Money";
import { Pill, type Tone } from "../ui/Pill";
import { statusLabel } from "../../lib/format";
import { ArrowLeftRight, X, Tag } from "lucide-react";

function statusTone(status: string): Tone {
  switch (status) {
    case "confirmed": return "good";
    case "needs_review": return "warn";
    case "ignored": return "muted";
    default: return "neutral";
  }
}

export function TransactionRow({ txn, onOpen, onStatus }: {
  txn: Txn;
  onOpen: (t: Txn) => void;
  onStatus: (t: Txn, status: string) => void;
}) {
  const needsReview = txn.Status === "needs_review";
  const subtitle = [txn.PostedAt.slice(0, 10), txn.CategoryName].filter(Boolean).join(" · ");
  return (
    <div className="py-2.5 flex items-center gap-3">
      <button className="flex-1 min-w-0 text-left" aria-label={`Categorize ${txn.MerchantRaw || "transaction"}`} onClick={() => onOpen(txn)}>
        <p className="truncate font-medium">{txn.MerchantRaw || "—"}</p>
        <p className="text-xs text-muted truncate">{subtitle || "Uncategorized"}</p>
      </button>
      <div className="flex flex-col items-end gap-1">
        <span className="tnum font-medium"><Money fils={txn.Direction === "credit" ? txn.AmountFils : -txn.AmountFils} /></span>
        <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>
      </div>
      {needsReview && (
        <div className="flex flex-col gap-1">
          <button aria-label="Categorize" className="p-1.5 rounded-lg hover:bg-bg text-accent" onClick={() => onOpen(txn)}><Tag size={16} /></button>
          <button aria-label="Transfer" className="p-1.5 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "transfer")}><ArrowLeftRight size={16} /></button>
          <button aria-label="Ignore" className="p-1.5 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "ignored")}><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/TransactionRow.tsx frontend/src/components/transactions/TransactionRow.test.tsx
git commit -m "feat(pwa): TransactionRow with status pill, category, quick actions"
```

---

### Task D3: Transactions screen (filter + search + triage + categorize)

**Files:**
- Create: `frontend/src/screens/Transactions.tsx`
- Test: `frontend/src/screens/Transactions.test.tsx`
- Modify: `frontend/src/app/AppShell.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/screens/Transactions.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Transactions } from "./Transactions";
import type { Txn, Category } from "../api/types";

const all: Txn[] = [
  { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Confidence: 0, Source: "email", CategoryID: null, CategoryName: "", Bucket: "" },
  { ID: 2, PostedAt: "2026-06-09", AmountFils: 2500, Currency: "AED", Direction: "debit", MerchantRaw: "NETFLIX", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 2, CategoryName: "Subscriptions", Bucket: "want" },
];
const cats: Category[] = [{ ID: 1, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/transactions")) {
      const status = new URL("http://x" + url.replace(/^[^/]*/, "")).searchParams.get("status");
      const rows = status === "needs_review" ? all.filter((t) => t.Status === "needs_review") : all;
      return new Response(JSON.stringify(rows));
    }
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Transactions /></ToastProvider></QueryClientProvider>);
}

describe("Transactions", () => {
  it("renders rows with a result count", async () => {
    wrap();
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.getByText("NETFLIX")).toBeInTheDocument();
    expect(screen.getByText(/2 transactions/i)).toBeInTheDocument();
  });

  it("filters to needs-review via the segmented control", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("tab", { name: /needs review/i }));
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
  });

  it("client-filters by search text", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "spin" } });
    expect(screen.getByText("SPINNEYS")).toBeInTheDocument();
    expect(screen.queryByText("NETFLIX")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/screens/Transactions.test.tsx`
Expected: FAIL — `./Transactions` not found.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/screens/Transactions.tsx
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { TransactionRow } from "../components/transactions/TransactionRow";
import { CategorizeSheet } from "../components/transactions/CategorizeSheet";
import { useToast } from "../components/Toast";
import { AlertTriangle, ListOrdered } from "lucide-react";

type Filter = "all" | "needs_review" | "confirmed";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Needs review" },
  { value: "confirmed" as const, label: "Confirmed" },
];

export function Transactions() {
  const qc = useQueryClient();
  const { show } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<Txn | null>(null);

  const status = filter === "all" ? "" : filter;
  const q = useQuery({
    queryKey: ["transactions", status],
    queryFn: () => getJSON<Txn[]>(status ? `/api/transactions?status=${status}` : "/api/transactions"),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const rows = useMemo(() => {
    const data = q.data ?? [];
    const term = search.trim().toLowerCase();
    return term ? data.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(term)) : data;
  }, [q.data, search]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    qc.invalidateQueries({ queryKey: ["review"] });
  };

  const setStatus = async (t: Txn, newStatus: string) => {
    const name = t.MerchantRaw || "transaction";
    const verb = newStatus === "ignored" ? "Ignored" : newStatus === "transfer" ? "Marked transfer" : "Updated";
    try {
      await postJSON(`/api/transactions/${t.ID}/status`, { status: newStatus });
      invalidate();
      show({ message: `${verb} ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/status`, { status: "needs_review" }).then(invalidate); } } });
    } catch { show({ message: `Couldn’t update ${name}`, tone: "error" }); }
  };

  const categorize = async (t: Txn, body: { category_id: number; make_rule: boolean }) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/categorize`, { ...body, merchant_raw: t.MerchantRaw });
      setActive(null);
      invalidate();
      show({ message: `Categorized ${name}`, tone: "success" });
    } catch { show({ message: `Couldn’t categorize ${name}`, tone: "error" }); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <div className="flex flex-col gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        <input
          type="search"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        />
      </div>

      {q.isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn’t load transactions" hint="Check your connection and try again." />
      ) : q.isLoading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListOrdered} title="No transactions" hint="Try a different filter or search." />
      ) : (
        <Card className="!p-0">
          <p className="text-xs text-muted px-4 pt-3">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
          <ul className="divide-y divide-border px-4">
            {rows.map((t) => (
              <li key={t.ID}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} /></li>
            ))}
          </ul>
        </Card>
      )}

      {active && cats.data && (
        <CategorizeSheet
          txn={active}
          categories={cats.data}
          onSubmit={(body) => categorize(active, body)}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
```

Wire into the shell — in `AppShell.tsx` replace the transactions placeholder:

```tsx
import { Transactions } from "../screens/Transactions";
// ...
{tab === "transactions" && <Transactions />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run src/screens/Transactions.test.tsx`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Transactions.tsx frontend/src/screens/Transactions.test.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(pwa): Transactions screen — segmented filter, search, triage, categorize"
```

---

# Phase E — Insights

### Task E1: Insights screen

**Files:**
- Create: `frontend/src/screens/Insights.tsx`
- Test: `frontend/src/screens/Insights.test.tsx`
- Modify: `frontend/src/app/AppShell.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/screens/Insights.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Insights } from "./Insights";
import type { CategorySpend, MonthlyTotal } from "../api/types";

const cats: CategorySpend[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 210000 },
  { category_id: 2, name: "Dining", bucket: "want", spent: 80000 },
];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 290000, income: 1500000 }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Insights /></QueryClientProvider>);
}

describe("Insights", () => {
  it("lists categories with their spend, largest first", async () => {
    wrap();
    expect(await screen.findByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
    // 210000 fils => 2,100.00
    expect(screen.getByText(/2,100\.00/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/screens/Insights.test.tsx`
Expected: FAIL — `./Insights` not found.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/screens/Insights.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { CategorySpend, MonthlyTotal } from "../api/types";
import { Card } from "../components/ui/Card";
import { Money } from "../components/Money";
import { Pill, type Tone } from "../components/ui/Pill";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { DonutChart } from "../components/charts/DonutChart";
import { TrendBars } from "../components/charts/TrendBars";
import { donutSlices, trendSeries, trailingPeriods, monthLabel } from "../lib/insights";
import { AlertTriangle } from "lucide-react";

const BUCKET_TONE: Record<string, Tone> = { need: "neutral", want: "warn", saving: "good" };

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function Insights() {
  const [period] = useState(currentPeriod());
  const periods = trailingPeriods(period, 6);
  const cats = useQuery({ queryKey: ["insights-categories", period], queryFn: () => getJSON<CategorySpend[]>(`/api/insights/categories?period=${period}`) });
  const trend = useQuery({ queryKey: ["insights-trend"], queryFn: () => getJSON<MonthlyTotal[]>("/api/insights/trend?months=6") });

  if (cats.isLoading) return <Skeleton rows={8} />;
  if (cats.isError) return <EmptyState icon={AlertTriangle} title="Couldn’t load insights" hint="Check your connection and try again." />;

  const data = cats.data ?? [];
  const total = data.reduce((s, c) => s + c.spent, 0);
  const slices = donutSlices(data);
  const points = trendSeries(trend.data ?? [], periods);

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Insights · {monthLabel(period)}</h1>

      <Card>
        <p className="text-sm font-medium mb-2">Where the money went</p>
        {slices.length === 0 ? <EmptyState title="No spending this month" /> : <DonutChart slices={slices} centerLabel="Spent" centerValue={total} />}
      </Card>

      <Card>
        <p className="text-sm font-medium mb-2">6-month spending trend</p>
        <TrendBars points={points} activePeriod={period} />
      </Card>

      <Card className="!p-0">
        <p className="text-sm font-medium px-4 pt-4">By category</p>
        {data.length === 0 ? (
          <EmptyState title="Nothing to break down yet" />
        ) : (
          <ul className="divide-y divide-border px-4 pb-2">
            {data.map((c) => (
              <li key={c.category_id} className="py-2.5 flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{c.name}</span>
                  <Pill tone={BUCKET_TONE[c.bucket] ?? "muted"}>{c.bucket}</Pill>
                </span>
                <span className="tnum font-medium"><Money fils={c.spent} /></span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
```

Wire into the shell — in `AppShell.tsx` replace the insights placeholder:

```tsx
import { Insights } from "../screens/Insights";
// ...
{tab === "insights" && <Insights />}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/screens/Insights.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Insights.tsx frontend/src/screens/Insights.test.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(pwa): Insights screen — donut, trend, category breakdown"
```

---

# Phase F — Settings + teardown

### Task F1: Settings screen (Tailwind rebuild)

**Files:**
- Create: `frontend/src/screens/Settings.tsx`
- Test: `frontend/src/screens/Settings.test.tsx`
- Modify: `frontend/src/app/AppShell.tsx`

Rebuild the old `SettingsDrawer` as a full screen with the same behavior: AED income, whole-percent splits that must sum to 100%, category→bucket reassignment, rules list with delete. Reuse the kept helpers `dirhamsToFils`, `filsToDirhams`, `fractionToPercent`, `percentToFraction`, and the validation `pctsValid` (copy it here so the old file can be deleted).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/screens/Settings.test.tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings, pctsValid } from "./Settings";
import type { BudgetConfig } from "../api/types";

const budget: BudgetConfig = { monthly_income: 1500000, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/budget")) return new Response(JSON.stringify(budget));
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Settings /></QueryClientProvider>);
}

describe("pctsValid", () => {
  it("accepts 50/30/20 and rejects others", () => {
    expect(pctsValid(0.5, 0.3, 0.2)).toBe(true);
    expect(pctsValid(0.5, 0.5, 0.2)).toBe(false);
  });
});

describe("Settings", () => {
  it("shows income in AED and splits as whole percents", async () => {
    wrap();
    expect((await screen.findByLabelText(/monthly income/i) as HTMLInputElement).value).toBe("15000");
    expect((screen.getByLabelText(/need %/i) as HTMLInputElement).value).toBe("50");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/screens/Settings.test.tsx`
Expected: FAIL — `./Settings` not found.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/screens/Settings.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON, del } from "../api/client";
import type { BudgetConfig, Category, Rule } from "../api/types";
import { dirhamsToFils, filsToDirhams, fractionToPercent, percentToFraction } from "../lib/format";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Trash2 } from "lucide-react";

export function pctsValid(need: number, want: number, saving: number): boolean {
  return Math.abs(need + want + saving - 1.0) < 0.001;
}

const BUCKETS = ["need", "want", "saving"] as const;

export function Settings() {
  const qc = useQueryClient();
  const budget = useQuery({ queryKey: ["budget"], queryFn: () => getJSON<BudgetConfig>("/api/budget") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const rules = useQuery({ queryKey: ["rules"], queryFn: () => getJSON<Rule[]>("/api/rules") });

  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [error, setError] = useState("");
  const cfg = draft ?? budget.data ?? null;
  const patch = (p: Partial<BudgetConfig>) => cfg && setDraft({ ...cfg, ...p });

  const saveBudget = async () => {
    if (!cfg) return;
    if (!pctsValid(cfg.need_pct, cfg.want_pct, cfg.saving_pct)) { setError("Need / Want / Saving must add up to 100%."); return; }
    setError("");
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

  const field = "w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm";

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>

      {cfg && (
        <Card>
          <p className="text-sm font-medium mb-3">Budget</p>
          <label className="block text-sm mb-3">Monthly income (AED)
            <input type="number" min="0" step="0.01" className={field}
              value={filsToDirhams(cfg.monthly_income)}
              onChange={(e) => patch({ monthly_income: dirhamsToFils(Number(e.target.value)) })} />
          </label>
          <div className="grid grid-cols-3 gap-2">
            <label className="text-sm">Need %
              <input type="number" min="0" max="100" className={field}
                value={fractionToPercent(cfg.need_pct)}
                onChange={(e) => patch({ need_pct: percentToFraction(Number(e.target.value)) })} />
            </label>
            <label className="text-sm">Want %
              <input type="number" min="0" max="100" className={field}
                value={fractionToPercent(cfg.want_pct)}
                onChange={(e) => patch({ want_pct: percentToFraction(Number(e.target.value)) })} />
            </label>
            <label className="text-sm">Saving %
              <input type="number" min="0" max="100" className={field}
                value={fractionToPercent(cfg.saving_pct)}
                onChange={(e) => patch({ saving_pct: percentToFraction(Number(e.target.value)) })} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm mt-3">
            <input type="checkbox" checked={cfg.freeze_history} onChange={(e) => patch({ freeze_history: e.target.checked })} /> Freeze history
          </label>
          {error && <p role="alert" className="text-bad text-sm mt-2">{error}</p>}
          <div className="mt-3"><Button variant="primary" onClick={saveBudget}>Save budget</Button></div>
        </Card>
      )}

      <Card>
        <p className="text-sm font-medium mb-3">Categories → buckets</p>
        <div className="space-y-2">
          {(cats.data ?? []).filter((c) => c.Kind === "spending").map((c) => (
            <div key={c.ID} className="flex items-center justify-between gap-3">
              <span className="text-sm">{c.Name}</span>
              <select value={c.Bucket} onChange={(e) => reassign(c, e.target.value)} className="border border-border rounded-lg px-2 py-1 text-sm bg-surface">
                {BUCKETS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <p className="text-sm font-medium mb-3">Rules</p>
        {(rules.data ?? []).length === 0 ? (
          <p className="text-sm text-muted">No rules yet — create one when you categorize a transaction.</p>
        ) : (
          <ul className="space-y-2">
            {(rules.data ?? []).map((r) => (
              <li key={r.ID} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">{r.MatchType}: “{r.Pattern}” → {catName(r.CategoryID)}</span>
                <button aria-label="Delete rule" className="text-muted hover:text-bad" onClick={() => deleteRule(r.ID)}><Trash2 size={16} /></button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <p className="text-sm font-medium mb-1">About</p>
        <p className="text-xs text-muted">Icons by Lucide (ISC). Charts by Recharts (MIT).</p>
      </Card>
    </div>
  );
}
```

Wire into the shell — in `AppShell.tsx` replace the settings placeholder and remove the now-unused `Placeholder` component:

```tsx
import { Settings } from "../screens/Settings";
// ...
{tab === "settings" && <Settings />}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/screens/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/screens/Settings.tsx frontend/src/screens/Settings.test.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(pwa): Settings screen (Tailwind) — budget, buckets, rules"
```

---

### Task F2: Delete the XP-era files

**Files:**
- Delete: `frontend/src/App.tsx`
- Delete: `frontend/src/styles/theme.css`
- Delete: `frontend/src/components/AppWindow.tsx` + `AppWindow.test.tsx`
- Delete: `frontend/src/components/Taskbar.tsx` + `Taskbar.test.tsx`
- Delete: `frontend/src/components/BucketBox.tsx` + `BucketBox.test.tsx`
- Delete: `frontend/src/components/Modal.tsx`
- Delete: `frontend/src/components/Icon.tsx` + `Icon.test.tsx`
- Delete: `frontend/src/components/CategorizeDialog.tsx` + `CategorizeDialog.test.tsx`
- Delete: `frontend/src/views/Dashboard.tsx` + `Dashboard.test.tsx`
- Delete: `frontend/src/views/Review.tsx` + `Review.test.tsx`
- Delete: `frontend/src/views/Transactions.tsx` + `Transactions.filters.test.ts` + `Transactions.recategorize.test.tsx`
- Delete: `frontend/src/views/SettingsDrawer.tsx` + `SettingsDrawer.income.test.tsx` + `SettingsDrawer.pct.test.ts`
- Delete: `frontend/public/icons/` (the XP Fugue PNGs, now unused)

- [ ] **Step 1: Confirm nothing live imports them**

Run:
```bash
cd frontend
grep -Rn -E "AppWindow|Taskbar|BucketBox|/Modal|components/Icon|CategorizeDialog|views/|theme.css|/App'|/App\"" src | grep -v -E "components/transactions|components/charts|components/ui"
```
Expected: **no matches** outside the files being deleted. If anything in `src/app`, `src/screens`, `src/components/ui`, `src/components/charts`, or `src/components/transactions` still imports a doomed file, fix that import first (it should already use the new equivalents).

- [ ] **Step 2: Delete**

```bash
cd frontend
git rm src/App.tsx src/styles/theme.css \
  src/components/AppWindow.tsx src/components/AppWindow.test.tsx \
  src/components/Taskbar.tsx src/components/Taskbar.test.tsx \
  src/components/BucketBox.tsx src/components/BucketBox.test.tsx \
  src/components/Modal.tsx \
  src/components/Icon.tsx src/components/Icon.test.tsx \
  src/components/CategorizeDialog.tsx src/components/CategorizeDialog.test.tsx \
  src/views/Dashboard.tsx src/views/Dashboard.test.tsx \
  src/views/Review.tsx src/views/Review.test.tsx \
  src/views/Transactions.tsx src/views/Transactions.filters.test.ts src/views/Transactions.recategorize.test.tsx \
  src/views/SettingsDrawer.tsx src/views/SettingsDrawer.income.test.tsx src/views/SettingsDrawer.pct.test.ts
git rm -r public/icons
```

- [ ] **Step 3: Type-check + full suite**

Run: `cd frontend && bunx tsc -b && bun run test`
Expected: `tsc` clean (no dangling imports); all remaining tests pass (the new ui/charts/transactions/screens/lib tests plus the kept Money/format/money/client/useOnline/useLiveEvents/Toast tests). If `tsc` flags an unused export or missing reference, fix it minimally.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(pwa): remove xp.css-era components, views, and icons"
```

---

### Task F3: Build, smoke, and ship

**Files:** regenerates `internal/web/dist`.

- [ ] **Step 1: Full frontend suite**

Run: `cd frontend && bun run test`
Expected: all green.

- [ ] **Step 2: Production build**

Run: `cd frontend && bun run build`
Expected: `tsc -b` clean; Vite writes the new bundle (with Tailwind + Recharts + lucide) to `../internal/web/dist`.

- [ ] **Step 3: Go build + embed test**

Run: `cd /root/Coding/ledger && go build ./... && go test ./...`
Expected: build clean; all Go tests pass with the regenerated embedded bundle.

- [ ] **Step 4: Isolated runtime smoke**

```bash
cd /root/Coding/ledger
go build -o /tmp/ledger-smoke ./cmd/ledger
D=$(mktemp -d); LEDGER_LISTEN=127.0.0.1:8099 LEDGER_DATA_DIR="$D" /tmp/ledger-smoke >/tmp/smoke.log 2>&1 &
P=$!; sleep 1
curl -s -o /dev/null -w 'index=%{http_code}\n' http://127.0.0.1:8099/
curl -s http://127.0.0.1:8099/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1
curl -s -o /dev/null -w 'spa-fallback=%{http_code}\n' http://127.0.0.1:8099/insights
kill $P; rm -rf "$D" /tmp/ledger-smoke
```
Expected: `index=200`, an asset path prints, `spa-fallback=200`.

- [ ] **Step 5: Commit the rebuilt bundle**

```bash
cd /root/Coding/ledger
git add internal/web/dist frontend
git commit -m "build(pwa): rebuild embedded dist for the spending-first UI"
```

- [ ] **Step 6: Deploy (this box is prod — confirm with the user before running)**

```bash
go build -o /tmp/ledger-new ./cmd/ledger
sudo install -m 0755 /tmp/ledger-new /usr/local/bin/ledger
sudo systemctl restart ledger.service
systemctl is-active ledger.service
curl -s http://127.0.0.1:8080/api/health
```
Expected: `active`; health `status: ok`. Then hard-refresh the PWA on the phone to bust the service-worker cache.

---

## Self-Review

**1. Spec coverage** (against the request: drop XP; spending front-and-center; better transaction management):
- Drop XP aesthetic → Phase B (Tailwind, new shell) + Phase F2 (delete xp.css + XP components). ✅
- Spending front and center → Phase C Home: spend-vs-budget hero, donut by category, bucket bars, trend, recent. ✅
- Better transaction management → Phase D: segmented status filter, merchant search, status pills, quick triage (Transfer/Ignore + Undo), tap-to-categorize with search/grouping. ✅
- "Track monthly spending" core objective → period selector on Home + dedicated Insights screen with donut + 6-month trend + category table (Phase E), backed by new `/api/insights/*` + `?period=` (Phase A). ✅
- Charts via a library (Recharts) → Phase C2. ✅
- IA Home·Transactions·Insights·Settings with review folded into Transactions → Phase B3 nav + Phase D filter. ✅

**2. Placeholder scan:** every code step contains complete code; the only `Placeholder` is an intentional, named Phase-B shim that is explicitly removed in Phase F1. No "TBD"/"handle errors"/"similar to". ✅ The two spots that say "mirror the existing test helper" (A4 summary test, A3 server construction) point at concrete existing tests to copy from rather than inventing an API — acceptable because they depend on repo-local test scaffolding the engineer must read; both name the exact file.

**3. Type/identifier consistency:**
- `Txn` gains `CategoryID: number | null`, `CategoryName`, `Bucket` (C1); Home/TransactionRow/Transactions all read those exact names. ✅
- Backend `ReviewItem` adds `CategoryID *int64`, `CategoryName`, `Bucket` → JSON keys `CategoryID`/`CategoryName`/`Bucket` (no json tags), matching the frontend `Txn`. ✅
- Insight JSON DTOs use snake_case (`category_id,name,bucket,spent` and `period,spent,income`) → frontend `CategorySpend`/`MonthlyTotal` match. ✅
- `donutSlices`, `trendSeries`, `trailingPeriods`, `monthLabel`, `bucketColor`, `totalSpent`, `totalBudget` defined in C1 and consumed in C3/E1 with matching signatures. ✅
- `Pill` `Tone` union (`good|warn|bad|muted|neutral`) defined in B2, used in D2/E1. ✅
- `SegmentedControl<T>` generic value type used with `Filter` in D3 and the options literal types line up. ✅
- `CategorizeSheet` props `{txn,categories,onSubmit,onClose}` with `onSubmit({category_id,make_rule})` match the call in D3. ✅
- `EmptyState.icon` becomes a `LucideIcon` (B4); every caller passes a lucide icon component (Home/Transactions/Insights/Settings) or omits it. ✅
- `SetInsightsStore` / `insightsStore` field / `InsightsStore` interface consistent across A3 + server.go + main.go. ✅

Gaps found & resolved inline: `SelectRecent` was added to A1 so summary `recent[]` carries category (Home shows it); `EmptyState` icon-type change propagated to its test and all callers; `Placeholder` removal called out explicitly in F1.

---

**Plan complete and saved to `docs/superpowers/plans/2026-06-15-ui-overhaul-spending-first.md`.**
</content>
