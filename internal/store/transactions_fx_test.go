package store

import (
	"testing"
	"time"
)

func TestInsertTransactionSetsAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	day := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name     string
		currency string
		amount   int64
		wantAED  *int64
	}{
		{"aed identity", "AED", 5000, i64p(5000)},
		{"empty defaults to aed", "", 700, i64p(700)},
		{"usd via seeded peg", "USD", 1009, i64p(3706)},
		{"unknown currency stays null", "EUR", 2412, nil},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			id, created, err := s.InsertTransaction(TransactionRow{
				PostedAt: day.AddDate(0, 0, i), AmountFils: c.amount, Currency: c.currency,
				Direction: "debit", MerchantRaw: c.name, Status: "confirmed",
			})
			if err != nil || !created {
				t.Fatalf("insert: created=%v err=%v", created, err)
			}
			var got *int64
			if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE id=?`, id).Scan(&got); err != nil {
				t.Fatalf("select: %v", err)
			}
			if (got == nil) != (c.wantAED == nil) || (got != nil && *got != *c.wantAED) {
				t.Fatalf("amount_aed = %v, want %v", deref(got), deref(c.wantAED))
			}
		})
	}
}

func TestInsertManualTransactionSetsAmountAED(t *testing.T) {
	s := openFXTestStore(t)
	id, err := s.InsertManualTransaction(ManualTxn{
		PostedAt:   time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		AmountFils: 1000, Currency: "USD", Direction: "debit", MerchantRaw: "m",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	var got int64
	if err := s.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE id=?`, id).Scan(&got); err != nil {
		t.Fatalf("select: %v", err)
	}
	if got != 3673 { // USD 10.00 * 3.6725 = AED 36.725 -> 3673 fils half-up
		t.Fatalf("amount_aed = %d, want 3673", got)
	}
}

func i64p(v int64) *int64 { return &v }

func deref(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
