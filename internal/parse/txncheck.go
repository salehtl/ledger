package parse

import (
	"context"
	"fmt"

	"ledger/internal/classify"
)

// The AI check's two answers, and the parse tier it stamps on an email it sets
// aside.
const (
	VerdictTxn    = "transaction"
	VerdictNotTxn = "not_transaction"
	TierAICheck   = "ai_check"
)

// TxnVerdict is the AI check's answer for one email.
type TxnVerdict struct {
	Verdict    string // VerdictTxn | VerdictNotTxn
	Confidence float64
}

// setsAside reports whether verdict v sets an email aside under threshold
// ignoreAt: a "not a transaction" at or above it. ignoreAt 0 never sets aside.
// The cascade and the eval share it, so the eval measures the live rule.
func setsAside(v TxnVerdict, ignoreAt float64) bool {
	return ignoreAt > 0 && v.Verdict == VerdictNotTxn && v.Confidence >= ignoreAt
}

// TxnChecker answers "is this email a transaction?". It never extracts fields.
type TxnChecker interface {
	Check(ctx context.Context, from, subject, body string) (TxnVerdict, error)
}

const txnCheckInstructions = "Is this email from a UAE bank a notice of one completed transaction: " +
	"money taken from, or paid into, the customer's account or card, with an amount? " +
	"`from` is the sender, `subject` the subject line, `body` the email text."

var txnCheckOptions = []classify.Option{
	{Name: VerdictTxn, Criterion: "Reports one completed purchase, debit, credit, transfer or withdrawal, with its amount"},
	{Name: VerdictNotTxn, Criterion: "Anything else: a promotion, a one-time password, a statement, " +
		"a balance or due-date reminder, a login or security alert, or a declined or pending payment"},
}

// ClassifierTxnChecker asks a classification provider. It sends the sender,
// the subject and at most maxExtractBodyBytes of the email text.
type ClassifierTxnChecker struct {
	C classify.Classifier
}

// NewClassifierTxnChecker wraps a provider.
func NewClassifierTxnChecker(c classify.Classifier) *ClassifierTxnChecker {
	return &ClassifierTxnChecker{C: c}
}

// Check implements TxnChecker.
func (k *ClassifierTxnChecker) Check(ctx context.Context, from, subject, body string) (TxnVerdict, error) {
	ans, err := k.C.Classify(ctx, classify.Request{
		Path:     "txn_check",
		Detail:   subject,
		State:    map[string]string{"from": from, "subject": subject, "body": truncateBody(body)},
		Question: classify.Question{ID: "is_transaction", Instructions: txnCheckInstructions, Options: txnCheckOptions},
	})
	if err != nil {
		return TxnVerdict{}, fmt.Errorf("txn check: %w", err)
	}
	if ans.Choice != VerdictTxn && ans.Choice != VerdictNotTxn {
		return TxnVerdict{}, fmt.Errorf("txn check: unexpected answer %q", ans.Choice)
	}
	return TxnVerdict{Verdict: ans.Choice, Confidence: ans.Confidence}, nil
}

// storedVerdict replays a verdict saved on the ingest row, with no provider
// call. The processor uses it so a reprocess never pays twice.
type storedVerdict TxnVerdict

func (s storedVerdict) Check(context.Context, string, string, string) (TxnVerdict, error) {
	return TxnVerdict(s), nil
}
