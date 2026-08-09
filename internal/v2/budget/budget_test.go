package budget

import (
	"context"
	"crypto/rand"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

func newUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	sub := make([]byte, 32)
	if _, err := rand.Read(sub); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := pool.QueryRow(bg,
		`INSERT INTO users (idp, idp_sub_hash) VALUES ('apple', $1) RETURNING id`,
		sub).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// setDefaultLimit lowers the default policy row so a test can reach a ceiling
// with a handful of bytes instead of 256 MiB.
func setDefaultLimit(t *testing.T, pool *pgxpool.Pool, oplogBytes int64) {
	t.Helper()
	if _, err := pool.Exec(bg,
		`UPDATE account_limits SET oplog_bytes = $1 WHERE user_id IS NULL`, oplogBytes); err != nil {
		t.Fatal(err)
	}
}

// admit runs one Admit in its own transaction and commits it if it succeeded,
// which is what a real caller does.
func admit(t *testing.T, g *Gate, userID uuid.UUID, resource string, delta int64) error {
	t.Helper()
	tx, err := g.Pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)
	if err := g.Admit(bg, tx, userID, resource, delta); err != nil {
		return err
	}
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}
	return nil
}

func usage(t *testing.T, g *Gate, userID uuid.UUID, resource string) int64 {
	t.Helper()
	amount, err := g.Usage(bg, userID, resource)
	if err != nil {
		t.Fatal(err)
	}
	return amount
}

func refusals(t *testing.T, pool *pgxpool.Pool, userID uuid.UUID) map[string]int64 {
	t.Helper()
	rows, err := pool.Query(bg,
		`SELECT resource, count FROM account_refusals WHERE user_id = $1`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int64{}
	for rows.Next() {
		var res string
		var n int64
		if err := rows.Scan(&res, &n); err != nil {
			t.Fatal(err)
		}
		out[res] = n
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestAdmitDeniesAtTheCeilingAndAbove is the boundary case the design names
// explicitly: exactly at the ceiling is ADMITTED, one byte past it is refused,
// and far past it is refused the same way rather than by some other error.
func TestAdmitDeniesAtTheCeilingAndAbove(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	setDefaultLimit(t, pool, 1000)

	u := newUser(t, pool)
	if err := admit(t, g, u, ResourceOplogHotBytes, 1000); err != nil {
		t.Fatalf("exactly the ceiling must be admitted: %v", err)
	}
	if got := usage(t, g, u, ResourceOplogHotBytes); got != 1000 {
		t.Fatalf("usage after filling to the ceiling = %d, want 1000", got)
	}
	// At the ceiling: the next byte is refused.
	if err := admit(t, g, u, ResourceOplogHotBytes, 1); !errors.Is(err, ErrRefused) {
		t.Fatalf("one byte past a full account = %v, want ErrRefused", err)
	}

	// One byte over, from empty.
	over := newUser(t, pool)
	if err := admit(t, g, over, ResourceOplogHotBytes, 1001); !errors.Is(err, ErrRefused) {
		t.Fatalf("one byte over the ceiling = %v, want ErrRefused", err)
	}
	if got := usage(t, g, over, ResourceOplogHotBytes); got != 0 {
		t.Fatalf("a refused admit wrote %d bytes to the ledger, want 0", got)
	}

	// Far over.
	far := newUser(t, pool)
	err := admit(t, g, far, ResourceOplogHotBytes, 1<<30)
	if !errors.Is(err, ErrRefused) {
		t.Fatalf("far over the ceiling = %v, want ErrRefused", err)
	}
	var refused *RefusedError
	if !errors.As(err, &refused) {
		t.Fatalf("error %v does not carry a *RefusedError", err)
	}
	if refused.Limit != 1000 || refused.Have != 0 || refused.Delta != 1<<30 {
		t.Fatalf("RefusedError = %+v, want have 0, delta %d, limit 1000", refused, int64(1)<<30)
	}
}

// TestOneCeilingBoundsHotAndColdTogether pins the reading of the design's
// ceiling table that 00031 wrote down: "op log: 256 MB per account" is ONE
// number over the whole log. A per-stream ceiling would admit the second call
// here, letting an account store twice its stated budget.
func TestOneCeilingBoundsHotAndColdTogether(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	setDefaultLimit(t, pool, 1000)
	u := newUser(t, pool)

	if err := admit(t, g, u, ResourceOplogHotBytes, 600); err != nil {
		t.Fatal(err)
	}
	if err := admit(t, g, u, ResourceOplogColdBytes, 500); !errors.Is(err, ErrRefused) {
		t.Fatalf("cold 500 on top of hot 600 under a 1000 ceiling = %v, want ErrRefused", err)
	}
	if err := admit(t, g, u, ResourceOplogColdBytes, 400); err != nil {
		t.Fatalf("cold 400 on top of hot 600 under a 1000 ceiling: %v", err)
	}
	if got := usage(t, g, u, ResourceOplogColdBytes); got != 400 {
		t.Fatalf("cold usage = %d, want 400", got)
	}
}

// TestAnAccountOverrideBeatsTheDefaultRow covers the OR user_id IS NULL lookup
// in both directions: the override applies to its own account and to nobody
// else.
func TestAnAccountOverrideBeatsTheDefaultRow(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	setDefaultLimit(t, pool, 1000)
	rich := newUser(t, pool)
	poor := newUser(t, pool)
	if _, err := pool.Exec(bg,
		`INSERT INTO account_limits (user_id, oplog_bytes, quarantine_bytes, quarantine_count)
		 VALUES ($1, 5000, 100, 10)`, rich); err != nil {
		t.Fatal(err)
	}
	if err := admit(t, g, rich, ResourceOplogHotBytes, 4000); err != nil {
		t.Fatalf("the override account: %v", err)
	}
	if err := admit(t, g, poor, ResourceOplogHotBytes, 4000); !errors.Is(err, ErrRefused) {
		t.Fatalf("an account without an override = %v, want ErrRefused", err)
	}
}

// TestARefusalIsCountedOnceAndThenIncrements is the promise that nothing is
// silently dropped. It also pins the placement that makes the promise real: the
// caller's transaction is rolled back (admit's defer), so a refusal counted
// inside it would leave this table empty.
func TestARefusalIsCountedOnceAndThenIncrements(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	setDefaultLimit(t, pool, 10)
	u := newUser(t, pool)

	if err := admit(t, g, u, ResourceOplogHotBytes, 11); !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want ErrRefused", err)
	}
	if got := refusals(t, pool, u); len(got) != 1 || got[ResourceOplogHotBytes] != 1 {
		t.Fatalf("after one refusal, account_refusals = %v, want exactly {%s: 1}", got, ResourceOplogHotBytes)
	}
	if err := admit(t, g, u, ResourceOplogHotBytes, 11); !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want ErrRefused", err)
	}
	if got := refusals(t, pool, u); len(got) != 1 || got[ResourceOplogHotBytes] != 2 {
		t.Fatalf("after two refusals, account_refusals = %v, want exactly {%s: 2}", got, ResourceOplogHotBytes)
	}
	// A different resource is a different row, not the same counter.
	if err := admit(t, g, u, ResourceOplogColdBytes, 11); !errors.Is(err, ErrRefused) {
		t.Fatalf("got %v, want ErrRefused", err)
	}
	got := refusals(t, pool, u)
	if len(got) != 2 || got[ResourceOplogHotBytes] != 2 || got[ResourceOplogColdBytes] != 1 {
		t.Fatalf("account_refusals = %v, want {hot: 2, cold: 1}", got)
	}
}

// TestTheRefusalDayIsUTC pins the bucket 00031 specified. A local-time boundary
// would make "today" mean different things to the app and to a sweep.
func TestTheRefusalDayIsUTC(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	// 01:30 UTC on the 2nd is still the 1st in any negative-offset zone.
	g.now = func() time.Time {
		return time.Date(2026, 8, 2, 1, 30, 0, 0, time.UTC).In(time.FixedZone("UTC-7", -7*3600))
	}
	setDefaultLimit(t, pool, 1)
	u := newUser(t, pool)
	if err := admit(t, g, u, ResourceOplogHotBytes, 2); !errors.Is(err, ErrRefused) {
		t.Fatal(err)
	}
	var day time.Time
	if err := pool.QueryRow(bg,
		`SELECT day FROM account_refusals WHERE user_id = $1`, u).Scan(&day); err != nil {
		t.Fatal(err)
	}
	if got := day.Format("2006-01-02"); got != "2026-08-02" {
		t.Fatalf("refusal day = %s, want 2026-08-02 (UTC)", got)
	}
}

// TestAReleaseDecrementsAndCannotGoBelowZero covers the decrement paths — the
// expiry sweep, confirm-and-reingest, any future compaction — and the ledger
// bug an over-release represents.
func TestAReleaseDecrementsAndCannotGoBelowZero(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	u := newUser(t, pool)

	if err := admit(t, g, u, ResourceQuarantineBytes, 900); err != nil {
		t.Fatal(err)
	}
	if err := admit(t, g, u, ResourceQuarantineBytes, -400); err != nil {
		t.Fatalf("a release must be admitted: %v", err)
	}
	if got := usage(t, g, u, ResourceQuarantineBytes); got != 500 {
		t.Fatalf("usage after 900 - 400 = %d, want 500", got)
	}
	// Exactly to zero is legal.
	if err := admit(t, g, u, ResourceQuarantineBytes, -500); err != nil {
		t.Fatalf("a release to exactly zero must be admitted: %v", err)
	}
	if got := usage(t, g, u, ResourceQuarantineBytes); got != 0 {
		t.Fatalf("usage = %d, want 0", got)
	}
	// One below zero is not, and it changes nothing.
	err := admit(t, g, u, ResourceQuarantineBytes, -1)
	if !errors.Is(err, ErrLedgerUnderflow) {
		t.Fatalf("releasing below zero = %v, want ErrLedgerUnderflow", err)
	}
	if errors.Is(err, ErrRefused) {
		t.Fatal("an underflow is a server bug, not a user-facing refusal")
	}
	if got := usage(t, g, u, ResourceQuarantineBytes); got != 0 {
		t.Fatalf("usage after a refused release = %d, want 0", got)
	}
	if got := refusals(t, pool, u); len(got) != 0 {
		t.Fatalf("an underflow was counted as a refusal: %v", got)
	}
}

// TestAReleaseIsNeverRefusedByALoweredCeiling: an account already over its
// limit must still be able to shrink, or lowering a ceiling would strand it
// forever.
func TestAReleaseIsNeverRefusedByALoweredCeiling(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	u := newUser(t, pool)
	if err := admit(t, g, u, ResourceOplogHotBytes, 5000); err != nil {
		t.Fatal(err)
	}
	setDefaultLimit(t, pool, 100)
	if err := admit(t, g, u, ResourceOplogHotBytes, -1000); err != nil {
		t.Fatalf("release under a lowered ceiling: %v", err)
	}
	if got := usage(t, g, u, ResourceOplogHotBytes); got != 4000 {
		t.Fatalf("usage = %d, want 4000", got)
	}
}

// TestTheLedgerIsUnchangedWhenTheCallerRollsBack is the property that makes
// taking a pgx.Tx worth the trouble, at the level of this package. The
// equivalent through the real append path is in internal/v2/oplog.
func TestTheLedgerIsUnchangedWhenTheCallerRollsBack(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	u := newUser(t, pool)
	if err := admit(t, g, u, ResourceOplogHotBytes, 700); err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	if err := g.Admit(bg, tx, u, ResourceOplogHotBytes, 300); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(bg); err != nil {
		t.Fatal(err)
	}
	if got := usage(t, g, u, ResourceOplogHotBytes); got != 700 {
		t.Fatalf("usage after a rolled-back admit = %d, want 700", got)
	}
}

// TestAdmitRefusesWhatItCannotAccount is the fail-closed half. Each of these
// would otherwise be a write admitted without being counted.
func TestAdmitRefusesWhatItCannotAccount(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	u := newUser(t, pool)
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)

	if err := g.Admit(bg, tx, u, "disk_bytes", 1); err == nil {
		t.Fatal("an unknown resource was admitted")
	}
	if err := g.Admit(bg, tx, uuid.Nil, ResourceOplogHotBytes, 1); err == nil {
		t.Fatal("a zero user was admitted")
	}
	if err := g.Admit(bg, tx, u, ResourceOplogHotBytes, 0); err != nil {
		t.Fatalf("a zero delta must be a no-op, got %v", err)
	}
	poolless := &Gate{}
	if err := poolless.Admit(bg, tx, u, ResourceOplogHotBytes, 1); err == nil {
		t.Fatal("a gate with no pool admitted a write it could never have refused in writing")
	}
}

// TestConcurrentAdmitsForOneAccountAreSerialized: twenty concurrent increments
// must sum, not race. A read-then-write without the FOR UPDATE lock loses
// updates here.
func TestConcurrentAdmitsForOneAccountAreSerialized(t *testing.T) {
	pool := pgtest.New(t)
	g := New(pool)
	u := newUser(t, pool)

	const n = 20
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tx, err := pool.BeginTx(bg, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			if err != nil {
				errs[i] = err
				return
			}
			defer tx.Rollback(bg)
			if err := g.Admit(bg, tx, u, ResourceOplogHotBytes, 10); err != nil {
				errs[i] = err
				return
			}
			errs[i] = tx.Commit(bg)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent admit %d: %v", i, err)
		}
	}
	if got := usage(t, g, u, ResourceOplogHotBytes); got != n*10 {
		t.Fatalf("usage after %d concurrent +10 admits = %d, want %d", n, got, n*10)
	}
}
