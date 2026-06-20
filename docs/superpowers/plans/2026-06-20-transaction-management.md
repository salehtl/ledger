# Transaction Management & Manual Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user soft-delete (archive/restore) any transaction and manually add a transaction from the PWA.

**Architecture:** Add a reversible `archived` status backed by a new `archived_from` column that remembers the pre-archive status, so archiving and restoring are lossless. Archive/restore and manual-create are new HTTP endpoints over `*store.Store`. The Transactions screen grows an "Archived" filter, an Add button, and per-row Archive/Restore actions. Budget and insights queries already filter to `status='confirmed'`, so archived rows fall out of those automatically — no math changes.

**Tech Stack:** Go 1.22 (stdlib `net/http`, pure-Go SQLite via `modernc.org/sqlite`), React 18 + TypeScript + Vite, TanStack Query, Tailwind v4, vitest, lucide-react.

## Global Constraints

- **Money is integer minor units.** Always `int64` fils (AED × 100). `transactions.amount` is always **positive**; `direction` is `'debit'|'credit'`. Never use floats for money.
- **Soft-delete only.** No transaction is ever hard-deleted in this feature. "Archive" is a reversible hidden state; there is no erase/DELETE path.
- **Single binary, embedded frontend.** The PWA is embedded via `embed.FS`. The frontend must be rebuilt (`cd frontend && bun run build`) before `go build`, and `internal/web/dist/` is a committed artifact that must be rebuilt before finishing the branch.
- **Schema migrations are additive.** No migration tool exists; `schema.sql` uses `CREATE TABLE IF NOT EXISTS` and new columns are added via `addColumnIfMissing` in `internal/store/store.go`'s `migrate`.
- **API shape.** Routes use Go 1.22 method+pattern syntax (`s.mux.HandleFunc("POST /api/...")`). Handlers write JSON and call `s.BroadcastEvent("tx", nil)` after a successful mutation so SSE clients refresh.
- **Frontend lib convention.** Pure decision/format logic lives in `frontend/src/lib/*` with a co-located `*.test.ts`; components stay thin.
- **Tests:** `go test ./...` (Go), `cd frontend && bun run test` (vitest, pinned single-fork — do not parallelize).

---

### Task 1: Archive / Restore store methods (+ `archived_from` column)

**Files:**
- Modify: `internal/store/schema.sql:50-68` (add `archived_from` column to `transactions`)
- Modify: `internal/store/store.go` (`migrate` func, ~line 67)
- Modify: `internal/store/transactions.go` (add two methods at end of file)
- Test: `internal/store/transactions_test.go` (append tests)

**Interfaces:**
- Consumes: existing `newTestStore(t)`, `txnRow()` helper, `InsertTransaction(TransactionRow) (int64, bool, error)`, `UpdateTransactionCategory(txID, catID int64, status string) error`, `SelectMonthSpend(period string, frozen bool) ([]SpendRow, error)` — all in package `store`.
- Produces: `func (s *Store) ArchiveTransaction(txID int64) error` and `func (s *Store) RestoreTransaction(txID int64) error`. Archiving stashes the prior `status` into `archived_from` and sets `status='archived'`; restoring sets `status` back to `archived_from` (or `'needs_review'` if empty) and clears `archived_from`. Both are no-ops when the row is not in the relevant state.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/transactions_test.go`:

```go
func seedConfirmedTxn(t *testing.T, st *Store) int64 {
	t.Helper()
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "arch-seed", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='arch-seed'").Scan(&ingestID)
	row := txnRow()
	row.IngestID = ingestID
	row.PostedAt = time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC)
	id, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatal(err)
	}
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if err := st.UpdateTransactionCategory(id, catID, "confirmed"); err != nil {
		t.Fatal(err)
	}
	return id
}

func statusOf(t *testing.T, st *Store, id int64) string {
	t.Helper()
	var s string
	if err := st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestArchiveAndRestoreRoundTrip(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if got := statusOf(t, st, id); got != "archived" {
		t.Fatalf("status after archive = %q, want archived", got)
	}

	if err := st.RestoreTransaction(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := statusOf(t, st, id); got != "confirmed" {
		t.Fatalf("status after restore = %q, want confirmed (prior status preserved)", got)
	}
}

func TestArchiveHidesFromBudget(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	before, _ := st.SelectMonthSpend("2026-06", false)
	if len(before) != 1 {
		t.Fatalf("pre-archive month spend rows = %d, want 1", len(before))
	}
	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatal(err)
	}
	after, _ := st.SelectMonthSpend("2026-06", false)
	if len(after) != 0 {
		t.Fatalf("archived txn still counted in budget: %d rows", len(after))
	}
}

func TestRestoreNonArchivedIsNoOp(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)
	if err := st.RestoreTransaction(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := statusOf(t, st, id); got != "confirmed" {
		t.Fatalf("status = %q, want unchanged confirmed", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run 'Archive|Restore' -v`
Expected: FAIL — `st.ArchiveTransaction undefined` / `st.RestoreTransaction undefined`.

- [ ] **Step 3: Add the `archived_from` column to the schema**

In `internal/store/schema.sql`, inside the `transactions` table, add the column after `source` (keep the existing `ingest_id` line):

```sql
  source          TEXT NOT NULL DEFAULT 'email',  -- 'email' | 'import' | 'manual'
  archived_from   TEXT,                            -- pre-archive status; set only while status='archived'
  ingest_id       INTEGER REFERENCES ingest_log(id),
```

- [ ] **Step 4: Add the migration for existing databases**

In `internal/store/store.go`, change `migrate` to also add the column:

```go
func migrate(db *sql.DB) error {
	if err := addColumnIfMissing(db, "rules", "is_active", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	return addColumnIfMissing(db, "transactions", "archived_from", "TEXT")
}
```

- [ ] **Step 5: Implement the store methods**

Append to `internal/store/transactions.go`:

```go
// ArchiveTransaction soft-deletes a transaction: it stashes the current status
// in archived_from and sets status='archived'. Archived rows are hidden from the
// default transaction list and fall out of budgets/insights (which count only
// status='confirmed'). No row is ever physically deleted. No-op if already archived.
func (s *Store) ArchiveTransaction(txID int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`UPDATE transactions
		    SET archived_from=status, status='archived', updated_at=?
		  WHERE id=? AND status!='archived'`,
		now, txID,
	)
	return err
}

// RestoreTransaction reverses ArchiveTransaction: it returns the row to its
// pre-archive status (or 'needs_review' when unknown) and clears archived_from.
// No-op if the row is not archived.
func (s *Store) RestoreTransaction(txID int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`UPDATE transactions
		    SET status=COALESCE(NULLIF(archived_from,''), 'needs_review'),
		        archived_from=NULL, updated_at=?
		  WHERE id=? AND status='archived'`,
		now, txID,
	)
	return err
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./internal/store/ -run 'Archive|Restore' -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full store package to check for regressions**

Run: `go test ./internal/store/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add internal/store/schema.sql internal/store/store.go internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): reversible archive/restore for transactions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Hide archived rows from the default transaction list

**Files:**
- Modify: `internal/store/transactions.go` (`SelectTransactions`, lines ~226-252)
- Test: `internal/store/transactions_test.go` (append test)

**Interfaces:**
- Consumes: `ArchiveTransaction(txID int64) error` (Task 1), `seedConfirmedTxn` / `statusOf` helpers (Task 1), existing `SelectTransactions(status, from, to string) ([]ReviewItem, error)`.
- Produces: `SelectTransactions("", "", "")` now excludes `status='archived'`; `SelectTransactions("archived", "", "")` returns only archived rows. Signature unchanged.

- [ ] **Step 1: Write the failing test**

Append to `internal/store/transactions_test.go`:

```go
func TestSelectTransactionsExcludesArchivedByDefault(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)
	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatal(err)
	}

	all, err := st.SelectTransactions("", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Fatalf("default list returned archived row: %d items", len(all))
	}

	arch, err := st.SelectTransactions("archived", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(arch) != 1 {
		t.Fatalf("status=archived returned %d items, want 1", len(arch))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestSelectTransactionsExcludesArchivedByDefault -v`
Expected: FAIL — default list returns 1 item (archived row leaks through).

- [ ] **Step 3: Implement the exclusion**

In `internal/store/transactions.go`, update the `status` branch of `SelectTransactions`:

```go
	var args []any
	if status != "" {
		q += " AND t.status=?"
		args = append(args, status)
	} else {
		// Archived rows are soft-deleted: hidden from the default list, reachable
		// only by explicitly asking for status='archived'.
		q += " AND t.status!='archived'"
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/store/ -run TestSelectTransactionsExcludesArchivedByDefault -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): exclude archived transactions from default list

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `InsertManualTransaction` store method

**Files:**
- Modify: `internal/store/transactions.go` (add `ManualTxn` struct + method; add `crypto/rand` import)
- Test: `internal/store/transactions_test.go` (append tests)

**Interfaces:**
- Consumes: existing `TransactionRow.Fingerprint() string`, `SelectTransactions(...)`.
- Produces:
  ```go
  type ManualTxn struct {
      PostedAt    time.Time
      AmountFils  int64
      Currency    string // "" defaults to "AED"
      Direction   string // "debit" | "credit"
      MerchantRaw string
      CategoryID  int64  // 0 = uncategorized
  }
  func (s *Store) InsertManualTransaction(m ManualTxn) (int64, error)
  ```
  Inserts `source='manual'`, `confidence=1.0`. Status is `'confirmed'` when `CategoryID>0`, else `'needs_review'`. Returns the new row id. The fingerprint is salted so a deliberate manual entry never collides with the UNIQUE fingerprint index.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/transactions_test.go`:

```go
func TestInsertManualTransactionConfirmedWithCategory(t *testing.T) {
	st := newTestStore(t)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			catID = c.ID
		}
	}
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC),
		AmountFils:  4250,
		Direction:   "debit",
		MerchantRaw: "Corner Shop",
		CategoryID:  catID,
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	var status, source, currency string
	st.DB.QueryRow("SELECT status, source, currency FROM transactions WHERE id=?", id).
		Scan(&status, &source, &currency)
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}
	if source != "manual" {
		t.Errorf("source = %q, want manual", source)
	}
	if currency != "AED" {
		t.Errorf("currency = %q, want default AED", currency)
	}
}

func TestInsertManualTransactionUncategorizedGoesToReview(t *testing.T) {
	st := newTestStore(t)
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC),
		AmountFils:  1000,
		Direction:   "debit",
		MerchantRaw: "Mystery",
	})
	if err != nil {
		t.Fatal(err)
	}
	var status string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&status)
	if status != "needs_review" {
		t.Errorf("status = %q, want needs_review", status)
	}
}

func TestInsertManualTransactionAllowsDuplicateFingerprint(t *testing.T) {
	st := newTestStore(t)
	m := ManualTxn{
		PostedAt:    time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC),
		AmountFils:  1500,
		Direction:   "debit",
		MerchantRaw: "Coffee",
	}
	if _, err := st.InsertManualTransaction(m); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if _, err := st.InsertManualTransaction(m); err != nil {
		t.Fatalf("second identical manual insert should not collide: %v", err)
	}
	rows, _ := st.SelectTransactions("", "", "")
	if len(rows) != 2 {
		t.Fatalf("want 2 manual rows, got %d", len(rows))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run TestInsertManualTransaction -v`
Expected: FAIL — `st.InsertManualTransaction undefined`.

- [ ] **Step 3: Add the `crypto/rand` import**

In `internal/store/transactions.go`, update the import block to include `crypto/rand`:

```go
import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)
```

- [ ] **Step 4: Implement the struct and method**

Append to `internal/store/transactions.go`:

```go
// ManualTxn is a user-entered transaction. CategoryID 0 means uncategorized.
type ManualTxn struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string // "" defaults to "AED"
	Direction   string // "debit" | "credit"
	MerchantRaw string
	CategoryID  int64
}

// InsertManualTransaction writes a user-entered transaction (source='manual',
// confidence 1.0). A row with a category is trusted and stored 'confirmed';
// without one it lands in 'needs_review'. The fingerprint is salted with random
// bytes so a deliberate manual entry never trips the UNIQUE fingerprint index
// (two identical real-world purchases on the same day are legitimate).
func (s *Store) InsertManualTransaction(m ManualTxn) (int64, error) {
	currency := m.Currency
	if currency == "" {
		currency = "AED"
	}
	status := "needs_review"
	var catID any
	if m.CategoryID > 0 {
		status = "confirmed"
		catID = m.CategoryID
	}
	base := TransactionRow{
		PostedAt:    m.PostedAt,
		AmountFils:  m.AmountFils,
		Direction:   m.Direction,
		MerchantRaw: m.MerchantRaw,
	}
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return 0, err
	}
	fp := base.Fingerprint() + "|manual|" + hex.EncodeToString(salt)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, category_id, status,
		    confidence, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
		m.PostedAt.UTC().Format(time.RFC3339Nano), m.AmountFils, currency, m.Direction,
		m.MerchantRaw, catID, status, 1.0, fp, now, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/store/ -run TestInsertManualTransaction -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): InsertManualTransaction for user-entered rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Archive / Restore HTTP endpoints

**Files:**
- Modify: `internal/server/server.go` (`CategoryStore` interface ~line 43-58; route table ~line 160)
- Modify: `internal/server/transactions.go` (add two handlers)
- Test: `internal/server/transactions_test.go` (append tests)

**Interfaces:**
- Consumes: `s.catStore` (`CategoryStore`), `ArchiveTransaction(int64) error` + `RestoreTransaction(int64) error` (Task 1), `s.BroadcastEvent(string, any)`, test helpers `newTestServerStore`, `newTestServerWithStore`, `seedTestTransaction`.
- Produces: `POST /api/transactions/{id}/archive` and `POST /api/transactions/{id}/restore`, each returning `{"ok": true}` on success, `400` on a non-numeric id.

- [ ] **Step 1: Write the failing tests**

Append to `internal/server/transactions_test.go`:

```go
func TestPostArchiveAndRestore(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/archive", txID), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("archive status = %d; body: %s", w.Code, w.Body)
	}
	var dbStatus string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&dbStatus)
	if dbStatus != "archived" {
		t.Fatalf("db status = %q, want archived", dbStatus)
	}

	r = httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/restore", txID), nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("restore status = %d; body: %s", w.Code, w.Body)
	}
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&dbStatus)
	if dbStatus != "needs_review" {
		t.Fatalf("db status after restore = %q, want needs_review", dbStatus)
	}
}

func TestPostArchiveInvalidID(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	r := httptest.NewRequest("POST", "/api/transactions/abc/archive", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run TestPostArchive -v`
Expected: FAIL — route returns 404 (handler not registered), so status != 200/400 as asserted.

- [ ] **Step 3: Extend the `CategoryStore` interface**

In `internal/server/server.go`, add to the `CategoryStore` interface (after `ClearAllCategorization`):

```go
	ClearAllCategorization() (int64, error)
	ArchiveTransaction(txID int64) error
	RestoreTransaction(txID int64) error
```

- [ ] **Step 4: Register the routes**

In `internal/server/server.go`, after the existing `POST /api/transactions/{id}/status` line:

```go
	s.mux.HandleFunc("POST /api/transactions/{id}/status", s.handleSetStatus)
	s.mux.HandleFunc("POST /api/transactions/{id}/archive", s.handleArchive)
	s.mux.HandleFunc("POST /api/transactions/{id}/restore", s.handleRestore)
```

- [ ] **Step 5: Implement the handlers**

Append to `internal/server/transactions.go`:

```go
func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	s.archiveOrRestore(w, r, true)
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	s.archiveOrRestore(w, r, false)
}

// archiveOrRestore handles both soft-delete directions: archive (true) stashes
// the current status and hides the row; restore (false) brings it back.
func (s *Server) archiveOrRestore(w http.ResponseWriter, r *http.Request, archive bool) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	if archive {
		err = s.catStore.ArchiveTransaction(txID)
	} else {
		err = s.catStore.RestoreTransaction(txID)
	}
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./internal/server/ -run TestPostArchive -v`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add internal/server/server.go internal/server/transactions.go internal/server/transactions_test.go
git commit -m "feat(server): archive/restore transaction endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Manual-create HTTP endpoint

**Files:**
- Modify: `internal/server/server.go` (`CategoryStore` interface; route table ~line 158)
- Modify: `internal/server/transactions.go` (add handler + request struct)
- Test: `internal/server/transactions_test.go` (append tests)

**Interfaces:**
- Consumes: `s.catStore`, `InsertManualTransaction(store.ManualTxn) (int64, error)` (Task 3), `s.BroadcastEvent`.
- Produces: `POST /api/transactions` accepting JSON `{posted_at, amount_fils, currency, direction, merchant_raw, category_id}` and returning `201` with `{"id": <int64>}`. Validation: `amount_fils>0`, `direction ∈ {debit,credit}`, non-empty `merchant_raw`, parseable `posted_at` (RFC3339 or `YYYY-MM-DD`). Failures return `400`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/server/transactions_test.go`:

```go
func TestPostManualTransaction(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{
		"posted_at": "2026-06-15", "amount_fils": 4250, "direction": "debit",
		"merchant_raw": "Corner Shop",
	})
	r := httptest.NewRequest("POST", "/api/transactions", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["id"] == nil || resp["id"].(float64) <= 0 {
		t.Fatalf("expected positive id, got %v", resp["id"])
	}
	var n int
	st.DB.QueryRow("SELECT count(*) FROM transactions WHERE source='manual'").Scan(&n)
	if n != 1 {
		t.Errorf("manual rows = %d, want 1", n)
	}
}

func TestPostManualTransactionRejectsBadInput(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	cases := []map[string]any{
		{"posted_at": "2026-06-15", "amount_fils": 0, "direction": "debit", "merchant_raw": "X"},      // amount <= 0
		{"posted_at": "2026-06-15", "amount_fils": 100, "direction": "sideways", "merchant_raw": "X"}, // bad direction
		{"posted_at": "2026-06-15", "amount_fils": 100, "direction": "debit", "merchant_raw": "  "},   // blank merchant
		{"posted_at": "nope", "amount_fils": 100, "direction": "debit", "merchant_raw": "X"},          // bad date
	}
	for i, c := range cases {
		body, _ := json.Marshal(c)
		r := httptest.NewRequest("POST", "/api/transactions", bytes.NewReader(body))
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("case %d: status = %d, want 400", i, w.Code)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run TestPostManualTransaction -v`
Expected: FAIL — `POST /api/transactions` is unregistered (the existing handler is only `GET`), so the create returns 405/404, not 201.

- [ ] **Step 3: Extend the `CategoryStore` interface**

In `internal/server/server.go`, add to `CategoryStore` (after the Task 4 additions):

```go
	ArchiveTransaction(txID int64) error
	RestoreTransaction(txID int64) error
	InsertManualTransaction(store.ManualTxn) (int64, error)
```

- [ ] **Step 4: Register the route**

In `internal/server/server.go`, after the existing `GET /api/transactions` line:

```go
	s.mux.HandleFunc("GET /api/transactions", s.handleGetTransactions)
	s.mux.HandleFunc("POST /api/transactions", s.handlePostTransaction)
```

- [ ] **Step 5: Implement the handler**

Append to `internal/server/transactions.go` (the `time` package import is needed — add it to the import block: `"time"`):

```go
type manualTxnReq struct {
	PostedAt    string `json:"posted_at"`
	AmountFils  int64  `json:"amount_fils"`
	Currency    string `json:"currency"`
	Direction   string `json:"direction"`
	MerchantRaw string `json:"merchant_raw"`
	CategoryID  int64  `json:"category_id"`
}

// parseManualDate accepts a full RFC3339 timestamp or a bare YYYY-MM-DD date.
func parseManualDate(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func (s *Server) handlePostTransaction(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req manualTxnReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if req.AmountFils <= 0 {
		http.Error(w, `{"error":"amount must be positive"}`, http.StatusBadRequest)
		return
	}
	if req.Direction != "debit" && req.Direction != "credit" {
		http.Error(w, `{"error":"direction must be debit or credit"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.MerchantRaw) == "" {
		http.Error(w, `{"error":"merchant required"}`, http.StatusBadRequest)
		return
	}
	posted, ok := parseManualDate(req.PostedAt)
	if !ok {
		http.Error(w, `{"error":"invalid posted_at"}`, http.StatusBadRequest)
		return
	}
	id, err := s.catStore.InsertManualTransaction(store.ManualTxn{
		PostedAt:    posted,
		AmountFils:  req.AmountFils,
		Currency:    req.Currency,
		Direction:   req.Direction,
		MerchantRaw: strings.TrimSpace(req.MerchantRaw),
		CategoryID:  req.CategoryID,
	})
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id})
}
```

Add `"strings"` and `"time"` to the import block of `internal/server/transactions.go` (currently `encoding/json`, `net/http`, `strconv`, `ledger/internal/store`):

```go
import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ledger/internal/store"
)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test ./internal/server/ -run TestPostManualTransaction -v`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the whole Go suite**

Run: `go test ./...`
Expected: PASS (all packages).

- [ ] **Step 8: Commit**

```bash
git add internal/server/server.go internal/server/transactions.go internal/server/transactions_test.go
git commit -m "feat(server): manual transaction create endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Frontend status label + tone for `archived`

**Files:**
- Modify: `frontend/src/lib/format.ts` (lines 1-21)
- Test: `frontend/src/lib/format.test.ts` (append assertions)

**Interfaces:**
- Consumes: existing `statusLabel(status)`, `statusTone(status)`.
- Produces: `statusLabel("archived") === "Archived"`, `statusTone("archived") === "muted"`.

- [ ] **Step 1: Write the failing assertions**

In `frontend/src/lib/format.test.ts`, add inside the existing `describe("statusLabel", ...)` block a new `it`:

```ts
  it("labels archived", () => {
    expect(statusLabel("archived")).toBe("Archived");
  });
```

And inside `describe("statusTone", ...)` add:

```ts
  it("tones archived as muted", () => {
    expect(statusTone("archived")).toBe("muted");
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/lib/format.test.ts`
Expected: FAIL — `statusLabel("archived")` returns `"Archived"` only via the capitalize fallback (passes), but `statusTone("archived")` returns `"neutral"`, not `"muted"`.

(Note: the label assertion may already pass via the capitalize fallback; the tone assertion is the real driver. Keep both — the explicit map entry makes intent clear.)

- [ ] **Step 3: Implement**

In `frontend/src/lib/format.ts`, add to `STATUS_LABELS`:

```ts
const STATUS_LABELS: Record<string, string> = {
  needs_review: "Needs review",
  confirmed: "Confirmed",
  transfer: "Transfer",
  ignored: "Ignored",
  archived: "Archived",
};
```

And add a case to `statusTone`:

```ts
export function statusTone(status: string): Tone {
  switch (status) {
    case "confirmed": return "good";
    case "needs_review": return "warn";
    case "ignored": return "muted";
    case "archived": return "muted";
    default: return "neutral";
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && bunx vitest run src/lib/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/format.ts frontend/src/lib/format.test.ts
git commit -m "feat(frontend): archived status label and tone

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `buildManualTxnPayload` pure helper

**Files:**
- Modify: `frontend/src/lib/transactions.ts` (append types + function)
- Test: `frontend/src/lib/transactions.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `dirhamsToFils(number)` from `./format`.
- Produces:
  ```ts
  export interface ManualTxnInput { merchant: string; amountAed: string; direction: string; date: string; categoryId: number | null; }
  export interface ManualTxnPayload { posted_at: string; amount_fils: number; currency: string; direction: string; merchant_raw: string; category_id: number; }
  export type BuildResult = { ok: true; payload: ManualTxnPayload } | { ok: false; error: string };
  export function buildManualTxnPayload(input: ManualTxnInput): BuildResult;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/transactions.test.ts` (extend the import from `./transactions` to include `buildManualTxnPayload`):

```ts
import { buildManualTxnPayload } from "./transactions";

describe("buildManualTxnPayload", () => {
  const base = { merchant: "Carrefour", amountAed: "42.50", direction: "debit", date: "2026-06-15", categoryId: 3 };

  it("builds a payload from valid input", () => {
    const r = buildManualTxnPayload(base);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toEqual({
        posted_at: "2026-06-15", amount_fils: 4250, currency: "AED",
        direction: "debit", merchant_raw: "Carrefour", category_id: 3,
      });
    }
  });

  it("defaults category_id to 0 when none chosen", () => {
    const r = buildManualTxnPayload({ ...base, categoryId: null });
    expect(r.ok && r.payload.category_id).toBe(0);
  });

  it("trims the merchant", () => {
    const r = buildManualTxnPayload({ ...base, merchant: "  Spinneys  " });
    expect(r.ok && r.payload.merchant_raw).toBe("Spinneys");
  });

  it("rejects a blank merchant", () => {
    const r = buildManualTxnPayload({ ...base, merchant: "   " });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    expect(buildManualTxnPayload({ ...base, amountAed: "0" }).ok).toBe(false);
    expect(buildManualTxnPayload({ ...base, amountAed: "-5" }).ok).toBe(false);
    expect(buildManualTxnPayload({ ...base, amountAed: "abc" }).ok).toBe(false);
  });

  it("rejects a bad direction", () => {
    expect(buildManualTxnPayload({ ...base, direction: "sideways" }).ok).toBe(false);
  });

  it("rejects a malformed date", () => {
    expect(buildManualTxnPayload({ ...base, date: "06/15/2026" }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: FAIL — `buildManualTxnPayload` is not exported.

- [ ] **Step 3: Implement**

Append to `frontend/src/lib/transactions.ts` (add `import { dirhamsToFils } from "./format";` at the top, below the existing `import type { Txn }` line):

```ts
export interface ManualTxnInput {
  merchant: string;
  amountAed: string;
  direction: string;
  date: string; // YYYY-MM-DD
  categoryId: number | null;
}

export interface ManualTxnPayload {
  posted_at: string;
  amount_fils: number;
  currency: string;
  direction: string;
  merchant_raw: string;
  category_id: number;
}

export type BuildResult =
  | { ok: true; payload: ManualTxnPayload }
  | { ok: false; error: string };

/** Validate a manual-entry form and project it onto the POST /api/transactions body. */
export function buildManualTxnPayload(input: ManualTxnInput): BuildResult {
  const merchant = input.merchant.trim();
  if (!merchant) return { ok: false, error: "Enter a merchant or description." };

  const aed = Number(input.amountAed);
  if (!Number.isFinite(aed) || aed <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }
  if (input.direction !== "debit" && input.direction !== "credit") {
    return { ok: false, error: "Choose debit or credit." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, error: "Choose a valid date." };
  }
  return {
    ok: true,
    payload: {
      posted_at: input.date,
      amount_fils: dirhamsToFils(aed),
      currency: "AED",
      direction: input.direction,
      merchant_raw: merchant,
      category_id: input.categoryId ?? 0,
    },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && bunx vitest run src/lib/transactions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/transactions.ts frontend/src/lib/transactions.test.ts
git commit -m "feat(frontend): buildManualTxnPayload form-to-API helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: TransactionRow archive / restore actions

**Files:**
- Modify: `frontend/src/components/transactions/TransactionRow.tsx`
- Test: `frontend/src/components/transactions/TransactionRow.test.tsx` (create)

**Interfaces:**
- Consumes: `Txn` type; lucide icons `Archive`, `ArchiveRestore`, plus existing `ArrowLeftRight`, `X`, `Tag`.
- Produces: `TransactionRow` gains two props — `onArchive: (t: Txn) => void` and `onRestore: (t: Txn) => void`. An archived row shows only a "Restore" button; every other row shows an "Archive" button (and, when `needs_review`, the existing Categorize / Transfer / Ignore buttons).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/transactions/TransactionRow.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TransactionRow } from "./TransactionRow";
import type { Txn } from "../../api/types";

const mk = (over: Partial<Txn>): Txn => ({
  ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit",
  MerchantRaw: "SPINNEYS", Status: "confirmed", Confidence: 0, Source: "email",
  CategoryID: null, CategoryName: "", Bucket: "", ...over,
});

const noop = () => {};

describe("TransactionRow archive actions", () => {
  it("offers Archive on a non-archived row", () => {
    const onArchive = vi.fn();
    render(<TransactionRow txn={mk({})} onOpen={noop} onStatus={noop} onArchive={onArchive} onRestore={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /archive/i }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("offers Restore (and not Archive) on an archived row", () => {
    const onRestore = vi.fn();
    render(<TransactionRow txn={mk({ Status: "archived" })} onOpen={noop} onStatus={noop} onArchive={noop} onRestore={onRestore} />);
    expect(screen.queryByRole("button", { name: /^archive$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: FAIL — `TransactionRow` does not accept `onArchive`/`onRestore` and renders no Archive/Restore buttons (TypeScript/assertion errors).

- [ ] **Step 3: Implement**

Replace the contents of `frontend/src/components/transactions/TransactionRow.tsx` with:

```tsx
// frontend/src/components/transactions/TransactionRow.tsx
import type { Txn } from "../../api/types";
import { Money } from "../Money";
import { Pill } from "../ui/Pill";
import { statusLabel, statusTone } from "../../lib/format";
import { bucketColor } from "../../lib/insights";
import { ArrowLeftRight, X, Tag, Archive, ArchiveRestore } from "lucide-react";

export function TransactionRow({ txn, onOpen, onStatus, onArchive, onRestore }: {
  txn: Txn;
  onOpen: (t: Txn) => void;
  onStatus: (t: Txn, status: string) => void;
  onArchive: (t: Txn) => void;
  onRestore: (t: Txn) => void;
}) {
  const needsReview = txn.Status === "needs_review";
  const archived = txn.Status === "archived";
  const subtitle = [txn.PostedAt.slice(0, 10), txn.CategoryName].filter(Boolean).join(" · ");
  return (
    <div className="py-2.5 flex items-stretch gap-3">
      <span
        aria-hidden
        className="w-1 rounded-full shrink-0"
        style={{ background: txn.Bucket ? bucketColor(txn.Bucket) : "var(--color-border)" }}
      />
      <button className="flex-1 min-w-0 text-left self-center" aria-label={`Open ${txn.MerchantRaw || "transaction"}`} onClick={() => onOpen(txn)}>
        <p className="truncate font-medium">{txn.MerchantRaw || "—"}</p>
        <p className="text-xs text-muted truncate">{subtitle || "Uncategorized"}</p>
      </button>
      <div className="flex flex-col items-end gap-1 self-center">
        <span className="tnum font-medium"><Money fils={txn.Direction === "credit" ? txn.AmountFils : -txn.AmountFils} /></span>
        <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>
      </div>
      <div className="flex flex-col gap-1 self-center">
        {archived ? (
          <button aria-label="Restore" className="p-2 rounded-lg hover:bg-bg text-accent" onClick={() => onRestore(txn)}><ArchiveRestore size={16} /></button>
        ) : (
          <>
            {needsReview && (
              <>
                <button aria-label="Categorize" className="p-2 rounded-lg hover:bg-bg text-accent" onClick={() => onOpen(txn)}><Tag size={16} /></button>
                <button aria-label="Transfer" className="p-2 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "transfer")}><ArrowLeftRight size={16} /></button>
                <button aria-label="Ignore" className="p-2 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "ignored")}><X size={16} /></button>
              </>
            )}
            <button aria-label="Archive" className="p-2 rounded-lg hover:bg-bg text-muted" onClick={() => onArchive(txn)}><Archive size={16} /></button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/TransactionRow.tsx frontend/src/components/transactions/TransactionRow.test.tsx
git commit -m "feat(frontend): per-row archive/restore actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: AddTransactionSheet form component

**Files:**
- Create: `frontend/src/components/transactions/AddTransactionSheet.tsx`
- Test: `frontend/src/components/transactions/AddTransactionSheet.test.tsx`

**Interfaces:**
- Consumes: `Category` type, `Dialog` (`{ title, onClose, children }`), `Button` (`variant`), `buildManualTxnPayload` + `ManualTxnPayload` (Task 7).
- Produces: `AddTransactionSheet` with props `{ categories: Category[]; onSubmit: (payload: ManualTxnPayload) => void; onClose: () => void }`. On Add it validates via `buildManualTxnPayload`; invalid input shows an inline error and does **not** call `onSubmit`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/transactions/AddTransactionSheet.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AddTransactionSheet } from "./AddTransactionSheet";
import type { Category } from "../../api/types";

const cats: Category[] = [{ ID: 3, Name: "Groceries", Kind: "spending", Bucket: "need", IsActive: true }];

describe("AddTransactionSheet", () => {
  it("submits a built payload from valid input", () => {
    const onSubmit = vi.fn();
    render(<AddTransactionSheet categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/merchant/i), { target: { value: "Carrefour" } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "42.50" } });
    fireEvent.change(screen.getByLabelText(/^date$/i), { target: { value: "2026-06-15" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      amount_fils: 4250, direction: "debit", merchant_raw: "Carrefour", posted_at: "2026-06-15",
    }));
  });

  it("shows an error and does not submit when the merchant is blank", () => {
    const onSubmit = vi.fn();
    render(<AddTransactionSheet categories={cats} onSubmit={onSubmit} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/merchant/i);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/components/transactions/AddTransactionSheet.test.tsx`
Expected: FAIL — module `./AddTransactionSheet` does not exist.

- [ ] **Step 3: Implement**

Create `frontend/src/components/transactions/AddTransactionSheet.tsx`:

```tsx
// frontend/src/components/transactions/AddTransactionSheet.tsx
import { useState } from "react";
import type { Category } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { buildManualTxnPayload, type ManualTxnPayload } from "../../lib/transactions";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AddTransactionSheet({ categories, onSubmit, onClose }: {
  categories: Category[];
  onSubmit: (payload: ManualTxnPayload) => void;
  onClose: () => void;
}) {
  const [merchant, setMerchant] = useState("");
  const [amountAed, setAmountAed] = useState("");
  const [direction, setDirection] = useState("debit");
  const [date, setDate] = useState(today());
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [error, setError] = useState("");

  const field = "w-full px-3 py-2 rounded-lg border border-border bg-bg text-sm";

  const submit = () => {
    const res = buildManualTxnPayload({ merchant, amountAed, direction, date, categoryId });
    if (!res.ok) { setError(res.error); return; }
    setError("");
    onSubmit(res.payload);
  };

  return (
    <Dialog title="Add transaction" onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-sm">Merchant
          <input className={field} value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="e.g. Carrefour" />
        </label>
        <label className="block text-sm">Amount (AED)
          <input type="number" min="0" step="0.01" className={field} value={amountAed} onChange={(e) => setAmountAed(e.target.value)} />
        </label>
        <label className="block text-sm">Direction
          <select className={field} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="debit">Debit (money out)</option>
            <option value="credit">Credit (money in)</option>
          </select>
        </label>
        <label className="block text-sm">Date
          <input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="block text-sm">Category (optional)
          <select className={field} value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Uncategorized — send to Needs review</option>
            {categories.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
          </select>
        </label>
        {error && <p role="alert" className="text-bad text-sm">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit}>Add</Button>
      </div>
    </Dialog>
  );
}
```

Note: the test matches the Amount label via `/amount/i` and the Date label via `/^date$/i`. The `<label>` text "Amount (AED)" and "Date" make the associated inputs accessible by those names because the input is nested inside the label.

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && bunx vitest run src/components/transactions/AddTransactionSheet.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/AddTransactionSheet.tsx frontend/src/components/transactions/AddTransactionSheet.test.tsx
git commit -m "feat(frontend): AddTransactionSheet manual-entry form

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Wire archive / restore / add into the Transactions screen

**Files:**
- Modify: `frontend/src/screens/Transactions.tsx`
- Test: `frontend/src/screens/Transactions.test.tsx` (append tests)

**Interfaces:**
- Consumes: `postJSON`, `AddTransactionSheet` (Task 9), `ManualTxnPayload` (Task 7), `TransactionRow` props `onArchive`/`onRestore` (Task 8), lucide `Plus`.
- Produces: the screen gains an "Archived" segment, a `+` Add button that opens `AddTransactionSheet`, and archive/restore handlers wired to each row. Archive shows an Undo toast that calls restore.

- [ ] **Step 1: Write the failing tests**

Append two tests inside the existing `describe("Transactions", ...)` block in `frontend/src/screens/Transactions.test.tsx`:

```ts
  it("opens the Add transaction sheet", async () => {
    wrap();
    await screen.findByText("NETFLIX");
    fireEvent.click(screen.getByRole("button", { name: /add transaction/i }));
    expect(await screen.findByRole("button", { name: /^add$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/merchant/i)).toBeInTheDocument();
  });

  it("archives a row via its Archive action", async () => {
    wrap();
    await screen.findByText("SPINNEYS");
    const calls: string[] = [];
    const realFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    realFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { calls.push(url); return new Response("{}"); }
      if (url.includes("/api/categories")) return new Response(JSON.stringify(cats));
      return new Response(JSON.stringify(all));
    });
    fireEvent.click(screen.getAllByRole("button", { name: /^archive$/i })[0]);
    await screen.findByText(/archived/i); // toast
    expect(calls.some((u) => /\/api\/transactions\/\d+\/archive$/.test(u))).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: FAIL — there is no "Add transaction" button and `TransactionRow` is called without `onArchive`/`onRestore`, so no Archive button renders.

- [ ] **Step 3: Add imports**

In `frontend/src/screens/Transactions.tsx`, update the imports:

```ts
import { AddTransactionSheet } from "../components/transactions/AddTransactionSheet";
import type { ManualTxnPayload } from "../lib/transactions";
import { AlertTriangle, ListOrdered, Search, Zap, Plus } from "lucide-react";
```

(Replace the existing `lucide-react` import line with the one above; add the other two lines near the existing imports.)

- [ ] **Step 4: Add the "Archived" filter option**

Update the `Filter` type and `FILTERS` array:

```ts
type Filter = "all" | "needs_review" | "confirmed" | "archived";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Needs review" },
  { value: "confirmed" as const, label: "Confirmed" },
  { value: "archived" as const, label: "Archived" },
];
```

- [ ] **Step 5: Add state and handlers**

Inside the `Transactions` component, after `const [active, setActive] = useState<Txn | null>(null);` add:

```ts
  const [addOpen, setAddOpen] = useState(false);
```

After the existing `setStatus` function, add:

```ts
  const archive = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/archive`, {});
      invalidate();
      show({
        message: `Archived ${name}`,
        action: {
          label: "Undo",
          onAction: () => {
            void postJSON(`/api/transactions/${t.ID}/restore`, {})
              .then(invalidate)
              .catch(() => show({ message: "Couldn't undo", tone: "error" }));
          },
        },
      });
    } catch { show({ message: `Couldn't archive ${name}`, tone: "error" }); }
  };

  const restore = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/restore`, {});
      invalidate();
      show({ message: `Restored ${name}` });
    } catch { show({ message: `Couldn't restore ${name}`, tone: "error" }); }
  };

  const createTxn = async (payload: ManualTxnPayload) => {
    try {
      await postJSON("/api/transactions", payload);
      setAddOpen(false);
      invalidate();
      show({ message: "Transaction added", tone: "success" });
    } catch { show({ message: "Couldn't add transaction", tone: "error" }); }
  };
```

- [ ] **Step 6: Add the Add button to the header and pass row callbacks**

Replace the header block (the `<div className="flex items-center justify-between gap-2">…</div>` wrapping `SegmentedControl`) with:

```tsx
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        <div className="flex items-center gap-2">
          {filter === "needs_review" && onOpenSwipeMode && (
            <button
              onClick={onOpenSwipeMode}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
            >
              <Zap size={16} /> Swipe
            </button>
          )}
          <button
            onClick={() => setAddOpen(true)}
            aria-label="Add transaction"
            className="flex items-center justify-center p-2 rounded-lg bg-accent text-accent-fg hover:opacity-90 transition-opacity"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
```

Update the `TransactionRow` usage to pass the new callbacks:

```tsx
                <li key={t.ID}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archive} onRestore={restore} /></li>
```

Add the sheet near the bottom, just before the closing `</div>` of the component (after the `CategorizeSheet` block):

```tsx
      {addOpen && (
        <AddTransactionSheet
          categories={cats.data ?? []}
          onSubmit={createTxn}
          onClose={() => setAddOpen(false)}
        />
      )}
```

- [ ] **Step 7: Run to verify pass**

Run: `cd frontend && bunx vitest run src/screens/Transactions.test.tsx`
Expected: PASS (existing 7 tests + 2 new).

- [ ] **Step 8: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/screens/Transactions.tsx frontend/src/screens/Transactions.test.tsx
git commit -m "feat(frontend): archive/restore actions and manual add on Transactions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Rebuild embedded bundle and verify end-to-end

**Files:**
- Modify: `internal/web/dist/**` (regenerated build artifact — committed)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: an embedded PWA bundle matching the frontend source, and a green full build + test run.

- [ ] **Step 1: Build the frontend bundle**

Run: `cd frontend && bun install && bun run build`
Expected: Vite build succeeds; files under `internal/web/dist/` are regenerated.

- [ ] **Step 2: Build the Go binary**

Run: `CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds with no errors (confirms the embedded `dist` and all Go changes compile together).

- [ ] **Step 3: Run the full Go test suite with the race detector**

Run: `go test ./... -race`
Expected: PASS.

- [ ] **Step 4: Run the full frontend test suite**

Run: `cd frontend && bun run test`
Expected: PASS.

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run: `./ledger` (defaults apply with no config), then in the PWA: add a transaction, confirm it appears; archive a transaction, confirm it leaves the default list and the budget total is unchanged by it; switch to the **Archived** filter and restore it.

- [ ] **Step 6: Commit the rebuilt bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for transaction management

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**
- *Archive a transaction (soft-delete, reversible):* Tasks 1 (store), 4 (endpoints), 8 (row action), 10 (screen + Undo). ✓
- *Restore an archived transaction:* Tasks 1, 4, 8, 10, plus the dedicated **Archived** filter (Task 10). ✓
- *Archived rows hidden from lists & budgets:* Task 2 (default-list exclusion) + Task 1 `TestArchiveHidesFromBudget` (budget/insights already filter `confirmed`). ✓
- *Add a transaction manually:* Tasks 3 (store), 5 (endpoint + validation), 7 (form→payload helper), 9 (form), 10 (wiring). ✓
- *No hard delete (soft-delete only, per the agreed scope):* No DELETE path anywhere; "erase" intentionally omitted. ✓
- *Rebuild embedded bundle before finishing:* Task 11. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Every code step shows full code; every validation rule is explicit (amount>0, direction set, merchant non-blank, date format). ✓

**3. Type consistency:**
- `ArchiveTransaction(txID int64) error` / `RestoreTransaction(txID int64) error` — identical in store (Task 1), interface + handlers (Task 4). ✓
- `InsertManualTransaction(store.ManualTxn) (int64, error)` — store (Task 3), interface + handler (Task 5). `ManualTxn` fields (`PostedAt, AmountFils, Currency, Direction, MerchantRaw, CategoryID`) match the handler's construction. ✓
- `buildManualTxnPayload(ManualTxnInput): BuildResult` and `ManualTxnPayload` shape (`posted_at, amount_fils, currency, direction, merchant_raw, category_id`) — defined Task 7, consumed by `AddTransactionSheet` (Task 9) and `createTxn` (Task 10); matches the Go `manualTxnReq` JSON tags in Task 5. ✓
- `TransactionRow` props `onArchive`/`onRestore` — defined Task 8, supplied Task 10. ✓
- `statusLabel("archived")` / `statusTone("archived")` — Task 6, consumed by `TransactionRow` Pill. ✓
