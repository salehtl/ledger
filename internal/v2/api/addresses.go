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
// bearer credential in Phase 1) has no device key. Malware on an unlocked
// device that can sign has no way to produce a fresh IdP assertion.
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

	// Factor 2: fresh IdP re-authentication, bound to the session's account.
	//
	// The binding is the load-bearing half. Verifying the token and not
	// checking WHO it names would accept any valid Apple or Google token from
	// anyone as "re-authentication" for this session's account.
	//
	// Phase 1 caveat, stated plainly rather than papered over: the exchange
	// endpoint binds no nonce (see handleExchange), so "fresh" here means the
	// token is currently valid, not that it was minted for THIS action. A token
	// captured within its validity window satisfies this check. Closing it
	// needs the issue -> store -> compare -> consume-once flow described at
	// handleExchange, and it is the same fix in both places.
	id, err := verifier.Verify(r.Context(), req.IDToken, auth.VerifyOpts{})
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
	reauthed, err := auth.UpsertUser(r.Context(), s.Pool, id)
	if err != nil {
		s.logf("api: rotate address for %s: resolve re-auth identity: %v", userID, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	if reauthed != userID {
		s.logf("api: rotate address for %s: re-auth names a different account (%s)", userID, reauthed)
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
