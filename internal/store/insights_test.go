// internal/store/insights_test.go
package store

import (
	"testing"
	"time"
)

func TestSelectCategorySpend(t *testing.T) {
	st := openTestStore(t)
	cats, _ := st.SelectCategories()
	id := func(name string) int64 {
		for _, c := range cats {
			if c.Name == name {
				return c.ID
			}
		}
		t.Fatalf("no category %q", name)
		return 0
	}
	add := func(merchant string, fils int64, cat int64) {
		tid, _, err := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime("2026-06-10T09:00:00Z"), AmountFils: fils, Currency: "AED",
			Direction: "debit", MerchantRaw: merchant, Status: "confirmed", Source: "email",
		})
		if err != nil {
			t.Fatalf("insert: %v", err)
		}
		if err := st.UpdateTransactionCategory(tid, cat, "confirmed"); err != nil {
			t.Fatalf("setcat: %v", err)
		}
	}
	add("SPINNEYS", 5000, id("Groceries"))
	add("CARREFOUR", 3000, id("Groceries"))
	add("NETFLIX", 4000, id("Subscriptions"))

	rows, err := st.SelectCategorySpend("2026-06", false)
	if err != nil {
		t.Fatalf("category spend: %v", err)
	}
	// Sorted by spend desc: Groceries 8000 (need), Subscriptions 4000 (want)
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	if rows[0].Name != "Groceries" || rows[0].AmountFils != 8000 || rows[0].Bucket != "need" {
		t.Fatalf("row0 = %+v", rows[0])
	}
	if rows[1].Name != "Subscriptions" || rows[1].AmountFils != 4000 {
		t.Fatalf("row1 = %+v", rows[1])
	}
}

func TestSelectMonthlyTotals(t *testing.T) {
	st := openTestStore(t)
	cats, _ := st.SelectCategories()
	gid, sid := int64(0), int64(0)
	for _, c := range cats {
		if c.Name == "Groceries" {
			gid = c.ID
		}
		if c.Name == "Salary" {
			sid = c.ID
		}
	}
	if sid == 0 {
		t.Skip("no Salary income category in seed; adjust to an income category name present in seedCategories")
	}
	spend := func(ts string, fils int64) {
		tid, _, _ := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime(ts), AmountFils: fils, Currency: "AED",
			Direction: "debit", MerchantRaw: "X", Status: "confirmed", Source: "email",
		})
		st.UpdateTransactionCategory(tid, gid, "confirmed")
	}
	income := func(ts string, fils int64) {
		tid, _, _ := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime(ts), AmountFils: fils, Currency: "AED",
			Direction: "credit", MerchantRaw: "PAY", Status: "confirmed", Source: "email",
		})
		st.UpdateTransactionCategory(tid, sid, "confirmed")
	}
	spend("2026-06-05T09:00:00Z", 5000)
	spend("2026-06-20T09:00:00Z", 3000)
	income("2026-06-01T09:00:00Z", 100000)

	rows, err := st.SelectMonthlyTotals(3)
	if err != nil {
		t.Fatalf("monthly totals: %v", err)
	}
	// Find the 2026-06 bucket.
	var june MonthlyTotalRow
	for _, r := range rows {
		if r.Period == "2026-06" {
			june = r
		}
	}
	if june.SpentFils != 8000 || june.IncomeFils != 100000 {
		t.Fatalf("june = %+v, want spent 8000 income 100000", june)
	}
}

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
