package store

import (
	"reflect"
	"testing"
)

func TestSelectMerchantLabels(t *testing.T) {
	st := openTestStore(t)
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("categories: %v", err)
	}
	id := map[string]int64{}
	for _, c := range cats {
		id[c.Name] = c.ID
	}
	for _, n := range []string{"Groceries", "Dining", "Shopping"} {
		if id[n] == 0 {
			t.Fatalf("%s not in seed", n)
		}
	}
	add := func(day, merchant, status, cat string) {
		t.Helper()
		txID, _, err := st.InsertTransaction(TransactionRow{
			PostedAt: mustTime("2026-06-" + day + "T09:00:00Z"), AmountFils: 5000, Currency: "AED",
			Direction: "debit", MerchantRaw: merchant, Status: "needs_review", Source: "email",
		})
		if err != nil {
			t.Fatalf("insert %q: %v", merchant, err)
		}
		if err := st.UpdateTransactionCategory(txID, id[cat], status); err != nil {
			t.Fatalf("category %q: %v", merchant, err)
		}
	}
	add("01", "Carrefour MOE", "confirmed", "Groceries")
	add("02", "Carrefour MOE", "confirmed", "Groceries")
	add("03", " carrefour moe ", "confirmed", "Dining")
	add("04", "Talabat", "confirmed", "Dining")
	add("05", "Noon", "needs_review", "Shopping")
	add("06", "  ", "confirmed", "Shopping")

	got, err := st.SelectMerchantLabels()
	if err != nil {
		t.Fatalf("SelectMerchantLabels: %v", err)
	}
	want := []MerchantLabel{{"carrefour moe", "Groceries", 2}, {"talabat", "Dining", 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("labels = %+v, want %+v", got, want)
	}
}
