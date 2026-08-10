package smtpd

// How a suspension is FILED. Migration 00033 gave parse_diagnostics a word for
// it; before that the notice said 'over_quota', so an operator reading
// diagnostics saw "this user hit their quota" for an account they had paused
// themselves.

import (
	"testing"

	"ledger/internal/v2/diag"
)

func TestASuspensionIsFiledAsSuspendedAndNotAsAQuotaBreach(t *testing.T) {
	f := suspendable(t, testMailConfig(), withHighRefusalThreshold())
	setStatus(t, f, "suspended")

	c := dial(t, f.addr)
	c.envelope("bank@dib.ae")
	c.mustCmd(452, "RCPT TO:<%s>", knownRcpt)

	rows := diagRows(t, f.pool)
	if len(rows) != 1 {
		t.Fatalf("%d diagnostics rows, want 1", len(rows))
	}
	got := rows[0]
	if got.rejectReason == nil {
		t.Fatal("the suspension notice carries no reject_reason")
	}
	if *got.rejectReason != diag.RejectSuspended {
		t.Fatalf("reject_reason = %q, want %q: the operator paused this account, the user did "+
			"not exceed anything", *got.rejectReason, diag.RejectSuspended)
	}
	// The outcome is the judgement recorded at the call site: 'rejected' is
	// true (the message was refused), 'over_quota' would be false.
	if got.outcome != diag.OutcomeRejected {
		t.Fatalf("outcome = %q, want %q", got.outcome, diag.OutcomeRejected)
	}

	// The AGGREGATE keeps the narrow vocabulary its table was created with:
	// smtp_rejections holds refusals with no recipient to scope them to, and a
	// 'suspended' row there would be an unscoped fact about a known user. It is
	// still counted, under the closest reason that table allows, so a suspended
	// account's mail does not vanish from "did everything get accounted for".
	flushed(t, f.srv)
	if n := rejectionCount(t, f.pool, diag.RejectOverQuota); n != 1 {
		t.Fatalf("smtp_rejections[over_quota] = %d, want 1", n)
	}
	var n int64
	if err := f.pool.QueryRow(bg,
		`SELECT coalesce(sum(count), 0) FROM smtp_rejections WHERE reason = 'suspended'`).Scan(&n); err != nil {
		// The column's CHECK refuses the value, so a row cannot exist; the
		// query is here so a widened constraint fails this test rather than
		// passing silently.
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("smtp_rejections holds %d 'suspended' rows: that table is for refusals with no "+
			"resolved recipient, and a suspension always has one", n)
	}

	// And the per-account ledger still names it exactly.
	flushedRefusals(t, f.srv)
	if got := refusalCount(t, f.pool, f.user, RefusalSuspended); got != 1 {
		t.Fatalf("account_refusals[suspended] = %d, want 1", got)
	}
}
