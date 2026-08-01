package auth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

func newSessions(pool *pgxpool.Pool, ttl time.Duration, c *clock) *Sessions {
	return &Sessions{Pool: pool, TTL: ttl, Now: c.now}
}

func mustUpsert(t *testing.T, pool *pgxpool.Pool, id Identity) uuid.UUID {
	t.Helper()
	u, err := UpsertUser(bgctx, pool, id)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func appleIdentity(sub string) Identity { return Identity{IdP: IdPApple, Subject: sub} }

// ---------------------------------------------------------------------------
// Session tokens
// ---------------------------------------------------------------------------

func TestSessionTokenIsNeverStoredInTheClear(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-clear"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if tok == "" {
		t.Fatal("issued an empty token")
	}

	var raw []byte
	if err := pool.QueryRow(bgctx, `SELECT token_hash FROM sessions`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(tok)) {
		t.Fatal("the sessions table contains the bearer token itself")
	}
	want := sha256.Sum256([]byte(tok))
	if !bytes.Equal(raw, want[:]) {
		t.Fatalf("stored %x, want SHA-256 of the token %x", raw, want)
	}

	got, err := s.Resolve(bgctx, tok)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if got != u {
		t.Fatalf("resolved to %s, want %s", got, u)
	}
}

// A session token is a bearer credential; it has to be unguessable. 32 bytes
// from crypto/rand is the requirement, and the encoding must not silently
// shrink that.
func TestIssuedTokensAreDistinctAnd32BytesOfEntropy(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-entropy"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		tok, err := s.Issue(bgctx, u)
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatalf("issued a duplicate token after %d draws", i)
		}
		seen[tok] = true
		raw, err := base64.RawURLEncoding.DecodeString(tok)
		if err != nil {
			t.Fatalf("token is not base64url: %v", err)
		}
		if len(raw) != sessionTokenBytes {
			t.Fatalf("token carries %d bytes of entropy, want %d", len(raw), sessionTokenBytes)
		}
	}
}

func TestExpiredSessionIsRejected(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-expiry"))
	c := newClock()
	s := newSessions(pool, time.Minute, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(bgctx, tok); err != nil {
		t.Fatalf("fresh session should resolve: %v", err)
	}

	c.advance(2 * time.Minute)
	_, err = s.Resolve(bgctx, tok)
	if !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("resolve after expiry: %v, want ErrSessionExpired", err)
	}
	// Every rejection reason must also satisfy the general predicate, so a
	// caller can write one check and not accidentally admit a revoked or
	// expired session by matching only the unknown-token case.
	if !errors.Is(err, ErrSessionInvalid) {
		t.Fatal("ErrSessionExpired must wrap ErrSessionInvalid")
	}
}

func TestRevokedSessionIsRejected(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-revoke"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Revoke(bgctx, tok); err != nil {
		t.Fatal(err)
	}
	_, err = s.Resolve(bgctx, tok)
	if !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("resolve after revoke: %v, want ErrSessionRevoked", err)
	}
	if !errors.Is(err, ErrSessionInvalid) {
		t.Fatal("ErrSessionRevoked must wrap ErrSessionInvalid")
	}

	// Revocation is permanent and idempotent: a second Revoke must not move
	// the recorded time, and must certainly not un-revoke.
	var first time.Time
	if err := pool.QueryRow(bgctx, `SELECT revoked_at FROM sessions`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	c.advance(time.Minute)
	if err := s.Revoke(bgctx, tok); err != nil {
		t.Fatal(err)
	}
	var second time.Time
	if err := pool.QueryRow(bgctx, `SELECT revoked_at FROM sessions`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if !first.Equal(second) {
		t.Fatalf("second revoke moved revoked_at from %v to %v", first, second)
	}
	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("still revoked check: %v", err)
	}
}

func TestResolveRejectsUnknownAndEmptyTokens(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-unknown"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)
	if _, err := s.Issue(bgctx, u); err != nil {
		t.Fatal(err)
	}

	for _, tok := range []string{"", "not-a-token", base64.RawURLEncoding.EncodeToString(make([]byte, 32))} {
		got, err := s.Resolve(bgctx, tok)
		if !errors.Is(err, ErrSessionInvalid) {
			t.Fatalf("resolve(%q) = %v, want ErrSessionInvalid", tok, err)
		}
		if got != uuid.Nil {
			t.Fatalf("a rejected token resolved to %s", got)
		}
	}
}

// "Sign out everywhere" and, later, the account-deletion path both need this.
// It must not touch another user's sessions.
func TestRevokeAllForUserRevokesOnlyThatUser(t *testing.T) {
	pool := pgtest.New(t)
	mine := mustUpsert(t, pool, appleIdentity("sub-mine"))
	theirs := mustUpsert(t, pool, appleIdentity("sub-theirs"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	var myTokens []string
	for i := 0; i < 3; i++ {
		tok, err := s.Issue(bgctx, mine)
		if err != nil {
			t.Fatal(err)
		}
		myTokens = append(myTokens, tok)
	}
	theirToken, err := s.Issue(bgctx, theirs)
	if err != nil {
		t.Fatal(err)
	}

	if err := s.RevokeAllForUser(bgctx, mine); err != nil {
		t.Fatal(err)
	}
	for i, tok := range myTokens {
		if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionRevoked) {
			t.Fatalf("my token %d: %v, want ErrSessionRevoked", i, err)
		}
	}
	if got, err := s.Resolve(bgctx, theirToken); err != nil || got != theirs {
		t.Fatalf("another user's session was collateral damage: %s %v", got, err)
	}
}

func TestIssueRejectsAnUnusableConfiguration(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-config"))
	c := newClock()

	if _, err := (&Sessions{Pool: pool, TTL: 0, Now: c.now}).Issue(bgctx, u); err == nil {
		t.Fatal("a zero TTL must be rejected, not silently issue a dead session")
	}
	if _, err := (&Sessions{Pool: pool, TTL: -time.Hour, Now: c.now}).Issue(bgctx, u); err == nil {
		t.Fatal("a negative TTL must be rejected")
	}
	if _, err := newSessions(pool, time.Hour, c).Issue(bgctx, uuid.Nil); err == nil {
		t.Fatal("the zero user id must be rejected")
	}
}

// ---------------------------------------------------------------------------
// UpsertUser
// ---------------------------------------------------------------------------

// the oplog appender's ON CONFLICT path is documented as dead code in steady state
// because the counter row is created WITH the user. That claim is only true if
// this function actually does it, in the same transaction.
func TestUpsertUserCreatesTheUserAndItsOplogSeqRowTogether(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-new"))
	if u == uuid.Nil {
		t.Fatal("returned the zero uuid")
	}

	var users, seqRows int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM users WHERE id = $1`, u).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM oplog_seq WHERE user_id = $1`, u).Scan(&seqRows); err != nil {
		t.Fatal(err)
	}
	if users != 1 || seqRows != 1 {
		t.Fatalf("users=%d oplog_seq=%d, want 1 and 1", users, seqRows)
	}
}

func TestUpsertUserNeverStoresTheRawSubject(t *testing.T) {
	pool := pgtest.New(t)
	const sub = "001234.deadbeefcafe.0001"
	u := mustUpsert(t, pool, appleIdentity(sub))

	var idp string
	var hash []byte
	err := pool.QueryRow(bgctx, `SELECT idp, idp_sub_hash FROM users WHERE id = $1`, u).Scan(&idp, &hash)
	if err != nil {
		t.Fatal(err)
	}
	if idp != IdPApple {
		t.Fatalf("idp = %q", idp)
	}
	if bytes.Contains(hash, []byte(sub)) {
		t.Fatal("the users table contains the raw IdP subject")
	}
	if !bytes.Equal(hash, SubjectHash(IdPApple, sub)) {
		t.Fatalf("stored %x, want SubjectHash %x", hash, SubjectHash(IdPApple, sub))
	}
}

// Every sign-in after the first calls this. It must return the same user, and
// — the failure that would actually hurt — must not reset the op-log counter,
// which would hand the next append a seq that already exists.
func TestUpsertUserIsIdempotentAndDoesNotResetTheSeqCounter(t *testing.T) {
	pool := pgtest.New(t)
	id := appleIdentity("sub-repeat")
	first := mustUpsert(t, pool, id)

	if _, err := pool.Exec(bgctx, `UPDATE oplog_seq SET next_seq = 42 WHERE user_id = $1`, first); err != nil {
		t.Fatal(err)
	}

	second := mustUpsert(t, pool, id)
	if second != first {
		t.Fatalf("second sign-in produced a different user: %s then %s", first, second)
	}

	var next int64
	if err := pool.QueryRow(bgctx, `SELECT next_seq FROM oplog_seq WHERE user_id = $1`, first).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if next != 42 {
		t.Fatalf("next_seq = %d after a repeat sign-in, want 42 (the counter was reset)", next)
	}

	var users int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM users`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 1 {
		t.Fatalf("users = %d, want 1", users)
	}
}

// The same person tapping "Sign in" on two devices at once, or a client
// retrying a slow request, races two first-logins for one identity.
func TestUpsertUserIsSafeUnderConcurrentFirstLogin(t *testing.T) {
	pool := pgtest.New(t)
	id := appleIdentity("sub-race")

	const n = 8
	ids := make([]uuid.UUID, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	// pgxpool opens connections lazily, so without this the goroutines are
	// staggered by connection setup and may barely overlap. Replacing
	// UpsertUser's `INSERT ... ON CONFLICT DO NOTHING` + fallback SELECT with a
	// SELECT-then-INSERT TOCTOU is the mutation this test exists to catch:
	// warmed, it fails 8 of 8 runs here; unwarmed, whether it fails at all is
	// load- and machine-dependent (it failed 8 of 8 on this box but survived 3
	// of 8 for a reviewer on another). Warming removes the dependence on luck
	// rather than fixing a specific number. Every single-shot concurrency test
	// in this package wants it; see warmPool in writer_test.go.
	warmPool(t, pool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			ids[i], errs[i] = UpsertUser(bgctx, pool, id)
		}(i)
	}
	close(start)
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: %v", i, err)
		}
	}
	for i := 1; i < n; i++ {
		if ids[i] != ids[0] {
			t.Fatalf("concurrent first logins produced two users: %s and %s", ids[0], ids[i])
		}
	}
	var users, seqRows int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM users`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM oplog_seq`).Scan(&seqRows); err != nil {
		t.Fatal(err)
	}
	if users != 1 || seqRows != 1 {
		t.Fatalf("users=%d oplog_seq=%d, want 1 and 1", users, seqRows)
	}
}

// The same opaque subject string from two different providers is two different
// people. The users table's UNIQUE (idp, idp_sub_hash) says so; this pins that
// UpsertUser actually feeds it distinct hashes.
func TestUpsertUserSeparatesIdentitiesAcrossProviders(t *testing.T) {
	pool := pgtest.New(t)
	const sub = "same-string"
	apple := mustUpsert(t, pool, Identity{IdP: IdPApple, Subject: sub})
	google := mustUpsert(t, pool, Identity{IdP: IdPGoogle, Subject: sub})
	if apple == google {
		t.Fatal("an apple and a google identity with the same subject collapsed into one user")
	}
}

func TestUpsertUserRejectsAnUnusableIdentity(t *testing.T) {
	pool := pgtest.New(t)
	cases := map[string]Identity{
		"empty idp":     {IdP: "", Subject: "x"},
		"unknown idp":   {IdP: "facebook", Subject: "x"},
		"empty subject": {IdP: IdPApple, Subject: ""},
	}
	for name, id := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := UpsertUser(bgctx, pool, id); err == nil {
				t.Fatalf("UpsertUser(%+v) succeeded", id)
			}
		})
	}
	var users int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM users`).Scan(&users); err != nil {
		t.Fatal(err)
	}
	if users != 0 {
		t.Fatalf("users = %d after only-invalid upserts", users)
	}
}
