package auth

import (
	"errors"
	"testing"
	"time"

	"ledger/internal/v2/pgtest"
)

// The whole reason 00021 exists. If this ever passes because the middleware
// checked "session resolved but the user row is missing", it is passing over a
// state that cannot occur: sessions.user_id cascades from users.
func TestASessionOfADeletedAccountIsDistinguishableFromAnExpiredOne(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-deleted-session"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(bgctx, tok); err != nil {
		t.Fatalf("a fresh session did not resolve: %v", err)
	}

	// The production deletion statement, verbatim: purge.Purge is one
	// `DELETE FROM users` and everything else cascades from it.
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}
	// The session row really is gone — so anything that looked for "resolved
	// but no user" would find nothing to look at.
	var sessions int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("%d session rows survived the account: the cascade this test is about did not happen", sessions)
	}

	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionAccountDeleted) {
		t.Fatalf("err = %v, want ErrSessionAccountDeleted", err)
	}
	// It is still a session-invalid case, so a caller that only knows the
	// general sentinel still rejects it rather than falling through to a 500.
	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionInvalid) {
		t.Fatal("ErrSessionAccountDeleted does not wrap ErrSessionInvalid")
	}
}

// An ordinary expiry must stay an ordinary expiry: this is the case the client
// must NOT wipe local data on, and it is the common one.
func TestAnExpiredSessionIsNotReportedAsADeletedAccount(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-expiry"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	c.advance(2 * time.Hour)
	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("err = %v, want ErrSessionExpired", err)
	}
}

// A token that was never issued must not be answered as a deleted account: it
// would tell an unauthenticated caller that a guessed token once existed.
func TestAnUnknownTokenIsNotReportedAsADeletedAccount(t *testing.T) {
	pool := pgtest.New(t)
	c := newClock()
	s := newSessions(pool, time.Hour, c)
	if _, err := s.Resolve(bgctx, "not-a-token-anyone-ever-issued"); !errors.Is(err, ErrSessionUnknown) {
		t.Fatalf("err = %v, want ErrSessionUnknown", err)
	}
}

// The tombstone stops answering once the session it names would have died
// anyway. Past that point "expired" is true and sufficient.
func TestTheTombstoneStopsAnsweringOnceTheSessionWouldHaveExpired(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-tombstone-expiry"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionAccountDeleted) {
		t.Fatalf("err = %v, want ErrSessionAccountDeleted while the session is live", err)
	}
	c.advance(2 * time.Hour)
	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionUnknown) {
		t.Fatalf("err = %v, want ErrSessionUnknown once the session's own expiry passed", err)
	}
}

// Whether a tombstone still answers is decided by the Sessions clock — the one
// that decides expiry everywhere else — and never by Postgres's.
//
// This is not a hypothetical distinction. A test that pins its clock (as every
// test in this package does) issues sessions whose expires_at is in Postgres's
// PAST, so a trigger that filtered on `expires_at > now()` would write no row
// at all and every 410 would silently become a 401. Two clocks deciding one
// fact is the defect; this pins the fix in both directions.
func TestTombstoneExpiryIsDecidedByTheSessionsClock(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-stale"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	// Postgres's own clock is well past this session's expiry: the test clock
	// is pinned to a fixed instant and wall time has moved on since.
	var dbSaysExpired bool
	if err := pool.QueryRow(bgctx,
		`SELECT bool_and(expires_at < now()) FROM sessions WHERE user_id = $1`, u).Scan(&dbSaysExpired); err != nil {
		t.Fatal(err)
	}
	if !dbSaysExpired {
		t.Skip("wall time has not passed the pinned test clock; this test needs the two to disagree")
	}
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}

	var rows int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM deleted_account_sessions`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("%d tombstones, want 1: the trigger judged expiry by Postgres's clock", rows)
	}
	if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionAccountDeleted) {
		t.Fatalf("err = %v, want ErrSessionAccountDeleted: the session is live by the clock that decides", err)
	}
}

// The tombstone must carry nothing attributable to the person: no user id, no
// subject hash, no address.
func TestTheTombstoneCarriesNoIdentity(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-anonymous"))
	c := newClock()
	s := newSessions(pool, time.Hour, c)
	if _, err := s.Issue(bgctx, u); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
		t.Fatal(err)
	}

	rows, err := pool.Query(bgctx,
		`SELECT column_name FROM information_schema.columns
		  WHERE table_schema = 'public' AND table_name = 'deleted_account_sessions'
		  ORDER BY column_name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		cols = append(cols, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"token_hash": true, "deleted_at": true, "expires_at": true}
	for _, c := range cols {
		if !want[c] {
			t.Fatalf("deleted_account_sessions has column %q: the tombstone must outlive an account "+
				"without describing one", c)
		}
	}
	if len(cols) != len(want) {
		t.Fatalf("columns = %v, want exactly %v", cols, want)
	}
}
