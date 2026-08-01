package api

import (
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"

	"ledger/internal/v2/pushv2"
)

// maxPushTokenLen mirrors the push_tokens CHECK constraint. Duplicated rather
// than imported because the constraint is what makes the bound a guarantee and
// this is what makes the refusal a 400 instead of a 500.
const maxPushTokenLen = 512

// rePushToken mirrors the same constraint's grammar: printable ASCII, no space
// and no control character. It is deliberately wide — Expo has changed its
// token shape before, and a client that cannot register is a client that never
// gets a notification — while still refusing anything that could carry a line
// break into a JSON body this server sends to a third party.
var rePushToken = regexp.MustCompile(`^[\x21-\x7e]+$`)

// PushTokenRequest is POST /api/v1/push/tokens.
type PushTokenRequest struct {
	Token    string `json:"token"`
	Platform string `json:"platform"`
}

// handleRegisterPushToken records a device token for the CALLING session's user.
//
// The user is taken from the session and is not a field of the request. That is
// the whole security property of this endpoint: a token is an opaque string
// somebody might observe, and a body that named its own user_id would let anyone
// holding a session point another account's notifications wherever they liked.
//
// It is an upsert, because a client re-registers on every launch and Expo
// re-issues the same token for the same install. A repeat is a no-op rather than
// an error, and it deliberately does not touch created_at: the ordering
// pushv2.Notify reads is "oldest device first", and refreshing it on every
// launch would make that order meaningless.
func (s *Server) handleRegisterPushToken(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req PushTokenRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	token := strings.TrimSpace(req.Token)
	switch {
	case token == "" || len(token) > maxPushTokenLen || !rePushToken.MatchString(token):
		writeErr(w, http.StatusBadRequest, "invalid_token", "token must be 1-512 printable ASCII characters")
		return
	case !slices.Contains(pushv2.Platforms, req.Platform):
		writeErr(w, http.StatusBadRequest, "invalid_platform",
			"platform must be one of "+strings.Join(pushv2.Platforms, ", "))
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,$3)
		 ON CONFLICT (user_id, token) DO UPDATE SET platform = excluded.platform`,
		userID, token, req.Platform); err != nil {
		s.logf("api: register push token for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeletePushToken forgets one device.
//
// Scoped to the session's user by the WHERE clause, so a caller can only ever
// delete their own row — and because the table is keyed by (user_id, token), a
// token string two accounts share is two rows and deleting one leaves the other
// alone. See 00010_push_tokens.sql for why the key is composite.
//
// A token that does not exist answers 204 and not 404. Deleting something twice
// is the normal outcome of a client retrying, and a 404 here would additionally
// tell any caller whether an arbitrary token string is registered to them.
func (s *Server) handleDeletePushToken(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	token := r.PathValue("token")
	if token == "" {
		writeErr(w, http.StatusBadRequest, "invalid_token", "no token in the path")
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_tokens WHERE user_id = $1 AND token = $2`, userID, token); err != nil {
		s.logf("api: delete push token for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
