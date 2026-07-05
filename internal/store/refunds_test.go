package store

import (
	"database/sql"
	"errors"
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

func TestLinkRefundCopiesCategoryAndConfirms(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Carrefour refund", 5000, "2026-07-03T10:00:00Z", "")

	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}

	var refundOf, catID sql.NullInt64
	var status string
	if err := st.DB.QueryRow(
		`SELECT refund_of_id, category_id, status FROM transactions WHERE id=?`, creditID,
	).Scan(&refundOf, &catID, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !refundOf.Valid || refundOf.Int64 != debitID {
		t.Errorf("refund_of_id = %v, want %d", refundOf, debitID)
	}
	var groceriesID int64
	if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name='Groceries'`).Scan(&groceriesID); err != nil {
		t.Fatal(err)
	}
	if !catID.Valid || catID.Int64 != groceriesID {
		t.Errorf("category_id = %v, want %d (Groceries)", catID, groceriesID)
	}
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}

	// The linked credit must net the purchase out of the month's Need bucket.
	spend, err := st.SelectMonthSpend("2026-07", false)
	if err != nil {
		t.Fatalf("SelectMonthSpend: %v", err)
	}
	var net int64
	for _, r := range spend {
		if r.Bucket != "need" {
			continue
		}
		if r.Direction == "debit" {
			net += r.AmountFils
		} else {
			net -= r.AmountFils
		}
	}
	if net != 0 {
		t.Errorf("need bucket net = %d fils, want 0 (refund should cancel purchase)", net)
	}
}

func TestLinkRefundValidation(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	otherCredit := seedTxn(t, st, "credit", "Other credit", 900, "2026-07-02T10:00:00Z", "")
	pendingDebit := seedTxn(t, st, "debit", "Pending", 700, "2026-07-02T10:00:00Z", "") // needs_review, uncategorized

	cases := []struct {
		name          string
		credit, debit int64
		wantErr       error
	}{
		{"credit missing", 99999, debitID, ErrRefundNotFound},
		{"target missing", creditID, 99999, ErrRefundNotFound},
		{"credit is a debit", debitID, debitID, ErrRefundBadLink},
		{"target is a credit", creditID, otherCredit, ErrRefundBadLink},
		{"target unconfirmed", creditID, pendingDebit, ErrRefundBadLink},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := st.LinkRefund(tc.credit, tc.debit); !errors.Is(err, tc.wantErr) {
				t.Errorf("LinkRefund = %v, want errors.Is(_, %v)", err, tc.wantErr)
			}
		})
	}
}

func TestUnlinkRefundRevertsToReview(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}

	if err := st.UnlinkRefund(creditID); err != nil {
		t.Fatalf("UnlinkRefund: %v", err)
	}
	var refundOf, catID sql.NullInt64
	var status string
	if err := st.DB.QueryRow(
		`SELECT refund_of_id, category_id, status FROM transactions WHERE id=?`, creditID,
	).Scan(&refundOf, &catID, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if refundOf.Valid || catID.Valid || status != "needs_review" {
		t.Errorf("after unlink: refund_of=%v cat=%v status=%q, want NULL/NULL/needs_review", refundOf, catID, status)
	}

	// Unlinking a transaction that isn't linked is a not-found error.
	if err := st.UnlinkRefund(creditID); !errors.Is(err, ErrRefundNotFound) {
		t.Errorf("second UnlinkRefund = %v, want ErrRefundNotFound", err)
	}
}

func TestClearAllCategorizationClearsRefundLinks(t *testing.T) {
	st := openTestStore(t)
	debitID := seedTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}
	if _, err := st.ClearAllCategorization(); err != nil {
		t.Fatalf("ClearAllCategorization: %v", err)
	}
	var refundOf sql.NullInt64
	if err := st.DB.QueryRow(`SELECT refund_of_id FROM transactions WHERE id=?`, creditID).Scan(&refundOf); err != nil {
		t.Fatal(err)
	}
	if refundOf.Valid {
		t.Errorf("refund_of_id survived bulk clear, want NULL")
	}
}
