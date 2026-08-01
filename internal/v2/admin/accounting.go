package admin

// The console's half of spec §5's "zero drops without notice" exit criterion.
//
// The arithmetic lives in internal/v2/verify, not here, and that split is
// deliberate: the SAME report has to be reachable two ways. An operator with a
// shell runs `ledgerd verify`, which exits non-zero on a finding and is the
// thing a deploy or a cron can gate on; an operator with a browser on the
// tailnet reads it here. Two implementations would be two arithmetics, and the
// one that eventually disagreed with the other would be the one nobody was
// looking at.
//
// This handler adds exactly one thing over the library call: it refuses an
// unbounded window. A report that says "from 0001-01-01" is a report nobody can
// compare against another one.

import (
	"context"
	"net/http"
	"time"

	"ledger/internal/v2/diag"
	"ledger/internal/v2/verify"
)

// defaultAccountingWindow is what /admin/accounting reports when the caller
// names neither end. It matches the alpha's own cadence: spec §5's exit
// criteria are measured over two weeks.
const defaultAccountingWindow = 14 * 24 * time.Hour

// arrivalTally is the second, independent count `balanced` is checked against.
//
// It is a variable so a test can make the two sides disagree, and that is not
// an apology — it is the point. A cross-check between two correct
// implementations cannot be made false by any DATA, so a test that only planted
// rows could never observe whether the conjunct was there at all. That is how
// the field this replaced ("balanced", which reduced algebraically to
// `unaccounted == 0` because both of its sides incremented in the same branch
// of one scan) survived review: nothing could tell it apart from a tautology.
// TestBalancedIsMeasuredAgainstASecondCountAndNotDerivedFromTheFirst makes the
// second measurement lie and requires the answer to change.
var arrivalTally = func(ctx context.Context, d *diag.Diag, from, to time.Time) (diag.ArrivalTally, error) {
	return d.ArrivalTally(ctx, from, to)
}

// accounting is the "every email accounted for" report.
//
// The response carries the equation's terms, the reprocessing split BESIDE them
// (never folded in), the protocol-level refusals that never resolved a
// recipient, the quarantine reconciliation that closes the one non-terminal
// arrival outcome, and — always — the list of refusal classes this accounting
// cannot see. That last field is not decoration: a console that rendered
// "unaccounted: 0" with no caveat would be claiming something stronger than the
// receiver can support. See verify.BlindSpots.
func (h *Handler) accounting(w http.ResponseWriter, r *http.Request) {
	from, to, ok := h.window(w, r)
	if !ok {
		return
	}
	if to.IsZero() {
		to = time.Now()
	}
	if from.IsZero() {
		from = to.Add(-defaultAccountingWindow)
	}
	rep, err := verify.Accounting(r.Context(), h.Diag.Pool, from, to)
	if err != nil {
		h.logf("admin: accounting: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}
	// The independent count. See arrivalTally: without it "balanced" is a
	// restatement of `unaccounted == 0` wearing the clothes of an equation.
	tally, err := arrivalTally(r.Context(), h.Diag, from, to)
	if err != nil {
		h.logf("admin: accounting: arrival tally: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal")
		return
	}

	// balanced is the assertion, computed here rather than trusted from the
	// client: the named arrival outcomes plus the unclassifiable ones must equal
	// the inbound total, and a non-zero unaccounted is a failure whatever the
	// sum says.
	body := map[string]any{
		"from": rep.From, "to": rep.To,
		"inbound_total":      rep.InboundTotal,
		"inbound_identities": rep.InboundIdentities,
		"arrival":            rep.Arrival,
		"arrival_sum":        rep.ArrivalSum(),
		"reprocess":          rep.Reprocess,
		"unaccounted":        rep.Unaccounted,
		// The equation is necessary and not sufficient: a discarded duplicate
		// and a vanished hold both leave it balanced, so "balanced" must not be
		// the console's headline. Findings is.
		//
		// The last two conjuncts are the ones that make it an equation at all.
		// `arrival_sum + unaccounted == inbound_total` is TRUE BY CONSTRUCTION
		// inside verify.Accounting — inbound_total increments in exactly the
		// branches that increment the other two — so on its own this field
		// reduced to `unaccounted == 0` and told an operator nothing they were
		// not already reading one line above. Checking both totals against a
		// SECOND query (diag.ArrivalTally, a plain count with the outcome test
		// in SQL) is what turns it into corroboration: the two classifiers have
		// to agree about how many messages arrived and how many of them this
		// build can place.
		"balanced": rep.ArrivalSum()+rep.Unaccounted == rep.InboundTotal &&
			rep.Unaccounted == 0 &&
			tally.Rows == rep.InboundTotal &&
			tally.Named == rep.ArrivalSum(),
		"ok": len(rep.Findings()) == 0,

		"protocol_rejections":       rep.ProtocolRejections,
		"protocol_rejections_total": rep.ProtocolRejectionsTotal(),
		"rejection_days":            rep.RejectionDays,

		"discarded":   rep.Discarded,
		"quarantine":  rep.Quarantine,
		"blind_spots": rep.BlindSpots,
		"findings":    rep.Findings(),
	}
	if len(rep.UnknownOutcomes) > 0 {
		body["unknown_outcomes"] = rep.UnknownOutcomes
	}
	writeJSON(w, http.StatusOK, body)
}
