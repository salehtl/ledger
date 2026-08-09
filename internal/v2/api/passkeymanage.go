package api

// Seeing and removing passkeys — the two routes
// docs/superpowers/specs/2026-08-09-passkey-management-design.md adds to the six
// ceremony routes in passkey.go:
//
//	GET    /api/v1/auth/passkeys                  -> {passkeys:[{credential_id, created_at, last_used_at, authenticator, current}]}
//	DELETE /api/v1/auth/passkeys/{credential_id}  -> 204 | 404 not_found | 409 last_passkey
//
// # Why they are here at all
//
// A user could ADD a passkey and could not see or remove one. A lost phone left
// a credential that could sign in for ever, and the user had no way to end it.
// The listing is not a nicety attached to the removal: it is what makes the
// removal reachable, the same argument the push-token and allowlist routes make
// in api.go.
//
// # The one refusal, and why it is the server's
//
// Removing the account's LAST credential is refused with 409
// {"error":"last_passkey"}. A passkey is the only way in — no password, no reset
// mail, and the recovery phrase unlocks DATA rather than restoring ACCESS — so
// the last removal is an unrecoverable lockout. The client also disables the
// control at one credential, which is honest and is defence in depth; it is NOT
// the guard, because a client-side rule is one the next screen forgets. See
// auth.ErrLastPasskey, where the check runs under a row lock.
//
// # No key material, ever
//
// The listing carries five fields and none of them is a public key. There is no
// use a client has for the key bytes, and returning them would be a liability
// bought for nothing. auth.Credential does not carry a public key at all, so
// this is a property of the type rather than of a SELECT list somebody could
// widen. A test asserts the response body cannot contain the key.
//
// # One field that is honest about what this deployment does not know
//
// `authenticator` is always null. Turning an AAGUID into "iCloud Keychain"
// needs the FIDO Metadata Service blob, which this server does not ship and
// this task did not invent a table for. The field is on the wire because the
// client reads it and a name can be filled in later without a wire change; null
// says "unknown", which is true.
//
// # `current` is real, and it is READ rather than inferred
//
// It comes from the caller's OWN session row: 00034 added
// sessions.credential_id, written at issue time by the ceremony that minted the
// session, and the marker is a byte comparison against it. It is never derived
// from last_used_at or from created_at proximity — that inference is broken by
// re-authentication and by any later sign-in, and a wrong "this device" marker
// is worse than none.
//
// A session that records NO credential — one minted before 00034, or by the
// Apple/Google ID-token exchange, which authenticates no credential — marks
// NOTHING. Every row comes back current:false, which is the truthful rendering
// of "this server does not know which of these you are standing on". The
// screen's marker is then absent rather than wrong.
//
// # Removing a passkey signs out exactly what that passkey signed in
//
// DELETE revokes the sessions the removed credential minted, and leaves the
// account's other devices signed in. It also revokes any session it CANNOT
// attribute (pre-00034 or exchange-minted), except the caller's own, because
// "might be the lost phone" is the one place to err towards signing out — see
// auth/passkey_manage.go's header, which enumerates all four populations. A
// caller who removes the credential their own session was minted with is signed
// out by their own request; the `current` marker above exists so that is a
// decision rather than a surprise.

import (
	"bytes"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
)

// PasskeySummary is one enrolled credential, in exactly the five fields
// web/src/v2/passkeys.ts reads.
type PasskeySummary struct {
	// CredentialID is standard base64 of the raw credential id — the same
	// encoding PasskeyAddResponse and KeyWrap use, and the key the DELETE path
	// takes (URL-encoded, because standard base64 contains '/' and '+').
	CredentialID string    `json:"credential_id"`
	CreatedAt    time.Time `json:"created_at"`
	// LastUsedAt is null for a credential that has never signed in.
	LastUsedAt *time.Time `json:"last_used_at"`
	// Authenticator is the AAGUID-derived model name, and is always null on this
	// deployment. See the file header.
	Authenticator *string `json:"authenticator"`
	// Current marks the credential that authenticated THIS session. It is false
	// on every row when the session records no credential, which is the honest
	// rendering of "unknown". See the file header.
	Current bool `json:"current"`
}

// PasskeysResponse answers GET /api/v1/auth/passkeys.
//
// An account with no credentials answers 200 with an empty list rather than
// 404: it is a normal state for an account created before passkeys, and it is
// not the same fact as "there is no such account".
type PasskeysResponse struct {
	Passkeys []PasskeySummary `json:"passkeys"`
}

func (s *Server) handleListPasskeys(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	creds, err := s.Passkeys.ListCredentials(r.Context(), userID)
	if err != nil {
		s.logf("api: list passkeys for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	// The credential this very request's session was minted by, or nil when the
	// session predates 00034 or came from the ID-token exchange. A failure to
	// read it is NOT a 500: the listing is still completely correct without a
	// marker, and refusing to show a user their passkeys because a supplementary
	// lookup failed is a worse answer than the one already available.
	var mine []byte
	if tok, ok := bearerToken(r); ok {
		var err error
		if mine, err = s.Sessions.CredentialForSession(r.Context(), tok); err != nil {
			s.logf("api: list passkeys for %s: resolve current credential: %v", userID, err)
			mine = nil
		}
	}

	out := PasskeysResponse{Passkeys: make([]PasskeySummary, 0, len(creds))}
	for _, c := range creds {
		out.Passkeys = append(out.Passkeys, PasskeySummary{
			CredentialID: base64.StdEncoding.EncodeToString(c.ID),
			CreatedAt:    c.CreatedAt,
			LastUsedAt:   c.LastUsedAt,
			// Deliberately left at its zero value: there is no AAGUID name table
			// on this deployment and a name will not be invented. See the header.
			Authenticator: nil,
			// bytes.Equal, not a length-guarded compare: mine is nil for an
			// unattributed session and c.ID is never empty, so nil marks nothing.
			Current: len(mine) > 0 && bytes.Equal(mine, c.ID),
		})
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeletePasskey(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	// PathValue is already percent-decoded by the mux, so the client's
	// encodeURIComponent round-trips: a '/' inside standard base64 arrives as
	// %2F and stays inside this one segment.
	raw, err := base64.StdEncoding.DecodeString(r.PathValue("credential_id"))
	if err != nil {
		// A 400 describes the caller's own submission and says nothing about
		// which credentials exist.
		writeErr(w, http.StatusBadRequest, "bad_request", "credential id is not standard base64")
		return
	}

	// The caller's own session, spared from the UNATTRIBUTED sweep only — if it
	// was minted by the credential being removed, it goes with it. requireSession
	// has already resolved this token, so the read cannot fail here; push.go
	// re-extracts it the same way rather than widening authedHandler for two
	// handlers out of twenty.
	var keep []byte
	if tok, ok := bearerToken(r); ok {
		keep = auth.SessionHash(tok)
	}

	revoked, err := s.Passkeys.DeleteCredential(r.Context(), userID, raw, keep)
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrLastPasskey):
		// The spec's own code, and the ONE thing this endpoint refuses on
		// policy rather than on identity. The detail is safe and is the reason
		// the rule exists — a client that only shows the code still has
		// something true to say.
		s.logf("api: delete passkey for %s: refused, it is the account's last credential", userID)
		writeErr(w, http.StatusConflict, "last_passkey",
			"this is the only passkey on the account; removing it would lock you out permanently")
		return
	case errors.Is(err, auth.ErrCredentialUnknown):
		// Not an oracle: a caller can only ever ask about ids under their own
		// session, and "somebody else's credential" answers identically to "no
		// such credential" (auth.DeleteCredential returns one sentinel for both).
		s.logf("api: delete passkey for %s: no such credential on this account", userID)
		writeErr(w, http.StatusNotFound, "not_found", "no such passkey on this account")
		return
	default:
		s.logf("api: delete passkey for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}

	// Loud in the log, because a user who is unexpectedly signed out somewhere
	// should be explicable from it: this is now exactly the removed credential's
	// sessions plus any this server could not attribute.
	s.logf("api: delete passkey for %s: removed, revoked %d session(s) it had authenticated", userID, revoked)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
