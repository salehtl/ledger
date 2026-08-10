package api

// The six passkey routes (spec §3.8, Phase 2 Task 4). They are the PWA's whole
// sign-in surface: WebAuthn replaced Sign in with Apple and Google Sign-In when
// the product dropped Expo, and with it the App Store rule that required them.
//
//	POST /api/v1/auth/passkey/register/begin   {invite_code}            -> {ceremony_id, options}
//	POST /api/v1/auth/passkey/register/finish  {ceremony_id, credential} -> {session_token, user_id}
//	POST /api/v1/auth/passkey/login/begin      {}                       -> {ceremony_id, options}
//	POST /api/v1/auth/passkey/login/finish     {ceremony_id, credential} -> {session_token, user_id}
//	POST /api/v1/auth/passkey/add/begin        {}    (authenticated)    -> {ceremony_id, options}
//	POST /api/v1/auth/passkey/add/finish       {ceremony_id, credential} (authenticated) -> {credential_id}
//
// `options` is go-webauthn's own protocol.CredentialCreation /
// CredentialAssertion, marshalled as-is and passed to the browser untouched.
// That is deliberate: the browser's `navigator.credentials` consumes exactly this
// shape, and any reshaping here would be a second encoder to keep in step with a
// specification neither side owns.
//
// # What these endpoints answer
//
// Everything collapses to the package's ONE 401, with a single exception that is
// the same carve-out the ID-token exchange makes: `403 {"error":"not_invited"}`
// when account creation was required and no unredeemed code authorized it. That
// is a fact about this deployment's policy rather than about the credential, and
// it is the one thing the person holding the phone needs to know.
//
// A rejected ceremony never says WHY. auth returns distinct sentinels — expired,
// replayed, unknown credential, cloned authenticator — and every one of them is a
// useful log line and an oracle in a response.
//
// # Why all six are rate limited
//
// Four of them are unauthenticated, and every begin MINTS A ROW. An endpoint that
// writes server-side state for anyone holding a socket is a memory- and
// disk-growth target, and the sweep that removes expired ceremonies runs on a
// timer, so the table's steady-state size is set by the mint rate. The two `add`
// routes are session-authenticated and limited on the same budget, because the
// limiter runs BEFORE the session is resolved — see requirePasskeySession, and
// handleExchange for the ordering argument in full.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"

	"ledger/internal/v2/auth"
)

// Rate-limit budget. The shape of the legitimate traffic is a person signing in:
// a couple of ceremonies, occasionally retried when a browser prompt is
// dismissed, and then nothing for hours. The burst is therefore generous enough
// to survive a user who cancels the system dialog three times, and the sustained
// rate is mean.
//
// It is deliberately looser than the challenge budgets (1/minute) and tighter
// than the sign-in exchange's, because a ceremony costs a row where an exchange
// costs a signature verification.
const (
	passkeyPerIPRate   = 0.2 // 12/minute sustained
	passkeyPerIPBurst  = 12
	passkeyMaxKeys     = 4096
	passkeyGlobalRate  = 20
	passkeyGlobalBurst = 100
)

// PasskeyRegisterBeginRequest starts a sign-up.
type PasskeyRegisterBeginRequest struct {
	InviteCode string `json:"invite_code"`
}

// PasskeyBeginResponse is what all three begin steps answer with. Options is
// go-webauthn's own structure, embedded verbatim.
type PasskeyBeginResponse struct {
	CeremonyID string          `json:"ceremony_id"`
	Options    json.RawMessage `json:"options"`
}

// PasskeyFinishRequest carries the browser's response to a ceremony.
//
// Credential is the raw PublicKeyCredential JSON, forwarded to go-webauthn's own
// parser without being decoded here. This package therefore never has to agree
// with the library about the shape of an attestation object, which is the sort of
// disagreement that produces a verifier that accepts something it should not.
type PasskeyFinishRequest struct {
	CeremonyID string          `json:"ceremony_id"`
	Credential json.RawMessage `json:"credential"`
}

// PasskeyAddResponse names the credential that was enrolled. Standard base64,
// matching every other binary field in this API.
type PasskeyAddResponse struct {
	CredentialID string `json:"credential_id"`
}

// passkeyLimited wraps a handler in the two limiters, in the order that matters:
// per-IP first, and a global token is spent only by a request that already passed
// it. See handleExchange — the other order lets one host drain the shared budget
// with requests the per-IP limiter was about to refuse anyway, and hold every
// other client at 429 indefinitely.
func (s *Server) passkeyLimited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.PasskeyPerIP.Allow(clientKey(r)) || !s.PasskeyGlobal.Allow("") {
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "too many passkey attempts")
			return
		}
		h(w, r)
	}
}

// passkeyLimitedSession is passkeyLimited for the two authenticated routes. The
// limiter runs BEFORE requireSession, so a caller with no session at all still
// spends a token: otherwise the cheapest way to bypass the limit would be to omit
// the credential.
func (s *Server) passkeyLimitedSession(h authedHandler) http.HandlerFunc {
	return s.passkeyLimited(s.requireSession(h))
}

func (s *Server) handlePasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	var req PasskeyRegisterBeginRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	id, opts, err := s.Passkeys.BeginRegistration(r.Context(), req.InviteCode)
	if err != nil {
		s.writePasskeyError(w, r, "register/begin", err)
		return
	}
	s.writeBegin(w, r, id, opts)
}

func (s *Server) handlePasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	var req PasskeyFinishRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	userID, credID, err := s.Passkeys.FinishRegistration(r.Context(), req.CeremonyID, req.Credential)
	if err != nil {
		s.writePasskeyError(w, r, "register/finish", err)
		return
	}
	s.writeSession(w, r, userID, credID)
}

func (s *Server) handlePasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	// No body is read: a discoverable login carries nothing at all. Anything the
	// caller sent is ignored rather than refused, because a client that posts
	// `{}` and a client that posts nothing are both correct here.
	id, opts, err := s.Passkeys.BeginLogin(r.Context())
	if err != nil {
		s.writePasskeyError(w, r, "login/begin", err)
		return
	}
	s.writeBegin(w, r, id, opts)
}

func (s *Server) handlePasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	var req PasskeyFinishRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	userID, credID, err := s.Passkeys.FinishLogin(r.Context(), req.CeremonyID, req.Credential)
	if err != nil {
		s.writePasskeyError(w, r, "login/finish", err)
		return
	}
	s.writeSession(w, r, userID, credID)
}

func (s *Server) handlePasskeyAddBegin(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	id, opts, err := s.Passkeys.BeginAdd(r.Context(), userID)
	if err != nil {
		s.writePasskeyError(w, r, "add/begin", err)
		return
	}
	s.writeBegin(w, r, id, opts)
}

func (s *Server) handlePasskeyAddFinish(w http.ResponseWriter, r *http.Request, userID uuid.UUID) {
	var req PasskeyFinishRequest
	if !decodeBody(w, r, maxSmallBodyBytes, &req) {
		return
	}
	credID, err := s.Passkeys.FinishAdd(r.Context(), req.CeremonyID, userID, req.Credential)
	if err != nil {
		s.writePasskeyError(w, r, "add/finish", err)
		return
	}
	writeJSON(w, http.StatusOK, PasskeyAddResponse{
		CredentialID: base64.StdEncoding.EncodeToString(credID),
	})
}

// writeBegin marshals go-webauthn's options into the envelope. The options are
// re-marshalled rather than streamed so that a marshalling failure produces a 500
// instead of a half-written 200.
func (s *Server) writeBegin(w http.ResponseWriter, r *http.Request, ceremonyID string, opts any) {
	raw, err := json.Marshal(opts)
	if err != nil {
		s.logf("api: %s %s: marshal ceremony options: %v", r.Method, r.URL.Path, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, PasskeyBeginResponse{CeremonyID: ceremonyID, Options: raw})
}

// writeSession issues the session a completed sign-in earns, ATTRIBUTED to the
// credential that just finished the ceremony. It is the same session the
// ID-token exchange mints, deliberately: a passkey changes how an identity is
// established and changes nothing about what a session is.
//
// credID is the one thing it adds, and it is the whole of 00034's point. Both
// callers — register/finish and login/finish — genuinely know it, because
// go-webauthn returns the credential it verified and auth returns it upward.
// The exchange path in sync.go does NOT know one (no credential authenticated
// it) and calls Sessions.Issue, which records NULL rather than a guess.
func (s *Server) writeSession(w http.ResponseWriter, r *http.Request, userID uuid.UUID, credID []byte) {
	token, err := s.Sessions.IssueForCredential(r.Context(), userID, credID)
	if err != nil {
		s.logf("api: %s %s: issue session: %v", r.Method, r.URL.Path, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, ExchangeResponse{SessionToken: token, UserID: userID.String()})
}

// writePasskeyError is the single translation point, so no handler can invent a
// status of its own.
//
// Two answers only. `not_invited` is the deployment-policy fact, and everything
// else — expired ceremony, replayed ceremony, unknown credential, a signature
// that did not verify, a cloned authenticator — is the one 401. A failure that is
// not a rejection (the database is unreachable) is a 500, on the same reasoning
// requireSession applies: reporting infrastructure trouble as "your credential is
// invalid" sends a user off to re-authenticate for no reason.
func (s *Server) writePasskeyError(w http.ResponseWriter, r *http.Request, step string, err error) {
	switch {
	case errors.Is(err, auth.ErrNotInvited):
		s.logf("api: passkey %s: not invited", step)
		writeErr(w, http.StatusForbidden, "not_invited", "")
	case errors.Is(err, auth.ErrPasskeyRejected):
		// The reason is logged, never returned.
		s.logf("api: passkey %s: rejected: %v", step, err)
		writeUnauthorized(w)
	default:
		s.logf("api: passkey %s: %v", step, err)
		writeErr(w, http.StatusInternalServerError, "internal", "")
	}
}
