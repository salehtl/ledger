package auth

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

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
// This is not a hypothetical distinction. A clock behind Postgres's issues
// sessions whose expires_at is in Postgres's PAST, so a trigger that filtered
// the INSERT on `expires_at > now()` would write no row at all and every 410
// would silently become a 401. Two clocks deciding one fact is the defect; this
// pins the INSERT side of the fix, and
// TestATombstoneOutlivesADisagreementBetweenTheGoAndPostgresClocks pins the
// retention side.
//
// The skew is a DURATION, not the pinned newClock() this test used to take.
// Under the pinned clock the disagreement it needs was supplied by the
// calendar — true only because wall time had passed 2026-08-01T13:00:00Z — and
// the test skipped itself, silently and vacuously, on any box whose date said
// otherwise. Two hours of skew is the same disagreement on every day this suite
// will ever run.
func TestTombstoneExpiryIsDecidedByTheSessionsClock(t *testing.T) {
	pool := pgtest.New(t)
	u := mustUpsert(t, pool, appleIdentity("sub-stale"))
	// Two hours behind wall time with a one-hour TTL: live by the clock that
	// decides, an hour dead by Postgres's.
	c := newSkewedClock(-2 * time.Hour)
	s := newSessions(pool, time.Hour, c)

	tok, err := s.Issue(bgctx, u)
	if err != nil {
		t.Fatal(err)
	}
	// Asserted, not skipped on: the premise of this test is measured here, and
	// a run in which the two clocks agree proves nothing and must say so.
	var dbSaysExpired bool
	if err := pool.QueryRow(bgctx,
		`SELECT bool_and(expires_at < now()) FROM sessions WHERE user_id = $1`, u).Scan(&dbSaysExpired); err != nil {
		t.Fatal(err)
	}
	if !dbSaysExpired {
		t.Fatal("Postgres does not consider this session expired: the two clocks agree, " +
			"so this run cannot see the defect it exists to catch")
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

// newSkewedClock returns a clock a fixed distance from wall time, pinned at
// construction so it does not move during a test.
//
// It exists because the pinned newClock() is only a MEANINGFUL disagreement
// with Postgres for as long as the calendar keeps it one, and a test whose
// premise expires on a date is a test that turns red for a reason nobody
// present caused. Skew is stated as a duration and is therefore the same
// disagreement on every day this suite will ever run.
func newSkewedClock(skew time.Duration) *clock {
	return &clock{t: time.Now().UTC().Add(skew)}
}

// Nothing about a tombstone may depend on Postgres agreeing with ledgerd about
// what time it is.
//
// This is the whole point of 00021's design and it was not true: the trigger
// swept `expires_at < now() - interval '30 days'` on POSTGRES's clock over
// rows whose expires_at came from Sessions', and — because the sweep ran after
// the INSERT in the same invocation — it destroyed the row it had just
// written. A session live by the clock that decides then answered 401, and the
// device wiped nothing because Task 13's mayWipeLocalData requires 410 AND
// account_deleted precisely so a bare 401 never wipes.
//
// Skew is not hypothetical: ledgerd and Postgres share a box today, which is
// an accident of deployment, not a property of the system. A relay, a second
// host, a VM resume or an NTP correction ends it.
func TestATombstoneOutlivesADisagreementBetweenTheGoAndPostgresClocks(t *testing.T) {
	for _, tc := range []struct {
		name string
		skew time.Duration
	}{
		{"ledgerd 31 days behind postgres", -31 * 24 * time.Hour},
		{"ledgerd 90 days behind postgres", -90 * 24 * time.Hour},
		{"ledgerd 90 days ahead of postgres", 90 * 24 * time.Hour},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := pgtest.New(t)
			u := mustUpsert(t, pool, appleIdentity("sub-skew"))
			c := newSkewedClock(tc.skew)
			s := newSessions(pool, time.Hour, c)

			tok, err := s.Issue(bgctx, u)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
				t.Fatal(err)
			}

			var rows int
			if err := pool.QueryRow(bgctx, `SELECT count(*) FROM deleted_account_sessions`).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows != 1 {
				t.Fatalf("%d tombstones, want 1: a second clock decided this row's fate", rows)
			}
			if _, err := s.Resolve(bgctx, tok); !errors.Is(err, ErrSessionAccountDeleted) {
				t.Fatalf("err = %v, want ErrSessionAccountDeleted: the session is live by the clock that decides", err)
			}
		})
	}
}

// Deleting one account must not reap another account's tombstone. Two, not
// one: a fixture with a single deletion cannot tell "the sweep left my row
// alone" from "the sweep did not run at all this time".
//
// The clock is skewed so that a sweep on Postgres's clock would consider both
// rows ancient. Without the fix the second DELETE takes the first device's
// tombstone with it, and that device — signed in, its account deleted — sees a
// 401 for ever.
func TestDeletingOneAccountDoesNotReapAnotherAccountsTombstone(t *testing.T) {
	pool := pgtest.New(t)
	c := newSkewedClock(-90 * 24 * time.Hour)
	s := newSessions(pool, time.Hour, c)

	first := mustUpsert(t, pool, appleIdentity("sub-reap-first"))
	firstTok, err := s.Issue(bgctx, first)
	if err != nil {
		t.Fatal(err)
	}
	second := mustUpsert(t, pool, appleIdentity("sub-reap-second"))
	if _, err := s.Issue(bgctx, second); err != nil {
		t.Fatal(err)
	}

	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, first); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, second); err != nil {
		t.Fatal(err)
	}

	var rows int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM deleted_account_sessions`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 2 {
		t.Fatalf("%d tombstones, want 2: deleting one account reaped another's", rows)
	}
	if _, err := s.Resolve(bgctx, firstTok); !errors.Is(err, ErrSessionAccountDeleted) {
		t.Fatalf("err = %v, want ErrSessionAccountDeleted for the FIRST account's device", err)
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

// ---------------------------------------------------------------------------
// Retention: the sweep that used to live in the trigger
// ---------------------------------------------------------------------------

// The sweep is measured in BOTH directions, over three rows that differ only in
// when their session expired, and the run is arranged so that a sweep on
// POSTGRES's clock could not produce this outcome.
//
// Three, not one. A fixture with a single tombstone cannot distinguish "reaped
// the row that was past its grace" from "reaped whatever it found", and the
// aggressive direction is the dangerous one: a row deleted early is a device
// that is told 401 for an account that was deleted, which Task 13's
// mayWipeLocalData deliberately refuses to wipe on.
//
//	A  expired long before now() - tombstoneGrace   → must go
//	B  expired an hour ago, well inside the grace   → must stay
//	C  still live                                   → must stay, and must still answer 410
//
// The clock is 90 days AHEAD of wall time, which is what makes this a
// measurement of the clock rather than of the arithmetic: every one of these
// rows carries an expires_at in Postgres's future, so the pre-flight assertion
// below records that a Postgres-clock sweep would reap NOTHING here. The only
// way to reap exactly A is to judge on the clock that issued the sessions.
func TestReapingTombstonesUsesTheSessionsClockAndSparesRowsInsideTheGrace(t *testing.T) {
	pool := pgtest.New(t)
	c := newSkewedClock(90 * 24 * time.Hour)
	s := newSessions(pool, time.Hour, c)

	// A, at T0: expires T0+1h.
	uA := mustUpsert(t, pool, appleIdentity("sub-reap-ancient"))
	tokA, err := s.Issue(bgctx, uA)
	if err != nil {
		t.Fatal(err)
	}

	// B, a whole grace period later: expires T0+grace+3h.
	c.advance(tombstoneGrace + 2*time.Hour)
	uB := mustUpsert(t, pool, appleIdentity("sub-reap-recent"))
	tokB, err := s.Issue(bgctx, uB)
	if err != nil {
		t.Fatal(err)
	}

	// Two hours on: B died an hour ago, A died a grace period and three hours
	// ago, and C is issued live.
	c.advance(2 * time.Hour)
	uC := mustUpsert(t, pool, appleIdentity("sub-reap-live"))
	tokC, err := s.Issue(bgctx, uC)
	if err != nil {
		t.Fatal(err)
	}

	for _, u := range []uuid.UUID{uA, uB, uC} {
		if _, err := pool.Exec(bgctx, `DELETE FROM users WHERE id = $1`, u); err != nil {
			t.Fatal(err)
		}
	}
	if got := countTombstones(t, pool); got != 3 {
		t.Fatalf("%d tombstones before the sweep, want 3", got)
	}

	// The premise, measured rather than assumed: on Postgres's clock there is
	// nothing here to reap, so an implementation that used `now()` could only
	// score 0 below. This is the assertion that stops the test passing for the
	// wrong reason.
	var postgresWouldReap int
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM deleted_account_sessions WHERE expires_at < now() - interval '30 days'`,
	).Scan(&postgresWouldReap); err != nil {
		t.Fatal(err)
	}
	if postgresWouldReap != 0 {
		t.Fatalf("a Postgres-clock sweep would reap %d of these rows; this run cannot tell the "+
			"two clocks apart", postgresWouldReap)
	}

	n, err := s.ReapDeletedAccountTombstones(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("reaped %d rows, want exactly 1 (only A is past its grace)", n)
	}

	if tombstoneExists(t, pool, tokA) {
		t.Fatal("A's tombstone survived: the table is not bounded at all")
	}
	if !tombstoneExists(t, pool, tokB) {
		t.Fatal("B's tombstone was reaped an hour after its session expired: the grace is not honoured")
	}
	if !tombstoneExists(t, pool, tokC) {
		t.Fatal("C's tombstone was reaped while its session is still LIVE: a deleted account now " +
			"answers 401, which is the answer a device must not wipe on")
	}
	if _, err := s.Resolve(bgctx, tokC); !errors.Is(err, ErrSessionAccountDeleted) {
		t.Fatalf("err = %v, want ErrSessionAccountDeleted: the sweep broke the row that still answers", err)
	}

	// Idempotent: with nothing left past its grace, a second pass takes nothing.
	// A sweep that ate one row per run would drain the table over a few hours
	// of ticks and the first assertion above would never see it.
	again, err := s.ReapDeletedAccountTombstones(bgctx)
	if err != nil {
		t.Fatal(err)
	}
	if again != 0 {
		t.Fatalf("a second sweep reaped %d more rows, want 0", again)
	}
	if got := countTombstones(t, pool); got != 2 {
		t.Fatalf("%d tombstones after two sweeps, want 2", got)
	}
}

// A row is only reapable once it is past its expiry AND past the grace, and the
// grace is a real, finite, non-zero window. A zero grace would reap on the same
// instant deletedOrUnknown stops answering, which is defensible — and is not
// what the table, the migration or the runbook say.
func TestTheTombstoneGraceIsAFiniteWindowPastExpiry(t *testing.T) {
	if tombstoneGrace <= 0 {
		t.Fatalf("tombstoneGrace = %v: the sweep would reap rows the moment they expire", tombstoneGrace)
	}
	if tombstoneGrace > 365*24*time.Hour {
		t.Fatalf("tombstoneGrace = %v: a bound this loose does not bound the table", tombstoneGrace)
	}
}

func countTombstones(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx, `SELECT count(*) FROM deleted_account_sessions`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func tombstoneExists(t *testing.T, pool *pgxpool.Pool, token string) bool {
	t.Helper()
	var n int
	if err := pool.QueryRow(bgctx,
		`SELECT count(*) FROM deleted_account_sessions WHERE token_hash = $1`,
		tokenHash(token)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}
