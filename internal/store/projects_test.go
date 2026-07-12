package store

import (
	"testing"
	"time"
)

// insertCategory seeds a category via the existing store method (mirrors
// how budget_test.go/refunds_test.go seed categories, but through
// InsertCategory rather than a parallel raw INSERT).
func insertCategory(t *testing.T, st *Store, name, kind, bucket string) int64 {
	t.Helper()
	id, err := st.InsertCategory(CategoryRow{Name: name, Kind: kind, Bucket: bucket, IsActive: true})
	if err != nil {
		t.Fatalf("insertCategory: %v", err)
	}
	return id
}

// insertTxn seeds a confirmed manual transaction against catID via
// InsertManualTransaction (same helper transactions.go already exposes;
// see refunds_test.go's seedTxn for the same pattern).
func insertTxn(t *testing.T, st *Store, catID int64, direction string, amountFils int64, postedAt, status string) int64 {
	t.Helper()
	posted, err := time.Parse("2006-01-02", postedAt)
	if err != nil {
		t.Fatalf("insertTxn: parse postedAt %q: %v", postedAt, err)
	}
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    posted,
		AmountFils:  amountFils,
		Direction:   direction,
		MerchantRaw: "Test Merchant",
		CategoryID:  catID,
	})
	if err != nil {
		t.Fatalf("insertTxn: %v", err)
	}
	if status != "" && status != "confirmed" {
		if err := st.UpdateTransactionStatus(id, status); err != nil {
			t.Fatalf("insertTxn: set status: %v", err)
		}
	}
	return id
}

func TestProjectCRUD(t *testing.T) {
	st := newTestStore(t) // shared helper (adds EnsureAppSettings); see ingest_test.go
	st.SetNow(func() int64 { return 1_000_000 })

	budget := int64(3_000_000)
	id, err := st.InsertProject(ProjectRow{Name: "Project Car", BudgetFils: &budget, Color: "#c2703d", EndsOn: "2026-09-30", Status: "active"})
	if err != nil || id == 0 {
		t.Fatalf("insert: id=%d err=%v", id, err)
	}
	got, err := st.SelectProject(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Project Car" || got.BudgetFils == nil || *got.BudgetFils != budget || got.CountInMonthly {
		t.Fatalf("got %+v", got)
	}
	// Update: mark completed + clear budget.
	got.Status = "completed"
	got.CompletedAt = "2026-10-01"
	got.BudgetFils = nil
	if err := st.UpdateProject(got); err != nil {
		t.Fatal(err)
	}
	// Default list excludes completed; include flag returns it.
	active, _ := st.SelectProjects(false)
	if len(active) != 0 {
		t.Fatalf("active list should be empty, got %d", len(active))
	}
	all, _ := st.SelectProjects(true)
	if len(all) != 1 || all[0].BudgetFils != nil {
		t.Fatalf("all=%+v", all)
	}
}

func TestAssignAndDeleteUnassigns(t *testing.T) {
	st := newTestStore(t)
	// Seed a category + two confirmed transactions via the existing store
	// methods (InsertCategory / InsertManualTransaction), same pattern as
	// budget_test.go/refunds_test.go use.
	catID := insertCategory(t, st, "Auto", "spending", "want")
	t1 := insertTxn(t, st, catID, "debit", 500_000, "2026-07-01", "confirmed")
	t2 := insertTxn(t, st, catID, "debit", 200_000, "2026-07-02", "confirmed")

	pid, _ := st.InsertProject(ProjectRow{Name: "Car", Status: "active"})
	if err := st.AssignTransactionProject(t1, &pid); err != nil {
		t.Fatal(err)
	}
	n, err := st.BulkAssignProject(pid, []int64{t2})
	if err != nil || n != 1 {
		t.Fatalf("bulk assign n=%d err=%v", n, err)
	}
	// Delete un-assigns, keeps transactions.
	if err := st.DeleteProject(pid); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SelectProject(pid); err == nil {
		t.Fatal("project should be gone")
	}
	// Transactions still exist with project_id cleared.
	var cnt, withProj int
	st.DB.QueryRow(`SELECT COUNT(*), COUNT(project_id) FROM transactions WHERE id IN (?,?)`, t1, t2).Scan(&cnt, &withProj)
	if cnt != 2 || withProj != 0 {
		t.Fatalf("cnt=%d withProj=%d, want 2/0", cnt, withProj)
	}
}
