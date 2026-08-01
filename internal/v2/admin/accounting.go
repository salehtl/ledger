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
	"net/http"
	"time"

	"ledger/internal/v2/verify"
)

// defaultAccountingWindow is what /admin/accounting reports when the caller
// names neither end. It matches the alpha's own cadence: spec §5's exit
// criteria are measured over two weeks.
const defaultAccountingWindow = 14 * 24 * time.Hour

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

	// balanced is the assertion, computed here rather than trusted from the
	// client: the named arrival outcomes plus the unclassifiable ones must equal
	// the inbound total, and a non-zero unaccounted is a failure whatever the
	// sum says.
	body := map[string]any{
		"from": rep.From, "to": rep.To,
		"inbound_total": rep.InboundTotal,
		"arrival":       rep.Arrival,
		"arrival_sum":   rep.ArrivalSum(),
		"reprocess":     rep.Reprocess,
		"unaccounted":   rep.Unaccounted,
		"balanced":      rep.ArrivalSum()+rep.Unaccounted == rep.InboundTotal && rep.Unaccounted == 0,

		"protocol_rejections":       rep.ProtocolRejections,
		"protocol_rejections_total": rep.ProtocolRejectionsTotal(),
		"rejection_days":            rep.RejectionDays,

		"quarantine":  rep.Quarantine,
		"blind_spots": rep.BlindSpots,
		"findings":    rep.Findings(),
	}
	if len(rep.UnknownOutcomes) > 0 {
		body["unknown_outcomes"] = rep.UnknownOutcomes
	}
	writeJSON(w, http.StatusOK, body)
}
