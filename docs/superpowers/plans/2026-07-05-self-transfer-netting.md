# Self-Transfer Netting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Money moved between the user's own accounts nets to zero: both legs get `status='transfer'` (which budget math already excludes), detected by a hardened heuristic (same amount + currency, opposite directions, close timestamps, last-4 discrimination against a user-maintained own-accounts registry), with a retroactive sweep for pairs already in the DB.

**Architecture:** Extends the existing partial implementation rather than replacing it. `internal/store` gains a persisted `last4` column, an own-accounts registry over the (currently unused) `accounts` table, a hardened `FindTransferMatch`, and a retroactive `NetTransferPairs` sweep. `internal/parse.Processor` fixes a leg-arrival-order bug. `internal/server` gains `/api/accounts` CRUD and `POST /api/transfers/sweep`. The frontend gains one settings drill-in page ("Accounts & transfers") for the registry and a sweep button.

**Tech Stack:** Go (stdlib net/http, modernc.org/sqlite), React 18 + TypeScript + TanStack Query, vitest + jsdom, Go table tests beside code.

## Global Constraints

- Money is integer minor units: always `int64` fils; never floats for money (spec §2).
- Budget spend counts only `status='confirmed'` debits of `spending` categories; `transfer` status is excluded by construction — do not add special-casing to budget math (spec §6.5).
- Amounts in `transactions.amount` are always positive; `direction` is `'debit'|'credit'`.
- Schema changes are additive only: `CREATE TABLE IF NOT EXISTS` in `schema.sql` (fresh DBs) **plus** `addColumnIfMissing` in `store.go` `migrate()` (existing DBs). No migration tool.
- Nothing is silently destroyed: netting only changes `status`; a wrong auto-mark is reversible from the Transactions screen (mark confirmed/needs_review).
- The frontend builds to `internal/web/dist/` which Go embeds; rebuild the combined dist before finishing (CLAUDE.md).
- Frontend vitest stays single-fork (`fileParallelism: false`, `singleFork`) — do not parallelize.
- Frontend API calls use relative URLs via the helpers in `frontend/src/api/client.ts`.

## Existing behavior you are building on (verified 2026-07-05)

- `parse.ParsedTxn` has `Last4` and `IsTransfer`; DIB/AI parsers fill `Last4`; ENBD transfer emails set `IsTransfer`.
- `parse/processor.go:70-102`: `IsTransfer` ⇒ insert with `status='transfer'`; after insert of a non-transfer row, `FindTransferMatch(…, 2h)` pairs and marks both legs.
- `store/transactions.go:234`: `FindTransferMatch` matches amount + opposite direction + window only (no currency, no last4), excludes `transfer`/`archived` candidates.
- `server/transactions.go:187-192`: manual `POST /api/transactions/{id}/status` already accepts `"transfer"`; the UI has a one-tap transfer button.
- `store/budget.go SelectMonthSpend`: `WHERE t.status='confirmed'` — transfers already excluded.
- The `accounts` table exists in `schema.sql` but **no code reads or writes it**.
- `transactions` has **no** `last4` column — `TransactionRow.Last4` only feeds the fingerprint.

## Heuristic decisions (locked in)

- **Currency equality is required** for a pair (native `amount` compare; cross-currency transfers are out of scope).
- **Same-last4 opposite pair is never a transfer** — that's the refund/reversal shape (spec §6.4 handles refunds separately). Rejected when *both* legs have a last4 and they're equal.
- **Own-accounts registry tightens matching when configured:** if the registry is non-empty and both legs have last4s, both must be registered own accounts. An empty registry, or a leg with no last4 (old rows, CSV imports), never blocks a match — preserves today's behavior until the user opts in.
- **Nettable statuses** are `needs_review`, `low_confidence`, `confirmed`. `ignored` rows are no longer eligible candidates (a deliberate user decision shouldn't be silently rewritten; both states are budget-excluded anyway). `transfer` and `archived` stay excluded.
- **Live matching window stays 2 hours.** The sweep accepts an optional window (default 2h, max 48h) for imported rows whose timestamps are date-only.
- **The sweep is user-initiated only** (Settings button / API). It is *not* auto-run on import: imported rows have no last4, so the heuristic is weakest exactly there — the user triggers it and reviews the result.

## File structure

| File | Responsibility |
|---|---|
| `internal/store/schema.sql` (modify) | `last4` column on `transactions` for fresh DBs |
| `internal/store/store.go` (modify) | `addColumnIfMissing` migration for `last4` |
| `internal/store/transactions.go` (modify) | persist `last4`; `TransferLeg` + hardened `FindTransferMatch`; `transferLast4Compatible` predicate; `NetTransferPairs` sweep |
| `internal/store/accounts.go` (create) | own-accounts CRUD + `OwnAccountLast4s()` set |
| `internal/store/accounts_test.go` (create) | registry tests |
| `internal/store/transactions_test.go` (modify) | last4 persistence, predicate, match-hardening, sweep tests |
| `internal/store/budget_test.go` (modify) | regression: transfer legs net to zero in month spend |
| `internal/parse/processor.go` (modify) | leg-order fix + new `FindTransferMatch` signature |
| `internal/parse/processor_test.go` (modify) | IsTransfer-leg-arrives-second test |
| `internal/server/accounts.go` (create) | `GET/POST /api/accounts`, `DELETE /api/accounts/{id}` |
| `internal/server/accounts_test.go` (create) | handler tests |
| `internal/server/transfers.go` (create) | `POST /api/transfers/sweep` |
| `internal/server/transfers_test.go` (create) | sweep handler test |
| `internal/server/server.go` (modify) | struct fields + routes |
| `cmd/ledger/main.go` (modify) | `SetAccountsStore` / `SetTransfersStore` wiring |
| `frontend/src/api/types.ts` (modify) | `Account`, `SweepResult` |
| `frontend/src/api/client.ts` (modify) | `getAccounts`, `createAccount`, `deleteAccount`, `sweepTransfers` |
| `frontend/src/screens/settings/AccountsPage.tsx` (create) | registry UI + sweep button |
| `frontend/src/screens/settings/SettingsHub.tsx` (modify) | page id + hub row |
| `frontend/src/screens/Settings.tsx` (modify) | drill-in dispatch |
| `frontend/src/screens/Settings.accounts.test.tsx` (create) | page tests |

---

### Task 1: Persist `last4` on transactions

**Files:**
- Modify: `internal/store/schema.sql` (transactions CREATE TABLE)
- Modify: `internal/store/store.go:86-88` (migrate)
- Modify: `internal/store/transactions.go:54-61` (InsertTransaction)
- Test: `internal/store/transactions_test.go`

**Interfaces:**
- Consumes: existing `TransactionRow.Last4` (already populated by parsers via `processor.go`).
- Produces: `transactions.last4 TEXT` column (NULL for pre-existing/imported rows), written by `InsertTransaction`. Later tasks read it with `COALESCE(last4,'')`.

- [ ] **Step 1: Write the failing test**

Append to `internal/store/transactions_test.go`:

```go
// TestInsertTransactionPersistsLast4 verifies the account last-4 captured at
// parse time survives into the transactions row (transfer matching reads it).
func TestInsertTransactionPersistsLast4(t *testing.T) {
	st := newTestStore(t)
	id, created, err := st.InsertTransaction(TransactionRow{
		PostedAt:    time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC),
		AmountFils:  12345,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "LAST4 TEST",
		Last4:       "1234",
		Status:      "needs_review",
	})
	if err != nil || !created {
		t.Fatalf("insert: created=%v err=%v", created, err)
	}
	var got string
	if err := st.DB.QueryRow(`SELECT COALESCE(last4,'') FROM transactions WHERE id=?`, id).Scan(&got); err != nil {
		t.Fatalf("select last4: %v", err)
	}
	if got != "1234" {
		t.Errorf("last4 = %q, want %q", got, "1234")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/store/ -run TestInsertTransactionPersistsLast4 -v`
Expected: FAIL — `last4 = "", want "1234"` (column missing → SQL error `no such column: last4`, also acceptable).

- [ ] **Step 3: Add the column (fresh + existing DBs)**

In `internal/store/schema.sql`, inside `CREATE TABLE IF NOT EXISTS transactions`, after the `description` line add:

```sql
  last4           TEXT,                         -- account last-4 from the bank email; used by self-transfer matching
```

In `internal/store/store.go`, replace the end of `migrate`:

```go
	// Days of mailbox silence before /api/health reports mail_silent.
	return addColumnIfMissing(db, "app_settings", "ingest_silence_days", "INTEGER NOT NULL DEFAULT 3")
```

with:

```go
	// Days of mailbox silence before /api/health reports mail_silent.
	if err := addColumnIfMissing(db, "app_settings", "ingest_silence_days", "INTEGER NOT NULL DEFAULT 3"); err != nil {
		return err
	}
	// Account last-4 captured at parse time; used by self-transfer matching.
	return addColumnIfMissing(db, "transactions", "last4", "TEXT")
```

- [ ] **Step 4: Write it in InsertTransaction**

In `internal/store/transactions.go`, change the INSERT in `InsertTransaction` to:

```go
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, last4, status, confidence,
		    fingerprint, source, ingest_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, amountAED, r.Currency, r.Direction,
		r.MerchantRaw, nullable(r.Last4), r.Status, r.Confidence, r.Fingerprint(), source, nullableID(r.IngestID), now, now,
	)
```

(`nullable` already exists in this file at line 138.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/store/ -v -run TestInsertTransaction`
Expected: PASS. Then run the whole package: `go test ./internal/store/` — PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/store/schema.sql internal/store/store.go internal/store/transactions.go internal/store/transactions_test.go
git commit -m "feat(store): persist account last4 on transactions"
```

---

### Task 2: Own-accounts registry (store + /api/accounts)

**Files:**
- Create: `internal/store/accounts.go`
- Create: `internal/store/accounts_test.go`
- Create: `internal/server/accounts.go`
- Create: `internal/server/accounts_test.go`
- Modify: `internal/server/server.go` (struct field ~line 94, routes ~line 175)
- Modify: `cmd/ledger/main.go` (next to `srv.SetRatesStore(st)` at line 158)

**Interfaces:**
- Consumes: the existing (empty, unused) `accounts` table from `schema.sql`; server wiring pattern `SetRatesStore` / `RatesStore` interface (`internal/server/rates.go`).
- Produces:
  - `store.Account{ID int64; Name, Bank, Last4, Currency string; IsActive bool}`
  - `(*Store) SelectAccounts() ([]Account, error)`
  - `(*Store) InsertAccount(name, bank, last4 string) (int64, error)`
  - `(*Store) DeleteAccount(id int64) error`
  - `(*Store) OwnAccountLast4s() (map[string]bool, error)` — **Task 3 and 4 call this**
  - HTTP: `GET /api/accounts` → `[{id,name,bank,last4}]`; `POST /api/accounts` `{name,bank?,last4}` → 201 `{id}`; `DELETE /api/accounts/{id}` → `{ok:true}`
  - `(*Server) SetAccountsStore(AccountsStore)`

- [ ] **Step 1: Write the failing store test**

Create `internal/store/accounts_test.go`:

```go
package store

import "testing"

func TestAccountsCRUDAndOwnLast4s(t *testing.T) {
	st := newTestStore(t)

	id1, err := st.InsertAccount("DIB Current", "DIB", "1234")
	if err != nil {
		t.Fatalf("insert 1: %v", err)
	}
	if _, err := st.InsertAccount("ENBD Savings", "ENBD", "5678"); err != nil {
		t.Fatalf("insert 2: %v", err)
	}

	accs, err := st.SelectAccounts()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(accs) != 2 {
		t.Fatalf("len(accounts) = %d, want 2", len(accs))
	}
	if accs[0].Name != "DIB Current" || accs[0].Last4 != "1234" || accs[0].Bank != "DIB" {
		t.Errorf("first account = %+v", accs[0])
	}

	own, err := st.OwnAccountLast4s()
	if err != nil {
		t.Fatalf("own last4s: %v", err)
	}
	if !own["1234"] || !own["5678"] || len(own) != 2 {
		t.Errorf("own set = %v, want {1234,5678}", own)
	}

	if err := st.DeleteAccount(id1); err != nil {
		t.Fatalf("delete: %v", err)
	}
	accs, _ = st.SelectAccounts()
	if len(accs) != 1 || accs[0].Last4 != "5678" {
		t.Errorf("after delete accounts = %+v, want only 5678", accs)
	}
}

func TestOwnAccountLast4sEmptyRegistry(t *testing.T) {
	st := newTestStore(t)
	own, err := st.OwnAccountLast4s()
	if err != nil {
		t.Fatalf("own last4s: %v", err)
	}
	if len(own) != 0 {
		t.Errorf("own set = %v, want empty", own)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `go test ./internal/store/ -run TestAccounts -v`
Expected: FAIL to compile — `st.InsertAccount undefined`.

- [ ] **Step 3: Implement the store layer**

Create `internal/store/accounts.go`:

```go
package store

// Account is one of the user's own bank accounts (the accounts table). The
// registry exists so self-transfer matching can recognize "both legs are my
// accounts"; nothing else references it yet.
type Account struct {
	ID       int64
	Name     string
	Bank     string
	Last4    string
	Currency string
	IsActive bool
}

// SelectAccounts returns all accounts, insertion order.
func (s *Store) SelectAccounts() ([]Account, error) {
	rows, err := s.DB.Query(
		`SELECT id, name, bank, COALESCE(last4,''), currency, is_active FROM accounts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		var a Account
		var active int
		if err := rows.Scan(&a.ID, &a.Name, &a.Bank, &a.Last4, &a.Currency, &active); err != nil {
			return nil, err
		}
		a.IsActive = active == 1
		out = append(out, a)
	}
	return out, rows.Err()
}

// InsertAccount registers an own account. Validation (non-empty name, 4-digit
// last4) is the API layer's job; the store persists what it's given.
func (s *Store) InsertAccount(name, bank, last4 string) (int64, error) {
	res, err := s.DB.Exec(
		`INSERT INTO accounts (name, bank, last4, currency, is_active) VALUES (?, ?, ?, 'AED', 1)`,
		name, bank, last4)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// DeleteAccount removes an account. Hard delete: transactions.account_id is
// never populated, so no row can reference it.
func (s *Store) DeleteAccount(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM accounts WHERE id=?`, id)
	return err
}

// OwnAccountLast4s returns the set of last-4s of active accounts. An empty set
// means "registry unconfigured" and transfer matching must not tighten on it.
func (s *Store) OwnAccountLast4s() (map[string]bool, error) {
	rows, err := s.DB.Query(
		`SELECT last4 FROM accounts WHERE is_active=1 AND last4 IS NOT NULL AND last4 != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	own := make(map[string]bool)
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			return nil, err
		}
		own[l] = true
	}
	return own, rows.Err()
}
```

- [ ] **Step 4: Run store tests**

Run: `go test ./internal/store/ -run "TestAccounts|TestOwnAccount" -v`
Expected: PASS.

- [ ] **Step 5: Write the failing server test**

Create `internal/server/accounts_test.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ledger/internal/store"
)

func newAccountsServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetAccountsStore(st)
	return srv, st
}

func TestAccountsCreateListDelete(t *testing.T) {
	srv, _ := newAccountsServer(t)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/accounts",
		strings.NewReader(`{"name":"DIB Current","bank":"DIB","last4":"1234"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create code=%d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == 0 {
		t.Fatalf("create body=%s err=%v", rec.Body.String(), err)
	}

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list code=%d", rec.Code)
	}
	var got []struct {
		ID    int64  `json:"id"`
		Name  string `json:"name"`
		Last4 string `json:"last4"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, rec.Body.String())
	}
	if len(got) != 1 || got[0].Name != "DIB Current" || got[0].Last4 != "1234" {
		t.Fatalf("list = %+v", got)
	}

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/accounts/1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete code=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))
	if body := strings.TrimSpace(rec.Body.String()); body != "[]" {
		t.Errorf("after delete list = %s, want []", body)
	}
}

func TestAccountsCreateValidation(t *testing.T) {
	srv, _ := newAccountsServer(t)
	for _, body := range []string{
		`{"name":"","last4":"1234"}`,   // empty name
		`{"name":"X","last4":"12"}`,    // short last4
		`{"name":"X","last4":"12ab"}`,  // non-digit last4
	} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/accounts", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: code=%d, want 400", body, rec.Code)
		}
	}
}

func TestAccountsUnavailableWithoutStore(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st) // no SetAccountsStore
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("code=%d, want 503", rec.Code)
	}
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `go test ./internal/server/ -run TestAccounts -v`
Expected: FAIL to compile — `srv.SetAccountsStore undefined`.

- [ ] **Step 7: Implement the handlers**

Create `internal/server/accounts.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"ledger/internal/store"
)

// AccountsStore is the own-account registry surface /api/accounts needs.
type AccountsStore interface {
	SelectAccounts() ([]store.Account, error)
	InsertAccount(name, bank, last4 string) (int64, error)
	DeleteAccount(id int64) error
}

// SetAccountsStore wires the accounts store. Required for /api/accounts.
func (s *Server) SetAccountsStore(as AccountsStore) { s.accountsStore = as }

var last4Re = regexp.MustCompile(`^[0-9]{4}$`)

type accountDTO struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Bank  string `json:"bank"`
	Last4 string `json:"last4"`
}

func (s *Server) handleGetAccounts(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	accs, err := s.accountsStore.SelectAccounts()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	out := []accountDTO{}
	for _, a := range accs {
		out = append(out, accountDTO{ID: a.ID, Name: a.Name, Bank: a.Bank, Last4: a.Last4})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handlePostAccount(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Name  string `json:"name"`
		Bank  string `json:"bank"`
		Last4 string `json:"last4"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
		return
	}
	if !last4Re.MatchString(req.Last4) {
		http.Error(w, `{"error":"last4 must be exactly 4 digits"}`, http.StatusBadRequest)
		return
	}
	id, err := s.accountsStore.InsertAccount(req.Name, strings.TrimSpace(req.Bank), req.Last4)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id})
}

func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	if err := s.accountsStore.DeleteAccount(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
```

In `internal/server/server.go`, add the struct field after `ratesStore      RatesStore`:

```go
	accountsStore   AccountsStore
```

and add routes next to the rates routes (after the `DELETE /api/rates/{currency}` line):

```go
	s.mux.HandleFunc("GET /api/accounts", s.handleGetAccounts)
	s.mux.HandleFunc("POST /api/accounts", s.handlePostAccount)
	s.mux.HandleFunc("DELETE /api/accounts/{id}", s.handleDeleteAccount)
```

- [ ] **Step 8: Wire it in main.go**

In `cmd/ledger/main.go`, directly after `srv.SetRatesStore(st)` (line 158):

```go
	srv.SetAccountsStore(st)
```

- [ ] **Step 9: Run tests**

Run: `go test ./internal/server/ -run TestAccounts -v && go build ./...`
Expected: all PASS, build clean.

- [ ] **Step 10: Commit**

```bash
git add internal/store/accounts.go internal/store/accounts_test.go internal/server/accounts.go internal/server/accounts_test.go internal/server/server.go cmd/ledger/main.go
git commit -m "feat(accounts): own-account registry (store + /api/accounts)"
```

---

### Task 3: Harden transfer matching + fix leg-arrival-order bug

**Files:**
- Modify: `internal/store/transactions.go:231-263` (replace `FindTransferMatch`)
- Modify: `internal/store/transactions_test.go` (update existing call site in `TestFindTransferMatchSkipsArchived:365`; add new tests)
- Modify: `internal/store/budget_test.go` (net-to-zero regression test)
- Modify: `internal/parse/processor.go:94-102` (leg-order fix, new signature)
- Modify: `internal/parse/processor_test.go` (IsTransfer-arrives-second test)

**Interfaces:**
- Consumes: `OwnAccountLast4s()` from Task 2; persisted `last4` from Task 1; existing `UpdateTransactionStatus(txID int64, status string) error`.
- Produces:
  - `store.TransferLeg{TxID, AmountFils int64; Currency, Direction, Last4 string; PostedAt time.Time}`
  - `(*Store) FindTransferMatch(leg TransferLeg, window time.Duration) (int64, bool, error)` — **replaces** the old 5-arg signature; Task 4's sweep reuses the same predicate.
  - unexported `transferLast4Compatible(a, b string, own map[string]bool) bool` (same file; sweep in Task 4 calls it).

- [ ] **Step 1: Write the failing store tests**

Append to `internal/store/transactions_test.go`. A shared seeding helper first:

```go
// seedTxn inserts a minimal transaction for transfer-matching tests and
// returns its id.
func seedTxn(t *testing.T, st *Store, amount int64, currency, direction, last4, status string, at time.Time) int64 {
	t.Helper()
	id, created, err := st.InsertTransaction(TransactionRow{
		PostedAt:    at,
		AmountFils:  amount,
		Currency:    currency,
		Direction:   direction,
		MerchantRaw: "SEED " + direction + " " + last4 + " " + at.Format(time.RFC3339),
		Last4:       last4,
		Status:      status,
	})
	if err != nil || !created {
		t.Fatalf("seedTxn: created=%v err=%v", created, err)
	}
	return id
}

func TestFindTransferMatchRequiresSameCurrency(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	seedTxn(t, st, 10000, "USD", "credit", "", "needs_review", base)
	debitID := seedTxn(t, st, 10000, "AED", "debit", "", "needs_review", base.Add(5*time.Minute))

	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 10000, Currency: "AED", Direction: "debit",
		PostedAt: base.Add(5 * time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("matched across currencies: AED debit must not pair with USD credit")
	}
}

func TestFindTransferMatchRejectsSameLast4(t *testing.T) {
	// Same account, opposite directions = refund/reversal, never a transfer.
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	seedTxn(t, st, 25000, "AED", "credit", "1234", "needs_review", base)
	debitID := seedTxn(t, st, 25000, "AED", "debit", "1234", "needs_review", base.Add(10*time.Minute))

	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 25000, Currency: "AED", Direction: "debit",
		Last4: "1234", PostedAt: base.Add(10 * time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("same-last4 opposite pair matched — refund shape must be rejected")
	}
}

func TestFindTransferMatchOwnAccountGating(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

	// Registry configured with two own accounts.
	if _, err := st.InsertAccount("A", "DIB", "1111"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertAccount("B", "ENBD", "2222"); err != nil {
		t.Fatal(err)
	}

	// Counterpart credit on a NON-registered account: must not match.
	seedTxn(t, st, 50000, "AED", "credit", "9999", "needs_review", base)
	d1 := seedTxn(t, st, 50000, "AED", "debit", "1111", "needs_review", base.Add(time.Minute))
	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: d1, AmountFils: 50000, Currency: "AED", Direction: "debit",
		Last4: "1111", PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("matched a leg on an unregistered account while registry is configured")
	}

	// Counterpart on the other registered account: must match.
	c2 := seedTxn(t, st, 70000, "AED", "credit", "2222", "needs_review", base)
	d2 := seedTxn(t, st, 70000, "AED", "debit", "1111", "needs_review", base.Add(time.Minute))
	matchID, found, err := st.FindTransferMatch(TransferLeg{
		TxID: d2, AmountFils: 70000, Currency: "AED", Direction: "debit",
		Last4: "1111", PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !found || matchID != c2 {
		t.Errorf("match = (%d,%v), want (%d,true)", matchID, found, c2)
	}
}

func TestFindTransferMatchAllowsMissingLast4(t *testing.T) {
	// Old rows and CSV imports have no last4; they must still be matchable.
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	credID := seedTxn(t, st, 30000, "AED", "credit", "", "needs_review", base)
	debitID := seedTxn(t, st, 30000, "AED", "debit", "1234", "needs_review", base.Add(time.Minute))

	matchID, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 30000, Currency: "AED", Direction: "debit",
		Last4: "1234", PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !found || matchID != credID {
		t.Errorf("match = (%d,%v), want (%d,true)", matchID, found, credID)
	}
}

func TestFindTransferMatchSkipsIgnored(t *testing.T) {
	// A row the user explicitly ignored must not be silently rewritten.
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	seedTxn(t, st, 40000, "AED", "credit", "", "ignored", base)
	debitID := seedTxn(t, st, 40000, "AED", "debit", "", "needs_review", base.Add(time.Minute))

	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 40000, Currency: "AED", Direction: "debit",
		PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("ignored row was offered as a transfer leg")
	}
}
```

Also update the **existing** `TestFindTransferMatchSkipsArchived` (line ~365) to the new signature — replace:

```go
	matchID, found, err := st.FindTransferMatch(callerID, amount, "debit", base.Add(10*time.Minute), time.Hour)
```

with:

```go
	matchID, found, err := st.FindTransferMatch(TransferLeg{
		TxID: callerID, AmountFils: amount, Currency: "AED", Direction: "debit",
		Last4: "8888", PostedAt: base.Add(10 * time.Minute),
	}, time.Hour)
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/store/ -run TestFindTransferMatch -v`
Expected: FAIL to compile (`TransferLeg` undefined).

- [ ] **Step 3: Implement the hardened match**

In `internal/store/transactions.go`, replace the whole `FindTransferMatch` function (lines 231–263) with:

```go
// TransferLeg is one side of a potential self-transfer, used to search for its
// counterpart.
type TransferLeg struct {
	TxID       int64
	AmountFils int64
	Currency   string
	Direction  string
	Last4      string
	PostedAt   time.Time
}

// transferLast4Compatible applies the last-4 heuristics for pairing two legs.
// A same-account opposite pair is a refund/reversal, never a transfer. When the
// own-accounts registry is configured (non-empty own set) and both last4s are
// known, both must be registered own accounts. A missing last4 (old rows, CSV
// imports) never blocks a match.
func transferLast4Compatible(a, b string, own map[string]bool) bool {
	if a == "" || b == "" {
		return true
	}
	if a == b {
		return false
	}
	if len(own) > 0 && (!own[a] || !own[b]) {
		return false
	}
	return true
}

// FindTransferMatch looks for the other leg of a self-transfer: same amount and
// currency, opposite direction, within `window` of the leg, still in a nettable
// status (needs_review / low_confidence / confirmed), and last4-compatible.
// Returns the closest-in-time hit. Ignored, archived and already-netted rows
// are never candidates.
func (s *Store) FindTransferMatch(leg TransferLeg, window time.Duration) (int64, bool, error) {
	own, err := s.OwnAccountLast4s()
	if err != nil {
		return 0, false, err
	}
	opp := "credit"
	if leg.Direction == "credit" {
		opp = "debit"
	}
	start := leg.PostedAt.Add(-window).UTC().Format(time.RFC3339Nano)
	end := leg.PostedAt.Add(window).UTC().Format(time.RFC3339Nano)
	postedStr := leg.PostedAt.UTC().Format(time.RFC3339Nano)

	rows, err := s.DB.Query(`
		SELECT id, COALESCE(last4,'') FROM transactions
		 WHERE id != ?
		   AND amount = ?
		   AND currency = ?
		   AND direction = ?
		   AND posted_at >= ?
		   AND posted_at <= ?
		   AND status IN ('needs_review','low_confidence','confirmed')
		 ORDER BY ABS(CAST((julianday(posted_at) - julianday(?)) * 86400 AS INTEGER))
	`, leg.TxID, leg.AmountFils, leg.Currency, opp, start, end, postedStr)
	if err != nil {
		return 0, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var last4 string
		if err := rows.Scan(&id, &last4); err != nil {
			return 0, false, err
		}
		if transferLast4Compatible(leg.Last4, last4, own) {
			return id, true, nil
		}
	}
	return 0, false, rows.Err()
}
```

(The `database/sql` import's `sql.ErrNoRows` may now be unused in this file — check and drop the import only if nothing else uses it; `InsertManualTransaction` and others may still need it.)

- [ ] **Step 4: Update the processor call site and fix leg order**

In `internal/parse/processor.go`, replace lines 94–102:

```go
			// Auto-match opposite transfer leg within 2 hours.
			if txStatus != "transfer" {
				if matchID, found, _ := p.store.FindTransferMatch(
					txID, res.Txn.AmountFils, res.Txn.Direction, res.Txn.PostedAt, 2*time.Hour,
				); found {
					_ = p.store.UpdateTransactionStatus(txID, "transfer")
					_ = p.store.UpdateTransactionStatus(matchID, "transfer")
				}
			}
```

with:

```go
			// Net the opposite transfer leg within 2 hours — regardless of which
			// leg arrived first. A parser-flagged transfer (IsTransfer) still has
			// to find and mark its counterpart, or the credit leg lingers in review.
			if matchID, found, _ := p.store.FindTransferMatch(store.TransferLeg{
				TxID:       txID,
				AmountFils: res.Txn.AmountFils,
				Currency:   res.Txn.Currency,
				Direction:  res.Txn.Direction,
				Last4:      res.Txn.Last4,
				PostedAt:   res.Txn.PostedAt,
			}, 2*time.Hour); found {
				_ = p.store.UpdateTransactionStatus(txID, "transfer")
				_ = p.store.UpdateTransactionStatus(matchID, "transfer")
			}
```

- [ ] **Step 5: Write the leg-order processor test**

Append to `internal/parse/processor_test.go` (reuses the existing `stubTransferParser`, `procTestStore`, and the cascade construction pattern from `TestProcessorSetsTransferStatusFromIsTransfer` / `TestProcessorCrossMatchTransfer` — copy how those build a cascade containing `stubTransferParser`):

```go
// TestProcessorIsTransferLegArrivingSecondNetsCounterpart covers the arrival
// order the old guard missed: the credit leg is already in the DB as
// needs_review, then the parser-flagged (IsTransfer) debit leg arrives. Both
// must end up status=transfer.
func TestProcessorIsTransferLegArrivingSecondNetsCounterpart(t *testing.T) {
	st := procTestStore(t)

	// Pre-existing credit leg (e.g. the receiving account's email parsed first).
	// stubTransferParser emits: 2025-08-19 00:00 UTC, 10000 fils, AED, debit.
	if _, created, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 0, 30, 0, 0, time.UTC),
		AmountFils:  10000,
		Currency:    "AED",
		Direction:   "credit",
		MerchantRaw: "Incoming Transfer",
		Status:      "needs_review",
	}); err != nil || !created {
		t.Fatalf("seed credit leg: created=%v err=%v", created, err)
	}

	// Now the IsTransfer debit email arrives.
	cascade := &Cascade{
		Parsers:   []BankParser{stubTransferParser{}},
		Heuristic: HeuristicParser{},
		AI:        DisabledExtractor{},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "istransfer-second",
		FromAddr:    "stub@bank.com",
		Subject:     "transfer",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: stub@bank.com\r\nSubject: transfer\r\n\r\ntransfer"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, cascade)
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status='transfer'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("transfer-status count = %d, want 2 (IsTransfer leg arriving second must net its counterpart)", count)
	}
}
```

> The `&Cascade{...}` struct literal above is copied from the existing `TestProcessorSetsTransferStatusFromIsTransfer` (`processor_test.go:162`); `stubTransferParser` and `procTestStore` are already defined in that file.

- [ ] **Step 6: Write the budget net-to-zero regression test**

Append to `internal/store/budget_test.go` (mirror the file's existing seeding style; the essential assertions are below):

```go
// TestMonthSpendExcludesTransferLegs is the spec's "a self-transfer nets to
// zero" check at the store layer: a categorized debit that got netted as a
// transfer must not appear in month spend.
func TestMonthSpendExcludesTransferLegs(t *testing.T) {
	st := newTestStore(t)
	catID, err := st.InsertCategory(CategoryRow{Name: "Transfer Test Cat", Kind: "spending", Bucket: "need", IsActive: true})
	if err != nil {
		t.Fatal(err)
	}

	mk := func(direction, status string, at time.Time) {
		id, created, err := st.InsertTransaction(TransactionRow{
			PostedAt: at, AmountFils: 100000, Currency: "AED", Direction: direction,
			MerchantRaw: "NET " + direction + " " + status, Status: "needs_review",
		})
		if err != nil || !created {
			t.Fatalf("insert: created=%v err=%v", created, err)
		}
		if err := st.UpdateTransactionCategory(id, catID, status); err != nil {
			t.Fatal(err)
		}
	}
	at := time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
	mk("debit", "confirmed", at)              // real spend: counts
	mk("debit", "transfer", at.Add(time.Hour)) // netted leg: must not count

	rows, err := st.SelectMonthSpend("2026-07", false)
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, r := range rows {
		if r.Direction == "debit" {
			total += r.AmountFils
		}
	}
	if total != 100000 {
		t.Errorf("month spend = %d fils, want 100000 (transfer leg leaked into spend)", total)
	}
}
```

> If `budget_test.go` has no `newTestStore` in scope it shares the package with `transactions_test.go`, so the helper is available; `CategoryRow` / `InsertCategory` / `UpdateTransactionCategory` all exist in `internal/store/categories.go`.

- [ ] **Step 7: Run everything**

Run: `go test ./internal/store/ ./internal/parse/ -v -run "TransferMatch|Transfer|MonthSpendExcludes"`
Expected: all PASS (including the pre-existing `TestProcessorCrossMatchTransfer` and `TestFindTransferMatchSkipsArchived`).

Then the full suite: `go test ./...`
Expected: PASS (known exception per project memory: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set in the sandbox — not caused by this change).

- [ ] **Step 8: Commit**

```bash
git add internal/store/transactions.go internal/store/transactions_test.go internal/store/budget_test.go internal/parse/processor.go internal/parse/processor_test.go
git commit -m "feat(transfers): currency + last4-aware matching, net either arrival order"
```

---

### Task 4: Retroactive sweep — `NetTransferPairs` + `POST /api/transfers/sweep`

**Files:**
- Modify: `internal/store/transactions.go` (append `NetTransferPairs`)
- Modify: `internal/store/transactions_test.go`
- Create: `internal/server/transfers.go`
- Create: `internal/server/transfers_test.go`
- Modify: `internal/server/server.go` (field + route)
- Modify: `cmd/ledger/main.go` (wiring)

**Interfaces:**
- Consumes: `transferLast4Compatible` and `OwnAccountLast4s()` (Task 2/3), `UpdateTransactionStatus`.
- Produces:
  - `(*Store) NetTransferPairs(window time.Duration) (int, error)` — returns count of transactions marked (2 per pair).
  - HTTP `POST /api/transfers/sweep` body `{"window_hours": 2}` (optional; default 2, max 48) → `{"marked": n}`; broadcasts SSE `tx` when n > 0.
  - `(*Server) SetTransfersStore(TransfersStore)`.

- [ ] **Step 1: Write the failing store test**

Append to `internal/store/transactions_test.go`:

```go
func TestNetTransferPairs(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 6, 15, 9, 0, 0, 0, time.UTC)

	// A genuine pair, already confirmed (historical pollution).
	d1 := seedTxn(t, st, 150000, "AED", "debit", "1111", "confirmed", base)
	c1 := seedTxn(t, st, 150000, "AED", "credit", "2222", "confirmed", base.Add(20*time.Minute))
	// A refund shape: same account both sides — must NOT be netted.
	r1 := seedTxn(t, st, 8000, "AED", "debit", "3333", "confirmed", base)
	r2 := seedTxn(t, st, 8000, "AED", "credit", "3333", "confirmed", base.Add(10*time.Minute))
	// A lone debit with no counterpart — must stay untouched.
	lone := seedTxn(t, st, 999999, "AED", "debit", "1111", "confirmed", base)

	marked, err := st.NetTransferPairs(2 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if marked != 2 {
		t.Errorf("marked = %d, want 2", marked)
	}
	status := func(id int64) string {
		var s string
		if err := st.DB.QueryRow(`SELECT status FROM transactions WHERE id=?`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if status(d1) != "transfer" || status(c1) != "transfer" {
		t.Errorf("pair statuses = %s/%s, want transfer/transfer", status(d1), status(c1))
	}
	if status(r1) != "confirmed" || status(r2) != "confirmed" {
		t.Errorf("refund pair rewritten: %s/%s, want confirmed/confirmed", status(r1), status(r2))
	}
	if status(lone) != "confirmed" {
		t.Errorf("lone debit rewritten to %s", status(lone))
	}
}

func TestNetTransferPairsEachLegUsedOnce(t *testing.T) {
	// Two debits, one credit at the same amount: only one debit pairs.
	st := newTestStore(t)
	base := time.Date(2026, 6, 15, 9, 0, 0, 0, time.UTC)
	seedTxn(t, st, 50000, "AED", "debit", "", "needs_review", base)
	seedTxn(t, st, 50000, "AED", "debit", "", "needs_review", base.Add(5*time.Minute))
	seedTxn(t, st, 50000, "AED", "credit", "", "needs_review", base.Add(2*time.Minute))

	marked, err := st.NetTransferPairs(2 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if marked != 2 {
		t.Errorf("marked = %d, want 2 (one pair, credit used once)", marked)
	}
	var transfers int
	st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status='transfer'`).Scan(&transfers)
	if transfers != 2 {
		t.Errorf("transfer rows = %d, want 2", transfers)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `go test ./internal/store/ -run TestNetTransferPairs -v`
Expected: FAIL to compile — `st.NetTransferPairs undefined`.

- [ ] **Step 3: Implement the sweep**

Append to `internal/store/transactions.go`:

```go
// NetTransferPairs retroactively pairs and nets self-transfers across all
// nettable rows (needs_review / low_confidence / confirmed): same amount and
// currency, opposite directions, within `window`, last4-compatible (see
// transferLast4Compatible). Greedy nearest-in-time pairing; each leg is used at
// most once. Both legs of every pair get status='transfer'. Returns the number
// of transactions marked (2 per pair). User-initiated (sweep endpoint) — it is
// deliberately not run automatically on ingest or import.
func (s *Store) NetTransferPairs(window time.Duration) (int, error) {
	own, err := s.OwnAccountLast4s()
	if err != nil {
		return 0, err
	}
	type leg struct {
		id        int64
		amount    int64
		currency  string
		direction string
		last4     string
		postedAt  time.Time
	}
	rows, err := s.DB.Query(
		`SELECT id, amount, currency, direction, COALESCE(last4,''), posted_at
		   FROM transactions
		  WHERE status IN ('needs_review','low_confidence','confirmed')
		  ORDER BY posted_at, id`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var legs []leg
	for rows.Next() {
		var l leg
		var posted string
		if err := rows.Scan(&l.id, &l.amount, &l.currency, &l.direction, &l.last4, &posted); err != nil {
			return 0, err
		}
		t, err := time.Parse(time.RFC3339Nano, posted)
		if err != nil {
			continue // unparseable timestamp: skip the row, never fail the sweep
		}
		l.postedAt = t
		legs = append(legs, l)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	used := make(map[int64]bool)
	marked := 0
	for i := range legs {
		if legs[i].direction != "debit" || used[legs[i].id] {
			continue
		}
		best := -1
		var bestDelta time.Duration
		for j := range legs {
			if legs[j].direction != "credit" || used[legs[j].id] {
				continue
			}
			if legs[j].amount != legs[i].amount || legs[j].currency != legs[i].currency {
				continue
			}
			delta := legs[j].postedAt.Sub(legs[i].postedAt)
			if delta < 0 {
				delta = -delta
			}
			if delta > window {
				continue
			}
			if !transferLast4Compatible(legs[i].last4, legs[j].last4, own) {
				continue
			}
			if best == -1 || delta < bestDelta {
				best, bestDelta = j, delta
			}
		}
		if best == -1 {
			continue
		}
		used[legs[i].id], used[legs[best].id] = true, true
		if err := s.UpdateTransactionStatus(legs[i].id, "transfer"); err != nil {
			return marked, err
		}
		if err := s.UpdateTransactionStatus(legs[best].id, "transfer"); err != nil {
			return marked, err
		}
		marked += 2
	}
	return marked, nil
}
```

(O(n²) over nettable rows is fine at single-user scale; the query is bounded by the whole history but runs only on explicit user action.)

- [ ] **Step 4: Run store tests**

Run: `go test ./internal/store/ -run TestNetTransferPairs -v`
Expected: PASS.

- [ ] **Step 5: Write the failing handler test**

Create `internal/server/transfers_test.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ledger/internal/store"
)

func seedSweepPair(t *testing.T, st *store.Store) {
	t.Helper()
	base := time.Date(2026, 6, 15, 9, 0, 0, 0, time.UTC)
	for _, d := range []struct {
		dir string
		at  time.Time
	}{{"debit", base}, {"credit", base.Add(15 * time.Minute)}} {
		if _, created, err := st.InsertTransaction(store.TransactionRow{
			PostedAt: d.at, AmountFils: 200000, Currency: "AED", Direction: d.dir,
			MerchantRaw: "SWEEP " + d.dir, Status: "needs_review",
		}); err != nil || !created {
			t.Fatalf("seed %s: created=%v err=%v", d.dir, created, err)
		}
	}
}

func TestTransfersSweep(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTransfersStore(st)
	seedSweepPair(t, st)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/transfers/sweep", strings.NewReader(`{}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Marked int `json:"marked"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Marked != 2 {
		t.Errorf("marked = %d, want 2", got.Marked)
	}
	var transfers int
	st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status='transfer'`).Scan(&transfers)
	if transfers != 2 {
		t.Errorf("transfer rows = %d, want 2", transfers)
	}
}

func TestTransfersSweepWindowValidation(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTransfersStore(st)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/transfers/sweep",
		strings.NewReader(`{"window_hours": 500}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("window 500h: code=%d, want 400", rec.Code)
	}
}

func TestTransfersSweepUnavailableWithoutStore(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st) // no SetTransfersStore
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/transfers/sweep", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("code=%d, want 503", rec.Code)
	}
}
```

- [ ] **Step 6: Run to verify failure**

Run: `go test ./internal/server/ -run TestTransfersSweep -v`
Expected: FAIL to compile — `srv.SetTransfersStore undefined`.

- [ ] **Step 7: Implement the endpoint**

Create `internal/server/transfers.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"time"
)

// TransfersStore is the sweep surface /api/transfers/sweep needs.
type TransfersStore interface {
	NetTransferPairs(window time.Duration) (int, error)
}

// SetTransfersStore wires the transfer-sweep store. Required for /api/transfers/sweep.
func (s *Server) SetTransfersStore(ts TransfersStore) { s.transfersStore = ts }

// handleTransfersSweep retroactively nets self-transfer pairs over the whole
// history. Body is optional: {"window_hours": 2} widens/narrows the pairing
// window (default 2, max 48 — wide windows are for date-only import timestamps).
func (s *Server) handleTransfersSweep(w http.ResponseWriter, r *http.Request) {
	if s.transfersStore == nil {
		http.Error(w, `{"error":"transfers unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req struct {
		WindowHours float64 `json:"window_hours"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // absent/empty body → defaults
	hours := req.WindowHours
	if hours == 0 {
		hours = 2
	}
	if hours < 0 || hours > 48 {
		http.Error(w, `{"error":"window_hours must be between 0 and 48"}`, http.StatusBadRequest)
		return
	}
	marked, err := s.transfersStore.NetTransferPairs(time.Duration(hours * float64(time.Hour)))
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if marked > 0 {
		s.BroadcastEvent("tx", nil)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"marked": marked})
}
```

In `internal/server/server.go`: add struct field after `accountsStore   AccountsStore`:

```go
	transfersStore  TransfersStore
```

and the route after the accounts routes:

```go
	s.mux.HandleFunc("POST /api/transfers/sweep", s.handleTransfersSweep)
```

In `cmd/ledger/main.go`, after `srv.SetAccountsStore(st)`:

```go
	srv.SetTransfersStore(st)
```

- [ ] **Step 8: Run tests**

Run: `go test ./internal/server/ ./internal/store/ && go build ./...`
Expected: PASS, clean build.

- [ ] **Step 9: Commit**

```bash
git add internal/store/transactions.go internal/store/transactions_test.go internal/server/transfers.go internal/server/transfers_test.go internal/server/server.go cmd/ledger/main.go
git commit -m "feat(transfers): retroactive sweep (NetTransferPairs + POST /api/transfers/sweep)"
```

---

### Task 5: Frontend — Accounts & transfers settings page

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Create: `frontend/src/screens/settings/AccountsPage.tsx`
- Modify: `frontend/src/screens/settings/SettingsHub.tsx`
- Modify: `frontend/src/screens/Settings.tsx`
- Test: `frontend/src/screens/Settings.accounts.test.tsx`

**Interfaces:**
- Consumes: Task 2/4 HTTP endpoints; existing helpers `getJSON` / `postJSON` / `del` in `client.ts`; `SettingsPage`, `SavedFlash`/`useSavedFlash`, `Button`, `useToast` components (see `CurrenciesPage.tsx` for the pattern).
- Produces: `Account` and `SweepResult` types; `getAccounts()`, `createAccount({name, last4})`, `deleteAccount(id)`, `sweepTransfers()` client functions; `"accounts"` member of `SettingsPageId`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/screens/Settings.accounts.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

let accounts: { id: number; name: string; bank: string; last4: string }[] = [];

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/accounts" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    accounts = [...accounts, { id: accounts.length + 1, bank: "", ...body }];
    return new Response(JSON.stringify({ id: accounts.length }), { status: 201 });
  }
  if (/^\/api\/accounts\/\d+$/.test(url) && init?.method === "DELETE") {
    accounts = accounts.slice(0, -1);
    return new Response(JSON.stringify({ ok: true }));
  }
  if (url === "/api/accounts") return new Response(JSON.stringify(accounts));
  if (url === "/api/transfers/sweep") return new Response(JSON.stringify({ marked: 4 }));
  if (url === "/api/settings")
    return new Response(JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ai_key_present: true }));
  if (url === "/api/budget")
    return new Response(JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }));
  if (url === "/api/rates") return new Response(JSON.stringify({ rates: [], missing: [] }));
  return new Response("[]");
});

beforeEach(() => {
  fetchMock.mockClear();
  accounts = [{ id: 1, name: "DIB Current", bank: "DIB", last4: "1234" }];
  vi.stubGlobal("fetch", fetchMock);
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Settings />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

async function openAccounts() {
  fireEvent.click(await screen.findByRole("button", { name: /accounts & transfers/i }));
}

describe("Settings accounts & transfers", () => {
  it("lists registered accounts", async () => {
    renderSettings();
    await openAccounts();
    expect(await screen.findByText("DIB Current")).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
  });

  it("adds an account", async () => {
    renderSettings();
    await openAccounts();
    fireEvent.change(await screen.findByLabelText(/account name/i), { target: { value: "ENBD Savings" } });
    fireEvent.change(screen.getByLabelText(/last 4/i), { target: { value: "5678" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/accounts",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("rejects a bad last4 before hitting the network", async () => {
    renderSettings();
    await openAccounts();
    fireEvent.change(await screen.findByLabelText(/account name/i), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/last 4/i), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/4 digits/i);
  });

  it("runs the sweep and reports the count", async () => {
    renderSettings();
    await openAccounts();
    fireEvent.click(await screen.findByRole("button", { name: /net matching transfers/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/transfers/sweep",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(await screen.findByText(/marked 4/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && bunx vitest run src/screens/Settings.accounts.test.tsx`
Expected: FAIL — no hub row named "Accounts & transfers".

- [ ] **Step 3: Add types and client functions**

In `frontend/src/api/types.ts`, append:

```ts
export interface Account {
  id: number;
  name: string;
  bank: string;
  last4: string;
}

export interface SweepResult {
  marked: number;
}
```

In `frontend/src/api/client.ts`, add imports for `Account, SweepResult` from `./types` (extend the existing type import line) and append:

```ts
export function getAccounts(): Promise<Account[]> {
  return getJSON("/api/accounts");
}

export function createAccount(a: { name: string; last4: string; bank?: string }): Promise<{ id: number }> {
  return postJSON("/api/accounts", a);
}

export function deleteAccount(id: number): Promise<void> {
  return del(`/api/accounts/${id}`);
}

export function sweepTransfers(): Promise<SweepResult> {
  return postJSON("/api/transfers/sweep", {});
}
```

- [ ] **Step 4: Create the page**

Create `frontend/src/screens/settings/AccountsPage.tsx` (mirrors `CurrenciesPage.tsx`):

```tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { getAccounts, createAccount, deleteAccount, sweepTransfers } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/Toast";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";

const field = "w-full px-3 py-2 rounded-md border border-border bg-surface text-sm";

export function AccountsPage({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const { saved, flash } = useSavedFlash();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
  const [name, setName] = useState("");
  const [last4, setLast4] = useState("");
  const [addError, setAddError] = useState("");
  const [sweeping, setSweeping] = useState(false);

  const add = async () => {
    if (!name.trim()) {
      setAddError("Name is required");
      return;
    }
    if (!/^\d{4}$/.test(last4)) {
      setAddError("Last 4 must be exactly 4 digits");
      return;
    }
    setAddError("");
    try {
      await createAccount({ name: name.trim(), last4 });
      setName("");
      setLast4("");
      qc.invalidateQueries({ queryKey: ["accounts"] });
      flash();
    } catch {
      show({ message: "Couldn't add account", tone: "error" });
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteAccount(id);
      qc.invalidateQueries({ queryKey: ["accounts"] });
    } catch {
      show({ message: "Couldn't delete account", tone: "error" });
    }
  };

  const sweep = async () => {
    setSweeping(true);
    try {
      const res = await sweepTransfers();
      show({
        message:
          res.marked === 0
            ? "No matching transfer pairs found"
            : `Marked ${res.marked} transaction${res.marked === 1 ? "" : "s"} as transfers`,
        tone: "success",
      });
      for (const k of ["transactions", "review", "summary", "insights-categories", "insights-trend"]) {
        qc.invalidateQueries({ queryKey: [k] });
      }
    } catch {
      show({ message: "Sweep failed", tone: "error" });
    } finally {
      setSweeping(false);
    }
  };

  return (
    <SettingsPage title="Accounts & transfers" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div className="space-y-6">
        <div>
          <p className="text-xs text-muted mb-4">
            Register your own accounts (by card/account last 4) so money moved between them is
            recognized as a transfer and nets to zero. With no accounts registered, matching falls
            back to amount + timing only.
          </p>
          <div className="space-y-3">
            {(accounts.data ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-2">
                <span className="text-sm font-medium flex-1 truncate">{a.name}</span>
                <span className="text-xs text-muted tabular-nums">•••• {a.last4}</span>
                <button
                  aria-label={`Delete ${a.name}`}
                  className="p-2 -mr-2 text-muted hover:text-bad press"
                  onClick={() => remove(a.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}

            <div className="space-y-1 pt-3 border-t border-border">
              <p className="text-sm font-medium">Add account</p>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Name"
                  aria-label="Account name"
                  className={`${field} flex-1`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="Last 4"
                  aria-label="Last 4 digits"
                  className={`${field} w-24`}
                  value={last4}
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))}
                />
                <Button variant="secondary" onClick={add}>Add</Button>
              </div>
              {addError && <p role="alert" className="text-bad text-xs">{addError}</p>}
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-border space-y-2">
          <p className="text-sm font-medium">Net existing transfers</p>
          <p className="text-xs text-muted">
            Scans all transactions and marks matching debit/credit pairs (same amount, close in
            time) as transfers. Wrong matches can be reverted from the Transactions screen.
          </p>
          <Button variant="secondary" onClick={sweep} disabled={sweeping}>
            {sweeping ? "Scanning…" : "Net matching transfers"}
          </Button>
        </div>
      </div>
    </SettingsPage>
  );
}
```

- [ ] **Step 5: Register the page in hub + dispatch**

In `frontend/src/screens/settings/SettingsHub.tsx`:

1. Extend the union:

```ts
export type SettingsPageId =
  | "budget"
  | "categorization"
  | "swipe"
  | "currencies"
  | "accounts"
  | "categories"
  | "rules"
  | "textsize";
```

2. Extend the client import: `import { getAccounts, getJSON, getRates } from "../../api/client";`

3. Add the query beside the others in `SettingsHub`:

```ts
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: getAccounts });
```

4. Add a row in the `Library` group after the Currencies `HubRow`:

```tsx
        <HubRow
          label="Accounts & transfers"
          value={
            accounts.data && accounts.data.length > 0
              ? `${accounts.data.length} account${accounts.data.length === 1 ? "" : "s"}`
              : undefined
          }
          onClick={() => onOpen("accounts")}
        />
```

In `frontend/src/screens/Settings.tsx`: add `import { AccountsPage } from "./settings/AccountsPage";` and, next to the other drill-ins:

```tsx
      {page === "accounts" && <AccountsPage onClose={close} />}
```

- [ ] **Step 6: Run the new test, then the whole frontend suite**

Run: `cd frontend && bunx vitest run src/screens/Settings.accounts.test.tsx`
Expected: PASS.

Run: `cd frontend && bun run test`
Expected: PASS (vitest stays single-fork; don't change `vite.config.ts`).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/screens/settings/AccountsPage.tsx frontend/src/screens/settings/SettingsHub.tsx frontend/src/screens/Settings.tsx frontend/src/screens/Settings.accounts.test.tsx
git commit -m "feat(web): accounts & transfers settings page (registry + sweep)"
```

---

### Task 6: Rebuild embedded dist + end-to-end verification

**Files:**
- Modify: `internal/web/dist/*` (committed build artifact)

**Interfaces:**
- Consumes: everything above.
- Produces: a deployable binary whose embedded PWA matches the frontend source (CLAUDE.md requirement; parallel sessions run on `main` — pull/rebase first so the dist you build is the *combined* frontend).

- [ ] **Step 1: Sync with main**

```bash
git pull --rebase
```

If other sessions landed frontend changes, resolve and re-run the frontend tests.

- [ ] **Step 2: Build frontend into the embedded dist**

```bash
cd frontend && bun install && bun run build
```

Expected: Vite build succeeds, output written to `internal/web/dist/`.

- [ ] **Step 3: Build the binary and run the full suites**

```bash
cd .. && CGO_ENABLED=0 go build -o ledger ./cmd/ledger
go test ./...
cd frontend && bun run test
```

Expected: build clean; all Go tests PASS (known sandbox exception: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set — pre-existing, unrelated); frontend suite PASS.

- [ ] **Step 4: Smoke the new endpoints against the real binary**

```bash
./ledger &  # uses default config; serves 127.0.0.1:8080
sleep 1
curl -s localhost:8080/api/accounts                     # expect []
curl -s -X POST localhost:8080/api/accounts -d '{"name":"DIB Current","last4":"1234"}'   # expect {"id":1}
curl -s -X POST localhost:8080/api/transfers/sweep -d '{}'                               # expect {"marked":0}
kill %1
```

(Per project memory: after store changes also spot-check `curl -s localhost:8080/api/summary` and `/api/transactions` return 200.)

- [ ] **Step 5: Commit the dist**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded dist (accounts & transfers)"
```

(Do not commit the `ledger` binary — only `internal/web/dist/`.)

---

## Out of scope (deliberate)

- **Cross-currency transfers** (AED→USD account): amounts differ by FX; no reliable heuristic without rates-at-time-of-transfer. Manual mark-as-transfer covers it.
- **Auto-sweep on import**: imported rows lack last4, making the heuristic weakest there; the user triggers the sweep from Settings after an import instead.
- **Populating `transactions.account_id`** from the registry: nothing consumes it yet (YAGNI); matching works on last4 strings.
- **A "possible transfer" review-queue suggestion state**: the spec (§6.4) says mark both legs directly; the status is reversible from the UI if wrong.
