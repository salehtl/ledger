// Package auth is v2's front door: it verifies Sign in with Apple and Google
// Sign-In identity tokens, maps them onto pseudonymous user rows, and issues
// the opaque server-side session tokens every authenticated request carries.
// Passwords never exist anywhere in v2 (spec §3.8).
//
// # What a session token is, and what it is deliberately NOT
//
// A session token is an opaque 32-byte random string. It is not a JWT, carries
// no claims, and means nothing except "row present, unexpired, unrevoked" —
// which is what makes it revocable in one UPDATE.
//
// Spec §3.4's capability rules make sessions DELIBERATELY WEAK. A session
// token alone must never be sufficient to:
//
//   - register a new writer (that needs proof of key possession — a challenge
//     sealed to an already-enrolled key — and is recorded in the key-history
//     log, so a stolen session cannot inject a writer whose ops other devices
//     would replay),
//   - delete the account (fresh IdP re-authentication plus on-device
//     confirmation backed by key possession; a stolen session must not be able
//     to crypto-shred a life's financial history),
//   - rotate the inbound address (same bar as deletion).
//
// None of those flows is built yet. Whoever builds them must not reach for
// Sessions.Resolve as the only gate — it answers "is this a live session", and
// that is a strictly weaker question than "is this the account owner, present,
// on an enrolled device, right now".
//
// # Why the IdP subject is hashed
//
// A Sign in with Apple subject is pseudonymous at best (Google's is a stable
// account identifier), and spec §2's breach inventory counts what a database
// copy reveals. Storing SubjectHash instead of the raw subject means a dump of
// `users` links to an IdP account only for someone who already knows which
// subject to test for. Same reasoning as session tokens: store the digest,
// never the value.
//
// # Verification: library, not hand-rolled
//
// ID-token verification is delegated to github.com/coreos/go-oidc/v3 (plan
// Decision 12). Alg confusion, kid selection, embedded-JWK injection and
// issuer validation are each a well-known way to hand-roll an authentication
// bypass, and this is the one code path where getting it wrong exposes every
// user's financial data. See NewOIDCVerifier for exactly which checks this
// package still owns and why.
package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
)

// The two identity providers v2 supports. These strings are also the CHECK
// constraint on users.idp, and they are part of SubjectHash's input, so they
// are a closed vocabulary and not free-form labels.
const (
	IdPApple  = "apple"
	IdPGoogle = "google"
)

// Issuer and JWKS locations, in one place because a typo in an issuer is an
// authentication bypass: a verifier that accepts the wrong `iss` accepts
// identities minted by whoever owns that issuer.
const (
	AppleIssuer   = "https://appleid.apple.com"
	AppleJWKSURL  = "https://appleid.apple.com/auth/keys"
	GoogleIssuer  = "https://accounts.google.com"
	GoogleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"
)

// jwksMaxAge bounds how long a signing key the provider has RETIRED stays
// acceptable to a long-lived process.
//
// This exists because go-oidc v3.11.0's RemoteKeySet caches the fetched key
// set with no expiry at all and refetches only on a `kid` MISS (see
// oidc/jwks.go: keysFromCache is consulted first and cachedKeys is never
// invalidated). That is the correct strategy for rotating a key IN — a token
// signed by a brand-new kid triggers a refetch and verifies immediately — but
// it means a key the provider has revoked would remain trusted by this process
// forever. rotatingKeySet discards the key set after this long so the window
// is bounded and, more importantly, stated.
const jwksMaxAge = time.Hour

// nbfLeeway matches the clock-skew tolerance go-oidc applies to `nbf`, so this
// package's own check and the library's cannot disagree about a token in the
// skew window.
const nbfLeeway = 5 * time.Minute

// Rejection reasons. Every one of them wraps ErrTokenRejected, so a caller
// that only wants "was this token good" writes one errors.Is.
//
// The HTTP layer must map ALL of these to an identical 401 with an identical
// body: which check failed is useful in a log and is an oracle in a response.
var (
	// ErrTokenRejected is the umbrella: the presented ID token did not
	// establish an identity.
	ErrTokenRejected = errors.New("auth: id token rejected")

	// ErrMalformed means the token is not a well-formed compact JWS, or its
	// header/payload is not JSON.
	ErrMalformed = fmt.Errorf("%w: malformed token", ErrTokenRejected)

	// ErrAlgorithm means the header declared a signing algorithm outside the
	// RS256/ES256 allow-list — "none" (unsigned), or a symmetric algorithm
	// whose "secret" would be the provider's PUBLIC key.
	ErrAlgorithm = fmt.Errorf("%w: unacceptable signing algorithm", ErrTokenRejected)

	// ErrUntrustedHeader means the token tried to supply or redirect its own
	// key material ("jwk", "jku", "x5u", "x5c") or demanded processing of a
	// critical header we do not implement ("crit"). Keys come from the
	// provider's JWKS and nowhere else.
	ErrUntrustedHeader = fmt.Errorf("%w: token supplied its own key material", ErrTokenRejected)

	// ErrIssuer means `iss` is not the provider this verifier is bound to.
	ErrIssuer = fmt.Errorf("%w: wrong issuer", ErrTokenRejected)

	// ErrAudience means `aud` names no client ID of ours — the token is
	// genuine but was issued to a different relying party.
	ErrAudience = fmt.Errorf("%w: wrong audience", ErrTokenRejected)

	// ErrExpired means `exp` has passed, or there is no `exp` at all.
	ErrExpired = fmt.Errorf("%w: expired", ErrTokenRejected)

	// ErrNotYetValid means `nbf` is further in the future than the clock-skew
	// leeway allows.
	ErrNotYetValid = fmt.Errorf("%w: not yet valid", ErrTokenRejected)

	// ErrSignature means the signature did not verify against any key
	// currently published in the provider's JWKS, under the kid the token
	// named.
	ErrSignature = fmt.Errorf("%w: signature not verified by the provider's JWKS", ErrTokenRejected)

	// ErrNoSubject means the token carries no `sub`, so it names nobody.
	ErrNoSubject = fmt.Errorf("%w: no subject", ErrTokenRejected)

	// ErrNotConfigured means the verifier itself is unusable (no audience, no
	// issuer, no JWKS URL, unknown IdP). It rejects every token rather than
	// existing in a state where it could accept one it should not.
	ErrNotConfigured = fmt.Errorf("%w: verifier is not configured", ErrTokenRejected)
)

// Identity is who an ID token says the bearer is: a provider plus that
// provider's opaque subject string. The Subject is the raw value from the
// token; it is hashed by SubjectHash before it goes anywhere near storage.
type Identity struct {
	IdP     string
	Subject string
}

// Verifier turns a provider ID token into an Identity, or an error wrapping
// ErrTokenRejected.
type Verifier interface {
	Verify(ctx context.Context, idToken string) (Identity, error)
}

// SubjectHash is what `users.idp_sub_hash` stores: SHA-256 over
// "v2|" + idp + "|" + subject. The raw subject is never persisted.
//
// The "|" separator is not injective for arbitrary inputs — ("a|b", "c") and
// ("a", "b|c") hash alike — which is safe here only because idp is a closed
// two-value vocabulary containing no "|", enforced by validIdP below and again
// by the CHECK constraint on users.idp. Do not widen that vocabulary without
// making the encoding unambiguous (length-prefix it).
//
// The "v2|" prefix domain-separates this digest from any other SHA-256 the
// system computes over user data, so a hash from elsewhere can never be
// mistaken for a subject hash.
func SubjectHash(idp, subject string) []byte {
	sum := sha256.Sum256([]byte("v2|" + idp + "|" + subject))
	return sum[:]
}

func validIdP(idp string) bool { return idp == IdPApple || idp == IdPGoogle }

// NewOIDCVerifier builds a verifier for one provider.
//
// It never performs network I/O and never returns an error. Construction is
// deliberately free: it is called at process start, possibly while the
// provider is unreachable, and OIDC discovery at that moment would either
// block startup or fail it. That is why the key set is built with
// oidc.NewRemoteKeySet + oidc.NewVerifier and NEVER with oidc.NewProvider,
// which fetches the discovery document in its constructor.
//
// A misconfiguration (no audiences, no issuer, no JWKS URL, unknown IdP) is
// recorded and turned into an ErrNotConfigured rejection of EVERY token rather
// than a construction error, so the failure mode of a bad config is "nobody
// can sign in", never "anybody can".
//
// # Division of labour
//
// go-oidc is the authority for the things that are hard to get right:
//
//   - the signing-algorithm allow-list, enforced at parse time by go-jose
//     (SupportedSigningAlgs = RS256, ES256 — no "none", no HMAC),
//   - selecting the key by `kid` from the JWKS and verifying the signature,
//     including refetching the JWKS when an unknown kid appears,
//   - `iss`, `exp` and `nbf`.
//
// This package still owns, and must own:
//
//   - `aud`. SkipClientIDCheck is set to true because go-oidc compares against
//     a SINGLE ClientID, and neither provider fits that: Apple's `aud` may be
//     a bare string or an array, and Google issues a different client ID per
//     platform. Turning that check off without replacing it would accept a
//     token minted for any other relying party, so audienceAllowed below is
//     load-bearing, not a convenience.
//   - the header hygiene go-oidc does not need but does not perform either:
//     refusing a token that brings its own key material ("jwk"/"jku"/"x5u"/
//     "x5c"). go-oidc ignores those headers rather than rejecting them, and a
//     loud rejection is worth more than a silent one.
//   - a bounded JWKS cache lifetime, so a RETIRED key stops working (see
//     jwksMaxAge).
//
// The claim checks this package performs run BEFORE go-oidc's, on the parsed
// but not yet verified payload. That is not a substitute for go-oidc's — both
// run, and both must pass — it is what makes a rejection name its reason
// instead of surfacing an opaque library error string, and it means a
// wrong-issuer or expired token is refused without spending a JWKS fetch.
// Because both run, a divergence between the two can only ever make this
// stricter, never more permissive.
func NewOIDCVerifier(idp, issuer, jwksURL string, audiences []string, now func() time.Time) Verifier {
	return newOIDCVerifier(idp, issuer, jwksURL, audiences, now, jwksMaxAge)
}

// NewAppleVerifier and NewGoogleVerifier are the two constructors production
// code should use; they pin the issuer and JWKS URL so no caller has to repeat
// (or mistype) them.
func NewAppleVerifier(audiences []string, now func() time.Time) Verifier {
	return NewOIDCVerifier(IdPApple, AppleIssuer, AppleJWKSURL, audiences, now)
}

func NewGoogleVerifier(audiences []string, now func() time.Time) Verifier {
	return NewOIDCVerifier(IdPGoogle, GoogleIssuer, GoogleJWKSURL, audiences, now)
}

// newOIDCVerifier is NewOIDCVerifier with the JWKS cache lifetime exposed, so
// the rotation tests can exercise both sides of the staleness window without
// waiting an hour.
func newOIDCVerifier(idp, issuer, jwksURL string, audiences []string, now func() time.Time, maxAge time.Duration) *oidcVerifier {
	if now == nil {
		now = time.Now
	}
	v := &oidcVerifier{idp: idp, issuer: issuer, now: now}
	for _, a := range audiences {
		if a = strings.TrimSpace(a); a != "" {
			v.audiences = append(v.audiences, a)
		}
	}
	switch {
	case !validIdP(idp):
		v.configErr = fmt.Errorf("%w: unknown idp %q", ErrNotConfigured, idp)
	case issuer == "":
		v.configErr = fmt.Errorf("%w: %s has no issuer", ErrNotConfigured, idp)
	case jwksURL == "":
		v.configErr = fmt.Errorf("%w: %s has no jwks url", ErrNotConfigured, idp)
	case len(v.audiences) == 0:
		// The dangerous one. With SkipClientIDCheck on and no audiences of our
		// own to compare against, "accept anything" would be one missing
		// `return` away.
		v.configErr = fmt.Errorf("%w: %s has no client ids configured, so no token can be recognized as ours", ErrNotConfigured, idp)
	}
	if v.configErr != nil {
		return v
	}
	v.keys = &rotatingKeySet{
		ctx:     context.Background(),
		jwksURL: jwksURL,
		maxAge:  maxAge,
		now:     now,
	}
	v.inner = oidc.NewVerifier(issuer, v.keys, &oidc.Config{
		SkipClientIDCheck:    true, // audienceAllowed replaces it; see the doc above
		SupportedSigningAlgs: []string{oidc.RS256, oidc.ES256},
		Now:                  now,
	})
	return v
}

type oidcVerifier struct {
	idp       string
	issuer    string
	audiences []string
	now       func() time.Time
	keys      *rotatingKeySet
	inner     *oidc.IDTokenVerifier
	configErr error
}

func (v *oidcVerifier) Verify(ctx context.Context, idToken string) (Identity, error) {
	if v.configErr != nil {
		return Identity{}, v.configErr
	}
	hdr, claims, err := parseUnverified(idToken)
	if err != nil {
		return Identity{}, err
	}
	if err := checkHeader(hdr); err != nil {
		return Identity{}, err
	}
	if err := v.checkClaims(claims); err != nil {
		return Identity{}, err
	}

	// Everything above is advisory: the payload was not authenticated yet.
	// This is the line that authenticates it.
	tok, err := v.inner.Verify(ctx, idToken)
	if err != nil {
		// Every claim-level reason has already been excluded above, so what
		// remains is "these bytes are not from the provider": bad signature,
		// unknown kid, an algorithm go-jose refused, or a JWS shape go-oidc
		// will not process. The library error is wrapped for the log.
		return Identity{}, fmt.Errorf("%w: %s: %v", ErrSignature, v.idp, err)
	}

	// Tripwire, not a check: go-oidc parses the same payload bytes with the
	// same encoding/json, so these can only differ if one of the two parsers
	// changes. If that ever happens, the identity we return would be derived
	// from claims that were never the ones validated — fail instead.
	if tok.Issuer != claims.Issuer || tok.Subject != claims.Subject || !sameStrings(tok.Audience, claims.Audience) {
		return Identity{}, fmt.Errorf("%w: claim parse divergence between auth and go-oidc", ErrMalformed)
	}

	// Re-checked against the VERIFIED token, so the value that decides
	// acceptance is the authenticated one rather than the pre-parse.
	if !v.audienceAllowed(tok.Audience) {
		return Identity{}, fmt.Errorf("%w: %s token aud %q names no configured client id", ErrAudience, v.idp, tok.Audience)
	}
	if tok.Subject == "" {
		return Identity{}, ErrNoSubject
	}
	return Identity{IdP: v.idp, Subject: tok.Subject}, nil
}

// forbiddenHeaders are the JOSE header parameters that either carry key
// material or point at it. A verifier that honours any of them is verifying
// the attacker's signature against the attacker's key.
var forbiddenHeaders = []string{"jwk", "jku", "x5u", "x5c", "crit"}

func checkHeader(hdr map[string]json.RawMessage) error {
	for _, h := range forbiddenHeaders {
		if _, ok := hdr[h]; ok {
			return fmt.Errorf("%w: header %q", ErrUntrustedHeader, h)
		}
	}
	var alg string
	if raw, ok := hdr["alg"]; ok {
		if err := json.Unmarshal(raw, &alg); err != nil {
			return fmt.Errorf("%w: alg header is not a string", ErrMalformed)
		}
	}
	if alg != oidc.RS256 && alg != oidc.ES256 {
		return fmt.Errorf("%w: %q (want %s or %s)", ErrAlgorithm, alg, oidc.RS256, oidc.ES256)
	}
	return nil
}

func (v *oidcVerifier) checkClaims(c idClaims) error {
	if c.Issuer != v.issuer {
		return fmt.Errorf("%w: token issued by %q, want %q", ErrIssuer, c.Issuer, v.issuer)
	}
	now := v.now()
	// RFC 7519: the token must not be accepted on or after exp. go-oidc is a
	// hair more lenient (it rejects only strictly-before), which is fine —
	// this check runs first and is the stricter of the two.
	if c.Expiry == nil {
		return fmt.Errorf("%w: token has no exp claim", ErrExpired)
	}
	if !c.Expiry.t.After(now) {
		return fmt.Errorf("%w: exp %s, now %s", ErrExpired, c.Expiry.t.UTC(), now.UTC())
	}
	if c.NotBefore != nil && now.Add(nbfLeeway).Before(c.NotBefore.t) {
		return fmt.Errorf("%w: nbf %s, now %s", ErrNotYetValid, c.NotBefore.t.UTC(), now.UTC())
	}
	if !v.audienceAllowed(c.Audience) {
		return fmt.Errorf("%w: aud %q names no configured client id", ErrAudience, []string(c.Audience))
	}
	if c.Subject == "" {
		return ErrNoSubject
	}
	return nil
}

// audienceAllowed is the replacement for go-oidc's ClientID check. An empty
// audience entry never matches, so a token with `"aud": ""` cannot slip
// through against a configured set that was itself filtered of empties.
func (v *oidcVerifier) audienceAllowed(aud []string) bool {
	for _, got := range aud {
		if got == "" {
			continue
		}
		for _, want := range v.audiences {
			if got == want {
				return true
			}
		}
	}
	return false
}

func sameStrings(a, b []string) bool {
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

// ---------------------------------------------------------------------------
// Unverified pre-parse
// ---------------------------------------------------------------------------

// idClaims is the subset of an ID token this package inspects. Both providers
// send more (email, email_verified, nonce, real_user_status); none of it is
// read, because none of it is needed to identify the account and every field
// read is a field that could be stored by accident. Apple in particular only
// sends `email` on the FIRST authorization, so any design that depended on it
// would work once per user and then quietly stop.
type idClaims struct {
	Issuer    string       `json:"iss"`
	Subject   string       `json:"sub"`
	Audience  audienceSet  `json:"aud"`
	Expiry    *numericDate `json:"exp"`
	NotBefore *numericDate `json:"nbf"`
}

// audienceSet accepts both shapes RFC 7519 permits for `aud`: a bare string
// and an array of strings. Apple uses both depending on the flow.
type audienceSet []string

func (a *audienceSet) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*a = audienceSet{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return errors.New("aud is neither a string nor an array of strings")
	}
	*a = many
	return nil
}

// numericDate is an RFC 7519 NumericDate. Fractional seconds are truncated,
// matching go-oidc, so the two never disagree by a rounding step.
type numericDate struct{ t time.Time }

func (n *numericDate) UnmarshalJSON(b []byte) error {
	var num json.Number
	if err := json.Unmarshal(b, &num); err != nil {
		return err
	}
	if i, err := num.Int64(); err == nil {
		n.t = time.Unix(i, 0)
		return nil
	}
	f, err := num.Float64()
	if err != nil {
		return err
	}
	n.t = time.Unix(int64(f), 0)
	return nil
}

// maxIDTokenBytes caps what this package will even look at. Real Apple and
// Google ID tokens are on the order of 1 KB, so this is ~10x headroom; it
// exists because Verify is reachable by an unauthenticated caller and the
// first thing it does is base64-decode two attacker-sized segments into
// memory. The HTTP layer should also cap the request body — this is the
// backstop, not the primary limit.
const maxIDTokenBytes = 16 << 10

// parseUnverified splits a compact JWS and decodes its header and payload
// WITHOUT checking anything. Its output may only be used to reject; acceptance
// always goes through go-oidc.
func parseUnverified(token string) (map[string]json.RawMessage, idClaims, error) {
	if len(token) > maxIDTokenBytes {
		return nil, idClaims{}, fmt.Errorf("%w: %d bytes, cap is %d", ErrMalformed, len(token), maxIDTokenBytes)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, idClaims{}, fmt.Errorf("%w: %d segments, want 3", ErrMalformed, len(parts))
	}
	rawHdr, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, idClaims{}, fmt.Errorf("%w: header is not base64url", ErrMalformed)
	}
	rawPayload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, idClaims{}, fmt.Errorf("%w: payload is not base64url", ErrMalformed)
	}
	var hdr map[string]json.RawMessage
	if err := json.Unmarshal(rawHdr, &hdr); err != nil {
		return nil, idClaims{}, fmt.Errorf("%w: header is not a JSON object", ErrMalformed)
	}
	var claims idClaims
	if err := json.Unmarshal(rawPayload, &claims); err != nil {
		return nil, idClaims{}, fmt.Errorf("%w: payload is not valid claims JSON: %v", ErrMalformed, err)
	}
	return hdr, claims, nil
}

// ---------------------------------------------------------------------------
// JWKS with a bounded cache lifetime
// ---------------------------------------------------------------------------

// rotatingKeySet wraps go-oidc's RemoteKeySet with an expiry it does not have.
//
// Rotating a key IN is already handled by the wrapped set: an unknown kid
// triggers a refetch. Rotating one OUT is not — see jwksMaxAge. Discarding and
// rebuilding the RemoteKeySet is how the cache is dropped, because its cached
// keys are unexported and there is no invalidate method; the cost is one extra
// JWKS GET per provider per maxAge, which is nothing.
//
// Accepted trade: dropping the cache means that if the provider's JWKS is
// unreachable at the moment a rebuild happens, sign-in fails until it comes
// back, where an unbounded cache would have kept serving. That is not a new
// failure mode — a cold process has exactly the same exposure on its first
// sign-in — it just becomes possible hourly instead of once per restart. It
// costs new sign-ins only; existing sessions never touch the IdP. Trading that
// for "a revoked signing key stops working within the hour" is the right way
// round for an auth front door.
type rotatingKeySet struct {
	// ctx is go-oidc's configuration context (it selects the http.Client via
	// oidc.ClientContext); its cancellation is explicitly ignored by go-oidc,
	// so a background context is the honest thing to store. Per-call
	// cancellation still works: it comes from the ctx passed to
	// VerifySignature, which RemoteKeySet selects on while a fetch is in
	// flight.
	ctx     context.Context
	jwksURL string
	maxAge  time.Duration
	now     func() time.Time

	mu      sync.Mutex
	inner   oidc.KeySet
	fetched time.Time
}

func (r *rotatingKeySet) VerifySignature(ctx context.Context, jwt string) ([]byte, error) {
	r.mu.Lock()
	now := r.now()
	if r.inner == nil || now.Sub(r.fetched) >= r.maxAge {
		r.inner = oidc.NewRemoteKeySet(r.ctx, r.jwksURL)
		r.fetched = now
	}
	inner := r.inner
	r.mu.Unlock()
	// Deliberately outside the lock: the wrapped set does its own inflight
	// deduplication, and holding this mutex across a network fetch would
	// serialise every concurrent sign-in behind one HTTP request.
	return inner.VerifySignature(ctx, jwt)
}
