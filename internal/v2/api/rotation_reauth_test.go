package api

import (
	"context"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"ledger/internal/v2/addresses"
	"ledger/internal/v2/auth"
)

// bindingVerifier is a verifier that actually HONOURS VerifyOpts, which the
// shared fakeVerifier deliberately does not.
//
// It exists because the property under test is not "the handler passed
// something" — it is "the token must carry the nonce THIS SERVER issued". A
// fake that ignores opts cannot fail when the handler passes the wrong value,
// so a test built on one would go green over the exact gap the binding closes.
type bindingVerifier struct {
	// nonce is the `nonce` claim inside the token this verifier will vouch for.
	nonce string
	// issuedAt is the token's `iat`.
	issuedAt time.Time
	subject  string
}

func (v *bindingVerifier) Verify(_ context.Context, idToken string, opts auth.VerifyOpts) (auth.Identity, error) {
	if opts.Nonce != "" && subtle.ConstantTimeCompare([]byte(v.nonce), []byte(opts.Nonce)) != 1 {
		return auth.Identity{}, fmt.Errorf("%w: nonce claim %q, want %q", auth.ErrNonce, v.nonce, opts.Nonce)
	}
	iat := v.issuedAt
	if iat.IsZero() {
		iat = time.Now()
	}
	if opts.MaxAge > 0 {
		if time.Since(iat) > opts.MaxAge {
			return auth.Identity{}, fmt.Errorf("%w: iat %s", auth.ErrStale, iat)
		}
	}
	sub := v.subject
	if sub == "" {
		sub = "sub-" + idToken
	}
	return auth.Identity{IdP: auth.IdPApple, Subject: sub, IssuedAt: iat}, nil
}

// The nonce the handler binds must be the one the CHALLENGE endpoint issued,
// verbatim, in the encoding the client received it in.
func TestRotationBindsTheServerIssuedNonceToTheIdPToken(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, _ := h.signedIn(t, "alice")
	local := strings.TrimSuffix(h.currentAddress(t, session).Address, apiSuffix)

	nonce := h.rotationNonce(t, session)
	sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
	rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
		IdP: "apple", IDToken: "alice",
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig:   base64.StdEncoding.EncodeToString(sig),
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rec.Code, rec.Body.String())
	}
	h.apple.mu.Lock()
	defer h.apple.mu.Unlock()
	if want := base64.StdEncoding.EncodeToString(nonce); h.apple.lastOpts.Nonce != want {
		t.Fatalf("the verifier was asked for nonce %q, want the server-issued %q",
			h.apple.lastOpts.Nonce, want)
	}
	if h.apple.lastOpts.MaxAge != reauthMaxAge {
		t.Fatalf("MaxAge = %v, want %v", h.apple.lastOpts.MaxAge, reauthMaxAge)
	}
}

// A token carrying NO nonce claim, or somebody else's, does not authorize a
// rotation. Same 403, same empty body, as every other refusal here.
func TestRotationRefusesATokenNotBoundToTheChallenge(t *testing.T) {
	for _, tc := range []struct {
		name  string
		claim func(issued string) string
	}{
		{"no nonce claim", func(string) string { return "" }},
		{"a nonce the server never issued", func(string) string { return "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newAddrHarness(t)
			u, session, priv, _ := h.signedIn(t, "alice")
			before := h.currentAddress(t, session)
			local := strings.TrimSuffix(before.Address, apiSuffix)

			nonce := h.rotationNonce(t, session)
			sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
			h.srv.Verifiers[auth.IdPApple] = &bindingVerifier{
				nonce:   tc.claim(base64.StdEncoding.EncodeToString(nonce)),
				subject: "sub-alice",
			}
			rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
				IdP: "apple", IDToken: "alice",
				Nonce: base64.StdEncoding.EncodeToString(nonce),
				Sig:   base64.StdEncoding.EncodeToString(sig),
			})
			if rec.Code != http.StatusForbidden {
				t.Fatalf("got %d %s, want 403", rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); got != `{"error":"rotation_rejected"}` {
				t.Fatalf("body = %s, want the byte-identical rotation_rejected answer", got)
			}
			if after := h.currentAddress(t, session); after.Address != before.Address {
				t.Fatal("a refused rotation still changed the address")
			}
		})
	}
}

// A token minted more than five minutes ago is not "fresh IdP
// re-authentication" (spec §3.4). The account-deletion path already enforces
// this; rotation is in the same class and Phase 1 left it unenforced.
func TestRotationRefusesAStaleIdPToken(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, _ := h.signedIn(t, "alice")
	before := h.currentAddress(t, session)
	local := strings.TrimSuffix(before.Address, apiSuffix)

	nonce := h.rotationNonce(t, session)
	sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
	h.srv.Verifiers[auth.IdPApple] = &bindingVerifier{
		nonce:    base64.StdEncoding.EncodeToString(nonce),
		issuedAt: time.Now().Add(-30 * time.Minute),
		subject:  "sub-alice",
	}
	rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
		IdP: "apple", IDToken: "alice",
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig:   base64.StdEncoding.EncodeToString(sig),
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d %s, want 403", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != `{"error":"rotation_rejected"}` {
		t.Fatalf("body = %s", got)
	}
	if after := h.currentAddress(t, session); after.Address != before.Address {
		t.Fatal("a stale token still rotated the address")
	}
}

// The staleness is re-checked in the HANDLER, against the Identity, so a
// Verifier implementation that ignored MaxAge cannot silently turn this back
// into a session-plus-key endpoint. Same guard account.go documents.
func TestRotationRechecksFreshnessAgainstTheIdentity(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, _ := h.signedIn(t, "alice")
	local := strings.TrimSuffix(h.currentAddress(t, session).Address, apiSuffix)

	nonce := h.rotationNonce(t, session)
	sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
	// A verifier that IGNORES MaxAge entirely and hands back a month-old token.
	h.srv.Verifiers[auth.IdPApple] = &ignoresOptsVerifier{
		id: auth.Identity{IdP: auth.IdPApple, Subject: "sub-alice", IssuedAt: time.Now().Add(-30 * 24 * time.Hour)},
	}
	rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
		IdP: "apple", IDToken: "alice",
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig:   base64.StdEncoding.EncodeToString(sig),
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d %s, want 403", rec.Code, rec.Body.String())
	}
}

type ignoresOptsVerifier struct{ id auth.Identity }

func (v *ignoresOptsVerifier) Verify(context.Context, string, auth.VerifyOpts) (auth.Identity, error) {
	return v.id, nil
}

// All four re-authentication refusals — absent nonce claim, a nonce the server
// never issued, a stale token, and a REPLAY of a nonce that was already spent —
// answer with one byte-identical body. Distinguishing them would tell a caller
// which of the two factors they still need.
func TestEveryReauthRefusalIsByteIdentical(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, _ := h.signedIn(t, "alice")
	// The address budget is 10 attempts and this test makes a dozen. Widening
	// it here keeps the 429s out of the property under test; the budget itself
	// is TestAddressRoutesAreRateLimitedPerUser's subject.
	h.srv.AddressPerUser = NewLimiter(0, 1000, 16, time.Now)

	// build issues a rotation attempt. `reuse` supplies an already-spent nonce
	// for the replay case; otherwise a fresh one is minted, and the verifier is
	// constructed AFTER it is known so a case can vouch for exactly that nonce.
	attempt := func(reuse []byte, v func(nonceB64 string) auth.Verifier) (int, string) {
		nonce := reuse
		if nonce == nil {
			nonce = h.rotationNonce(t, session)
		}
		local := strings.TrimSuffix(h.currentAddress(t, session).Address, apiSuffix)
		sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
		b64 := base64.StdEncoding.EncodeToString(nonce)
		h.srv.Verifiers[auth.IdPApple] = v(b64)
		rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
			IdP: "apple", IDToken: "alice",
			Nonce: b64,
			Sig:   base64.StdEncoding.EncodeToString(sig),
		})
		return rec.Code, rec.Body.String()
	}

	// The replay case needs a nonce that has actually been SPENT, so it is
	// produced by a successful rotation rather than asserted about.
	spent := h.rotationNonce(t, session)
	if code, body := attempt(spent, func(n string) auth.Verifier {
		return &bindingVerifier{nonce: n, subject: "sub-alice"}
	}); code != http.StatusOK {
		t.Fatalf("the rotation that spends the nonce: %d %s", code, body)
	}

	cases := []struct {
		name  string
		reuse []byte
		v     func(nonceB64 string) auth.Verifier
	}{
		{"no nonce claim", nil, func(string) auth.Verifier {
			return &bindingVerifier{nonce: "", subject: "sub-alice"}
		}},
		{"an unissued nonce", nil, func(string) auth.Verifier {
			return &bindingVerifier{nonce: "c29tZXRoaW5nIGVsc2U=", subject: "sub-alice"}
		}},
		{"a stale token", nil, func(n string) auth.Verifier {
			return &bindingVerifier{nonce: n, issuedAt: time.Now().Add(-time.Hour), subject: "sub-alice"}
		}},
		{"a replayed nonce", spent, func(n string) auth.Verifier {
			return &bindingVerifier{nonce: n, subject: "sub-alice"}
		}},
		{"a token for another account", nil, func(n string) auth.Verifier {
			return &bindingVerifier{nonce: n, subject: "sub-mallory"}
		}},
	}
	var bodies []string
	for _, tc := range cases {
		code, body := attempt(tc.reuse, tc.v)
		if code != http.StatusForbidden {
			t.Fatalf("%s answered %d %s, want 403", tc.name, code, body)
		}
		bodies = append(bodies, body)
	}
	for i, b := range bodies {
		if b != bodies[0] {
			t.Fatalf("refusal %d reads %q but the first reads %q", i, b, bodies[0])
		}
	}
	if bodies[0] != `{"error":"rotation_rejected"}` {
		t.Fatalf("the refusal body changed to %q", bodies[0])
	}
}

// Rotation must not be an account-creation primitive. Resolving the re-auth
// identity by UPSERTING it meant one valid session plus any Apple token minted
// a users row on the path that answers 403 — and since Phase 2, a way straight
// past the invite gate.
func TestARefusedRotationCreatesNoAccount(t *testing.T) {
	h := newAddrHarness(t)
	u, session, priv, _ := h.signedIn(t, "alice")
	local := strings.TrimSuffix(h.currentAddress(t, session).Address, apiSuffix)
	before := h.countUsers(t)

	nonce := h.rotationNonce(t, session)
	sig := ed25519.Sign(priv, addresses.RotationMessage(nonce, u, local))
	// A perfectly valid token for somebody this deployment has never seen.
	h.srv.Verifiers[auth.IdPApple] = &bindingVerifier{
		nonce:   base64.StdEncoding.EncodeToString(nonce),
		subject: "sub-a-complete-stranger",
	}
	rec := h.req(http.MethodPost, "/api/v1/address/rotate", session, RotateRequest{
		IdP: "apple", IDToken: "stranger",
		Nonce: base64.StdEncoding.EncodeToString(nonce),
		Sig:   base64.StdEncoding.EncodeToString(sig),
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("got %d %s, want 403", rec.Code, rec.Body.String())
	}
	if after := h.countUsers(t); after != before {
		t.Fatalf("a refused rotation minted %d account(s): the re-auth path is a sign-up bypass",
			after-before)
	}
}
