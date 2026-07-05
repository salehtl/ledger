package store

import (
	"testing"
	"time"
)

// seedTxn inserts a manual transaction and returns its id. categoryName ""
// leaves it uncategorized (status 'needs_review'); a seeded category name
// (e.g. "Groceries") stores it 'confirmed' with that category.
func seedTxn(t *testing.T, st *Store, direction, merchant string, amountFils int64, postedAt, categoryName string) int64 {
	t.Helper()
	var catID int64
	if categoryName != "" {
		if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name=?`, categoryName).Scan(&catID); err != nil {
			t.Fatalf("look up category %q: %v", categoryName, err)
		}
	}
	posted, err := time.Parse(time.RFC3339, postedAt)
	if err != nil {
		t.Fatalf("parse postedAt %q: %v", postedAt, err)
	}
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    posted,
		AmountFils:  amountFils,
		Direction:   direction,
		MerchantRaw: merchant,
		CategoryID:  catID,
	})
	if err != nil {
		t.Fatalf("insert txn: %v", err)
	}
	return id
}

func TestReviewItemCarriesRefundOfID(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Carrefour refund", 5000, "2026-07-03T10:00:00Z", "")
	if _, err := st.DB.Exec(`UPDATE transactions SET refund_of_id=? WHERE id=?`, debitID, creditID); err != nil {
		t.Fatalf("link: %v", err)
	}
	fetchers := map[string]func() ([]ReviewItem, error){
		"SelectTransactions": func() ([]ReviewItem, error) { return st.SelectTransactions("", "", "") },
		"SelectRecent":       func() ([]ReviewItem, error) { return st.SelectRecent(10) },
	}
	for name, fetch := range fetchers {
		items, err := fetch()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var credit, debit *ReviewItem
		for i := range items {
			switch items[i].ID {
			case creditID:
				credit = &items[i]
			case debitID:
				debit = &items[i]
			}
		}
		if credit == nil || debit == nil {
			t.Fatalf("%s: seeded rows missing from result", name)
		}
		if credit.RefundOfID == nil || *credit.RefundOfID != debitID {
			t.Errorf("%s: credit.RefundOfID = %v, want %d", name, credit.RefundOfID, debitID)
		}
		if debit.RefundOfID != nil {
			t.Errorf("%s: debit.RefundOfID = %v, want nil", name, debit.RefundOfID)
		}
	}
}
