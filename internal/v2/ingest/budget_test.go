package ingest

// What Deliver says when the storage layer refuses the message on budget
// grounds. It is the only failure this package translates for the receiver, and
// the translation is what stops a full account being reported to the sending
// world as a broken server.

import (
	"errors"
	"testing"

	"ledger/internal/v2/budget"
	"ledger/internal/v2/smtpd"
)

// setOplogCeiling lowers the default policy row so a single email is over
// budget, which is the same wall a real account reaches at 256 MB.
func setOplogCeiling(r *rig, bytes int64) {
	r.t.Helper()
	if _, err := r.pool.Exec(bg,
		`UPDATE account_limits SET oplog_bytes = $1 WHERE user_id IS NULL`, bytes); err != nil {
		r.t.Fatal(err)
	}
}

// The refusal reaches smtpd as ErrOverBudget, so the receiver answers 452
// ("insufficient storage, retry") instead of the 451 it gives every failure it
// cannot explain. Both errors are wrapped: the receiver matches its own
// sentinel, and the operator's log still names the resource that ran out.
func TestABudgetRefusalIsTranslatedForTheReceiver(t *testing.T) {
	r := newRig(t)
	r.publish(bankTemplate())
	r.allow("bank.example", "outer")
	setOplogCeiling(r, 1)

	err := r.deliver(r.trusted(templateBody), "alerts@bank.example")
	if err == nil {
		t.Fatal("a message the log refused must not be answered with nil: nil means " +
			"'I have taken responsibility for this' and the sender never retries")
	}
	if !errors.Is(err, smtpd.ErrOverBudget) {
		t.Fatalf("deliver over the ceiling = %v, want it to carry smtpd.ErrOverBudget so the "+
			"receiver answers 452 rather than the generic 451", err)
	}
	if !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("deliver over the ceiling = %v, want the cause to travel with it", err)
	}
	if got := r.rows(); len(got) != 0 {
		t.Fatalf("op_log has %d rows after a refused append, want 0", len(got))
	}
}

// Only a budget refusal is translated. Every other failure stays what it was —
// an unexplained error the receiver answers 451 to — because guessing "your
// mailbox is full" during a database outage tells senders to give up on a
// mailbox that is fine.
func TestAnOrdinaryFailureIsNotDressedUpAsABudgetRefusal(t *testing.T) {
	r := newRig(t)
	r.p.Trust = failingAllowlist{}

	err := r.deliver(r.trusted(templateBody), "alerts@bank.example")
	if err == nil {
		t.Fatal("an allowlist outage must not be swallowed")
	}
	if errors.Is(err, smtpd.ErrOverBudget) {
		t.Fatalf("an allowlist outage = %v, reported as a full mailbox", err)
	}
}

// A message that is admitted is still admitted: the translation must not turn
// a working path into a refusal, and the ceiling above the message size is the
// case every real delivery takes.
func TestAMessageUnderTheCeilingIsStillDelivered(t *testing.T) {
	r := newRig(t)
	r.publish(bankTemplate())
	r.allow("bank.example", "outer")
	setOplogCeiling(r, 1<<20)

	r.mustDeliver(r.trusted(templateBody), "alerts@bank.example")
	if got := r.rows(); len(got) != 2 {
		t.Fatalf("op_log has %d rows, want 2 (one hot op, one cold raw body)", len(got))
	}
}
