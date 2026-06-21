package store

import (
	"database/sql"
	"path/filepath"
	"strconv"
	"testing"
	"time"
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

// SelectRecent shares scanReviewItems with SelectTransactions; its SELECT must
// project the same columns (incl. kind + bucket_snapshot) or the scan fails.
// Regression guard: a column-count mismatch surfaced as /api/summary 500.
func TestSelectRecentScansAllColumns(t *testing.T) {
	st := openTestStore(t)
	if _, _, err := st.InsertTransaction(TransactionRow{
		PostedAt: time.Now().UTC(), AmountFils: 1234, Currency: "AED",
		Direction: "debit", MerchantRaw: "Test Merchant", Status: "confirmed",
	}); err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}
	rows, err := st.SelectRecent(10)
	if err != nil {
		t.Fatalf("SelectRecent: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("SelectRecent returned %d rows, want 1", len(rows))
	}
	if rows[0].MerchantRaw != "Test Merchant" {
		t.Errorf("MerchantRaw = %q, want %q", rows[0].MerchantRaw, "Test Merchant")
	}
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
	cfg, err := st.SelectBudgetConfig()
	if err != nil {
		t.Fatalf("SelectBudgetConfig: %v", err)
	}
	if cfg.MonthlyIncome != 2000000 || cfg.NeedPct != 0.6 || !cfg.FreezeHistory {
		t.Errorf("Ensure clobbered user values: %+v", cfg)
	}
}

func TestSelectBudgetConfigNoRow(t *testing.T) {
	st := openTestStore(t)
	// Without EnsureBudgetConfig, the singleton row does not exist.
	if _, err := st.SelectBudgetConfig(); err != sql.ErrNoRows {
		t.Errorf("err = %v, want sql.ErrNoRows", err)
	}
}

func seedTx(t *testing.T, st *Store, postedAt, direction string, amount int64, catID int64, status string) {
	t.Helper()
	_, err := st.DB.Exec(
		`INSERT INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, category_id, status, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, 'AED', ?, 'M', ?, ?, ?, 'email', '2026-06-01', '2026-06-01')`,
		postedAt, amount, direction, catID, status,
		postedAt+direction+itoa(amount),
	)
	if err != nil {
		t.Fatalf("seedTx: %v", err)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestSelectMonthSpend(t *testing.T) {
	st := openTestStore(t)
	var grocID int64
	st.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&grocID)

	seedTx(t, st, "2026-06-10", "debit", 50000, grocID, "confirmed")
	seedTx(t, st, "2026-06-12", "credit", 10000, grocID, "confirmed")
	seedTx(t, st, "2026-06-15", "debit", 99999, grocID, "needs_review")
	seedTx(t, st, "2026-05-30", "debit", 77777, grocID, "confirmed")

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
	seedTx(t, st, "2026-06-01", "credit", 500000, salaryID, "needs_review")
	got, err := st.SelectMonthIncome("2026-06")
	if err != nil {
		t.Fatal(err)
	}
	if got != 2000000 {
		t.Errorf("income = %d, want 2000000", got)
	}
}
