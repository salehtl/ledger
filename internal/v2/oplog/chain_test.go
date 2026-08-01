package oplog

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/blob"
	"ledger/internal/v2/pgtest"
)

// sealBody is sealRow with a caller-chosen payload, so a test can put TWO
// DIFFERENT blobs at the same chain position — which is the only way to tell a
// benign replay of an already-applied batch apart from a genuine fork.
func sealBody(t *testing.T, u uuid.UUID, writerID, stream string, counter int64, prev [32]byte, body string) (Row, [32]byte) {
	t.Helper()
	env := blob.Envelope{UserID: u, Stream: stream, WriterID: writerID, WriterCounter: counter}
	s, err := blob.PlaintextSealer{}.Seal(env, []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	h := blob.Hash(prev, s)
	flag := TypeFlagEdit
	if writerID == IngestWriterID {
		flag = TypeFlagIngest
	}
	return Row{
		UserID:        u,
		Stream:        stream,
		WriterID:      writerID,
		WriterCounter: counter,
		TypeFlag:      flag,
		Blob:          s.Bytes,
		SizeBucket:    s.SizeBucket,
		BlobHash:      h[:],
		PrevHash:      prev[:],
	}, h
}

// chainFrom builds n rows continuing a (writer, stream) chain from
// (startCounter-1, prev), each sealed at its own position and linked to the one
// before it. It returns the rows and the new head hash.
func chainFrom(t *testing.T, u uuid.UUID, writerID, stream string, startCounter int64, prev [32]byte, n int) ([]Row, [32]byte) {
	t.Helper()
	out := make([]Row, 0, n)
	for i := 0; i < n; i++ {
		c := startCounter + int64(i)
		r, h := sealBody(t, u, writerID, stream, c, prev, fmt.Sprintf(`{"w":%q,"s":%q,"c":%d}`, writerID, stream, c))
		prev = h
		out = append(out, r)
	}
	return out, prev
}

// warmPool forces n connections to be established before a concurrency test
// starts. pgxpool opens lazily, so without this the "racers" stagger by however
// long a fresh connection takes and a test can pass under a broken
// implementation simply because nothing ever actually overlapped.
func warmPool(t *testing.T, pool *pgxpool.Pool, n int) {
	t.Helper()
	conns := make([]*pgxpool.Conn, 0, n)
	for i := 0; i < n; i++ {
		c, err := pool.Acquire(bg)
		if err != nil {
			t.Fatalf("warm pool: %v", err)
		}
		if err := c.Ping(bg); err != nil {
			t.Fatalf("warm pool ping: %v", err)
		}
		conns = append(conns, c)
	}
	for _, c := range conns {
		c.Release()
	}
}

// assertChainBreak insists on ErrChainBreak specifically — and, just as
// importantly, insists the error is NOT a raw unique-violation leaking out of
// the database. "Some error happened" is not the property under test: a
// constraint violation reaching the caller means the ordering rule in appendTx
// was not honoured, and it is the wrong thing to hand a client (spec §3.3:68
// makes a chain break a sync hard stop, which a duplicate-key error is not).
func assertChainBreak(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("want ErrChainBreak, got nil")
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
		t.Fatalf("the database rejected this, not the chain check: %v", err)
	}
	if !errors.Is(err, ErrChainBreak) {
		t.Fatalf("want ErrChainBreak, got %T: %v", err, err)
	}
}

func countersOf(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, writerID, stream string) []int64 {
	t.Helper()
	rows, err := pool.Query(bg,
		`SELECT writer_counter FROM op_log WHERE user_id=$1 AND writer_id=$2 AND stream=$3 ORDER BY seq`,
		u, writerID, stream)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []int64
	for rows.Next() {
		var c int64
		if err := rows.Scan(&c); err != nil {
			t.Fatal(err)
		}
		got = append(got, c)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return got
}

// storedChain reads back one (writer, stream) chain in counter order.
func storedChain(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, writerID, stream string) []Row {
	t.Helper()
	rows, err := pool.Query(bg,
		`SELECT seq, stream, writer_id, writer_counter, blob, size_bucket, blob_hash, prev_hash
		   FROM op_log WHERE user_id=$1 AND writer_id=$2 AND stream=$3 ORDER BY writer_counter`,
		u, writerID, stream)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		r := Row{UserID: u}
		if err := rows.Scan(&r.Seq, &r.Stream, &r.WriterID, &r.WriterCounter,
			&r.Blob, &r.SizeBucket, &r.BlobHash, &r.PrevHash); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// ---------------------------------------------------------------------------
// The chain rule itself. These need no database: they are the property a CLIENT
// checks over rows it pulled, which is where "the server dropped or reordered
// my ops" is actually detected (spec §3.3(a)).
// ---------------------------------------------------------------------------

// TestChainRuleIsPinnedByAGoldenVector freezes the formula the TypeScript port
// must reproduce byte for byte: blob_hash[n] = SHA256(blob_hash[n-1] ‖ bytes[n]),
// starting from 32 zero bytes. A change here is a data migration, not a code
// change, so it is pinned against constants rather than against a
// reimplementation of itself.
func TestChainRuleIsPinnedByAGoldenVector(t *testing.T) {
	first := blob.Hash(blob.ZeroHash, blob.Sealed{Bytes: bytesOf(0xab, 1024), SizeBucket: 1024})
	const wantFirst = "b972e78fb27a0866f41fd72ab4687e18aed94a66c8e32314ac654e8247c3e3d3"
	if got := hex.EncodeToString(first[:]); got != wantFirst {
		t.Fatalf("chain hash 1 = %s, want %s", got, wantFirst)
	}
	second := blob.Hash(first, blob.Sealed{Bytes: bytesOf(0xcd, 1024), SizeBucket: 1024})
	const wantSecond = "1eb123521be8de11640db812996ae32d973f6ed53d3eff1f3e080fa377761eb4"
	if got := hex.EncodeToString(second[:]); got != wantSecond {
		t.Fatalf("chain hash 2 = %s, want %s", got, wantSecond)
	}
	// And the genesis really is 32 zero bytes, not "no bytes at all".
	if blob.ZeroHash != ([32]byte{}) {
		t.Fatal("ZeroHash is not 32 zero bytes")
	}
	direct := sha256.Sum256(append(make([]byte, 32), bytesOf(0xab, 1024)...))
	if direct != first {
		t.Fatal("blob.Hash is not SHA256(prev || bytes)")
	}
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func TestVerifyChainAcceptsAContiguousRun(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 5)
	if err := VerifyChain(rows, 0, blob.ZeroHash); err != nil {
		t.Fatalf("a well-formed chain must verify: %v", err)
	}
	// And a suffix verifies against the head it continues from.
	var prev [32]byte
	copy(prev[:], rows[1].BlobHash)
	if err := VerifyChain(rows[2:], 2, prev); err != nil {
		t.Fatalf("a suffix must verify against its own head: %v", err)
	}
}

// The first blob of a chain links to 32 zero bytes and nothing else. Without
// this, a writer could start its chain anywhere and a client verifying from
// genesis would have nothing to anchor against.
func TestFirstBlobOfAChainLinksToZeroHash(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 1)
	if err := VerifyChain(rows, 0, blob.ZeroHash); err != nil {
		t.Fatalf("counter 1 chained from ZeroHash must verify: %v", err)
	}
	var junk [32]byte
	junk[0] = 1
	forged, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, junk, 1)
	if err := VerifyChain(forged, 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("counter 1 with a non-zero prev must break: %v", err)
	}
}

// THE integrity property, part 1: an op the server never delivered is detected.
func TestVerifyChainDetectsADroppedOp(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 5)
	dropped := append(append([]Row{}, rows[:2]...), rows[3:]...) // 1,2,4,5
	if err := VerifyChain(dropped, 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("a dropped op must break the chain, got %v", err)
	}
}

// THE integrity property, part 2: ops served out of order are detected.
func TestVerifyChainDetectsAReorderedOp(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 5)
	swapped := append([]Row{}, rows...)
	swapped[2], swapped[3] = swapped[3], swapped[2]
	if err := VerifyChain(swapped, 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("a reordered op must break the chain, got %v", err)
	}
}

// THE integrity property, part 3: substituted bytes are detected even when the
// counters and links are all internally consistent, because the hash is
// recomputed from the stored bytes rather than trusted.
func TestVerifyChainDetectsATamperedBlob(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	rows[1].Blob = append([]byte(nil), rows[1].Blob...)
	rows[1].Blob[600] ^= 0xff
	if err := VerifyChain(rows, 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("a tampered blob must break the chain, got %v", err)
	}
}

func TestVerifyChainDetectsAForgedPrevHash(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	rows[2].PrevHash = bytesOf(0x11, 32)
	if err := VerifyChain(rows, 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("a forged prev_hash must break the chain, got %v", err)
	}
}

func TestVerifyChainDetectsAChainThatDoesNotContinueTheHead(t *testing.T) {
	u := uuid.New()
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 4, blob.ZeroHash, 2)
	if err := VerifyChain(rows, 2, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("counter 4 after head 2 must break, got %v", err)
	}
}

// ---------------------------------------------------------------------------
// Head
// ---------------------------------------------------------------------------

func TestHeadOfAnUnusedChainIsZero(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	c, h, err := a.Head(bg, u, "dev-a", blob.StreamHot)
	if err != nil {
		t.Fatal(err)
	}
	if c != 0 || h != blob.ZeroHash {
		t.Fatalf("Head = (%d, %x), want (0, zero)", c, h)
	}
}

func TestHeadAdvancesWithEveryAppend(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	rows, want := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows); err != nil {
		t.Fatal(err)
	}
	c, h, err := a.Head(bg, u, "dev-a", blob.StreamHot)
	if err != nil {
		t.Fatal(err)
	}
	if c != 3 || h != want {
		t.Fatalf("Head = (%d, %x), want (3, %x)", c, h, want)
	}
	// Another writer's chain is untouched by this one.
	if c, _, err := a.Head(bg, u, "dev-b", blob.StreamHot); err != nil || c != 0 {
		t.Fatalf("dev-b head = (%d, %v), want (0, nil)", c, err)
	}
}

// ---------------------------------------------------------------------------
// AppendClient: the chain is verified at append time
// ---------------------------------------------------------------------------

func TestClientAppendRejectsCounterGap(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, head := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 2)
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows); err != nil {
		t.Fatal(err)
	}
	gapped, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 4, head, 1)
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, gapped)
	assertChainBreak(t, err)

	assertGapFree(t, pool, u, 2)
	if got := nextSeqOf(t, pool, u); got != 3 {
		t.Fatalf("next_seq = %d after a rejected append, want 3", got)
	}
}

func TestClientAppendRejectsForgedPrevHash(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 1)
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows); err != nil {
		t.Fatal(err)
	}
	var forged [32]byte
	forged[3] = 0x99
	next, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 2, forged, 1)
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, next)
	assertChainBreak(t, err)
	assertGapFree(t, pool, u, 1)
}

func TestClientAppendRejectsRecomputedHashMismatch(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 1)
	// The row claims a hash that is not SHA256(prev || blob). A server that
	// stored the caller's word for it would let a writer make its own chain
	// unverifiable from the stored bytes.
	rows[0].BlobHash = bytesOf(0x42, 32)
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows)
	assertChainBreak(t, err)
	assertGapFree(t, pool, u, 0)
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d, want 1 — a rejected append burned a seq", got)
	}
}

func TestChainBreakRollsBackTheWholeBatch(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	rows[2].PrevHash = bytesOf(0x7e, 32) // the third row breaks the run
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows)
	assertChainBreak(t, err)

	assertGapFree(t, pool, u, 0)
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d, want 1 — the rejected batch burned seqs", got)
	}
}

func TestClientAppendRejectsTheIngestWriter(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	rows, _ := chainFrom(t, u, IngestWriterID, blob.StreamHot, 1, blob.ZeroHash, 1)
	if _, err := a.AppendClient(bg, u, IngestWriterID, blob.StreamHot, rows); err == nil {
		t.Fatal("a client must not be able to append into the ingest writer's chain")
	}
	assertGapFree(t, pool, u, 0)
}

func TestClientAppendRejectsRowsThatDisagreeWithTheCall(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 1)
	if _, err := a.AppendClient(bg, u, "dev-b", blob.StreamHot, rows); err == nil {
		t.Fatal("a row naming another writer must be rejected, not silently rewritten")
	}
	if _, err := a.AppendClient(bg, uuid.New(), "dev-a", blob.StreamHot, rows); err == nil {
		t.Fatal("a row naming another user must be rejected")
	}
	// The row-versus-call STREAM disagreement is not asserted here: there are
	// only two streams, so it can only be tested against cold, which
	// TestClientAppendRejectsTheColdStream now refuses one check earlier.
	assertGapFree(t, pool, u, 0)
}

// ---------------------------------------------------------------------------
// The ambiguous-commit contract (append.go's "an error does not always mean
// 'not appended'"): a naive retry of a batch that in fact committed must be
// answered with its seqs, not with an error that loops forever.
// ---------------------------------------------------------------------------

func TestResendingACommittedBatchReturnsItsSeqsInsteadOfFailing(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	first, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows)
	if err != nil {
		t.Fatal(err)
	}
	// The client never saw the response (deadline expired during Commit) and
	// sends the identical batch again.
	again, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows)
	if err != nil {
		t.Fatalf("a resend of an already-applied batch must not fail: %v", err)
	}
	if !reflect.DeepEqual(first, again) {
		t.Fatalf("resend returned %v, want the original %v", again, first)
	}
	assertGapFree(t, pool, u, 3)
	if got := nextSeqOf(t, pool, u); got != 4 {
		t.Fatalf("next_seq = %d, want 4 — the resend burned a seq", got)
	}
	// An older, fully-applied prefix is answered the same way.
	prefix, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows[:2])
	if err != nil {
		t.Fatalf("a resend of an applied prefix must not fail: %v", err)
	}
	if !reflect.DeepEqual(prefix, first[:2]) {
		t.Fatalf("prefix resend returned %v, want %v", prefix, first[:2])
	}
}

func TestResendingDifferentBytesAtAnAppliedCounterIsAChainBreak(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 1)
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows); err != nil {
		t.Fatal(err)
	}
	other, _ := sealBody(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, `{"forked":true}`)
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, []Row{other})
	assertChainBreak(t, err)
	assertGapFree(t, pool, u, 1)
}

func TestAPartiallyAppliedResendIsRejectedWithoutClaimingAChainBreak(t *testing.T) {
	// Counters 1..2 are applied; the client resends 2..3. This is a protocol
	// mistake, not evidence the server lost anything, so it must NOT be
	// ErrChainBreak — spec §3.3:68 makes that a sync hard stop with a
	// non-dismissable warning.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows[:2]); err != nil {
		t.Fatal(err)
	}
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows[1:])
	if err == nil {
		t.Fatal("a partially-applied batch must be rejected")
	}
	if errors.Is(err, ErrChainBreak) {
		t.Fatalf("a partial resend must not be reported as a chain break: %v", err)
	}
	assertGapFree(t, pool, u, 2)
	// Resubmitting only the new row works.
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows[2:]); err != nil {
		t.Fatalf("the suffix must be appendable: %v", err)
	}
	assertGapFree(t, pool, u, 3)
}

// ---------------------------------------------------------------------------
// The ORDERING RULE: allocSeq (the counter lock) FIRST, then the head read.
// ---------------------------------------------------------------------------

// TestTheChainCheckRunsAfterTheCounterLockIsTaken is the ORDERING RULE, pinned
// directly and without any timing: it drives appendTx with a prepare hook that
// reads the user's counter row on the append's OWN transaction. allocSeq is the
// statement that takes that row's lock, so "has next_seq already advanced by
// len(rows) when the chain check runs?" is exactly "was the lock taken first?".
//
// Swap the two statements in appendTx and this fails deterministically, on one
// connection, with no concurrency. The CONSEQUENCE of getting it wrong — a
// second upload from the same writer colliding in the unique index instead of
// being answered with ErrChainBreak — is pinned separately by
// TestConcurrentDoubleAppendFromOneWriterIsACleanChainBreak.
func TestTheChainCheckRunsAfterTheCounterLockIsTaken(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 3)
	var seen int64
	prepare := func(ctx context.Context, tx pgx.Tx, rows []Row) error {
		return tx.QueryRow(ctx, `SELECT next_seq FROM oplog_seq WHERE user_id=$1`, u).Scan(&seen)
	}
	if _, err := a.appendRows(bg, rows, prepare); err != nil {
		t.Fatal(err)
	}
	if want := int64(1 + len(rows)); seen != want {
		t.Fatalf("the chain check saw next_seq=%d, want %d: allocSeq has NOT taken the counter lock "+
			"before the chain head is read, so two concurrent uploads from one writer can both "+
			"observe the same head and race for the same counter", seen, want)
	}
}

// TestAnAppendQueuedBehindAnotherSeesTheCommittedHead: an append that arrives
// while another transaction holds the counter is answered against the head that
// transaction commits, never against the stale one it saw on arrival. Here the
// queued append submits DIFFERENT bytes at the counter the winner takes, so the
// only correct answer is ErrChainBreak.
//
// (The statement it actually blocks on is EnsureSeqRow's
// `INSERT ... ON CONFLICT DO NOTHING`, not allocSeq: an insert whose conflicting
// row is being updated by an in-flight transaction has to wait to learn whether
// that update commits. That is why this test is a companion to the ordering pin
// above rather than the pin itself — the external interleaving it can create is
// the same under both orderings.)
func TestAnAppendQueuedBehindAnotherSeesTheCommittedHead(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	warmPool(t, pool, 4)

	first, h1 := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 1)
	if _, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, first); err != nil {
		t.Fatal(err)
	}

	// The winner: holds the counter lock, has written counter 2, not committed.
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	winner, _ := sealBody(t, u, "dev-a", blob.StreamHot, 2, h1, `{"winner":true}`)
	if _, err := a.appendTx(bg, tx, u, []Row{winner}, nil); err != nil {
		t.Fatal(err)
	}

	// The racer: a DIFFERENT blob at counter 2, submitted while the winner
	// still holds the lock.
	racer, _ := sealBody(t, u, "dev-a", blob.StreamHot, 2, h1, `{"racer":true}`)
	done := make(chan error, 1)
	go func() {
		_, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, []Row{racer})
		done <- err
	}()

	waitForLockWaiter(t, pool)
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-done:
		assertChainBreak(t, err)
	case <-time.After(30 * time.Second):
		t.Fatal("the racing append never returned")
	}
	assertGapFree(t, pool, u, 2)
	if got := countersOf(t, pool, u, "dev-a", blob.StreamHot); !reflect.DeepEqual(got, []int64{1, 2}) {
		t.Fatalf("counters = %v, want [1 2]", got)
	}
}

// waitForLockWaiter blocks until some backend on this database is waiting on a
// lock, which is how the test knows the racer has reached the counter — under
// either ordering. Polling this instead of sleeping keeps the test both fast
// and free of a timing assumption that would silently stop testing anything.
func waitForLockWaiter(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := pool.QueryRow(bg,
			`SELECT count(*) FROM pg_stat_activity
			  WHERE datname = current_database() AND wait_event_type = 'Lock'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no backend ever blocked on the counter lock; the test premise does not hold")
}

// TestConcurrentDoubleAppendFromOneWriterIsACleanChainBreak is the realistic
// shape of the same rule: two uploads from one device, in flight at once, both
// claiming the next counter. Exactly one must win and the loser must get
// ErrChainBreak — never a duplicate-key error.
func TestConcurrentDoubleAppendFromOneWriterIsACleanChainBreak(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	warmPool(t, pool, 4)

	const rounds = 25
	counter, head := int64(0), blob.ZeroHash
	for round := 0; round < rounds; round++ {
		bodies := [2]string{fmt.Sprintf(`{"a":%d}`, round), fmt.Sprintf(`{"b":%d}`, round)}
		var racers [2][]Row
		for i, body := range bodies {
			r, _ := sealBody(t, u, "dev-a", blob.StreamHot, counter+1, head, body)
			racers[i] = []Row{r}
		}
		var (
			wg    sync.WaitGroup
			start = make(chan struct{})
			errs  [2]error
		)
		for i := range racers {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				_, errs[i] = a.AppendClient(bg, u, "dev-a", blob.StreamHot, racers[i])
			}(i)
		}
		close(start)
		wg.Wait()

		wins := 0
		for i, err := range errs {
			if err == nil {
				wins++
				continue
			}
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
				t.Fatalf("round %d racer %d: the database rejected the append instead of the chain check: %v", round, i, err)
			}
			if !errors.Is(err, ErrChainBreak) {
				t.Fatalf("round %d racer %d: want ErrChainBreak, got %T: %v", round, i, err, err)
			}
		}
		if wins != 1 {
			t.Fatalf("round %d: %d of 2 racers won, want exactly 1 (errs: %v)", round, wins, errs)
		}
		var err error
		if counter, head, err = a.Head(bg, u, "dev-a", blob.StreamHot); err != nil {
			t.Fatal(err)
		}
		if counter != int64(round+1) {
			t.Fatalf("round %d: head counter = %d, want %d", round, counter, round+1)
		}
	}
	assertGapFree(t, pool, u, rounds)
}

// ---------------------------------------------------------------------------
// AppendIngest: the server computes the chain, per stream
// ---------------------------------------------------------------------------

func TestIngestChainIsServerComputedAndPerStream(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	for i := 0; i < 3; i++ {
		seqs, err := a.AppendIngest(bg, u, []IngestBlob{
			{Stream: blob.StreamHot, Plaintext: []byte(fmt.Sprintf(`{"op":%d}`, i))},
			{Stream: blob.StreamCold, Plaintext: []byte(fmt.Sprintf(`{"raw":%d}`, i))},
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(seqs) != 2 || seqs[1] != seqs[0]+1 {
			t.Fatalf("delivery %d got seqs %v, want a contiguous pair", i, seqs)
		}
	}

	// Not 1..6 interleaved: each stream is its own chain (Decision 13).
	for _, stream := range []string{blob.StreamHot, blob.StreamCold} {
		if got := countersOf(t, pool, u, IngestWriterID, stream); !reflect.DeepEqual(got, []int64{1, 2, 3}) {
			t.Fatalf("%s counters = %v, want [1 2 3]", stream, got)
		}
		rows := storedChain(t, pool, u, IngestWriterID, stream)
		if err := VerifyChain(rows, 0, blob.ZeroHash); err != nil {
			t.Fatalf("%s chain does not verify from stored bytes: %v", stream, err)
		}
	}
	assertGapFree(t, pool, u, 6)
}

// The reason AppendIngest takes plaintext rather than a sealed blob: the AAD
// binds writer_counter, and the counter is not known until the server has taken
// the counter lock. A caller that sealed first would have to guess, and a wrong
// guess stores a blob that can never be opened at the position it occupies.
func TestIngestBlobsOpenAtThePositionTheServerAssigned(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	for i := 0; i < 2; i++ {
		if _, err := a.AppendIngest(bg, u, []IngestBlob{
			{Stream: blob.StreamHot, Plaintext: []byte(fmt.Sprintf(`{"op":%d}`, i))},
			{Stream: blob.StreamCold, Plaintext: []byte(fmt.Sprintf(`{"raw":%d}`, i))},
		}); err != nil {
			t.Fatal(err)
		}
	}
	for _, stream := range []string{blob.StreamHot, blob.StreamCold} {
		for i, r := range storedChain(t, pool, u, IngestWriterID, stream) {
			plain, err := blob.PlaintextSealer{}.Open(blob.Envelope{
				UserID: u, Stream: r.Stream, WriterID: r.WriterID, WriterCounter: r.WriterCounter,
			}, blob.Sealed{Bytes: r.Blob, SizeBucket: r.SizeBucket})
			if err != nil {
				t.Fatalf("%s row %d does not open at its own position: %v", stream, i, err)
			}
			want := fmt.Sprintf(`{"op":%d}`, i)
			if stream == blob.StreamCold {
				want = fmt.Sprintf(`{"raw":%d}`, i)
			}
			if string(plain) != want {
				t.Fatalf("%s row %d = %s, want %s", stream, i, plain, want)
			}
		}
	}
}

// Two blobs on the SAME stream in one call must chain to each other, not both
// claim the next counter — the batch advances the head as it is built.
func TestIngestChainsTwoBlobsOnOneStreamWithinOneCall(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	if _, err := a.AppendIngest(bg, u, []IngestBlob{
		{Stream: blob.StreamHot, Plaintext: []byte(`{"op":0}`)},
		{Stream: blob.StreamHot, Plaintext: []byte(`{"op":1}`)},
		{Stream: blob.StreamCold, Plaintext: []byte(`{"raw":0}`)},
	}); err != nil {
		t.Fatal(err)
	}
	if got := countersOf(t, pool, u, IngestWriterID, blob.StreamHot); !reflect.DeepEqual(got, []int64{1, 2}) {
		t.Fatalf("hot counters = %v, want [1 2]", got)
	}
	if got := countersOf(t, pool, u, IngestWriterID, blob.StreamCold); !reflect.DeepEqual(got, []int64{1}) {
		t.Fatalf("cold counters = %v, want [1]", got)
	}
	rows := storedChain(t, pool, u, IngestWriterID, blob.StreamHot)
	if err := VerifyChain(rows, 0, blob.ZeroHash); err != nil {
		t.Fatalf("two hot blobs from one call must chain to each other: %v", err)
	}
	// The second row's prev must be the first row's hash, not ZeroHash.
	if reflect.DeepEqual(rows[1].PrevHash, blob.ZeroHash[:]) {
		t.Fatal("the second blob in the call links to the genesis instead of the first")
	}
}

func TestHotAndColdChainsAreIndependent(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	if _, err := a.AppendIngest(bg, u, []IngestBlob{{Stream: blob.StreamHot, Plaintext: []byte(`{"op":0}`)}}); err != nil {
		t.Fatal(err)
	}
	hotC, hotH, err := a.Head(bg, u, IngestWriterID, blob.StreamHot)
	if err != nil {
		t.Fatal(err)
	}
	coldC, coldH, err := a.Head(bg, u, IngestWriterID, blob.StreamCold)
	if err != nil {
		t.Fatal(err)
	}
	if hotC != 1 || coldC != 0 || coldH != blob.ZeroHash {
		t.Fatalf("after one hot append: hot=(%d), cold=(%d,%x)", hotC, coldC, coldH)
	}

	// A cold append must not move the hot head at all.
	for i := 0; i < 2; i++ {
		if _, err := a.AppendIngest(bg, u, []IngestBlob{{Stream: blob.StreamCold, Plaintext: []byte(`{"raw":1}`)}}); err != nil {
			t.Fatal(err)
		}
	}
	gotC, gotH, err := a.Head(bg, u, IngestWriterID, blob.StreamHot)
	if err != nil {
		t.Fatal(err)
	}
	if gotC != hotC || gotH != hotH {
		t.Fatalf("cold appends moved the hot head from (%d,%x) to (%d,%x)", hotC, hotH, gotC, gotH)
	}
	if c, _, err := a.Head(bg, u, IngestWriterID, blob.StreamCold); err != nil || c != 2 {
		t.Fatalf("cold head = (%d, %v), want (2, nil)", c, err)
	}
}

func TestIngestRejectsCallerAssignedChainFields(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	cases := []struct {
		name string
		b    IngestBlob
	}{
		{"unknown stream", IngestBlob{Stream: "warm", Plaintext: []byte(`{}`)}},
		{"empty stream", IngestBlob{Plaintext: []byte(`{}`)}},
		{"empty plaintext", IngestBlob{Stream: blob.StreamHot}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := a.AppendIngest(bg, u, []IngestBlob{c.b}); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d after only-invalid ingest appends, want 1", got)
	}
}

// Concurrent deliveries for one user: the ingest writer's counters must stay
// contiguous on BOTH streams, which is exactly what the counter lock buys —
// two deliveries that both read head=N before either commits would collide.
func TestConcurrentIngestAppendsKeepBothChainsContiguous(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	const deliverers, perDeliverer = 6, 6
	warmPool(t, pool, deliverers)
	var wg sync.WaitGroup
	for d := 0; d < deliverers; d++ {
		wg.Add(1)
		go func(d int) {
			defer wg.Done()
			for i := 0; i < perDeliverer; i++ {
				if _, err := a.AppendIngest(bg, u, []IngestBlob{
					{Stream: blob.StreamHot, Plaintext: []byte(fmt.Sprintf(`{"op":"%d-%d"}`, d, i))},
					{Stream: blob.StreamCold, Plaintext: []byte(fmt.Sprintf(`{"raw":"%d-%d"}`, d, i))},
				}); err != nil {
					t.Errorf("deliverer %d message %d: %v", d, i, err)
					return
				}
			}
		}(d)
	}
	wg.Wait()

	total := deliverers * perDeliverer
	for _, stream := range []string{blob.StreamHot, blob.StreamCold} {
		rows := storedChain(t, pool, u, IngestWriterID, stream)
		if len(rows) != total {
			t.Fatalf("%s has %d rows, want %d", stream, len(rows), total)
		}
		for i, r := range rows {
			if r.WriterCounter != int64(i+1) {
				t.Fatalf("%s counter at index %d is %d, want %d", stream, i, r.WriterCounter, i+1)
			}
		}
		if err := VerifyChain(rows, 0, blob.ZeroHash); err != nil {
			t.Fatalf("%s chain does not verify after concurrent appends: %v", stream, err)
		}
	}
	assertGapFree(t, pool, u, 2*total)
}

// ---------------------------------------------------------------------------
// The SQLSTATE 23505 backstop
// ---------------------------------------------------------------------------

func TestUniqueViolationOnAPositionIsRecognised(t *testing.T) {
	dup := &pgconn.PgError{Code: uniqueViolation, ConstraintName: positionConstraint}
	if !isPositionTaken(fmt.Errorf("wrapped: %w", dup)) {
		t.Fatal("a 23505 on the (writer, stream, counter) key must be recognised")
	}
	other := &pgconn.PgError{Code: uniqueViolation, ConstraintName: "op_log_pkey"}
	if isPositionTaken(other) {
		t.Fatal("a 23505 on the seq primary key is a different failure and must not be translated")
	}
	if isPositionTaken(errors.New("boom")) {
		t.Fatal("a non-pg error must not be translated")
	}
}

func TestAppliedLookupResolvesSeqsAndSpotsAFork(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 2)
	seqs, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows)
	if err != nil {
		t.Fatal(err)
	}
	got, err := appliedSeqs(bg, pool, u, "dev-a", blob.StreamHot, rows)
	if err != nil {
		t.Fatalf("identical rows must resolve to their seqs: %v", err)
	}
	if !reflect.DeepEqual(got, seqs) {
		t.Fatalf("appliedSeqs = %v, want %v", got, seqs)
	}

	forked := append([]Row(nil), rows...)
	other, _ := sealBody(t, u, "dev-a", blob.StreamHot, 2, blob.ZeroHash, `{"forked":true}`)
	forked[1] = other
	if _, err := appliedSeqs(bg, pool, u, "dev-a", blob.StreamHot, forked); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("different bytes at an applied counter must be a chain break, got %v", err)
	}

	missing, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 5, blob.ZeroHash, 1)
	_, err = appliedSeqs(bg, pool, u, "dev-a", blob.StreamHot, missing)
	if err == nil {
		t.Fatal("a counter that was never stored must not resolve")
	}
	if errors.Is(err, ErrChainBreak) {
		t.Fatalf("an unstored counter is not a chain break: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Position binding: a blob must be sealed FOR the position it is stored at
// ---------------------------------------------------------------------------

// Every row here has a flawless chain — correct counter sequence, correct
// prev_hash, correctly recomputed blob_hash. Only the AAD embedded in the frame
// says otherwise, which is why the chain check alone is not enough and why
// Row.validate compares it. Without that compare all three are stored, and a
// device meets them as a set-aside WARNING (blob.ErrSetAside) rather than as
// anything that stops a sync.
func TestAppendClientRejectsABlobSealedForAnotherPosition(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	// rechain re-links a row at counter 1 from genesis, so the ONLY thing wrong
	// with it is where its bytes were sealed.
	rechain := func(r Row) Row {
		r.WriterCounter = 1
		r.PrevHash = blob.ZeroHash[:]
		h := blob.Hash(blob.ZeroHash, blob.Sealed{Bytes: r.Blob, SizeBucket: r.SizeBucket})
		r.BlobHash = h[:]
		return r
	}

	// One writer per case, so every case is an independent chain starting at
	// counter 1. Sharing a writer would make the first case's stored row turn
	// the rest into replay-detection tests, which pass whether or not the AAD
	// is checked at all.
	movedCounter, _ := sealBody(t, u, "dev-1", blob.StreamHot, 7, blob.ZeroHash, `{"moved":"counter"}`)
	movedCounter = rechain(movedCounter)

	movedUser, _ := sealBody(t, uuid.New(), "dev-2", blob.StreamHot, 1, blob.ZeroHash, `{"moved":"user"}`)
	movedUser.UserID = u

	movedStream, _ := sealBody(t, u, "dev-3", blob.StreamCold, 1, blob.ZeroHash, `{"moved":"stream"}`)
	movedStream.Stream = blob.StreamHot

	movedWriter, _ := sealBody(t, u, "dev-z", blob.StreamHot, 1, blob.ZeroHash, `{"moved":"writer"}`)
	movedWriter.WriterID = "dev-4"

	cases := []struct {
		name, writer string
		row          Row
	}{
		{"sealed at counter 7, stored at counter 1", "dev-1", movedCounter},
		{"sealed for another user", "dev-2", movedUser},
		{"sealed for the cold stream", "dev-3", movedStream},
		{"sealed by another writer", "dev-4", movedWriter},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Premise: the chain itself is intact, so nothing but the AAD can
			// catch this. Without this assertion the test could pass because
			// the row was malformed in some other way.
			if err := VerifyChain([]Row{c.row}, 0, blob.ZeroHash); err != nil {
				t.Fatalf("premise broken — the chain must verify: %v", err)
			}
			if _, err := a.AppendClient(bg, u, c.writer, blob.StreamHot, []Row{c.row}); err == nil {
				t.Fatal("a blob sealed for a different position must not be stored")
			}
		})
	}
	assertGapFree(t, pool, u, 0)
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d, want 1 — a rejected row burned a seq", got)
	}

	// The control: the same payload, sealed where it is actually stored.
	ok, _ := sealBody(t, u, "dev-1", blob.StreamHot, 1, blob.ZeroHash, `{"moved":"counter"}`)
	if _, err := a.AppendClient(bg, u, "dev-1", blob.StreamHot, []Row{ok}); err != nil {
		t.Fatalf("a correctly sealed row must be accepted: %v", err)
	}
}

// The server seals ingest blobs itself, so this can only fail if the sealer and
// the row disagree about the position — which is the bug the client-side check
// above exists to catch, asserted here for the path where the server is the
// author.
func TestIngestBlobsAreSealedForTheRowTheyAreStoredIn(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	if _, err := a.AppendIngest(bg, u, []IngestBlob{
		{Stream: blob.StreamHot, Plaintext: []byte(`{"op":0}`)},
		{Stream: blob.StreamCold, Plaintext: []byte(`{"raw":0}`)},
	}); err != nil {
		t.Fatal(err)
	}
	for _, stream := range []string{blob.StreamHot, blob.StreamCold} {
		for _, r := range storedChain(t, pool, u, IngestWriterID, stream) {
			aad, err := blob.EmbeddedAAD(r.Blob)
			if err != nil {
				t.Fatal(err)
			}
			want := blob.Envelope{UserID: u, Stream: r.Stream, WriterID: r.WriterID, WriterCounter: r.WriterCounter}.AAD()
			if string(aad) != string(want) {
				t.Fatalf("stored blob carries AAD %q, want %q", aad, want)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Splices, the cold stream, and the 23505 arm
// ---------------------------------------------------------------------------

// A server that interleaves two writers can keep the counters continuous and
// recompute every hash honestly, so nothing but the (writer, stream) guard
// notices. VerifyChain is exported for Task 9 to run over server-supplied rows,
// which is exactly where this matters.
func TestVerifyChainDetectsRowsSplicedFromTwoChains(t *testing.T) {
	u := uuid.New()
	base, head := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 2)

	twoWriters, _ := chainFrom(t, u, "dev-b", blob.StreamHot, 3, head, 2)
	if err := VerifyChain(append(append([]Row{}, base...), twoWriters...), 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("two writers spliced into one chain must break, got %v", err)
	}
	twoStreams, _ := chainFrom(t, u, "dev-a", blob.StreamCold, 3, head, 2)
	if err := VerifyChain(append(append([]Row{}, base...), twoStreams...), 0, blob.ZeroHash); !errors.Is(err, ErrChainBreak) {
		t.Fatalf("two streams spliced into one chain must break, got %v", err)
	}
}

func TestClientAppendRejectsTheColdStream(t *testing.T) {
	// Invariant I16: cold carries raw bodies from the ingest writer, never ops.
	// A client-authored cold row would put state on the stream a hot-only
	// client skips.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	rows, _ := chainFrom(t, u, "dev-a", blob.StreamCold, 1, blob.ZeroHash, 1)
	_, err := a.AppendClient(bg, u, "dev-a", blob.StreamCold, rows)
	if err == nil {
		t.Fatal("a client must not author cold-stream rows")
	}
	if errors.Is(err, ErrChainBreak) {
		t.Fatalf("refusing the cold stream is a protocol rule, not a chain break: %v", err)
	}
	assertGapFree(t, pool, u, 0)
}

// The 23505 arm is unreachable in a correct build (see resolveAppendErr), so it
// is driven directly with the same synthetic error the classifier test builds.
// Without this the branch that honours the ambiguous-commit contract would ship
// untested.
func TestPositionTakenIsResolvedAgainstTheStoredRows(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	rows, _ := chainFrom(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash, 2)
	seqs, err := a.AppendClient(bg, u, "dev-a", blob.StreamHot, rows)
	if err != nil {
		t.Fatal(err)
	}
	dup := fmt.Errorf("oplog: append: insert row 0 (seq 9): %w",
		&pgconn.PgError{Code: uniqueViolation, ConstraintName: positionConstraint})

	// Byte-identical rows: "already applied", answered with the stored seqs.
	got, err := a.resolveAppendErr(bg, u, "dev-a", blob.StreamHot, rows, nil, dup)
	if err != nil {
		t.Fatalf("a duplicate position holding identical bytes must resolve: %v", err)
	}
	if !reflect.DeepEqual(got, seqs) {
		t.Fatalf("resolved %v, want %v", got, seqs)
	}

	// Different bytes at a taken position: an invariant violation, NOT a chain
	// break — a client must not be hard-stopped by a server-side bug.
	forked := append([]Row(nil), rows...)
	forked[1], _ = sealBody(t, u, "dev-a", blob.StreamHot, 2, blob.ZeroHash, `{"forked":true}`)
	_, err = a.resolveAppendErr(bg, u, "dev-a", blob.StreamHot, forked, nil, dup)
	if !errors.Is(err, ErrPositionTaken) {
		t.Fatalf("want ErrPositionTaken, got %T: %v", err, err)
	}
	if errors.Is(err, ErrChainBreak) {
		t.Fatalf("a server-side invariant violation must not be reported as a chain break: %v", err)
	}

	// Anything else passes through untouched, and a nil error returns the seqs
	// it was handed.
	boom := errors.New("boom")
	if _, err := a.resolveAppendErr(bg, u, "dev-a", blob.StreamHot, rows, nil, boom); !errors.Is(err, boom) {
		t.Fatalf("an unrelated error must pass through, got %v", err)
	}
	if got, err := a.resolveAppendErr(bg, u, "dev-a", blob.StreamHot, rows, seqs, nil); err != nil || !reflect.DeepEqual(got, seqs) {
		t.Fatalf("a successful append must return its seqs: %v, %v", got, err)
	}
}
