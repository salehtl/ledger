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
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, category_id, status, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, ?, 'AED', ?, 'M', ?, ?, ?, 'email', '2026-06-01', '2026-06-01')`,
		postedAt, amount, amount, direction, catID, status,
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
	mk("debit", "confirmed", at)               // real spend: counts
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

// sumMonthSpend nets a SelectMonthSpend result (debit +, credit −) and buckets
// the debit-side fils.
func sumMonthSpend(t *testing.T, st *Store, period string) (total int64, byBucket map[string]int64) {
	t.Helper()
	rows, err := st.SelectMonthSpend(period, false)
	if err != nil {
		t.Fatalf("SelectMonthSpend: %v", err)
	}
	byBucket = map[string]int64{}
	for _, r := range rows {
		if r.Direction == "credit" {
			total -= r.AmountFils
			byBucket[r.Bucket] -= r.AmountFils
			continue
		}
		total += r.AmountFils
		byBucket[r.Bucket] += r.AmountFils
	}
	return total, byBucket
}

// TestMonthSpendUnchangedBySplit is the "splitting must never delete money
// from the jars" regression: the Home 50/30/20 summary total is identical
// before and after splitting — the split only re-buckets the fils.
func TestMonthSpendUnchangedBySplit(t *testing.T) {
	st := newTestStore(t)
	need := insertCategory(t, st, "SplitJarNeed", "spending", "need")
	want := insertCategory(t, st, "SplitJarWant", "spending", "want")

	txID := insertTxn(t, st, need, "debit", 20_000, "2026-07-10", "confirmed")
	if total, _ := sumMonthSpend(t, st, "2026-07"); total != 20_000 {
		t.Fatalf("pre-split total = %d, want 20000", total)
	}

	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: need, AmountFils: 15_000},
		{CategoryID: want, AmountFils: 5_000},
	}); err != nil {
		t.Fatal(err)
	}
	total, byBucket := sumMonthSpend(t, st, "2026-07")
	if total != 20_000 {
		t.Fatalf("post-split total = %d, want 20000 (splitting deleted spend from the jars)", total)
	}
	if byBucket["need"] != 15_000 || byBucket["want"] != 5_000 {
		t.Errorf("post-split buckets = %v, want need 15000 / want 5000", byBucket)
	}

	// Un-splitting leaves the parent uncategorized → it drops out until
	// recategorized (documented API behavior), not silently double-counted.
	if err := st.ReplaceTransactionSplits(txID, nil); err != nil {
		t.Fatal(err)
	}
	if total, _ := sumMonthSpend(t, st, "2026-07"); total != 0 {
		t.Errorf("un-split uncategorized parent leaked %d fils into spend", total)
	}
}

// TestMonthIncomeUnchangedBySplit: splitting an income credit across income
// categories must not delete it from month income (jar income AND the
// envelope RTA when income_source=categories).
func TestMonthIncomeUnchangedBySplit(t *testing.T) {
	st := newTestStore(t)
	salaryA := insertCategory(t, st, "SplitIncA", "income", "")
	salaryB := insertCategory(t, st, "SplitIncB", "income", "")
	spend := insertCategory(t, st, "SplitIncSpend", "spending", "need")

	txID := insertTxn(t, st, salaryA, "credit", 300_000, "2026-07-01", "confirmed")
	if got, err := st.SelectMonthIncome("2026-07"); err != nil || got != 300_000 {
		t.Fatalf("pre-split income = %d err=%v, want 300000", got, err)
	}
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: salaryA, AmountFils: 250_000},
		{CategoryID: salaryB, AmountFils: 40_000},
		{CategoryID: spend, AmountFils: 10_000}, // spending line: not income
	}); err != nil {
		t.Fatal(err)
	}
	if got, err := st.SelectMonthIncome("2026-07"); err != nil || got != 290_000 {
		t.Fatalf("post-split income = %d err=%v, want 290000 (income lines only)", got, err)
	}
}

// TestMonthProjectExcludedUnchangedBySplit: the "excludes AED X in project
// spend" note keeps its figure when a project-carved transaction is split.
func TestMonthProjectExcludedUnchangedBySplit(t *testing.T) {
	st := newTestStore(t)
	need := insertCategory(t, st, "SplitProjNeed", "spending", "need")
	want := insertCategory(t, st, "SplitProjWant", "spending", "want")
	projID, err := st.InsertProject(ProjectRow{Name: "Split Reno", Status: "active"}) // count_in_monthly=0
	if err != nil {
		t.Fatal(err)
	}
	txID := insertTxn(t, st, need, "debit", 80_000, "2026-07-12", "confirmed")
	if err := st.AssignTransactionProject(txID, &projID); err != nil {
		t.Fatal(err)
	}
	if got, err := st.SelectMonthProjectExcluded("2026-07", false); err != nil || got != 80_000 {
		t.Fatalf("pre-split excluded = %d err=%v, want 80000", got, err)
	}
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: need, AmountFils: 50_000},
		{CategoryID: want, AmountFils: 30_000},
	}); err != nil {
		t.Fatal(err)
	}
	if got, err := st.SelectMonthProjectExcluded("2026-07", false); err != nil || got != 80_000 {
		t.Fatalf("post-split excluded = %d err=%v, want 80000", got, err)
	}
	// And the carved-out spend still never leaks into the jars.
	if total, _ := sumMonthSpend(t, st, "2026-07"); total != 0 {
		t.Errorf("project-excluded split leaked %d fils into month spend", total)
	}
}
