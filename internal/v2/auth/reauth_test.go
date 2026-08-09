package auth

import (
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"

	"ledger/internal/v2/authtest"
	"ledger/internal/v2/pgtest"
)

// challengeBytes is a server-minted nonce of the width purge.Challenges uses.
// It is generated rather than fixed so no test can pass by matching a constant
// that also appears in the code under test.
func challengeBytes(t *testing.T) []byte {
	t.Helper()
	return authtest.RandBytes(t, 32)
}

// assertOver is what a browser produces for navigator.credentials.get() over a
// raw challenge. There is no begin step to fetch options from — the deletion
// nonce IS the challenge.
func assertOver(t *testing.T, a *authtest.Authenticator, challenge []byte, counter uint32) []byte {
	t.Helper()
	return a.Assert(t, &protocol.CredentialAssertion{
		Response: protocol.PublicKeyCredentialRequestOptions{
			Challenge:      protocol.URLEncodedBase64(challenge),
			RelyingPartyID: authtest.RPID,
		},
	}, counter)
}

func TestVerifyAssertionAcceptsAnEnrolledCredentialOverTheServersChallenge(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, a := enroll(t, p, mustMint(t, pool, "alice"))
	challenge := challengeBytes(t)

	if err := p.VerifyAssertion(bgctx, userID, challenge, assertOver(t, a, challenge, 2)); err != nil {
		t.Fatalf("VerifyAssertion: %v", err)
	}

	// It is a sign-in in every way that matters to the credential row: the
	// counter moved and the credential is marked used, so an operator can see
	// that this authenticator is live and a clone cannot replay this counter.
	var (
		count int64
		used  *time.Time
	)
	if err := pool.QueryRow(bgctx,
		`SELECT sign_count, last_used_at FROM webauthn_credentials WHERE credential_id = $1`,
		a.CredID).Scan(&count, &used); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("sign_count = %d, want the counter the assertion carried", count)
	}
	if used == nil {
		t.Fatal("last_used_at is still NULL after a successful re-authentication")
	}
}

// The binding that makes this a re-authentication rather than a bearer check:
// the assertion signs THIS challenge, so one over any other value is worthless.
func TestVerifyAssertionRefusesAnAssertionOverADifferentChallenge(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, a := enroll(t, p, mustMint(t, pool, "alice"))

	signed := challengeBytes(t)
	expected := challengeBytes(t)
	err := p.VerifyAssertion(bgctx, userID, expected, assertOver(t, a, signed, 2))
	if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("err = %v, want ErrPasskeyRejected", err)
	}
}

// The account binding. Without it, anybody's passkey re-authenticates
// anybody's session.
func TestVerifyAssertionRefusesACredentialOfADifferentAccount(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	alice, _ := enroll(t, p, mustMint(t, pool, "alice"))
	_, mallory := enroll(t, p, mustMint(t, pool, "mallory"))
	challenge := challengeBytes(t)

	err := p.VerifyAssertion(bgctx, alice, challenge, assertOver(t, mallory, challenge, 2))
	if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("err = %v, want ErrPasskeyRejected", err)
	}
}

// A credential nobody enrolled is a rejection, never a first enrolment.
func TestVerifyAssertionRefusesAnUnenrolledCredential(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, _ := enroll(t, p, mustMint(t, pool, "alice"))

	stranger := authtest.New(t)
	stranger.Handle = authtest.RandBytes(t, 32)
	challenge := challengeBytes(t)

	err := p.VerifyAssertion(bgctx, userID, challenge, assertOver(t, stranger, challenge, 2))
	if !errors.Is(err, ErrCredentialUnknown) {
		t.Fatalf("err = %v, want ErrCredentialUnknown", err)
	}
}

// A counter that does not advance is §6.1.1's evidence that the private key
// exists in two places. The re-authentication that guards account deletion is
// the last place to be relaxed about that.
func TestVerifyAssertionRefusesACounterThatDidNotAdvance(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, a := enroll(t, p, mustMint(t, pool, "alice"))

	first := challengeBytes(t)
	if err := p.VerifyAssertion(bgctx, userID, first, assertOver(t, a, first, 5)); err != nil {
		t.Fatalf("first assertion: %v", err)
	}
	second := challengeBytes(t)
	err := p.VerifyAssertion(bgctx, userID, second, assertOver(t, a, second, 5))
	if !errors.Is(err, ErrClonedAuthenticator) {
		t.Fatalf("err = %v, want ErrClonedAuthenticator", err)
	}
}

// An absent assertion is a factor that was not presented, and it is a
// REJECTION rather than an argument error: the HTTP layer must be able to
// answer it identically to a wrong one.
func TestVerifyAssertionRefusesAnEmptyAssertion(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, _ := enroll(t, p, mustMint(t, pool, "alice"))

	err := p.VerifyAssertion(bgctx, userID, challengeBytes(t), nil)
	if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("err = %v, want ErrPasskeyRejected", err)
	}
}

// A challenge the server did not mint cannot be validated against anything.
// go-webauthn only compares the echoed value, so a caller passing a short or
// empty challenge would be authorizing an assertion over bytes of its own
// choosing.
func TestVerifyAssertionRefusesAChallengeTooShortToBeOneOfOurs(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, a := enroll(t, p, mustMint(t, pool, "alice"))

	short := make([]byte, 8)
	if _, err := rand.Read(short); err != nil {
		t.Fatal(err)
	}
	err := p.VerifyAssertion(bgctx, userID, short, assertOver(t, a, short, 2))
	if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("err = %v, want ErrPasskeyRejected", err)
	}
}

func TestVerifyAssertionRefusesAZeroUser(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	_, a := enroll(t, p, mustMint(t, pool, "alice"))
	challenge := challengeBytes(t)

	err := p.VerifyAssertion(bgctx, uuid.Nil, challenge, assertOver(t, a, challenge, 2))
	if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("err = %v, want ErrPasskeyRejected", err)
	}
}
