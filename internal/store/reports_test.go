package store

import (
	"testing"
	"time"
)

// reportInsertCat seeds one category.
func reportInsertCat(t *testing.T, st *Store, name, kind, bucket string) int64 {
	t.Helper()
	id, err := st.InsertCategory(CategoryRow{Name: name, Kind: kind, Bucket: bucket, IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory(%s): %v", name, err)
	}
	return id
}

// reportInsertCatTxn seeds one categorized confirmed transaction.
func reportInsertCatTxn(t *testing.T, st *Store, catID int64, direction string, amountFils int64, postedAt, merchant string) int64 {
	t.Helper()
	id := reconInsertTxn(t, st, "", direction, amountFils, postedAt, "needs_review", merchant)
	if err := st.UpdateTransactionCategory(id, catID, "confirmed"); err != nil {
		t.Fatalf("UpdateTransactionCategory: %v", err)
	}
	return id
}

func TestNetWorthSeries(t *testing.T) {
	st := openTestStore(t)
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)

	budgetAcct, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	trackAcct, err := st.InsertAccount("Broker", "IBKR", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateAccountKind(trackAcct, "tracking"); err != nil {
		t.Fatal(err)
	}

	// Budget account: anchored mid-June at 1000.00, then a 200.00 debit in July.
	if _, err := st.InsertAccountBalance(AccountBalanceRow{
		AccountID: budgetAcct, AsOf: "2026-06-15T10:00:00Z", BalanceFils: 1000_00,
	}); err != nil {
		t.Fatal(err)
	}
	reconInsertTxn(t, st, "1234", "debit", 200_00, "2026-07-10T09:00:00Z", "confirmed", "july spend")
	// Tracking account: anchored in July at 5000.00.
	if _, err := st.InsertAccountBalance(AccountBalanceRow{
		AccountID: trackAcct, AsOf: "2026-07-05T10:00:00Z", BalanceFils: 5000_00,
	}); err != nil {
		t.Fatal(err)
	}

	points, err := st.NetWorthSeries(3, now)
	if err != nil {
		t.Fatalf("NetWorthSeries: %v", err)
	}
	if len(points) != 3 {
		t.Fatalf("got %d points, want 3", len(points))
	}
	tests := []struct {
		i                         int
		month                     string
		budget, tracking, wantNet int64
	}{
		{0, "2026-05", 0, 0, 0},                  // before any anchor
		{1, "2026-06", 1000_00, 0, 1000_00},      // anchor only
		{2, "2026-07", 800_00, 5000_00, 5800_00}, // anchor − July debit + tracking
	}
	for _, tc := range tests {
		p := points[tc.i]
		if p.Month != tc.month || p.BudgetFils != tc.budget || p.TrackingFils != tc.tracking || p.NetWorthFils != tc.wantNet {
			t.Errorf("point[%d] = %+v, want month=%s budget=%d tracking=%d net=%d",
				tc.i, p, tc.month, tc.budget, tc.tracking, tc.wantNet)
		}
	}
}

func TestIncomeExpenseMatrixWithSplits(t *testing.T) {
	st := openTestStore(t)
	salary := reportInsertCat(t, st, "RptSalary", "income", "")
	food := reportInsertCat(t, st, "RptFood", "spending", "need")
	fun := reportInsertCat(t, st, "RptFun", "spending", "want")

	reportInsertCatTxn(t, st, salary, "credit", 3000_00, "2026-06-01T08:00:00Z", "employer")
	reportInsertCatTxn(t, st, food, "debit", 100_00, "2026-06-05T08:00:00Z", "grocer june")
	// July: one plain spend and one split spend (60/40 across food/fun).
	reportInsertCatTxn(t, st, food, "debit", 50_00, "2026-07-03T08:00:00Z", "grocer july")
	splitParent := reportInsertCatTxn(t, st, food, "debit", 100_00, "2026-07-04T08:00:00Z", "hyper")
	if err := st.ReplaceTransactionSplits(splitParent, []TransactionSplitRow{
		{CategoryID: food, AmountFils: 60_00},
		{CategoryID: fun, AmountFils: 40_00},
	}); err != nil {
		t.Fatalf("ReplaceTransactionSplits: %v", err)
	}

	rows, err := st.IncomeExpenseMatrix("2026-06", "2026-07")
	if err != nil {
		t.Fatalf("IncomeExpenseMatrix: %v", err)
	}
	got := make(map[string]int64)
	for _, r := range rows {
		got[r.Name+"|"+r.Month] = r.NetFils
	}
	want := map[string]int64{
		"RptSalary|2026-06": -3000_00, // credit-dominant → negative net (debit − credit)
		"RptFood|2026-06":   100_00,
		"RptFood|2026-07":   50_00 + 60_00, // plain spend + its split share; parent not double-counted
		"RptFun|2026-07":    40_00,
	}
	if len(got) != len(want) {
		t.Fatalf("got %d cells %v, want %d", len(got), got, len(want))
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("cell %s = %d, want %d", k, got[k], v)
		}
	}
	// Income block sorts first.
	if rows[0].Kind != "income" {
		t.Errorf("first row kind = %s, want income", rows[0].Kind)
	}
}

func TestSelectCashflowForAge(t *testing.T) {
	st := openTestStore(t)
	salary := reportInsertCat(t, st, "RptSalary", "income", "")
	food := reportInsertCat(t, st, "RptFood", "spending", "need")
	fun := reportInsertCat(t, st, "RptFun", "spending", "want")

	reportInsertCatTxn(t, st, salary, "credit", 1000_00, "2026-07-01T08:00:00Z", "employer")
	reportInsertCatTxn(t, st, food, "debit", 100_00, "2026-07-05T08:00:00Z", "grocer")
	// Split parent (category NULL) still counts as one whole spend.
	parent := reportInsertCatTxn(t, st, food, "debit", 80_00, "2026-07-06T08:00:00Z", "hyper")
	if err := st.ReplaceTransactionSplits(parent, []TransactionSplitRow{
		{CategoryID: food, AmountFils: 50_00},
		{CategoryID: fun, AmountFils: 30_00},
	}); err != nil {
		t.Fatal(err)
	}
	// Uncounted: needs_review debit, income-category debit, transfer.
	reconInsertTxn(t, st, "", "debit", 5_00, "2026-07-07T08:00:00Z", "needs_review", "pending")

	flows, err := st.SelectCashflowForAge()
	if err != nil {
		t.Fatalf("SelectCashflowForAge: %v", err)
	}
	if len(flows) != 3 {
		t.Fatalf("got %d flows, want 3: %+v", len(flows), flows)
	}
	if !flows[0].IsIncome || flows[0].AmountFils != 1000_00 {
		t.Errorf("flow[0] = %+v, want income 1000_00", flows[0])
	}
	if flows[1].IsIncome || flows[1].AmountFils != 100_00 {
		t.Errorf("flow[1] = %+v, want spend 100_00", flows[1])
	}
	if flows[2].IsIncome || flows[2].AmountFils != 80_00 {
		t.Errorf("flow[2] = %+v, want split-parent spend 80_00", flows[2])
	}
}

// TestSelectCashflowForAgeKeepsSplitIncome: splitting a salary credit must
// never delete it from the age-of-money stream (budget.go guarantees the same
// for income/RTA) — the income arrives through its income-kind split lines,
// AED-exact.
func TestSelectCashflowForAgeKeepsSplitIncome(t *testing.T) {
	st := openTestStore(t)
	salary := reportInsertCat(t, st, "AgeSalary", "income", "")
	bonus := reportInsertCat(t, st, "AgeBonus", "income", "")
	food := reportInsertCat(t, st, "AgeFood", "spending", "need")

	parent := reportInsertCatTxn(t, st, salary, "credit", 100_000, "2026-07-01T08:00:00Z", "employer")
	reportInsertCatTxn(t, st, food, "debit", 20_000, "2026-07-05T08:00:00Z", "grocer")

	base, err := st.SelectCashflowForAge()
	if err != nil {
		t.Fatal(err)
	}
	if len(base) != 2 || !base[0].IsIncome {
		t.Fatalf("pre-split flows = %+v, want income + spend", base)
	}

	// Split the salary into two income lines: the stream must keep the full
	// 100_000 of income (as two lots), not drop to just the spend.
	if err := st.ReplaceTransactionSplits(parent, []TransactionSplitRow{
		{CategoryID: salary, AmountFils: 70_000},
		{CategoryID: bonus, AmountFils: 30_000},
	}); err != nil {
		t.Fatal(err)
	}
	flows, err := st.SelectCashflowForAge()
	if err != nil {
		t.Fatal(err)
	}
	var incomeTotal, spendTotal int64
	for _, f := range flows {
		if f.IsIncome {
			incomeTotal += f.AmountFils
		} else {
			spendTotal += f.AmountFils
		}
	}
	if incomeTotal != 100_000 {
		t.Fatalf("income after split = %d (flows %+v), want 100000 — split salary vanished from the stream", incomeTotal, flows)
	}
	if spendTotal != 20_000 {
		t.Fatalf("spend after split = %d, want 20000", spendTotal)
	}
	// Chronology preserved: income lots still precede the spend.
	if len(flows) != 3 || !flows[0].IsIncome || !flows[1].IsIncome || flows[2].IsIncome {
		t.Fatalf("flow order = %+v, want [income income spend]", flows)
	}
}

// TestIncomeExpenseMatrixIgnoresUnconvertedForeign: a foreign row with no FX
// rate must contribute nothing (jar convention) — not raw foreign minor units.
func TestIncomeExpenseMatrixIgnoresUnconvertedForeign(t *testing.T) {
	st := openTestStore(t)
	food := reportInsertCat(t, st, "FxNilFood", "spending", "need")
	reportInsertCatTxn(t, st, food, "debit", 40_00, "2026-07-03T08:00:00Z", "aed spend")
	gbp := reportInsertCatTxn(t, st, food, "debit", 100_00, "2026-07-04T08:00:00Z", "london shop")
	if _, err := st.DB.Exec(`UPDATE transactions SET currency='GBP', amount_aed=NULL WHERE id=?`, gbp); err != nil {
		t.Fatal(err)
	}
	rows, err := st.IncomeExpenseMatrix("2026-07", "2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].NetFils != 40_00 {
		t.Fatalf("rows = %+v, want single cell of 4000 (unconverted GBP contributes 0)", rows)
	}
}

// TestNetWorthSeriesDayGranularWindow mirrors the check-in window fix: a
// midnight-dated transaction on the anchor's calendar day is part of the
// stated balance (not re-subtracted), while later days count once.
func TestNetWorthSeriesDayGranularWindow(t *testing.T) {
	st := openTestStore(t)
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	acct, err := st.InsertAccount("Main", "DIB", "4242")
	if err != nil {
		t.Fatal(err)
	}
	// Check-in mid-day on July 10 stating 1000.00 — which already includes the
	// morning's midnight-dated 50.00 spend.
	reconInsertTxn(t, st, "4242", "debit", 50_00, "2026-07-10T00:00:00Z", "confirmed", "same-day spend")
	if _, err := st.InsertAccountBalance(AccountBalanceRow{
		AccountID: acct, AsOf: "2026-07-10T16:37:00Z", BalanceFils: 1000_00,
	}); err != nil {
		t.Fatal(err)
	}
	reconInsertTxn(t, st, "4242", "debit", 30_00, "2026-07-11T00:00:00Z", "confirmed", "next-day spend")

	points, err := st.NetWorthSeries(1, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].Month != "2026-07" {
		t.Fatalf("points = %+v", points)
	}
	// 1000.00 anchor − 30.00 (next day). The same-day 50.00 must NOT be
	// subtracted again.
	if points[0].BudgetFils != 970_00 {
		t.Fatalf("July net worth = %d, want 97000 (anchor covers its own day)", points[0].BudgetFils)
	}
}

// TestIncomeExpenseMatrixForeignSplitExact: a foreign-currency parent's split
// lines must sum to exactly the parent's AED in the matrix — cumulative-floor
// scaling, no lost fils.
func TestIncomeExpenseMatrixForeignSplitExact(t *testing.T) {
	st := openTestStore(t)
	food := reportInsertCat(t, st, "FxMxFood", "spending", "need")
	fun := reportInsertCat(t, st, "FxMxFun", "spending", "want")

	parent := reportInsertCatTxn(t, st, food, "debit", 10_000, "2026-07-04T08:00:00Z", "usd shop")
	if _, err := st.DB.Exec(`UPDATE transactions SET currency='USD', amount_aed=36730 WHERE id=?`, parent); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceTransactionSplits(parent, []TransactionSplitRow{
		{CategoryID: food, AmountFils: 3_333},
		{CategoryID: fun, AmountFils: 3_333},
		{CategoryID: fun, AmountFils: 3_334},
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.IncomeExpenseMatrix("2026-07", "2026-07")
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, r := range rows {
		total += r.NetFils
	}
	if total != 36_730 {
		t.Fatalf("matrix total = %d, want exactly the parent's 36730 AED fils", total)
	}
}

// TestSelectCashflowForAgeSplitParentNeverDoubleCounts: even if a split
// income credit somehow carries a category (legacy rows written before the
// UpdateTransactionCategory split guard existed), the income-credit arm's
// NOT EXISTS exclusion keeps it out — the income flows through its split
// lines exactly once, never both whole-parent AND per-line.
func TestSelectCashflowForAgeSplitParentNeverDoubleCounts(t *testing.T) {
	st := openTestStore(t)
	salary := reportInsertCat(t, st, "DblSalary", "income", "")
	bonus := reportInsertCat(t, st, "DblBonus", "income", "")

	parent := reportInsertCatTxn(t, st, salary, "credit", 100_000, "2026-07-01T08:00:00Z", "employer")
	if err := st.ReplaceTransactionSplits(parent, []TransactionSplitRow{
		{CategoryID: salary, AmountFils: 60_000},
		{CategoryID: bonus, AmountFils: 40_000},
	}); err != nil {
		t.Fatal(err)
	}
	// Simulate the pre-guard corrupt state: a categorized split parent.
	if _, err := st.DB.Exec(`UPDATE transactions SET category_id=? WHERE id=?`, salary, parent); err != nil {
		t.Fatal(err)
	}

	flows, err := st.SelectCashflowForAge()
	if err != nil {
		t.Fatal(err)
	}
	var incomeTotal int64
	for _, f := range flows {
		if f.IsIncome {
			incomeTotal += f.AmountFils
		}
	}
	if incomeTotal != 100_000 {
		t.Fatalf("income = %d, want 100000 — categorized split parent double-counted", incomeTotal)
	}
	// SelectMonthIncome already guards this; the two must agree.
	if monthIncome, err := st.SelectMonthIncome("2026-07"); err != nil || monthIncome != 100_000 {
		t.Fatalf("month income = %d err=%v, want 100000", monthIncome, err)
	}
}

// TestNetWorthSeriesIgnoresUnconvertedForeign pins the AED convention on the
// net-worth series: a foreign-currency transaction with no FX rate configured
// contributes NOTHING to a month-end balance — never its raw foreign minor
// units (THB 100.00 must not move the series by AED 100.00). It backfills
// when a rate is added, like every other AED aggregate.
func TestNetWorthSeriesIgnoresUnconvertedForeign(t *testing.T) {
	st := openTestStore(t)
	now := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	if _, err := st.InsertAccount("Main", "DIB", "3333"); err != nil {
		t.Fatal(err)
	}
	acct, err := st.SelectAccounts()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertAccountBalance(AccountBalanceRow{
		AccountID: acct[0].ID, AsOf: "2026-07-01T10:00:00Z", BalanceFils: 1000_00,
	}); err != nil {
		t.Fatal(err)
	}
	reconInsertTxn(t, st, "3333", "debit", 200_00, "2026-07-10T00:00:00Z", "confirmed", "aed spend")
	thb := reconInsertTxn(t, st, "3333", "debit", 100_00, "2026-07-11T00:00:00Z", "confirmed", "bangkok cafe")
	if _, err := st.DB.Exec(`UPDATE transactions SET currency='THB', amount_aed=NULL WHERE id=?`, thb); err != nil {
		t.Fatal(err)
	}

	points, err := st.NetWorthSeries(1, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].NetWorthFils != 1000_00-200_00 {
		t.Fatalf("points = %+v, want single 2026-07 at 80000 (unconverted THB contributes 0)", points)
	}

	// Rate configured → the row backfills and the series moves.
	if err := st.UpsertFXRate("THB", 110_000); err != nil {
		t.Fatal(err)
	}
	if _, err := st.ConvertUnconverted(); err != nil {
		t.Fatal(err)
	}
	points, err = st.NetWorthSeries(1, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 || points[0].NetWorthFils != 1000_00-200_00-11_00 {
		t.Fatalf("points after rate = %+v, want 78900", points)
	}
}
