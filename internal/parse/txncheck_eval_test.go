package parse

import (
	"context"
	"errors"
	"testing"
)

type subjCheck map[string]TxnVerdict

func (m subjCheck) Check(_ context.Context, _, subject, _ string) (TxnVerdict, error) {
	v, ok := m[subject]
	if !ok {
		return TxnVerdict{}, errors.New("boom")
	}
	return v, nil
}

func TestEvaluateTxnCheckCuts(t *testing.T) {
	chk := subjCheck{
		"promo":     {VerdictNotTxn, 0.995}, // non-txn, set aside at every cut
		"otp":       {VerdictNotTxn, 0.92},  // non-txn, set aside at 0.90 and 0.80
		"statement": {VerdictNotTxn, 0.95},  // non-txn exactly at a cut: set aside at 0.95 and below
		"spend":     {VerdictTxn, 0.99},     // txn, never set aside
		"refund":    {VerdictNotTxn, 0.96},  // txn wrongly called not: hidden at 0.95 and below
		"transfer":  {VerdictNotTxn, 0.9},   // txn exactly at a cut: hidden at 0.90 and below
	}
	samples := []TxnSample{
		{Subject: "promo"}, {Subject: "otp"}, {Subject: "statement"},
		{Subject: "spend", IsTxn: true}, {Subject: "refund", IsTxn: true},
		{Subject: "transfer", IsTxn: true}, {Subject: "broken", IsTxn: true},
	}
	r := EvaluateTxnCheck(t.Context(), samples, chk)
	if r.Total != 7 || r.Txns != 4 || r.NonTxns != 3 || r.Errors != 1 || r.FirstErr == nil {
		t.Fatalf("report = %+v", r)
	}
	// "broken" is a transaction whose call failed: it counts in Txns, not in
	// the answered totals the cut table divides by.
	if r.TxnsAnswered != 3 || r.NonTxnsAnswered != 3 {
		t.Fatalf("answered = %d txns, %d non-txns, want 3 and 3", r.TxnsAnswered, r.NonTxnsAnswered)
	}
	want := map[float64][2]int{0.99: {1, 0}, 0.97: {1, 0}, 0.95: {2, 1}, 0.9: {3, 2}, 0.8: {3, 2}}
	if len(r.Cuts) != len(want) {
		t.Fatalf("cuts = %+v", r.Cuts)
	}
	for _, c := range r.Cuts {
		if w := want[c.Min]; c.SetAside != w[0] || c.Hidden != w[1] {
			t.Errorf("cut %.2f = set aside %d hidden %d, want %d %d", c.Min, c.SetAside, c.Hidden, w[0], w[1])
		}
	}
}
