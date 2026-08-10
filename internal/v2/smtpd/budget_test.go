package smtpd

// A full account is not a broken server. These cover the reply, the metering
// and the accounting of a delivery the storage layer refused on budget
// grounds — the case that used to surface as the generic 451 every unexplained
// failure gets.

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"ledger/internal/v2/diag"
)

// A handler that says ErrOverBudget is answered 452, not the generic 451. The
// difference is the whole reason the sentinel exists: 451 tells the sending
// postmaster our server is faulty, when what actually happened is the
// recipient's account hit the ceiling it was built to hit. 4.3.1 ("insufficient
// system storage") says that, temporarily, so the mail retries across the
// window in which space is freed.
func TestABudgetRefusalIsA452AndNotTheGeneric451(t *testing.T) {
	f := suspendable(t, testMailConfig(), withHighRefusalThreshold())
	f.h.fail(fmt.Errorf("%w: budget: refused: oplog_cold_bytes", ErrOverBudget))

	code, msg := dial(t, f.addr).send("bank@dib.ae", knownRcpt, mailOf(256))
	if code != 452 {
		t.Fatalf("an over-budget delivery -> %d %q, want 452", code, msg)
	}
	if msg != "4.3.1 insufficient storage for this mailbox, try again later" {
		t.Fatalf("over-budget reply text = %q", msg)
	}

	// And an unrecognised failure still gets the generic temporary answer: a
	// database outage must not be rendered to the world as "that mailbox is
	// full".
	f.h.fail(errors.New("database is down"))
	code, msg = dial(t, f.addr).send("bank@dib.ae", knownRcpt, mailOf(256))
	if code != 451 {
		t.Fatalf("an unrecognised handler failure -> %d %q, want 451", code, msg)
	}
}

// The budget refusal takes the SAME metered path as every other refusal with a
// resolved recipient — tarpit debt, aggregate count, bounded user notice — so
// it cannot become the one free branch. What it must NOT do is write a second
// account_refusals row: the gate that refused already counted it against the
// ledger resource that ran out, and counting it again here would make one
// refused email read as two declined writes in the user's own app.
func TestABudgetRefusalIsMeteredAndNotCountedTwice(t *testing.T) {
	f := suspendable(t, testMailConfig(), withLimiter(LimiterConfig{
		Burst: 1, Base: time.Millisecond, Max: 2 * time.Millisecond,
		Window: time.Hour, Disconnect: 4, Daily: 50,
	}))
	f.h.fail(fmt.Errorf("%w: budget: refused", ErrOverBudget))

	c := dial(t, f.addr)
	c.hello()
	for i := range 3 {
		c.mustCmd(250, "MAIL FROM:<bank@dib.ae>")
		c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
		if code, msg := c.data(mailOf(256)); code != 452 {
			t.Fatalf("over-budget delivery %d -> %d %q, want 452", i, code, msg)
		}
	}
	// Past the disconnect threshold: this is the assertion that fails if the
	// branch ever stops going through session.refuse.
	c.mustCmd(250, "MAIL FROM:<bank@dib.ae>")
	c.mustCmd(250, "RCPT TO:<%s>", knownRcpt)
	if code, _ := c.data(mailOf(256)); code != 421 {
		t.Fatalf("a fourth over-budget refusal -> %d, want 421: the branch is unmetered", code)
	}

	flushed(t, f.srv)
	flushedRefusals(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectOverQuota); n != 4 {
		t.Fatalf("smtp_rejections = %d, want 4: every refusal is accounted for", n)
	}
	if rows := diagRows(t, f.pool); len(rows) == 0 || !rows[0].userID.Valid || rows[0].userID.UUID != f.user {
		t.Fatalf("an over-budget refusal must leave a user-scoped notice: %+v", rows)
	}
	for _, res := range []string{RefusalSMTPDaily, RefusalSuspended} {
		if n := refusalCount(t, f.pool, f.user, res); n != 0 {
			t.Fatalf("account_refusals[%s] = %d: a budget refusal is neither a daily-quota "+
				"refusal nor a suspension, and the gate that refused already counted it "+
				"against the resource that actually ran out", res, n)
		}
	}
}

// A refused message must not spend the recipient's daily allowance: it was
// never delivered, and charging for it would let a full log quietly eat the day
// of mail the user gets once space is free again.
func TestABudgetRefusalDoesNotBurnTheUsersAllowance(t *testing.T) {
	cfg := testMailConfig()
	cfg.PerAddressDaily = 1
	f := suspendable(t, cfg, withHighRefusalThreshold())
	f.h.fail(fmt.Errorf("%w: budget: refused", ErrOverBudget))
	if code, _ := dial(t, f.addr).send("bank@dib.ae", knownRcpt, mailOf(256)); code != 452 {
		t.Fatal("the first message must be refused as over budget")
	}

	f.h.fail(nil)
	if code, msg := dial(t, f.addr).send("bank@dib.ae", knownRcpt, mailOf(256)); code != 250 {
		t.Fatalf("the message after a budget refusal -> %d %q, want 250: the refused one "+
			"spent an allowance unit it never used", code, msg)
	}
}
