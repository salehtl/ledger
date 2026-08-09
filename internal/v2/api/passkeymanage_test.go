package api

// Tests for passkeymanage.go — GET /api/v1/auth/passkeys and
// DELETE /api/v1/auth/passkeys/{credential_id}.
//
// What is worth measuring here, over and above auth's own tests:
//
//   - the WIRE shape the shipped client is already committed to, field by
//     field, including that no key material can travel on it;
//   - the last-passkey refusal arriving as 409 {"error":"last_passkey"} rather
//     than as the package's collapsed 401;
//   - a caller reaching only their own account's credentials, with no user
//     field on the wire to reach anything else with;
//   - the id surviving the round trip through a URL path, which is the one
//     thing standard base64 is bad at.

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"ledger/internal/v2/authtest"
)

// addCredential enrols a second credential over the real add ceremony.
func (h *harness) addCredential(token string) *authtest.Authenticator {
	h.t.Helper()
	id, opts := h.beginCreate("/api/v1/auth/passkey/add/begin", token, map[string]any{})
	a := authtest.New(h.t)
	w := h.req("POST", "/api/v1/auth/passkey/add/finish", token, PasskeyFinishRequest{
		CeremonyID: id, Credential: a.Create(h.t, opts),
	})
	wantStatus(h.t, w, http.StatusOK)
	return a
}

func (h *harness) listPasskeys(token string) PasskeysResponse {
	h.t.Helper()
	w := h.req("GET", "/api/v1/auth/passkeys", token, nil)
	wantStatus(h.t, w, http.StatusOK)
	return decodeJSON[PasskeysResponse](h.t, w)
}

// passkeyPath builds the DELETE path the way the client does — the id is
// standard base64, whose '+', '/' and '=' would otherwise change the route.
func passkeyPath(credID []byte) string {
	return "/api/v1/auth/passkeys/" + url.QueryEscape(base64.StdEncoding.EncodeToString(credID))
}

// ---------------------------------------------------------------------------
// Mounting and authentication
// ---------------------------------------------------------------------------

func TestPasskeyManagementRoutesAreNotMountedWithoutARelyingParty(t *testing.T) {
	h := newHarness(t)
	for method, path := range map[string]string{
		"GET":    "/api/v1/auth/passkeys",
		"DELETE": "/api/v1/auth/passkeys/" + url.QueryEscape(b64([]byte("cred-1"))),
	} {
		w := h.req(method, path, "", nil)
		wantStatus(t, w, http.StatusNotFound)
		if got := w.Body.String(); got != `{"error":"not_found","detail":"no such endpoint"}` {
			t.Fatalf("%s %s answered %s, want the API 404 rather than an HTML fallthrough", method, path, got)
		}
	}
}

func TestPasskeyManagementRequiresASession(t *testing.T) {
	h := newHarness(t).passkeys()
	for method, path := range map[string]string{
		"GET":    "/api/v1/auth/passkeys",
		"DELETE": "/api/v1/auth/passkeys/" + url.QueryEscape(b64([]byte("cred-1"))),
	} {
		w := h.req(method, path, "", nil)
		wantStatus(t, w, http.StatusUnauthorized)
		if got := w.Body.String(); got != `{"error":"unauthorized"}` {
			t.Fatalf("%s %s answered %s", method, path, got)
		}
	}
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

// TestListPasskeysCarriesFiveFieldsAndNoKeyMaterial pins the wire contract
// web/src/v2/passkeys.ts parses, and the spec's flat rule that the endpoint
// returns no public key. The key check is done against the ACTUAL stored bytes
// in every encoding this API uses anywhere, so a future SELECT that widened by
// one column would fail here rather than in production.
func TestListPasskeysCarriesFiveFieldsAndNoKeyMaterial(t *testing.T) {
	h := newHarness(t).passkeys()
	_, session := h.register(h.invite("passkey beta"))
	second := h.addCredential(session.SessionToken)

	w := h.req("GET", "/api/v1/auth/passkeys", session.SessionToken, nil)
	wantStatus(t, w, http.StatusOK)
	body := w.Body.String()

	var raw struct {
		Passkeys []map[string]json.RawMessage `json:"passkeys"`
	}
	if err := json.Unmarshal([]byte(body), &raw); err != nil {
		t.Fatalf("decode %s: %v", body, err)
	}
	if len(raw.Passkeys) != 2 {
		t.Fatalf("%d passkeys, want 2 (%s)", len(raw.Passkeys), body)
	}
	want := map[string]bool{
		"credential_id": true, "created_at": true, "last_used_at": true,
		"authenticator": true, "current": true,
	}
	for i, row := range raw.Passkeys {
		if len(row) != len(want) {
			t.Fatalf("row %d has %d fields, want exactly %d: %v", i, len(row), len(want), row)
		}
		for k := range row {
			if !want[k] {
				t.Fatalf("row %d carries an unexpected field %q — the client reads five and no more", i, k)
			}
		}
	}

	// Every public key this account holds, in every encoding this API uses.
	rows, err := h.pool.Query(bg,
		`SELECT public_key FROM webauthn_credentials WHERE user_id = $1`, mustUUID(t, session.UserID))
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	keys := 0
	for rows.Next() {
		var pk []byte
		if err := rows.Scan(&pk); err != nil {
			t.Fatal(err)
		}
		keys++
		for _, enc := range []string{
			base64.StdEncoding.EncodeToString(pk),
			base64.RawURLEncoding.EncodeToString(pk),
			hex.EncodeToString(pk),
		} {
			if strings.Contains(body, enc) {
				t.Fatalf("the listing contains a credential's public key material")
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if keys != 2 {
		t.Fatalf("checked %d public keys, want 2 — the fixture did not enrol what the test assumes", keys)
	}

	// And the parsed values are the ones the screen renders.
	out := decodeJSON[PasskeysResponse](t, w)
	if out.Passkeys[1].CredentialID != base64.StdEncoding.EncodeToString(second.CredID) {
		t.Fatalf("second credential id is %q", out.Passkeys[1].CredentialID)
	}
	for i, p := range out.Passkeys {
		if p.CreatedAt.IsZero() {
			t.Fatalf("row %d has no created_at", i)
		}
		if p.LastUsedAt != nil {
			t.Fatalf("row %d reports a last use, but neither credential has asserted", i)
		}
		// An honest null on this deployment: there is no AAGUID name table.
		// See passkeymanage.go's header.
		if p.Authenticator != nil {
			t.Fatalf("row %d named an authenticator this server cannot resolve", i)
		}
	}
	// The session came out of register/finish, so it IS the first credential's.
	if !out.Passkeys[0].Current {
		t.Fatal("the credential that registered this session is not marked current")
	}
	if out.Passkeys[1].Current {
		t.Fatal("a credential that authenticated nothing is marked current")
	}
}

// TestTheCurrentMarkerFollowsTheCredentialTheSessionWasMintedWith is the
// design's one open question, resolved: the marker is READ from
// sessions.credential_id (00034), never inferred from last_used_at.
//
// The second half is the property that made the previous agent refuse to guess:
// a session with no recorded credential marks NOTHING, rather than marking the
// most recently used credential and being wrong.
func TestTheCurrentMarkerFollowsTheCredentialTheSessionWasMintedWith(t *testing.T) {
	h := newHarness(t).passkeys()
	_, session := h.register(h.invite("two devices"))
	second := h.addCredential(session.SessionToken)

	// Sign in on the SECOND credential. The marker must move with it, which no
	// last_used_at inference could get right for both sessions at once.
	id, opts := h.beginAssert("/api/v1/auth/passkey/login/begin", "")
	w := h.req("POST", "/api/v1/auth/passkey/login/finish", "", PasskeyFinishRequest{
		CeremonyID: id, Credential: second.Assert(h.t, opts, second.Counter+1),
	})
	wantStatus(t, w, http.StatusOK)
	onSecond := decodeJSON[ExchangeResponse](t, w).SessionToken

	marked := func(token string) []bool {
		var out []bool
		for _, p := range h.listPasskeys(token).Passkeys {
			out = append(out, p.Current)
		}
		return out
	}
	if got := marked(session.SessionToken); len(got) != 2 || !got[0] || got[1] {
		t.Fatalf("the registration session marks %v, want [true false]", got)
	}
	if got := marked(onSecond); len(got) != 2 || got[0] || !got[1] {
		t.Fatalf("the session signed in on the second credential marks %v, want [false true]", got)
	}

	// A session that records no credential — an exchange session, or one minted
	// before 00034 — marks nothing at all.
	unattributed := h.session(mustUUID(t, session.UserID))
	for i, p := range h.listPasskeys(unattributed).Passkeys {
		if p.Current {
			t.Fatalf("row %d is marked current for a session that records no credential", i)
		}
	}
}

func TestListPasskeysOnlyEverShowsTheCallersOwnCredentials(t *testing.T) {
	h := newHarness(t).passkeys()
	_, mine := h.register(h.invite("mine"))
	_, theirs := h.register(h.invite("theirs"))

	got := h.listPasskeys(mine.SessionToken)
	if len(got.Passkeys) != 1 {
		t.Fatalf("%d passkeys for the first account, want 1", len(got.Passkeys))
	}
	other := h.listPasskeys(theirs.SessionToken)
	if len(other.Passkeys) != 1 {
		t.Fatalf("%d passkeys for the second account, want 1", len(other.Passkeys))
	}
	if got.Passkeys[0].CredentialID == other.Passkeys[0].CredentialID {
		t.Fatal("two accounts were shown the same credential")
	}
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

func TestDeletingTheLastPasskeyIsRefusedByTheServer(t *testing.T) {
	h := newHarness(t).passkeys()
	a, session := h.register(h.invite("one device"))

	w := h.req("DELETE", passkeyPath(a.CredID), session.SessionToken, nil)
	wantStatus(t, w, http.StatusConflict)
	var e struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &e); err != nil {
		t.Fatal(err)
	}
	if e.Error != "last_passkey" {
		t.Fatalf(`error code is %q, want "last_passkey" — the client keys its message on it`, e.Error)
	}
	if got := h.listPasskeys(session.SessionToken); len(got.Passkeys) != 1 {
		t.Fatalf("%d passkeys survive the refusal, want 1", len(got.Passkeys))
	}
}

func TestDeletingAPasskeyRemovesItAndThenRefusesTheRemainingOne(t *testing.T) {
	h := newHarness(t).passkeys()
	first, session := h.register(h.invite("two devices"))
	// The session was minted by `first`, so `first` is the one credential this
	// caller cannot remove without signing itself out. It removes the OTHER one,
	// which is what the screen's "current" marker steers a user towards.
	second := h.addCredential(session.SessionToken)

	w := h.req("DELETE", passkeyPath(second.CredID), session.SessionToken, nil)
	wantStatus(t, w, http.StatusNoContent)
	if w.Body.Len() != 0 {
		t.Fatalf("204 carried a body: %s", w.Body.String())
	}

	got := h.listPasskeys(session.SessionToken)
	if len(got.Passkeys) != 1 ||
		got.Passkeys[0].CredentialID != base64.StdEncoding.EncodeToString(first.CredID) {
		t.Fatalf("after the removal the listing is %+v", got.Passkeys)
	}
	wantStatus(t, h.req("DELETE", passkeyPath(first.CredID), session.SessionToken, nil), http.StatusConflict)
}

// TestDeletingAPasskeyTakesItsKeyWrapWithIt goes through the real
// POST /api/v1/keys/wraps so the row under test is the one production writes.
// The cascade is 00028's, which is why it is measured over HTTP as well as in
// auth: nothing in the handler would notice if the schema lost it.
func TestDeletingAPasskeyTakesItsKeyWrapWithIt(t *testing.T) {
	h := newHarness(t).passkeys()
	first, session := h.register(h.invite("prf"))
	second := h.addCredential(session.SessionToken)
	userID := mustUUID(t, session.UserID)

	for _, cred := range [][]byte{first.CredID, second.CredID} {
		wantStatus(t, h.req("POST", "/api/v1/keys/wraps", session.SessionToken, map[string]any{
			"credential_id": b64(cred), "wrapped": b64(prfWrap(3)), "wrap_version": 1,
		}), http.StatusNoContent)
	}
	if n := h.countWraps(userID); n != 2 {
		t.Fatalf("%d wraps before the removal, want 2", n)
	}

	// The added credential goes: this session was minted by `first`, and removing
	// that one would sign the caller out before it could read the wraps back.
	wantStatus(t, h.req("DELETE", passkeyPath(second.CredID), session.SessionToken, nil), http.StatusNoContent)

	if n := h.countWraps(userID); n != 1 {
		t.Fatalf("%d wraps after the removal, want 1 — the ON DELETE CASCADE did not fire", n)
	}
	wraps := decodeJSON[KeyWrapsResponse](t, h.req("GET", "/api/v1/keys/wraps", session.SessionToken, nil))
	if len(wraps.Wraps) != 1 || wraps.Wraps[0].CredentialID != b64(first.CredID) {
		t.Fatalf("the surviving wrap is %+v", wraps.Wraps)
	}
}

// TestDeletingAPasskeyEndsOnlyThatPasskeysSessions is the point of the feature
// over HTTP, and the narrowing 00034 bought: the lost phone is signed out, the
// user's OTHER device is not.
//
// The caller here is signed in on the credential that survives, which is the
// ordinary shape of "remove my lost phone".
func TestDeletingAPasskeyEndsOnlyThatPasskeysSessions(t *testing.T) {
	h := newHarness(t).passkeys()
	// Three ceremonies plus five plain requests is past the shipped per-IP burst
	// of 12. The limit itself has its own test; this one is about revocation.
	h.srv.PasskeyPerIP = NewLimiter(passkeyPerIPRate, 64, passkeyMaxKeys, h.srv.now)
	lost, lostSession := h.register(h.invite("lost phone"))
	second := h.addCredential(lostSession.SessionToken)
	userID := mustUUID(t, lostSession.UserID)

	// The caller: a sign-in on the credential that will survive.
	id, opts := h.beginAssert("/api/v1/auth/passkey/login/begin", "")
	w := h.req("POST", "/api/v1/auth/passkey/login/finish", "", PasskeyFinishRequest{
		CeremonyID: id, Credential: second.Assert(t, opts, second.Counter+1),
	})
	wantStatus(t, w, http.StatusOK)
	caller := decodeJSON[ExchangeResponse](t, w).SessionToken

	// A session this server cannot attribute, and another account's, which must
	// be untouched.
	unattributed := h.session(userID)
	_, bystander := h.register(h.invite("a bystander"))

	wantStatus(t, h.req("DELETE", passkeyPath(lost.CredID), caller, nil), http.StatusNoContent)

	if w := h.req("GET", "/api/v1/auth/passkeys", lostSession.SessionToken, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("the removed passkey's session still works (status %d) — the lost phone is still signed in", w.Code)
	}
	if w := h.req("GET", "/api/v1/auth/passkeys", unattributed, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("a session this server cannot attribute survived (status %d); it might have been the lost phone's", w.Code)
	}
	wantStatus(t, h.req("GET", "/api/v1/auth/passkeys", caller, nil), http.StatusOK)
	wantStatus(t, h.req("GET", "/api/v1/auth/passkeys", bystander.SessionToken, nil), http.StatusOK)
}

// TestDeletingAPasskeyLeavesTheAccountsOtherDevicesSignedIn is the regression
// this whole change exists to prevent: before 00034 the DELETE revoked every
// session but the caller's, so retiring a phone signed the laptop out.
func TestDeletingAPasskeyLeavesTheAccountsOtherDevicesSignedIn(t *testing.T) {
	h := newHarness(t).passkeys()
	first, session := h.register(h.invite("phone and laptop"))
	laptopCred := h.addCredential(session.SessionToken)

	// The laptop signs in on its own credential.
	id, opts := h.beginAssert("/api/v1/auth/passkey/login/begin", "")
	w := h.req("POST", "/api/v1/auth/passkey/login/finish", "", PasskeyFinishRequest{
		CeremonyID: id, Credential: laptopCred.Assert(t, opts, laptopCred.Counter+1),
	})
	wantStatus(t, w, http.StatusOK)
	laptop := decodeJSON[ExchangeResponse](t, w).SessionToken

	// The phone removes its own passkey. It is standing on that credential, so
	// it signs ITSELF out — and only itself.
	wantStatus(t, h.req("DELETE", passkeyPath(first.CredID), session.SessionToken, nil), http.StatusNoContent)

	if w := h.req("GET", "/api/v1/auth/passkeys", laptop, nil); w.Code != http.StatusOK {
		t.Fatalf("the laptop was signed out (status %d) by a removal that had nothing to do with it", w.Code)
	}
	if w := h.req("GET", "/api/v1/auth/passkeys", session.SessionToken, nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("the caller removed the credential its own session was minted with and is still signed in (status %d)", w.Code)
	}
}

func TestDeletingAnotherAccountsPasskeyIsRefusedAndLeavesItAlone(t *testing.T) {
	h := newHarness(t).passkeys()
	_, attacker := h.register(h.invite("attacker"))
	h.addCredential(attacker.SessionToken) // so the last-passkey rule is not what stops them
	victimCred, victim := h.register(h.invite("victim"))

	w := h.req("DELETE", passkeyPath(victimCred.CredID), attacker.SessionToken, nil)
	wantStatus(t, w, http.StatusNotFound)

	got := h.listPasskeys(victim.SessionToken)
	if len(got.Passkeys) != 1 ||
		got.Passkeys[0].CredentialID != base64.StdEncoding.EncodeToString(victimCred.CredID) {
		t.Fatalf("the victim's credential did not survive: %+v", got.Passkeys)
	}
	// An id that exists NOWHERE answers identically, so the status code is not
	// an oracle for which credential ids exist.
	wantStatus(t, h.req("DELETE", passkeyPath([]byte("no such credential")), attacker.SessionToken, nil),
		http.StatusNotFound)
}

// TestDeletingAPasskeyWhoseIdNeedsEscapingWorks covers the one thing standard
// base64 is bad at: '+', '/' and '=' in a URL path. The client percent-encodes
// the id; this asserts the route still matches and the right row goes.
func TestDeletingAPasskeyWhoseIdNeedsEscapingWorks(t *testing.T) {
	h := newHarness(t).passkeys()
	u := h.user("escaping")
	token := h.session(u)
	awkward := []byte{0xff, 0xff, 0xff, 0xfb, 0xef, 0xbe, 0x01}
	if enc := base64.StdEncoding.EncodeToString(awkward); !strings.ContainsAny(enc, "+/=") {
		t.Fatalf("the fixture id %q does not exercise the escaping this test exists for", enc)
	}
	h.credential(u, awkward)
	h.credential(u, []byte("plain-credential-id"))

	wantStatus(t, h.req("DELETE", passkeyPath(awkward), token, nil), http.StatusNoContent)
	got := h.listPasskeys(token)
	if len(got.Passkeys) != 1 || got.Passkeys[0].CredentialID != b64([]byte("plain-credential-id")) {
		t.Fatalf("the wrong credential was removed: %+v", got.Passkeys)
	}
}

func TestDeletingAPasskeyWithAMalformedIdIsABadRequest(t *testing.T) {
	h := newHarness(t).passkeys()
	_, session := h.register(h.invite("malformed"))
	w := h.req("DELETE", "/api/v1/auth/passkeys/not!base64", session.SessionToken, nil)
	wantStatus(t, w, http.StatusBadRequest)
}

// TestPasskeyManagementIsRateLimited keeps the two new routes on the budget
// every other passkey route is on: they are session-authenticated, and the
// limiter runs before the session is resolved.
func TestPasskeyManagementIsRateLimited(t *testing.T) {
	h := newHarness(t).passkeys()
	_, session := h.register(h.invite("limits"))
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/v1/auth/passkeys"},
		{"DELETE", "/api/v1/auth/passkeys/" + url.QueryEscape(b64([]byte("cred-1")))},
	} {
		method, path := route.method, route.path
		// A limiter with no refill, so the budget is exactly the burst.
		h.srv.PasskeyPerIP = NewLimiter(0, 1, 16, h.srv.now)
		if w := h.req(method, path, session.SessionToken, nil); w.Code == http.StatusTooManyRequests {
			t.Fatalf("%s %s was refused on its first request", method, path)
		}
		if w := h.req(method, path, session.SessionToken, nil); w.Code != http.StatusTooManyRequests {
			t.Fatalf("%s %s answered %d on a spent budget, want 429", method, path, w.Code)
		}
	}
}

func mustUUID(t *testing.T, s string) uuid.UUID {
	t.Helper()
	u, err := uuid.Parse(s)
	if err != nil {
		t.Fatalf("user id %q is not a uuid: %v", s, err)
	}
	return u
}
