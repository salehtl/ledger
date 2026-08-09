package pg_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/pg"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

func TestMigrationsCreateUsersAndSessions(t *testing.T) {
	pool := pgtest.New(t)
	ctx := context.Background()
	var n int
	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM information_schema.tables
		  WHERE table_schema='public' AND table_name IN ('users','sessions')`).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected users+sessions tables, found %d", n)
	}
}

func TestEachTestGetsAnIsolatedDatabase(t *testing.T) {
	ctx := context.Background()
	a, b := pgtest.New(t), pgtest.New(t)
	if _, err := a.Exec(ctx, `INSERT INTO users (id, idp, idp_sub_hash, created_at)
		VALUES (gen_random_uuid(), 'apple', '\x00'::bytea, now())`); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := b.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("databases are not isolated: second pool sees %d users", n)
	}
}

func TestMigrationsAreReversible(t *testing.T) {
	// goose's Down path is dead code unless something runs it; a broken Down
	// block is only discovered during an emergency rollback otherwise.
	pool := pgtest.New(t)
	ctx := context.Background()
	if err := pg.MigrateDown(ctx, pool); err != nil {
		t.Fatalf("down: %v", err)
	}
	var n int
	pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
	                     WHERE table_schema='public' AND table_name='users'`).Scan(&n)
	if n != 0 {
		t.Fatal("Down left the users table behind")
	}
	if err := pg.Migrate(ctx, pool); err != nil {
		t.Fatalf("re-up: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Per-account isolation schema (00030-00032)
// ---------------------------------------------------------------------------

// atVersion returns a pool migrated to exactly version, so a test can seed the
// rows a later migration is supposed to read.
func atVersion(t *testing.T, version int64) *pgxpool.Pool {
	t.Helper()
	pool := pgtest.New(t)
	ctx := context.Background()
	if err := pg.MigrateDown(ctx, pool); err != nil {
		t.Fatalf("down: %v", err)
	}
	if err := pg.MigrateTo(ctx, pool, version); err != nil {
		t.Fatalf("up to %d: %v", version, err)
	}
	return pool
}

func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
}

// wantsError runs a statement that MUST be refused. A test that only asserts
// the happy path cannot tell a constraint from a comment.
func wantsError(t *testing.T, pool *pgxpool.Pool, what, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err == nil {
		t.Fatalf("%s: statement was accepted, expected a refusal", what)
	}
}

func newTestUser(t *testing.T, pool *pgxpool.Pool, sub string) uuid.UUID {
	t.Helper()
	sum := sha256.Sum256([]byte(sub))
	var u uuid.UUID
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO users (idp, idp_sub_hash, created_at) VALUES ('apple', $1, now()) RETURNING id`,
		sum[:]).Scan(&u); err != nil {
		t.Fatalf("create user %q: %v", sub, err)
	}
	return u
}

func usage(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, resource string) int64 {
	t.Helper()
	var n int64
	err := pool.QueryRow(context.Background(),
		`SELECT amount FROM account_usage WHERE user_id = $1 AND resource = $2`, u, resource).Scan(&n)
	if err != nil {
		t.Fatalf("read %s for %s: %v", resource, u, err)
	}
	return n
}

// TestTheUsageLedgerIsBackfilledFromExistingRows is the test the whole
// MigrateTo helper exists for. A ledger that starts at zero on a box that
// already holds data hands every existing account its entire budget a second
// time, and the failure is invisible: nothing about a zero row looks wrong.
func TestTheUsageLedgerIsBackfilledFromExistingRows(t *testing.T) {
	pool := atVersion(t, 30)
	ctx := context.Background()

	// Two accounts, so the backfill has to attribute rather than total.
	loud := newTestUser(t, pool, "loud")
	quiet := newTestUser(t, pool, "quiet")
	empty := newTestUser(t, pool, "empty") // no op log, no quarantine at all

	mustExec(t, pool, `INSERT INTO oplog_seq (user_id, next_seq) VALUES ($1, 1), ($2, 1), ($3, 1)`,
		loud, quiet, empty)

	// Deliberately uneven: two hot blobs and one cold for `loud`, one hot for
	// `quiet`. Hand-computed below rather than re-derived with the same SQL the
	// migration uses, which would only prove the query equals itself.
	appendOp := func(u uuid.UUID, seq int, stream string, size int) {
		mustExec(t, pool, `INSERT INTO op_log
		  (user_id, seq, stream, writer_id, writer_counter, type_flag,
		   blob, size_bucket, blob_hash, prev_hash)
		  VALUES ($1, $2, $3, 'w1', $2, 'ingest', $4, $5, $6, $7)`,
			u, seq, stream, make([]byte, size), size, make([]byte, 32), make([]byte, 32))
	}
	appendOp(loud, 1, "hot", 1024)
	appendOp(loud, 2, "hot", 4096)
	appendOp(loud, 3, "cold", 65536)
	appendOp(quiet, 1, "hot", 1024)

	hold := func(u uuid.UUID, body []byte) {
		mustExec(t, pool, `INSERT INTO quarantine
		  (user_id, ingest_id, received_at, expires_at, outer_domain, dkim, arc, size_bucket, blob)
		  VALUES ($1, $2, now(), now() + interval '30 days', 'dib.ae', 'pass', 'none', 1024, $3)`,
			u, sha256sum(body), body)
	}
	hold(loud, []byte("held one"))   // 8 bytes
	hold(loud, []byte("held two !")) // 10 bytes

	if err := pg.MigrateTo(ctx, pool, 31); err != nil {
		t.Fatalf("up to 31: %v", err)
	}

	for _, c := range []struct {
		u        uuid.UUID
		who      string
		resource string
		want     int64
	}{
		{loud, "loud", "oplog_hot_bytes", 1024 + 4096},
		{loud, "loud", "oplog_cold_bytes", 65536},
		{loud, "loud", "quarantine_bytes", 8 + 10},
		{loud, "loud", "quarantine_count", 2},
		{quiet, "quiet", "oplog_hot_bytes", 1024},
		{quiet, "quiet", "oplog_cold_bytes", 0},
		{quiet, "quiet", "quarantine_bytes", 0},
		{quiet, "quiet", "quarantine_count", 0},
		// An account with nothing still gets all four rows: an absent row and a
		// zero row must mean the same thing, or admission has to decide what a
		// missing row implies.
		{empty, "empty", "oplog_hot_bytes", 0},
		{empty, "empty", "oplog_cold_bytes", 0},
		{empty, "empty", "quarantine_bytes", 0},
		{empty, "empty", "quarantine_count", 0},
	} {
		if got := usage(t, pool, c.u, c.resource); got != c.want {
			t.Errorf("%s %s = %d, want %d", c.who, c.resource, got, c.want)
		}
	}

	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM account_usage`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 12 {
		t.Errorf("account_usage holds %d rows, want 12 (3 accounts x 4 resources)", rows)
	}
}

// TestTheUsageLedgerRefusesANegativeAmount pins the CHECK. Three paths
// decrement, and a decrement bigger than the balance means the ledger has
// already lost track; without the constraint that becomes free quota instead of
// an error somebody sees.
func TestTheUsageLedgerRefusesANegativeAmount(t *testing.T) {
	pool := pgtest.New(t)
	u := newTestUser(t, pool, "over-decrement")
	mustExec(t, pool, `INSERT INTO account_usage (user_id, resource, amount)
	                   VALUES ($1, 'oplog_hot_bytes', 100)`, u)
	wantsError(t, pool, "decrement below zero",
		`UPDATE account_usage SET amount = amount - 101 WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`, u)
	wantsError(t, pool, "insert a negative balance",
		`INSERT INTO account_usage (user_id, resource, amount) VALUES ($1, 'quarantine_count', -1)`, u)
	wantsError(t, pool, "an unknown resource",
		`INSERT INTO account_usage (user_id, resource, amount) VALUES ($1, 'disk_bytes', 1)`, u)
	if got := usage(t, pool, u, "oplog_hot_bytes"); got != 100 {
		t.Fatalf("balance is %d after the refused statements, want 100", got)
	}
}

// TestTheDefaultLimitPolicyIsPresentAndPermanent covers the row every account
// without an override depends on. Its absence leaves Admit with nothing to
// compare against, and both ways of handling that are bad in opposite
// directions.
func TestTheDefaultLimitPolicyIsPresentAndPermanent(t *testing.T) {
	pool := pgtest.New(t)
	ctx := context.Background()
	var oplog, qbytes, qcount int64
	err := pool.QueryRow(ctx, `SELECT oplog_bytes, quarantine_bytes, quarantine_count
	                             FROM account_limits WHERE user_id IS NULL`).Scan(&oplog, &qbytes, &qcount)
	if err != nil {
		t.Fatalf("read the default policy: %v", err)
	}
	// The design's beta ceilings, in binary megabytes.
	if oplog != 256*1024*1024 || qbytes != 100*1024*1024 || qcount != 500 {
		t.Errorf("default policy is (%d, %d, %d), want (%d, %d, 500)",
			oplog, qbytes, qcount, 256*1024*1024, 100*1024*1024)
	}
	wantsError(t, pool, "deleting the default policy",
		`DELETE FROM account_limits WHERE user_id IS NULL`)
	wantsError(t, pool, "a second default policy",
		`INSERT INTO account_limits (user_id, oplog_bytes, quarantine_bytes, quarantine_count)
		 VALUES (NULL, 1, 1, 1)`)

	// An override is one row per account, and updating the default is expected.
	u := newTestUser(t, pool, "override")
	mustExec(t, pool, `INSERT INTO account_limits (user_id, oplog_bytes, quarantine_bytes, quarantine_count)
	                   VALUES ($1, 1, 2, 3)`, u)
	wantsError(t, pool, "a second override for one account",
		`INSERT INTO account_limits (user_id, oplog_bytes, quarantine_bytes, quarantine_count)
		 VALUES ($1, 4, 5, 6)`, u)
	mustExec(t, pool, `UPDATE account_limits SET oplog_bytes = 1 WHERE user_id IS NULL`)

	// The lookup the admission gate performs: the override wins, and an account
	// without one falls through to the default.
	var got int64
	if err := pool.QueryRow(ctx, `SELECT oplog_bytes FROM account_limits
	                               WHERE user_id = $1 OR user_id IS NULL
	                               ORDER BY user_id NULLS LAST LIMIT 1`, u).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != 1 {
		t.Errorf("override lookup returned %d, want the account's own 1", got)
	}
}

// TestTheRefusalAggregateHoldsCountsAndNothingElse is a schema-shape assertion
// on purpose. "Counts only, no sender and no content" is a privacy promise, and
// the way it gets broken is a later task adding one helpful column.
func TestTheRefusalAggregateHoldsCountsAndNothingElse(t *testing.T) {
	pool := pgtest.New(t)
	rows, err := pool.Query(context.Background(),
		`SELECT attname FROM pg_attribute
		  WHERE attrelid = 'public.account_refusals'::regclass AND attnum > 0 AND NOT attisdropped
		  ORDER BY attnum`)
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
	want := []string{"user_id", "day", "resource", "count"}
	if !slices.Equal(cols, want) {
		t.Fatalf("account_refusals columns are %v, want exactly %v — a refusal record "+
			"carries no sender, no address and no content", cols, want)
	}

	u := newTestUser(t, pool, "refused")
	mustExec(t, pool, `INSERT INTO account_refusals (user_id, day, resource, count)
	                   VALUES ($1, current_date, 'oplog_hot_bytes', 1)
	                   ON CONFLICT (user_id, day, resource) DO UPDATE SET count = account_refusals.count + 1`, u)
	wantsError(t, pool, "a refusal reason nothing can produce",
		`INSERT INTO account_refusals (user_id, day, resource, count)
		 VALUES ($1, current_date, 'because', 1)`, u)
}

// TestAccountStatusIsActiveOrSuspended covers P3's one column, including the
// default that every existing row was backfilled with.
func TestAccountStatusIsActiveOrSuspended(t *testing.T) {
	pool := pgtest.New(t)
	u := newTestUser(t, pool, "status")
	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM users WHERE id = $1`, u).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" {
		t.Fatalf("a new account is %q, want active", status)
	}
	mustExec(t, pool, `UPDATE users SET status = 'suspended' WHERE id = $1`, u)
	wantsError(t, pool, "a third status",
		`UPDATE users SET status = 'deleted' WHERE id = $1`, u)
	wantsError(t, pool, "no status at all",
		`UPDATE users SET status = NULL WHERE id = $1`, u)
}

// TestThePersistedSMTPCounterKeepsTheRollingWindowState pins the columns that
// make persistence faithful rather than a summary: the limiter's counter is
// (start, cur, prev) under a window, and all four are stored.
func TestThePersistedSMTPCounterKeepsTheRollingWindowState(t *testing.T) {
	pool := pgtest.New(t)
	u := newTestUser(t, pool, "smtp")
	mustExec(t, pool, `INSERT INTO smtp_user_counters
	  (user_id, kind, reason, window_seconds, window_start, cur, prev)
	  VALUES ($1, 'messages', '', 86400, now(), 7, 3)`, u)
	mustExec(t, pool, `INSERT INTO smtp_user_counters
	  (user_id, kind, reason, window_seconds, window_start, cur, prev)
	  VALUES ($1, 'notice', 'over_quota', 86400, now(), 2, 0)`, u)

	// The key shapes that would be read back into nothing, or would shadow the
	// row that should have been read.
	wantsError(t, pool, "a messages row with a reason",
		`INSERT INTO smtp_user_counters (user_id, kind, reason, window_seconds, window_start, cur, prev)
		 VALUES ($1, 'messages', 'over_quota', 86400, now(), 1, 0)`, u)
	wantsError(t, pool, "a notice row with no reason",
		`INSERT INTO smtp_user_counters (user_id, kind, reason, window_seconds, window_start, cur, prev)
		 VALUES ($1, 'notice', '', 86400, now(), 1, 0)`, u)
	wantsError(t, pool, "a second row for one counter",
		`INSERT INTO smtp_user_counters (user_id, kind, reason, window_seconds, window_start, cur, prev)
		 VALUES ($1, 'messages', '', 86400, now(), 1, 0)`, u)
	wantsError(t, pool, "a zero window",
		`INSERT INTO smtp_user_counters (user_id, kind, reason, window_seconds, window_start, cur, prev)
		 VALUES ($1, 'notice', 'too_large', 0, now(), 1, 0)`, u)
	wantsError(t, pool, "a count above the limiter's ceiling",
		`INSERT INTO smtp_user_counters (user_id, kind, reason, window_seconds, window_start, cur, prev)
		 VALUES ($1, 'notice', 'too_large', 86400, now(), 1073741825, 0)`, u)
	wantsError(t, pool, "a negative count",
		`INSERT INTO smtp_user_counters (user_id, kind, reason, window_seconds, window_start, cur, prev)
		 VALUES ($1, 'notice', 'too_large', 86400, now(), -1, 0)`, u)

	// The restore read: the whole state of one counter, in one row.
	var window int
	var start time.Time
	var cur, prev int64
	if err := pool.QueryRow(context.Background(),
		`SELECT window_seconds, window_start, cur, prev FROM smtp_user_counters
		  WHERE user_id = $1 AND kind = 'messages' AND reason = ''`, u).
		Scan(&window, &start, &cur, &prev); err != nil {
		t.Fatal(err)
	}
	if window != 86400 || cur != 7 || prev != 3 || start.IsZero() {
		t.Fatalf("restored state is (window %d, start %v, cur %d, prev %d)", window, start, cur, prev)
	}
}

// TestTheNewIsolationTablesAreGrantedToTheRuntimeRole exercises the GRANT block
// that never fires in an ordinary test run — pgtest has no ledger_runtime, so
// the DO block is a no-op and a missing grant would only surface in production.
// Creating the role and re-running the migrations is the only way to see it.
func TestTheNewIsolationTablesAreGrantedToTheRuntimeRole(t *testing.T) {
	pool := pgtest.New(t)
	ctx := context.Background()
	if err := pg.MigrateDown(ctx, pool); err != nil {
		t.Fatalf("down: %v", err)
	}
	// NOLOGIN: this role is never connected as here, only granted to.
	mustExec(t, pool, `CREATE ROLE ledger_runtime NOLOGIN`)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DROP OWNED BY ledger_runtime`)
		_, _ = pool.Exec(context.Background(), `DROP ROLE IF EXISTS ledger_runtime`)
	})
	if err := pg.Migrate(ctx, pool); err != nil {
		t.Fatalf("re-up: %v", err)
	}
	for _, table := range []string{"account_usage", "account_limits", "account_refusals", "smtp_user_counters"} {
		for _, priv := range []string{"SELECT", "INSERT", "UPDATE", "DELETE"} {
			var ok bool
			if err := pool.QueryRow(ctx,
				`SELECT has_table_privilege('ledger_runtime', $1, $2)`, table, priv).Scan(&ok); err != nil {
				t.Fatal(err)
			}
			if !ok {
				t.Errorf("ledger_runtime has no %s on %s: this fails ONLY in production, "+
					"on the first write after deploy", priv, table)
			}
		}
	}
}

func sha256sum(b []byte) []byte {
	sum := sha256.Sum256(b)
	return sum[:]
}

func TestParallelMigrationsDoNotRaceOnGooseGlobals(t *testing.T) {
	// goose.SetDialect/SetBaseFS mutate unsynchronized package-level state
	// (dialect.go, goose.go in the vendored source) that pg.Migrate calls on
	// every invocation. Nothing else in this suite runs concurrently, so a
	// missing mutex around that state would sit unnoticed until the first
	// t.Parallel() test anywhere in the ~20 v2 packages this harness exists
	// to serve — this test exists to be that first one, under `go test -race`.
	for i := 0; i < 8; i++ {
		t.Run(fmt.Sprintf("db%d", i), func(t *testing.T) {
			t.Parallel()
			pool := pgtest.New(t) // New -> pg.Migrate, called concurrently across subtests
			ctx := context.Background()
			var n int
			if err := pool.QueryRow(ctx,
				`SELECT count(*) FROM information_schema.tables
				  WHERE table_schema='public' AND table_name IN ('users','sessions')`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n != 2 {
				t.Fatalf("expected users+sessions tables, found %d", n)
			}
		})
	}
}
