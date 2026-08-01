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
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	jose "github.com/go-jose/go-jose/v4"
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
//
// GoogleIssuerNoScheme is not a mistake. Google documents its `iss` as EITHER
// "https://accounts.google.com" OR the bare "accounts.google.com", and issues
// both in practice; go-oidc carries an explicit carve-out for exactly this
// pair and refuses to generalize it to other providers. We match that, and
// only for Google — see acceptedIssuers in newOIDCVerifier.
const (
	AppleIssuer          = "https://appleid.apple.com"
	AppleJWKSURL         = "https://appleid.apple.com/auth/keys"
	GoogleIssuer         = "https://accounts.google.com"
	GoogleIssuerNoScheme = "accounts.google.com"
	GoogleJWKSURL        = "https://www.googleapis.com/oauth2/v3/certs"
)

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

	// ErrMalformed means the token is not a well-formed compact JWS, its
	// header/payload is not JSON, or it carries a construct this package
	// deliberately does not implement (aggregated/distributed claims).
	ErrMalformed = fmt.Errorf("%w: malformed token", ErrTokenRejected)

	// ErrAlgorithm means the header declared a signing algorithm outside the
	// RS256/ES256 allow-list — "none" (unsigned), or a symmetric algorithm
	// whose "secret" would be the provider's PUBLIC key.
	ErrAlgorithm = fmt.Errorf("%w: unacceptable signing algorithm", ErrTokenRejected)

	// ErrUntrustedHeader means the token tried to supply or redirect its own
	// key material ("jwk", "jku", "x5u", "x5c"), demanded processing of a
	// critical header we do not implement ("crit"), or declared a media type
	// that is not an ID token ("typ"). Keys come from the provider's JWKS and
	// nowhere else.
	ErrUntrustedHeader = fmt.Errorf("%w: unacceptable token header", ErrTokenRejected)

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

	// ErrNonce means the caller bound a nonce and the token's `nonce` claim is
	// not it — the token is genuine but belongs to a different sign-in
	// attempt. See VerifyOpts.
	ErrNonce = fmt.Errorf("%w: nonce mismatch", ErrTokenRejected)

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

// VerifyOpts carries per-exchange bindings. It is a struct rather than an
// extra parameter so a future binding (an `azp` check, a max token age) does
// not change every call site again.
type VerifyOpts struct {
	// Nonce, when non-empty, must equal the token's `nonce` claim.
	//
	// An ID token with no nonce bound to it is a pure BEARER credential for
	// the sign-in exchange: anything that observes one inside its validity
	// window — a malicious SDK in the client app, a log line, an intercepting
	// proxy — can replay it to this endpoint and be issued a session. Binding
	// a nonce is what makes a captured token useless to anyone but the client
	// that requested it.
	//
	// Phase 1 does not yet require it: the client generates the nonce, and the
	// Expo client does not exist. Leaving it empty is therefore ALLOWED and is
	// the current behaviour, but it is a deliberate, temporary gap and not the
	// intended end state. When the client can round-trip a nonce (pass it to
	// the provider at authorization, hand it back here at exchange), set it —
	// the plumbing is here so that becomes a one-line change rather than an
	// interface change.
	Nonce string
}

// Verifier turns a provider ID token into an Identity, or an error wrapping
// ErrTokenRejected.
type Verifier interface {
	Verify(ctx context.Context, idToken string, opts VerifyOpts) (Identity, error)
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
//     including refetching the JWKS when an unknown kid appears. A token with
//     NO kid is verified against every published key in turn and accepted if
//     any of them verifies it — permitted by RFC 7515, emitted by neither
//     provider, and tested so the behaviour is a known quantity rather than a
//     discovery,
//   - `iss`, `exp` and `nbf`.
//
// This package still owns, and must own:
//
//   - `aud`. SkipClientIDCheck is set to true because go-oidc compares against
//     a SINGLE ClientID, and neither provider fits that: Apple's `aud` may be
//     a bare string or an array, and Google issues a different client ID per
//     platform. With that flag on go-oidc performs NO audience check at all,
//     so audienceAllowed below is the only one there is — load-bearing, not a
//     convenience.
//   - the header hygiene go-oidc does not need but does not perform either:
//     refusing a token that brings its own key material ("jwk"/"jku"/"x5u"/
//     "x5c") or declares a media type that is not an ID token. go-oidc ignores
//     those headers rather than rejecting them, and a loud rejection is worth
//     more than a silent one.
//   - `nonce`, which go-oidc explicitly leaves to the caller (see VerifyOpts).
//   - the JWKS refetch policy itself. go-oidc's RemoteKeySet caches forever
//     and refetches on every FAILED verification, which is both a revoked key
//     that never expires and an unauthenticated outbound amplifier; see
//     cachingKeySet, which replaces it.
//   - the Google scheme-less issuer alias, below.
//
// # On the pre-checks, and why "stricter" is not the same as "safe"
//
// The claim checks this package performs run BEFORE go-oidc's, on the parsed
// but not yet verified payload. They are not a substitute for go-oidc's — both
// run, and both must pass — they exist so a rejection names its reason instead
// of surfacing an opaque library error string, and so a wrong-issuer or
// expired token is refused without spending a JWKS fetch.
//
// An earlier version of this comment argued that a divergence between the two
// "can only ever make this stricter, never more permissive", and treated that
// as sufficient. It is not, and that reasoning actively hid a bug: the first
// implementation rejected Google's documented scheme-less `iss`, which go-oidc
// accepts. Being stricter than the library is a real defect — it fails closed,
// so it is not a bypass, but it presents as a subset of legitimate sign-ins
// failing with no explanation, which is far harder to notice than a loud
// error. Any pre-check added here must be kept in AGREEMENT with go-oidc's,
// not merely no weaker than it.
func NewOIDCVerifier(idp, issuer, jwksURL string, audiences []string, now func() time.Time) Verifier {
	return newOIDCVerifier(idp, issuer, jwksURL, audiences, now, jwksRefresh)
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

// newOIDCVerifier is NewOIDCVerifier with the JWKS refresh interval exposed,
// so the rotation tests can drive both sides of the window explicitly.
func newOIDCVerifier(idp, issuer, jwksURL string, audiences []string, now func() time.Time, refresh time.Duration) *oidcVerifier {
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

	// The Google carve-out, kept as narrow as go-oidc keeps its own: it
	// applies only when this is the Google verifier AND it is pointed at
	// Google's real issuer. A verifier configured with some other issuer —
	// including the ones the tests use — gets no alias, so this cannot drift
	// into a general "also accept the scheme-less form" rule for other
	// providers.
	v.acceptedIssuers = []string{issuer}
	if idp == IdPGoogle && issuer == GoogleIssuer {
		v.acceptedIssuers = append(v.acceptedIssuers, GoogleIssuerNoScheme)
	}

	v.keys = &cachingKeySet{
		jwksURL:  jwksURL,
		refresh:  refresh,
		staleMax: jwksStaleMax,
		now:      now,
	}
	// The issuer handed to go-oidc is the canonical one; go-oidc's own
	// carve-out then accepts the scheme-less form for Google, matching
	// acceptedIssuers above.
	v.inner = oidc.NewVerifier(issuer, v.keys, &oidc.Config{
		SkipClientIDCheck:    true, // audienceAllowed replaces it; see the doc above
		SupportedSigningAlgs: []string{oidc.RS256, oidc.ES256},
		Now:                  now,
	})
	return v
}

type oidcVerifier struct {
	idp             string
	issuer          string
	acceptedIssuers []string
	audiences       []string
	now             func() time.Time
	keys            *cachingKeySet
	inner           *oidc.IDTokenVerifier
	configErr       error
}

func (v *oidcVerifier) Verify(ctx context.Context, idToken string, opts VerifyOpts) (Identity, error) {
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
	if err := v.checkClaims(claims, opts); err != nil {
		return Identity{}, err
	}

	// Everything above is advisory: the payload was not authenticated yet.
	// This is the line that authenticates it.
	tok, err := v.inner.Verify(ctx, idToken)
	if err != nil {
		// Every claim-level reason has already been excluded above, and
		// parseUnverified has already refused the JWS shapes go-oidc would
		// reject for structural reasons (not three segments, aggregated
		// claims). What remains is "these bytes are not from the provider":
		// bad signature, an unpublished kid, or an algorithm go-jose refused.
		// The library error is wrapped verbatim so the log keeps the detail.
		return Identity{}, fmt.Errorf("%w: %s: %v", ErrSignature, v.idp, err)
	}

	// Tripwire, not a check: go-oidc parses the same payload bytes with the
	// same encoding/json, so these can only differ if one of the two parsers
	// changes. If that ever happens, the identity we return would be derived
	// from claims that were never the ones validated — fail instead.
	if tok.Issuer != claims.Issuer || tok.Subject != claims.Subject ||
		tok.Nonce != claims.Nonce || !sameStrings(tok.Audience, claims.Audience) {
		return Identity{}, fmt.Errorf("%w: claim parse divergence between auth and go-oidc", ErrMalformed)
	}

	// Re-checked against the VERIFIED token, so the values that decide
	// acceptance are the authenticated ones rather than the pre-parse.
	if !v.audienceAllowed(tok.Audience) {
		return Identity{}, fmt.Errorf("%w: %s token aud %q names no configured client id", ErrAudience, v.idp, tok.Audience)
	}
	if opts.Nonce != "" && subtle.ConstantTimeCompare([]byte(tok.Nonce), []byte(opts.Nonce)) != 1 {
		return Identity{}, ErrNonce
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
	// `typ` is optional (Apple omits it, Google sends "JWT") but when present
	// it must say this is an ID token. Neither provider signs an "at+jwt"
	// access token with these keys today, so this is defence in depth against
	// a provider that later reuses one key set for two token types — the
	// classic way a token minted for one purpose gets accepted for another.
	// Media types are case-insensitive, and RFC 7519 allows the
	// "application/" prefix to be omitted.
	if raw, ok := hdr["typ"]; ok {
		var typ string
		if err := json.Unmarshal(raw, &typ); err != nil {
			return fmt.Errorf("%w: typ header is not a string", ErrMalformed)
		}
		switch strings.ToLower(typ) {
		case "jwt", "application/jwt":
		default:
			return fmt.Errorf("%w: typ %q is not an id token", ErrUntrustedHeader, typ)
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

// issuerAccepted implements the Google scheme-less alias. Everything else is
// exact equality.
func (v *oidcVerifier) issuerAccepted(iss string) bool {
	for _, want := range v.acceptedIssuers {
		if iss == want {
			return true
		}
	}
	return false
}

func (v *oidcVerifier) checkClaims(c idClaims, opts VerifyOpts) error {
	if !v.issuerAccepted(c.Issuer) {
		return fmt.Errorf("%w: token issued by %q, want one of %q", ErrIssuer, c.Issuer, v.acceptedIssuers)
	}
	now := v.now()
	// RFC 7519: the token must not be accepted on or after exp. go-oidc is a
	// hair more lenient (it rejects only strictly-before). That direction of
	// disagreement is safe — see the "stricter is not safe" note on
	// NewOIDCVerifier for the direction that is not.
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
	// Checked here too, not only against the verified token, so a token bound
	// to someone else's sign-in is refused without spending a JWKS fetch.
	if opts.Nonce != "" && subtle.ConstantTimeCompare([]byte(c.Nonce), []byte(opts.Nonce)) != 1 {
		return ErrNonce
	}
	if c.Subject == "" {
		return ErrNoSubject
	}
	return nil
}

// audienceAllowed is the replacement for go-oidc's ClientID check — with
// SkipClientIDCheck set, it is the ONLY audience check that runs. An empty
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
// send more (email, email_verified, real_user_status); none of it is read,
// because none of it is needed to identify the account and every field read is
// a field that could be stored by accident. Apple in particular only sends
// `email` on the FIRST authorization, so any design that depended on it would
// work once per user and then quietly stop.
type idClaims struct {
	Issuer    string       `json:"iss"`
	Subject   string       `json:"sub"`
	Audience  audienceSet  `json:"aud"`
	Nonce     string       `json:"nonce"`
	Expiry    *numericDate `json:"exp"`
	NotBefore *numericDate `json:"nbf"`

	// Aggregated/distributed claims (OIDC Core §5.6.2). Neither Apple nor
	// Google issues them and this package does not implement them; a token
	// carrying them is refused outright rather than partially understood.
	// Rejecting here also keeps them from reaching go-oidc, whose own error
	// for them would otherwise be surfaced as a signature failure and put the
	// wrong reason in the log.
	ClaimNames   map[string]any `json:"_claim_names"`
	ClaimSources map[string]any `json:"_claim_sources"`
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
		// This is also what makes a multi-signature JWS unreachable: two
		// signatures require the JSON General Serialization, which is not
		// three dot-separated segments.
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
	if len(claims.ClaimNames) > 0 || len(claims.ClaimSources) > 0 {
		return nil, idClaims{}, fmt.Errorf("%w: aggregated/distributed claims are not supported", ErrMalformed)
	}
	return hdr, claims, nil
}

// ---------------------------------------------------------------------------
// The key set: bounded staleness AND a bound on attacker-forced fetches
// ---------------------------------------------------------------------------

// maxJWKSBytes caps the published key document. Google's is ~1 KB, Apple's
// smaller.
const maxJWKSBytes = 256 << 10

// jwksFetchTimeout bounds one JWKS fetch, so an unresponsive provider cannot
// pin a request for however long the caller's context allows.
const jwksFetchTimeout = 10 * time.Second

// jwksRefresh is the minimum interval between JWKS fetch ATTEMPTS, and
// therefore the single number that governs every timing property here:
//
//   - a key the provider rotates IN starts working within this long,
//   - a key the provider rotates OUT (revoked, compromised) stops working
//     within this long,
//   - key material replaced under an unchanged kid likewise, and
//   - an unauthenticated caller can force at most ONE outbound request per
//     provider per this interval, no matter how many forged tokens they send.
//
// One minute makes the rotation lag indistinguishable from a retry while
// keeping the outbound rate trivial (1440 GETs/day/provider in the worst case,
// versus ~2 in the normal one).
const jwksRefresh = time.Minute

// jwksStaleMax is how long a key set we have failed to refresh may still be
// used. Serving stale keys through a provider outage is deliberate — failing
// closed would turn a Google blip into a total sign-in outage — but it is not
// unbounded, because "the JWKS is unreachable" must not keep a revoked key
// alive forever.
const jwksStaleMax = time.Hour

// cachingKeySet is the oidc.KeySet handed to go-oidc's IDTokenVerifier. It
// replaces oidc.NewRemoteKeySet, which could not be used here for a specific,
// measured reason.
//
// # Why not oidc.RemoteKeySet
//
// Two independent defects, both verified against v3.11.0's source and both
// reproduced with a test before this type was written:
//
//  1. Its cache never expires. cachedKeys is written only by keysFromRemote,
//     is never invalidated or timestamped, and the struct's `now` field is set
//     by the constructor and never read anywhere in the file. A key the
//     provider REVOKES therefore stays trusted for the life of the process.
//
//  2. Its refetch trigger is "verification failed", not "kid unknown". The
//     comment above the call says "if the kid doesn't match", but the code
//     falls through to keysFromRemote whenever no cached key VERIFIES — which
//     includes a valid kid with a bad signature. There is no negative caching
//     and no rate limit.
//
// Defect 2 is the dangerous one, and it is dangerous because every check an
// attacker must pass to reach it is public: `iss` and `alg` are fixed, `exp`
// is theirs to choose, and `aud` is the client ID that ships inside the mobile
// app. The kid is published in the JWKS itself. Measured before this change:
// 20 forged tokens signed with the attacker's own key but naming the
// provider's real kid produced 21 outbound JWKS fetches — an unauthenticated
// amplifier pointed at Apple's and Google's endpoints, whose success would get
// us rate limited there and take every sign-in down with it.
//
// # Why not a negative cache of missed kids
//
// The obvious patch — remember recently-failed kids and short-circuit them —
// is a trap. Its key is attacker-supplied, and a "miss" is indistinguishable
// from a bad signature under a REAL kid. An attacker forges garbage under the
// provider's live kid, poisons that entry, and every legitimate sign-in is
// short-circuited for the TTL: an amplification nuisance converted into a full
// authentication outage. There is no attacker-keyed state in this type at all,
// which is the property that makes that class of bug impossible rather than
// merely absent.
//
// # What this does instead
//
// It owns the refetch policy: the key set is refreshed on a clock, never in
// response to a token. A failed verification consults the cache and returns;
// it cannot cause I/O. That makes the outbound rate a function of time alone,
// and makes every rotation property fall out of one constant (jwksRefresh).
//
// # What is still go-oidc's, and still go-jose's
//
// All of the cryptography. This type fetches a document, unmarshals it with
// go-jose's own jose.JSONWebKeySet, selects candidates by kid, and calls
// go-jose's jws.Verify. It parses no key material by hand and implements no
// algorithm. go-oidc's IDTokenVerifier remains the authority for the
// algorithm allow-list, `iss`, `exp` and `nbf`, and go-oidc ships this exact
// selection-and-verify loop itself as StaticKeySet — implementing oidc.KeySet
// is the library's supported extension point, not a way around it.
type cachingKeySet struct {
	jwksURL  string
	refresh  time.Duration
	staleMax time.Duration
	now      func() time.Time

	// fetchMu serialises fetches so a burst costs one request, not one per
	// goroutine. Held across the HTTP call; mu never is.
	fetchMu sync.Mutex

	mu          sync.Mutex
	keys        []jose.JSONWebKey
	fetchedAt   time.Time // last SUCCESSFUL fetch
	attemptedAt time.Time // last attempt, successful or not
}

// keySetAlgs is the third and innermost enforcement of the signing-algorithm
// allow-list: checkHeader rejects first, go-oidc's SupportedSigningAlgs
// rejects second, and this ParseSigned call would reject an "alg" that somehow
// reached here regardless.
var keySetAlgs = []jose.SignatureAlgorithm{jose.RS256, jose.ES256}

func (r *cachingKeySet) VerifySignature(ctx context.Context, jwt string) ([]byte, error) {
	jws, err := jose.ParseSigned(jwt, keySetAlgs)
	if err != nil {
		return nil, fmt.Errorf("parse jws: %w", err)
	}
	if len(jws.Signatures) != 1 {
		return nil, fmt.Errorf("id token carries %d signatures, want exactly 1", len(jws.Signatures))
	}
	kid := jws.Signatures[0].Header.KeyID

	keys, err := r.currentKeys(ctx)
	if err != nil {
		return nil, err
	}
	for i := range keys {
		key := keys[i]
		// A key published for encryption must never verify a signature. Both
		// providers mark their keys "sig"; an unset Use is permitted by
		// RFC 7517 and is not treated as disqualifying.
		if key.Use != "" && key.Use != "sig" {
			continue
		}
		// A token naming a kid is verified against THAT key only, so a
		// signature cannot be laundered through some other published key. A
		// token with no kid is checked against all of them (RFC 7515 permits
		// it; neither provider emits it).
		if kid != "" && key.KeyID != kid {
			continue
		}
		if payload, err := jws.Verify(&key); err == nil {
			return payload, nil
		}
	}
	// Deliberately no refetch here. This is the line that used to be an
	// unauthenticated outbound request; see the type doc.
	return nil, fmt.Errorf("no key published at %s verifies this token (kid %q)", r.jwksURL, kid)
}

// currentKeys returns the key set, refreshing it at most once per r.refresh.
// It serves a stale set through a provider outage, but only up to r.staleMax.
func (r *cachingKeySet) currentKeys(ctx context.Context) ([]jose.JSONWebKey, error) {
	if keys, ok := r.freshKeys(); ok {
		return keys, nil
	}
	r.fetchMu.Lock()
	defer r.fetchMu.Unlock()
	if keys, ok := r.freshKeys(); ok { // another goroutine may have just fetched
		return keys, nil
	}

	r.mu.Lock()
	// Rate-limit ATTEMPTS, not just successes: without this a provider that is
	// down would be hammered once per inbound request, which is the same
	// amplification bug in a different costume.
	tooSoon := !r.attemptedAt.IsZero() && r.now().Sub(r.attemptedAt) < r.refresh
	r.mu.Unlock()
	if tooSoon {
		return r.staleKeys()
	}

	r.mu.Lock()
	r.attemptedAt = r.now()
	r.mu.Unlock()

	fetchCtx, cancel := context.WithTimeout(ctx, jwksFetchTimeout)
	defer cancel()
	fetched, err := fetchJWKS(fetchCtx, r.jwksURL)
	if err != nil {
		return r.staleKeys()
	}
	r.mu.Lock()
	r.keys, r.fetchedAt = fetched, r.now()
	r.mu.Unlock()
	return fetched, nil
}

func (r *cachingKeySet) freshKeys() ([]jose.JSONWebKey, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.keys == nil {
		return nil, false
	}
	return r.keys, r.now().Sub(r.fetchedAt) < r.refresh
}

func (r *cachingKeySet) staleKeys() ([]jose.JSONWebKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.keys == nil {
		return nil, fmt.Errorf("jwks %s is unavailable and nothing is cached", r.jwksURL)
	}
	if age := r.now().Sub(r.fetchedAt); age >= r.staleMax {
		return nil, fmt.Errorf("jwks %s could not be refreshed for %s, which exceeds the %s limit",
			r.jwksURL, age, r.staleMax)
	}
	return r.keys, nil
}

// fetchJWKS retrieves and unmarshals the published key set. Unmarshalling is
// go-jose's own, so no key material is parsed by hand here.
func fetchJWKS(ctx context.Context, url string) ([]jose.JSONWebKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("jwks %s: %s", url, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxJWKSBytes))
	if err != nil {
		return nil, fmt.Errorf("jwks %s: %w", url, err)
	}
	var set jose.JSONWebKeySet
	if err := json.Unmarshal(body, &set); err != nil {
		return nil, fmt.Errorf("jwks %s: %w", url, err)
	}
	if len(set.Keys) == 0 {
		// An empty document must not be cached as "the provider publishes
		// nothing", which would reject every token for a full refresh window.
		return nil, fmt.Errorf("jwks %s: no keys", url)
	}
	return set.Keys, nil
}
