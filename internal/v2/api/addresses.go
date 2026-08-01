package api

// The inbound-address endpoints: read the account's mail slot, and rotate it.
//
// # Why rotation is gated harder than anything else here
//
// The inbound address is where the user's bank mail arrives. Rotating it ends
// every forward rule and bank-side registration pointed at the old one, and the
// user finds out by noticing, days later, that transactions stopped appearing.
// It is destructive, it is silent, and spec §3.4 therefore puts it in the same
// class as account deletion:
//
//	"Account deletion (§3.10) and address rotation require fresh IdP
//	 re-authentication *plus* an on-device confirmation backed by key
//	 possession."
//
// So POST /api/v1/address/rotate demands all three, and the session is the
// weakest of them:
//
//  1. a live session — which account is being talked about, and NOTHING else;
//  2. a fresh ID token from the account's IdP, verified here and required to
//     resolve to the SAME user the session names;
//  3. an Ed25519 signature by an enrolled, non-revoked device key over a
//     single-use nonce from POST /api/v1/address/challenge.
//
// Steps 2 and 3 are independent on purpose. A stolen session has neither. A
// stolen ID token (which the exchange endpoint's doc admits is a replayable
// bearer credential there) has no device key. Malware on an unlocked device
// that can sign has no way to produce a fresh IdP assertion.
//
// And the two are not merely independent, they are TIED: the nonce the ID token
// must carry is the same single-use challenge factor 3 signs and spends, so a
// token minted for one rotation cannot authorize another. That binding is what
// makes "fresh" mean minted-for-this-action rather than merely still-valid, and
// it is the thing Phase 1 shipped as an empty auth.VerifyOpts{}. The exchange
// endpoint still has no such store and is deliberately left unbound; see
// handleExchange, which says so in full.
//
// # GET is allowed to issue, and that is not a hole
//
// GET /api/v1/address mints the account's first address if it has none, so a
// fresh account has a mail slot without a separate provisioning call. That is a
// session-only write, deliberately: creating the FIRST address gives a session
// holder nothing it could not already read, whereas rotation destroys a working
// one. Concurrency is safe by construction — the partial unique index permits
// one active address per user, and addresses.Ensure converges on it.

import (
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/auth"
)

// AddressResponse answers both GET /api/v1/address and POST
// /api/v1/address/rotate.
//
// RotatesFrom and GraceUntil are populated only while the predecessor is STILL
// ACCEPTING. Once the window closes they are dropped rather than left behind as
// history: their whole purpose is to drive the "your old address stops working
// on X" countdown, and an address shown next to a deadline that has already
// passed reads as though it still works.
type AddressResponse struct {
	Address   string    `json:"address"`
	CreatedAt time.Time `json:"created_at"`
	// RotatesFrom is the full previous address, still accepting until
	// GraceUntil.
	RotatesFrom string     `json:"rotates_from,omitempty"`
	GraceUntil  *time.Time `json:"grace_until,omitempty"`
}

// RotateRequest is POST /api/v1/address/rotate.
//
// IdP/IDToken are the fresh re-authentication; Nonce/Sig are the proof of key
// possession, the signature being over
// addresses.RotationMessage(nonce, user_id, current_local_part).
type RotateRequest struct {
	IdP     string `json:"idp"`
	IDToken string `json:"id_token"`
	Nonce   string `json:"nonce"` // base64
	Sig     string `json:"sig"`   // base64
}

// handleAddress returns the caller's inbound address, minting one on first
// read. See the file header for why a GET is permitted to do that.
func (s *Server) handleAddress(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	addr, err := s.Addresses.Ensure(r.Context(), userID)
	if err != nil {
		s.logf("api: address for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	s.writeAddress(w, r, userID, addr)
}

// handleAddressChallenge mints a single-use rotation nonce.
//
// The per-user cap is the point of the rate limit: minting is exactly what a
// session authorizes, so without one a session can fill the challenge table as
// fast as it can issue requests. The nonce is worthless without a signature
// from an enrolled key, so the cap protects storage rather than the capability.
func (s *Server) handleAddressChallenge(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	if !s.AddressPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many address requests; try again shortly")
		return
	}
	nonce, err := s.Addresses.RotationChallenge(r.Context(), userID)
	if err != nil {
		s.logf("api: address challenge for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, ChallengeResponse{Nonce: base64.StdEncoding.EncodeToString(nonce)})
}

// handleAddressRotate retires the caller's address and mints a replacement.
//
// Every authorization failure — a stale or replayed nonce, a signature from an
// unenrolled or revoked key, an ID token naming a different account, a token
// the provider will not vouch for — is the SAME 403 with the SAME empty body.
// Distinguishing them would tell a caller who could not prove key possession
// whether a nonce exists and which of the two factors it still needs.
//
// Malformed input (bad base64, a missing field, an unknown IdP) is a 400
// instead: that describes the caller's own submission, reveals nothing about
// the account, and answering it as an authorization failure would send a client
// with a coding bug into an endless re-authentication loop.
func (s *Server) handleAddressRotate(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	// Attempts need their own cap, not just challenge minting: a failed attempt
	// spends a challenge but a caller can always mint another, and signature
	// verification plus a roster read is real work to hand an unauthenticated
	// guess.
	if !s.AddressPerUser.Allow(userID.String()) {
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many address requests; try again shortly")
		return
	}
	var req RotateRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	verifier, ok := s.Verifiers[req.IdP]
	if !ok || verifier == nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "unsupported idp")
		return
	}
	if req.IDToken == "" {
		writeErr(w, http.StatusBadRequest, "bad_request", "id_token is required: rotation needs fresh re-authentication")
		return
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

	// Factor 2: fresh IdP re-authentication, BOUND to this specific rotation
	// and bound to the session's account.
	//
	// # The nonce is the real binding, and it is the rotation challenge itself
	//
	// VerifyOpts.Nonce only defeats replay when the expected value comes from
	// server-side state created BEFORE the token existed — issue, store,
	// compare, consume exactly once. Phase 1 passed an empty VerifyOpts here
	// and said the store did not exist, which was not true of THIS endpoint:
	// address_rotation_challenges is exactly that store (32 bytes from
	// crypto/rand, 5-minute TTL, spent by RotateAuthorized before it verifies
	// anything), it was already in the same commit, and the only thing missing
	// was passing it. So "fresh IdP re-authentication" checked nothing at all:
	// any currently-valid ID token satisfied factor 2.
	//
	// The value is the CANONICAL encoding of the decoded nonce, not the string
	// the caller typed: it is the exact string POST /api/v1/address/challenge
	// handed out, which is what the client passes to Apple or Google as `nonce`
	// when it starts authorization. A caller who re-encodes it differently is
	// normalized onto the server's own spelling rather than being refused for
	// base64 trivia.
	//
	// Consume-once is not implemented here — it is RotateAuthorized below,
	// which spends the challenge whether or not the signature verifies. A
	// replayed token therefore fails twice over: its nonce names a challenge
	// that is already spent, and factor 3 cannot be satisfied with it.
	//
	// MaxAge matches the account-deletion path exactly. The two are one class
	// (spec §3.4) and account.go documented rotation's missing window as a gap
	// in rotation rather than a policy difference; this closes it.
	id, err := verifier.Verify(r.Context(), req.IDToken, auth.VerifyOpts{
		Nonce:  base64.StdEncoding.EncodeToString(nonce),
		MaxAge: reauthMaxAge,
	})
	if err != nil {
		if errors.Is(err, auth.ErrNotConfigured) || errors.Is(err, auth.ErrKeySetUnavailable) {
			// A fact about the server, not the credential: the user's token may
			// be perfectly good. Answering 403 would send them to re-authenticate
			// against a provider whose next token we still could not verify.
			s.logf("api: rotate address for %s: %v", userID, err)
			writeErr(w, http.StatusServiceUnavailable, "unavailable", "identity provider is unavailable")
			return
		}
		s.logf("api: rotate address for %s: id token rejected: %v", userID, err)
		writeAddressRotationRejected(w)
		return
	}
	// Re-checked against the Identity, not only handed to the verifier, so a
	// Verifier implementation that ignored MaxAge cannot silently turn this
	// back into a session-plus-key endpoint. Same guard, same reason, as
	// account.go's.
	if id.IssuedAt.IsZero() || s.now().Sub(id.IssuedAt) > reauthMaxAge {
		s.logf("api: rotate address for %s: id token is not fresh (iat %s)", userID, id.IssuedAt.UTC())
		writeAddressRotationRejected(w)
		return
	}
	// A COMPARISON, never auth.UpsertUser.
	//
	// This handler used to resolve the re-authenticating identity by UPSERTING
	// it, which resolves an unknown subject by CREATING it: one valid session
	// plus any Apple or Google token minted a `users` row on every rejected
	// rotation — a row-creation primitive on the path that answers 403. Since
	// Phase 2 it is worse than untidy, because account creation is the closed
	// beta's only gate (see handleExchange) and this was a way straight past
	// it. account.go found and fixed the same defect on the deletion path;
	// auth.IdentityMatchesUser is that fix, extracted so the two cannot drift.
	same, err := auth.IdentityMatchesUser(r.Context(), s.Pool, userID, id)
	if err != nil {
		s.logf("api: rotate address for %s: resolve re-auth identity: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if !same {
		s.logf("api: rotate address for %s: re-auth names a different account", userID)
		writeAddressRotationRejected(w)
		return
	}

	// Factor 3: proof of key possession. RotateAuthorized spends the challenge
	// before it verifies anything, so one challenge buys one attempt.
	local, until, err := s.Addresses.RotateAuthorized(r.Context(), userID, nonce, sig)
	switch {
	case err == nil:
	case errors.Is(err, addresses.ErrRotationRejected):
		s.logf("api: rotate address for %s: %v", userID, err)
		writeAddressRotationRejected(w)
		return
	case errors.Is(err, addresses.ErrNoActiveAddress):
		// Nothing to rotate. It describes the caller's own account, which they
		// can already read from GET /api/v1/address, so it is safe to say.
		writeErr(w, http.StatusConflict, "no_address", "this account has no active address to rotate")
		return
	default:
		s.logf("api: rotate address for %s: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}

	addr, err := s.Addresses.Current(r.Context(), userID)
	if err != nil {
		// The rotation already COMMITTED; only the read-back failed. Answering
		// an error here would tell the client the rotation did not happen when
		// it did, and a client that retried would rotate a second time — a
		// second cutover, a second broken forward rule, for one user action.
		// Everything the response needs is already in hand: the deadline came
		// back from the rotation, and the new address was created exactly one
		// grace window before it.
		s.logf("api: rotate address for %s: read back: %v", userID, err)
		writeJSON(w, http.StatusOK, AddressResponse{
			Address:    s.Addresses.Address(local),
			CreatedAt:  until.Add(-s.Addresses.GraceWindow()),
			GraceUntil: &until,
		})
		return
	}
	s.writeAddress(w, r, userID, addr)
}

// writeAddress renders an address plus, when one is still accepting, its
// predecessor and that predecessor's deadline.
func (s *Server) writeAddress(w http.ResponseWriter, r *http.Request, userID uuid.UUID, addr addresses.Address) {
	out := AddressResponse{Address: s.Addresses.Address(addr.LocalPart), CreatedAt: addr.CreatedAt}
	// The store answers "still accepting?" against ITS clock, which is the one
	// the SMTP path enforces. Comparing here against the API's own clock would
	// let the countdown outlive the address it counts down for.
	switch prev, live, err := s.Addresses.Predecessor(r.Context(), addr); {
	case err != nil:
		// Not fatal: the address itself is what the caller asked for, and the
		// countdown is decoration on top of it.
		s.logf("api: address for %s: read predecessor: %v", userID, err)
	case live:
		until := prev.ExpiresAt
		out.RotatesFrom = s.Addresses.Address(prev.LocalPart)
		out.GraceUntil = &until
	}
	writeJSON(w, http.StatusOK, out)
}

// writeAddressRotationRejected is the ONE rejection the rotation endpoint
// emits. It takes no arguments precisely so no caller can vary it.
func writeAddressRotationRejected(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "rotation_rejected", "")
}
