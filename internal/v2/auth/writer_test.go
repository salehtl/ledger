package auth

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// device is a client writer's identity keypair plus the writer id it wants.
// The private half never leaves this struct, which is the point of the whole
// mechanism: the server only ever sees the public key and a signature.
type device struct {
	id   string
	pub  ed25519.PublicKey
	priv ed25519.PrivateKey
}

func newDevice(t *testing.T, id string) device {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return device{id: id, pub: pub, priv: priv}
}

// signEnrollment signs the enrollment OF subject, USING d's private key. When
// d == subject this is the self-signature a first (TOFU) writer presents.
func (d device) signEnrollment(nonce []byte, subject device) []byte {
	return ed25519.Sign(d.priv, RegistrationMessage(nonce, subject.id, subject.pub))
}

func (d device) signRevocation(nonce []byte, target string) []byte {
	return ed25519.Sign(d.priv, RevocationMessage(nonce, target))
}

func newWriters(pool *pgxpool.Pool, c *clock) *Writers {
	return &Writers{Pool: pool, Now: c.now}
}

func mustChallenge(t *testing.T, w *Writers, u uuid.UUID) []byte {
	t.Helper()
	n, err := w.Challenge(bgctx, u)
	if err != nil {
		t.Fatalf("challenge: %v", err)
	}
	return n
}

// mustEnroll registers subject, authorized by by's key (pass subject as by for
// the self-signed bootstrap).
func mustEnroll(t *testing.T, w *Writers, u uuid.UUID, by, subject device) {
	t.Helper()
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, subject.id, subject.pub, n, by.signEnrollment(n, subject)); err != nil {
		t.Fatalf("register %s (authorized by %s): %v", subject.id, by.id, err)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx, sql, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ---------------------------------------------------------------------------
// The capability rule (spec §3.4): a session token alone is not enough
// ---------------------------------------------------------------------------

// ATTACK: an attacker holding a stolen session token can do everything a
// session authorizes — including asking for a writer challenge — and can
// generate a keypair of its own and sign the challenge with it. What it cannot
// do is sign with a key that is ALREADY ENROLLED. If a self-signature were
// accepted for the second writer, the stolen token alone would inject a writer
// whose ops every other device would replay.
func TestSecondWriterRequiresProofOfKeyPossession(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-possession"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a) // first writer: TOFU bootstrap

	b := newDevice(t, "dev-b")
	n2 := mustChallenge(t, w, u)
	err := w.Register(bgctx, u, b.id, b.pub, n2, b.signEnrollment(n2, b))
	if !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("self-signed second writer: %v, want ErrNotAuthorized (spec §3.4 capability rules)", err)
	}
	if countRows(t, pool, `SELECT count(*) FROM writers WHERE user_id=$1 AND writer_id=$2`, u, b.id) != 0 {
		t.Fatal("the rejected writer was stored anyway")
	}

	// The legitimate path: an already-enrolled device authorizes the new one.
	n3 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, b.id, b.pub, n3, a.signEnrollment(n3, b)); err != nil {
		t.Fatalf("second writer signed by an enrolled key must be accepted: %v", err)
	}
}

// ATTACK: capture a legitimate signature (over a challenge the victim's device
// really signed) and re-submit it for a DIFFERENT writer id, or a DIFFERENT
// public key. A signature over the bare nonce — the first draft of this
// mechanism — would accept both, because it proves possession of an enrolled
// key without saying what that key authorized.
func TestSignatureIsBoundToTheWriterIDAndKey(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-binding"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)

	b := newDevice(t, "dev-b")
	evil := newDevice(t, "dev-evil")

	t.Run("swapped writer id", func(t *testing.T) {
		n := mustChallenge(t, w, u)
		sig := a.signEnrollment(n, b) // authorizes dev-b with pubB, nothing else
		err := w.Register(bgctx, u, evil.id, b.pub, n, sig)
		if !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("replayed under another writer id: %v, want ErrNotAuthorized", err)
		}
	})

	t.Run("swapped public key", func(t *testing.T) {
		n := mustChallenge(t, w, u)
		sig := a.signEnrollment(n, b)
		err := w.Register(bgctx, u, b.id, evil.pub, n, sig)
		if !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("replayed under another public key: %v, want ErrNotAuthorized", err)
		}
	})

	t.Run("signature over the bare nonce", func(t *testing.T) {
		// Exactly what the rejected first draft would have verified.
		n := mustChallenge(t, w, u)
		err := w.Register(bgctx, u, evil.id, evil.pub, n, ed25519.Sign(a.priv, n))
		if !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("bare-nonce signature: %v, want ErrNotAuthorized", err)
		}
	})

	t.Run("a revocation signature is not a registration signature", func(t *testing.T) {
		// Domain separation: the two messages must not be interchangeable, or
		// a "retire this device" signature doubles as an enrollment.
		n := mustChallenge(t, w, u)
		err := w.Register(bgctx, u, evil.id, evil.pub, n, a.signRevocation(n, evil.id))
		if !errors.Is(err, ErrNotAuthorized) {
			t.Fatalf("revocation signature accepted as registration: %v", err)
		}
	})

	if countRows(t, pool, `SELECT count(*) FROM writers WHERE user_id=$1 AND kind=$2`, u, KindDevice) != 1 {
		t.Fatal("one of the replay attempts enrolled a writer")
	}
}

// RegistrationMessage is reimplemented by the client (Task 14). Pin its exact
// bytes here so a drift in either implementation is a test failure and not a
// mysterious rejection at enrollment time.
func TestRegistrationMessageEncodingIsPinnedAndUnambiguous(t *testing.T) {
	nonce := bytes.Repeat([]byte{0xAB}, ChallengeNonceBytes)
	pub := ed25519.PublicKey(bytes.Repeat([]byte{0xCD}, ed25519.PublicKeySize))

	got := RegistrationMessage(nonce, "dev-a", pub)
	want := append([]byte("ledger-v2-writer-registration\x00"), nonce...)
	want = append(want, 0x00)
	want = append(want, "dev-a"...)
	want = append(want, 0x00)
	want = append(want, pub...)
	if !bytes.Equal(got, want) {
		t.Fatalf("RegistrationMessage =\n%x\nwant\n%x", got, want)
	}

	// The domain prefix keeps a registration message out of every other
	// signing context this key will ever be used in.
	if !bytes.HasPrefix(RevocationMessage(nonce, "dev-a"), []byte("ledger-v2-writer-revocation\x00")) {
		t.Fatal("revocation messages must carry their own domain prefix")
	}

	// Unambiguity: with the nonce and the key both fixed-length, no two
	// distinct (nonce, writerID, pubkey) triples can encode to the same bytes,
	// including when the writer id itself contains the separator byte.
	seen := map[string]string{}
	for _, id := range []string{"a", "a\x00b", "b", "", "a\x00", "\x00ab"} {
		enc := string(RegistrationMessage(nonce, id, pub))
		if other, dup := seen[enc]; dup {
			t.Fatalf("writer ids %q and %q encode identically", other, id)
		}
		seen[enc] = id
	}
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

func TestChallengesAreDistinctAnd32BytesOfEntropy(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-entropy"))
	w := newWriters(pool, newClock())

	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		n := mustChallenge(t, w, u)
		if len(n) != ChallengeNonceBytes {
			t.Fatalf("nonce is %d bytes, want %d", len(n), ChallengeNonceBytes)
		}
		if seen[string(n)] {
			t.Fatalf("issued a duplicate nonce after %d draws", i)
		}
		seen[string(n)] = true
	}
	if ChallengeNonceBytes*8 < 128 {
		t.Fatalf("a challenge carries %d bits, want at least 128", ChallengeNonceBytes*8)
	}
}

// ATTACK: replay a nonce that already registered a writer.
func TestChallengeIsSingleUse(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-replay"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, a.id, a.pub, n, a.signEnrollment(n, a)); err != nil {
		t.Fatal(err)
	}
	b := newDevice(t, "dev-b")
	err := w.Register(bgctx, u, b.id, b.pub, n, a.signEnrollment(n, b))
	if !errors.Is(err, ErrChallengeUsed) {
		t.Fatalf("replayed nonce: %v, want ErrChallengeUsed", err)
	}

	// A failed attempt burns the challenge too: one challenge, one attempt.
	n2 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, b.id, b.pub, n2, b.signEnrollment(n2, b)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("setup: %v", err)
	}
	if err := w.Register(bgctx, u, b.id, b.pub, n2, a.signEnrollment(n2, b)); !errors.Is(err, ErrChallengeUsed) {
		t.Fatalf("nonce reused after a failed attempt: %v, want ErrChallengeUsed", err)
	}
}

// ATTACK: race the same nonce from many connections at once, hoping the
// test-and-set is a read followed by a write.
func TestChallengeIsSingleUseUnderConcurrency(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-race"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	n := mustChallenge(t, w, u)
	sig := a.signEnrollment(n, a)

	const goroutines = 12
	errs := make([]error, goroutines)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = w.Register(bgctx, u, a.id, a.pub, n, sig)
		}(i)
	}
	close(start)
	wg.Wait()

	won := 0
	for i, err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, ErrRegistrationRejected):
			// The expected loser: challenge already consumed.
		default:
			t.Fatalf("goroutine %d failed for an unexpected reason: %v", i, err)
		}
	}
	if won != 1 {
		t.Fatalf("%d of %d concurrent registrations succeeded, want exactly 1", won, goroutines)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM writers WHERE user_id=$1`, u); got != 1 {
		t.Fatalf("%d writer rows after the race, want 1", got)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM key_history WHERE user_id=$1`, u); got != 1 {
		t.Fatalf("%d key_history rows after the race, want 1", got)
	}
}

// ATTACK: hold a captured challenge until long after the device that would
// have used it is out of the attacker's reach, then spend it.
func TestChallengeExpires(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-expiry"))
	c := newClock()
	w := newWriters(pool, c)

	a := newDevice(t, "dev-a")
	n := mustChallenge(t, w, u)
	c.advance(ChallengeTTL + time.Second)

	err := w.Register(bgctx, u, a.id, a.pub, n, a.signEnrollment(n, a))
	if !errors.Is(err, ErrChallengeExpired) {
		t.Fatalf("expired challenge: %v, want ErrChallengeExpired", err)
	}
	if countRows(t, pool, `SELECT count(*) FROM writers WHERE user_id=$1`, u) != 0 {
		t.Fatal("an expired challenge enrolled a writer")
	}
}

// ATTACK: user B's session gets a challenge for B; the attacker submits it as
// user A, hoping the nonce is looked up by itself.
func TestChallengeIsBoundToTheUserItWasIssuedFor(t *testing.T) {
	pool := pgtest.New(t)
	alice := mustUpsert(t, pool, appleIdentity("sub-writer-alice"))
	mallory := mustUpsert(t, pool, appleIdentity("sub-writer-mallory"))
	w := newWriters(pool, newClock())

	n := mustChallenge(t, w, mallory)
	d := newDevice(t, "dev-m")
	err := w.Register(bgctx, alice, d.id, d.pub, n, d.signEnrollment(n, d))
	if !errors.Is(err, ErrChallengeUnknown) {
		t.Fatalf("cross-user challenge: %v, want ErrChallengeUnknown", err)
	}
	if countRows(t, pool, `SELECT count(*) FROM writers WHERE user_id=$1`, alice) != 0 {
		t.Fatal("a challenge issued for another user enrolled a writer")
	}
	// And it is still spendable by the user it was issued for: the rejected
	// attempt must not have burned someone else's challenge.
	if err := w.Register(bgctx, mallory, d.id, d.pub, n, d.signEnrollment(n, d)); err != nil {
		t.Fatalf("the rightful owner could not spend its own challenge: %v", err)
	}
}

// ATTACK: enrolled on account A, present that key to authorize a writer on
// account B (whose roster is empty, so B is still in its bootstrap window).
func TestAnotherUsersEnrolledKeyCannotAuthorizeAWriter(t *testing.T) {
	pool := pgtest.New(t)
	alice := mustUpsert(t, pool, appleIdentity("sub-writer-a2"))
	bob := mustUpsert(t, pool, appleIdentity("sub-writer-b2"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, alice, a, a)

	evil := newDevice(t, "dev-evil")
	n := mustChallenge(t, w, bob)
	if err := w.Register(bgctx, bob, evil.id, evil.pub, n, a.signEnrollment(n, evil)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("another user's key authorized an enrollment: %v", err)
	}

	// Rosters do not leak across users either.
	roster, err := w.Roster(bgctx, bob)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 0 {
		t.Fatalf("bob's roster has %d entries, want 0", len(roster))
	}
}

// ---------------------------------------------------------------------------
// Bootstrap, revocation
// ---------------------------------------------------------------------------

// The residual trust of the TOFU bootstrap is bounded by being available
// exactly once. If revoking the last device reopened it, a stolen session
// would only need to wait for (or provoke) a revocation.
func TestBootstrapIsAvailableOnlyOnce(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-bootstrap"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)

	// dev-a retires itself; the user now has zero LIVE device writers.
	n := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, a.id, n, a.signRevocation(n, a.id)); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	b := newDevice(t, "dev-b")
	n2 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, b.id, b.pub, n2, b.signEnrollment(n2, b)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a revocation reopened the TOFU bootstrap window: %v", err)
	}
}

// ATTACK: steal a device that was already retired (or its extracted key) and
// use it to enroll a writer.
func TestRevokedKeyCannotAuthorizeANewWriter(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-revoked-key"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	b := newDevice(t, "dev-b")
	mustEnroll(t, w, u, a, a)
	mustEnroll(t, w, u, a, b)

	n := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, a.id, n, b.signRevocation(n, a.id)); err != nil {
		t.Fatalf("revoke dev-a: %v", err)
	}

	evil := newDevice(t, "dev-evil")
	n2 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, evil.id, evil.pub, n2, a.signEnrollment(n2, evil)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a revoked key authorized an enrollment: %v", err)
	}
	// dev-b, still live, can.
	n3 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, evil.id, evil.pub, n3, b.signEnrollment(n3, evil)); err != nil {
		t.Fatalf("a live key was refused: %v", err)
	}
}

// ATTACK: a stolen session revokes every device (the precondition for the
// bootstrap attack above, if bootstrap were reopenable) using a key of its own.
func TestRevocationRequiresAnEnrolledKey(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-revoke-auth"))
	c := newClock()
	w := newWriters(pool, c)

	a := newDevice(t, "dev-a")
	b := newDevice(t, "dev-b")
	mustEnroll(t, w, u, a, a)
	mustEnroll(t, w, u, a, b)

	evil := newDevice(t, "dev-evil")
	n := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, b.id, n, evil.signRevocation(n, b.id)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("an unenrolled key revoked a writer: %v", err)
	}

	// A registration signature must not double as a revocation signature.
	n2 := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, b.id, n2, a.signEnrollment(n2, b)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a registration signature revoked a writer: %v", err)
	}

	roster, err := w.Roster(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 2 || !roster[0].Live() || !roster[1].Live() {
		t.Fatalf("a writer was retired by a refused revocation: %+v", roster)
	}

	// The legitimate revocation, and its idempotence. Authorization is checked
	// before the already-revoked short circuit, so the repeat is authorized by
	// dev-a, which is still live.
	n3 := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, b.id, n3, a.signRevocation(n3, b.id)); err != nil {
		t.Fatal(err)
	}
	first := countRows(t, pool, `SELECT count(*) FROM key_history WHERE user_id=$1 AND event='revoked'`, u)
	c.advance(time.Minute)
	n4 := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, b.id, n4, a.signRevocation(n4, b.id)); err != nil {
		t.Fatalf("a second revoke must be a no-op, not an error: %v", err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM key_history WHERE user_id=$1 AND event='revoked'`, u); got != first {
		t.Fatalf("a repeated revoke appended another key_history row (%d, was %d)", got, first)
	}

	// A revoked key cannot revoke: dev-b is retired and must not be able to
	// retire the device that retired it.
	n5 := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, a.id, n5, b.signRevocation(n5, a.id)); !errors.Is(err, ErrNotAuthorized) {
		t.Fatalf("a revoked key revoked another writer: %v", err)
	}
}

// ---------------------------------------------------------------------------
// The key-history log
// ---------------------------------------------------------------------------

func TestRegistrationAppendsToKeyHistory(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-history"))
	c := newClock()
	w := newWriters(pool, c)

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)
	c.advance(time.Minute)
	b := newDevice(t, "dev-b")
	mustEnroll(t, w, u, a, b)

	rows, err := pool.Query(bgctx,
		`SELECT writer_id, pubkey, event, at FROM key_history WHERE user_id=$1 ORDER BY id`, u)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type entry struct {
		writerID string
		pubkey   []byte
		event    string
		at       time.Time
	}
	var got []entry
	for rows.Next() {
		var e entry
		if err := rows.Scan(&e.writerID, &e.pubkey, &e.event, &e.at); err != nil {
			t.Fatal(err)
		}
		got = append(got, e)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("%d key_history rows, want exactly 2", len(got))
	}
	if got[0].writerID != a.id || !bytes.Equal(got[0].pubkey, a.pub) || got[0].event != EventRegistered {
		t.Fatalf("first entry = %+v", got[0])
	}
	if got[1].writerID != b.id || !bytes.Equal(got[1].pubkey, b.pub) || got[1].event != EventRegistered {
		t.Fatalf("second entry = %+v", got[1])
	}
	if !got[1].at.After(got[0].at) {
		t.Fatal("key_history timestamps do not follow the injected clock")
	}
}

// ATTACK: the log is what peer devices audit for key substitution. Rewriting
// an entry — swapping the public key recorded for a writer, or deleting the
// entry that would expose an injected one — is the substitution itself. It has
// to fail at the database, not merely be absent from this package's SQL.
func TestKeyHistoryIsAppendOnly(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-immutable"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)
	evil := newDevice(t, "dev-evil")

	if _, err := pool.Exec(bgctx,
		`UPDATE key_history SET pubkey=$1 WHERE user_id=$2`, []byte(evil.pub), u); err == nil {
		t.Fatal("a key_history entry was rewritten")
	} else if !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("UPDATE was refused, but not by the append-only guard: %v", err)
	}

	if _, err := pool.Exec(bgctx, `DELETE FROM key_history WHERE user_id=$1`, u); err == nil {
		t.Fatal("a key_history entry was deleted")
	} else if !strings.Contains(err.Error(), "append-only") {
		t.Fatalf("DELETE was refused, but not by the append-only guard: %v", err)
	}

	if _, err := pool.Exec(bgctx, `TRUNCATE key_history`); err == nil {
		t.Fatal("key_history was truncated")
	}

	var pub []byte
	if err := pool.QueryRow(bgctx, `SELECT pubkey FROM key_history WHERE user_id=$1`, u).Scan(&pub); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pub, a.pub) {
		t.Fatal("the recorded public key changed")
	}
}

// The append-only guard must not make account deletion (spec §3.10) impossible:
// erasing a user takes its key history with it. That is a deletion of the whole
// account, not a rewrite of a live account's history.
func TestKeyHistoryIsRemovedWithItsUser(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-cascade"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)
	if _, err := w.EnsureIngestWriter(bgctx, u); err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id=$1`, u); err != nil {
		t.Fatalf("deleting a user must cascade through key_history: %v", err)
	}
	for _, table := range []string{"key_history", "writers", "writer_challenges"} {
		if n := countRows(t, pool, `SELECT count(*) FROM `+table); n != 0 {
			t.Fatalf("%s still holds %d rows after the user was deleted", table, n)
		}
	}
}

// ---------------------------------------------------------------------------
// The ingest writer and the roster
// ---------------------------------------------------------------------------

// ATTACK: register a client-controlled key under the writer id the server's own
// ingest pipeline uses. The ingest chain is the one a client trusts as
// "server-ingested provenance" (spec §3.3(b)); a client writer wearing that id
// would launder its own ops into it.
func TestClientCannotRegisterTheIngestWriterID(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-ingest-id"))
	w := newWriters(pool, newClock())

	d := newDevice(t, IngestWriterID)
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, d.id, d.pub, n, d.signEnrollment(n, d)); !errors.Is(err, ErrWriterIDReserved) {
		t.Fatalf("registering writer_id %q: %v, want ErrWriterIDReserved", IngestWriterID, err)
	}

	// Same for revocation: a client must not be able to retire the server's
	// writer and stop its own ingest.
	if _, err := w.EnsureIngestWriter(bgctx, u); err != nil {
		t.Fatal(err)
	}
	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)
	n2 := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, IngestWriterID, n2, a.signRevocation(n2, IngestWriterID)); !errors.Is(err, ErrWriterIDReserved) {
		t.Fatalf("revoking the ingest writer: %v, want ErrWriterIDReserved", err)
	}
}

func TestEnsureIngestWriterIsIdempotent(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-ingest"))
	w := newWriters(pool, newClock())

	id, err := w.EnsureIngestWriter(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if id != IngestWriterID {
		t.Fatalf("ingest writer id = %q, want %q", id, IngestWriterID)
	}
	for i := 0; i < 3; i++ {
		if _, err := w.EnsureIngestWriter(bgctx, u); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if n := countRows(t, pool, `SELECT count(*) FROM writers WHERE user_id=$1`, u); n != 1 {
		t.Fatalf("%d writer rows, want 1", n)
	}
	if n := countRows(t, pool, `SELECT count(*) FROM key_history WHERE user_id=$1`, u); n != 1 {
		t.Fatalf("%d key_history rows, want 1 (one per actual creation)", n)
	}

	roster, err := w.Roster(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 1 || roster[0].Kind != KindIngest || roster[0].PubKey != nil {
		t.Fatalf("ingest roster entry = %+v", roster)
	}

	// The ingest writer must not count as an enrolled key: it has none, and a
	// user whose only writer is the server's is still on its first device.
	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)
}

func TestRosterReportsEveryWriterWithItsState(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-roster"))
	c := newClock()
	w := newWriters(pool, c)

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)
	c.advance(time.Minute)
	b := newDevice(t, "dev-b")
	mustEnroll(t, w, u, a, b)
	c.advance(time.Minute)
	revokedAt := c.now()
	n := mustChallenge(t, w, u)
	if err := w.Revoke(bgctx, u, b.id, n, a.signRevocation(n, b.id)); err != nil {
		t.Fatal(err)
	}

	roster, err := w.Roster(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster) != 2 {
		t.Fatalf("%d roster entries, want 2", len(roster))
	}
	byID := map[string]Writer{}
	for _, wr := range roster {
		if wr.UserID != u {
			t.Fatalf("roster entry %s belongs to %s", wr.WriterID, wr.UserID)
		}
		byID[wr.WriterID] = wr
	}
	if got := byID[a.id]; !bytes.Equal(got.PubKey, a.pub) || got.Kind != KindDevice || !got.RevokedAt.IsZero() {
		t.Fatalf("dev-a = %+v", got)
	}
	if got := byID[b.id]; !bytes.Equal(got.PubKey, b.pub) || !got.RevokedAt.Equal(revokedAt) {
		t.Fatalf("dev-b = %+v, want revoked at %v", got, revokedAt)
	}
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

func TestRegisterRejectsUnusableInput(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-input"))
	w := newWriters(pool, newClock())
	a := newDevice(t, "dev-a")
	n := mustChallenge(t, w, u)
	good := a.signEnrollment(n, a)

	cases := map[string]struct {
		writerID string
		pub      ed25519.PublicKey
		nonce    []byte
		sig      []byte
	}{
		"empty writer id":  {"", a.pub, n, good},
		"overlong id":      {strings.Repeat("d", 65), a.pub, n, good},
		"id with a NUL":    {"dev\x00a", a.pub, n, good},
		"id with a space":  {"dev a", a.pub, n, good},
		"short public key": {a.id, ed25519.PublicKey(a.pub[:16]), n, good},
		"no public key":    {a.id, nil, n, good},
		"short nonce":      {a.id, a.pub, n[:16], good},
		"short signature":  {a.id, a.pub, n, good[:32]},
		"no signature":     {a.id, a.pub, n, nil},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := w.Register(bgctx, u, c.writerID, c.pub, c.nonce, c.sig)
			if !errors.Is(err, ErrRegistrationRejected) {
				t.Fatalf("Register(%q): %v, want ErrRegistrationRejected", c.writerID, err)
			}
		})
	}
	// None of that touched the challenge: malformed input is refused before it
	// can spend one.
	if err := w.Register(bgctx, u, a.id, a.pub, n, good); err != nil {
		t.Fatalf("a malformed attempt burned the challenge: %v", err)
	}
	// The zero user id is not a wildcard.
	n2 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, uuid.Nil, a.id, a.pub, n2, good); err == nil {
		t.Fatal("the zero user id was accepted")
	}
	if _, err := w.Challenge(bgctx, uuid.Nil); err == nil {
		t.Fatal("a challenge was issued for the zero user id")
	}
}

func TestRegisteringTheSameWriterOrKeyTwiceIsRefused(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-writer-dupe"))
	w := newWriters(pool, newClock())

	a := newDevice(t, "dev-a")
	mustEnroll(t, w, u, a, a)

	// Same writer id, different key: the id is already spoken for, and letting
	// a re-registration through would silently rotate the pinned key under
	// every peer device.
	rekeyed := device{id: a.id, pub: newDevice(t, "x").pub}
	n := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, rekeyed.id, rekeyed.pub, n, a.signEnrollment(n, rekeyed)); !errors.Is(err, ErrWriterExists) {
		t.Fatalf("re-registering an existing writer id: %v, want ErrWriterExists", err)
	}
	var stored []byte
	if err := pool.QueryRow(bgctx,
		`SELECT pubkey FROM writers WHERE user_id=$1 AND writer_id=$2`, u, a.id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(stored, a.pub) {
		t.Fatal("the enrolled key was replaced")
	}

	// Same key, different writer id: two identities for one device would make
	// (writer_id, writer_counter) ambiguous about who authored an op.
	reused := device{id: "dev-b", pub: a.pub, priv: a.priv}
	n2 := mustChallenge(t, w, u)
	if err := w.Register(bgctx, u, reused.id, reused.pub, n2, a.signEnrollment(n2, reused)); !errors.Is(err, ErrKeyAlreadyEnrolled) {
		t.Fatalf("re-using an enrolled key under a new writer id: %v, want ErrKeyAlreadyEnrolled", err)
	}
}

func TestWritersRejectsAnUnusableConfiguration(t *testing.T) {
	var zero Writers
	if _, err := zero.Challenge(bgctx, uuid.New()); err == nil {
		t.Fatal("a nil pool must be refused")
	}
	if err := (&Writers{}).Register(bgctx, uuid.New(), "dev-a", make([]byte, 32), make([]byte, 32), make([]byte, 64)); err == nil {
		t.Fatal("a nil pool must be refused")
	}
	if _, err := (&Writers{}).Roster(bgctx, uuid.New()); err == nil {
		t.Fatal("a nil pool must be refused")
	}
}
