# Smaller Cheaper Wins (Search + CSV Export + IMAP IDLE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three independent quality-of-life features: server-side free-text transaction search (`q=` on `GET /api/transactions`), CSV export (`GET /api/transactions/export` + an Export button), and optional IMAP IDLE so new mail triggers an immediate sync instead of waiting out the poll interval.

**Architecture:** Search extends `store.SelectTransactions` with a LIKE filter on `merchant_raw` and plumbs a `q` query param through the existing handler. Export is a new handler that reuses the same store method and streams `encoding/csv`. IDLE is a hybrid: the poll loop stays the backbone (dial-per-cycle, unchanged), but between syncs the worker can park in IMAP IDLE on a short-lived dedicated connection and wake early on a new-mail signal — the poll interval remains the fallback upper bound, so a broken IDLE path degrades to today's behavior, never worse.

**Tech Stack:** Go stdlib (`net/http`, `encoding/csv`), SQLite via existing `store` package, `github.com/emersion/go-imap/v2 v2.0.0-beta.8` (`imapclient.Client.Idle`, already a dependency), React 18 + vitest for the frontend button.

## Global Constraints

- Money is integer minor units: `int64` fils. Never floats. CSV export renders decimals by integer division/modulo only.
- The mailbox is opened read-only: every `Select` uses `imap.SelectOptions{ReadOnly: true}` (EXAMINE). IDLE must not weaken this.
- Single binary; frontend builds into `internal/web/dist/` (committed artifact) which Go embeds. **Rebuild dist before finishing** (Task 6).
- Frontend vitest is pinned to a single non-parallel fork in `vite.config.ts` — do not change that.
- Go tests: `go test ./...`. Known false failure: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set in the shell; verify that package with `env -u LEDGER_AI_API_KEY go test ./internal/config`.
- Unknown `/api/*` must 404 (never fall through to the SPA); new routes register in `internal/server/server.go` with Go 1.22 method+pattern syntax.
- Commit messages follow the repo's `feat(scope): ...` convention and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Scope notes (read before Task 1)

- **The search box already exists.** `frontend/src/screens/Transactions.tsx:76-85` renders a search input filtering client-side via `searchTxns` (`frontend/src/lib/analysis.ts:99-103`, lowercase `.includes` on `MerchantRaw`). It stays as-is — instant, no network. Task 1 is therefore **backend only**: it gives the API (and export, and curl audits) the same contains-match semantics. SQLite `LIKE` is case-insensitive for ASCII, matching the client behavior.
- **There is no `description` column.** `merchant_raw` is the only free-text field on transactions; `q` searches it alone.
- **`use_idle` already exists** in `IMAPConfig` (`internal/config/config.go:40`, default `false`) — reserved since Milestone 2, currently read by nothing. Task 4–5 wire it. The conscious decision recorded here: **polling stays the backbone; IDLE only accelerates it.** With `use_idle = true` the recommended `poll_interval` is `"15m"` (fallback heartbeat), which is what actually cuts mailbox chatter.
- The three parts are independent. Tasks 1→2→3 are ordered only because export reuses the `q` parameter. Tasks 4–5 touch disjoint files and can ship separately.

---

### Task 1: Server-side search — `q=` on `GET /api/transactions`

**Files:**
- Modify: `internal/store/categories.go:211-244` (`SelectTransactions`)
- Modify: `internal/server/server.go:49` (catStore interface method)
- Modify: `internal/server/transactions.go:52-68` (`handleGetTransactions`)
- Modify: `internal/server/categorize_job.go:46` (caller, passes `""`)
- Modify (mechanical, tests): `internal/store/categories_test.go`, `internal/store/transactions_test.go`, `internal/store/budget_fx_test.go`, `internal/importer/importer_test.go`, `internal/parse/processor_test.go`
- Test: `internal/store/categories_test.go`, `internal/server/transactions_test.go`

**Interfaces:**
- Consumes: existing `SelectTransactions(status, from, to string) ([]ReviewItem, error)` and its `scanReviewItems` helper (unchanged columns — do not touch the scanner).
- Produces: `func (s *Store) SelectTransactions(status, from, to, search string) ([]ReviewItem, error)` — empty `search` matches all; non-empty does a case-insensitive contains-match on `merchant_raw` with LIKE wildcards in the term escaped. Tasks 2–3 rely on this exact signature and on the handler reading URL param `q`.

- [ ] **Step 1: Write the failing store test**

Append to `internal/store/categories_test.go`:

```go
func TestSelectTransactionsSearch(t *testing.T) {
	st := newTestStore(t)
	seed := func(merchant string) {
		t.Helper()
		if _, _, err := st.InsertTransaction(TransactionRow{
			PostedAt:    time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC),
			AmountFils:  5000,
			Currency:    "AED",
			Direction:   "debit",
			MerchantRaw: merchant,
			Status:      "needs_review",
		}); err != nil {
			t.Fatalf("insert %q: %v", merchant, err)
		}
	}
	seed("SPINNEYS DUBAI MARINA")
	seed("NETFLIX.COM")
	seed("100% NATURAL JUICE")
	seed("1000 THINGS STORE")

	// Case-insensitive contains-match.
	got, err := st.SelectTransactions("", "", "", "spinneys")
	if err != nil {
		t.Fatalf("SelectTransactions(search): %v", err)
	}
	if len(got) != 1 || got[0].MerchantRaw != "SPINNEYS DUBAI MARINA" {
		t.Errorf("search=spinneys: got %+v, want only the SPINNEYS row", got)
	}

	// No match.
	none, _ := st.SelectTransactions("", "", "", "carrefour")
	if len(none) != 0 {
		t.Errorf("search=carrefour: got %d rows, want 0", len(none))
	}

	// LIKE wildcards in the term are literal text, not patterns: "100%" must
	// match only the "100%" merchant, not everything containing "100".
	pct, _ := st.SelectTransactions("", "", "", "100%")
	if len(pct) != 1 || pct[0].MerchantRaw != "100% NATURAL JUICE" {
		t.Errorf("search=100%%: got %+v, want only the 100%% NATURAL JUICE row", pct)
	}

	// Empty search matches all.
	all, _ := st.SelectTransactions("", "", "", "")
	if len(all) != 4 {
		t.Errorf("empty search: got %d rows, want 4", len(all))
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `go test ./internal/store/ -run TestSelectTransactionsSearch`
Expected: FAIL — build error `too many arguments in call to st.SelectTransactions` (the 4-arg signature doesn't exist yet).

- [ ] **Step 3: Implement the store change**

In `internal/store/categories.go`, replace the `SelectTransactions` function (lines 211–244) with:

```go
// SelectTransactions returns transactions matching optional status, date, and
// free-text filters. Empty status matches all. from/to are RFC3339 or date
// strings (SQLite text compare). search does a case-insensitive contains-match
// on merchant_raw; LIKE wildcards in the term are escaped so they match
// literally.
func (s *Store) SelectTransactions(status, from, to, search string) ([]ReviewItem, error) {
	q := `SELECT t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
	             COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	             t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
	             COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,'')
	      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	      WHERE 1=1`
	var args []any
	if status != "" {
		q += " AND t.status=?"
		args = append(args, status)
	} else {
		// Archived rows are soft-deleted: hidden from the default list, reachable
		// only by explicitly asking for status='archived'.
		q += " AND t.status!='archived'"
	}
	if from != "" {
		q += " AND t.posted_at >= ?"
		args = append(args, from)
	}
	if to != "" {
		q += " AND t.posted_at <= ?"
		args = append(args, to)
	}
	if search != "" {
		q += ` AND t.merchant_raw LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(search)+"%")
	}
	q += " ORDER BY t.posted_at DESC"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}

// escapeLike backslash-escapes LIKE metacharacters so user text matches literally.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
```

`strings` is already imported in `categories.go`? Check the import block — if not, add it.

- [ ] **Step 4: Update every caller**

Non-test callers (hand-edit):

- `internal/server/server.go:49` — interface method becomes:
  ```go
  SelectTransactions(status, from, to, q string) ([]store.ReviewItem, error)
  ```
- `internal/server/transactions.go:58` — pass the new param:
  ```go
  items, err := s.catStore.SelectTransactions(q.Get("status"), q.Get("from"), q.Get("to"), q.Get("q"))
  ```
- `internal/server/categorize_job.go:46`:
  ```go
  items, err := s.catStore.SelectTransactions("needs_review", from, to, "")
  ```

Test callers all use string-literal args; update mechanically:

```bash
grep -rl --include='*_test.go' 'SelectTransactions(' internal | xargs sed -i -E \
  's/SelectTransactions\(("[^"]*"), ("[^"]*"), ("[^"]*")\)/SelectTransactions(\1, \2, \3, "")/g'
```

Then confirm nothing was missed: `grep -rn 'SelectTransactions(' internal cmd | grep -v ', "")' | grep -v 'q.Get("q")'` should show only the definition in `categories.go`, the interface line in `server.go`, and the new 4-arg test calls from Step 1.

- [ ] **Step 5: Write the failing handler test**

Append to `internal/server/transactions_test.go`:

```go
func TestGetTransactionsSearch(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st) // merchant "DAPPER DAN GENTS SAL"
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions?q=dapper", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var hits []map[string]any
	json.NewDecoder(w.Body).Decode(&hits)
	if len(hits) != 1 {
		t.Errorf("q=dapper: got %d items, want 1", len(hits))
	}

	r = httptest.NewRequest("GET", "/api/transactions?q=nomatch", nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	var misses []map[string]any
	json.NewDecoder(w.Body).Decode(&misses)
	if len(misses) != 0 {
		t.Errorf("q=nomatch: got %d items, want 0", len(misses))
	}
}
```

- [ ] **Step 6: Run the affected packages**

Run: `go test ./internal/store/ ./internal/server/ ./internal/importer/ ./internal/parse/`
Expected: PASS (including the two new tests).

- [ ] **Step 7: Run the full suite**

Run: `go test ./...`
Expected: PASS everywhere except possibly `internal/config` (known env false-failure — confirm with `env -u LEDGER_AI_API_KEY go test ./internal/config`, which must PASS).

- [ ] **Step 8: Commit**

```bash
git add internal/store internal/server internal/importer internal/parse
git commit -m "feat(api): free-text merchant search via q= on GET /api/transactions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CSV export endpoint — `GET /api/transactions/export`

**Files:**
- Create: `internal/server/export.go`
- Create: `internal/server/export_test.go`
- Modify: `internal/server/server.go:163-168` (route registration)

**Interfaces:**
- Consumes: `s.catStore.SelectTransactions(status, from, to, q string) ([]store.ReviewItem, error)` from Task 1; `store.ReviewItem` fields `ID, PostedAt, AmountFils, AmountAedFils (*int64), Currency, Direction, MerchantRaw, Status, Source, CategoryName, Bucket`.
- Produces: `GET /api/transactions/export` honoring the same `status`/`from`/`to`/`q` params as the list endpoint; response `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="ledger-export-YYYY-MM-DD.csv"`, header row `id,posted_at,amount,currency,amount_aed,direction,merchant,category,bucket,status,source`, amounts as plain decimals (`215.00`). Task 3's frontend button links here. Also produces `filsToDecimal(fils int64) string`.

- [ ] **Step 1: Write the failing tests**

Create `internal/server/export_test.go`:

```go
package server

import (
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestFilsToDecimal(t *testing.T) {
	cases := []struct {
		fils int64
		want string
	}{
		{0, "0.00"}, {5, "0.05"}, {50, "0.50"}, {21500, "215.00"}, {123456789, "1234567.89"},
	}
	for _, c := range cases {
		if got := filsToDecimal(c.fils); got != c.want {
			t.Errorf("filsToDecimal(%d) = %q, want %q", c.fils, got, c.want)
		}
	}
}

func TestExportTransactionsCSV(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st) // 21500 fils AED debit, "DAPPER DAN GENTS SAL", needs_review
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions/export", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("Content-Type = %q, want text/csv", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, `attachment; filename="ledger-export-`) {
		t.Errorf("Content-Disposition = %q, want attachment with dated filename", cd)
	}

	rows, err := csv.NewReader(w.Body).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d csv rows, want header + 1 record", len(rows))
	}
	wantHeader := []string{"id", "posted_at", "amount", "currency", "amount_aed", "direction",
		"merchant", "category", "bucket", "status", "source"}
	if !slices.Equal(rows[0], wantHeader) {
		t.Errorf("header = %v, want %v", rows[0], wantHeader)
	}
	rec := rows[1]
	if rec[2] != "215.00" {
		t.Errorf("amount = %q, want 215.00", rec[2])
	}
	if rec[3] != "AED" {
		t.Errorf("currency = %q, want AED", rec[3])
	}
	if rec[6] != "DAPPER DAN GENTS SAL" {
		t.Errorf("merchant = %q", rec[6])
	}
	if rec[9] != "needs_review" {
		t.Errorf("status = %q, want needs_review", rec[9])
	}
}

func TestExportTransactionsHonorsFilters(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions/export?q=nomatch", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	rows, err := csv.NewReader(w.Body).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("q=nomatch: got %d rows, want header only", len(rows))
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/server/ -run 'TestFilsToDecimal|TestExportTransactions'`
Expected: FAIL — `undefined: filsToDecimal` (build error).

- [ ] **Step 3: Implement the handler**

Create `internal/server/export.go`:

```go
package server

import (
	"encoding/csv"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// exportHeader is the CSV column order for GET /api/transactions/export.
var exportHeader = []string{
	"id", "posted_at", "amount", "currency", "amount_aed", "direction",
	"merchant", "category", "bucket", "status", "source",
}

// filsToDecimal renders integer minor units as a plain decimal string
// ("215.00") without ever touching floats.
func filsToDecimal(fils int64) string {
	sign := ""
	if fils < 0 {
		sign = "-"
		fils = -fils
	}
	return fmt.Sprintf("%s%d.%02d", sign, fils/100, fils%100)
}

// handleExportTransactions streams the transaction list as a CSV attachment.
// It honors the same status/from/to/q filters as GET /api/transactions, so a
// spot-audit export matches exactly what the list shows server-side.
func (s *Server) handleExportTransactions(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"transactions unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	qp := r.URL.Query()
	items, err := s.catStore.SelectTransactions(qp.Get("status"), qp.Get("from"), qp.Get("to"), qp.Get("q"))
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	filename := fmt.Sprintf("ledger-export-%s.csv", time.Now().UTC().Format("2006-01-02"))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	cw := csv.NewWriter(w)
	_ = cw.Write(exportHeader)
	for _, t := range items {
		aed := ""
		if t.AmountAedFils != nil {
			aed = filsToDecimal(*t.AmountAedFils)
		}
		_ = cw.Write([]string{
			strconv.FormatInt(t.ID, 10), t.PostedAt, filsToDecimal(t.AmountFils), t.Currency, aed,
			t.Direction, t.MerchantRaw, t.CategoryName, t.Bucket, t.Status, t.Source,
		})
	}
	cw.Flush()
}
```

Register the route in `internal/server/server.go`, directly after the `GET /api/transactions` line (line 163):

```go
s.mux.HandleFunc("GET /api/transactions/export", s.handleExportTransactions)
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server/export.go internal/server/export_test.go internal/server/server.go
git commit -m "feat(api): CSV export endpoint GET /api/transactions/export

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend Export button on the Transactions screen

**Files:**
- Modify: `frontend/src/lib/transactions.ts` (add `exportUrl`)
- Modify: `frontend/src/lib/transactions.test.ts` (add tests)
- Modify: `frontend/src/screens/Transactions.tsx` (button in the header row)
- Modify: `frontend/src/screens/Transactions.test.tsx` (link test)

**Interfaces:**
- Consumes: Task 2's `GET /api/transactions/export?status=&from=&to=&q=`. Screen state already present in `Transactions.tsx`: `status` (string, `""` for all), `from`/`to` props, `search` state.
- Produces: `export function exportUrl(opts: { status?: string; from?: string; to?: string; q?: string }): string` in `frontend/src/lib/transactions.ts`.

**Note:** chip filters (`TxnFilters`) are client-only and are deliberately NOT reflected in the export — the export mirrors the server-side filters (status, period, search). The button's `title` says so.

- [ ] **Step 1: Write the failing lib test**

Append to `frontend/src/lib/transactions.test.ts` (add `exportUrl` to the existing import from `./transactions`):

```ts
describe("exportUrl", () => {
  it("returns the bare endpoint with no filters", () => {
    expect(exportUrl({})).toBe("/api/transactions/export");
  });

  it("carries status, period and search", () => {
    expect(exportUrl({ status: "confirmed", from: "2026-06-01", to: "2026-06-32", q: "netflix" }))
      .toBe("/api/transactions/export?status=confirmed&from=2026-06-01&to=2026-06-32&q=netflix");
  });

  it("omits blank search and trims whitespace", () => {
    expect(exportUrl({ q: "  " })).toBe("/api/transactions/export");
    expect(exportUrl({ q: " spin " })).toBe("/api/transactions/export?q=spin");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: FAIL — `exportUrl` is not exported.

- [ ] **Step 3: Implement `exportUrl`**

Append to `frontend/src/lib/transactions.ts`:

```ts
/**
 * URL for the CSV export endpoint, carrying the same server-side filters as
 * the list query (status/from/to/q). Client-only chip filters are deliberately
 * not reflected — export mirrors what the server can filter.
 */
export function exportUrl(opts: { status?: string; from?: string; to?: string; q?: string }): string {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  const q = opts.q?.trim();
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/api/transactions/export?${qs}` : "/api/transactions/export";
}
```

- [ ] **Step 4: Run the lib test**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing screen test**

Append inside the `describe("Transactions", ...)` block in `frontend/src/screens/Transactions.test.tsx`:

```tsx
it("links CSV export to the current server-side filters", async () => {
  wrap({ from: "2026-06-01", to: "2026-06-32" });
  await screen.findByText("NETFLIX");
  fireEvent.click(screen.getByRole("button", { name: /confirmed/i }));
  fireEvent.change(screen.getByPlaceholderText(/search merchant/i), { target: { value: "net" } });
  const link = screen.getByRole("link", { name: /export csv/i });
  expect(link).toHaveAttribute(
    "href",
    "/api/transactions/export?status=confirmed&from=2026-06-01&to=2026-06-32&q=net",
  );
});
```

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: FAIL — no link with name "Export CSV".

- [ ] **Step 6: Add the button**

In `frontend/src/screens/Transactions.tsx`:

1. Extend the lucide import (line 19) with `Download`:
   ```tsx
   import { AlertTriangle, ListOrdered, Search, Plus, Download } from "lucide-react";
   ```
2. Extend the lib import (line 16) with `exportUrl`:
   ```tsx
   import { txnTotals, applyTxnFilters, EMPTY_FILTERS, exportUrl, type TxnFilters, type ManualTxnPayload } from "../lib/transactions";
   ```
3. Replace the header row (lines 72–74) with:
   ```tsx
   <div className="flex items-center justify-between gap-2">
     <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
     <a
       href={exportUrl({ status, from, to, q: search })}
       download
       aria-label="Export CSV"
       title="Export CSV (current status, period and search — chip filters not included)"
       className="shrink-0 p-2 rounded-md border border-border bg-surface text-muted"
     >
       <Download size={16} aria-hidden />
     </a>
   </div>
   ```

- [ ] **Step 7: Run the frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS (all files; remember vitest runs single-fork here).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/transactions.ts frontend/src/lib/transactions.test.ts frontend/src/screens/Transactions.tsx frontend/src/screens/Transactions.test.tsx
git commit -m "feat(transactions): CSV export button wired to server-side filters

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Ingest worker IDLE seam (`Waiter` / `IdleDialer` / `waitNext`)

**Files:**
- Modify: `internal/ingest/ingest.go` (interfaces, `SetIdle`, `waitNext`, `Run` loop)
- Test: `internal/ingest/ingest_test.go`

**Interfaces:**
- Consumes: existing `Worker` fields (`interval time.Duration`, `log *log.Logger`, `idle` added here), existing test fakes `fakeDialer`, `newTestStore`, `quietLogger` in `ingest_test.go`.
- Produces (Task 5 implements these against real IMAP):
  ```go
  // Waiter blocks until the mailbox signals new mail or a timeout passes.
  type Waiter interface {
      Wait(ctx context.Context, timeout time.Duration) error
      Close() error
  }
  // IdleDialer opens a Waiter (a connection that can park in IMAP IDLE).
  type IdleDialer interface {
      DialIdle(ctx context.Context) (Waiter, error)
  }
  func (w *Worker) SetIdle(d IdleDialer)
  ```
  Semantics of `Wait`: returns `nil` when it's time to sync again (new-mail signal **or** timeout elapsed — callers don't distinguish), and a non-nil error on cancellation or connection failure.

- [ ] **Step 1: Write the failing tests**

Append to `internal/ingest/ingest_test.go` (add `"errors"` to the imports):

```go
// scriptedWaiter signals "new mail" instantly on the first Wait call and then
// blocks until cancellation, so tests can prove the early-wake path without
// real timers.
type scriptedWaiter struct {
	mu     sync.Mutex
	nWaits int
	closed bool
}

func (s *scriptedWaiter) Wait(ctx context.Context, timeout time.Duration) error {
	s.mu.Lock()
	s.nWaits++
	first := s.nWaits == 1
	s.mu.Unlock()
	if first {
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

func (s *scriptedWaiter) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	return nil
}

func (s *scriptedWaiter) wasClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

type fakeIdleDialer struct {
	w       *scriptedWaiter
	dialErr error
}

func (d *fakeIdleDialer) DialIdle(ctx context.Context) (Waiter, error) {
	if d.dialErr != nil {
		return nil, d.dialErr
	}
	return d.w, nil
}

func TestWaitNextWakesOnIdleSignal(t *testing.T) {
	st := newTestStore(t)
	// 1h interval: if waitNext returns promptly, the idle signal (not the
	// timer) woke it.
	w := New(&fakeDialer{mb: mailboxWith(1)}, st, time.Hour, quietLogger())
	sw := &scriptedWaiter{}
	w.SetIdle(&fakeIdleDialer{w: sw})

	start := time.Now()
	if !w.waitNext(context.Background()) {
		t.Fatal("waitNext = false, want true")
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("waitNext took %s; the idle signal should wake it immediately", elapsed)
	}
	if !sw.wasClosed() {
		t.Error("waiter connection not closed after waitNext")
	}
}

func TestWaitNextFallsBackToTimerOnDialError(t *testing.T) {
	st := newTestStore(t)
	w := New(&fakeDialer{mb: mailboxWith(1)}, st, 20*time.Millisecond, quietLogger())
	w.SetIdle(&fakeIdleDialer{dialErr: errors.New("boom")})

	if !w.waitNext(context.Background()) {
		t.Fatal("waitNext = false, want true (interval-timer fallback)")
	}
}

func TestWaitNextReturnsFalseWhenCancelled(t *testing.T) {
	st := newTestStore(t)
	w := New(&fakeDialer{mb: mailboxWith(1)}, st, time.Hour, quietLogger())
	// nWaits pre-set to 1 so Wait blocks on ctx instead of signalling.
	sw := &scriptedWaiter{nWaits: 1}
	w.SetIdle(&fakeIdleDialer{w: sw})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if w.waitNext(ctx) {
		t.Fatal("waitNext = true on cancelled ctx, want false")
	}
}

func TestWaitNextWithoutIdleUsesTimer(t *testing.T) {
	st := newTestStore(t)
	w := New(&fakeDialer{mb: mailboxWith(1)}, st, 20*time.Millisecond, quietLogger())
	if !w.waitNext(context.Background()) {
		t.Fatal("waitNext = false, want true after interval")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/ingest/ -run TestWaitNext`
Expected: FAIL — `undefined: Waiter`, `w.SetIdle undefined`, `w.waitNext undefined` (build errors).

- [ ] **Step 3: Implement the seam**

In `internal/ingest/ingest.go`:

1. After the `Dialer` interface (line 57–59), add:

```go
// Waiter blocks until the mailbox signals new mail or a timeout passes.
// Wait returns nil when it is time to sync again (a new-mail signal or the
// timeout elapsing — callers treat both the same) and a non-nil error on
// cancellation or connection failure. Close releases the connection.
type Waiter interface {
	Wait(ctx context.Context, timeout time.Duration) error
	Close() error
}

// IdleDialer opens a Waiter: a dedicated connection that can park in IMAP
// IDLE between syncs. Optional — without one the worker is purely poll-driven.
type IdleDialer interface {
	DialIdle(ctx context.Context) (Waiter, error)
}
```

2. Add the field to `Worker` (after `postProcess`):

```go
	idle        IdleDialer
```

3. After `SetPostProcess`, add:

```go
// SetIdle registers an IdleDialer. When set, the worker parks in IMAP IDLE
// between syncs and wakes early on new mail; the poll interval remains the
// fallback upper bound, so IDLE failures degrade to plain polling.
func (w *Worker) SetIdle(d IdleDialer) {
	w.idle = d
}
```

4. Replace the `Run` method with:

```go
// Run syncs the mailbox until ctx is cancelled: every interval, plus (when an
// IdleDialer is set) immediately on an IDLE new-mail signal. Transient errors
// are logged and retried on the next cycle; the worker never crashes the process.
func (w *Worker) Run(ctx context.Context) {
	mode := "poll"
	if w.idle != nil {
		mode = "idle+poll"
	}
	w.log.Printf("ingest worker started (%s, interval %s)", mode, w.interval)
	for {
		n, err := w.pollOnce(ctx)
		switch {
		case ctx.Err() != nil:
			w.log.Printf("ingest worker stopping")
			return
		case err != nil:
			w.log.Printf("ingest sync error: %v", err)
		case n > 0:
			w.log.Printf("ingest: %d new message(s)", n)
		}
		if !w.waitNext(ctx) {
			w.log.Printf("ingest worker stopping")
			return
		}
	}
}

// waitNext blocks until the next sync should run. With an IdleDialer set it
// parks in IMAP IDLE and wakes early on a new-mail signal; the poll interval
// is always the upper bound, and the sole mechanism when IDLE is off or
// failing (a failed IDLE falls through to the plain timer, so the worker can
// never spin hot). Returns false when ctx was cancelled.
func (w *Worker) waitNext(ctx context.Context) bool {
	if w.idle != nil {
		wtr, err := w.idle.DialIdle(ctx)
		if err == nil {
			werr := wtr.Wait(ctx, w.interval)
			_ = wtr.Close()
			if werr == nil {
				return true // new-mail signal or interval elapsed: sync now
			}
			if ctx.Err() != nil {
				return false
			}
			w.log.Printf("idle wait error: %v (falling back to poll timer)", werr)
		} else {
			if ctx.Err() != nil {
				return false
			}
			w.log.Printf("idle dial error: %v (falling back to poll timer)", err)
		}
	}
	select {
	case <-ctx.Done():
		return false
	case <-time.After(w.interval):
		return true
	}
}
```

- [ ] **Step 4: Run the package tests (including race)**

Run: `go test ./internal/ingest/ && go test ./internal/ingest/ -race`
Expected: PASS — new tests plus all existing worker tests (the poll-only path must be behaviorally unchanged).

- [ ] **Step 5: Commit**

```bash
git add internal/ingest/ingest.go internal/ingest/ingest_test.go
git commit -m "feat(ingest): IDLE seam — worker wakes early on a Waiter signal, poll interval stays the fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Real IMAP IDLE (`DialIdle`) + wiring + config docs

**Files:**
- Modify: `internal/ingest/imap.go` (shared `connect` helper, `DialIdle`, `idleWaiter`)
- Modify: `cmd/ledger/main.go:274-281` (wire `SetIdle` when `use_idle = true`)
- Modify: `config.example.toml:18-19` (document that `use_idle` is now functional)
- Modify: `CLAUDE.md` (ingest bullet: mention optional IDLE)

**Interfaces:**
- Consumes: Task 4's `Waiter` / `IdleDialer` / `SetIdle`; `imapclient.Client.Idle()` (go-imap v2 — auto-restarts IDLE every 28min internally); `imapclient.Options.UnilateralDataHandler` (must be registered at dial time); `cfg.IMAP.UseIDLE` (`internal/config/config.go:40`, already parsed, default false).
- Produces: `func (d *imapDialer) DialIdle(ctx context.Context) (Waiter, error)` — so the concrete dialer satisfies both `Dialer` and `IdleDialer`.

**Design constraint:** the IDLE connection selects the folder with `ReadOnly: true` (EXAMINE), same as the sync path — IDLE never weakens the read-only guarantee. Each `waitNext` cycle dials a fresh IDLE connection and closes it before syncing; there is no long-lived connection state to corrupt, and reconnects are free.

- [ ] **Step 1: Refactor `Dial` and add `DialIdle`**

Replace the contents of `internal/ingest/imap.go` from the top through the `Dial` method (lines 1–40) with:

```go
package ingest

import (
	"context"
	"fmt"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"

	"ledger/internal/config"
)

// imapDialer opens authenticated, read-only IMAP connections from config.
// It implements both Dialer (per-sync connections) and IdleDialer (dedicated
// IDLE connections that wake the worker on new mail).
type imapDialer struct {
	cfg config.IMAPConfig
}

// NewIMAPDialer returns a Dialer backed by go-imap/v2. The returned value
// also implements IdleDialer (checked via type assertion in main).
func NewIMAPDialer(cfg config.IMAPConfig) Dialer { return &imapDialer{cfg: cfg} }

// connect dials TLS and authenticates. opts may carry a unilateral-data
// handler (required at dial time by go-imap for IDLE notifications); nil is
// fine for plain sync connections.
func (d *imapDialer) connect(opts *imapclient.Options) (*imapclient.Client, error) {
	c, err := imapclient.DialTLS(d.cfg.Addr(), opts)
	if err != nil {
		return nil, fmt.Errorf("imap dial %s: %w", d.cfg.Addr(), err)
	}
	switch d.cfg.Auth {
	case "app_password", "":
		if err := c.Login(d.cfg.Username, d.cfg.AppPassword).Wait(); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("imap login: %w", err)
		}
	case "oauth2":
		_ = c.Close()
		return nil, fmt.Errorf("imap auth oauth2 not implemented yet; use app_password")
	default:
		_ = c.Close()
		return nil, fmt.Errorf("imap: unknown auth %q", d.cfg.Auth)
	}
	return c, nil
}

func (d *imapDialer) Dial(ctx context.Context) (Mailbox, error) {
	c, err := d.connect(nil)
	if err != nil {
		return nil, err
	}
	return &imapMailbox{c: c, folder: d.cfg.Folder}, nil
}

// DialIdle opens a connection whose sole job is to park in IDLE and report
// new-mail activity. The unilateral-data handler must be registered at dial
// time, and the folder is selected read-only (EXAMINE) — IDLE never weakens
// the read-only guarantee.
func (d *imapDialer) DialIdle(ctx context.Context) (Waiter, error) {
	notify := make(chan struct{}, 1)
	opts := &imapclient.Options{
		UnilateralDataHandler: &imapclient.UnilateralDataHandler{
			Mailbox: func(data *imapclient.UnilateralDataMailbox) {
				if data.NumMessages != nil {
					select {
					case notify <- struct{}{}:
					default:
					}
				}
			},
		},
	}
	c, err := d.connect(opts)
	if err != nil {
		return nil, err
	}
	if _, err := c.Select(d.cfg.Folder, &imap.SelectOptions{ReadOnly: true}).Wait(); err != nil {
		_ = c.Close()
		return nil, fmt.Errorf("idle examine %q: %w", d.cfg.Folder, err)
	}
	return &idleWaiter{c: c, notify: notify}, nil
}

// idleWaiter is one parked IDLE connection.
type idleWaiter struct {
	c      *imapclient.Client
	notify chan struct{}
}

func (iw *idleWaiter) Wait(ctx context.Context, timeout time.Duration) error {
	cmd, err := iw.c.Idle()
	if err != nil {
		return fmt.Errorf("idle: %w", err)
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	var reason error
	select {
	case <-ctx.Done():
		reason = ctx.Err()
	case <-iw.notify: // server pushed EXISTS: new mail
	case <-timer.C: // fallback heartbeat: sync anyway
	}
	if err := cmd.Close(); err != nil && reason == nil {
		return fmt.Errorf("idle close: %w", err)
	}
	return reason
}

func (iw *idleWaiter) Close() error {
	_ = iw.c.Logout().Wait()
	return iw.c.Close()
}
```

Keep the existing `imapMailbox` type and its methods (`Examine`, `ListUIDs`, `Fetch`, `Close`) below, unchanged.

- [ ] **Step 2: Verify it builds and existing tests pass**

Run: `go build ./... && go vet ./internal/ingest/ && go test ./internal/ingest/`
Expected: builds clean, tests PASS. (`DialIdle` itself has no unit test — it's pure I/O against a real server, same policy as `Dial`; the logic around it was tested in Task 4.)

- [ ] **Step 3: Wire it in main**

In `cmd/ledger/main.go`, inside the `if cfg.IMAP.Enabled()` block (lines 274–281), after `worker.SetPostProcess(...)` and before `srv.SetIngestHealth(...)`, add:

```go
		if cfg.IMAP.UseIDLE {
			if idler, ok := dialer.(ingest.IdleDialer); ok {
				worker.SetIdle(idler)
			}
		}
```

And replace the log line:

```go
		mode := "poll"
		if cfg.IMAP.UseIDLE {
			mode = "idle+poll"
		}
		log.Printf("ingest+parse enabled for %s (mailbox %s, %s, interval %s)", cfg.IMAP.Username, cfg.IMAP.Folder, mode, interval)
```

- [ ] **Step 4: Update the docs**

`config.example.toml` — replace lines 18–19:

```toml
use_idle      = false                   # true: park in IMAP IDLE between syncs — new mail triggers an immediate sync
poll_interval = "60s"                   # sync cadence; with use_idle=true this is just the fallback heartbeat (raise it, e.g. "15m")
```

`CLAUDE.md` — in the `internal/` packages list, extend the **`ingest`** bullet's last sentence:

> …then calls a post-process hook to run the parse cascade over unparsed rows. With `use_idle = true` it also parks in IMAP IDLE between polls so new mail triggers an immediate sync; the poll interval remains the fallback heartbeat.

- [ ] **Step 5: Full build + test**

Run: `go build ./... && go test ./...`
Expected: PASS (modulo the known `internal/config` env false-failure — verify with `env -u LEDGER_AI_API_KEY go test ./internal/config`).

- [ ] **Step 6: Commit**

```bash
git add internal/ingest/imap.go cmd/ledger/main.go config.example.toml CLAUDE.md
git commit -m "feat(ingest): wire use_idle — IMAP IDLE wakes the worker, polling stays the fallback

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Manual verification (deploy-time, not part of this task's gate):** on dinosaur, set `use_idle = true` and `poll_interval = "15m"` in `/etc/ledger/config.toml`, restart the service, send yourself a bank-alert email, and confirm via `journalctl -u ledger -f` that the sync fires within seconds (log shows `idle+poll`), not at the next 15-minute tick. Per deploy memory: confirm the running process actually loaded the new binary.

---

### Task 6: Combined verification + embedded dist rebuild

Parallel sessions run on `main` — re-sync before rebuilding the committed dist so the embedded bundle matches **all** current frontend source, not just this branch's edits.

**Files:**
- Modify: `internal/web/dist/**` (committed build artifact)

- [ ] **Step 1: Re-sync with main**

```bash
git pull --rebase 2>/dev/null || true
git status
```

If other sessions landed frontend changes, they're now included in the rebuild below.

- [ ] **Step 2: Run both test suites**

```bash
go test ./... && (cd frontend && bun run test)
env -u LEDGER_AI_API_KEY go test ./internal/config
```

Expected: all PASS.

- [ ] **Step 3: Rebuild the embedded bundle and binary**

```bash
cd frontend && bun install && bun run build && cd ..
CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```

Expected: both succeed; `internal/web/dist/` updated.

- [ ] **Step 4: Smoke-test the real binary**

`SelectTransactions` changed, and per project memory any store change warrants smoking the live endpoints:

```bash
LEDGER_DATA_DIR=$(mktemp -d) LEDGER_LISTEN=127.0.0.1:8899 ./ledger &
sleep 1
curl -s "http://127.0.0.1:8899/api/transactions?q=test"        # expect: []
curl -s http://127.0.0.1:8899/api/summary | head -c 200        # expect: JSON with buckets
curl -sD - -o /dev/null "http://127.0.0.1:8899/api/transactions/export?q=x" | grep -i 'content-type\|content-disposition'
# expect: text/csv + attachment; filename="ledger-export-...csv"
kill %1
```

- [ ] **Step 5: Commit the dist**

```bash
git add internal/web/dist
git commit -m "build(web): rebuild embedded dist (transaction search + CSV export button)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** (1) Transaction search — `q=` param: Task 1; search box: already shipped client-side, documented in Scope notes; semantics match (`LIKE` contains ≙ lowercase `.includes`). (2) CSV export — endpoint: Task 2; portability/spot-audit columns incl. decimal amounts and AED snapshot: Task 2; UI affordance: Task 3. (3) IMAP IDLE — conscious decision recorded (hybrid, polling remains fallback): Scope notes; seam + tests: Task 4; real IDLE + `use_idle` wiring + docs: Task 5.
- **Placeholder scan:** every code step contains full code; no TBDs; caller-update list in Task 1 is exhaustive (verified by grep during planning: `transactions.go:58`, `server.go:49`, `categorize_job.go:46`, plus literal-arg test callers in `store`, `importer`, `parse`).
- **Type consistency:** `SelectTransactions(status, from, to, search string)` used identically in Tasks 1–2; `exportUrl` name/shape identical in Task 3 steps; `Waiter`/`IdleDialer`/`SetIdle`/`waitNext` names identical across Tasks 4–5; `filsToDecimal` defined and tested in Task 2 only.
