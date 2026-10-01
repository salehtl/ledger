package parse

import "context"

// TxnSample is one labelled email for EvaluateTxnCheck.
type TxnSample struct {
	From, Subject, Body string
	IsTxn               bool
}

// TxnCut is what one set-aside threshold would do: SetAside non-transactions
// it would clear from the queue, and Hidden real transactions it would hide.
type TxnCut struct {
	Min              float64
	SetAside, Hidden int
}

// TxnCheckReport is the outcome of EvaluateTxnCheck. An email whose check
// failed counts in Total, Txns/NonTxns and Errors, but in no cut and not in
// TxnsAnswered/NonTxnsAnswered. Read each cut against the answered counts: a
// cut can only hide or set aside emails that got an answer.
type TxnCheckReport struct {
	Total, Txns, NonTxns, Errors  int
	TxnsAnswered, NonTxnsAnswered int
	FirstErr                      error
	Cuts                          []TxnCut
}

// txnCutMins are the thresholds the eval reports; 0.97 is the default.
var txnCutMins = []float64{0.99, 0.97, 0.95, 0.9, 0.8}

// EvaluateTxnCheck asks chk about every sample directly (no stored verdicts)
// and reports, per threshold, how many emails a "not a transaction" answer at
// or above it would set aside, split by the true label.
func EvaluateTxnCheck(ctx context.Context, samples []TxnSample, chk TxnChecker) TxnCheckReport {
	r := TxnCheckReport{Cuts: make([]TxnCut, len(txnCutMins))}
	for i, m := range txnCutMins {
		r.Cuts[i].Min = m
	}
	for _, s := range samples {
		r.Total++
		if s.IsTxn {
			r.Txns++
		} else {
			r.NonTxns++
		}
		v, err := chk.Check(ctx, s.From, s.Subject, s.Body)
		if err != nil {
			r.Errors++
			if r.FirstErr == nil {
				r.FirstErr = err
			}
			continue
		}
		if s.IsTxn {
			r.TxnsAnswered++
		} else {
			r.NonTxnsAnswered++
		}
		for i := range r.Cuts {
			if setsAside(v, r.Cuts[i].Min) {
				if s.IsTxn {
					r.Cuts[i].Hidden++
				} else {
					r.Cuts[i].SetAside++
				}
			}
		}
	}
	return r
}
