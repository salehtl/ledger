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
//  2. a fresh WebAuthn assertion by an enrolled credential of THAT account,
//     over the single-use nonce from POST /api/v1/account/challenge;
//  3. an Ed25519 signature by an enrolled, non-revoked device key over the
//     same nonce.
//
// A stolen session has neither of the other two. Malware on an unlocked device
// that can sign cannot produce an assertion; an authenticator that can produce
// an assertion is not an enrolled writer.
//
// # Factor 2 used to be an ID token, and could not be satisfied by anyone
//
// This endpoint originally required a fresh ID token from the account's IdP.
// v2 is passkeys-only — apple_client_ids and google_client_ids are both empty,
// because dropping the native client removed the App Store rule that forced
// Sign in with Apple, and v2 never had passwords. With no verifier configured
// the factor could never be presented, so the endpoint answered 403 to
// everybody. It was not a policy; it was a path left behind when the identity
// providers were removed.
//
// The replacement is strictly stronger, and the old header said so about the
// old scheme's weakness: an ID token binds no nonce unless the flow arranges
// one, so "fresh" meant "minted inside the window", not "minted FOR this
// action" — a token captured inside that window satisfied it. A WebAuthn
// assertion signs a challenge THIS server minted for THIS deletion, so it is
// bound to the action by construction and is worthless anywhere else.
//
// (For the record, because the previous version of this comment was wrong
// about it: auth.VerifyOpts carries BOTH Nonce and MaxAge, and the rotation
// and deletion paths were both passing a Nonce. The paragraph claiming
// "VerifyOpts carries MaxAge and nothing else" predated commit e03e264 and was
// never updated. It is moot now — no verifier is consulted here at all.)
//
// The challenge is REUSED, not doubled: one nonce is the assertion's challenge
// and the device key's message. Two challenges would be two expiries collected
// in one user gesture, and a flow where one dies while the other is still good
// fails halfway for a reason the user cannot see.
//
// # An account with no device key cannot delete itself here
//
// Same locked door addresses.RotateAuthorized documents, and the same reason:
// the alternative is that a session token alone is sufficient. A user who has
// lost every device re-enrolls one (POST /api/v1/writers/register, which is
// trust-on-first-use for an account with no live key) or asks the operator.
//
// # A deployment with no relying party answers 503, not 403
//
// s.Passkeys is nil when no rp_id is configured, and factor 2 then cannot be
// presented by anybody. That is a fact about the SERVER — exactly the case the
// ID-token path answered 503 for — and it must not be a 403, which would send
// every user off to re-authenticate against a ceremony this process would
// refuse again. It is also precisely the shape of the defect that made this
// endpoint unusable for months, so it is loud.
//
// # What the answer says
//
// Every authorization failure is the SAME 403 with the SAME empty body: a
// missing assertion, an assertion over a challenge this server did not mint,
// an assertion from another account's credential, a spent nonce, an unenrolled
// or revoked device key. Distinguishing them tells a caller who could not
// prove key possession which factor they still need.
//
// A failure that is NOT a rejection is loud and different. Nothing is dropped
// silently: a purge that could not complete answers 500 and says the account
// was not deleted, because a client that showed "your account has been deleted"
// over a failed purge would be the worst possible outcome of this endpoint.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
	"ledger/internal/v2/purge"
)

// reauthMaxAge is how recently an IdP ID token must have been minted to count
// as fresh re-authentication (spec §3.4). Five minutes: long enough for a
// provider round trip on a bad connection plus the confirmation the client
// shows, short enough that a token captured from a log is worthless by the
// time anyone reads it.
//
// DELETION NO LONGER USES IT. Its factor 2 is a passkey assertion, whose
// freshness is the challenge's own TTL and nothing else — one window for one
// gesture. It stays here because POST /api/v1/address/rotate still takes an ID
// token and reads this constant (addresses.go), and it is the same window
// purge.ChallengeTTL uses so that rotation's two factors cannot expire apart.
const reauthMaxAge = 5 * time.Minute

// DeleteAccountRequest is DELETE /api/v1/account.
//
// There is ONE window in this flow and it is purge.ChallengeTTL. The freshness
// of the re-authentication is not a second, independently-checked age: the
// assertion is over the challenge, and the challenge dies on its own clock.
type DeleteAccountRequest struct {
	// Assertion is the browser's PublicKeyCredential for a
	// navigator.credentials.get() over Nonce, forwarded to go-webauthn's own
	// parser untouched — this package never has to agree with the library
	// about the shape of an authenticator response.
	Assertion json.RawMessage `json:"assertion"`
	// Nonce is the challenge from POST /api/v1/account/challenge (base64). It
	// is BOTH the assertion's challenge and the device key's message.
	Nonce string `json:"nonce"`
	// Sig is the Ed25519 signature over purge.DeletionMessage(nonce, user_id)
	// by an enrolled device writer (base64).
	Sig string `json:"sig"`
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
	// costs two signature verifications, a credential read and a roster read.
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

	if s.Passkeys == nil {
		// A fact about the server, not about the caller. See the file header.
		s.logf("api: delete account %s: no relying party is configured, so the "+
			"re-authentication factor cannot be presented by anyone", userID)
		writeErr(w, http.StatusServiceUnavailable, "unavailable",
			"this server cannot verify a passkey re-authentication")
		return
	}

	// Factor 2: a fresh passkey assertion over THIS server's challenge, by an
	// enrolled credential of the account the session names.
	//
	// The account binding is inside VerifyAssertion and is the load-bearing
	// half: verifying an assertion without checking whose credential signed it
	// would accept anybody's passkey as re-authentication for this session.
	//
	// Nothing is written on this path and nothing may be. The IdP version of
	// this handler resolved its identity with auth.UpsertUser and therefore
	// CREATED a users row for an unknown subject on the way to answering 403 —
	// a row-creation primitive on the endpoint whose whole job is destruction.
	// An assertion cannot create anything: an unknown credential is a
	// rejection, never a first enrolment (auth.Passkeys.VerifyAssertion).
	if err := s.Passkeys.VerifyAssertion(r.Context(), userID, nonce, req.Assertion); err != nil {
		if errors.Is(err, auth.ErrPasskeyRejected) {
			// The reason is logged, never returned.
			s.logf("api: delete account %s: re-authentication rejected: %v", userID, err)
			writeDeletionRejected(w)
			return
		}
		s.logf("api: delete account %s: verify assertion: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
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
