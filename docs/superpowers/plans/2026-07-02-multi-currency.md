# Multi-Currency Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Foreign-currency transactions (USD/EUR/GBP… — the parse cascade already extracts them) convert to AED via a user-managed rate table, so budget math and displays are correct instead of counting USD 10.09 as AED 10.09.

**Architecture:** A new `fx_rates` table (currency → integer micro-rate) feeds an `amount_aed` snapshot column on `transactions`, written at insert time and backfilled when a rate is added. All budget/insight/summary math switches from `amount` to `amount_aed`. The API exposes `GET/PUT/DELETE /api/rates`; the PWA shows AED-primary amounts with a native-currency tag and a Settings section to manage rates.

**Tech Stack:** Go stdlib (`net/http` method+pattern routing), SQLite via `modernc.org/sqlite` (pure Go), React 18 + TypeScript + vitest.

## Global Constraints

- **Money is integer minor units.** Always `int64` fils. Never floats for money. Rates are stored as `rate_micro INTEGER` (AED per 1 unit × 1,000,000); conversion is integer math with half-up rounding.
- `transactions.amount` stays the **native** positive minor-unit amount; `direction` carries sign. `amount_aed` is the AED snapshot (NULL when no rate is known yet).
- **Snapshot semantics:** rate changes affect future inserts and NULL backfills only; existing non-NULL `amount_aed` values are never rewritten.
- **Nothing silently dropped:** unconverted rows contribute 0 to budgets but stay visible, tagged "no AED rate" in the UI, and listed under `missing` in `GET /api/rates`.
- Schema changes are additive only: `CREATE TABLE IF NOT EXISTS` in `internal/store/schema.sql` + `addColumnIfMissing` in `internal/store/store.go`. No migration tool.
- `ReviewItem` has no JSON tags — Go field names are the JSON keys the frontend types mirror (`AmountFils`, `AmountAedFils`).
- Frontend vitest is pinned to a single non-parallel fork in `vite.config.ts` — do not change that.
- Run Go tests with `go test ./internal/<pkg>/`. Note: `go test ./internal/config/` has a known false failure in this sandbox (`LEDGER_AI_API_KEY` is set in the env) — ignore that one failure only.
- Frontend tests: `cd frontend && bunx vitest run <file>` for one file, `bun run test` for all.

## Conversion formula (used everywhere)

`amount_aed = (amount * rate_micro + 500000) / 1000000` (int64 division; half-up).
Example: USD 10.09 → amount `1009`, rate_micro `3672500` → `(1009*3672500+500000)/1000000 = 3706` fils = AED 37.06.
AED rows: `amount_aed = amount` (identity; no fx_rates row for AED ever).

---

### Task 1: Store — fx_rates table, amount_aed column, conversion + CRUD + backfill

**Files:**
- Modify: `internal/store/schema.sql` (append table)
- Modify: `internal/store/store.go` (migrate + seed + backfill call)
- Create: `internal/store/fx.go`
- Test: `internal/store/fx_test.go`

**Interfaces:**
- Produces (later tasks rely on these exact signatures):
  - `func ConvertToAEDFils(amountMinor, rateMicro int64) int64`
  - `type FXRate struct { Currency string; RateMicro int64; UpdatedAt string }`
  - `func (s *Store) SelectFXRates() ([]FXRate, error)`
  - `func (s *Store) UpsertFXRate(currency string, rateMicro int64) error`
  - `func (s *Store) DeleteFXRate(currency string) error`
  - `func (s *Store) RateMicroFor(currency string) (int64, bool, error)`
  - `func (s *Store) UnconvertedCurrencies() ([]string, error)`
  - `func (s *Store) ConvertUnconverted() (int64, error)`

- [ ] **Step 1: Write the failing test**

Create `internal/store/fx_test.go`:

```go
package store

import "testing"

func openFXTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestConvertToAEDFils(t *testing.T) {
	cases := []struct{ amount, rate, want int64 }{
		{1009, 3672500, 3706},  // USD 10.09 @ peg -> AED 37.06
		{100, 1000000, 100},    // identity rate
		{1, 3672500, 4},        // rounds half-up: 3.6725 -> 4
		{2412, 4300000, 10372}, // EUR 24.12 @ 4.30 -> AED 103.72 (103.716 rounds up)
	}
	for _, c := range cases {
		if got := ConvertToAEDFils(c.amount, c.rate); got != c.want {
			t.Errorf("ConvertToAEDFils(%d, %d) = %d, want %d", c.amount, c.rate, got, c.want)
		}
	}
}

func TestFXRateCRUDAndSeed(t *testing.T) {
	s := openFXTestStore(t)

	// USD peg is seeded on Open.
	rate, ok, err := s.RateMicroFor("USD")
	if err != nil || !ok || rate != 3672500 {
		t.Fatalf("seeded USD rate = %d, ok=%v, err=%v; want 3672500", rate, ok, err)
	}
	// AED is always identity without a table row.
	rate, ok, err = s.RateMicroFor("AED")
	if err != nil || !ok || rate != 1000000 {
		t.Fatalf("AED rate = %d, ok=%v, err=%v; want identity 1000000", rate, ok, err)
	}
	// Unknown currency: ok=false.
	if _, ok, _ := s.RateMicroFor("EUR"); ok {
		t.Fatal("EUR should have no rate yet")
	}

	if err := s.UpsertFXRate("EUR", 4300000); err != nil {
		t.Fatalf("UpsertFXRate: %v", err)
	}
	rates, err := s.SelectFXRates()
	if err != nil || len(rates) != 2 {
		t.Fatalf("SelectFXRates = %v, err=%v; want 2 rows", rates, err)
	}
	// Upsert overwrites.
	if err := s.UpsertFXRate("EUR", 4310000); err != nil {
		t.Fatalf("UpsertFXRate overwrite: %v", err)
	}
	rate, _, _ = s.RateMicroFor("EUR")
	if rate != 4310000 {
		t.Fatalf("EUR after overwrite = %d, want 4310000", rate)
	}
	if err := s.DeleteFXRate("EUR"); err != nil {
		t.Fatalf("DeleteFXRate: %v", err)
	}
	if _, ok, _ := s.RateMicroFor("EUR"); ok {
		t.Fatal("EUR should be gone after delete")
	}
}

func TestConvertUnconvertedBackfill(t *testing.T) {
	s := openFXTestStore(t)
	// Insert rows bypassing InsertTransaction so amount_aed stays NULL
	// (simulates pre-migration data).
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := s.DB.Exec(q, args...); err != nil {
			t.Fatalf("exec: %v", err)
		}
	}
	const ins = `INSERT INTO transactions
	  (posted_at, amount, currency, direction, merchant_raw, status, fingerprint, source, created_at, updated_at)
	  VALUES (?, ?, ?, 'debit', 'm', 'confirmed', ?, 'email', '2026-07-01', '2026-07-01')`
	mustExec(ins, "2026-07-01T00:00:00Z", 5000, "AED", "fp-aed")
	mustExec(ins, "2026-07-01T00:00:00Z", 1009, "USD", "fp-usd")
	mustExec(ins, "2026-07-01T00:00:00Z", 2412, "EUR", "fp-eur")

	n, err := s.ConvertUnconverted()
	if err != nil {
		t.Fatalf("ConvertUnconverted: %v", err)
	}
	if n != 2 { // AED identity + USD via seeded peg; EUR has no rate
		t.Fatalf("converted %d rows, want 2", n)
	}
	var aed, usd int64
	var eur *int64
	row := func(fp string, dst any) {
		t.Helper()
		if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE fingerprint=?`, fp).Scan(dst); err != nil {
			t.Fatalf("select %s: %v", fp, err)
		}
	}
	row("fp-aed", &aed)
	row("fp-usd", &usd)
	row("fp-eur", &eur)
	if aed != 5000 || usd != 3706 || eur != nil {
		t.Fatalf("aed=%d usd=%d eur=%v; want 5000, 3706, nil", aed, usd, eur)
	}

	missing, err := s.UnconvertedCurrencies()
	if err != nil || len(missing) != 1 || missing[0] != "EUR" {
		t.Fatalf("UnconvertedCurrencies = %v, err=%v; want [EUR]", missing, err)
	}

	// Adding the missing rate then re-running backfills EUR.
	if err := s.UpsertFXRate("EUR", 4300000); err != nil {
		t.Fatalf("UpsertFXRate: %v", err)
	}
	if n, err := s.ConvertUnconverted(); err != nil || n != 1 {
		t.Fatalf("second ConvertUnconverted = %d, %v; want 1", n, err)
	}
	row("fp-eur", &eur)
	if eur == nil || *eur != 10372 {
		t.Fatalf("eur = %v, want 10372", eur)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run 'TestConvertToAEDFils|TestFXRateCRUDAndSeed|TestConvertUnconvertedBackfill' -v`
Expected: FAIL — compile errors (`ConvertToAEDFils` undefined, etc.)

- [ ] **Step 3: Implement**

Append to `internal/store/schema.sql`:

```sql
-- FX rates for converting foreign-currency transactions to AED.
-- rate_micro is AED per 1 unit of currency × 1,000,000 (integer; money math never uses floats).
-- AED itself never has a row (identity). Rates are user-maintained via /api/rates.
CREATE TABLE IF NOT EXISTS fx_rates (
  currency   TEXT PRIMARY KEY,
  rate_micro INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
```

In `internal/store/store.go`, extend `migrate` (keep existing lines):

```go
func migrate(db *sql.DB) error {
	if err := addColumnIfMissing(db, "rules", "is_active", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		return err
	}
	if err := addColumnIfMissing(db, "transactions", "archived_from", "TEXT"); err != nil {
		return err
	}
	// AED snapshot of amount; NULL when the currency has no fx rate yet.
	return addColumnIfMissing(db, "transactions", "amount_aed", "INTEGER")
}
```

In `Open`, after `st := &Store{DB: db}` and the `SeedDefaultCategories` block, add:

```go
	if err := st.seedFXRates(); err != nil {
		db.Close()
		return nil, fmt.Errorf("seed fx rates: %w", err)
	}
	if _, err := st.ConvertUnconverted(); err != nil {
		db.Close()
		return nil, fmt.Errorf("backfill amount_aed: %w", err)
	}
```

Create `internal/store/fx.go`:

```go
package store

import "time"

// FXRate is one currency's AED conversion rate. RateMicro is AED per 1 unit
// of the currency × 1,000,000, kept integer so money math never touches floats.
type FXRate struct {
	Currency  string
	RateMicro int64
	UpdatedAt string
}

// aedIdentityMicro is the implicit AED->AED rate; AED never has an fx_rates row.
const aedIdentityMicro = 1_000_000

// ConvertToAEDFils converts a native minor-unit amount to fils, rounding half-up.
func ConvertToAEDFils(amountMinor, rateMicro int64) int64 {
	return (amountMinor*rateMicro + 500_000) / 1_000_000
}

// seedFXRates inserts the USD/AED peg (3.6725, fixed since 1997) once.
// Other currencies are user-entered; a wrong guessed seed applied silently
// would be worse than a visible missing rate.
func (s *Store) seedFXRates() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO fx_rates (currency, rate_micro, updated_at) VALUES ('USD', 3672500, ?)`,
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

// SelectFXRates returns all configured rates, alphabetical.
func (s *Store) SelectFXRates() ([]FXRate, error) {
	rows, err := s.DB.Query(`SELECT currency, rate_micro, updated_at FROM fx_rates ORDER BY currency`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FXRate
	for rows.Next() {
		var r FXRate
		if err := rows.Scan(&r.Currency, &r.RateMicro, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertFXRate creates or overwrites one currency's rate.
func (s *Store) UpsertFXRate(currency string, rateMicro int64) error {
	_, err := s.DB.Exec(
		`INSERT INTO fx_rates (currency, rate_micro, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(currency) DO UPDATE SET rate_micro=excluded.rate_micro, updated_at=excluded.updated_at`,
		currency, rateMicro, time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

// DeleteFXRate removes a rate. Existing amount_aed snapshots are untouched.
func (s *Store) DeleteFXRate(currency string) error {
	_, err := s.DB.Exec(`DELETE FROM fx_rates WHERE currency=?`, currency)
	return err
}

// RateMicroFor returns the micro-rate for a currency. AED (or empty, which
// defaults to AED throughout the store) is the identity; unknown currencies
// return ok=false.
func (s *Store) RateMicroFor(currency string) (int64, bool, error) {
	if currency == "" || currency == "AED" {
		return aedIdentityMicro, true, nil
	}
	var rate int64
	err := s.DB.QueryRow(`SELECT rate_micro FROM fx_rates WHERE currency=?`, currency).Scan(&rate)
	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return 0, false, nil
		}
		return 0, false, err
	}
	return rate, true, nil
}

// UnconvertedCurrencies lists currencies present on transactions that still
// have no AED snapshot — i.e. rates the user needs to add.
func (s *Store) UnconvertedCurrencies() ([]string, error) {
	rows, err := s.DB.Query(
		`SELECT DISTINCT currency FROM transactions WHERE amount_aed IS NULL ORDER BY currency`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ConvertUnconverted fills amount_aed for rows that lack it: identity for AED,
// the current fx rate otherwise. Rows whose currency has no rate stay NULL.
// Existing snapshots are never rewritten (WHERE amount_aed IS NULL).
func (s *Store) ConvertUnconverted() (int64, error) {
	res1, err := s.DB.Exec(
		`UPDATE transactions SET amount_aed = amount WHERE amount_aed IS NULL AND currency = 'AED'`)
	if err != nil {
		return 0, err
	}
	n1, _ := res1.RowsAffected()
	res2, err := s.DB.Exec(
		`UPDATE transactions
		    SET amount_aed = (amount * (SELECT rate_micro FROM fx_rates WHERE fx_rates.currency = transactions.currency) + 500000) / 1000000
		  WHERE amount_aed IS NULL
		    AND currency IN (SELECT currency FROM fx_rates)`)
	if err != nil {
		return n1, err
	}
	n2, _ := res2.RowsAffected()
	return n1 + n2, nil
}
```

Note on `RateMicroFor`: use `errors.Is(err, sql.ErrNoRows)` (import `database/sql` and `errors`) instead of the string compare shown above — write it as:

```go
	err := s.DB.QueryRow(`SELECT rate_micro FROM fx_rates WHERE currency=?`, currency).Scan(&rate)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/store/ -v`
Expected: PASS (all store tests, not just the new ones — the migration must not break anything)

- [ ] **Step 5: Commit**

```bash
git add internal/store/schema.sql internal/store/store.go internal/store/fx.go internal/store/fx_test.go
git commit -m "feat(store): fx_rates table + amount_aed snapshot column with backfill"
```

---

### Task 2: Store — insert paths populate amount_aed; AI prompt currency fix

**Files:**
- Modify: `internal/store/transactions.go` (`InsertTransaction` ~line 44, `InsertManualTransaction` ~line 186)
- Modify: `internal/parse/ai.go` (prompt text, lines 35-36)
- Test: `internal/store/transactions_fx_test.go` (create)

**Interfaces:**
- Consumes: `s.RateMicroFor(currency)`, `ConvertToAEDFils` from Task 1.
- Produces: every transaction inserted via `InsertTransaction` or `InsertManualTransaction` has `amount_aed` set (or NULL when the currency has no rate). No signature changes — callers (parse processor, importer, server) are untouched.

- [ ] **Step 1: Write the failing test**

Create `internal/store/transactions_fx_test.go`:

```go
package store

import (
	"testing"
	"time"
)

func TestInsertTransactionSetsAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	day := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name     string
		currency string
		amount   int64
		wantAED  *int64
	}{
		{"aed identity", "AED", 5000, i64p(5000)},
		{"empty defaults to aed", "", 700, i64p(700)},
		{"usd via seeded peg", "USD", 1009, i64p(3706)},
		{"unknown currency stays null", "EUR", 2412, nil},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id, created, err := s.InsertTransaction(TransactionRow{
				PostedAt: day.AddDate(0, 0, i), AmountFils: c.amount, Currency: c.currency,
				Direction: "debit", MerchantRaw: c.name, Status: "confirmed",
			})
			if err != nil || !created {
				t.Fatalf("insert: created=%v err=%v", created, err)
			}
			var got *int64
			if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE id=?`, id).Scan(&got); err != nil {
				t.Fatalf("select: %v", err)
			}
			if (got == nil) != (c.wantAED == nil) || (got != nil && *got != *c.wantAED) {
				t.Fatalf("amount_aed = %v, want %v", deref(got), deref(c.wantAED))
			}
		})
	}
}

func TestInsertManualTransactionSetsAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	id, err := s.InsertManualTransaction(ManualTxn{
		PostedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		AmountFils: 1000, Currency: "USD", Direction: "debit", MerchantRaw: "m",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	var got int64
	if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE id=?`, id).Scan(&got); err != nil {
		t.Fatalf("select: %v", err)
	}
	if got != 3673 { // USD 10.00 * 3.6725 = AED 36.725 -> 3673 fils half-up
		t.Fatalf("amount_aed = %d, want 3673", got)
	}
}

func i64p(v int64) *int64 { return &v }

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run 'TestInsertTransactionSetsAmountAED|TestInsertManualTransactionSetsAmountAED' -v`
Expected: FAIL — `amount_aed = <nil>, want 5000` (column exists from Task 1 but inserts leave it NULL)

- [ ] **Step 3: Implement**

In `internal/store/fx.go`, add:

```go
// amountAEDValue computes the AED snapshot to store with a new transaction:
// the amount itself for AED, the converted value when a rate exists, SQL NULL
// otherwise (backfilled later by ConvertUnconverted once a rate is added).
func (s *Store) amountAEDValue(amountFils int64, currency string) (any, error) {
	rate, ok, err := s.RateMicroFor(currency)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return ConvertToAEDFils(amountFils, rate), nil
}
```

In `InsertTransaction` (internal/store/transactions.go), before the `s.DB.Exec`, compute the snapshot and add the column:

```go
	amountAED, err := s.amountAEDValue(r.AmountFils, r.Currency)
	if err != nil {
		return 0, false, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, status, confidence,
		    fingerprint, source, ingest_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, amountAED, r.Currency, r.Direction,
		r.MerchantRaw, r.Status, r.Confidence, r.Fingerprint(), source, nullableID(r.IngestID), now, now,
	)
```

In `InsertManualTransaction`, same pattern (after the `currency` default, before the Exec):

```go
	amountAED, err := s.amountAEDValue(m.AmountFils, currency)
	if err != nil {
		return 0, err
	}
```

and change its INSERT to:

```go
		`INSERT INTO transactions
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, category_id, status,
		    confidence, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
		m.PostedAt.UTC().Format(time.RFC3339Nano), m.AmountFils, amountAED, currency, m.Direction,
		m.MerchantRaw, catID, status, 1.0, fp, now, now,
```

In `internal/parse/ai.go`, the extraction prompt (lines 35-36) says `amount_fils is positive integer (AED×100)`. Replace those two lines' rules text so the AI reports the native currency instead of assuming AED:

```go
{"posted_at":"2024-01-15T00:00:00Z","amount_fils":3825,"currency":"AED","direction":"debit","merchant_raw":"AMAZON.AE","last4":"1234","confidence":0.8}
Rules: posted_at is ISO8601 UTC; amount_fils is a positive integer, the amount in minor units (×100) of the transaction currency (e.g. USD 10.09 → 1009 with currency "USD"); currency is the 3-letter code shown in the email, "AED" if none shown; direction is exactly "debit" or "credit"; last4 may be empty string "".`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/store/ ./internal/parse/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/store/transactions.go internal/store/fx.go internal/store/transactions_fx_test.go internal/parse/ai.go
git commit -m "feat(store): snapshot amount_aed on insert; AI prompt reports native currency"
```

---

### Task 3: Store — budget/insight math and list queries use amount_aed

**Files:**
- Modify: `internal/store/budget.go` (`SelectMonthSpend` line 82, `SelectMonthIncome` line 115, `SelectRecent` line 143)
- Modify: `internal/store/categories.go` (`ReviewItem` struct line 29, `SelectTransactions` line 213, `scanReviewItems` line 245)
- Modify: `internal/store/insights.go` (`SelectCategorySpend` line 26, `SelectMonthlyTotals` lines 67-69)
- Test: `internal/store/budget_fx_test.go` (create)

**Interfaces:**
- Consumes: `amount_aed` column populated by Tasks 1-2.
- Produces: `ReviewItem` gains field `AmountAedFils *int64` (JSON key `AmountAedFils`, `null` when unconverted — no json tags on this struct). All aggregate queries (`SelectMonthSpend`, `SelectMonthIncome`, `SelectCategorySpend`, `SelectMonthlyTotals`) sum `COALESCE(t.amount_aed, 0)` — unconverted rows contribute 0 until a rate is added.

**CAUTION (from project memory):** `scanReviewItems` is a shared scanner. Its column list must change in lockstep in *both* feeder queries — `SelectTransactions` (categories.go:213) and `SelectRecent` (budget.go:143) — or `/api/transactions` and `/api/summary` break at runtime.

- [ ] **Step 1: Write the failing test**

Create `internal/store/budget_fx_test.go`:

```go
package store

import (
	"testing"
	"time"
)

// seedFXSpend inserts one AED and one USD confirmed debit in July 2026 under
// a spending/need category, plus one EUR debit with no rate (unconverted).
func seedFXSpend(t *testing.T, s *Store) (catID int64) {
	t.Helper()
	// Groceries is seeded by SeedDefaultCategories as spending/need.
	if err := s.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&catID); err != nil {
		t.Fatalf("find category: %v", err)
	}
	day := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ins := func(amount int64, currency, merchant string) {
		t.Helper()
		id, created, err := s.InsertTransaction(TransactionRow{
			PostedAt: day, AmountFils: amount, Currency: currency,
			Direction: "debit", MerchantRaw: merchant, Status: "confirmed",
		})
		if err != nil || !created {
			t.Fatalf("insert %s: created=%v err=%v", merchant, created, err)
		}
		if _, err := s.DB.Exec(`UPDATE transactions SET category_id=? WHERE id=?`, catID, id); err != nil {
			t.Fatalf("categorize: %v", err)
		}
	}
	ins(10000, "AED", "carrefour") // AED 100.00
	ins(1009, "USD", "hetzner")    // -> AED 37.06 via seeded peg
	ins(2412, "EUR", "seychelles") // no EUR rate -> unconverted, counts 0
	return catID
}

func TestMonthSpendUsesAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	seedFXSpend(t, s)
	rows, err := s.SelectMonthSpend("2026-07", false)
	if err != nil {
		t.Fatalf("SelectMonthSpend: %v", err)
	}
	var total int64
	for _, r := range rows {
		total += r.AmountFils
	}
	if total != 13706 { // 10000 + 3706 + 0
		t.Fatalf("month spend = %d, want 13706", total)
	}
}

func TestCategorySpendAndTotalsUseAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	seedFXSpend(t, s)
	cats, err := s.SelectCategorySpend("2026-07", false)
	if err != nil || len(cats) != 1 {
		t.Fatalf("SelectCategorySpend = %v, err=%v", cats, err)
	}
	if cats[0].AmountFils != 13706 {
		t.Fatalf("category spend = %d, want 13706", cats[0].AmountFils)
	}
	totals, err := s.SelectMonthlyTotals(1)
	if err != nil || len(totals) != 1 {
		t.Fatalf("SelectMonthlyTotals = %v, err=%v", totals, err)
	}
	if totals[0].SpentFils != 13706 {
		t.Fatalf("monthly spent = %d, want 13706", totals[0].SpentFils)
	}
}

func TestReviewItemCarriesAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	seedFXSpend(t, s)
	items, err := s.SelectTransactions("", "", "")
	if err != nil || len(items) != 3 {
		t.Fatalf("SelectTransactions = %d items, err=%v; want 3", len(items), err)
	}
	byMerchant := map[string]ReviewItem{}
	for _, it := range items {
		byMerchant[it.MerchantRaw] = it
	}
	if v := byMerchant["hetzner"].AmountAedFils; v == nil || *v != 3706 {
		t.Fatalf("usd AmountAedFils = %v, want 3706", v)
	}
	if v := byMerchant["seychelles"].AmountAedFils; v != nil {
		t.Fatalf("eur AmountAedFils = %v, want nil", v)
	}
	// SelectRecent feeds the same scanner — must not break.
	if _, err := s.SelectRecent(5); err != nil {
		t.Fatalf("SelectRecent: %v", err)
	}
}
```

Note: `TestMonthlyTotals` uses `time.Now()` internally — the July 2026 rows are "this month" as of the plan date. If `SelectMonthlyTotals(1)` returns empty because the wall clock moved past July 2026, use `SelectMonthlyTotals(24)` and find the "2026-07" row instead.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/store/ -run 'TestMonthSpendUsesAmountAED|TestCategorySpendAndTotalsUseAmountAED|TestReviewItemCarriesAmountAED' -v`
Expected: FAIL — `AmountAedFils` undefined (compile), then totals `16421` instead of `13706` (raw native sums)

- [ ] **Step 3: Implement**

`internal/store/categories.go` — add the field after `Currency`:

```go
type ReviewItem struct {
	ID             int64
	PostedAt       string
	AmountFils     int64
	AmountAedFils  *int64 // AED snapshot; nil when the currency has no rate yet
	Currency       string
	...            // rest unchanged
}
```

Both feeder queries add `t.amount_aed` right after `t.amount`. `SelectTransactions` (categories.go:213):

```go
	q := `SELECT t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
	             COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	             t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
	             COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,'')
	      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	      WHERE 1=1`
```

`SelectRecent` (budget.go:143) — identical column list change:

```go
		`SELECT t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
		        COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,'')
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  ORDER BY t.posted_at DESC LIMIT ?`, n,
```

`scanReviewItems` (categories.go:245) — scan the new column:

```go
	for rows.Next() {
		var r ReviewItem
		var catID sql.NullInt64
		var aed sql.NullInt64
		if err := rows.Scan(
			&r.ID, &r.PostedAt, &r.AmountFils, &aed, &r.Currency, &r.Direction,
			&r.MerchantRaw, &r.Status, &r.Confidence, &r.Source,
			&catID, &r.CategoryName, &r.Bucket,
			&r.Kind, &r.BucketSnapshot,
		); err != nil {
			return nil, err
		}
		if aed.Valid {
			v := aed.Int64
			r.AmountAedFils = &v
		}
		if catID.Valid {
			id := catID.Int64
			r.CategoryID = &id
		}
		out = append(out, r)
	}
```

Aggregate queries switch `t.amount` → `COALESCE(t.amount_aed, 0)`:

- `SelectMonthSpend` (budget.go:82): `SELECT `+bucketExpr+`, t.direction, COALESCE(t.amount_aed, 0)`
- `SelectMonthIncome` (budget.go:115): `SELECT COALESCE(SUM(COALESCE(t.amount_aed, 0)), 0)`
- `SelectCategorySpend` (insights.go:26 and 31): `SUM(COALESCE(t.amount_aed, 0))` in both SELECT and ORDER BY
- `SelectMonthlyTotals` (insights.go:68-69): both `CASE WHEN ... THEN t.amount END` become `CASE WHEN ... THEN COALESCE(t.amount_aed, 0) END`

Do **not** touch `FindTransferMatch` (transactions.go:226) — transfer legs match on native `amount`, which is correct for same-currency transfers and cross-currency matching is out of scope.

- [ ] **Step 4: Run the full store and server test suites**

Run: `go test ./internal/store/ ./internal/server/ -v`
Expected: PASS. Server tests exercise `/api/summary` and `/api/transactions` against the changed scanner — both must be green (see CAUTION above).

- [ ] **Step 5: Commit**

```bash
git add internal/store/budget.go internal/store/categories.go internal/store/insights.go internal/store/budget_fx_test.go
git commit -m "feat(store): budget/insight math and lists use amount_aed snapshots"
```

---

### Task 4: Server — /api/rates endpoints

**Files:**
- Create: `internal/server/rates.go`
- Modify: `internal/server/server.go` (route table ~line 169, store setter section ~line 117, field block ~line 91)
- Modify: `cmd/ledger/main.go` (wire setter next to `srv.SetSettingsStore(st)` at line 157)
- Test: `internal/server/rates_test.go`

**Interfaces:**
- Consumes (from Task 1, all on `*store.Store`): `SelectFXRates() ([]store.FXRate, error)`, `UpsertFXRate(string, int64) error`, `DeleteFXRate(string) error`, `UnconvertedCurrencies() ([]string, error)`, `ConvertUnconverted() (int64, error)`.
- Produces:
  - `GET /api/rates` → `{"rates":[{"currency":"USD","rate":3.6725,"updated_at":"..."}],"missing":["EUR"]}` (`missing` = currencies on unconverted transactions; `[]` never null)
  - `PUT /api/rates/{currency}` body `{"rate":4.02}` → upserts, backfills NULL snapshots, broadcasts `tx` SSE, returns `{"ok":true,"converted":N}`. 400 on bad code (must match `^[A-Z]{3}$`, not `AED`) or rate outside `(0, 1000)`.
  - `DELETE /api/rates/{currency}` → `{"ok":true}`.
  - `func (s *Server) SetRatesStore(rs RatesStore)`

- [ ] **Step 1: Write the failing test**

Create `internal/server/rates_test.go` (mirrors settings_test.go style; uses the real store like `newTestServerStore`):

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

func newRatesServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetRatesStore(st)
	return srv, st
}

func TestGetRates(t *testing.T) {
	srv, st := newRatesServer(t)
	// One unconverted EUR row so "missing" is non-empty.
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		AmountFils: 2412, Currency: "EUR", Direction: "debit",
		MerchantRaw: "m", Status: "confirmed",
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/rates", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Rates []struct {
			Currency string  `json:"currency"`
			Rate     float64 `json:"rate"`
		} `json:"rates"`
		Missing []string `json:"missing"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rates) != 1 || got.Rates[0].Currency != "USD" || got.Rates[0].Rate != 3.6725 {
		t.Fatalf("rates = %+v, want seeded USD 3.6725", got.Rates)
	}
	if len(got.Missing) != 1 || got.Missing[0] != "EUR" {
		t.Fatalf("missing = %v, want [EUR]", got.Missing)
	}
}

func TestPutRateBackfills(t *testing.T) {
	srv, st := newRatesServer(t)
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		AmountFils: 2412, Currency: "EUR", Direction: "debit",
		MerchantRaw: "m", Status: "confirmed",
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	req := httptest.NewRequest("PUT", "/api/rates/EUR", strings.NewReader(`{"rate":4.30}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["converted"] != float64(1) {
		t.Fatalf("converted = %v, want 1", got["converted"])
	}
	var aed int64
	if err := st.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE currency='EUR'`).Scan(&aed); err != nil {
		t.Fatalf("select: %v", err)
	}
	if aed != 10372 {
		t.Fatalf("amount_aed = %d, want 10372", aed)
	}
}

func TestPutRateValidation(t *testing.T) {
	srv, _ := newRatesServer(t)
	for _, c := range []struct{ path, body string }{
		{"/api/rates/AED", `{"rate":1}`},    // AED is identity, not editable
		{"/api/rates/usd", `{"rate":3.67}`}, // lowercase
		{"/api/rates/EURO", `{"rate":4.3}`}, // 4 letters
		{"/api/rates/EUR", `{"rate":0}`},    // non-positive
		{"/api/rates/EUR", `{"rate":-2}`},
	} {
		req := httptest.NewRequest("PUT", c.path, strings.NewReader(c.body))
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("PUT %s %s: code=%d, want 400", c.path, c.body, rec.Code)
		}
	}
}

func TestDeleteRate(t *testing.T) {
	srv, st := newRatesServer(t)
	if err := st.UpsertFXRate("EUR", 4300000); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	req := httptest.NewRequest("DELETE", "/api/rates/EUR", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d", rec.Code)
	}
	if _, ok, _ := st.RateMicroFor("EUR"); ok {
		t.Fatal("EUR rate should be deleted")
	}
}
```

Note: check how `newTestServerWithStore`/`testFS` are defined in `server_testhelpers_test.go` and reuse them exactly; if `testFS` is named differently (e.g. `fstest()`), match the existing name.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/server/ -run 'TestGetRates|TestPutRate|TestDeleteRate' -v`
Expected: FAIL — `SetRatesStore` undefined

- [ ] **Step 3: Implement**

Create `internal/server/rates.go`:

```go
package server

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"

	"ledger/internal/store"
)

// RatesStore is the fx-rate surface the /api/rates endpoints need.
type RatesStore interface {
	SelectFXRates() ([]store.FXRate, error)
	UpsertFXRate(currency string, rateMicro int64) error
	DeleteFXRate(currency string) error
	UnconvertedCurrencies() ([]string, error)
	ConvertUnconverted() (int64, error)
}

// SetRatesStore wires the fx-rate store. Required for /api/rates.
func (s *Server) SetRatesStore(rs RatesStore) { s.ratesStore = rs }

var currencyCodeRe = regexp.MustCompile(`^[A-Z]{3}$`)

type rateDTO struct {
	Currency  string  `json:"currency"`
	Rate      float64 `json:"rate"` // AED per 1 unit; display/input form of rate_micro
	UpdatedAt string  `json:"updated_at"`
}

func (s *Server) handleGetRates(w http.ResponseWriter, r *http.Request) {
	if s.ratesStore == nil {
		http.Error(w, `{"error":"rates unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	rates, err := s.ratesStore.SelectFXRates()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	missing, err := s.ratesStore.UnconvertedCurrencies()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	out := struct {
		Rates   []rateDTO `json:"rates"`
		Missing []string  `json:"missing"`
	}{Rates: []rateDTO{}, Missing: []string{}}
	for _, fr := range rates {
		out.Rates = append(out.Rates, rateDTO{
			Currency: fr.Currency, Rate: float64(fr.RateMicro) / 1e6, UpdatedAt: fr.UpdatedAt,
		})
	}
	out.Missing = append(out.Missing, missing...)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handlePutRate(w http.ResponseWriter, r *http.Request) {
	if s.ratesStore == nil {
		http.Error(w, `{"error":"rates unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	currency := r.PathValue("currency")
	if !currencyCodeRe.MatchString(currency) || currency == "AED" {
		http.Error(w, `{"error":"currency must be a 3-letter uppercase code other than AED"}`, http.StatusBadRequest)
		return
	}
	var req struct {
		Rate float64 `json:"rate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if !(req.Rate > 0 && req.Rate < 1000) {
		http.Error(w, `{"error":"rate must be between 0 and 1000"}`, http.StatusBadRequest)
		return
	}
	// The float exists only at the API boundary; storage and math are integer micro-units.
	rateMicro := int64(math.Round(req.Rate * 1e6))
	if err := s.ratesStore.UpsertFXRate(currency, rateMicro); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	converted, err := s.ratesStore.ConvertUnconverted()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if converted > 0 {
		s.BroadcastEvent("tx", nil)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "converted": converted})
}

func (s *Server) handleDeleteRate(w http.ResponseWriter, r *http.Request) {
	if s.ratesStore == nil {
		http.Error(w, `{"error":"rates unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	currency := r.PathValue("currency")
	if !currencyCodeRe.MatchString(currency) {
		http.Error(w, `{"error":"invalid currency"}`, http.StatusBadRequest)
		return
	}
	if err := s.ratesStore.DeleteFXRate(currency); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
```

In `internal/server/server.go`:
- add field `ratesStore RatesStore` next to `settingsStore` (~line 91)
- register routes next to the settings routes (~line 170):

```go
	s.mux.HandleFunc("GET /api/rates", s.handleGetRates)
	s.mux.HandleFunc("PUT /api/rates/{currency}", s.handlePutRate)
	s.mux.HandleFunc("DELETE /api/rates/{currency}", s.handleDeleteRate)
```

In `cmd/ledger/main.go`, next to `srv.SetSettingsStore(st)` (line 157):

```go
	srv.SetRatesStore(st)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/server/ -v && go build ./cmd/ledger`
Expected: PASS, binary builds

- [ ] **Step 5: Commit**

```bash
git add internal/server/rates.go internal/server/rates_test.go internal/server/server.go cmd/ledger/main.go
git commit -m "feat(server): /api/rates endpoints with backfill-on-change"
```

---

### Task 5: Frontend — types + pure money/sum helpers

**Files:**
- Modify: `frontend/src/api/types.ts` (Txn interface line 11; add rate types)
- Modify: `frontend/src/lib/money.ts` (add `aedFils`, `nativeAmountTag`)
- Modify: `frontend/src/lib/analysis.ts` (sums at lines 39, 45, 48, 75, 80)
- Modify: `frontend/src/lib/transactions.ts` (`txnTotals` line 22)
- Test: `frontend/src/lib/money.test.ts` (extend), `frontend/src/lib/analysis.test.ts` (extend), `frontend/src/lib/transactions.test.ts` (extend)

**Interfaces:**
- Consumes: `AmountAedFils` JSON field from Task 3 (`number | null`).
- Produces (Task 6/7 rely on these):
  - `Txn` gains `AmountAedFils: number | null;`
  - `interface FXRateDTO { currency: string; rate: number; updated_at: string }`
  - `interface RatesResponse { rates: FXRateDTO[]; missing: string[] }`
  - `function aedFils(t: { AmountFils: number; Currency: string; AmountAedFils: number | null }): number | null`
  - `function nativeAmountTag(t: { AmountFils: number; Currency: string; AmountAedFils: number | null }): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/money.test.ts` (match the file's existing describe/it style):

```ts
import { aedFils, nativeAmountTag } from "./money";

const txn = (over: Partial<{ AmountFils: number; Currency: string; AmountAedFils: number | null }>) => ({
  AmountFils: 1009, Currency: "USD", AmountAedFils: 3706, ...over,
});

describe("aedFils", () => {
  it("returns AmountFils for AED rows regardless of snapshot", () => {
    expect(aedFils(txn({ Currency: "AED", AmountFils: 5000, AmountAedFils: 5000 }))).toBe(5000);
  });
  it("treats empty currency as AED", () => {
    expect(aedFils(txn({ Currency: "", AmountFils: 700, AmountAedFils: null }))).toBe(700);
  });
  it("returns the snapshot for foreign rows", () => {
    expect(aedFils(txn({}))).toBe(3706);
  });
  it("returns null for unconverted foreign rows", () => {
    expect(aedFils(txn({ AmountAedFils: null }))).toBeNull();
  });
});

describe("nativeAmountTag", () => {
  it("is null for AED rows", () => {
    expect(nativeAmountTag(txn({ Currency: "AED" }))).toBeNull();
    expect(nativeAmountTag(txn({ Currency: "" }))).toBeNull();
  });
  it("formats the native amount with its code", () => {
    expect(nativeAmountTag(txn({}))).toBe("USD 10.09");
    expect(nativeAmountTag(txn({ Currency: "EUR", AmountFils: 241234 }))).toBe("EUR 2,412.34");
  });
});
```

Append to `frontend/src/lib/analysis.test.ts` — build Txn fixtures the way the existing tests in that file do (there is a fixture helper or inline literals; extend the object with `AmountAedFils`), and add:

```ts
it("sums the AED snapshot, not the native amount, and skips unconverted rows", () => {
  const rows = [
    mkTxn({ AmountFils: 10000, Currency: "AED", AmountAedFils: 10000 }),
    mkTxn({ AmountFils: 1009, Currency: "USD", AmountAedFils: 3706 }),
    mkTxn({ AmountFils: 2412, Currency: "EUR", AmountAedFils: null }),
  ];
  const out = bucketBreakdown(rows, false);
  const total = out.reduce((s, b) => s + b.spent, 0);
  expect(total).toBe(13706);
});
```

(`mkTxn` = whatever confirmed-debit-spending fixture builder the file already uses; if it builds plain objects, add `AmountAedFils` to its defaults as `AmountFils` for AED.)

Append to `frontend/src/lib/transactions.test.ts`:

```ts
it("txnTotals uses AED snapshots and skips unconverted rows", () => {
  const rows = [
    { Direction: "debit", AmountFils: 10000, Currency: "AED", AmountAedFils: 10000 },
    { Direction: "debit", AmountFils: 1009, Currency: "USD", AmountAedFils: 3706 },
    { Direction: "debit", AmountFils: 2412, Currency: "EUR", AmountAedFils: null },
    { Direction: "credit", AmountFils: 999, Currency: "AED", AmountAedFils: 999 },
  ] as unknown as Txn[];
  expect(txnTotals(rows)).toEqual({ count: 4, spentFils: 13706 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/money.test.ts src/lib/analysis.test.ts src/lib/transactions.test.ts`
Expected: FAIL — `aedFils` not exported; type errors on `AmountAedFils`

- [ ] **Step 3: Implement**

`frontend/src/api/types.ts` — extend `Txn` and add rate types:

```ts
export interface Txn {
  ID: number; PostedAt: string; AmountFils: number; AmountAedFils: number | null; Currency: string;
  Direction: string; MerchantRaw: string; Status: string; Confidence: number; Source: string;
  CategoryID: number | null; CategoryName: string; Bucket: string;
  Kind: string; BucketSnapshot: string;
}
export interface FXRateDTO { currency: string; rate: number; updated_at: string; }
export interface RatesResponse { rates: FXRateDTO[]; missing: string[]; }
```

`frontend/src/lib/money.ts` — append:

```ts
export interface FXAmount {
  AmountFils: number;
  Currency: string;
  AmountAedFils: number | null;
}

/** Budget-effective AED fils for a transaction. AED rows are their own amount;
 *  foreign rows use the stored snapshot; null = foreign with no rate configured
 *  yet (excluded from every sum until a rate is added in Settings). */
export function aedFils(t: FXAmount): number | null {
  if (!t.Currency || t.Currency === "AED") return t.AmountFils;
  return t.AmountAedFils;
}

/** "USD 10.09" annotation for foreign-currency rows; null for AED rows. */
export function nativeAmountTag(t: FXAmount): string | null {
  if (!t.Currency || t.Currency === "AED") return null;
  const n = (t.AmountFils / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${t.Currency} ${n}`;
}
```

`frontend/src/lib/analysis.ts` — import `aedFils` from `./money`, then replace every `t.AmountFils` accumulation with the snapshot (5 sites):

```ts
// line 39 and 75:
const total = spending.reduce((s, t) => s + (aedFils(t) ?? 0), 0);
// line 45:
b.spent += aedFils(t) ?? 0;
// line 48:
c.spent += aedFils(t) ?? 0;
// line 80:
m.spent += aedFils(t) ?? 0;
```

`frontend/src/lib/transactions.ts` — import `aedFils` from `./money`, change `txnTotals`:

```ts
export function txnTotals(rows: Txn[]): TxnTotals {
  let spentFils = 0;
  for (const t of rows) {
    if (t.Direction === "debit") spentFils += aedFils(t) ?? 0;
  }
  return { count: rows.length, spentFils };
}
```

Other existing tests in these files construct `Txn` objects; add `AmountAedFils` to any fixture the compiler complains about (equal to `AmountFils` for AED fixtures).

- [ ] **Step 4: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/lib/money.ts frontend/src/lib/money.test.ts frontend/src/lib/analysis.ts frontend/src/lib/analysis.test.ts frontend/src/lib/transactions.ts frontend/src/lib/transactions.test.ts
git commit -m "feat(web): AED-effective amount helpers; sums use fx snapshots"
```

---

### Task 6: Frontend — display components show AED + native tag

**Files:**
- Modify: `frontend/src/components/transactions/TransactionRow.tsx` (lines 18-19)
- Modify: `frontend/src/components/transactions/CategorizeSheet.tsx` (line 34)
- Modify: `frontend/src/components/swipe/SwipeCard.tsx` (line 170)
- Modify: `frontend/src/components/insights/DrillDownSheet.tsx` (line 52)
- Modify: `frontend/src/screens/Home.tsx` (line 149)
- Test: `frontend/src/components/transactions/TransactionRow.test.tsx` (extend)

**Interfaces:**
- Consumes: `aedFils`, `nativeAmountTag` from `../../lib/money` (Task 5).
- Display rule (all components): primary amount = `aedFils(t) ?? t.AmountFils` (fallback shows the native magnitude when unconverted); foreign rows get the `nativeAmountTag` in their secondary line; unconverted rows additionally get a literal `"no AED rate"` note.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/components/transactions/TransactionRow.test.tsx` (reuse the file's existing render helper / txn fixture, adding `AmountAedFils` to the fixture defaults):

```tsx
it("shows the converted AED amount with a native tag for foreign rows", () => {
  render(<TransactionRow txn={mkTxn({ AmountFils: 1009, Currency: "USD", AmountAedFils: 3706, Direction: "debit" })}
    onOpen={noop} onStatus={noop} onArchive={noop} onRestore={noop} />);
  expect(screen.getByText("−37.06")).toBeInTheDocument();
  expect(screen.getByText(/USD 10\.09/)).toBeInTheDocument();
});

it("marks unconverted foreign rows", () => {
  render(<TransactionRow txn={mkTxn({ AmountFils: 2412, Currency: "EUR", AmountAedFils: null, Direction: "debit" })}
    onOpen={noop} onStatus={noop} onArchive={noop} onRestore={noop} />);
  expect(screen.getByText(/no AED rate/)).toBeInTheDocument();
});
```

(`mkTxn`/`noop`: whatever the existing tests in this file use; the flow sign is `−` U+2212, matching `flowAmount`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/transactions/TransactionRow.test.tsx`
Expected: FAIL — `−10.09` rendered instead of `−37.06`, no tag

- [ ] **Step 3: Implement**

`TransactionRow.tsx` — import `aedFils, nativeAmountTag` alongside `flowAmount`, replace lines 18-19:

```tsx
  const aed = aedFils(txn);
  const native = nativeAmountTag(txn);
  const subtitle = [
    txn.PostedAt.slice(0, 10),
    txn.CategoryName,
    native,
    aed === null ? "no AED rate" : null,
  ].filter(Boolean).join(" · ");
  const amount = flowAmount(txn.Direction, aed ?? txn.AmountFils);
```

`CategorizeSheet.tsx` line 34 — converted amount plus native context:

```tsx
      <p className="text-sm text-muted mb-3">
        {txn.MerchantRaw || "—"} · <Money fils={-(aedFils(txn) ?? txn.AmountFils)} />
        {nativeAmountTag(txn) ? ` · ${nativeAmountTag(txn)}` : ""}
      </p>
```

`SwipeCard.tsx` line 170 — primary amount uses the snapshot; add the tag under it (match surrounding markup; a `text-xs text-muted` line):

```tsx
            {credit ? '+' : '−'}{formatFils(aedFils(txn) ?? txn.AmountFils)}
```

and directly below the amount element:

```tsx
          {nativeAmountTag(txn) && (
            <p className="text-xs text-muted">{nativeAmountTag(txn)}{aedFils(txn) === null ? " · no AED rate" : ""}</p>
          )}
```

`DrillDownSheet.tsx` line 52:

```tsx
  const total = rows.reduce((s, t) => s + (aedFils(t) ?? 0), 0);
```

`Home.tsx` line 149:

```tsx
                const amount = flowAmount(t.Direction, aedFils(t) ?? t.AmountFils);
```

Add the `import { aedFils, nativeAmountTag } from "<relative>/lib/money";` (or extend existing money imports) in each touched file; only import what the file uses.

- [ ] **Step 4: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS (existing component tests may need `AmountAedFils` added to fixtures — set it equal to `AmountFils` for AED fixtures)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/transactions/TransactionRow.tsx frontend/src/components/transactions/TransactionRow.test.tsx frontend/src/components/transactions/CategorizeSheet.tsx frontend/src/components/swipe/SwipeCard.tsx frontend/src/components/insights/DrillDownSheet.tsx frontend/src/screens/Home.tsx
git commit -m "feat(web): AED-primary display with native-currency tags"
```

---

### Task 7: Frontend — Settings currency-rates section

**Files:**
- Create: `frontend/src/lib/rates.ts`
- Test: `frontend/src/lib/rates.test.ts`
- Modify: `frontend/src/api/client.ts` (add rate calls)
- Modify: `frontend/src/screens/Settings.tsx` (new Card section; screen component starts line 26)
- Test: `frontend/src/screens/Settings.rates.test.tsx` (create; mirror `Settings.categorization.test.tsx` mocking style)

**Interfaces:**
- Consumes: `GET/PUT/DELETE /api/rates` (Task 4), `RatesResponse`/`FXRateDTO` types (Task 5).
- Produces:
  - `function parseRateForm(code: string, rate: string): { ok: true; currency: string; rate: number } | { ok: false; error: string }` in `lib/rates.ts`
  - `getRates(): Promise<RatesResponse>`, `putRate(currency: string, rate: number): Promise<void>`, `deleteRate(currency: string): Promise<void>` in `api/client.ts`

- [ ] **Step 1: Write the failing lib test**

Create `frontend/src/lib/rates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRateForm } from "./rates";

describe("parseRateForm", () => {
  it("accepts a valid code and rate, normalizing case/whitespace", () => {
    expect(parseRateForm(" eur ", "4.30")).toEqual({ ok: true, currency: "EUR", rate: 4.3 });
  });
  it("rejects non-3-letter codes", () => {
    expect(parseRateForm("EURO", "4.3")).toEqual({ ok: false, error: "Currency must be a 3-letter code." });
    expect(parseRateForm("E1R", "4.3")).toEqual({ ok: false, error: "Currency must be a 3-letter code." });
  });
  it("rejects AED", () => {
    expect(parseRateForm("AED", "1")).toEqual({ ok: false, error: "AED is the base currency." });
  });
  it("rejects non-positive or non-numeric rates", () => {
    expect(parseRateForm("EUR", "0")).toEqual({ ok: false, error: "Enter a rate greater than zero." });
    expect(parseRateForm("EUR", "abc")).toEqual({ ok: false, error: "Enter a rate greater than zero." });
    expect(parseRateForm("EUR", "-1")).toEqual({ ok: false, error: "Enter a rate greater than zero." });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && bunx vitest run src/lib/rates.test.ts`
Expected: FAIL — module `./rates` not found

- [ ] **Step 3: Implement lib + client**

Create `frontend/src/lib/rates.ts`:

```ts
export type RateFormResult =
  | { ok: true; currency: string; rate: number }
  | { ok: false; error: string };

/** Validate the Settings add/edit-rate form: 3-letter code (not AED), positive rate. */
export function parseRateForm(code: string, rate: string): RateFormResult {
  const currency = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: "Currency must be a 3-letter code." };
  }
  if (currency === "AED") {
    return { ok: false, error: "AED is the base currency." };
  }
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    return { ok: false, error: "Enter a rate greater than zero." };
  }
  return { ok: true, currency, rate: r };
}
```

Append to `frontend/src/api/client.ts`:

```ts
import type { CategoryUsage, RatesResponse } from "./types"; // extend the existing import

export function getRates(): Promise<RatesResponse> {
  return getJSON<RatesResponse>("/api/rates");
}

export async function putRate(currency: string, rate: number): Promise<void> {
  await postJSON(`/api/rates/${currency}`, { rate }, "PUT");
}

export function deleteRate(currency: string): Promise<void> {
  return del(`/api/rates/${currency}`);
}
```

- [ ] **Step 4: Verify lib tests pass**

Run: `cd frontend && bunx vitest run src/lib/rates.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing screen test**

Create `frontend/src/screens/Settings.rates.test.tsx`. Mirror the setup of `Settings.categorization.test.tsx` (query-client wrapper + fetch mocking) — read that file first and copy its harness. The assertions:

```tsx
it("lists configured rates and missing currencies", async () => {
  // mock GET /api/rates -> { rates: [{currency:"USD", rate:3.6725, updated_at:"2026-07-01"}], missing: ["EUR"] }
  renderSettings();
  expect(await screen.findByText("Currency Rates")).toBeInTheDocument();
  expect(await screen.findByText("USD")).toBeInTheDocument();
  expect(await screen.findByDisplayValue("3.6725")).toBeInTheDocument();
  expect(await screen.findByText(/EUR/)).toBeInTheDocument(); // missing-rate warning row
  expect(screen.getByText(/no rate configured/i)).toBeInTheDocument();
});

it("saves a rate via PUT /api/rates/{code}", async () => {
  renderSettings();
  const input = await screen.findByDisplayValue("3.6725");
  fireEvent.change(input, { target: { value: "3.68" } });
  fireEvent.click(screen.getByRole("button", { name: /save usd/i }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/api/rates/USD", expect.objectContaining({ method: "PUT" }));
  });
});
```

- [ ] **Step 6: Run to verify it fails, then implement the Settings section**

Run: `cd frontend && bunx vitest run src/screens/Settings.rates.test.tsx` → FAIL (no "Currency Rates" section)

Add to `Settings.tsx`, following the screen's existing Card/section pattern (see the "Swipe Directions" section at line 284 for the heading idiom):

- Query: `const rates = useQuery({ queryKey: ["rates"], queryFn: getRates });`
- A `Currency Rates` card that renders:
  - One row per configured rate: currency code, a numeric text input prefilled with `rate`, a save button (aria-label `Save {code}`) calling `putRate(code, parsed.rate)` (validate via `parseRateForm(code, input)`; show its `error` inline on failure), and a delete button calling `deleteRate(code)`.
  - After each successful mutation: `qc.invalidateQueries({ queryKey: ["rates"] })` and `qc.invalidateQueries({ queryKey: ["transactions"] })` (backfill may have changed amounts; summary/insights re-fetch on the `tx` SSE event as they already do).
  - For each entry in `missing`: a warning row "`{code}` — no rate configured; these transactions are excluded from budgets" with an inline rate input + save button that calls `putRate` for that code.
  - An "Add currency" row: code input + rate input + add button, validated with `parseRateForm`.
  - A one-line caption: "AED per 1 unit. Snapshots are taken when a transaction arrives; changing a rate only affects future and unconverted transactions."

- [ ] **Step 7: Run the full frontend suite**

Run: `cd frontend && bun run test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/rates.ts frontend/src/lib/rates.test.ts frontend/src/api/client.ts frontend/src/screens/Settings.tsx frontend/src/screens/Settings.rates.test.tsx frontend/src/api/types.ts
git commit -m "feat(web): currency-rates management in Settings"
```

---

### Task 8: Integration — rebuild embedded dist, full test pass

**Files:**
- Modify: `internal/web/dist/*` (committed build artifact)

**Interfaces:** none new — this is verification + artifact rebuild.

- [ ] **Step 1: Full backend test pass**

Run: `go test ./...`
Expected: PASS (except the known `internal/config` sandbox false failure if `LEDGER_AI_API_KEY` is set — verify that is the *only* failure and it's the known `TestAIConfigEnabledRequiresAPIKey` env issue)

- [ ] **Step 2: Full frontend test pass**

Run: `cd frontend && bun run test`
Expected: PASS

- [ ] **Step 3: Rebuild the embedded bundle and binary**

```bash
cd frontend && bun install && bun run build
cd .. && CGO_ENABLED=0 go build -o ledger ./cmd/ledger
```
Expected: `internal/web/dist/` updated, binary builds.

- [ ] **Step 4: Smoke-test the binary against a scratch DB**

```bash
LEDGER_DATA_DIR=$(mktemp -d) ./ledger -config /dev/null & sleep 2
curl -s localhost:8080/api/health
curl -s localhost:8080/api/rates
curl -s localhost:8080/api/summary | head -c 400
curl -s localhost:8080/api/transactions | head -c 400
kill %1
```
(Check `internal/config` for the actual data-dir config mechanism — if there is no env override, write a 2-line scratch TOML with `data_dir` pointing at a temp dir instead.) Expected: health OK; `/api/rates` shows seeded USD; summary and transactions return JSON without errors (shared-scanner smoke test).

- [ ] **Step 5: Commit the dist rebuild**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for multi-currency"
```
