// internal/store/insights_test.go
package store

import "testing"

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
