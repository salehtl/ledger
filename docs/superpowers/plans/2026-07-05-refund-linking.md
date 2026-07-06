# Refund/Reversal Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Worktree/cwd note:** subagents start in `/root/Coding/ledger` even when the session runs in a worktree. Every dispatched task must `cd` to the correct checkout and verify the branch before touching files.

**Goal:** Let the user link a refund credit to the original purchase so the credit offsets that purchase's category in budgets and insights instead of looking like income.

**Architecture:** A new nullable `transactions.refund_of_id` column points a credit at the debit it refunds. Linking copies the purchase's `category_id` (and `bucket_snapshot`) onto the credit and sets it `confirmed` — the existing budget query (`SelectMonthSpend`) already nets credits against their bucket, so the offset falls out for free. Insights queries currently sum debits only and get a netting fix. Three new API endpoints (candidates / link / unlink) and a `LinkRefundSheet` reachable from both the Transactions list (CategorizeSheet) and the Review swipe deck.

**Tech Stack:** Go stdlib `net/http` (Go 1.22 method+pattern routing), SQLite via `modernc.org/sqlite` (no cgo), React 18 + TypeScript + TanStack Query, vitest + Testing Library.

## Global Constraints

- Money is integer minor units: always `int64` fils, never floats.
- Single binary: frontend builds to `internal/web/dist/` which Go embeds; **rebuild the combined dist before finishing the branch** (parallel sessions run on `main`).
- Schema changes are additive only: `addColumnIfMissing` in `internal/store/store.go` `migrate()`; do **not** edit `schema.sql`'s `CREATE TABLE transactions` (the `amount_aed` precedent lives in `migrate()` only).
- `scanReviewItems` is shared by `SelectTransactions` and `SelectRecent` — any column added to the scanner must be added to **both** SELECTs (and any new query feeding it). Smoke-test `/api/summary` and `/api/transactions` after store changes.
- `ReviewItem` marshals to JSON with Go field names (no tags) — frontend `Txn` fields are PascalCase (`RefundOfID`).
- Unknown `/api/*` returns 404; all new routes go in `routes()` in `internal/server/server.go`.
- Frontend vitest is pinned to a single non-parallel fork in `vite.config.ts` — do not change that.
- Sandbox note: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set in the env — known false failure, not caused by this work.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Design decisions (locked in)

- **Link semantics:** `LinkRefund(creditID, debitID)` requires the credit to exist, be `direction='credit'`, and not be archived; the target must exist, be `direction='debit'`, `status='confirmed'`, and have a category. On success the credit gets `refund_of_id`, the debit's `category_id` + `bucket_snapshot`, and `status='confirmed'`. Partial refunds are allowed (no amount equality check); multiple credits may link the same debit (installment refunds).
- **Unlink semantics:** clears `refund_of_id`, `category_id`, `bucket_snapshot`, and returns the credit to `needs_review`.
- **Candidates:** confirmed, spending-kind, categorized debits posted between 90 days before and 1 day after the credit; exact `amount`+`currency` matches rank first, then newest first; limit 20.
- **Bulk reset:** `ClearAllCategorization` also clears `refund_of_id` (a cleared credit keeping a stale link would be inconsistent).
- **Out of scope:** automatic refund detection, re-categorization clearing the link, and any change to `SelectMonthSpend` (it already nets credits).

## File map

| File | Change |
|---|---|
| `internal/store/store.go` | `migrate()`: add `refund_of_id` column |
| `internal/store/categories.go` | `ReviewItem.RefundOfID`, scanner + `SelectTransactions` column, `ClearAllCategorization` clears link |
| `internal/store/budget.go` | `SelectRecent` column |
| `internal/store/refunds.go` (new) | `LinkRefund`, `UnlinkRefund`, `SelectRefundCandidates`, sentinel errors |
| `internal/store/refunds_test.go` (new) | store tests + `seedTxn` helper |
| `internal/store/insights.go` | net spending credits in both rollups |
| `internal/store/insights_test.go` | netting tests |
| `internal/store/store_test.go` | migration test |
| `internal/server/server.go` | `CategoryStore` interface + routes |
| `internal/server/refunds.go` (new) | three handlers |
| `internal/server/refunds_test.go` (new) | endpoint tests |
| `frontend/src/api/types.ts` | `Txn.RefundOfID` |
| `frontend/src/api/client.ts` | `getRefundCandidates`, `linkRefund`, `unlinkRefund` |
| `frontend/src/components/transactions/TransactionRow.tsx` (+test) | "refund" subtitle tag |
| `frontend/src/components/transactions/LinkRefundSheet.tsx` (new, +test) | candidate picker sheet |
| `frontend/src/components/transactions/CategorizeSheet.tsx` (+test) | link/unlink entry buttons |
| `frontend/src/hooks/useTxnActions.ts` | `unlinkRefund` mutation |
| `frontend/src/screens/Transactions.tsx` | wire sheet + actions |
| `frontend/src/components/swipe/SwipeDeck.tsx` (+new test) | refund button in review deck |

---

### Task 1: Store — `refund_of_id` column and `ReviewItem` plumbing

**Files:**
- Modify: `internal/store/store.go` (the `migrate` func, currently lines 75–88)
- Modify: `internal/store/categories.go` (`ReviewItem` struct ~line 29, `SelectTransactions` ~line 213, `scanReviewItems` ~line 246)
- Modify: `internal/store/budget.go` (`SelectRecent` ~line 141)
- Test: `internal/store/store_test.go`, create `internal/store/refunds_test.go`

**Interfaces:**
- Consumes: existing `openTestStore(t)` helper (in `budget_test.go`), `InsertManualTransaction`.
- Produces: `ReviewItem.RefundOfID *int64` (nil when unlinked) and the `seedTxn(t, st, direction, merchant, amountFils, postedAt, categoryName) int64` test helper — later tasks use both, exactly these signatures.

- [ ] **Step 1: Write the failing migration test**

Append to `internal/store/store_test.go`:

```go
func TestMigrateAddsRefundOfID(t *testing.T) {
	st := openTestStore(t)
	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM pragma_table_info('transactions') WHERE name='refund_of_id'`,
	).Scan(&n); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if n != 1 {
		t.Fatal("transactions.refund_of_id column missing")
	}
}
```

- [ ] **Step 2: Write the failing scanner round-trip test**

Create `internal/store/refunds_test.go`:

```go
package store

import (
	"testing"
	"time"
)

// seedTxn inserts a manual transaction and returns its id. categoryName ""
// leaves it uncategorized (status 'needs_review'); a seeded category name
// (e.g. "Groceries") stores it 'confirmed' with that category.
func seedTxn(t *testing.T, st *Store, direction, merchant string, amountFils int64, postedAt, categoryName string) int64 {
	t.Helper()
	var catID int64
	if categoryName != "" {
		if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name=?`, categoryName).Scan(&catID); err != nil {
			t.Fatalf("look up category %q: %v", categoryName, err)
		}
	}
	posted, err := time.Parse(time.RFC3339, postedAt)
	if err != nil {
		t.Fatalf("parse postedAt %q: %v", postedAt, err)
	}
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    posted,
		AmountFils:  amountFils,
		Direction:   direction,
		MerchantRaw: merchant,
		CategoryID:  catID,
	})
	if err != nil {
		t.Fatalf("insert txn: %v", err)
	}
	return id
}

func TestReviewItemCarriesRefundOfID(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Carrefour refund", 5000, "2026-07-03T10:00:00Z", "")
	if _, err := st.DB.Exec(`UPDATE transactions SET refund_of_id=? WHERE id=?`, debitID, creditID); err != nil {
		t.Fatalf("link: %v", err)
	}
	fetchers := map[string]func() ([]ReviewItem, error){
		"SelectTransactions": func() ([]ReviewItem, error) { return st.SelectTransactions("", "", "") },
		"SelectRecent":       func() ([]ReviewItem, error) { return st.SelectRecent(10) },
	}
	for name, fetch := range fetchers {
		items, err := fetch()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var credit, debit *ReviewItem
		for i := range items {
			switch items[i].ID {
			case creditID:
				credit = &items[i]
			case debitID:
				debit = &items[i]
			}
		}
		if credit == nil || debit == nil {
			t.Fatalf("%s: seeded rows missing from result", name)
		}
		if credit.RefundOfID == nil || *credit.RefundOfID != debitID {
			t.Errorf("%s: credit.RefundOfID = %v, want %d", name, credit.RefundOfID, debitID)
		}
		if debit.RefundOfID != nil {
			t.Errorf("%s: debit.RefundOfID = %v, want nil", name, debit.RefundOfID)
		}
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /root/Coding/ledger && go test ./internal/store/ -run 'TestMigrateAddsRefundOfID|TestReviewItemCarriesRefundOfID' -v`
Expected: FAIL — compile error `credit.RefundOfID undefined` (and the migration test would fail on the missing column).

- [ ] **Step 4: Implement**

In `internal/store/store.go`, inside `migrate()`, insert before the final `return addColumnIfMissing(...)` line:

```go
	// Refund linking: a credit that refunds an earlier purchase points at it.
	if err := addColumnIfMissing(db, "transactions", "refund_of_id", "INTEGER REFERENCES transactions(id)"); err != nil {
		return err
	}
```

In `internal/store/categories.go`, add to `ReviewItem` after `BucketSnapshot`:

```go
	RefundOfID     *int64 // set when this credit is a linked refund of another transaction
```

In `SelectTransactions`, change the SELECT head to end with the new column:

```go
	q := `SELECT t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
	             COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	             t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
	             COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,''), t.refund_of_id
	      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	      WHERE 1=1`
```

In `scanReviewItems`, declare `var refundOf sql.NullInt64`, append `&refundOf` to the `Scan` call (after `&r.BucketSnapshot`), and after the `catID.Valid` block add:

```go
			if refundOf.Valid {
				id := refundOf.Int64
				r.RefundOfID = &id
			}
```

In `internal/store/budget.go`, `SelectRecent`, append the column the same way:

```go
		`SELECT t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
		        COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,''), t.refund_of_id
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  ORDER BY t.posted_at DESC LIMIT ?`, n,
```

- [ ] **Step 5: Run the full store + server packages**

Run: `go test ./internal/store/ ./internal/server/`
Expected: PASS (server package proves the shared scanner change didn't break `/api/transactions` / `/api/summary` handlers).

- [ ] **Step 6: Commit**

```bash
git add internal/store/store.go internal/store/categories.go internal/store/budget.go internal/store/store_test.go internal/store/refunds_test.go
git commit -m "feat(store): add refund_of_id column and expose it on transaction rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Store — `LinkRefund` / `UnlinkRefund`

**Files:**
- Create: `internal/store/refunds.go`
- Modify: `internal/store/categories.go` (`ClearAllCategorization`, ~line 319)
- Test: `internal/store/refunds_test.go`

**Interfaces:**
- Consumes: `seedTxn` helper and `RefundOfID` from Task 1.
- Produces: `func (s *Store) LinkRefund(creditID, debitID int64) error`, `func (s *Store) UnlinkRefund(txID int64) error`, sentinel errors `store.ErrRefundNotFound` and `store.ErrRefundBadLink` (matched via `errors.Is`). Task 5 maps these to 404/400.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/refunds_test.go` (add `"database/sql"` and `"errors"` to its imports):

```go
func TestLinkRefundCopiesCategoryAndConfirms(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Carrefour refund", 5000, "2026-07-03T10:00:00Z", "")

	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}

	var refundOf, catID sql.NullInt64
	var status string
	if err := st.DB.QueryRow(
		`SELECT refund_of_id, category_id, status FROM transactions WHERE id=?`, creditID,
	).Scan(&refundOf, &catID, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !refundOf.Valid || refundOf.Int64 != debitID {
		t.Errorf("refund_of_id = %v, want %d", refundOf, debitID)
	}
	var groceriesID int64
	if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&groceriesID); err != nil {
		t.Fatal(err)
	}
	if !catID.Valid || catID.Int64 != groceriesID {
		t.Errorf("category_id = %v, want %d (Groceries)", catID, groceriesID)
	}
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}

	// The linked credit must net the purchase out of the month's Need bucket.
	spend, err := st.SelectMonthSpend("2026-07", false)
	if err != nil {
		t.Fatalf("SelectMonthSpend: %v", err)
	}
	var net int64
	for _, r := range spend {
		if r.Bucket != "need" {
			continue
		}
		if r.Direction == "debit" {
			net += r.AmountFils
		} else {
			net -= r.AmountFils
		}
	}
	if net != 0 {
		t.Errorf("need bucket net = %d fils, want 0 (refund should cancel purchase)", net)
	}
}

func TestLinkRefundValidation(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	otherCredit := seedTxn(t, st, "credit", "Other credit", 900, "2026-07-02T10:00:00Z", "")
	pendingDebit := seedTxn(t, st, "debit", "Pending", 700, "2026-07-02T10:00:00Z", "") // needs_review, uncategorized

	cases := []struct {
		name          string
		credit, debit int64
		wantErr       error
	}{
		{"credit missing", 99999, debitID, ErrRefundNotFound},
		{"target missing", creditID, 99999, ErrRefundNotFound},
		{"credit is a debit", debitID, debitID, ErrRefundBadLink},
		{"target is a credit", creditID, otherCredit, ErrRefundBadLink},
		{"target unconfirmed", creditID, pendingDebit, ErrRefundBadLink},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := st.LinkRefund(tc.credit, tc.debit); !errors.Is(err, tc.wantErr) {
				t.Errorf("LinkRefund = %v, want errors.Is(_, %v)", err, tc.wantErr)
			}
		})
	}
}

func TestUnlinkRefundRevertsToReview(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}

	if err := st.UnlinkRefund(creditID); err != nil {
		t.Fatalf("UnlinkRefund: %v", err)
	}
	var refundOf, catID sql.NullInt64
	var status string
	if err := st.DB.QueryRow(
		`SELECT refund_of_id, category_id, status FROM transactions WHERE id=?`, creditID,
	).Scan(&refundOf, &catID, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if refundOf.Valid || catID.Valid || status != "needs_review" {
		t.Errorf("after unlink: refund_of=%v cat=%v status=%q, want NULL/NULL/needs_review", refundOf, catID, status)
	}

	// Unlinking a transaction that isn't linked is a not-found error.
	if err := st.UnlinkRefund(creditID); !errors.Is(err, ErrRefundNotFound) {
		t.Errorf("second UnlinkRefund = %v, want ErrRefundNotFound", err)
	}
}

func TestClearAllCategorizationClearsRefundLinks(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}
	if _, err := st.ClearAllCategorization(); err != nil {
		t.Fatalf("ClearAllCategorization: %v", err)
	}
	var refundOf sql.NullInt64
	if err := st.DB.QueryRow(`SELECT refund_of_id FROM transactions WHERE id=?`, creditID).Scan(&refundOf); err != nil {
		t.Fatal(err)
	}
	if refundOf.Valid {
		t.Errorf("refund_of_id survived bulk clear, want NULL")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run 'TestLinkRefund|TestUnlinkRefund|TestClearAllCategorizationClearsRefundLinks' -v`
Expected: FAIL — compile errors: `st.LinkRefund undefined`, `ErrRefundNotFound undefined`.

- [ ] **Step 3: Implement**

Create `internal/store/refunds.go`:

```go
// Refund linking: a credit can point at the debit it refunds via
// transactions.refund_of_id. Linking copies the purchase's category (and
// frozen bucket snapshot) onto the credit and confirms it, so the budget and
// insights rollups net it against the purchase's category instead of treating
// it as income. Partial refunds are allowed; several credits may link the
// same purchase (installment refunds).
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrRefundNotFound: the credit or target transaction does not exist
	// (or, for unlink, the transaction has no link to remove).
	ErrRefundNotFound = errors.New("refund: transaction not found")
	// ErrRefundBadLink: the pair is not a linkable credit→purchase combination.
	ErrRefundBadLink = errors.New("refund: invalid link")
)

// LinkRefund marks creditID as a refund of debitID. The credit must be a
// non-archived credit; the target must be a confirmed, categorized debit.
func (s *Store) LinkRefund(creditID, debitID int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var creditDir, creditStatus string
	err = tx.QueryRow(`SELECT direction, status FROM transactions WHERE id=?`, creditID).
		Scan(&creditDir, &creditStatus)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: credit %d", ErrRefundNotFound, creditID)
	}
	if err != nil {
		return err
	}
	if creditDir != "credit" {
		return fmt.Errorf("%w: transaction %d is not a credit", ErrRefundBadLink, creditID)
	}
	if creditStatus == "archived" {
		return fmt.Errorf("%w: credit %d is archived", ErrRefundBadLink, creditID)
	}

	var debitDir, debitStatus string
	var catID sql.NullInt64
	var snap sql.NullString
	err = tx.QueryRow(`SELECT direction, status, category_id, bucket_snapshot FROM transactions WHERE id=?`, debitID).
		Scan(&debitDir, &debitStatus, &catID, &snap)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: purchase %d", ErrRefundNotFound, debitID)
	}
	if err != nil {
		return err
	}
	if debitDir != "debit" {
		return fmt.Errorf("%w: target %d is not a debit", ErrRefundBadLink, debitID)
	}
	if debitStatus != "confirmed" {
		return fmt.Errorf("%w: purchase %d is not confirmed", ErrRefundBadLink, debitID)
	}
	if !catID.Valid {
		return fmt.Errorf("%w: purchase %d has no category", ErrRefundBadLink, debitID)
	}

	var snapVal any
	if snap.Valid && snap.String != "" {
		snapVal = snap.String
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(
		`UPDATE transactions
		    SET refund_of_id=?, category_id=?, bucket_snapshot=?, status='confirmed', updated_at=?
		  WHERE id=?`,
		debitID, catID.Int64, snapVal, now, creditID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

// UnlinkRefund reverses LinkRefund: the credit loses its link and inherited
// category and returns to the review queue.
func (s *Store) UnlinkRefund(txID int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`UPDATE transactions
		    SET refund_of_id=NULL, category_id=NULL, bucket_snapshot=NULL, status='needs_review', updated_at=?
		  WHERE id=? AND refund_of_id IS NOT NULL`,
		now, txID,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: transaction %d is not a linked refund", ErrRefundNotFound, txID)
	}
	return nil
}
```

In `internal/store/categories.go`, `ClearAllCategorization`, extend the SET clause:

```go
		`UPDATE transactions
		    SET category_id=NULL, bucket_snapshot=NULL, refund_of_id=NULL, status='needs_review', updated_at=?
		  WHERE status!='archived'`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/store/ -run 'TestLinkRefund|TestUnlinkRefund|TestClearAllCategorization' -v`
Expected: PASS (including the pre-existing `ClearAllCategorization` tests).

- [ ] **Step 5: Commit**

```bash
git add internal/store/refunds.go internal/store/refunds_test.go internal/store/categories.go
git commit -m "feat(store): link and unlink refund credits to their original purchase

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Store — `SelectRefundCandidates`

**Files:**
- Modify: `internal/store/refunds.go`
- Test: `internal/store/refunds_test.go`

**Interfaces:**
- Consumes: `scanReviewItems` (now 16 columns incl. `t.refund_of_id`), sentinel errors from Task 2.
- Produces: `func (s *Store) SelectRefundCandidates(creditID int64, limit int) ([]ReviewItem, error)` — Task 5 calls it with `limit=20`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/refunds_test.go`:

```go
func TestSelectRefundCandidatesRanksExactAmountFirst(t *testing.T) {
	st := openTestStore(t)
	// In-window candidates:
	nearWrongAmt := seedTxn(t, st, "debit", "Noon", 7000, "2026-07-02T10:00:00Z", "Shopping")
	exact := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-06-20T10:00:00Z", "Groceries")
	// Excluded rows:
	old := seedTxn(t, st, "debit", "Old buy", 5000, "2026-03-01T10:00:00Z", "Groceries")        // >90 days before
	future := seedTxn(t, st, "debit", "Future buy", 5000, "2026-07-20T10:00:00Z", "Groceries")  // after credit+1d
	pending := seedTxn(t, st, "debit", "Pending buy", 5000, "2026-07-01T10:00:00Z", "")         // uncategorized
	credit := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")

	items, err := st.SelectRefundCandidates(credit, 20)
	if err != nil {
		t.Fatalf("SelectRefundCandidates: %v", err)
	}
	ids := make([]int64, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	if len(items) != 2 {
		t.Fatalf("got %d candidates (%v), want 2", len(items), ids)
	}
	if items[0].ID != exact {
		t.Errorf("first candidate = %d, want exact-amount match %d (got order %v)", items[0].ID, exact, ids)
	}
	if items[1].ID != nearWrongAmt {
		t.Errorf("second candidate = %d, want %d", items[1].ID, nearWrongAmt)
	}
	for _, excluded := range []int64{old, future, pending} {
		for _, id := range ids {
			if id == excluded {
				t.Errorf("candidate %d should have been excluded", excluded)
			}
		}
	}
}

func TestSelectRefundCandidatesRejectsNonCredit(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	if _, err := st.SelectRefundCandidates(debitID, 20); !errors.Is(err, ErrRefundBadLink) {
		t.Errorf("SelectRefundCandidates(debit) = %v, want ErrRefundBadLink", err)
	}
	if _, err := st.SelectRefundCandidates(99999, 20); !errors.Is(err, ErrRefundNotFound) {
		t.Errorf("SelectRefundCandidates(missing) = %v, want ErrRefundNotFound", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run TestSelectRefundCandidates -v`
Expected: FAIL — compile error `st.SelectRefundCandidates undefined`.

- [ ] **Step 3: Implement**

Append to `internal/store/refunds.go`:

```go
// SelectRefundCandidates lists confirmed, categorized spending debits the
// credit could plausibly refund: posted between 90 days before and 1 day
// after the credit. Exact amount+currency matches rank first, then newest.
func (s *Store) SelectRefundCandidates(creditID int64, limit int) ([]ReviewItem, error) {
	if limit <= 0 {
		limit = 20
	}
	var postedAt, currency, direction string
	var amount int64
	err := s.DB.QueryRow(
		`SELECT posted_at, amount, currency, direction FROM transactions WHERE id=?`, creditID,
	).Scan(&postedAt, &amount, &currency, &direction)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: credit %d", ErrRefundNotFound, creditID)
	}
	if err != nil {
		return nil, err
	}
	if direction != "credit" {
		return nil, fmt.Errorf("%w: transaction %d is not a credit", ErrRefundBadLink, creditID)
	}
	posted, err := time.Parse(time.RFC3339Nano, postedAt)
	if err != nil {
		return nil, fmt.Errorf("parse posted_at %q: %w", postedAt, err)
	}
	lower := posted.UTC().AddDate(0, 0, -90).Format(time.RFC3339Nano)
	upper := posted.UTC().Add(24 * time.Hour).Format(time.RFC3339Nano)
	rows, err := s.DB.Query(
		`SELECT t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
		        COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,''), t.refund_of_id
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.direction='debit' AND t.status='confirmed' AND c.kind='spending'
		    AND t.posted_at >= ? AND t.posted_at <= ?
		  ORDER BY CASE WHEN t.amount = ? AND t.currency = ? THEN 0 ELSE 1 END, t.posted_at DESC
		  LIMIT ?`,
		lower, upper, amount, currency, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/store/ -run TestSelectRefundCandidates -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/store/refunds.go internal/store/refunds_test.go
git commit -m "feat(store): rank refund candidate purchases for a credit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Store — net spending credits in insights rollups

The budget summary already nets credits, but `SelectCategorySpend` and `SelectMonthlyTotals` sum debits only — a linked refund would offset the jar but not the insights charts. Fix both to subtract spending-kind credits.

**Files:**
- Modify: `internal/store/insights.go` (both queries)
- Test: `internal/store/insights_test.go`

**Interfaces:**
- Consumes: `seedTxn` helper (Task 1), `UpdateTransactionCategory` (existing).
- Produces: no signature changes — `SelectCategorySpend` / `SelectMonthlyTotals` keep their shapes; only the SQL aggregation changes.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/insights_test.go` (ensure `"time"` is imported):

```go
func TestCategorySpendNetsSpendingCredits(t *testing.T) {
	st := openTestStore(t)
	seedTxn(t, st, "debit", "Carrefour", 10000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Carrefour refund", 4000, "2026-07-02T10:00:00Z", "")
	var groceriesID int64
	if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&groceriesID); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTransactionCategory(creditID, groceriesID, "confirmed"); err != nil {
		t.Fatalf("confirm credit: %v", err)
	}

	rows, err := st.SelectCategorySpend("2026-07", false)
	if err != nil {
		t.Fatalf("SelectCategorySpend: %v", err)
	}
	var groceries *CategorySpendRow
	for i := range rows {
		if rows[i].Name == "Groceries" {
			groceries = &rows[i]
		}
	}
	if groceries == nil {
		t.Fatal("Groceries row missing")
	}
	if groceries.AmountFils != 6000 {
		t.Errorf("Groceries spend = %d, want 6000 (10000 debit - 4000 refund credit)", groceries.AmountFils)
	}
}

func TestMonthlyTotalsNetSpendingCredits(t *testing.T) {
	st := openTestStore(t)
	// SelectMonthlyTotals is anchored to time.Now, so seed rows in the current month.
	posted := time.Now().UTC().Format("2006-01-02") + "T10:00:00Z"
	seedTxn(t, st, "debit", "Carrefour", 10000, posted, "Groceries")
	creditID := seedTxn(t, st, "credit", "Carrefour refund", 4000, posted, "")
	var groceriesID int64
	if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&groceriesID); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTransactionCategory(creditID, groceriesID, "confirmed"); err != nil {
		t.Fatalf("confirm credit: %v", err)
	}

	totals, err := st.SelectMonthlyTotals(1)
	if err != nil {
		t.Fatalf("SelectMonthlyTotals: %v", err)
	}
	if len(totals) != 1 {
		t.Fatalf("got %d months, want 1", len(totals))
	}
	if totals[0].SpentFils != 6000 {
		t.Errorf("spent = %d, want 6000 (net of refund)", totals[0].SpentFils)
	}
	if totals[0].IncomeFils != 0 {
		t.Errorf("income = %d, want 0 (refund is not income)", totals[0].IncomeFils)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run 'TestCategorySpendNetsSpendingCredits|TestMonthlyTotalsNetSpendingCredits' -v`
Expected: FAIL — spend comes back as 10000 (credits ignored).

- [ ] **Step 3: Implement**

In `internal/store/insights.go`, replace `SelectCategorySpend`'s query with:

```go
	rows, err := s.DB.Query(
		`SELECT c.id, c.name, COALESCE(`+bucketExpr+`,''),
		        SUM(CASE WHEN t.direction='debit' THEN COALESCE(t.amount_aed, 0)
		                 ELSE -COALESCE(t.amount_aed, 0) END) AS net
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='spending'
		    AND t.posted_at >= ? AND t.posted_at < ?
		  GROUP BY c.id, c.name
		  ORDER BY net DESC`,
		start, end,
	)
```

Also update the doc comment above it: `// SelectCategorySpend returns confirmed spending-kind activity in the period, netting credits (refunds) against debits, grouped by category, highest net spend first.`

In `SelectMonthlyTotals`, replace the spending CASE line:

```go
		`SELECT strftime('%Y-%m', t.posted_at) AS ym,
		        COALESCE(SUM(CASE WHEN c.kind='spending' AND t.direction='debit' THEN COALESCE(t.amount_aed, 0)
		                          WHEN c.kind='spending' AND t.direction='credit' THEN -COALESCE(t.amount_aed, 0) END),0),
		        COALESCE(SUM(CASE WHEN c.kind='income'   AND t.direction='credit' THEN COALESCE(t.amount_aed, 0) END),0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND t.posted_at >= ?
		  GROUP BY ym ORDER BY ym`,
```

- [ ] **Step 4: Run the store package**

Run: `go test ./internal/store/`
Expected: PASS — if a pre-existing insights test asserted debit-only sums with spending credits present, update its expectation to the netted value (the netting is the intended new behavior).

- [ ] **Step 5: Commit**

```bash
git add internal/store/insights.go internal/store/insights_test.go
git commit -m "feat(store): net spending credits in insights rollups

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Server — refund endpoints

**Files:**
- Create: `internal/server/refunds.go`
- Modify: `internal/server/server.go` (`CategoryStore` interface ~line 43, `routes()` ~line 162)
- Test: `internal/server/refunds_test.go` (new)

**Interfaces:**
- Consumes: `store.LinkRefund`, `store.UnlinkRefund`, `store.SelectRefundCandidates`, `store.ErrRefundNotFound`, `store.ErrRefundBadLink`; test helpers `newTestServerStore` / `newTestServerWithStore` (in `server_testhelpers_test.go`).
- Produces: `POST /api/transactions/{id}/link-refund` (body `{"target_id": N}`), `POST /api/transactions/{id}/unlink-refund`, `GET /api/transactions/{id}/refund-candidates` (returns a `[]store.ReviewItem` JSON array, same shape as `/api/transactions`). Task 6's client functions call exactly these paths.

- [ ] **Step 1: Write the failing tests**

Create `internal/server/refunds_test.go`:

```go
package server

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ledger/internal/store"
)

func seedServerTxn(t *testing.T, st *store.Store, direction, merchant string, amountFils int64, postedAt, categoryName string) int64 {
	t.Helper()
	var catID int64
	if categoryName != "" {
		if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name=?`, categoryName).Scan(&catID); err != nil {
			t.Fatalf("category %q: %v", categoryName, err)
		}
	}
	posted, err := time.Parse(time.RFC3339, postedAt)
	if err != nil {
		t.Fatalf("parse postedAt: %v", err)
	}
	id, err := st.InsertManualTransaction(store.ManualTxn{
		PostedAt: posted, AmountFils: amountFils, Direction: direction,
		MerchantRaw: merchant, CategoryID: catID,
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	return id
}

func TestLinkRefundEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/link-refund", creditID),
		strings.NewReader(fmt.Sprintf(`{"target_id":%d}`, debitID)))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var refundOf int64
	var status string
	if err := st.DB.QueryRow(`SELECT refund_of_id, status FROM transactions WHERE id=?`, creditID).
		Scan(&refundOf, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if refundOf != debitID || status != "confirmed" {
		t.Errorf("credit after link: refund_of=%d status=%q, want %d/confirmed", refundOf, status, debitID)
	}
}

func TestLinkRefundEndpointErrors(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	otherCredit := seedServerTxn(t, st, "credit", "Other", 900, "2026-07-02T10:00:00Z", "")

	cases := []struct {
		name     string
		url      string
		body     string
		wantCode int
	}{
		{"unknown credit", "/api/transactions/99999/link-refund", fmt.Sprintf(`{"target_id":%d}`, debitID), 404},
		{"target is a credit", fmt.Sprintf("/api/transactions/%d/link-refund", creditID), fmt.Sprintf(`{"target_id":%d}`, otherCredit), 400},
		{"missing target_id", fmt.Sprintf("/api/transactions/%d/link-refund", creditID), `{}`, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", tc.url, strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, req)
			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %s)", w.Code, tc.wantCode, w.Body.String())
			}
		})
	}
}

func TestRefundCandidatesEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/transactions/%d/refund-candidates", creditID), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"MerchantRaw":"Carrefour"`) {
		t.Errorf("candidates body missing Carrefour: %s", body)
	}
	if !strings.Contains(body, fmt.Sprintf(`"ID":%d`, debitID)) {
		t.Errorf("candidates body missing debit id: %s", body)
	}

	// A credit with no candidates must return [] not null.
	lonely := seedServerTxn(t, st, "credit", "Lonely", 123, "2020-01-01T10:00:00Z", "")
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/transactions/%d/refund-candidates", lonely), nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if got := strings.TrimSpace(w.Body.String()); got != "[]" {
		t.Errorf("empty candidates = %q, want []", got)
	}
}

func TestUnlinkRefundEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/unlink-refund", creditID), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	// Second unlink: nothing to remove → 404.
	req = httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/unlink-refund", creditID), nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Errorf("second unlink status = %d, want 404", w.Code)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run 'RefundEndpoint|RefundCandidatesEndpoint|LinkRefundEndpointErrors' -v`
Expected: FAIL — 404s from the `/api/` fallback (routes don't exist yet).

- [ ] **Step 3: Implement**

Add to the `CategoryStore` interface in `internal/server/server.go` (after `InsertManualTransaction`):

```go
	LinkRefund(creditID, debitID int64) error
	UnlinkRefund(txID int64) error
	SelectRefundCandidates(creditID int64, limit int) ([]store.ReviewItem, error)
```

(Only `*store.Store` implements `CategoryStore` — no test fakes to update.)

Add to `routes()` next to the other transaction routes:

```go
	s.mux.HandleFunc("GET /api/transactions/{id}/refund-candidates", s.handleRefundCandidates)
	s.mux.HandleFunc("POST /api/transactions/{id}/link-refund", s.handleLinkRefund)
	s.mux.HandleFunc("POST /api/transactions/{id}/unlink-refund", s.handleUnlinkRefund)
```

Create `internal/server/refunds.go`:

```go
package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

type linkRefundReq struct {
	TargetID int64 `json:"target_id"`
}

// writeRefundErr maps the store's refund sentinel errors onto HTTP statuses.
func writeRefundErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrRefundNotFound):
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	case errors.Is(err, store.ErrRefundBadLink):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
	default:
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
	}
}

func (s *Server) refundTxID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return 0, false
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return 0, false
	}
	return txID, true
}

func (s *Server) handleLinkRefund(w http.ResponseWriter, r *http.Request) {
	txID, ok := s.refundTxID(w, r)
	if !ok {
		return
	}
	var req linkRefundReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TargetID <= 0 {
		http.Error(w, `{"error":"target_id required"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.LinkRefund(txID, req.TargetID); err != nil {
		writeRefundErr(w, err)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *Server) handleUnlinkRefund(w http.ResponseWriter, r *http.Request) {
	txID, ok := s.refundTxID(w, r)
	if !ok {
		return
	}
	if err := s.catStore.UnlinkRefund(txID); err != nil {
		writeRefundErr(w, err)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *Server) handleRefundCandidates(w http.ResponseWriter, r *http.Request) {
	txID, ok := s.refundTxID(w, r)
	if !ok {
		return
	}
	items, err := s.catStore.SelectRefundCandidates(txID, 20)
	if err != nil {
		writeRefundErr(w, err)
		return
	}
	if items == nil {
		items = []store.ReviewItem{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/server/ -v -run 'Refund'`
Expected: PASS. Then run `go test ./...` — everything must pass (`internal/config` may show the known env false-failure).

- [ ] **Step 5: Commit**

```bash
git add internal/server/refunds.go internal/server/refunds_test.go internal/server/server.go
git commit -m "feat(api): refund link, unlink, and candidate endpoints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Frontend — API types/client and TransactionRow badge

**Files:**
- Modify: `frontend/src/api/types.ts` (Txn interface, ~line 11)
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/components/transactions/TransactionRow.tsx` (subtitle, ~line 20)
- Test: `frontend/src/components/transactions/TransactionRow.test.tsx` (append)

**Interfaces:**
- Consumes: endpoints from Task 5.
- Produces: `Txn.RefundOfID?: number | null` (optional so existing `Partial<Txn>` test factories keep compiling — the Go API always sends it); `getRefundCandidates(id: number): Promise<Txn[]>`, `linkRefund(id: number, targetId: number): Promise<void>`, `unlinkRefund(id: number): Promise<void>` in `api/client.ts`. Tasks 7–8 import these.

- [ ] **Step 1: Write the failing badge test**

Append inside the existing `describe` block of `frontend/src/components/transactions/TransactionRow.test.tsx` (reuse its existing imports of `render`/`screen`; add `import type { Txn } from "../../api/types";` if not present):

```tsx
it("marks linked refunds in the subtitle", () => {
  const t: Txn = {
    ID: 5, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "credit", MerchantRaw: "Carrefour", Status: "confirmed", Confidence: 1, Source: "email",
    CategoryID: 3, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "",
    RefundOfID: 42,
  };
  render(<TransactionRow txn={t} onOpen={() => {}} onStatus={() => {}} onArchive={() => {}} onRestore={() => {}} />);
  expect(screen.getByText(/refund/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: FAIL — `RefundOfID` type error surfaces at build time only, and the rendered subtitle has no "refund" text.

- [ ] **Step 3: Implement**

`frontend/src/api/types.ts` — add the optional field to `Txn`:

```ts
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; AmountAedFils: number | null; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
  CategoryID: number | null; CategoryName: string; Bucket: string;
  Kind: string; BucketSnapshot: string;
  /** Set when this credit is a linked refund of another transaction. */
  RefundOfID?: number | null;
}
```

`frontend/src/api/client.ts` — extend the types import and append:

```ts
import type { CategoryUsage, RatesResponse, Txn } from "./types";
```

```ts
export function getRefundCandidates(id: number): Promise<Txn[]> {
  return getJSON<Txn[]>(`/api/transactions/${id}/refund-candidates`);
}

export async function linkRefund(id: number, targetId: number): Promise<void> {
  await postJSON(`/api/transactions/${id}/link-refund`, { target_id: targetId });
}

export async function unlinkRefund(id: number): Promise<void> {
  await postJSON(`/api/transactions/${id}/unlink-refund`, {});
}
```

`frontend/src/components/transactions/TransactionRow.tsx` — add the tag to the subtitle array:

```tsx
  const subtitle = [
    txn.PostedAt.slice(0, 10),
    txn.CategoryName,
    txn.RefundOfID ? "refund" : null,
    native,
    aed === null ? "no AED rate" : null,
  ].filter(Boolean).join(" · ");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/components/transactions/TransactionRow.tsx frontend/src/components/transactions/TransactionRow.test.tsx
git commit -m "feat(web): refund link API client and transaction-row refund tag

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — LinkRefundSheet + Transactions-list flow

**Files:**
- Create: `frontend/src/components/transactions/LinkRefundSheet.tsx`
- Create: `frontend/src/components/transactions/LinkRefundSheet.test.tsx`
- Modify: `frontend/src/components/transactions/CategorizeSheet.tsx`
- Modify: `frontend/src/components/transactions/CategorizeSheet.test.tsx` (append)
- Modify: `frontend/src/hooks/useTxnActions.ts`
- Modify: `frontend/src/screens/Transactions.tsx`

**Interfaces:**
- Consumes: `getRefundCandidates`, `linkRefund`, `unlinkRefund` from Task 6; existing `Dialog`, `Button`, `Money` components; `aedFils`/`nativeAmountTag` from `lib/money`.
- Produces: `LinkRefundSheet({ txn, onLinked, onClose }: { txn: Txn; onLinked: () => void; onClose: () => void })`; `CategorizeSheet` gains optional props `onLinkRefund?: () => void` and `onUnlinkRefund?: () => void`; `useTxnActions()` additionally returns `unlinkRefund: (t: Txn) => Promise<void>`. Task 8 reuses `LinkRefundSheet` with the exact same props.

- [ ] **Step 1: Write the failing LinkRefundSheet test**

Create `frontend/src/components/transactions/LinkRefundSheet.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { LinkRefundSheet } from "./LinkRefundSheet";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "credit", MerchantRaw: "Refund", Status: "needs_review", Confidence: 1, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

const credit = txn({ ID: 7 });
const candidate = txn({
  ID: 9, Direction: "debit", MerchantRaw: "Carrefour", Status: "confirmed",
  CategoryID: 3, CategoryName: "Groceries", Bucket: "need", Kind: "spending",
  PostedAt: "2026-06-20T10:00:00Z",
});

function renderSheet(onLinked = vi.fn(), onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <LinkRefundSheet txn={credit} onLinked={onLinked} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onLinked, onClose };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("LinkRefundSheet", () => {
  it("lists candidates and links on tap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([candidate]))) // GET candidates
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }))); // POST link
    const { onLinked } = renderSheet();

    await screen.findByText("Carrefour");
    fireEvent.click(screen.getByRole("button", { name: /Carrefour/ }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/transactions/7/link-refund",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an empty state when there are no candidates", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("[]"));
    renderSheet();
    await screen.findByText(/No categorized purchases/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/components/transactions/LinkRefundSheet.test.tsx`
Expected: FAIL — cannot resolve `./LinkRefundSheet`.

- [ ] **Step 3: Implement LinkRefundSheet**

Create `frontend/src/components/transactions/LinkRefundSheet.tsx`:

```tsx
// frontend/src/components/transactions/LinkRefundSheet.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getRefundCandidates, linkRefund } from "../../api/client";
import type { Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Money } from "../Money";
import { aedFils, nativeAmountTag } from "../../lib/money";

/** Pick the original purchase a refund credit belongs to. Linking copies the
 *  purchase's category onto the credit so it offsets that category instead of
 *  looking like income. */
export function LinkRefundSheet({ txn, onLinked, onClose }: {
  txn: Txn;
  onLinked: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = useQuery({
    queryKey: ["refund-candidates", txn.ID],
    queryFn: () => getRefundCandidates(txn.ID),
  });

  const pick = async (target: Txn) => {
    setBusy(true);
    setError("");
    try {
      await linkRefund(txn.ID, target.ID);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't link refund");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Link refund" onClose={onClose}>
      <p className="text-sm text-muted mb-3">
        {txn.MerchantRaw || "—"} · <Money fils={aedFils(txn) ?? txn.AmountFils} />
        {" — pick the purchase this refunds."}
      </p>
      {candidates.isPending && (
        <div className="flex justify-center py-8">
          <Loader2 size={24} className="animate-spin text-muted" />
        </div>
      )}
      {candidates.isError && <p className="text-sm text-bad py-4">Couldn't load purchases.</p>}
      {candidates.data && candidates.data.length === 0 && (
        <p className="text-sm text-muted py-4">
          No categorized purchases found in the 90 days before this credit.
        </p>
      )}
      {candidates.data && candidates.data.length > 0 && (
        <ul className="divide-y divide-border">
          {candidates.data.map((c) => (
            <li key={c.ID}>
              <button
                disabled={busy}
                className="w-full text-left py-2.5 flex items-center justify-between gap-3 disabled:opacity-50"
                onClick={() => pick(c)}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{c.MerchantRaw || "—"}</span>
                  <span className="block text-xs text-muted truncate">
                    {c.PostedAt.slice(0, 10)} · {c.CategoryName}
                    {nativeAmountTag(c) ? ` · ${nativeAmountTag(c)}` : ""}
                  </span>
                </span>
                <span className="shrink-0"><Money fils={-(aedFils(c) ?? c.AmountFils)} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-sm text-bad mt-2">{error}</p>}
      <div className="flex justify-end mt-3">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the sheet test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/transactions/LinkRefundSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing CategorizeSheet tests**

Append inside the existing `describe` in `frontend/src/components/transactions/CategorizeSheet.test.tsx` (adapt the `txn`/render helper names to what that file already uses; if it has none, construct a full `Txn` literal as in Step 1):

```tsx
it("offers the refund link for unlinked credits", () => {
  const onLinkRefund = vi.fn();
  render(
    <CategorizeSheet
      txn={{ ...baseTxn, Direction: "credit", RefundOfID: null }}
      categories={[]}
      onSubmit={() => {}}
      onClose={() => {}}
      onLinkRefund={onLinkRefund}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /refund/i }));
  expect(onLinkRefund).toHaveBeenCalled();
});

it("offers unlink for linked credits and hides refund actions for debits", () => {
  const onUnlinkRefund = vi.fn();
  const { unmount } = render(
    <CategorizeSheet
      txn={{ ...baseTxn, Direction: "credit", RefundOfID: 42 }}
      categories={[]}
      onSubmit={() => {}}
      onClose={() => {}}
      onUnlinkRefund={onUnlinkRefund}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /unlink refund/i }));
  expect(onUnlinkRefund).toHaveBeenCalled();
  unmount();

  render(
    <CategorizeSheet
      txn={{ ...baseTxn, Direction: "debit" }}
      categories={[]}
      onSubmit={() => {}}
      onClose={() => {}}
      onLinkRefund={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: /refund/i })).not.toBeInTheDocument();
});
```

Where `baseTxn` is (define at the top of the file if absent):

```tsx
const baseTxn: Txn = {
  ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
  Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 1, Source: "email",
  CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
};
```

Run: `cd frontend && bunx vitest run src/components/transactions/CategorizeSheet.test.tsx`
Expected: FAIL — unknown props / missing buttons.

- [ ] **Step 6: Implement the CategorizeSheet + hook + screen wiring**

`frontend/src/components/transactions/CategorizeSheet.tsx` — extend the props and render the buttons right after the merchant `<p>` block:

```tsx
export function CategorizeSheet({ txn, categories, onSubmit, onClose, onLinkRefund, onUnlinkRefund }: {
  txn: Txn;
  categories: Category[];
  onSubmit: (body: { category_id: number; make_rule: boolean }) => void;
  onClose: () => void;
  onLinkRefund?: () => void;
  onUnlinkRefund?: () => void;
}) {
```

```tsx
      {txn.Direction === "credit" && !txn.RefundOfID && onLinkRefund && (
        <Button variant="secondary" className="w-full mb-3" onClick={onLinkRefund}>
          This is a refund — link the purchase
        </Button>
      )}
      {txn.RefundOfID != null && onUnlinkRefund && (
        <Button variant="secondary" className="w-full mb-3" onClick={onUnlinkRefund}>
          Unlink refund
        </Button>
      )}
```

`frontend/src/hooks/useTxnActions.ts` — add before the `return` and include it in the returned object:

```ts
  const unlinkRefund = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/unlink-refund`, {});
      invalidate();
      show({ message: `Unlinked refund ${name}` });
    } catch { show({ message: `Couldn't unlink ${name}`, tone: "error" }); }
  };
```

```ts
  return { invalidate, setStatus, archiveTxn, restoreTxn, categorize, unlinkRefund };
```

`frontend/src/screens/Transactions.tsx` — wire it up:

1. Extend imports: add `LinkRefundSheet` and `useToast` is already there; destructure `unlinkRefund` from `useTxnActions()`.

```tsx
import { LinkRefundSheet } from "../components/transactions/LinkRefundSheet";
```

```tsx
  const { invalidate, setStatus, archiveTxn, restoreTxn, categorize, unlinkRefund } = useTxnActions();
  const [linkTxn, setLinkTxn] = useState<Txn | null>(null);
```

2. Pass the new props to `CategorizeSheet` and render the link sheet after it:

```tsx
      {active && cats.data && (
        <CategorizeSheet
          txn={active}
          categories={cats.data}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
          onLinkRefund={() => { setLinkTxn(active); setActive(null); }}
          onUnlinkRefund={() => { const t = active; setActive(null); void unlinkRefund(t); }}
        />
      )}

      {linkTxn && (
        <LinkRefundSheet
          txn={linkTxn}
          onLinked={() => {
            setLinkTxn(null);
            invalidate();
            show({ message: "Refund linked", tone: "success" });
          }}
          onClose={() => setLinkTxn(null)}
        />
      )}
```

- [ ] **Step 7: Run the frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS (Transactions.test.tsx must still pass — the new props are optional).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/transactions/LinkRefundSheet.tsx frontend/src/components/transactions/LinkRefundSheet.test.tsx frontend/src/components/transactions/CategorizeSheet.tsx frontend/src/components/transactions/CategorizeSheet.test.tsx frontend/src/hooks/useTxnActions.ts frontend/src/screens/Transactions.tsx
git commit -m "feat(web): link-refund flow from the transactions list

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — refund action in the Review swipe deck

**Files:**
- Modify: `frontend/src/components/swipe/SwipeDeck.tsx`
- Create: `frontend/src/components/swipe/SwipeDeck.refund.test.tsx`

**Interfaces:**
- Consumes: `LinkRefundSheet` from Task 7 (props `txn`, `onLinked`, `onClose`).
- Produces: a "This is a refund — link the purchase" button shown only while the current card is a credit; linking advances the deck the same way triple-tap skip does (via `skippedIds`).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/swipe/SwipeDeck.refund.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Txn } from "../../api/types";
import { SwipeDeck } from "./SwipeDeck";

function txn(p: Partial<Txn>): Txn {
  return {
    ID: 1, PostedAt: "2026-07-03T10:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Carrefour", Status: "needs_review", Confidence: 1, Source: "email",
    CategoryID: null, CategoryName: "", Bucket: "", Kind: "", BucketSnapshot: "", RefundOfID: null,
    ...p,
  };
}

function renderDeck(transactions: Txn[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SwipeDeck transactions={transactions} categories={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("SwipeDeck refund action", () => {
  it("shows the refund button for a credit card and opens the link sheet", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[]"));
    renderDeck([txn({ ID: 7, Direction: "credit", MerchantRaw: "Refund inbound" })]);
    const btn = screen.getByRole("button", { name: /this is a refund/i });
    fireEvent.click(btn);
    expect(await screen.findByText("Link refund")).toBeInTheDocument();
  });

  it("hides the refund button for debit cards", () => {
    renderDeck([txn({ ID: 8, Direction: "debit" })]);
    expect(screen.queryByRole("button", { name: /this is a refund/i })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && bunx vitest run src/components/swipe/SwipeDeck.refund.test.tsx`
Expected: FAIL — no refund button rendered.

- [ ] **Step 3: Implement**

In `frontend/src/components/swipe/SwipeDeck.tsx`:

1. Import the sheet and add sheet-open state next to the existing `useState` calls:

```tsx
import { LinkRefundSheet } from '../transactions/LinkRefundSheet'
```

```tsx
  const [linkOpen, setLinkOpen] = useState(false)
```

2. Below the hint paragraph (`Swipe a card to sort · triple-tap to skip`), add:

```tsx
      {current && current.Direction === 'credit' && (
        <button
          className="mx-auto mt-2 text-sm font-medium text-accent"
          onClick={() => setLinkOpen(true)}
        >
          This is a refund — link the purchase
        </button>
      )}
```

3. At the end of the component's JSX (next to the `SubcategoryPanel` block), render the sheet; a successful link removes the card from this session's queue the same way triple-tap skip does:

```tsx
      {linkOpen && current && (
        <LinkRefundSheet
          txn={current}
          onLinked={() => {
            setLinkOpen(false)
            invalidate()
            setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }))
          }}
          onClose={() => setLinkOpen(false)}
        />
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/components/swipe/SwipeDeck.refund.test.tsx && bun run test`
Expected: PASS (full suite too).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/swipe/SwipeDeck.tsx frontend/src/components/swipe/SwipeDeck.refund.test.tsx
git commit -m "feat(web): refund link action in the review deck

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Rebuild embedded dist and verify end-to-end

**Files:**
- Modify: `internal/web/dist/` (committed build artifact)

**Interfaces:**
- Consumes: everything above.
- Produces: a deployable branch whose embedded bundle matches the frontend source.

- [ ] **Step 1: Re-check main for parallel-session drift**

Parallel sessions run on `main`. If working on a branch, run `git fetch && git log --oneline main..HEAD && git log --oneline HEAD..main`; if `main` moved, rebase/merge before building the dist so the combined bundle includes both streams of work.

- [ ] **Step 2: Full test pass**

```bash
cd /root/Coding/ledger && go test ./... && go vet ./... && gofmt -l internal cmd
cd frontend && bun run test
```
Expected: all PASS; `gofmt -l` prints nothing. Known exception: `internal/config` `TestAIConfigEnabledRequiresAPIKey` fails when `LEDGER_AI_API_KEY` is set in the sandbox env — pre-existing, not this feature.

- [ ] **Step 3: Rebuild the frontend and binary**

```bash
cd /root/Coding/ledger/frontend && bun install && bun run build
cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```
Expected: `bun run build` succeeds (this is also the TypeScript typecheck for Tasks 6–8); `go build` produces `./ledger`.

- [ ] **Step 4: Smoke-test the running binary**

```bash
cd /root/Coding/ledger && LEDGER_DATA_DIR=$(mktemp -d) ./ledger &  # or: ./ledger -config <temp config pointing at a temp data dir>
sleep 1
curl -s localhost:8080/api/health
curl -s localhost:8080/api/transactions | head -c 300
curl -s localhost:8080/api/summary | head -c 300
kill %1
```
(Check `internal/config/config.go` for the actual data-dir override mechanism — if there is no env override, write a two-line temp `config.toml` with `data_dir` pointing at a temp dir.)
Expected: health OK; `/api/transactions` returns `[]` or rows including `"RefundOfID"`; `/api/summary` returns buckets JSON. This is the shared-scanner smoke test.

- [ ] **Step 5: Commit the dist**

```bash
git add internal/web/dist ledger 2>/dev/null; git reset ledger 2>/dev/null  # never commit the binary
git add internal/web/dist
git commit -m "chore(web): rebuild embedded dist (refund linking)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** credit offsets original category — Tasks 2 (link copies category; budget nets automatically) and 4 (insights netting). Manual "link to transaction" in the review flow — Task 8 (swipe deck) and Task 7 (needs_review rows in the Transactions list). Undo path — unlink (Tasks 2/5/7). Visibility — refund tag (Task 6).
- **Type consistency:** `LinkRefund(creditID, debitID int64) error` / `UnlinkRefund(txID int64) error` / `SelectRefundCandidates(creditID int64, limit int) ([]ReviewItem, error)` are identical in store (T2/T3), server interface (T5), and callers. Frontend `RefundOfID?: number | null` matches Go's `*int64` JSON (`RefundOfID: 42` / `null`).
- **Known judgment calls (documented, intended):** re-categorizing a linked credit via `handleCategorize` keeps the link (harmless provenance); archiving the original purchase later does not unlink the credit; candidates require the purchase to be categorized because an uncategorized purchase has nothing to offset.
