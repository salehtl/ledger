package api

// waitlist.go is the public half of the bank-demand counter.
//
// It owns NO validation and NO SQL of its own. Both live in
// internal/v2/admin/waitlist.go and this handler calls them, because the two
// routes write the same row of the same table and a second copy of a rule is a
// second thing that can drift. It already had: the copy this file used to carry
// reimplemented the shape grammar and omitted `amountRe`, so
// "AED 25.00 STARBUCKS" was a 400 on the tailnet-only admin route and a stored
// row here -- on the one path reachable from every beta user's phone.
//
// That divergence also invalidated the premise `admin.amountRe`'s own comment
// rests on ("what bounds the damage is that this is a counter reachable only
// from the tailnet"). Sharing the implementation is what restores it.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"ledger/internal/v2/admin"
)

type waitlistRequest struct {
	Bank string `json:"bank"`
}

// handleWaitlist records only an aggregate bank counter. Authentication limits
// abuse; user identity is deliberately not persisted beside the request -- the
// id is discarded by this signature and never reaches admin.Record.
func (s *Server) handleWaitlist(w http.ResponseWriter, r *http.Request, _ uuid.UUID) {
	var req waitlistRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	wl := &admin.Waitlist{Pool: s.Pool}
	if err := wl.Record(r.Context(), req.Bank); err != nil {
		if errors.Is(err, admin.ErrInvalidBank) {
			// admin's own wording, which names the specific refusal (empty, too
			// long, a pasted decimal amount, a disallowed character) instead of
			// a generic shape complaint. The wrapped sentinel prefix is trimmed
			// so the detail reads as a sentence on a phone.
			writeErr(w, http.StatusBadRequest, "invalid_bank", strings.TrimPrefix(err.Error(), admin.ErrInvalidBank.Error()+": "))
			return
		}
		s.logf("api: record waitlist aggregate: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
