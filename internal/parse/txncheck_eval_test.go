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
		"promo":  {VerdictNotTxn, 0.995}, // non-txn, set aside at every cut
		"otp":    {VerdictNotTxn, 0.92},  // non-txn, set aside at 0.90 and 0.80
		"spend":  {VerdictTxn, 0.99},     // txn, never set aside
		"refund": {VerdictNotTxn, 0.96},  // txn wrongly called not: hidden at 0.95 and below
	}
	samples := []TxnSample{
		{Subject: "promo"}, {Subject: "otp"},
		{Subject: "spend", IsTxn: true}, {Subject: "refund", IsTxn: true},
		{Subject: "broken", IsTxn: true},
	}
	r := EvaluateTxnCheck(t.Context(), samples, chk)
	if r.Total != 5 || r.Txns != 3 || r.NonTxns != 2 || r.Errors != 1 || r.FirstErr == nil {
		t.Fatalf("report = %+v", r)
	}
	want := map[float64][2]int{0.99: {1, 0}, 0.97: {1, 0}, 0.95: {1, 1}, 0.9: {2, 1}, 0.8: {2, 1}}
	if len(r.Cuts) != len(want) {
		t.Fatalf("cuts = %+v", r.Cuts)
	}
	for _, c := range r.Cuts {
		if w := want[c.Min]; c.SetAside != w[0] || c.Hidden != w[1] {
			t.Errorf("cut %.2f = set aside %d hidden %d, want %d %d", c.Min, c.SetAside, c.Hidden, w[0], w[1])
		}
	}
}
