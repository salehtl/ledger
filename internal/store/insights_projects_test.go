package store

import (
	"testing"
	"time"
)

// Insights must apply the same carve-out as the monthly jars: confirmed spend
// assigned to a count_in_monthly=0 project stays out of the per-category and
// monthly-trend aggregates, so Home and Insights agree about the month.
// Dates are relative to now because SelectMonthlyTotals windows on time.Now().
func TestInsightsCarveOutExcludedProjectSpend(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "Furniture", "spending", "want")
	today := time.Now().UTC().Format("2006-01-02")
	period := time.Now().UTC().Format("2006-01")

	a := insertTxn(t, st, cat, "debit", 100_000, today, "confirmed")
	b := insertTxn(t, st, cat, "debit", 40_000, today, "confirmed")
	_ = a

	pid, _ := st.InsertProject(ProjectRow{Name: "Reno", Status: "active"}) // count_in_monthly=0
	if err := st.AssignTransactionProject(b, &pid); err != nil {
		t.Fatalf("assign: %v", err)
	}

	rows, err := st.SelectCategorySpend(period, false)
	if err != nil {
		t.Fatalf("category spend: %v", err)
	}
	if len(rows) != 1 || rows[0].AmountFils != 100_000 {
		t.Fatalf("category spend = %+v, want single Furniture row of 100000 (b carved out)", rows)
	}

	totals, err := st.SelectMonthlyTotals(1)
	if err != nil {
		t.Fatalf("monthly totals: %v", err)
	}
	if len(totals) != 1 || totals[0].SpentFils != 100_000 {
		t.Fatalf("monthly totals = %+v, want spent 100000 (b carved out)", totals)
	}

	// Opting the project into the monthly budget brings b back everywhere.
	p, _ := st.SelectProject(pid)
	p.CountInMonthly = true
	if err := st.UpdateProject(p); err != nil {
		t.Fatalf("update project: %v", err)
	}
	rows, _ = st.SelectCategorySpend(period, false)
	if len(rows) != 1 || rows[0].AmountFils != 140_000 {
		t.Fatalf("category spend after opt-in = %+v, want 140000", rows)
	}
	totals, _ = st.SelectMonthlyTotals(1)
	if len(totals) != 1 || totals[0].SpentFils != 140_000 {
		t.Fatalf("monthly totals after opt-in = %+v, want spent 140000", totals)
	}
}

// Income is never carved out: a credit in an excluded project must not
// disappear from the trend's income series.
func TestInsightsCarveOutLeavesIncomeAlone(t *testing.T) {
	st := newTestStore(t)
	inc := insertCategory(t, st, "Consulting income", "income", "")
	today := time.Now().UTC().Format("2006-01-02")

	txn := insertTxn(t, st, inc, "credit", 500_000, today, "confirmed")
	pid, _ := st.InsertProject(ProjectRow{Name: "Side gig", Status: "active"})
	if err := st.AssignTransactionProject(txn, &pid); err != nil {
		t.Fatalf("assign: %v", err)
	}

	totals, err := st.SelectMonthlyTotals(1)
	if err != nil {
		t.Fatalf("monthly totals: %v", err)
	}
	if len(totals) != 1 || totals[0].IncomeFils != 500_000 {
		t.Fatalf("monthly totals = %+v, want income 500000", totals)
	}
}
