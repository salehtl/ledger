package api

// Account deletion: spec §3.10, gated by spec §3.4.
//
// # Why this is in-app and self-service
//
// App Review guideline 5.1.1(v) requires an app that creates an account to
// offer deleting it from inside the app. That is the compliance reason. The
// product reason is the one on the privacy page: "users own their data" is a
// claim about what they can take away from us, and deletion is the half that
// proves it. `ledgerd purge-user` exists for the operator, but an operator-only
// path is a promise the user has to ask permission to collect on.
//
// # Three factors, and the session is the weakest
//
// Identical structure to POST /api/v1/address/rotate (addresses.go), for a
// stronger version of the same reason — a rotation silently ends the user's
// mail flow; this ends everything, permanently, with no undo:
//
//  1. a live session — which account is being talked about, and NOTHING else;
//  2. a fresh ID token from the account's IdP, verified here, required to
//     resolve to the SAME user the session names, and required to have been
//     minted within reauthMaxAge;
//  3. an Ed25519 signature by an enrolled, non-revoked device key over a
//     single-use nonce from POST /api/v1/account/challenge.
//
// A stolen session has neither of the other two. A stolen ID token (which the
// exchange endpoint's doc admits is a replayable bearer credential in Phase 1)
// has no device key. Malware on an unlocked device that can sign cannot produce
// an IdP assertion.
//
// What factor 2 does NOT prove, stated rather than implied: THIS ENDPOINT
// binds no IdP nonce — VerifyOpts carries MaxAge and nothing else — so "fresh"
// means the token was minted within the window, not that it was minted FOR
// this action. A token captured inside that window satisfies it. The window is
// what bounds the exposure until a nonce is bound here.
//
// Address rotation is the same ceremony and DOES bind one, because its
// challenge is issued before the token exists (addresses.go). Deletion could
// take the same step, and should: the nonce it already issues is an Ed25519
// challenge for factor 3, and passing it as VerifyOpts.Nonce as well would cost
// nothing here. It is not done in this commit because no client sends it yet —
// Task 26 builds this screen — and a server that began requiring a nonce no
// client supplies would make in-app account deletion impossible, which is the
// one thing App Review 5.1.1(v) will not accept. When that client lands, this
// is a one-line change and the per-provider hashing is already handled:
// auth.nonceClaimFor applies Apple's hex-SHA-256 rule inside the verifier, so
// the caller passes the raw challenge exactly as rotation does.
//
// # An account with no device key cannot delete itself here
//
// Same locked door addresses.RotateAuthorized documents, and the same reason:
// the alternative is that a session token alone is sufficient. A user who has
// lost every device re-enrolls one (POST /api/v1/writers/register, which is
// trust-on-first-use for an account with no live key) or asks the operator.
//
// # What the answer says
//
// Every authorization failure is the SAME 403 with the SAME empty body: a
// spent nonce, an unenrolled key, a stale token, a token naming a different
// account. Distinguishing them tells a caller who could not prove key
// possession which factor they still need.
//
// A failure that is NOT a rejection is loud and different. Nothing is dropped
// silently: a purge that could not complete answers 500 and says the account
// was not deleted, because a client that showed "your account has been deleted"
// over a failed purge would be the worst possible outcome of this endpoint.

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/purge"
)

// reauthMaxAge is how recently the ID token must have been minted to count as
// "fresh IdP re-authentication" (spec §3.4). Five minutes: long enough for a
// provider round trip on a bad connection plus the confirmation the client
// shows, short enough that a token captured from a log is worthless by the
// time anyone reads it.
//
// It is the same window purge.ChallengeTTL uses, and deliberately so — both
// factors are collected in one user gesture, and a design where one expires
// while the other is still good produces a flow that fails halfway for reasons
// the user cannot see.
const reauthMaxAge = 5 * time.Minute

// DeleteAccountRequest is DELETE /api/v1/account.
//
// IdP/IDToken are the fresh re-authentication; Nonce/Sig are the proof of key
// possession, the signature being over purge.DeletionMessage(nonce, user_id).
type DeleteAccountRequest struct {
	IdP     string `json:"idp"`
	IDToken string `json:"id_token"`
	Nonce   string `json:"nonce"` // base64
	Sig     string `json:"sig"`   // base64
}

// handleAccountChallenge mints a single-use deletion nonce.
//
// Minting is exactly what a session authorizes and nothing more: the nonce is
// worthless without a signature from an enrolled device key. The per-user rate
// limit therefore protects the table, not the capability.
func (s *Server) handleAccountChallenge(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.AccountPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many account requests; try again shortly")
		return
	}
	nonce, err := s.Deletion.Issue(r.Context(), userID)
	if err != nil {
		s.logf("api: account challenge for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, ChallengeResponse{Nonce: base64.StdEncoding.EncodeToString(nonce)})
}

// handleDeleteAccount purges the caller's account once all three factors are
// present. See the file header.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	// Attempts need their own cap, not just challenge minting: a failed attempt
	// spends a challenge, a caller can always mint another, and every attempt
	// costs a signature verification, a roster read and (for a real verifier) a
	// JWKS lookup.
	if !s.AccountPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many account requests; try again shortly")
		return
	}
	var req DeleteAccountRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}

	// Malformed input is a 400: it describes the caller's own submission and
	// says nothing about the account. An ABSENT credential is not malformed —
	// it is a failure to present a factor, and it falls through to the same 403
	// as presenting a wrong one, so a caller cannot learn which of the three
	// they are missing by watching the status code change.
	if req.IdP != "" {
		if v, ok := s.Verifiers[req.IdP]; !ok || v == nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "unsupported idp")
			return
		}
	}
	nonce, err := base64.StdEncoding.DecodeString(req.Nonce)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "nonce is not base64")
		return
	}
	sig, err := base64.StdEncoding.DecodeString(req.Sig)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "sig is not base64")
		return
	}

	verifier := s.Verifiers[req.IdP]
	if verifier == nil || req.IDToken == "" {
		s.logf("api: delete account %s: no re-authentication presented", userID)
		writeDeletionRejected(w)
		return
	}

	// Factor 2: fresh IdP re-authentication, bound to the session's account.
	//
	// MaxAge goes to the verifier because that is where it can be checked
	// against the AUTHENTICATED payload; it is re-checked below against the
	// Identity, so a Verifier implementation that ignored the option cannot
	// silently turn this endpoint back into a session-plus-key one.
	id, err := verifier.Verify(r.Context(), req.IDToken, auth.VerifyOpts{MaxAge: reauthMaxAge})
	if err != nil {
		if errors.Is(err, auth.ErrNotConfigured) || errors.Is(err, auth.ErrKeySetUnavailable) {
			// A fact about the server, not the credential. Answering 403 would
			// send the user to re-authenticate against a provider whose next
			// token we still could not verify.
			s.logf("api: delete account %s: %v", userID, err)
			writeErr(w, http.StatusServiceUnavailable, "unavailable", "identity provider is unavailable")
			return
		}
		s.logf("api: delete account %s: id token rejected: %v", userID, err)
		writeDeletionRejected(w)
		return
	}
	if id.IssuedAt.IsZero() || s.now().Sub(id.IssuedAt) > reauthMaxAge {
		s.logf("api: delete account %s: id token is not fresh (iat %s)", userID, id.IssuedAt.UTC())
		writeDeletionRejected(w)
		return
	}
	// The binding is the load-bearing half: verifying a token and not checking
	// WHO it names would accept any valid Apple or Google token from anyone as
	// re-authentication for this session's account.
	//
	// It is a COMPARISON, never auth.UpsertUser. Upserting here — which an
	// earlier version of this handler did, copying the rotation path — resolves
	// the identity by CREATING it when the subject is unknown, so a caller
	// holding one valid session plus any Apple or Google token could mint a
	// `users` row on every rejected delete. A row-creation primitive on the
	// endpoint whose entire job is destruction, reached on the path that
	// answers 403. Each stray account then sits in the retention sweep's
	// WithoutConsentRecord list for ever, because nobody ever signed anything
	// for it.
	//
	// Comparing the subject hash needs no write at all: users.idp_sub_hash is
	// exactly SubjectHash(idp, subject), and constant-time comparison keeps
	// this from being an oracle for which hashes exist.
	var want []byte
	if err := s.Pool.QueryRow(r.Context(),
		`SELECT idp_sub_hash FROM users WHERE id = $1 AND idp = $2`,
		userID, id.IdP).Scan(&want); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// The session's account does not exist under this provider — a
			// deleted account with a live token, or a token from the other IdP.
			s.logf("api: delete account %s: no %s identity for this account", userID, id.IdP)
			writeDeletionRejected(w)
			return
		}
		s.logf("api: delete account %s: read identity: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if subtle.ConstantTimeCompare(want, auth.SubjectHash(id.IdP, id.Subject)) != 1 {
		s.logf("api: delete account %s: re-auth names a different account", userID)
		writeDeletionRejected(w)
		return
	}

	// Factor 3: proof of key possession. Authorize spends the challenge before
	// it verifies anything, so one challenge buys one attempt.
	if err := s.Deletion.Authorize(r.Context(), userID, nonce, sig); err != nil {
		if errors.Is(err, purge.ErrDeletionRejected) {
			s.logf("api: delete account %s: %v", userID, err)
			writeDeletionRejected(w)
			return
		}
		s.logf("api: delete account %s: authorize: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}

	rep, err := purge.Purge(r.Context(), s.Pool, s.Dict, userID)
	if err != nil {
		// LOUD. The purge is all-or-nothing, so this means the account is still
		// here — and a client that rendered "your account has been deleted"
		// over this would be the worst outcome this endpoint has. The detail is
		// safe to return: it describes the caller's own account and the reason
		// is an operator-side defect, not a fact about their credentials.
		s.logf("api: delete account %s: PURGE FAILED, account intact: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "deletion_failed",
			"the account was NOT deleted and nothing was removed; this is a server-side "+
				"fault, not a problem with your request")
		return
	}
	s.logf("api: delete account %s: purged %d rows across %d tables", userID, rep.Total(), len(rep.Rows))
	if len(rep.SweptWithoutCascade) > 0 {
		// A schema defect the purge worked around. It is not the user's
		// problem, and it is very much the operator's.
		s.logf("api: delete account %s: tables needed an explicit sweep (missing ON DELETE "+
			"CASCADE): %v", userID, rep.SweptWithoutCascade)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

// writeDeletionRejected is the ONE rejection this endpoint emits. It takes no
// arguments precisely so no caller can vary it.
func writeDeletionRejected(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "deletion_rejected", "")
}
