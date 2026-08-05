package api

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

type waitlistRequest struct { Bank string `json:"bank"` }
var waitlistBank = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9 &.'-]{0,62}[a-z0-9])?$`)

// handleWaitlist records only an aggregate bank counter. Authentication limits
// abuse; user identity is deliberately not persisted beside the request.
func (s *Server) handleWaitlist(w http.ResponseWriter, r *http.Request, _ uuid.UUID) {
	var req waitlistRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) { return }
	bank := strings.ToLower(strings.Join(strings.Fields(req.Bank), " "))
	if !waitlistBank.MatchString(bank) {
		writeErr(w, http.StatusBadRequest, "invalid_bank", "bank must be a 1-64 character ASCII name")
		return
	}
	if _, err := s.Pool.Exec(r.Context(), `INSERT INTO waitlist (bank, demand, first_seen, last_seen)
		VALUES ($1,1,now(),now()) ON CONFLICT (bank) DO UPDATE SET demand=waitlist.demand+1,last_seen=now()`, bank); err != nil {
		s.logf("api: record waitlist aggregate: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
