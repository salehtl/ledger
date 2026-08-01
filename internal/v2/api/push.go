package api

import (
	"errors"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/pushv2"
)

// maxPushTokenLen mirrors the push_tokens CHECK constraint. Duplicated rather
// than imported because the constraint is what makes the bound a guarantee and
// this is what makes the refusal a 400 instead of a 500.
const maxPushTokenLen = 512

// maxWriterIDLen mirrors writers_writer_id_charset. It is a cheapness bound
// only: what actually authorizes a writer_id here is the ownership lookup in
// liveDeviceWriter, which is strictly stronger than any grammar check.
const maxWriterIDLen = 64

// pushTokenPrefixLen is how much of a token GET /push/tokens shows.
//
// A listing exists so a user can recognise and delete a device they no longer
// hold, and recognition is done by platform, registration date and the
// "current" flag — not by reading a token. The prefix is a tiebreak for two
// identical-looking rows and nothing more, which is why it is a fragment: a
// listing that returned whole tokens would hand every one of a user's device
// tokens to anything holding a session, and a token is precisely the string
// Expo's public send endpoint accepts as a target (see the config rail on
// Push.AccessToken for why that endpoint is not assumed to be authenticated).
const pushTokenPrefixLen = 12

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

	// WriterID names the device key this install already enrolled, and it is
	// REQUIRED. See handleRegisterPushToken for why it is not optional.
	WriterID string `json:"writer_id"`
}

// PushTokenInfo is one row of GET /api/v1/push/tokens.
type PushTokenInfo struct {
	// ID is the handle DELETE /push/tokens/{handle} takes. A client that knows
	// its own token deletes by that instead; a user deleting a phone they are
	// not holding has only this.
	ID          string    `json:"id"`
	TokenPrefix string    `json:"token_prefix"`
	Platform    string    `json:"platform"`
	WriterID    string    `json:"writer_id"`
	CreatedAt   time.Time `json:"created_at"`
	// Current marks the row registered by the session making THIS request —
	// i.e. "this phone". Without it a user looking at two iOS rows registered a
	// day apart cannot tell which one to revoke, and the failure of guessing
	// wrong is silently switching off their own notifications.
	Current bool `json:"current"`
}

// PushTokensResponse is GET /api/v1/push/tokens.
type PushTokensResponse struct {
	// Tokens is newest first — the same order pushv2 notifies in, so a client
	// can render the truncation honestly rather than implying every row gets a
	// notification.
	Tokens []PushTokenInfo `json:"tokens"`
	// Max is pushv2.MaxDevicesPerUser, published rather than left implicit.
	// The cap used to be enforced in one place, silently, keeping the OLDEST
	// devices — so a user's current phone was the one it dropped. It now keeps
	// the newest, evicts at registration, and says what the limit is.
	Max int `json:"max"`
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
// an error, and it deliberately does not touch created_at: pushv2 orders the
// fan-out by it, and refreshing it on every launch would make every device look
// equally new and the cap's choice arbitrary. It DOES refresh writer_id and
// session_hash, because those are the current answer to "which device and which
// sign-in owns this row" and a stale answer is a row that the wrong revocation
// clears.
//
// # Why writer_id is required rather than optional
//
// It is the link that makes a push token revocable (00019). A nullable link is
// one that the first client to forget the field silently opts out of, and what
// it opts out of is: revoking this device's key stops its notifications. There
// is no deployed client to break — push has been disabled since the table was
// created — so the contract is set now, while it is free, rather than after a
// user's stolen phone is the thing that discovers the field was optional.
func (s *Server) handleRegisterPushToken(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.PushPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
		return
	}
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
	case req.WriterID == "" || len(req.WriterID) > maxWriterIDLen:
		writeErr(w, http.StatusBadRequest, "invalid_writer",
			"writer_id must name a device writer this account has enrolled")
		return
	}
	// Authorization before existence, as everywhere else in this API: the
	// refusal is identical for "no such writer", "that is another account's
	// writer", "that is the server's ingest writer" and "that key is revoked",
	// so the error text cannot be used to enumerate a roster.
	switch ok, err := s.liveDeviceWriter(r, userID, req.WriterID); {
	case err != nil:
		s.logf("api: check writer %q for %s: %v", req.WriterID, userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	case !ok:
		writeErr(w, http.StatusBadRequest, "invalid_writer",
			"writer_id must name a device writer this account has enrolled")
		return
	}
	sessionHash, ok := s.sessionHash(r)
	if !ok {
		// Unreachable: requireSession already resolved this bearer token.
		// Checked rather than assumed because the alternative is a NOT NULL
		// violation presented as a 500 on a routine registration.
		writeUnauthorized(w)
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`INSERT INTO push_tokens (user_id, token, platform, writer_id, session_hash)
		 VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (user_id, token) DO UPDATE
		   SET platform = excluded.platform,
		       writer_id = excluded.writer_id,
		       session_hash = excluded.session_hash`,
		userID, token, req.Platform, req.WriterID, sessionHash); err != nil {
		s.logf("api: register push token for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.evictPushTokensOverCap(r, userID)
	w.WriteHeader(http.StatusNoContent)
}

// evictPushTokensOverCap enforces pushv2.MaxDevicesPerUser at the INSERT, using
// pushv2's own ordering expression so the set kept here is exactly the set
// notified there.
//
// Enforcing it only at fan-out was the original defect: rows accumulated
// without limit, the notifier took the first twenty by ASCENDING registration
// time, and a user past the cap had their newest phone — the one in their hand
// — dropped from every notification while registration still answered 204. Now
// the table cannot exceed the cap at all, the survivors are the most recent,
// and an eviction is logged rather than being a thing that quietly happened.
//
// A failure here is logged and swallowed: the registration itself succeeded and
// is durable, and turning "we could not trim an old row" into a 500 would make
// a client retry a call that already worked.
func (s *Server) evictPushTokensOverCap(r *http.Request, userID uuid.UUID) {
	tag, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_tokens
		  WHERE user_id = $1
		    AND id IN (SELECT id FROM push_tokens WHERE user_id = $1
		                ORDER BY created_at DESC, token DESC OFFSET $2)`,
		userID, pushv2.MaxDevicesPerUser)
	if err != nil {
		s.logf("api: trim push tokens for %s: %v", userID, err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		s.logf("api: user %s exceeded %d registered devices; forgot the %d oldest",
			userID, pushv2.MaxDevicesPerUser, n)
	}
}

// liveDeviceWriter reports whether writerID names an enrolled, non-revoked
// DEVICE writer of this user.
//
// kind = 'device' matters: the ingest writer is the server's own, it has no key
// and therefore no revocation ceremony, so a token pinned to it would be a
// token nothing could ever revoke — the exact hole this whole change closes,
// reintroduced through a value a client picks.
func (s *Server) liveDeviceWriter(r *http.Request, userID uuid.UUID, writerID string) (bool, error) {
	var one int
	err := s.Pool.QueryRow(r.Context(),
		`SELECT 1 FROM writers
		  WHERE user_id = $1 AND writer_id = $2 AND kind = 'device' AND revoked_at IS NULL`,
		userID, writerID).Scan(&one)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	return true, nil
}

// sessionHash re-derives the hash of the bearer token this request carried.
//
// Recomputed rather than threaded through requireSession because it is needed
// by exactly these handlers, and widening authedHandler for two of nineteen
// routes would put a credential-derived value in the signature of every handler
// that has no business holding one.
func (s *Server) sessionHash(r *http.Request) ([]byte, bool) {
	tok, ok := bearerToken(r)
	if !ok {
		return nil, false
	}
	return auth.SessionHash(tok), true
}

// handleListPushTokens is how a user sees the devices that receive their
// notifications, and it exists because without it "delete this device" was
// unreachable.
//
// The delete route needs the exact token string. A client knows its own; a user
// whose phone was stolen, signed out, or handed on knows nothing at all, and
// before this route there was no way for them to find out — so a device they
// had disowned kept receiving a real-time signal of every bank transaction with
// no mechanism, for the user OR the operator, to stop it. Revocation and
// sign-out now sweep automatically (see auth.forgetPushTokens); this is the
// manual path for everything neither of those covers.
func (s *Server) handleListPushTokens(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	current, _ := s.sessionHash(r)
	rows, err := s.Pool.Query(r.Context(),
		`SELECT id, token, platform, writer_id, created_at, session_hash = $2
		   FROM push_tokens WHERE user_id = $1
		  ORDER BY created_at DESC, token DESC`,
		userID, current)
	if err != nil {
		s.logf("api: list push tokens for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	defer rows.Close()
	out := PushTokensResponse{Tokens: []PushTokenInfo{}, Max: pushv2.MaxDevicesPerUser}
	for rows.Next() {
		var (
			info  PushTokenInfo
			id    uuid.UUID
			token string
		)
		if err := rows.Scan(&id, &token, &info.Platform, &info.WriterID, &info.CreatedAt, &info.Current); err != nil {
			s.logf("api: list push tokens for %s: %v", userID, err)
			writeErr(w, http.StatusInternalServerError, "internal", "")
			return
		}
		info.ID = id.String()
		info.TokenPrefix = token
		if len(token) > pushTokenPrefixLen {
			info.TokenPrefix = token[:pushTokenPrefixLen]
		}
		out.Tokens = append(out.Tokens, info)
	}
	if err := rows.Err(); err != nil {
		s.logf("api: list push tokens for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDeletePushToken forgets one device.
//
// Scoped to the session's user by the WHERE clause, so a caller can only ever
// delete their own row — and because the table is keyed by (user_id, token), a
// token string two accounts share is two rows and deleting one leaves the other
// alone. See 00010_push_tokens.sql for why the key is composite.
//
// The path segment is matched against the token OR the row id, because the two
// callers of this route know different things: a client deletes the token it
// holds, and a user deleting a phone they no longer have has only the id from
// the listing. Both are user-scoped, so neither widens what a caller can reach.
//
// A token that does not exist answers 204 and not 404. Deleting something twice
// is the normal outcome of a client retrying, and a 404 here would additionally
// tell any caller whether an arbitrary token string is registered to them.
func (s *Server) handleDeletePushToken(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.PushPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
		return
	}
	handle := r.PathValue("token")
	if handle == "" {
		writeErr(w, http.StatusBadRequest, "invalid_token", "no token in the path")
		return
	}
	// id::text rather than a Go-side uuid.Parse: a handle that is not a uuid
	// must be treated as a token, not as a parse error, and casting the column
	// keeps the two cases in one statement with one user_id scope on it.
	if _, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_tokens WHERE user_id = $1 AND (token = $2 OR id::text = $2)`,
		userID, handle); err != nil {
		s.logf("api: delete push token for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeleteAllPushTokens forgets every device this user has registered.
//
// The panic button, and the reason it is a route of its own: the recovery a
// user actually needs is "make it stop", not "identify which of these five rows
// is the phone that was stolen". Every still-held device re-registers on its
// next launch, so the cost of over-deleting is one app open — which is exactly
// why this is safe to offer and why a client should offer it plainly.
func (s *Server) handleDeleteAllPushTokens(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.PushPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "")
		return
	}
	if _, err := s.Pool.Exec(r.Context(),
		`DELETE FROM push_tokens WHERE user_id = $1`, userID); err != nil {
		s.logf("api: delete all push tokens for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
