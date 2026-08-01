package api

// The merchant-dictionary distribution channel (spec §3.6).
//
// # What this endpoint is
//
// GET /api/v1/dictionary?since=<version> is a delta feed over the GLOBAL,
// anonymous merchant -> category dictionary. It is the same shape as template
// distribution: the server publishes, every client receives the identical
// bytes, and matching runs on-device.
//
// It is the only part of the dictionary a client can reach. There is no
// submission endpoint in Phase 1 — spec §3.6's opt-in confirmations arrive with
// the Phase 2 client, and internal/v2/dict.Submit is the call that will serve
// it — and there is deliberately no moderation route here: that lives on the
// tailnet-bound admin listener (internal/v2/admin), never on the public API.
//
// # What it must never carry
//
// A merchant pattern is only published once at least dict.K distinct users have
// submitted it, because a merchant that one beta user transacts with is a name
// for that user. This handler therefore returns dict.Since's output verbatim
// and applies NO filtering of its own: the suppression rule lives in one SQL
// predicate in the dict package, and a second copy of it here would be a second
// thing to get wrong. dict.Since is what guarantees the response cannot name a
// pattern that has not published — including in `removed`, where a retraction
// may only name an entry that actually shipped.
//
// # Why the response is not user-scoped
//
// Every other endpoint in this package is scoped to the user id resolved from
// the bearer token. This one is not, because there is nothing per-user in it:
// every client gets the same dictionary. The session is still required — the
// dictionary is beta-participant data and not something to hand to an
// unauthenticated caller — but the token names nobody in the answer, which is
// exactly the property that makes the response impossible to correlate with a
// user's own merchants.

import (
	"net/http"
	"strconv"

	"github.com/google/uuid"

	"ledger/internal/v2/dict"
)

// DictionaryEntry is one published mapping.
type DictionaryEntry struct {
	Pattern string `json:"pattern"`
	// Match is "contains" or "exact". A regex is never published — see
	// internal/v2/dict.
	Match    string `json:"match"`
	Category string `json:"category"`
}

// DictionaryResponse is the delta a client applies to its local dictionary.
//
// Entries and Removed are NOT omitempty and are always arrays: a client that
// distinguishes "no changes" from "the field was missing" would be writing code
// for a case that never happens, and `null` is the classic way an empty delta
// becomes a crash on the device.
type DictionaryResponse struct {
	// Version is the cursor to send back as ?since= next time. Decimal string,
	// because it is an int64 in Go and JSON.parse would make it a float64 —
	// the same rule seq and writer_counter follow.
	Version string            `json:"version"`
	Entries []DictionaryEntry `json:"entries"`
	// Removed names entries the client already has and must drop, because the
	// operator retracted them after publication. It is always empty for
	// ?since=0, which is a client with nothing to remove.
	Removed []DictionaryEntry `json:"removed"`
}

// handleDictionary serves GET /api/v1/dictionary.
func (s *Server) handleDictionary(w http.ResponseWriter, r *http.Request, _ uuid.UUID) {
	var since int64
	if raw := r.URL.Query().Get("since"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			// Refused rather than clamped to 0: a negative or unparseable
			// cursor means the client's bookkeeping is wrong, and silently
			// serving it the whole dictionary hides that while looking like
			// it worked.
			writeErr(w, http.StatusBadRequest, "bad_request",
				"since must be a non-negative decimal version")
			return
		}
		since = n
	}

	delta, err := s.Dict.Since(r.Context(), since)
	if err != nil {
		s.logf("api: GET /api/v1/dictionary: %v", err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, DictionaryResponse{
		Version: strconv.FormatInt(delta.Version, 10),
		Entries: dictEntries(delta.Entries),
		Removed: dictEntries(delta.Removed),
	})
}

// dictEntries re-shapes dict's rows into this package's wire type rather than
// serving dict.Entry directly. The two are field-identical today, which is
// exactly why the conversion is worth keeping: the wire shape is a contract
// with every deployed client, and an internal struct that happens to marshal
// correctly is one refactor away from renaming a JSON field by accident.
func dictEntries(in []dict.Entry) []DictionaryEntry {
	out := make([]DictionaryEntry, 0, len(in))
	for _, e := range in {
		out = append(out, DictionaryEntry{Pattern: e.Pattern, Match: e.Match, Category: e.Category})
	}
	return out
}
