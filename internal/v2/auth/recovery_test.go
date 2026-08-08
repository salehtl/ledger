package auth

// The recovery authorizer: an Ed25519 key published with the account's key set,
// whose signature Register accepts as an alternative to a signature by an
// already-enrolled device.
//
// This file is the answer to one question — "does adding a second authorised
// signer weaken the capability rule?" — so every test here is about a boundary
// rather than about the happy path:
//
//   * a stolen session still enrolls nothing;
//   * the TOFU bootstrap is still available exactly once, and revoking every
//     device still does not reopen it;
//   * the recovery key authorizes THIS enrollment and no other, like every
//     other signature this package accepts;
//   * and the enrollment it authorizes is visibly different in key_history, so
//     a peer device auditing the log sees that a recovery happened.

import (
	"crypto/ed25519"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/pgtest"
)

// publishRecoveryKey stores a key set for u carrying pub as the recovery
// authorizer, the way api.handlePublishKeys does. The ingest key and the
// wrapped blob are opaque filler here: nothing in this package reads them.
func publishRecoveryKey(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, pub ed25519.PublicKey) {
	t.Helper()
	if _, err := pool.Exec(bgctx,
		`INSERT INTO user_keys (user_id, ingest_pubkey, wrapped_keys, key_version, recovery_pubkey, created_at, updated_at)
		 VALUES ($1, $2, $3, 1, $4, now(), now())`,
		u, make([]byte, 32), make([]byte, 149), []byte(pub)); err != nil {
		t.Fatalf("publish recovery key: %v", err)
	}
}

// The whole point, in one test: a device with no key of its own, on an account
// whose bootstrap is spent, enrolls with nothing but a signature from the key
// the recovery phrase reproduces.
func TestRecoveryKeyEnrollsAWriterWithNoOtherDeviceInvolved(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-enrolls"))
	w := newWriters(pool, newClock())

	// The original device, and the account's one self-approval, spent.
	original := newDevice(t, "dev-original")
	mustEnroll(t, w, u, original, original)

	recovery := newDevice(t, "recovery-authorizer")
	publishRecoveryKey(t, pool, u, recovery.pub)

	// A browser whose site data was cleared: a brand new writer id and a brand
	// new key, no access to the original device.
	recovered := newDevice(t, "web-after-clearing")
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, recovered.id, recovered.pub, n, recovery.signEnrollment(n, recovered)); err != nil {
		t.Fatalf("a recovery-authorized enrollment was refused: %v", err)
	}

	roster, err := w.Roster(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, r := range roster {
		if r.WriterID == recovered.id && r.Live() && r.PubKey.Equal(recovered.pub) {
			found = true
		}
	}
	if !found {
		t.Fatal("the recovered writer is not on the roster")
	}
}

// The bootstrap arm too: an account that published keys and then lost its only
// device before enrolling one at all. Rare, but it is the same signature and it
// must not fall through the `!hadDevice` branch into a refusal.
func TestRecoveryKeyAuthorizesTheVeryFirstWriter(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-first"))
	w := newWriters(pool, newClock())

	recovery := newDevice(t, "recovery-authorizer")
	publishRecoveryKey(t, pool, u, recovery.pub)

	d := newDevice(t, "dev-first")
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, d.id, d.pub, n, recovery.signEnrollment(n, d)); err != nil {
		t.Fatalf("recovery-authorized first enrollment: %v", err)
	}
}

// THE test. The recovery key is an additional SIGNER; it is not a second
// bootstrap, and it is not reachable from a session.
func TestRecoveryKeyDoesNotReopenTheBootstrapOrHelpAStolenSession(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-bounds"))
	w := newWriters(pool, newClock())

	original := newDevice(t, "dev-original")
	mustEnroll(t, w, u, original, original)

	recovery := newDevice(t, "recovery-authorizer")
	publishRecoveryKey(t, pool, u, recovery.pub)

	// 1. A stolen session. The attacker can mint challenges — that is all a
	//    session authorizes — and holds no key that may sign. A self-signature
	//    is refused exactly as it was before the recovery key existed.
	attacker := newDevice(t, "dev-attacker")
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, attacker.id, attacker.pub, n, attacker.signEnrollment(n, attacker)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a session self-signed its way in: %v", err)
	}

	// 2. Revoking every device still does not reopen TOFU. `hadDevice` is
	//    untouched by this change and this is what says so.
	n2 := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, original.id, n2, original.signRevocation(n2, original.id)); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	n3 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, attacker.id, attacker.pub, n3, attacker.signEnrollment(n3, attacker)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("an empty roster reopened the bootstrap: %v", err)
	}

	// 3. And the recovery key still works after all of that, which is the whole
	//    reason it exists: a user who revoked their last device is not locked out.
	replacement := newDevice(t, "dev-replacement")
	n4 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, replacement.id, replacement.pub, n4, recovery.signEnrollment(n4, replacement)); err != nil {
		t.Fatalf("recovery after revoking the last device: %v", err)
	}
}

// An account that never published keys has no recovery authorizer, and nothing
// about the roster changes for it. This is what keeps every pre-Phase-3 account
// on exactly the rules it had.
func TestAnAccountWithNoPublishedKeysIsUnchanged(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-absent"))
	w := newWriters(pool, newClock())

	original := newDevice(t, "dev-original")
	mustEnroll(t, w, u, original, original)

	stranger := newDevice(t, "dev-stranger")
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, stranger.id, stranger.pub, n, stranger.signEnrollment(n, stranger)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("an account with no published keys accepted a self-signature: %v", err)
	}
}

// A recovery key belongs to ONE account. A signature under account A's
// authorizer must do nothing on account B — the lookup is scoped to the user
// the session resolved to, and this is what proves the scoping rather than
// assuming it.
func TestARecoveryKeyAuthorizesOnlyItsOwnAccount(t *testing.T) {
	pool := pgtest.New(t)
	alice := mustUpsert(t, pool, appleIdentity("sub-recovery-alice"))
	bob := mustUpsert(t, pool, appleIdentity("sub-recovery-bob"))
	w := newWriters(pool, newClock())

	aliceRecovery := newDevice(t, "alice-recovery")
	publishRecoveryKey(t, pool, alice, aliceRecovery.pub)
	bobRecovery := newDevice(t, "bob-recovery")
	publishRecoveryKey(t, pool, bob, bobRecovery.pub)

	d := newDevice(t, "dev-intruder")
	n := mustChallenge(t, w, bob)
	if err := w.Register(bgctx, bob, d.id, d.pub, n, aliceRecovery.signEnrollment(n, d)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("alice's recovery key enrolled a writer on bob's account: %v", err)
	}
}

// The signature binds the enrollment, exactly as a device signature does: a
// recovery signature observed for one (writer id, key) pair authorizes that pair
// and nothing else. Without this, a captured recovery signature would be a
// blank cheque.
func TestARecoverySignatureAuthorizesOnlyItsOwnEnrollment(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-binding"))
	w := newWriters(pool, newClock())
	recovery := newDevice(t, "recovery-authorizer")
	publishRecoveryKey(t, pool, u, recovery.pub)

	intended := newDevice(t, "dev-intended")
	other := newDevice(t, "dev-other")

	n := mustChallenge(t, w, u)
	sig := recovery.signEnrollment(n, intended) // authorizes `intended` and nothing else
	if err := w.Register(bgctx, u, other.id, other.pub, n, sig); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a recovery signature for one writer enrolled another: %v", err)
	}
}

// The recovery key is not a device: it must not appear on the roster, and it
// must not become an authorizer for revocation either. Revocation deliberately
// has no bootstrap path, and widening it here would let a phrase retire every
// device — which is a denial of service the phrase should not be able to cause.
func TestTheRecoveryKeyIsNotAWriterAndCannotRevoke(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-not-a-writer"))
	w := newWriters(pool, newClock())

	original := newDevice(t, "dev-original")
	mustEnroll(t, w, u, original, original)
	recovery := newDevice(t, "recovery-authorizer")
	publishRecoveryKey(t, pool, u, recovery.pub)

	roster, err := w.Roster(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range roster {
		if r.PubKey.Equal(recovery.pub) {
			t.Fatal("the recovery authorizer is on the writer roster")
		}
	}

	n := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, original.id, n, recovery.signRevocation(n, original.id)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("the recovery key revoked a device: %v", err)
	}
}

// A recovery-authorized enrollment is VISIBLE in key_history, as a different
// event from an ordinary one. That is what a peer device auditing the log sees,
// and — because the cross-device comparison code hashes the event string — a
// server that lied about it would produce codes that do not match.
func TestARecoveryEnrollmentIsVisibleInTheKeyHistory(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-history"))
	w := newWriters(pool, newClock())

	original := newDevice(t, "dev-original")
	mustEnroll(t, w, u, original, original)
	recovery := newDevice(t, "recovery-authorizer")
	publishRecoveryKey(t, pool, u, recovery.pub)

	recovered := newDevice(t, "web-after-clearing")
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, recovered.id, recovered.pub, n, recovery.signEnrollment(n, recovered)); err != nil {
		t.Fatal(err)
	}

	log, err := w.KeyHistory(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	var events []string
	for _, e := range log {
		if e.WriterID == recovered.id {
			events = append(events, e.Event)
		}
	}
	if len(events) != 1 || events[0] != EventRecoveryRegistered {
		t.Fatalf("key history for the recovered writer = %v, want [%s]", events, EventRecoveryRegistered)
	}

	// And the ordinary enrollment is still an ordinary one: a change that
	// relabelled everything would make the distinction worthless.
	for _, e := range log {
		if e.WriterID == original.id && e.Event != EventRegistered {
			t.Fatalf("the original enrollment is recorded as %q", e.Event)
		}
	}
}

// A small-order recovery key is refused for the same reason a small-order
// device key is: signatures under it are forgeable by anyone, so it would make
// every enrollment authorizable by any session holder. Screened when it is
// READ, not only when it is written, because a row planted by a repair script
// must not authorize anything either.
func TestASmallOrderRecoveryKeyAuthorizesNothing(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-recovery-smallorder"))
	w := newWriters(pool, newClock())

	original := newDevice(t, "dev-original")
	mustEnroll(t, w, u, original, original)

	// The Ed25519 identity point, planted directly past the API's own checks.
	identityKey := make([]byte, ed25519.PublicKeySize)
	identityKey[0] = 0x01
	publishRecoveryKey(t, pool, u, identityKey)

	d := newDevice(t, "dev-forged")
	n := mustChallenge(t, w, u)
	// The universal forgery for the identity point: 64 zero bytes.
	if err := w.Register(bgctx, u, d.id, d.pub, n, make([]byte, ed25519.SignatureSize)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a small-order recovery key authorized an enrollment: %v", err)
	}
}
