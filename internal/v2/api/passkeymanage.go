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
// # Two fields that are honest about what this deployment does not know
//
// `authenticator` is always null. Turning an AAGUID into "iCloud Keychain"
// needs the FIDO Metadata Service blob, which this server does not ship and
// this task did not invent a table for. The field is on the wire because the
// client reads it and a name can be filled in later without a wire change; null
// says "unknown", which is true.
//
// `current` is always false, and that is the design's one open question landing
// on the floor. `sessions` records (token_hash, user_id, created_at,
// expires_at, revoked_at) and NOT which credential authenticated it, so this
// server genuinely cannot say which row is the one the caller is standing on.
// Guessing — say, by matching last_used_at against the session's created_at —
// would label a row "this device" on an inference that re-authentication and
// any later sign-in both break, and a wrong "this device" marker is worse than
// none. It needs a migration; see auth/passkey_manage.go's header for the
// column and for what the same column would fix about session revocation.
//
// # Removing a passkey signs the account's other devices out
//
// Because the credential→session link does not exist, DELETE revokes every
// session of the account EXCEPT the caller's own. That is a superset of the
// right answer: the removed credential's sessions are certainly among them, so
// the lost phone is signed out and its push registrations are deleted, while
// the user's other devices are signed out too and must re-authenticate with a
// passkey they still hold. Stated plainly rather than smoothed over — it is the
// cost of the missing column, and it is the right side to err on.

import (
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
	// Current marks the credential that authenticated THIS session, and is
	// always false because sessions do not record one. See the file header.
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
	out := PasskeysResponse{Passkeys: make([]PasskeySummary, 0, len(creds))}
	for _, c := range creds {
		out.Passkeys = append(out.Passkeys, PasskeySummary{
			CredentialID: base64.StdEncoding.EncodeToString(c.ID),
			CreatedAt:    c.CreatedAt,
			LastUsedAt:   c.LastUsedAt,
			// Both deliberately left at their zero values. See the file header;
			// this server does not know either fact and will not invent it.
			Authenticator: nil,
			Current:       false,
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

	// The session whose access must survive its own request. requireSession has
	// already resolved this token, so the read cannot fail here; push.go
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

	// Loud in the log, because the user is about to notice it: every other
	// device on this account has just been signed out. See the file header.
	s.logf("api: delete passkey for %s: removed, revoked %d other session(s)", userID, revoked)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
