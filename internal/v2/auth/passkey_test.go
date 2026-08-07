package auth

import (
	"bytes"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/authtest"
	"ledger/internal/v2/pgtest"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

func newPasskeys(t *testing.T, pool *pgxpool.Pool) *Passkeys {
	t.Helper()
	p, err := NewPasskeys(pool, authtest.RPID, authtest.RPDisplayName, []string{authtest.RPOrigin})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// enroll runs a whole registration and returns the account it created.
func enroll(t *testing.T, p *Passkeys, code string) (uuid.UUID, *authtest.Authenticator) {
	t.Helper()
	id, opts, err := p.BeginRegistration(bgctx, code)
	if err != nil {
		t.Fatalf("BeginRegistration: %v", err)
	}
	a := authtest.New(t)
	userID, _, err := p.FinishRegistration(bgctx, id, a.Create(t, opts))
	if err != nil {
		t.Fatalf("FinishRegistration: %v", err)
	}
	return userID, a
}

func countCeremonies(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM webauthn_ceremonies`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// (a) registration
// ---------------------------------------------------------------------------

func TestPasskeyRegistrationWithAValidInviteCreatesOnePasskeyUserAndSpendsTheCode(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	code := mustMint(t, pool, "the passkey beta tester")

	userID, a := enroll(t, p, code)

	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("users = %d, want exactly 1", n)
	}
	var (
		idp      string
		subHash  []byte
		redeemed *time.Time
		by       *uuid.UUID
	)
	if err := pool.QueryRow(bgctx, `SELECT idp, idp_sub_hash FROM users WHERE id = $1`, userID).
		Scan(&idp, &subHash); err != nil {
		t.Fatal(err)
	}
	if idp != IdPPasskey {
		t.Fatalf("users.idp = %q, want %q", idp, IdPPasskey)
	}
	// The subject is the user handle, so the row is addressable from an
	// assertion and from nothing else.
	want := SubjectHash(IdPPasskey, base64.RawURLEncoding.EncodeToString(a.Handle))
	if !bytes.Equal(subHash, want) {
		t.Fatal("users.idp_sub_hash is not SubjectHash(passkey, base64url(user handle))")
	}

	if err := pool.QueryRow(bgctx, `SELECT redeemed_at, redeemed_by FROM invite_codes`).
		Scan(&redeemed, &by); err != nil {
		t.Fatal(err)
	}
	if redeemed == nil || by == nil || *by != userID {
		t.Fatalf("invite was not redeemed by the account it created: redeemed_at=%v by=%v", redeemed, by)
	}

	// The credential is stored, and the ceremony is not.
	var (
		storedUser   uuid.UUID
		storedHandle []byte
		signCount    int64
		backupElig   bool
	)
	if err := pool.QueryRow(bgctx,
		`SELECT user_id, user_handle, sign_count, backup_eligible FROM webauthn_credentials WHERE credential_id = $1`,
		a.CredID).Scan(&storedUser, &storedHandle, &signCount, &backupElig); err != nil {
		t.Fatal(err)
	}
	if storedUser != userID {
		t.Fatal("the credential does not belong to the account the registration created")
	}
	if !bytes.Equal(storedHandle, a.Handle) {
		t.Fatal("the stored user handle is not the one the authenticator was given")
	}
	if signCount != 1 || !backupElig {
		t.Fatalf("sign_count = %d, backup_eligible = %v; want the authenticator's own values", signCount, backupElig)
	}
	if n := countCeremonies(t, pool); n != 0 {
		t.Fatalf("ceremonies left after finish = %d, want 0 (single use)", n)
	}
}

// ---------------------------------------------------------------------------
// (b) an already-redeemed code
// ---------------------------------------------------------------------------

func TestPasskeyRegistrationWithASpentCodeIsRefusedAndCreatesNothing(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	code := mustMint(t, pool, "spent once")
	first, _ := enroll(t, p, code)

	// The gate is at finish, in the transaction that creates the account, so
	// begin is allowed to hand out a ceremony for a code that is about to fail.
	id, opts, err := p.BeginRegistration(bgctx, code)
	if err != nil {
		// A begin-time pre-check is permitted, and if it fires it must fire as
		// exactly this error.
		if !errors.Is(err, ErrNotInvited) {
			t.Fatalf("BeginRegistration with a spent code: %v, want ErrNotInvited", err)
		}
	} else {
		a := authtest.New(t)
		if _, _, err := p.FinishRegistration(bgctx, id, a.Create(t, opts)); !errors.Is(err, ErrNotInvited) {
			t.Fatalf("FinishRegistration with a spent code: %v, want ErrNotInvited", err)
		}
	}

	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("users = %d, want 1 — the refused registration created an account", n)
	}
	var n int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM webauthn_credentials`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("credentials = %d, want 1 — the refused registration stored one", n)
	}
	var by uuid.UUID
	if err := pool.QueryRow(bgctx, `SELECT redeemed_by FROM invite_codes`).Scan(&by); err != nil {
		t.Fatal(err)
	}
	if by != first {
		t.Fatal("the code changed hands")
	}
}

// The begin-time pre-check is a convenience; the REDEMPTION is the gate. Two
// ceremonies begun while the code was still live both pass that pre-check, and
// exactly one of them may end with an account.
func TestTwoRegistrationsBegunAgainstOneLiveCodeYieldOneAccount(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	code := mustMint(t, pool, "one code, two tabs")

	idA, optsA, err := p.BeginRegistration(bgctx, code)
	if err != nil {
		t.Fatal(err)
	}
	idB, optsB, err := p.BeginRegistration(bgctx, code)
	if err != nil {
		t.Fatal(err)
	}
	a, b := authtest.New(t), authtest.New(t)
	if _, _, err := p.FinishRegistration(bgctx, idA, a.Create(t, optsA)); err != nil {
		t.Fatalf("first FinishRegistration: %v", err)
	}
	if _, _, err := p.FinishRegistration(bgctx, idB, b.Create(t, optsB)); !errors.Is(err, ErrNotInvited) {
		t.Fatalf("second FinishRegistration: %v, want ErrNotInvited", err)
	}
	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("users = %d, want 1", n)
	}
	var n int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM webauthn_credentials`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("credentials = %d, want 1 — the refused registration stored one anyway", n)
	}
}

// ---------------------------------------------------------------------------
// (c) login
// ---------------------------------------------------------------------------

func TestPasskeyLoginReturnsTheSameUserTheRegistrationCreated(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	registered, a := enroll(t, p, mustMint(t, pool, "returning user"))

	id, opts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	// A discoverable login names nobody: the server does not know who is
	// signing in until the authenticator answers.
	if len(opts.Response.AllowedCredentials) != 0 {
		t.Fatal("the login options list credentials; that is not a discoverable login")
	}
	loggedIn, credID, err := p.FinishLogin(bgctx, id, a.Assert(t, opts, a.Counter+1))
	if err != nil {
		t.Fatalf("FinishLogin: %v", err)
	}
	if loggedIn != registered {
		t.Fatalf("login resolved to %s, registration created %s", loggedIn, registered)
	}
	if !bytes.Equal(credID, a.CredID) {
		t.Fatal("login named a different credential")
	}

	var signCount int64
	var lastUsed *time.Time
	if err := pool.QueryRow(bgctx,
		`SELECT sign_count, last_used_at FROM webauthn_credentials WHERE credential_id = $1`,
		a.CredID).Scan(&signCount, &lastUsed); err != nil {
		t.Fatal(err)
	}
	if signCount != int64(a.Counter)+1 {
		t.Fatalf("sign_count = %d, want the counter the assertion carried (%d)", signCount, a.Counter+1)
	}
	if lastUsed == nil {
		t.Fatal("last_used_at was not recorded")
	}
	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("users = %d, want 1 — signing in created a second account", n)
	}
}

// ---------------------------------------------------------------------------
// (d) an unknown credential
// ---------------------------------------------------------------------------

func TestPasskeyLoginWithAnUnknownCredentialIsRefused(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	_, enrolled := enroll(t, p, mustMint(t, pool, "the real one"))

	// A different key, a different credential id — and the handle of the
	// account it is trying to impersonate, which is the interesting case: a
	// caller who has seen a handle must still not be able to assert with a
	// credential nobody enrolled.
	stranger := authtest.New(t)
	stranger.Handle = enrolled.Handle

	id, opts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.FinishLogin(bgctx, id, stranger.Assert(t, opts, 2)); err == nil {
		t.Fatal("an unenrolled credential was accepted")
	} else if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("FinishLogin with an unknown credential: %v, want ErrPasskeyRejected", err)
	}
}

// ---------------------------------------------------------------------------
// (e) single use
// ---------------------------------------------------------------------------

func TestPasskeyCeremonyIsSingleUse(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	_, a := enroll(t, p, mustMint(t, pool, "replayer"))

	id, opts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	body := a.Assert(t, opts, 2)
	if _, _, err := p.FinishLogin(bgctx, id, body); err != nil {
		t.Fatalf("first FinishLogin: %v", err)
	}
	// Byte-identical replay of a ceremony that has already been spent.
	if _, _, err := p.FinishLogin(bgctx, id, body); !errors.Is(err, ErrCeremonyUnknown) {
		t.Fatalf("replayed ceremony: %v, want ErrCeremonyUnknown", err)
	}
	if n := countCeremonies(t, pool); n != 0 {
		t.Fatalf("ceremonies = %d after a spent login, want 0", n)
	}
}

// ---------------------------------------------------------------------------
// (f) expiry
// ---------------------------------------------------------------------------

func TestExpiredPasskeyCeremonyIsRefused(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	_, a := enroll(t, p, mustMint(t, pool, "slow"))

	now := time.Now().UTC()
	p.Now = func() time.Time { return now }

	id, opts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	body := a.Assert(t, opts, 2)

	// One second past the TTL, on the clock that decides.
	now = now.Add(CeremonyTTL + time.Second)
	if _, _, err := p.FinishLogin(bgctx, id, body); !errors.Is(err, ErrCeremonyUnknown) {
		t.Fatalf("expired ceremony: %v, want ErrCeremonyUnknown", err)
	}
}

// ---------------------------------------------------------------------------
// (g) a signature counter that goes backwards
// ---------------------------------------------------------------------------

func TestPasskeySignCountGoingBackwardsIsRefusedAsCloneEvidence(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	_, a := enroll(t, p, mustMint(t, pool, "cloned"))

	// A good login first, which moves the stored counter to 9.
	id, opts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.FinishLogin(bgctx, id, a.Assert(t, opts, 9)); err != nil {
		t.Fatalf("FinishLogin at counter 9: %v", err)
	}

	// Now the same credential asserts at a LOWER counter: either two copies of
	// the private key exist, or the authenticator is malfunctioning. Either way
	// it is not a sign-in.
	id, opts, err = p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.FinishLogin(bgctx, id, a.Assert(t, opts, 4)); !errors.Is(err, ErrClonedAuthenticator) {
		t.Fatalf("a counter that went backwards: %v, want ErrClonedAuthenticator", err)
	}

	// And the stored counter was not moved backwards by the refused attempt.
	var signCount int64
	if err := pool.QueryRow(bgctx,
		`SELECT sign_count FROM webauthn_credentials WHERE credential_id = $1`, a.CredID).
		Scan(&signCount); err != nil {
		t.Fatal(err)
	}
	if signCount != 9 {
		t.Fatalf("sign_count = %d, want 9 — the refused assertion moved it", signCount)
	}
}

// ---------------------------------------------------------------------------
// Adding a second passkey to an existing account
// ---------------------------------------------------------------------------

func TestAddingASecondPasskeyKeepsOneAccountAndOneHandle(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	userID, first := enroll(t, p, mustMint(t, pool, "two devices"))

	id, opts, err := p.BeginAdd(bgctx, userID)
	if err != nil {
		t.Fatalf("BeginAdd: %v", err)
	}
	second := authtest.New(t)
	credID, err := p.FinishAdd(bgctx, id, userID, second.Create(t, opts))
	if err != nil {
		t.Fatalf("FinishAdd: %v", err)
	}
	if !bytes.Equal(credID, second.CredID) {
		t.Fatal("FinishAdd named a different credential")
	}
	// One handle, because a second handle would be a second SUBJECT and
	// therefore a second account.
	if !bytes.Equal(second.Handle, first.Handle) {
		t.Fatal("the add ceremony minted a new user handle instead of reusing the account's")
	}
	if n := countUsers(t, pool); n != 1 {
		t.Fatalf("users = %d, want 1", n)
	}

	// And the new credential signs in as the same account.
	lid, lopts, err := p.BeginLogin(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := p.FinishLogin(bgctx, lid, second.Assert(t, lopts, 7))
	if err != nil {
		t.Fatalf("FinishLogin with the added credential: %v", err)
	}
	if got != userID {
		t.Fatalf("the added credential signed in as %s, want %s", got, userID)
	}
}

func TestAddCeremonyIsBoundToTheSessionThatStartedIt(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	victim, _ := enroll(t, p, mustMint(t, pool, "victim"))
	attacker, _ := enroll(t, p, mustMint(t, pool, "attacker"))

	id, opts, err := p.BeginAdd(bgctx, victim)
	if err != nil {
		t.Fatal(err)
	}
	a := authtest.New(t)
	// The attacker's own live session, finishing a ceremony that was begun for
	// somebody else's account.
	if _, err := p.FinishAdd(bgctx, id, attacker, a.Create(t, opts)); err == nil {
		t.Fatal("a ceremony begun for one account was finished by another")
	} else if !errors.Is(err, ErrPasskeyRejected) {
		t.Fatalf("cross-account FinishAdd: %v, want ErrPasskeyRejected", err)
	}
}

func TestAddIsRefusedForAnAccountWithNoPasskeyIdentity(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	// An Apple account: it has no user handle, so there is nothing to bind a
	// new credential to without silently minting a second identity.
	u := mustUpsert(t, pool, appleIdentity("sub-no-passkey"))
	if _, _, err := p.BeginAdd(bgctx, u); !errors.Is(err, ErrNoPasskeyIdentity) {
		t.Fatalf("BeginAdd on a non-passkey account: %v, want ErrNoPasskeyIdentity", err)
	}
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

func TestExpiredCeremoniesAreSwept(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	now := time.Now().UTC()
	p.Now = func() time.Time { return now }

	if _, _, err := p.BeginLogin(bgctx); err != nil {
		t.Fatal(err)
	}
	if n := countCeremonies(t, pool); n != 1 {
		t.Fatalf("ceremonies = %d, want 1", n)
	}
	now = now.Add(CeremonyTTL + time.Minute)
	n, err := p.ReapExpiredCeremonies(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("reaped %d, want 1", n)
	}
	if got := countCeremonies(t, pool); got != 0 {
		t.Fatalf("ceremonies = %d after the sweep, want 0", got)
	}
}

func TestPasskeyCeremonyOptionsRequireADiscoverableCredential(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	_, opts, err := p.BeginRegistration(bgctx, mustMint(t, pool, "opts"))
	if err != nil {
		t.Fatal(err)
	}
	sel := opts.Response.AuthenticatorSelection
	if sel.ResidentKey != protocol.ResidentKeyRequirementRequired {
		t.Fatalf("residentKey = %q, want %q — username-less login needs a discoverable credential",
			sel.ResidentKey, protocol.ResidentKeyRequirementRequired)
	}
	if sel.UserVerification != protocol.VerificationPreferred {
		t.Fatalf("userVerification = %q, want %q", sel.UserVerification, protocol.VerificationPreferred)
	}
	if opts.Response.RelyingParty.ID != authtest.RPID {
		t.Fatalf("rp.id = %q, want %q", opts.Response.RelyingParty.ID, authtest.RPID)
	}
}

func TestPasskeyCeremonyIDIsNotGuessable(t *testing.T) {
	pool := pgtest.New(t)
	p := newPasskeys(t, pool)
	seen := map[string]bool{}
	for range 32 {
		id, _, err := p.BeginLogin(bgctx)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := base64.RawURLEncoding.DecodeString(id)
		if err != nil {
			t.Fatalf("ceremony id %q is not base64url: %v", id, err)
		}
		if len(raw) < 32 {
			t.Fatalf("ceremony id carries %d bytes, want at least 32", len(raw))
		}
		if seen[id] {
			t.Fatal("a ceremony id repeated")
		}
		seen[id] = true
	}
}

func TestPasskeysRefusesAConfigWithNoOrigin(t *testing.T) {
	pool := pgtest.New(t)
	if _, err := NewPasskeys(pool, authtest.RPID, authtest.RPDisplayName, nil); err == nil {
		t.Fatal("a relying party with no origins was accepted; every ceremony would be unverifiable")
	}
}
