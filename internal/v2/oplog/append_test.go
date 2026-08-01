package oplog

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
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

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// insertUser mirrors what auth.UpsertUser (Task 6) is required to do: the user
// row and its oplog_seq row are created inside ONE transaction, so the seq row
// always exists before the first append and Append's ON CONFLICT path is dead
// code rather than a live concurrency hazard.
func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)
	id := insertUserRow(t, tx)
	if err := EnsureSeqRow(bg, tx, id); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}
	return id
}

// insertUserBareUser creates a user WITHOUT its oplog_seq row, i.e. a user as it
// would exist if it had been created before EnsureSeqRow landed. It exercises
// Append's belt-and-braces INSERT ... ON CONFLICT DO NOTHING path.
func insertUserWithoutSeqRow(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)
	id := insertUserRow(t, tx)
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}
	return id
}

func insertUserRow(t *testing.T, tx pgx.Tx) uuid.UUID {
	t.Helper()
	sub := make([]byte, 32)
	if _, err := rand.Read(sub); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := tx.QueryRow(bg,
		`INSERT INTO users (idp, idp_sub_hash) VALUES ('apple', $1) RETURNING id`,
		sub).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// sealRow builds one real, bucket-padded blob at the given position and the
// op_log row that carries it. It returns the row's blob hash so a caller can
// chain the next one.
func sealRow(u uuid.UUID, writerID, stream string, counter int64, prev [32]byte) (Row, [32]byte, error) {
	env := blob.Envelope{UserID: u, Stream: stream, WriterID: writerID, WriterCounter: counter}
	body := fmt.Sprintf(`{"writer":%q,"stream":%q,"counter":%d}`, writerID, stream, counter)
	s, err := blob.PlaintextSealer{}.Seal(env, []byte(body))
	if err != nil {
		return Row{}, [32]byte{}, err
	}
	h := blob.Hash(prev, s)
	return Row{
		UserID:        u,
		Stream:        stream,
		WriterID:      writerID,
		WriterCounter: counter,
		TypeFlag:      TypeFlagIngest,
		Blob:          s.Bytes,
		SizeBucket:    s.SizeBucket,
		BlobHash:      h[:],
		PrevHash:      prev[:],
	}, h, nil
}

// mustSeal is sealRow for the sequential tests. It is NOT safe to call from a
// spawned goroutine (t.Fatal must run on the test's own goroutine); the
// concurrency tests call sealRow and report via t.Errorf instead.
func mustSeal(t *testing.T, u uuid.UUID, writerID, stream string, counter int64, prev [32]byte) (Row, [32]byte) {
	t.Helper()
	r, h, err := sealRow(u, writerID, stream, counter, prev)
	if err != nil {
		t.Fatal(err)
	}
	return r, h
}

// rowsFor builds n chained rows for one (writer, stream), starting at counter
// start.
func rowsFor(t *testing.T, u uuid.UUID, writerID, stream string, start int64, n int) []Row {
	t.Helper()
	prev := blob.ZeroHash
	out := make([]Row, 0, n)
	for i := 0; i < n; i++ {
		r, h := mustSeal(t, u, writerID, stream, start+int64(i), prev)
		prev = h
		out = append(out, r)
	}
	return out
}

func seqsOf(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) []int64 {
	t.Helper()
	rows, err := pool.Query(bg, `SELECT seq FROM op_log WHERE user_id=$1 ORDER BY seq`, u)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []int64
	for rows.Next() {
		var s int64
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		got = append(got, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return got
}

// assertGapFree is the whole point of this task: the stored seqs for a user must
// be exactly 1..want. Duplicates are structurally impossible (PRIMARY KEY
// (user_id, seq)), so a length mismatch plus a per-index equality check is a
// complete statement of the property.
func assertGapFree(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, want int) {
	t.Helper()
	got := seqsOf(t, pool, u)
	for i, s := range got {
		if s != int64(i+1) {
			t.Fatalf("gap at index %d: seq=%d (all seqs: %v)", i, s, got)
		}
	}
	if len(got) != want {
		t.Fatalf("want %d rows, got %d", want, len(got))
	}
}

func nextSeqOf(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(bg, `SELECT next_seq FROM oplog_seq WHERE user_id=$1`, u).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestAppendAssignsContiguousSeqs(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	seqs, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 3))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seqs, []int64{1, 2, 3}) {
		t.Fatalf("got %v, want [1 2 3]", seqs)
	}

	// A second call continues the same run rather than restarting.
	seqs, err = a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 4, 2))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seqs, []int64{4, 5}) {
		t.Fatalf("got %v, want [4 5]", seqs)
	}
	assertGapFree(t, pool, u, 5)
}

func TestConcurrentAppendsAreGapFreeAndCommitOrderMatchesSeqOrder(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	const writers, perWriter = 8, 25
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			id := fmt.Sprintf("dev-%d", w)
			prev := blob.ZeroHash
			for c := 1; c <= perWriter; c++ {
				r, h, err := sealRow(u, id, blob.StreamHot, int64(c), prev)
				if err != nil {
					t.Errorf("%s counter %d: seal: %v", id, c, err)
					return
				}
				prev = h
				if _, err := a.Append(bg, []Row{r}); err != nil {
					t.Errorf("%s counter %d: append: %v", id, c, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	assertGapFree(t, pool, u, writers*perWriter)
	max, err := a.MaxSeq(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if max != writers*perWriter {
		t.Fatalf("MaxSeq = %d, want %d", max, writers*perWriter)
	}
	if got := nextSeqOf(t, pool, u); got != writers*perWriter+1 {
		t.Fatalf("next_seq = %d, want %d", got, writers*perWriter+1)
	}
}

func TestConcurrentMultiRowAppendsAllocateContiguousBlocks(t *testing.T) {
	// A single Append must get a CONTIGUOUS block even while other appends for
	// the same user are in flight — otherwise one message's hot and cold rows
	// could be split by another writer's rows, and the block-allocation return
	// value would be a lie.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	const writers, batches, perBatch = 6, 10, 3
	var mu sync.Mutex
	var blocks [][]int64
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			id := fmt.Sprintf("dev-%d", w)
			prev := blob.ZeroHash
			for b := 0; b < batches; b++ {
				batch := make([]Row, 0, perBatch)
				for i := 0; i < perBatch; i++ {
					counter := int64(b*perBatch + i + 1)
					r, h, err := sealRow(u, id, blob.StreamHot, counter, prev)
					if err != nil {
						t.Errorf("%s counter %d: seal: %v", id, counter, err)
						return
					}
					prev = h
					batch = append(batch, r)
				}
				got, err := a.Append(bg, batch)
				if err != nil {
					t.Errorf("%s batch %d: append: %v", id, b, err)
					return
				}
				mu.Lock()
				blocks = append(blocks, got)
				mu.Unlock()
			}
		}(w)
	}
	wg.Wait()

	total := writers * batches * perBatch
	assertGapFree(t, pool, u, total)
	// Each returned block is contiguous, AND the blocks are pairwise disjoint
	// and jointly cover 1..total. An overlap would trip the primary key anyway,
	// so the disjointness half is belt-and-braces — but "every block is
	// contiguous" alone is also satisfied by every block being [1,2,3].
	seen := make(map[int64]int, total)
	for _, blk := range blocks {
		if len(blk) != perBatch {
			t.Fatalf("block %v has %d seqs, want %d", blk, len(blk), perBatch)
		}
		for i, s := range blk {
			if s != blk[0]+int64(i) {
				t.Fatalf("block %v is not contiguous", blk)
			}
			seen[s]++
		}
	}
	if len(seen) != total {
		t.Fatalf("the returned blocks cover %d distinct seqs, want %d", len(seen), total)
	}
	for s := int64(1); s <= int64(total); s++ {
		if seen[s] != 1 {
			t.Fatalf("seq %d was returned by %d blocks, want exactly 1", s, seen[s])
		}
	}
}

func TestNoTransientGapIsEverVisibleToAConcurrentReader(t *testing.T) {
	// This is the property a sequence + watermark does NOT have. With nextval(),
	// a reader can see seq 7 committed while 6 is still in flight. Here the
	// counter row lock makes commit order identical to seq order, so every
	// snapshot a reader takes is exactly 1..k with no hole.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	const writers, perWriter = 6, 20
	total := writers * perWriter

	done := make(chan struct{})
	type report struct {
		observations, partials int
		hole                   string
	}
	var rep report
	var readerWG sync.WaitGroup
	readerWG.Add(1)
	go func() {
		defer readerWG.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			rows, err := pool.Query(bg, `SELECT seq FROM op_log WHERE user_id=$1 ORDER BY seq`, u)
			if err != nil {
				rep.hole = fmt.Sprintf("query: %v", err)
				return
			}
			var got []int64
			for rows.Next() {
				var s int64
				if err := rows.Scan(&s); err != nil {
					rows.Close()
					rep.hole = fmt.Sprintf("scan: %v", err)
					return
				}
				got = append(got, s)
			}
			rows.Close()
			rep.observations++
			if len(got) > 0 && len(got) < total {
				rep.partials++
			}
			for i, s := range got {
				if s != int64(i+1) {
					rep.hole = fmt.Sprintf("reader saw a hole at index %d: seq=%d (all: %v)", i, s, got)
					return
				}
			}
		}
	}()

	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			id := fmt.Sprintf("dev-%d", w)
			prev := blob.ZeroHash
			for c := 1; c <= perWriter; c++ {
				r, h, err := sealRow(u, id, blob.StreamHot, int64(c), prev)
				if err != nil {
					t.Errorf("%s counter %d: seal: %v", id, c, err)
					return
				}
				prev = h
				if _, err := a.Append(bg, []Row{r}); err != nil {
					t.Errorf("%s counter %d: append: %v", id, c, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	close(done)
	readerWG.Wait() // happens-before for the reads of rep below

	if rep.hole != "" {
		t.Fatal(rep.hole)
	}
	// Vacuity guard: a reader that only ever saw the empty table or the final
	// state would have proved nothing about intermediate states.
	if rep.partials == 0 {
		t.Fatalf("reader took %d observations but never caught a partial state; the test proved nothing", rep.observations)
	}
	t.Logf("reader took %d observations, %d of them partial, and never saw a hole", rep.observations, rep.partials)
	assertGapFree(t, pool, u, total)
}

func TestARolledBackAppendLeavesNoGap(t *testing.T) {
	// The reason a locked counter row beats nextval(): a rolled-back UPDATE
	// restores the counter, so a failed append consumes nothing. nextval() burns
	// the value permanently and the hole is unrecoverable.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	first := rowsFor(t, u, "dev-a", blob.StreamHot, 1, 1)
	if _, err := a.Append(bg, first); err != nil {
		t.Fatal(err)
	}

	// Same (writer_id, stream, writer_counter) again: the unique index rejects
	// it AFTER the seq has been allocated inside the transaction.
	if _, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 1)); err == nil {
		t.Fatal("expected a duplicate (writer_id, stream, writer_counter) to be rejected")
	}

	if got := nextSeqOf(t, pool, u); got != 2 {
		t.Fatalf("the rolled-back append burned a seq: next_seq = %d, want 2", got)
	}
	seqs, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 2, 1))
	if err != nil {
		t.Fatal(err)
	}
	if seqs[0] != 2 {
		t.Fatalf("next append got seq %d, want 2 — the failed append left a hole", seqs[0])
	}
	assertGapFree(t, pool, u, 2)
}

func TestAFailedBatchAppendsNothingAndBurnsNoSeq(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	if _, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 2)); err != nil {
		t.Fatal(err)
	}
	// A three-row batch whose LAST row collides with counter 1. The first two
	// rows are valid; the batch must still land nothing at all.
	bad := rowsFor(t, u, "dev-a", blob.StreamHot, 3, 3)
	bad[2], _ = mustSeal(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash)
	if _, err := a.Append(bg, bad); err == nil {
		t.Fatal("expected the colliding batch to fail")
	}
	assertGapFree(t, pool, u, 2)
	if got := nextSeqOf(t, pool, u); got != 3 {
		t.Fatalf("next_seq = %d, want 3 — the failed batch burned seqs", got)
	}
}

func TestOneCallMaySpanStreamsAndCountersAreIndependent(t *testing.T) {
	// The ingest writer appends one hot and one cold row per message. Each
	// stream is its own chain (Decision 13), so both rows carry counter 1 and
	// the unique index must tolerate that because it includes the stream.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	hot, _ := mustSeal(t, u, "ingest", blob.StreamHot, 1, blob.ZeroHash)
	cold, _ := mustSeal(t, u, "ingest", blob.StreamCold, 1, blob.ZeroHash)
	seqs, err := a.Append(bg, []Row{hot, cold})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seqs, []int64{1, 2}) {
		t.Fatalf("got %v, want [1 2]", seqs)
	}

	var streams []string
	rows, err := pool.Query(bg, `SELECT stream FROM op_log WHERE user_id=$1 ORDER BY seq`, u)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		streams = append(streams, s)
	}
	if !reflect.DeepEqual(streams, []string{blob.StreamHot, blob.StreamCold}) {
		t.Fatalf("streams = %v", streams)
	}
}

func TestSeqRowExistsBeforeTheFirstAppend(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d before any append, want 1", got)
	}
}

func TestEnsureSeqRowIsIdempotent(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	if _, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 2)); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)
	if err := EnsureSeqRow(bg, tx, u); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}
	// A second EnsureSeqRow must not reset the counter to 1 — that would hand
	// the next append a seq that already exists.
	if got := nextSeqOf(t, pool, u); got != 3 {
		t.Fatalf("next_seq = %d after a repeat EnsureSeqRow, want 3", got)
	}
}

func TestAppendCreatesTheSeqRowWhenItIsMissing(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUserWithoutSeqRow(t, pool)
	a := &Appender{Pool: pool}
	seqs, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 2))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seqs, []int64{1, 2}) {
		t.Fatalf("got %v, want [1 2]", seqs)
	}
}

func TestSeqIsPerUser(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	u1, u2 := insertUser(t, pool), insertUser(t, pool)
	for i := int64(1); i <= 3; i++ {
		for _, u := range []uuid.UUID{u1, u2} {
			seqs, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, i, 1))
			if err != nil {
				t.Fatal(err)
			}
			if seqs[0] != i {
				t.Fatalf("user %s got seq %d, want %d", u, seqs[0], i)
			}
		}
	}
	assertGapFree(t, pool, u1, 3)
	assertGapFree(t, pool, u2, 3)
}

func TestAppendRejectsMixedUsers(t *testing.T) {
	pool := pgtest.New(t)
	u1, u2 := insertUser(t, pool), insertUser(t, pool)
	a := &Appender{Pool: pool}
	mixed := append(rowsFor(t, u1, "dev-a", blob.StreamHot, 1, 1), rowsFor(t, u2, "dev-a", blob.StreamHot, 1, 1)...)
	if _, err := a.Append(bg, mixed); err == nil {
		t.Fatal("expected two user_ids in one call to be rejected")
	}
	if got := len(seqsOf(t, pool, u1)); got != 0 {
		t.Fatalf("rejected call still wrote %d rows", got)
	}
}

func TestAppendRejectsAnUnknownUser(t *testing.T) {
	pool := pgtest.New(t)
	a := &Appender{Pool: pool}
	ghost := uuid.New()
	if _, err := a.Append(bg, rowsFor(t, ghost, "dev-a", blob.StreamHot, 1, 1)); err == nil {
		t.Fatal("expected an append for a nonexistent user to be rejected")
	}
}

func TestAppendOfNothingIsANoOp(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	seqs, err := a.Append(bg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(seqs) != 0 {
		t.Fatalf("got %v, want no seqs", seqs)
	}
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d, want 1 — an empty append consumed a seq", got)
	}
}

func TestAppendRejectsMalformedRows(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	good, _ := mustSeal(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash)

	mutate := func(f func(r *Row)) []Row {
		r := good
		r.Blob = append([]byte(nil), good.Blob...)
		r.BlobHash = append([]byte(nil), good.BlobHash...)
		r.PrevHash = append([]byte(nil), good.PrevHash...)
		f(&r)
		return []Row{r}
	}

	cases := []struct {
		name string
		rows []Row
	}{
		{"zero user", mutate(func(r *Row) { r.UserID = uuid.Nil })},
		{"unknown stream", mutate(func(r *Row) { r.Stream = "hott" })},
		{"empty stream", mutate(func(r *Row) { r.Stream = "" })},
		{"empty writer", mutate(func(r *Row) { r.WriterID = "" })},
		{"zero counter", mutate(func(r *Row) { r.WriterCounter = 0 })},
		{"negative counter", mutate(func(r *Row) { r.WriterCounter = -1 })},
		{"unknown type flag", mutate(func(r *Row) { r.TypeFlag = "ingested" })},
		{"empty blob", mutate(func(r *Row) { r.Blob = nil })},
		{"blob is not a bucket", mutate(func(r *Row) { r.Blob = r.Blob[:len(r.Blob)-1] })},
		{"size bucket disagrees with blob", mutate(func(r *Row) { r.SizeBucket = 4 << 10 })},
		{"short blob hash", mutate(func(r *Row) { r.BlobHash = r.BlobHash[:31] })},
		{"short prev hash", mutate(func(r *Row) { r.PrevHash = r.PrevHash[:31] })},
		{"caller-assigned seq", mutate(func(r *Row) { r.Seq = 7 })},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := a.Append(bg, c.rows); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
	// Validation runs before anything is allocated, so none of the above may
	// have moved the counter.
	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d after only-invalid appends, want 1", got)
	}
	assertGapFree(t, pool, u, 0)
}

func TestMaxSeq(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	got, err := a.MaxSeq(bg, u)
	if err != nil {
		t.Fatal(err)
	}
	if got != 0 {
		t.Fatalf("MaxSeq = %d before any append, want 0", got)
	}
	if _, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 4)); err != nil {
		t.Fatal(err)
	}
	if got, err = a.MaxSeq(bg, u); err != nil {
		t.Fatal(err)
	} else if got != 4 {
		t.Fatalf("MaxSeq = %d, want 4", got)
	}
}

func TestStoredRowRoundTripsAndTheBlobStillOpens(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	before := time.Now().Add(-time.Second)
	in, _ := mustSeal(t, u, "ingest", blob.StreamCold, 1, blob.ZeroHash)
	if _, err := a.Append(bg, []Row{in}); err != nil {
		t.Fatal(err)
	}

	var out Row
	err := pool.QueryRow(bg, `SELECT user_id, seq, stream, writer_id, writer_counter,
		type_flag, blob, size_bucket, blob_hash, prev_hash, created_at
		FROM op_log WHERE user_id=$1 AND seq=1`, u).Scan(
		&out.UserID, &out.Seq, &out.Stream, &out.WriterID, &out.WriterCounter,
		&out.TypeFlag, &out.Blob, &out.SizeBucket, &out.BlobHash, &out.PrevHash, &out.CreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	if out.Seq != 1 || out.Stream != blob.StreamCold || out.WriterID != "ingest" ||
		out.WriterCounter != 1 || out.TypeFlag != TypeFlagIngest || out.SizeBucket != in.SizeBucket {
		t.Fatalf("row round-tripped wrong: %+v", out)
	}
	if out.CreatedAt.Before(before) || out.CreatedAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf("created_at = %v, want ~now", out.CreatedAt)
	}
	// The bytes must still open at the position the row records — that is what
	// makes the AAD binding meaningful once the row has been through Postgres.
	plain, err := blob.PlaintextSealer{}.Open(blob.Envelope{
		UserID: out.UserID, Stream: out.Stream, WriterID: out.WriterID, WriterCounter: out.WriterCounter,
	}, blob.Sealed{Bytes: out.Blob, SizeBucket: out.SizeBucket})
	if err != nil {
		t.Fatalf("stored blob does not open: %v", err)
	}
	if string(plain) != `{"writer":"ingest","stream":"cold","counter":1}` {
		t.Fatalf("plaintext = %s", plain)
	}
}

func TestCallerSuppliedCreatedAtIsHonoured(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	want := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	r, _ := mustSeal(t, u, "dev-a", blob.StreamHot, 1, blob.ZeroHash)
	r.CreatedAt = want
	if _, err := a.Append(bg, []Row{r}); err != nil {
		t.Fatal(err)
	}
	var got time.Time
	if err := pool.QueryRow(bg, `SELECT created_at FROM op_log WHERE user_id=$1 AND seq=1`, u).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(want) {
		t.Fatalf("created_at = %v, want %v", got, want)
	}
}

// The database is the backstop for anything that bypasses Append's own
// validation — a psql session, a future task's hand-written INSERT, a bug.
func TestDatabaseConstraintsBackstopTheGoValidation(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	if _, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 1)); err != nil {
		t.Fatal(err)
	}

	ins := `INSERT INTO op_log (user_id, seq, stream, writer_id, writer_counter,
		type_flag, blob, size_bucket, blob_hash, prev_hash)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`

	// The baseline is a REAL sealed row, so every case below is rejected for the
	// one thing it mutates. An earlier version of this test used a one-byte blob
	// for every case; once the blob and hash CHECKs existed, those rows would
	// have been rejected for the wrong reason and the test would still have been
	// green.
	base, _ := mustSeal(t, u, "dev-b", blob.StreamHot, 1, blob.ZeroHash)
	type row struct {
		seq                  int64
		stream, writer, flag string
		counter              int64
		blb, bhash, phash    []byte
		bucket               int
	}
	valid := func() row {
		return row{seq: 2, stream: blob.StreamHot, writer: "dev-b", flag: TypeFlagIngest,
			counter: 1, blb: base.Blob, bhash: base.BlobHash, phash: base.PrevHash, bucket: base.SizeBucket}
	}
	exec := func(r row) error {
		_, err := pool.Exec(bg, ins, u, r.seq, r.stream, r.writer, r.counter, r.flag,
			r.blb, r.bucket, r.bhash, r.phash)
		return err
	}

	cases := []struct {
		name       string
		mutate     func(*row)
		constraint string
	}{
		{"duplicate seq", func(r *row) { r.seq = 1 }, "op_log_pkey"},
		{"unknown stream", func(r *row) { r.stream = "warm" }, "op_log_stream_check"},
		{"unknown type flag", func(r *row) { r.flag = "ingested" }, "op_log_type_flag_check"},
		{"duplicate (writer, stream, counter)", func(r *row) { r.writer = "dev-a" },
			"op_log_user_id_writer_id_stream_writer_counter_key"},
		{"blob shorter than its bucket", func(r *row) { r.blb = r.blb[:len(r.blb)-1] },
			"op_log_blob_fills_bucket"},
		{"size_bucket disagrees with the blob", func(r *row) { r.bucket = 4 << 10 },
			"op_log_blob_fills_bucket"},
		{"blob hash is not 32 bytes", func(r *row) { r.bhash = r.bhash[:31] },
			"op_log_hashes_are_sha256"},
		{"prev hash is not 32 bytes", func(r *row) { r.phash = append(r.phash, 0) },
			"op_log_hashes_are_sha256"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := valid()
			c.mutate(&r)
			err := exec(r)
			if err == nil {
				t.Fatal("expected the database to reject this row")
			}
			// Assert WHICH constraint fired. Without this a row could be
			// rejected for an unrelated reason and still read as coverage.
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) {
				t.Fatalf("want a PgError, got %T: %v", err, err)
			}
			if pgErr.ConstraintName != c.constraint {
				t.Fatalf("rejected by %q, want %q: %v", pgErr.ConstraintName, c.constraint, err)
			}
		})
	}

	// The unmutated baseline must be accepted, or every case above could be
	// passing for a reason none of them names.
	if err := exec(valid()); err != nil {
		t.Fatalf("the baseline row must be accepted: %v", err)
	}
	// Same counter on the OTHER stream is legal: chains are per (writer, stream).
	cold, _ := mustSeal(t, u, "dev-a", blob.StreamCold, 1, blob.ZeroHash)
	r := valid()
	r.seq, r.stream, r.writer = 3, blob.StreamCold, "dev-a"
	r.blb, r.bhash, r.phash, r.bucket = cold.Blob, cold.BlobHash, cold.PrevHash, cold.SizeBucket
	if err := exec(r); err != nil {
		t.Fatalf("the cold chain must be able to reuse counter 1: %v", err)
	}
}

func TestAnAbandonedTransactionReturnsItsSeqs(t *testing.T) {
	// The thesis of this design, isolated: an allocation lives and dies with
	// the transaction that made it. This drives appendTx directly and then
	// rolls back by hand, which is what a crashed process, a cancelled request
	// or a dropped connection amounts to.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	seqs, err := a.appendTx(bg, tx, u, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 3))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(seqs, []int64{1, 2, 3}) {
		t.Fatalf("in-transaction seqs = %v, want [1 2 3]", seqs)
	}
	if err := tx.Rollback(bg); err != nil {
		t.Fatal(err)
	}

	if got := nextSeqOf(t, pool, u); got != 1 {
		t.Fatalf("next_seq = %d after a rolled-back allocation, want 1", got)
	}
	got, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	if got[0] != 1 {
		t.Fatalf("the next append got seq %d, want 1 — the abandoned transaction burned seqs", got[0])
	}
	assertGapFree(t, pool, u, 1)
}

func TestACorruptedCounterFailsLoudlyRatherThanOverwritingHistory(t *testing.T) {
	// Deleting the counter row is the one way to make Append propose a seq that
	// already exists. The (user_id, seq) primary key must turn that into an
	// error, never a silent overwrite of a committed op.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}
	if _, err := a.Append(bg, rowsFor(t, u, "dev-a", blob.StreamHot, 1, 2)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bg, `DELETE FROM oplog_seq WHERE user_id=$1`, u); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Append(bg, rowsFor(t, u, "dev-b", blob.StreamHot, 1, 1)); err == nil {
		t.Fatal("a reset counter must not be allowed to reuse a committed seq")
	}
	// The two original rows are untouched and still contiguous.
	assertGapFree(t, pool, u, 2)
}

func TestAppendPinsReadCommittedRegardlessOfTheDatabaseDefault(t *testing.T) {
	// default_transaction_isolation is settable per database, per role and by a
	// pooler's startup parameters. Under `repeatable read` the counter UPDATE
	// raises serialization failures instead of blocking and re-evaluating, so
	// concurrent appends fail en masse — an availability failure that depends on
	// configuration nothing in this repo controls. Append must pin its own
	// isolation level rather than inherit one.
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	a := &Appender{Pool: pool}

	var dbName string
	if err := pool.QueryRow(bg, `SELECT current_database()`).Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(bg,
		`ALTER DATABASE `+dbName+` SET default_transaction_isolation = 'repeatable read'`); err != nil {
		t.Fatal(err)
	}
	// The setting is applied at session start, so existing pooled connections
	// still carry the old default until they are replaced.
	pool.Reset()

	// Vacuity guard: prove the default really changed, i.e. that an UNPINNED
	// transaction on this pool would not be read committed. Without this the
	// test could pass against a database whose default never moved.
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	var iso string
	if err := tx.QueryRow(bg, `SHOW transaction_isolation`).Scan(&iso); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(bg)
	if iso != "repeatable read" {
		t.Fatalf("unpinned transaction_isolation = %q; the test premise does not hold", iso)
	}

	const writers, perWriter = 6, 10
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			id := fmt.Sprintf("dev-%d", w)
			prev := blob.ZeroHash
			for c := 1; c <= perWriter; c++ {
				r, h, err := sealRow(u, id, blob.StreamHot, int64(c), prev)
				if err != nil {
					t.Errorf("%s counter %d: seal: %v", id, c, err)
					return
				}
				prev = h
				if _, err := a.Append(bg, []Row{r}); err != nil {
					t.Errorf("%s counter %d: append: %v", id, c, err)
					return
				}
			}
		}(w)
	}
	wg.Wait()
	assertGapFree(t, pool, u, writers*perWriter)
}
