package store

import (
	"testing"
	"time"
)

// seedFXSpend inserts one AED and one USD confirmed debit in July 2026 under
// a spending/need category, plus one EUR debit with no rate (unconverted).
func seedFXSpend(t *testing.T, s *Store) (catID int64) {
	t.Helper()
	// Groceries is seeded by SeedDefaultCategories as spending/need.
	if err := s.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&catID); err != nil {
		t.Fatalf("find category: %v", err)
	}
	day := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	ins := func(amount int64, currency, merchant string) {
		t.Helper()
		id, created, err := s.InsertTransaction(TransactionRow{
			PostedAt: day, AmountFils: amount, Currency: currency,
			Direction: "debit", MerchantRaw: merchant, Status: "confirmed",
		})
		if err != nil || !created {
			t.Fatalf("insert %s: created=%v err=%v", merchant, created, err)
		}
		if _, err := s.DB.Exec(`UPDATE transactions SET category_id=? WHERE id=?`, catID, id); err != nil {
			t.Fatalf("categorize: %v", err)
		}
	}
	ins(10000, "AED", "carrefour") // AED 100.00
	ins(1009, "USD", "hetzner")    // -> AED 37.06 via seeded peg
	ins(2412, "EUR", "seychelles") // no EUR rate -> unconverted, counts 0
	return catID
}

func TestMonthSpendUsesAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	seedFXSpend(t, s)
	rows, err := s.SelectMonthSpend("2026-07", false)
	if err != nil {
		t.Fatalf("SelectMonthSpend: %v", err)
	}
	var total int64
	for _, r := range rows {
		total += r.AmountFils
	}
	if total != 13706 { // 10000 + 3706 + 0
		t.Fatalf("month spend = %d, want 13706", total)
	}
}

func TestCategorySpendAndTotalsUseAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	seedFXSpend(t, s)
	cats, err := s.SelectCategorySpend("2026-07", false)
	if err != nil || len(cats) != 1 {
		t.Fatalf("SelectCategorySpend = %v, err=%v", cats, err)
	}
	if cats[0].AmountFils != 13706 {
		t.Fatalf("category spend = %d, want 13706", cats[0].AmountFils)
	}
	totals, err := s.SelectMonthlyTotals(24)
	if err != nil {
		t.Fatalf("SelectMonthlyTotals = %v, err=%v", totals, err)
	}
	var found bool
	for _, tot := range totals {
		if tot.Period != "2026-07" {
			continue
		}
		found = true
		if tot.SpentFils != 13706 {
			t.Fatalf("monthly spent = %d, want 13706", tot.SpentFils)
		}
	}
	if !found {
		t.Fatalf("SelectMonthlyTotals(24) = %v; missing period 2026-07", totals)
	}
}

func TestReviewItemCarriesAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	seedFXSpend(t, s)
	items, err := s.SelectTransactions("", "", "")
	if err != nil || len(items) != 3 {
		t.Fatalf("SelectTransactions = %d items, err=%v; want 3", len(items), err)
	}
	byMerchant := map[string]ReviewItem{}
	for _, it := range items {
		byMerchant[it.MerchantRaw] = it
	}
	if v := byMerchant["hetzner"].AmountAedFils; v == nil || *v != 3706 {
		t.Fatalf("usd AmountAedFils = %v, want 3706", v)
	}
	if v := byMerchant["seychelles"].AmountAedFils; v != nil {
		t.Fatalf("eur AmountAedFils = %v, want nil", v)
	}
	// SelectRecent feeds the same scanner — must not break.
	if _, err := s.SelectRecent(5); err != nil {
		t.Fatalf("SelectRecent: %v", err)
	}
}
