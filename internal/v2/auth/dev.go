package auth

import (
	"context"
	"fmt"
	"strings"
)

// devTokenPrefix is the whole grammar of a dev token: "dev:" followed by the
// subject. Nothing else is accepted, deliberately — see NewDevVerifier.
const devTokenPrefix = "dev:"

// NewDevVerifier returns a TEST-ONLY [Verifier] that accepts `dev:<subject>`
// and nothing else.
//
// # What it is for
//
// Phase 1's exit criterion is driven by a headless client against a real
// ledgerd (spec §5, plan Tasks 14/37/38). Signing that client in with a genuine
// Apple or Google ID token is not possible from a test: the token is minted by
// a provider, expires, and cannot be produced offline. Without this, the exit
// test cannot reach any authenticated endpoint at all.
//
// # Why it REPLACES the real verifiers rather than sitting beside them
//
// [api.NewServer] installs this for BOTH providers when `--dev-auth` is set, so
// a process running with the flag can verify no real token whatsoever. That is
// the safe direction and it is the point: a deployment that left the flag on
// fails every genuine sign-in immediately and loudly, instead of working
// perfectly while also accepting "dev:anyone". A verifier that fell back to the
// real one would be exactly the silent version.
//
// The flag itself is refused unless the HTTP listener is loopback
// ([config.Config.EnableTestOnly]), which is the second, independent rail.
//
// # What it deliberately does not do
//
// It does not check a nonce, an audience, an expiry or a signature, because
// there is nothing to check them against. Anything reachable with a session
// issued this way is reachable by anyone who can reach the listener — which is
// why the loopback rail is not decorative.
func NewDevVerifier(idp string) Verifier {
	return devVerifier{idp: idp}
}

type devVerifier struct{ idp string }

func (v devVerifier) Verify(_ context.Context, idToken string, _ VerifyOpts) (Identity, error) {
	if !validIdP(v.idp) {
		// Not an ErrTokenRejected: a verifier built for a provider that does not
		// exist is a wiring mistake, and answering "your token is invalid" would
		// send a caller off to fetch another one that fails identically. It is
		// also the one failure here a 401 would hide, since SubjectHash's
		// separator argument depends on the IdP vocabulary staying closed.
		return Identity{}, fmt.Errorf("auth: dev verifier built for unknown idp %q", v.idp)
	}
	subject, ok := strings.CutPrefix(idToken, devTokenPrefix)
	if !ok || subject == "" {
		return Identity{}, fmt.Errorf("%w: a dev token is %q followed by a subject", ErrTokenRejected, devTokenPrefix)
	}
	if strings.Contains(subject, "|") {
		// SubjectHash joins (idp, subject) with "|" and is only injective
		// because the IdP vocabulary contains no "|". A subject that does would
		// let one dev token address the account another one addresses. Real
		// providers issue opaque subjects that never contain it; this path is
		// the only one where the subject is caller-chosen, so it is the only
		// one that has to say so.
		return Identity{}, fmt.Errorf("%w: a dev subject may not contain %q", ErrTokenRejected, "|")
	}
	return Identity{IdP: v.idp, Subject: subject}, nil
}
