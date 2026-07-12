package store

import "testing"

func TestProjectRollupNetAndPending(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "Parts", "spending", "want")
	pid, _ := st.InsertProject(ProjectRow{Name: "Car", Status: "active"})

	// confirmed: 500k debit + 100k debit, minus a 150k credit (sold a part) = 450k net.
	a := insertTxn(t, st, cat, "debit", 500_000, "2026-07-01", "confirmed")
	b := insertTxn(t, st, cat, "debit", 100_000, "2026-07-02", "confirmed")
	c := insertTxn(t, st, cat, "credit", 150_000, "2026-07-03", "confirmed")
	// pending: 80k debit, not in net, in pending.
	d := insertTxn(t, st, cat, "debit", 80_000, "2026-07-04", "needs_review")
	for _, id := range []int64{a, b, c, d} {
		st.AssignTransactionProject(id, &pid)
	}
	r, err := st.ProjectRollup(pid)
	if err != nil {
		t.Fatal(err)
	}
	if r.NetSpentFils != 450_000 {
		t.Fatalf("net=%d want 450000", r.NetSpentFils)
	}
	if r.PendingFils != 80_000 {
		t.Fatalf("pending=%d want 80000", r.PendingFils)
	}
	if r.TxnCount != 3 {
		t.Fatalf("txncount=%d want 3 (confirmed only)", r.TxnCount)
	}
	if len(r.ByCategory) != 1 || r.ByCategory[0].Category != "Parts" || r.ByCategory[0].NetFils != 450_000 {
		t.Fatalf("bycategory=%+v", r.ByCategory)
	}
}
