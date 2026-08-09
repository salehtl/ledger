package oplog

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/budget"
	"ledger/internal/v2/pgtest"
)

// These tests cover the placement the design calls non-negotiable: the
// cumulative ceiling lives INSIDE the append path, so it covers AppendClient
// and AppendIngest alike. A check at POST /api/v1/sync would miss the ingest
// writer entirely — the path that stores a whole raw email body.

func ledger(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, resource string) int64 {
	t.Helper()
	amount, err := budget.New(pool).Usage(bg, u, resource)
	if err != nil {
		t.Fatal(err)
	}
	return amount
}

// storedBytes is what the ledger is supposed to equal: exactly what
// 00031's backfill and internal/v2/verify's reconciliation compute.
func storedBytes(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, stream string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(bg,
		`SELECT coalesce(sum(octet_length(blob)), 0) FROM op_log WHERE user_id = $1 AND stream = $2`,
		u, stream).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func setOplogCeiling(t *testing.T, pool *pgxpool.Pool, bytes int64) {
	t.Helper()
	if _, err := pool.Exec(bg,
		`UPDATE account_limits SET oplog_bytes = $1 WHERE user_id IS NULL`, bytes); err != nil {
		t.Fatal(err)
	}
}

func refusalCount(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, resource string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(bg,
		`SELECT coalesce(sum(count), 0) FROM account_refusals WHERE user_id = $1 AND resource = $2`,
		u, resource).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAppendClientChargesTheAccountForTheBytesItStored(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u := insertUser(t, pool)

	var prev [32]byte
	r1, h1 := mustSeal(t, u, "dev-a", blob.StreamHot, 1, prev)
	r1.TypeFlag = TypeFlagEdit
	r2, _ := mustSeal(t, u, "dev-a", blob.StreamHot, 2, h1)
	r2.TypeFlag = TypeFlagEdit
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, []Row{r1, r2}); err != nil {
		t.Fatal(err)
	}
	want := storedBytes(t, pool, u, blob.StreamHot)
	if want == 0 {
		t.Fatal("nothing was stored, so this test proves nothing")
	}
	if got := ledger(t, pool, u, budget.ResourceOplogHotBytes); got != want {
		t.Fatalf("hot ledger = %d, stored = %d", got, want)
	}
	if got := ledger(t, pool, u, budget.ResourceOplogColdBytes); got != 0 {
		t.Fatalf("cold ledger = %d, want 0", got)
	}
}

// TestAppendIngestIsBudgetedToo is the reason the gate is in appendTx. Ingest
// never passes through handleUpload: a per-upload ceiling would leave this path
// — one hot op plus a raw body up to a megabyte — entirely unaccounted.
func TestAppendIngestIsBudgetedToo(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u := insertUser(t, pool)

	if _, err := a.AppendIngest(bg, u, []IngestBlob{
		{Stream: blob.StreamHot, Plaintext: []byte(`{"t":"txn"}`)},
		{Stream: blob.StreamCold, Plaintext: []byte("From: bank\r\n\r\nyou spent money")},
	}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		stream   string
		resource string
	}{
		{blob.StreamHot, budget.ResourceOplogHotBytes},
		{blob.StreamCold, budget.ResourceOplogColdBytes},
	} {
		want := storedBytes(t, pool, u, c.stream)
		if want == 0 {
			t.Fatalf("no %s bytes were stored, so this test proves nothing", c.stream)
		}
		if got := ledger(t, pool, u, c.resource); got != want {
			t.Fatalf("%s ledger = %d, stored = %d", c.resource, got, want)
		}
	}
}

// TestAppendIngestIsRefusedAtTheCeiling: the same path, over budget. Nothing is
// stored, the seq counter is restored, and the refusal is counted.
func TestAppendIngestIsRefusedAtTheCeiling(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u := insertUser(t, pool)
	setOplogCeiling(t, pool, 1)

	_, err := a.AppendIngest(bg, u, []IngestBlob{
		{Stream: blob.StreamHot, Plaintext: []byte(`{"t":"txn"}`)},
		{Stream: blob.StreamCold, Plaintext: []byte("From: bank\r\n\r\nyou spent money")},
	})
	if !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("append ingest over the ceiling = %v, want budget.ErrRefused", err)
	}
	if got := storedBytes(t, pool, u, blob.StreamCold) + storedBytes(t, pool, u, blob.StreamHot); got != 0 {
		t.Fatalf("a refused append stored %d bytes", got)
	}
	// The rollback restores the counter, so the refusal costs no seq.
	var next int64
	if err := pool.QueryRow(bg, `SELECT next_seq FROM oplog_seq WHERE user_id = $1`, u).Scan(&next); err != nil {
		t.Fatal(err)
	}
	if next != 1 {
		t.Fatalf("next_seq = %d after a refused append, want 1", next)
	}
	// Cold sorts before hot, so cold is charged first and is the one refused.
	if got := refusalCount(t, pool, u, budget.ResourceOplogColdBytes); got != 1 {
		t.Fatalf("cold refusals = %d, want 1", got)
	}
	if got := ledger(t, pool, u, budget.ResourceOplogHotBytes); got != 0 {
		t.Fatalf("hot ledger = %d after a refused append, want 0", got)
	}
}

func TestAppendClientIsRefusedAtTheCeiling(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u := insertUser(t, pool)
	setOplogCeiling(t, pool, 1)

	var prev [32]byte
	r1, _ := mustSeal(t, u, "dev-a", blob.StreamHot, 1, prev)
	r1.TypeFlag = TypeFlagEdit
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, []Row{r1})
	if !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("append client over the ceiling = %v, want budget.ErrRefused", err)
	}
	if got := storedBytes(t, pool, u, blob.StreamHot); got != 0 {
		t.Fatalf("a refused append stored %d bytes", got)
	}
	if got := refusalCount(t, pool, u, budget.ResourceOplogHotBytes); got != 1 {
		t.Fatalf("hot refusals = %d, want 1", got)
	}
}

// TestTheLedgerIsUnchangedAfterARolledBackAppend is the case that makes
// transactional co-location worth the trouble. The second append reaches the
// gate, is charged, and then dies on the unique (writer, stream, counter)
// index — so the bytes never landed and the number that counts them must not
// have either.
//
// If Admit ran on its own connection instead of the caller's transaction, the
// ledger would read double here and every failed append would leak budget until
// an honest account was locked out of its own log.
func TestTheLedgerIsUnchangedAfterARolledBackAppend(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u := insertUser(t, pool)

	var prev [32]byte
	r1, _ := mustSeal(t, u, "dev-a", blob.StreamHot, 1, prev)
	if _, err := a.appendRaw(bg, []Row{r1}); err != nil {
		t.Fatal(err)
	}
	before := ledger(t, pool, u, budget.ResourceOplogHotBytes)
	if before == 0 {
		t.Fatal("the first append charged nothing, so this test proves nothing")
	}

	// The identical row again: position (dev-a, hot, 1) is taken, so the INSERT
	// fails AFTER the gate has already charged the account inside that same
	// transaction.
	r2, _ := mustSeal(t, u, "dev-a", blob.StreamHot, 1, prev)
	if _, err := a.appendRaw(bg, []Row{r2}); err == nil {
		t.Fatal("re-appending a taken position succeeded")
	}
	if got := ledger(t, pool, u, budget.ResourceOplogHotBytes); got != before {
		t.Fatalf("ledger = %d after a rolled-back append, want %d — the charge outlived its rollback", got, before)
	}
	if got := storedBytes(t, pool, u, blob.StreamHot); got != before {
		t.Fatalf("stored bytes = %d, ledger = %d: the two have drifted", got, before)
	}
}

// TestConcurrentAppendsFromOneAccountSerializeWithoutDeadlock. The gate runs
// after allocSeq, so these are already serialized on the counter row before
// they reach the usage row — one lock, one order, no deadlock, and every byte
// counted exactly once.
func TestConcurrentAppendsFromOneAccountSerializeWithoutDeadlock(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u := insertUser(t, pool)

	const n = 16
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = a.AppendIngest(bg, u, []IngestBlob{
				{Stream: blob.StreamHot, Plaintext: []byte(`{"t":"txn"}`)},
				{Stream: blob.StreamCold, Plaintext: []byte("From: bank\r\n\r\nspent")},
			})
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent append %d: %v", i, err)
		}
	}
	for _, c := range []struct{ stream, resource string }{
		{blob.StreamHot, budget.ResourceOplogHotBytes},
		{blob.StreamCold, budget.ResourceOplogColdBytes},
	} {
		want := storedBytes(t, pool, u, c.stream)
		if got := ledger(t, pool, u, c.resource); got != want {
			t.Fatalf("%s ledger = %d, stored = %d after %d concurrent appends", c.resource, got, want, n)
		}
	}
}

// TestOneAccountsHeldUsageRowDoesNotBlockAnother pins the isolation claim
// itself: the gate locks rows keyed by account, never anything shared. The
// same-account half of the test is what stops the other half from being
// vacuous — if the lock were not being taken at all, both would pass.
func TestOneAccountsHeldUsageRowDoesNotBlockAnother(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	busy := insertUser(t, pool)
	other := insertUser(t, pool)

	// Hold busy's usage rows for the duration, exactly as an in-flight append
	// would.
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)
	if err := budget.New(pool).Admit(bg, tx, busy, budget.ResourceOplogHotBytes, 1); err != nil {
		t.Fatal(err)
	}

	// A different account is untouched by that lock.
	freeCtx, cancel := context.WithTimeout(bg, 15*time.Second)
	defer cancel()
	if _, err := a.AppendIngest(freeCtx, other, []IngestBlob{
		{Stream: blob.StreamHot, Plaintext: []byte(`{"t":"txn"}`)},
	}); err != nil {
		t.Fatalf("an append for a different account was blocked: %v", err)
	}

	// The same account waits, which is what proves the lock is real.
	sameCtx, cancelSame := context.WithTimeout(bg, 2*time.Second)
	defer cancelSame()
	_, err = a.AppendIngest(sameCtx, busy, []IngestBlob{
		{Stream: blob.StreamHot, Plaintext: []byte(`{"t":"txn"}`)},
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("an append for the account whose usage row is held = %v, want it to block until the deadline", err)
	}
}
