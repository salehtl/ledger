package api

// keyhistory.go serves the append-only key-history log (spec §3.4) to the
// device it belongs to.
//
// Without this route the log was write-only: appended on every writer
// registration and revocation, protected by two database triggers, and
// selected by nothing but tests. §3.4, §3.3(c) and §2:176 all describe peer
// devices detecting key substitution by comparing a code derived from this
// log's head — a comparison no device could make, because no device could read
// the log.
//
// # The server deliberately does not compute the comparison code
//
// §3.4 is explicit that single-operator infrastructure "cannot make key
// substitution impossible, only detectable", and detection works only if the
// audited party is not the one doing the arithmetic. So this returns the
// entries and the client derives the code, over the canonical ordering
// [auth.Writers.KeyHistory] documents. A `comparison_code` field in this
// response would look like the feature and be worth nothing.

import (
	"encoding/base64"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// KeyHistoryEntry is one entry of the log, in wire form.
//
// PubKey is empty for the keyless ingest writer. It is a distinct value from a
// key, not a substitute for one: a peer replaying the log must be able to tell
// "a server-side writer with no key appeared" from "this device's key changed".
type KeyHistoryEntry struct {
	ID       int64     `json:"id"`
	WriterID string    `json:"writer_id"`
	PubKey   string    `json:"pubkey"` // base64; empty for the ingest writer
	Event    string    `json:"event"`  // "registered" | "revoked"
	At       time.Time `json:"at"`
}

// KeyHistoryResponse answers GET /api/v1/key-history. Entries are OLDEST FIRST
// and the slice is the complete log; the last element is the head.
type KeyHistoryResponse struct {
	Entries []KeyHistoryEntry `json:"entries"`
}

// handleKeyHistory returns the caller's own key-history log.
func (s *Server) handleKeyHistory(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	log, err := s.Writers.KeyHistory(r.Context(), userID)
	if err != nil {
		s.logf("api: key history for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	out := KeyHistoryResponse{Entries: make([]KeyHistoryEntry, 0, len(log))}
	for _, e := range log {
		entry := KeyHistoryEntry{ID: e.ID, WriterID: e.WriterID, Event: e.Event, At: e.At}
		if e.PubKey != nil {
			entry.PubKey = base64.StdEncoding.EncodeToString(e.PubKey)
		}
		out.Entries = append(out.Entries, entry)
	}
	writeJSON(w, http.StatusOK, out)
}
