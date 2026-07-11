package store

import "testing"

func TestBudgetCarveOut(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "Auto", "spending", "want")
	// two confirmed spends in 2026-07
	a := insertTxn(t, st, cat, "debit", 300_000, "2026-07-05", "confirmed")
	b := insertTxn(t, st, cat, "debit", 200_000, "2026-07-06", "confirmed")
	_ = a

	// carved-out project (count_in_monthly=0) holding txn b.
	pid, _ := st.InsertProject(ProjectRow{Name: "Car", Status: "active"}) // default carved out
	st.AssignTransactionProject(b, &pid)

	rows, _ := st.SelectMonthSpend("2026-07", false)
	var total int64
	for _, r := range rows {
		total += r.AmountFils
	}
	if total != 300_000 {
		t.Fatalf("month spend=%d want 300000 (b carved out)", total)
	}
	excl, _ := st.SelectMonthProjectExcluded("2026-07", false)
	if excl != 200_000 {
		t.Fatalf("excluded=%d want 200000", excl)
	}
	// Toggle project to count_in_monthly=1 → b re-enters.
	p, _ := st.SelectProject(pid)
	p.CountInMonthly = true
	st.UpdateProject(p)
	rows, _ = st.SelectMonthSpend("2026-07", false)
	total = 0
	for _, r := range rows {
		total += r.AmountFils
	}
	if total != 500_000 {
		t.Fatalf("month spend after toggle=%d want 500000", total)
	}
}
