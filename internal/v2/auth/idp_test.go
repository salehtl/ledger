package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ledger/internal/v2/pgtest"
)

// ---------------------------------------------------------------------------
// Hermeticity
//
// Not one test in this file may reach Apple's or Google's real JWKS endpoint.
// Every key below is generated locally in this process and served from an
// httptest server; the only URLs any verifier here is pointed at are
// 127.0.0.1 ones owned by the test. TestVerifierRejectsWrongIssuer and friends
// additionally pin that a rejection on a cheap claim check performs NO network
// I/O at all, which is what keeps a full `go test ./internal/v2/auth/` run
// offline-safe even if a future change points a default verifier somewhere
// real.
//
// Tokens are hand-assembled (base64url of a JSON header, a JSON payload and a
// signature) rather than produced by a JWT library on purpose: half of these
// tests are forgeries — alg:none, an HMAC over the RSA modulus, an injected
// "jwk" header — that no correct signing library will emit. Building them by
// hand is the only way to actually deliver the attack to the verifier.
// ---------------------------------------------------------------------------

const (
	testIssuer      = "https://idp.test"
	testOtherIssuer = "https://other-idp.test"
	testAudience    = "test.ledger.app"
	testSubject     = "001234.abcdef0123456789.0001"
)

var bgctx = context.Background()

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

type testKey struct {
	kid string
	alg string
	use string // published "use"; empty means the JWKS omits it
	rsa *rsa.PrivateKey
	ec  *ecdsa.PrivateKey
}

type keyBundle struct {
	rsa1 *testKey // enrolled in the JWKS by default
	rsa2 *testKey // NEVER enrolled unless a test enrolls it: the attacker's key
	ec1  *testKey // Apple signs with ES256
}

// RSA generation is slow enough to matter across ~20 tests, and the keys are
// immutable, so they are generated once for the package.
var testKeys = sync.OnceValue(func() *keyBundle {
	return &keyBundle{
		rsa1: mustRSAKey("rsa-1"),
		rsa2: mustRSAKey("rsa-2"),
		ec1:  mustECKey("ec-1"),
	}
})

func mustRSAKey(kid string) *testKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return &testKey{kid: kid, alg: "RS256", use: "sig", rsa: k}
}

func mustECKey(kid string) *testKey {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	return &testKey{kid: kid, alg: "ES256", use: "sig", ec: k}
}

// withUse republishes the key under a different "use", so a test can serve a
// key the provider marks for encryption.
func (k *testKey) withUse(use string) *testKey {
	c := *k
	c.use = use
	return &c
}

// withKID returns the same key material published under a different kid. It
// models a provider replacing a key's bytes without changing its identifier —
// the one rotation a kid-by-kid comparison would be blind to.
func (k *testKey) withKID(kid string) *testKey {
	c := *k
	c.kid = kid
	return &c
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// jwk renders the key as the JSON Web Key a JWKS endpoint would publish.
func (k *testKey) jwk() map[string]any {
	var out map[string]any
	if k.rsa != nil {
		out = map[string]any{
			"kty": "RSA",
			"alg": "RS256",
			"kid": k.kid,
			"n":   b64(k.rsa.PublicKey.N.Bytes()),
			"e":   b64(big.NewInt(int64(k.rsa.PublicKey.E)).Bytes()),
		}
	} else {
		out = map[string]any{
			"kty": "EC",
			"alg": "ES256",
			"crv": "P-256",
			"kid": k.kid,
			"x":   b64(pad32(k.ec.PublicKey.X)),
			"y":   b64(pad32(k.ec.PublicKey.Y)),
		}
	}
	if k.use != "" {
		out["use"] = k.use
	}
	return out
}

func pad32(i *big.Int) []byte {
	out := make([]byte, 32)
	i.FillBytes(out)
	return out
}

func (k *testKey) sign(t *testing.T, input []byte) []byte {
	t.Helper()
	sum := sha256.Sum256(input)
	if k.rsa != nil {
		sig, err := rsa.SignPKCS1v15(rand.Reader, k.rsa, crypto.SHA256, sum[:])
		if err != nil {
			t.Fatal(err)
		}
		return sig
	}
	r, s, err := ecdsa.Sign(rand.Reader, k.ec, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return append(pad32(r), pad32(s)...)
}

// ---------------------------------------------------------------------------
// JWKS server
// ---------------------------------------------------------------------------

type jwksServer struct {
	srv     *httptest.Server
	mu      sync.Mutex
	keys    []*testKey
	hits    int
	failing bool
	// gate, when set, makes the NEXT request announce itself on entered and
	// then block until release is closed. One-shot: later requests are served
	// normally.
	entered chan struct{}
	release chan struct{}
}

func newJWKS(t *testing.T, keys ...*testKey) *jwksServer {
	t.Helper()
	j := &jwksServer{keys: keys}
	j.srv = httptest.NewServer(http.HandlerFunc(j.serve))
	t.Cleanup(j.srv.Close)
	return j
}

func (j *jwksServer) serve(w http.ResponseWriter, _ *http.Request) {
	j.mu.Lock()
	j.hits++
	entered, release := j.entered, j.release
	j.entered, j.release = nil, nil
	failing := j.failing
	out := make([]map[string]any, 0, len(j.keys))
	for _, k := range j.keys {
		out = append(out, k.jwk())
	}
	j.mu.Unlock()
	if entered != nil {
		close(entered)
		<-release
	}
	if failing {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"keys": out})
}

func (j *jwksServer) url() string { return j.srv.URL }

// gate arms a one-shot block on the next request, so a test can hold a JWKS
// fetch open while it does something else (such as abort the caller).
func (j *jwksServer) gate() (entered <-chan struct{}, release chan<- struct{}) {
	e, r := make(chan struct{}), make(chan struct{})
	j.mu.Lock()
	j.entered, j.release = e, r
	j.mu.Unlock()
	return e, r
}

// fail makes the endpoint start (or stop) returning 503, modelling a provider
// outage.
func (j *jwksServer) fail(v bool) {
	j.mu.Lock()
	j.failing = v
	j.mu.Unlock()
}

// rotate replaces the published key set, as an IdP does when it retires a
// signing key.
func (j *jwksServer) rotate(keys ...*testKey) {
	j.mu.Lock()
	j.keys = keys
	j.mu.Unlock()
}

func (j *jwksServer) hitCount() int {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.hits
}

// ---------------------------------------------------------------------------
// clock + token minting
// ---------------------------------------------------------------------------

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *clock {
	return &clock{t: time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)}
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// goodClaims is a well-formed Apple/Google-shaped identity token payload.
// Override or delete individual claims by passing them in over; a nil value
// deletes the claim.
func goodClaims(now time.Time, over map[string]any) map[string]any {
	c := map[string]any{
		"iss": testIssuer,
		"sub": testSubject,
		"aud": testAudience,
		"iat": now.Unix(),
		"exp": now.Add(time.Hour).Unix(),
	}
	for k, v := range over {
		if v == nil {
			delete(c, k)
			continue
		}
		c[k] = v
	}
	return c
}

func seg(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b64(b)
}

// mintRaw assembles a compact JWS from an arbitrary header, payload and
// signing function. sign may return nil for an unsigned ("alg":"none") token.
func mintRaw(t *testing.T, hdr, claims map[string]any, sign func([]byte) []byte) string {
	t.Helper()
	input := seg(t, hdr) + "." + seg(t, claims)
	var sig []byte
	if sign != nil {
		sig = sign([]byte(input))
	}
	return input + "." + b64(sig)
}

// mint produces an honestly signed token from k.
func mint(t *testing.T, k *testKey, hdrOver, claims map[string]any) string {
	t.Helper()
	hdr := map[string]any{"alg": k.alg, "typ": "JWT", "kid": k.kid}
	for key, v := range hdrOver {
		if v == nil {
			delete(hdr, key)
			continue
		}
		hdr[key] = v
	}
	return mintRaw(t, hdr, claims, func(in []byte) []byte { return k.sign(t, in) })
}

// verifierOn builds a verifier for the given JWKS, at the given clock, with
// the default single audience.
func verifierOn(j *jwksServer, c *clock) Verifier {
	return NewOIDCVerifier(IdPApple, testIssuer, j.url(), []string{testAudience}, c.now)
}

// mustReject asserts a token is refused for the SPECIFIC reason claimed, not
// merely refused: an attack test that passes for the wrong reason is a test
// that will keep passing after the defence it targets is removed. It also
// pins that every rejection wraps ErrTokenRejected and yields no identity.
func mustReject(t *testing.T, v Verifier, token string, want error) {
	t.Helper()
	mustRejectOpts(t, v, token, VerifyOpts{}, want)
}

func mustRejectOpts(t *testing.T, v Verifier, token string, opts VerifyOpts, want error) {
	t.Helper()
	id, err := v.Verify(bgctx, token, opts)
	if err == nil {
		t.Fatalf("token was ACCEPTED as %+v; want rejection with %v", id, want)
	}
	if !errors.Is(err, want) {
		t.Fatalf("rejected with %v; want an error matching %v", err, want)
	}
	if !errors.Is(err, ErrTokenRejected) {
		t.Fatalf("rejection %v does not wrap ErrTokenRejected", err)
	}
	if id != (Identity{}) {
		t.Fatalf("a rejected token still yielded identity %+v", id)
	}
}

// ---------------------------------------------------------------------------
// Positive path
// ---------------------------------------------------------------------------

func TestVerifierAcceptsAGoodRS256Token(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	id, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if id.IdP != IdPApple || id.Subject != testSubject {
		t.Fatalf("identity = %+v, want {apple %s}", id, testSubject)
	}
}

// Apple signs its identity tokens with ES256, so RS256-only support would fail
// against the live provider on day one.
func TestVerifierAcceptsAGoodES256Token(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.ec1)
	c := newClock()
	v := verifierOn(j, c)

	id, err := v.Verify(bgctx, mint(t, k.ec1, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if id.Subject != testSubject {
		t.Fatalf("subject = %q", id.Subject)
	}
}

// Apple's `aud` is a bare string in some flows and a JSON array in others (an
// app plus its web service ID). Both must work, and the array form must be
// accepted when ANY member is one of ours.
func TestVerifierAcceptsAppleMultiAudienceArray(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{
		"aud": []string{"someone.elses.app", testAudience},
	}))
	if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
		t.Fatalf("multi-audience token rejected: %v", err)
	}
}

// Google issues a different client ID per platform (iOS, Android, web), so the
// configured set has several entries and a token matching any one of them is
// ours.
func TestVerifierAcceptsAnyConfiguredAudience(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := NewOIDCVerifier(IdPGoogle, testIssuer, j.url(),
		[]string{"ios.client.id", "android.client.id", "web.client.id"}, c.now)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"aud": "android.client.id"}))
	id, err := v.Verify(bgctx, tok, VerifyOpts{})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if id.IdP != IdPGoogle {
		t.Fatalf("idp = %q, want google", id.IdP)
	}
}

// ---------------------------------------------------------------------------
// Attack: algorithm confusion
// ---------------------------------------------------------------------------

// Attack: strip the signature and declare the token unsigned. If the verifier
// honours the header's algorithm, every claim becomes attacker-chosen.
func TestVerifierRejectsAlgNone(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mintRaw(t,
		map[string]any{"alg": "none", "typ": "JWT"},
		goodClaims(c.now(), nil), nil)
	mustReject(t, v, tok, ErrAlgorithm)

	// Defence in depth: go-oidc's own SupportedSigningAlgs allow-list must
	// reject this too, so removing our header check above would not open a
	// bypass.
	if _, err := v.(*oidcVerifier).inner.Verify(bgctx, tok); err == nil {
		t.Fatal("go-oidc accepted an alg:none token")
	}
}

// Attack: the classic RSA/HMAC confusion. The RSA public key is public, so if
// the verifier picks its algorithm from the header it will happily treat that
// public modulus as a shared HMAC secret that the attacker also has.
func TestVerifierRejectsHS256SignedWithTheJWKSModulus(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	secret := k.rsa1.rsa.PublicKey.N.Bytes() // exactly what the JWKS publishes as "n"
	tok := mintRaw(t,
		map[string]any{"alg": "HS256", "typ": "JWT", "kid": k.rsa1.kid},
		goodClaims(c.now(), map[string]any{"sub": "attacker"}),
		func(in []byte) []byte {
			mac := hmac.New(sha256.New, secret)
			mac.Write(in)
			return mac.Sum(nil)
		})
	mustReject(t, v, tok, ErrAlgorithm)

	if _, err := v.(*oidcVerifier).inner.Verify(bgctx, tok); err == nil {
		t.Fatal("go-oidc accepted an HS256 token")
	}
}

// ---------------------------------------------------------------------------
// Attack: key injection / key selection
// ---------------------------------------------------------------------------

// Attack: the token carries its own public key in a "jwk" header. A verifier
// that validates against the key the token brought with it validates the
// attacker's signature against the attacker's key.
func TestVerifierRejectsAnEmbeddedJWKHeader(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1) // rsa2 is deliberately NOT published
	c := newClock()
	v := verifierOn(j, c)

	claims := goodClaims(c.now(), map[string]any{"sub": "attacker"})
	tok := mint(t, k.rsa2, map[string]any{"jwk": k.rsa2.jwk()}, claims)
	mustReject(t, v, tok, ErrUntrustedHeader)

	// The header check is a loud rejection, not the only line of defence:
	// the same token without the injected header is still unverifiable,
	// because rsa2 is not in the JWKS at all.
	mustReject(t, v, mint(t, k.rsa2, nil, claims), ErrSignature)

	// "jku" and "x5u" are the same attack pointed at a URL the attacker
	// controls; "x5c" ships a certificate chain instead of a bare key; "crit"
	// demands processing of a header we do not implement. Every entry in
	// forbiddenHeaders is covered here, so adding one without a case is
	// visible.
	rest := map[string]any{
		"jku":  "https://evil.test/keys",
		"x5u":  "https://evil.test/chain.pem",
		"x5c":  []string{"MIIB..."},
		"crit": []string{"exp"},
	}
	if len(rest)+1 != len(forbiddenHeaders) {
		t.Fatalf("forbiddenHeaders has %d entries but this test covers %d", len(forbiddenHeaders), len(rest)+1)
	}
	for hdr, val := range rest {
		t.Run(hdr, func(t *testing.T) {
			mustReject(t, v, mint(t, k.rsa1, map[string]any{hdr: val}, claims), ErrUntrustedHeader)
		})
	}
}

// Attack: sign with a key of the attacker's own making. Nothing else about the
// token is wrong.
func TestVerifierRejectsAKeyNotInTheJWKS(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	mustReject(t, v, mint(t, k.rsa2, nil, goodClaims(c.now(), nil)), ErrSignature)
}

// Attack: point "kid" at a key that is not in the JWKS, or at a DIFFERENT
// enrolled key than the one that actually signed. A verifier that ignores kid
// and tries every key in turn would accept the second case.
func TestVerifierRejectsAMismatchedKid(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1, k.ec1)
	c := newClock()
	v := verifierOn(j, c)

	t.Run("unknown kid", func(t *testing.T) {
		tok := mint(t, k.rsa1, map[string]any{"kid": "no-such-key"}, goodClaims(c.now(), nil))
		mustReject(t, v, tok, ErrSignature)
	})
	t.Run("kid of another enrolled key", func(t *testing.T) {
		tok := mint(t, k.rsa1, map[string]any{"kid": k.ec1.kid}, goodClaims(c.now(), nil))
		mustReject(t, v, tok, ErrSignature)
	})
}

// ---------------------------------------------------------------------------
// Attack: claim substitution
// ---------------------------------------------------------------------------

// Google documents `iss` as EITHER "https://accounts.google.com" or the bare
// "accounts.google.com" and issues both; go-oidc carries a carve-out for
// exactly that pair. A verifier stricter than the library here is not a
// bypass, but it silently fails a subset of real Google sign-ins — which is
// how this was missed the first time.
func TestGoogleVerifierAcceptsBothDocumentedIssuerForms(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	// Google's real issuer with a LOCAL jwks url: the issuer is only ever
	// compared as a string, so this stays hermetic.
	v := NewOIDCVerifier(IdPGoogle, GoogleIssuer, j.url(), []string{testAudience}, c.now)

	for _, iss := range []string{GoogleIssuer, GoogleIssuerNoScheme} {
		t.Run(iss, func(t *testing.T) {
			tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"iss": iss}))
			id, err := v.Verify(bgctx, tok, VerifyOpts{})
			if err != nil {
				t.Fatalf("google issuer %q rejected: %v", iss, err)
			}
			if id.IdP != IdPGoogle {
				t.Fatalf("idp = %q", id.IdP)
			}
		})
	}
}

// The carve-out is Google's alone and is scoped to Google's real issuer, so it
// cannot drift into a general "scheme optional" rule.
func TestTheSchemeLessIssuerAliasIsGoogleOnly(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()

	t.Run("apple gets no alias", func(t *testing.T) {
		v := NewOIDCVerifier(IdPApple, AppleIssuer, j.url(), []string{testAudience}, c.now)
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"iss": "appleid.apple.com"}))
		mustReject(t, v, tok, ErrIssuer)
	})
	t.Run("google with a non-google issuer gets no alias", func(t *testing.T) {
		v := NewOIDCVerifier(IdPGoogle, testIssuer, j.url(), []string{testAudience}, c.now)
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(),
			map[string]any{"iss": strings.TrimPrefix(testIssuer, "https://")}))
		mustReject(t, v, tok, ErrIssuer)
	})
}

// Attack: an attacker who can get a token signed by their own IdP presents it
// to us. Only the configured issuer may mint identities we accept.
func TestVerifierRejectsWrongIssuer(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"iss": "https://evil.test"}))
	mustReject(t, v, tok, ErrIssuer)

	// A claim-level rejection must not have cost a JWKS fetch: the cheap
	// checks run first, which is also what keeps this suite offline.
	if j.hitCount() != 0 {
		t.Fatalf("wrong-issuer rejection fetched the JWKS %d time(s)", j.hitCount())
	}
}

// Attack: replay a token minted for a completely different relying party. The
// signature is genuine and the issuer is right; only `aud` says it was not
// issued to us. This is the check SkipClientIDCheck hands to us, so a missing
// implementation here is an open door, not a missing feature.
func TestVerifierRejectsWrongAudience(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	t.Run("bare string", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"aud": "someone.elses.app"}))
		mustReject(t, v, tok, ErrAudience)
	})
	t.Run("array with no member of ours", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(),
			map[string]any{"aud": []string{"a.app", "b.app"}}))
		mustReject(t, v, tok, ErrAudience)
	})
	t.Run("absent", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"aud": nil}))
		mustReject(t, v, tok, ErrAudience)
	})
	t.Run("empty string", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"aud": ""}))
		mustReject(t, v, tok, ErrAudience)
	})
}

// Attack: a token stolen from a device weeks ago. Identity tokens are
// short-lived precisely so a leaked one stops working.
func TestVerifierRejectsExpiredAndNotYetValid(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	t.Run("expired", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(),
			map[string]any{"exp": c.now().Add(-time.Second).Unix()}))
		mustReject(t, v, tok, ErrExpired)
	})
	t.Run("expires while held", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), nil))
		if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
			t.Fatalf("token should be good now: %v", err)
		}
		c.advance(2 * time.Hour)
		defer c.advance(-2 * time.Hour)
		mustReject(t, v, tok, ErrExpired)
	})
	t.Run("no exp claim at all", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"exp": nil}))
		mustReject(t, v, tok, ErrExpired)
	})
	t.Run("not yet valid", func(t *testing.T) {
		// Beyond the 5-minute clock-skew leeway; inside it is accepted on
		// purpose, which the next subtest pins.
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(),
			map[string]any{"nbf": c.now().Add(30 * time.Minute).Unix()}))
		mustReject(t, v, tok, ErrNotYetValid)
	})
	t.Run("nbf inside the skew leeway is accepted", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(),
			map[string]any{"nbf": c.now().Add(time.Minute).Unix()}))
		if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
			t.Fatalf("nbf 1m ahead should be tolerated as clock skew: %v", err)
		}
	})
}

// Attack: present a genuine Google token to the Apple verifier (or vice
// versa). Each verifier is bound to exactly one issuer and one key set, so a
// token from the other provider is simply not ours.
func TestVerifierRejectsATokenFromTheOtherIdP(t *testing.T) {
	k := testKeys()
	appleJWKS := newJWKS(t, k.ec1)
	googleJWKS := newJWKS(t, k.rsa1)
	c := newClock()

	apple := NewOIDCVerifier(IdPApple, testIssuer, appleJWKS.url(), []string{testAudience}, c.now)
	google := NewOIDCVerifier(IdPGoogle, testOtherIssuer, googleJWKS.url(), []string{testAudience}, c.now)

	googleToken := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"iss": testOtherIssuer}))
	if _, err := google.Verify(bgctx, googleToken, VerifyOpts{}); err != nil {
		t.Fatalf("google token should verify at the google verifier: %v", err)
	}
	mustReject(t, apple, googleToken, ErrIssuer)

	appleToken := mint(t, k.ec1, nil, goodClaims(c.now(), nil))
	if _, err := apple.Verify(bgctx, appleToken, VerifyOpts{}); err != nil {
		t.Fatalf("apple token should verify at the apple verifier: %v", err)
	}
	mustReject(t, google, appleToken, ErrIssuer)
}

// A token with no subject carries no identity. Accepting one would map every
// such token onto a single shared "" user.
func TestVerifierRejectsAMissingSubject(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	for _, sub := range []any{nil, ""} {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"sub": sub}))
		mustReject(t, v, tok, ErrNoSubject)
	}
}

func TestVerifierRejectsMalformedTokens(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)
	good := mint(t, k.rsa1, nil, goodClaims(c.now(), nil))
	parts := strings.Split(good, ".")

	cases := map[string]string{
		"empty":             "",
		"not a jwt":         "hello",
		"two segments":      parts[0] + "." + parts[1],
		"four segments":     good + "." + parts[2],
		"bad base64 header": "!!!." + parts[1] + "." + parts[2],
		"bad base64 body":   parts[0] + ".!!!." + parts[2],
		"header not json":   b64([]byte("nope")) + "." + parts[1] + "." + parts[2],
		"body not json":     parts[0] + "." + b64([]byte("nope")) + "." + parts[2],
	}
	// Verify is reachable unauthenticated, so an oversized token must be
	// refused before anything base64-decodes it into memory.
	//
	// It is a genuinely signed, otherwise-perfect token on purpose: a
	// `strings.Repeat("A", ...)` blob would be rejected as unparseable JSON
	// whether or not the cap existed, so it would pass this test while
	// testing nothing. Mutation-checked — deleting the cap accepts this.
	oversized := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{
		"padding": strings.Repeat("x", maxIDTokenBytes),
	}))
	if len(oversized) <= maxIDTokenBytes {
		t.Fatalf("fixture is %d bytes, which does not exceed the %d cap", len(oversized), maxIDTokenBytes)
	}
	cases["oversized"] = oversized

	for name, tok := range cases {
		t.Run(name, func(t *testing.T) { mustReject(t, v, tok, ErrMalformed) })
	}

	// The cap must not clip a realistically large real-world token.
	big := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{
		"padding": strings.Repeat("x", 2048), // far more claims than either provider sends
	}))
	if len(big) >= maxIDTokenBytes {
		t.Fatalf("a %d-byte token is not under the %d cap; the cap is too tight", len(big), maxIDTokenBytes)
	}
	if _, err := v.Verify(bgctx, big, VerifyOpts{}); err != nil {
		t.Fatalf("a large but legitimate token was rejected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Nonce binding (replay)
// ---------------------------------------------------------------------------

// Without a bound nonce an ID token is a pure bearer credential for the
// sign-in exchange: anything that observes one inside its validity window can
// replay it and be issued a session. These tests pin both the Phase 1 default
// (unbound, and honest about it) and the binding that closes it.
func TestNonceBinding(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	t.Run("unbound is replayable, which is why binding exists", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), nil))
		for i := 0; i < 5; i++ {
			if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
				t.Fatalf("replay %d: %v", i, err)
			}
		}
	})

	// `v` is an APPLE verifier (see verifierOn), so the claim it must be shown
	// is the hash and not the challenge — see nonceClaimFor, and
	// TestNonceClaimIsComparedPerProvider below, which is where the two
	// providers' rules are pinned against a published vector.
	t.Run("bound nonce matches", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"nonce": appleNonceClaim(abcNonce)}))
		if _, err := v.Verify(bgctx, tok, VerifyOpts{Nonce: abcNonce}); err != nil {
			t.Fatalf("matching nonce rejected: %v", err)
		}
	})

	// The replay case: a token captured from someone else's sign-in carries
	// THEIR nonce, so it is useless against a session bound to ours.
	t.Run("captured token carries another sign-in's nonce", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"nonce": appleNonceClaim("someone-elses")}))
		mustRejectOpts(t, v, tok, VerifyOpts{Nonce: abcNonce}, ErrNonce)
	})

	// The failure that would make the whole mechanism decorative: a token with
	// NO nonce must not satisfy a caller that bound one.
	t.Run("token with no nonce cannot satisfy a bound one", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), nil))
		mustRejectOpts(t, v, tok, VerifyOpts{Nonce: abcNonce}, ErrNonce)
	})

	// A nonce on the token but none bound is accepted: the sign-in exchange
	// does not round-trip one, and refusing would break it.
	t.Run("unbound caller ignores a token nonce", func(t *testing.T) {
		tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"nonce": "n-abc123"}))
		if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
			t.Fatalf("unbound verify rejected a token carrying a nonce: %v", err)
		}
	})
}

// abcNonce and appleClaimForABC are a PUBLISHED SHA-256 vector, not a value
// this package computed. `app/src/auth/idp.test.ts` pins the identical pair for
// the client's expectedNonceClaim, so the Go and TypeScript halves are shown to
// agree on a number neither of them produced for the occasion — which is the
// only way the two can be checked against each other with no device here.
const (
	abcNonce         = "abc"
	appleClaimForABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
)

// appleNonceClaim is the test's OWN statement of Apple's rule. It deliberately
// does not call nonceClaimFor: a test that computes its expectation with the
// function under test passes for any function at all, which is precisely the
// "true by construction" shape this project keeps finding.
func appleNonceClaim(nonce string) string {
	sum := sha256.Sum256([]byte(nonce))
	return hex.EncodeToString(sum[:])
}

// TestNonceClaimIsComparedPerProvider is the fix for the defect the client leg
// found: Apple's `nonce` claim is the hex SHA-256 of what it was given and
// Google's is the value itself, and comparing both against the raw challenge
// meant an Apple account could never satisfy address rotation.
//
// The four cases are chosen so that INVERTING the branch fails two of them and
// REMOVING it (comparing raw for both, the old behaviour) fails another two.
// Nothing here passes for a verifier that accepts "raw or hashed": that
// verifier would accept every one of the four, and the two refusals are what
// say it does not.
func TestNonceClaimIsComparedPerProvider(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	apple := NewOIDCVerifier(IdPApple, testIssuer, j.url(), []string{testAudience}, c.now)
	google := NewOIDCVerifier(IdPGoogle, testIssuer, j.url(), []string{testAudience}, c.now)

	// The vector, asserted before it is used, so a broken expectation is a
	// loud failure here rather than a silent one four subtests down.
	if got := appleNonceClaim(abcNonce); got != appleClaimForABC {
		t.Fatalf("the test's own SHA-256 of %q is %s, want the published vector %s", abcNonce, got, appleClaimForABC)
	}

	tokenWithClaim := func(nonce string) string {
		return mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"nonce": nonce}))
	}

	t.Run("apple accepts the hashed claim", func(t *testing.T) {
		if _, err := apple.Verify(bgctx, tokenWithClaim(appleClaimForABC), VerifyOpts{Nonce: abcNonce}); err != nil {
			t.Fatalf("an Apple token carrying hex(sha256(challenge)) was refused: %v — "+
				"this is the defect: no Apple account could rotate its address", err)
		}
	})

	// Inverted dispatch case 1, and also the OLD behaviour: comparing raw for
	// Apple is exactly what shipped, so this subtest is the regression.
	t.Run("apple refuses the raw claim", func(t *testing.T) {
		mustRejectOpts(t, apple, tokenWithClaim(abcNonce), VerifyOpts{Nonce: abcNonce}, ErrNonce)
	})

	t.Run("google accepts the raw claim", func(t *testing.T) {
		if _, err := google.Verify(bgctx, tokenWithClaim(abcNonce), VerifyOpts{Nonce: abcNonce}); err != nil {
			t.Fatalf("a Google token echoing the challenge verbatim was refused: %v", err)
		}
	})

	// Inverted dispatch case 2. Together with the one above, a swapped branch
	// cannot pass: it would hash for Google and not for Apple.
	t.Run("google refuses the hashed claim", func(t *testing.T) {
		mustRejectOpts(t, google, tokenWithClaim(appleClaimForABC), VerifyOpts{Nonce: abcNonce}, ErrNonce)
	})

	// The downgrade this must not become. One provider's assertion must not be
	// interchangeable with the other's, so neither shape is universally
	// acceptable — asserted as a property over both verifiers rather than
	// trusted to the two refusals above being remembered.
	t.Run("neither shape satisfies both providers", func(t *testing.T) {
		for _, claim := range []string{abcNonce, appleClaimForABC} {
			accepted := 0
			for _, v := range []Verifier{apple, google} {
				if _, err := v.Verify(bgctx, tokenWithClaim(claim), VerifyOpts{Nonce: abcNonce}); err == nil {
					accepted++
				}
			}
			if accepted != 1 {
				t.Fatalf("claim %q was accepted by %d of the 2 providers, want exactly 1: "+
					"a shape both accept makes an Apple challenge satisfiable by a Google token", claim, accepted)
			}
		}
	})
}

// The freshness window and the identity comparison are the other two factors
// of the re-authentication ceremony (spec §3.4). They have to keep working
// unchanged now that the nonce is hashed for one provider, and the way they
// would break is subtle: a dispatch that hashed the WRONG thing would refuse
// with ErrNonce and never reach them, so "rotation still works for Google" is
// not evidence that Apple's ceremony completes.
//
// So this walks the whole ceremony for BOTH providers against a real verifier:
// bind the challenge, require the five-minute window, and resolve the identity
// to the account the session names.
func TestReauthCeremonyCompletesForBothProviders(t *testing.T) {
	pool := pgtest.New(t)
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	const maxAge = 5 * time.Minute

	for _, tc := range []struct {
		idp   string
		claim string
	}{
		{IdPApple, appleClaimForABC},
		{IdPGoogle, abcNonce},
	} {
		t.Run(tc.idp, func(t *testing.T) {
			v := NewOIDCVerifier(tc.idp, testIssuer, j.url(), []string{testAudience}, c.now)
			u := mustUpsert(t, pool, Identity{IdP: tc.idp, Subject: testSubject})

			fresh := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"nonce": tc.claim}))
			id, err := v.Verify(bgctx, fresh, VerifyOpts{Nonce: abcNonce, MaxAge: maxAge})
			if err != nil {
				t.Fatalf("%s could not complete a re-authentication: %v", tc.idp, err)
			}
			same, err := IdentityMatchesUser(bgctx, pool, u, id)
			if err != nil {
				t.Fatal(err)
			}
			if !same {
				t.Fatalf("%s: the verified identity did not resolve to the account it belongs to", tc.idp)
			}

			// The window still bites, with the nonce still correct — so this
			// fails for staleness and not for a nonce mismatch.
			stale := goodClaims(c.now().Add(-30*time.Minute), map[string]any{"nonce": tc.claim})
			stale["exp"] = c.now().Add(time.Hour).Unix()
			mustRejectOpts(t, v, mint(t, k.rsa1, nil, stale), VerifyOpts{Nonce: abcNonce, MaxAge: maxAge}, ErrStale)

			// And the identity comparison still refuses a stranger, so a
			// verified token is not on its own an authorization.
			other := mustUpsert(t, pool, Identity{IdP: tc.idp, Subject: "someone-else-" + tc.idp})
			same, err = IdentityMatchesUser(bgctx, pool, other, id)
			if err != nil {
				t.Fatal(err)
			}
			if same {
				t.Fatalf("%s: a token for %s authorized an action on another account", tc.idp, testSubject)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Header media type and unsupported constructs
// ---------------------------------------------------------------------------

// `typ` is optional (Apple omits it) but when present must say this is an ID
// token. Defence in depth against a provider that later signs another token
// type with the same key set — the classic way a token minted for one purpose
// is accepted for another.
func TestVerifierChecksTheTypHeader(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)
	claims := goodClaims(c.now(), nil)

	t.Run("accepted", func(t *testing.T) {
		for _, typ := range []any{nil, "JWT", "jwt", "application/jwt"} {
			tok := mint(t, k.rsa1, map[string]any{"typ": typ}, claims)
			if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
				t.Fatalf("typ %v rejected: %v", typ, err)
			}
		}
	})
	t.Run("rejected", func(t *testing.T) {
		for _, typ := range []string{"at+jwt", "JWE", "secevent+jwt"} {
			tok := mint(t, k.rsa1, map[string]any{"typ": typ}, claims)
			mustReject(t, v, tok, ErrUntrustedHeader)
		}
	})
}

// Aggregated/distributed claims (OIDC Core 5.6.2) are not implemented here.
// Rejecting them in our own parse keeps them from reaching go-oidc, whose
// error for them would otherwise be logged as a signature failure — the wrong
// reason, on the one path where the log is the only diagnosis available.
func TestVerifierRejectsDistributedClaims(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{
		"_claim_names":   map[string]any{"email": "src1"},
		"_claim_sources": map[string]any{"src1": map[string]any{"endpoint": "https://evil.test/claims"}},
	}))
	mustReject(t, v, tok, ErrMalformed)

	// And it never reached the network to resolve that endpoint.
	if j.hitCount() != 0 {
		t.Fatalf("distributed-claims token caused %d JWKS fetches", j.hitCount())
	}
}

// ---------------------------------------------------------------------------
// JWKS rotation, both directions
// ---------------------------------------------------------------------------

// A provider that rotates IN a new signing key must not break sign-in until
// the process is restarted: once the cached key set is refreshed, the new key
// works.
//
// The clock advance is the point, not scaffolding. The key set is refreshed on
// a clock and never in response to a token, so a key rotated in is refused for
// up to jwksRefresh. That delay is the price of the amplification bound (see
// cachingKeySet) and is asserted here in both directions.
func TestVerifierRefetchesJWKSAfterRotation(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("pre-rotation verify: %v", err)
	}

	j.rotate(k.rsa2) // the provider retires rsa-1 and publishes rsa-2

	// Inside jwksRefresh the new kid is not yet known, and is refused rather than
	// costing an outbound fetch.
	mustReject(t, v, mint(t, k.rsa2, nil, goodClaims(c.now(), nil)), ErrSignature)

	c.advance(jwksRefresh + time.Second)
	before := j.hitCount()
	id, err := v.Verify(bgctx, mint(t, k.rsa2, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	if err != nil {
		t.Fatalf("post-rotation verify (new kid must trigger a refetch): %v", err)
	}
	if id.Subject != testSubject {
		t.Fatalf("subject = %q", id.Subject)
	}
	if j.hitCount() <= before {
		t.Fatal("the new kid did not cause a JWKS refetch")
	}
}

// The other direction, and the one that is actually a security property: a key
// the provider has RETIRED (revoked, compromised) must stop being accepted.
//
// go-oidc v3.11.0's RemoteKeySet caches the key set with no expiry whatsoever
// and only refetches on a kid MISS, so on its own a retired key stays valid in
// a long-lived process forever. Here the retired key's KID disappears from the
// cached set, and the set is replaced wholesale on the clock, so the key stops
// verifying within jwksRefresh.
func TestVerifierRejectsATokenSignedByARotatedOutKey(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("pre-rotation verify: %v", err)
	}

	j.rotate(k.rsa2) // rsa-1 is retired

	// Documented, bounded staleness: inside the refresh window the cached key
	// is still honoured. Asserted rather than glossed over, so a change to
	// jwksRefresh is a deliberate change to a tested property.
	c.advance(jwksRefresh / 2)
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("inside the refresh window the retired key should still verify: %v", err)
	}

	c.advance(jwksRefresh)
	mustReject(t, v, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), ErrSignature)

	// The refreshed view is not merely empty — the currently published key
	// still works.
	if _, err := v.Verify(bgctx, mint(t, k.rsa2, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("current key rejected after refresh: %v", err)
	}
}

// Key MATERIAL replaced under an UNCHANGED kid — the rotation a kid-by-kid
// comparison would be blind to. One refresh interval governs this too, because
// the whole key set is replaced on the clock rather than patched by kid.
func TestVerifierRejectsAKeyReplacedUnderTheSameKid(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("pre-rotation verify: %v", err)
	}

	imposter := k.rsa2.withKID(k.rsa1.kid) // same kid, different key
	j.rotate(imposter)

	// Inside the window the cached material is still honoured — stated, so a
	// change to jwksRefresh is a change to a tested property.
	c.advance(jwksRefresh / 2)
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("inside the refresh window the cached key should still verify: %v", err)
	}

	c.advance(jwksRefresh)
	mustReject(t, v, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), ErrSignature)

	// And the replacement key, under that same kid, is accepted.
	if _, err := v.Verify(bgctx, mint(t, imposter, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("replacement key rejected: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Outbound amplification
// ---------------------------------------------------------------------------

// The regression this whole key set exists for.
//
// go-oidc's RemoteKeySet refetches the JWKS whenever no cached key VERIFIES —
// not, as its comment claims, only when the kid is unknown — with no negative
// caching and no rate limit. Every check an attacker must pass to reach that
// point is public: `iss` and `alg` are fixed, `exp` is theirs, `aud` is the
// client ID shipped inside the mobile app, and the kid is published in the
// JWKS. Measured against the unguarded implementation: 20 forged tokens
// produced 21 outbound fetches.
//
// The live-kid case below is the one a kid filter does NOT catch — measured
// against a first attempt at this fix, which filtered unpublished kids and
// still produced 21 fetches — and is why the fix had to own the refetch policy
// instead.
func TestForgedTokensCannotAmplifyIntoJWKSFetches(t *testing.T) {
	k := testKeys()

	forgeries := map[string]func(i int) map[string]any{
		"unknown kid": func(i int) map[string]any {
			return map[string]any{"kid": fmt.Sprintf("forged-%d", i)}
		},
		"live kid, forged signature": func(int) map[string]any {
			return map[string]any{"kid": k.rsa1.kid}
		},
		"no kid": func(int) map[string]any {
			return map[string]any{"kid": nil}
		},
	}
	for name, hdr := range forgeries {
		t.Run(name, func(t *testing.T) {
			j := newJWKS(t, k.rsa1)
			c := newClock()
			v := verifierOn(j, c)
			for i := 0; i < 20; i++ {
				// Signed with the attacker's own key; everything a public
				// observer can set is set correctly.
				tok := mint(t, k.rsa2, hdr(i), goodClaims(c.now(), map[string]any{"sub": fmt.Sprint(i)}))
				mustReject(t, v, tok, ErrSignature)
			}
			if got := j.hitCount(); got != 1 {
				t.Fatalf("20 forged tokens caused %d JWKS fetches; want exactly 1 (the initial load)", got)
			}
		})
	}
}

// Time, not token content, is the only thing that may cause a fetch.
func TestJWKSIsFetchedOnAClockNotOnFailure(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	good := func() string { return mint(t, k.rsa1, nil, goodClaims(c.now(), nil)) }
	if _, err := v.Verify(bgctx, good(), VerifyOpts{}); err != nil {
		t.Fatal(err)
	}
	if j.hitCount() != 1 {
		t.Fatalf("first verify caused %d fetches, want 1", j.hitCount())
	}
	// A hundred successful verifications inside one window: still one fetch.
	for i := 0; i < 100; i++ {
		if _, err := v.Verify(bgctx, good(), VerifyOpts{}); err != nil {
			t.Fatal(err)
		}
	}
	if j.hitCount() != 1 {
		t.Fatalf("100 good verifies caused %d fetches, want 1", j.hitCount())
	}
	// Crossing the window costs exactly one more.
	c.advance(jwksRefresh + time.Second)
	if _, err := v.Verify(bgctx, good(), VerifyOpts{}); err != nil {
		t.Fatal(err)
	}
	if j.hitCount() != 2 {
		t.Fatalf("after one refresh interval there were %d fetches, want 2", j.hitCount())
	}
}

// There is no attacker-keyed state in the key set, so a forgery cannot poison
// anything. This is the test that fails if the policy is ever "simplified"
// into a negative cache of recently-missed kids — which would let an attacker
// forging garbage under the provider's LIVE kid lock out every real sign-in.
func TestAForgedSignatureUnderALiveKidDoesNotLockOutRealTokens(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	forged := mint(t, k.rsa2, map[string]any{"kid": k.rsa1.kid}, goodClaims(c.now(), nil))
	for i := 0; i < 5; i++ {
		mustReject(t, v, forged, ErrSignature)
	}
	// A genuine token under that same kid must still work, immediately.
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("a forgery under the live kid locked out genuine tokens: %v", err)
	}
}

// A provider outage must not be a sign-in outage — but it must not keep a
// revoked key alive forever either. Both ends of that are policy this package
// owns, so both are pinned.
func TestJWKSOutageServesStaleKeysButOnlyUpToTheLimit(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatal(err)
	}
	j.fail(true) // the provider's endpoint starts erroring

	c.advance(jwksRefresh + time.Second)
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("a JWKS blip must not be a sign-in outage: %v", err)
	}

	// A failed fetch must be rate limited too, or a down provider gets one
	// request per inbound sign-in.
	before := j.hitCount()
	for i := 0; i < 20; i++ {
		_, _ = v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	}
	if got := j.hitCount() - before; got != 0 {
		t.Fatalf("20 verifies during an outage made %d further fetch attempts, want 0 inside the window", got)
	}

	// Staleness is not unbounded — and past the limit this is reported as an
	// unavailable key set, not as a forged token, so the operator sees an
	// outage rather than an attack.
	c.advance(jwksStaleMax)
	_, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	if !errors.Is(err, ErrKeySetUnavailable) {
		t.Fatalf("past the stale limit: %v, want ErrKeySetUnavailable", err)
	}
	if errors.Is(err, ErrTokenRejected) {
		t.Fatal("an expired-stale key set must not be reported as a rejected token")
	}

	// Recovery works.
	j.fail(false)
	c.advance(jwksRefresh + time.Second)
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("after the provider recovered: %v", err)
	}
}

// RFC 7515 makes `kid` optional and go-oidc verifies such a token against every
// published key in turn. Neither provider emits one, but the behaviour is
// pinned so it is a known quantity rather than something discovered later.
func TestVerifierAcceptsAKidLessTokenThatVerifies(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, map[string]any{"kid": nil}, goodClaims(c.now(), nil))
	id, err := v.Verify(bgctx, tok, VerifyOpts{})
	if err != nil {
		t.Fatalf("kid-less token that verifies against a published key: %v", err)
	}
	if id.Subject != testSubject {
		t.Fatalf("subject = %q", id.Subject)
	}
}

// A key the provider publishes for ENCRYPTION must never verify a signature.
// RFC 7517 makes "use" optional, so an absent one is not disqualifying — but a
// key that explicitly says it is not for signing is.
func TestVerifierIgnoresKeysNotPublishedForSigning(t *testing.T) {
	k := testKeys()
	c := newClock()

	t.Run("use=enc is not a signing key", func(t *testing.T) {
		j := newJWKS(t, k.rsa1.withUse("enc"))
		v := verifierOn(j, c)
		mustReject(t, v, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), ErrSignature)
	})
	t.Run("absent use is still usable", func(t *testing.T) {
		j := newJWKS(t, k.rsa1.withUse(""))
		v := verifierOn(j, c)
		if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
			t.Fatalf("a key with no declared use should still verify: %v", err)
		}
	})
}

// The regression for the worst bug in this package's history, which the fix
// for outbound amplification introduced and review caught.
//
// The JWKS fetch used to run on the REQUESTING caller's context. net/http
// cancels that context the instant the client disconnects, so on a cold
// process one forged token — satisfying only public inputs — followed by an
// aborted connection consumed the single fetch attempt, killed the fetch, and
// cached nothing. Every genuine sign-in then failed for a full refresh window,
// with zero outbound requests, so the provider saw nothing and there was no
// external evidence. One aborted TCP connection per minute, forever.
func TestAnAbortedRequestCannotPoisonTheKeySet(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c) // cold: nothing cached, as after every restart

	entered, release := j.gate()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		// A forged token that passes every PUBLIC pre-check and so reaches
		// the key set. Its rejection is not what this test is about.
		_, _ = v.Verify(ctx, mint(t, k.rsa2, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	}()

	<-entered // the JWKS fetch is in flight
	cancel()  // the attacker aborts the connection
	close(release)
	<-done

	// The whole point: a genuine user signing in immediately afterwards, with
	// no clock advance, must succeed. Before the fix this failed for a full
	// jwksRefresh window.
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("an aborted request poisoned the key set: %v", err)
	}

	// Tighter, and what makes the DETACHMENT itself testable rather than only
	// the attempt-slot belt: the abandoned fetch ran to completion and
	// populated the cache, so the genuine sign-in needed no fetch of its own.
	// If the fetch were still tied to the caller's context it would have died
	// on the abort, and this would be 2 — an attacker aborting once a minute
	// would force an extra outbound request every time.
	if got := j.hitCount(); got != 1 {
		t.Fatalf("the sequence made %d JWKS fetches, want 1 (the aborted caller's fetch, completed anyway)", got)
	}
}

// A caller that gives up must not take the shared fetch down with it, and must
// not be made to wait past its own deadline either. go-oidc gets both by
// fetching on a detached context while making only the WAIT cancellable; so
// does this.
func TestASlowFetchHonoursTheCallersDeadlineWithoutAbortingTheFetch(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	entered, release := j.gate()

	// Caller A arrives first and owns the fetch.
	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_, _ = v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	}()
	<-entered // A's fetch is in flight and blocked

	// Caller B arrives with a short deadline and must get control back on
	// roughly its own schedule, not the fetch's.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := v.Verify(ctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{})
	waited := time.Since(start)
	if err == nil {
		t.Fatal("caller B should not have succeeded while the fetch was blocked")
	}
	if waited > 400*time.Millisecond {
		t.Fatalf("caller B waited %s despite a 50ms deadline", waited)
	}

	// B's departure must not have harmed A's fetch.
	close(release)
	<-firstDone
	if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
		t.Fatalf("the shared fetch did not complete: %v", err)
	}
}

// Concurrent callers on a cold cache must produce ONE request, not one each.
func TestConcurrentCallersShareOneJWKSFetch(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := v.Verify(bgctx, mint(t, k.rsa1, nil, goodClaims(c.now(), nil)), VerifyOpts{}); err != nil {
				t.Errorf("verify: %v", err)
			}
		}()
	}
	wg.Wait()
	if got := j.hitCount(); got != 1 {
		t.Fatalf("16 concurrent cold-cache verifies made %d fetches, want 1", got)
	}
}

// A provider outage is not an invalid token. They must be distinguishable, so
// an incident on Apple's side and someone forging tokens do not share a metric
// — and so the HTTP layer can answer one with a retryable 503 and the other
// with 401.
func TestAnUnavailableKeySetIsNotReportedAsAForgedToken(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)
	j.fail(true) // down before we ever cached anything

	good := mint(t, k.rsa1, nil, goodClaims(c.now(), nil))
	_, err := v.Verify(bgctx, good, VerifyOpts{})
	if err == nil {
		t.Fatal("verify succeeded with no keys available")
	}
	if !errors.Is(err, ErrKeySetUnavailable) {
		t.Fatalf("err = %v, want ErrKeySetUnavailable", err)
	}
	if errors.Is(err, ErrTokenRejected) {
		t.Fatal("a provider outage must not be reported as a rejected token")
	}

	// And a genuinely bad token, once the provider is reachable, is still a
	// rejection rather than an outage.
	j.fail(false)
	c.advance(jwksRefresh + time.Second)
	mustReject(t, v, mint(t, k.rsa2, nil, goodClaims(c.now(), nil)), ErrSignature)
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

// Construction must not perform OIDC discovery (oidc.NewProvider does; we must
// never use it). A verifier built at process start against an IdP that is
// briefly unreachable has to come up anyway, and every test in this file
// depends on construction being free.
func TestNewOIDCVerifierPerformsNoNetworkIOAtConstruction(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()

	_ = verifierOn(j, c)
	if j.hitCount() != 0 {
		t.Fatalf("construction fetched the JWKS %d time(s)", j.hitCount())
	}
}

// A verifier configured with no audiences would, with SkipClientIDCheck on,
// accept a token issued to ANY relying party. It must fail closed instead.
func TestMisconfiguredVerifierRejectsEverything(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	good := goodClaims(c.now(), nil)

	cases := map[string]Verifier{
		"no audiences":   NewOIDCVerifier(IdPApple, testIssuer, j.url(), nil, c.now),
		"empty audience": NewOIDCVerifier(IdPApple, testIssuer, j.url(), []string{""}, c.now),
		"no issuer":      NewOIDCVerifier(IdPApple, "", j.url(), []string{testAudience}, c.now),
		"no jwks url":    NewOIDCVerifier(IdPApple, testIssuer, "", []string{testAudience}, c.now),
		"unknown idp":    NewOIDCVerifier("facebook", testIssuer, j.url(), []string{testAudience}, c.now),
	}
	for name, v := range cases {
		t.Run(name, func(t *testing.T) {
			mustReject(t, v, mint(t, k.rsa1, nil, good), ErrNotConfigured)
		})
	}
}

// The Apple and Google issuer/JWKS literals are security-critical constants: a
// typo in an issuer accepts identities minted by whoever owns that issuer, and
// a typo in a JWKS URL trusts whoever owns that host.
//
// Deliberately white-box. Checking these by presenting a token would mean
// pointing a verifier at the provider's REAL jwks_uri, and nothing in this
// package may leave the machine — so the wiring is inspected instead of
// exercised. Verified hermetic by running the whole package behind a dead
// HTTP(S) proxy, which passes.
func TestProviderConstructorsAreWiredToTheRealProviders(t *testing.T) {
	c := newClock()
	apple, ok := NewAppleVerifier([]string{testAudience}, c.now).(*oidcVerifier)
	if !ok {
		t.Fatal("NewAppleVerifier did not return an *oidcVerifier")
	}
	google, ok := NewGoogleVerifier([]string{testAudience}, c.now).(*oidcVerifier)
	if !ok {
		t.Fatal("NewGoogleVerifier did not return an *oidcVerifier")
	}

	cases := []struct {
		name             string
		v                *oidcVerifier
		idp, issuer, url string
		accepted         []string
	}{
		{"apple", apple, IdPApple,
			"https://appleid.apple.com", "https://appleid.apple.com/auth/keys",
			[]string{"https://appleid.apple.com"}},
		{"google", google, IdPGoogle,
			"https://accounts.google.com", "https://www.googleapis.com/oauth2/v3/certs",
			// Both forms Google documents; see the carve-out in newOIDCVerifier.
			[]string{"https://accounts.google.com", "accounts.google.com"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.v.configErr != nil {
				t.Fatalf("configured verifier reports %v", tc.v.configErr)
			}
			if tc.v.idp != tc.idp {
				t.Errorf("idp = %q, want %q", tc.v.idp, tc.idp)
			}
			if tc.v.issuer != tc.issuer {
				t.Errorf("issuer = %q, want %q", tc.v.issuer, tc.issuer)
			}
			if !sameStrings(tc.v.acceptedIssuers, tc.accepted) {
				t.Errorf("accepted issuers = %q, want %q", tc.v.acceptedIssuers, tc.accepted)
			}
			if tc.v.keys.jwksURL != tc.url {
				t.Errorf("jwks url = %q, want %q", tc.v.keys.jwksURL, tc.url)
			}
			if tc.v.keys.refresh != jwksRefresh {
				t.Errorf("jwks refresh = %v, want %v", tc.v.keys.refresh, jwksRefresh)
			}
			if tc.v.keys.staleMax != jwksStaleMax {
				t.Errorf("jwks stale max = %v, want %v", tc.v.keys.staleMax, jwksStaleMax)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// SubjectHash
// ---------------------------------------------------------------------------

func TestSubjectHashIsStableAndNotReversible(t *testing.T) {
	a := SubjectHash(IdPApple, "001234.abc")
	if len(a) != 32 {
		t.Fatalf("digest is %d bytes, want a 32-byte SHA-256", len(a))
	}
	if !equalBytes(a, SubjectHash(IdPApple, "001234.abc")) {
		t.Fatal("hash is not stable across calls")
	}
	// The IdP must be part of the input: two providers can and do issue the
	// same opaque subject string, and colliding them would merge two people's
	// ledgers.
	if equalBytes(a, SubjectHash(IdPGoogle, "001234.abc")) {
		t.Fatal("idp must be part of the hash input")
	}
	// The "|" separator is only unambiguous because idp is a closed
	// vocabulary with no "|" in it. Pin that: if a third provider is ever
	// added, this is the test that has to be looked at, because the encoding
	// itself does not carry the guarantee.
	//
	//	SubjectHash("apple|x", "y") == SubjectHash("apple", "x|y")
	//
	// is TRUE, and safe only for as long as no idp value can contain "|".
	if !equalBytes(SubjectHash("apple|x", "y"), SubjectHash("apple", "x|y")) {
		t.Fatal("the separator became injective; update SubjectHash's doc comment")
	}
	for _, idp := range []string{IdPApple, IdPGoogle} {
		if strings.Contains(idp, "|") {
			t.Fatalf("idp %q contains the hash separator", idp)
		}
	}
	// It is a hash, not an encoding: the subject must not be recoverable by
	// eye from the digest.
	if bytesContains(a, []byte("001234.abc")) {
		t.Fatal("digest contains the raw subject")
	}
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func bytesContains(hay, needle []byte) bool {
	return strings.Contains(string(hay), string(needle))
}

// ---------------------------------------------------------------------------
// Freshness (VerifyOpts.MaxAge) — spec §3.4's re-authentication factor
// ---------------------------------------------------------------------------

// A token that is perfectly valid for a sign-in is NOT proof the user
// authenticated just now. Account deletion needs the second property, and
// MaxAge is the only thing that supplies it.
func TestVerifierRefusesAStaleTokenWhenFreshnessIsRequired(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), nil))
	// Still inside `exp` (an hour), well outside a five-minute freshness window.
	c.advance(10 * time.Minute)

	if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
		t.Fatalf("without MaxAge the same token must still verify: %v", err)
	}
	mustRejectOpts(t, v, tok, VerifyOpts{MaxAge: 5 * time.Minute}, ErrStale)
}

func TestVerifierAcceptsAFreshTokenAndReportsItsIssueInstant(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	iat := c.now()
	tok := mint(t, k.rsa1, nil, goodClaims(iat, nil))
	c.advance(time.Minute)

	id, err := v.Verify(bgctx, tok, VerifyOpts{MaxAge: 5 * time.Minute})
	if err != nil {
		t.Fatalf("verify a one-minute-old token with a five-minute window: %v", err)
	}
	if !id.IssuedAt.Equal(iat.Truncate(time.Second)) {
		t.Fatalf("Identity.IssuedAt = %s, want %s", id.IssuedAt.UTC(), iat.UTC())
	}
}

// A token that will not say when it was minted cannot be shown to be recent.
// Without this it would pass every freshness check ever written.
func TestVerifierRefusesATokenWithNoIssuedAtWhenFreshnessIsRequired(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{"iat": nil}))
	if _, err := v.Verify(bgctx, tok, VerifyOpts{}); err != nil {
		t.Fatalf("a token with no iat must still verify for an ordinary sign-in: %v", err)
	}
	mustRejectOpts(t, v, tok, VerifyOpts{MaxAge: 5 * time.Minute}, ErrStale)
}

// Otherwise a five-minute window is widened to any length by writing a later
// `iat`. The signature is what stops a forger; this is what stops the window
// from being meaningless if one ever gets past it.
func TestVerifierRefusesAFutureIssuedAtBeyondClockSkew(t *testing.T) {
	k := testKeys()
	j := newJWKS(t, k.rsa1)
	c := newClock()
	v := verifierOn(j, c)

	tok := mint(t, k.rsa1, nil, goodClaims(c.now(), map[string]any{
		"iat": c.now().Add(time.Hour).Unix(),
		"exp": c.now().Add(2 * time.Hour).Unix(),
	}))
	mustRejectOpts(t, v, tok, VerifyOpts{MaxAge: 5 * time.Minute}, ErrStale)
}

// The dev verifier reports every token as issued now, so an endpoint gated on
// freshness is reachable from the exit test. Pinned rather than assumed: it is
// the one implementation that could silently fail a freshness gate.
func TestDevVerifierReportsAFreshIssueInstant(t *testing.T) {
	before := time.Now()
	id, err := NewDevVerifier(IdPApple).Verify(bgctx, "dev:alice", VerifyOpts{MaxAge: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if id.IssuedAt.Before(before) {
		t.Fatalf("dev IssuedAt = %s, want at or after %s", id.IssuedAt, before)
	}
}
