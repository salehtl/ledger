package oplog

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/blob"
)

// This file is the READ half of the log: what a syncing device pulls, and the
// compact hash list it uses to audit a stream it has not downloaded.
//
// # Per-stream cursors, and why a sparse seq is not a gap
//
// seq is one per-user total order spanning BOTH streams, so a hot-only pull
// legitimately observes 1, 3, 5, … The client's cursor is therefore per stream:
// `after` is the largest seq it has seen ON THAT STREAM, and the response's
// `next` is the largest seq returned for that stream. Nothing about the holes
// is recoverable from the seqs themselves, and nothing needs to be — gap
// detection is the writer chain's job (spec §3.3:65), and Task 8 made chains
// per (writer_id, stream), so within one stream the counters ARE contiguous and
// self-verifying.
//
// # Why no watermark
//
// seq allocation takes the user's counter row lock as the first statement of
// the append transaction and holds it until commit (append.go), so commit order
// is identical to seq order and a committed seq N implies every seq below N is
// committed. The unfiltered log a reader sees is therefore always a contiguous
// committed PREFIX, never a prefix with holes waiting to be filled in — and a
// stream filter over a contiguous prefix is itself complete for that stream. A
// published watermark would be reconstructing a guarantee the counter row
// already provides. Do not add one.
//
// # What these reads do NOT prove
//
// Everything here is served by the server, from bytes the server holds.
// [VerifyChain] over the result proves only that what was served is a
// consistent continuation of the head the client gave it: a truncation, a
// re-chained interior drop, a wholly alternative history and equivocation
// between two devices all verify. Detecting those needs a head pinned
// INDEPENDENTLY of this response — a device's own persisted head, or spec
// §3.3(c)'s writer_checkpoint op (plan invariant I11_roster_checkpoint). Nothing
// in this file narrows that, and no caller may present a clean pull as evidence
// that the server served everything.

// ErrUnknownStream is returned for a stream that is neither hot nor cold. It is
// its own error because these functions are reached directly from an HTTP query
// parameter, where "you asked for a stream that does not exist" is a 400 and a
// database failure is not.
var ErrUnknownStream = errors.New("oplog: unknown stream")

// HashRow is one entry of spec §3.3:72's compact per-blob hash list: enough to
// audit a stream's chain LINKS and to pin what a later range fetch must return,
// without downloading a single blob body.
//
// PrevHash is carried as well as BlobHash, which the first sketch of this list
// omitted. Without it the list is not checkable at all without the bodies — the
// chain rule hashes bytes the caller deliberately did not fetch — whereas with
// it a client can verify, offline and for the whole cold stream, that entry n's
// prev_hash is entry n-1's blob_hash and that entry 1 links to blob.ZeroHash.
// That is the check that makes the list worth serving, and it costs 32 bytes.
//
// It remains a strictly weaker check than [VerifyChain]: the hashes are the
// SERVER's, not recomputed from bytes, so a server that rewrites a body and its
// hash together produces a list that links perfectly. What the list detects is
// a missing or reordered entry, and what it gives a client is a value to hold a
// later body fetch to.
type HashRow struct {
	Seq           int64
	Stream        string
	WriterID      string
	WriterCounter int64
	BlobHash      []byte // 32 bytes
	PrevHash      []byte // 32 bytes
}

// readPageSQL is the paged read, with the byte budget applied IN THE DATABASE.
//
// The obvious implementation — LIMIT in SQL, budget in Go — bounds what this
// process retains and nothing else: pgx drains a result set it stops scanning
// (rows.Close reads to ReadyForQuery so the connection stays usable), so
// Postgres would still send every row LIMIT selected. At the plan's page size
// and this table's 1 MB rows that is half a gigabyte on the wire to discard 98%
// of it.
//
// The window sum runs over size_bucket, which is a plain int column, so
// filtering on it never touches the blob: a row the outer WHERE discards is
// never detoasted and never serialized. `running` is monotone because seq is
// unique per user, so `running <= $5` always selects a PREFIX — a page with a
// hole in it would be far worse than a page that is too big.
//
// `rn = 1` is what guarantees forward progress: without it a single blob larger
// than the budget would return an empty page forever and the client's cursor
// could never pass it.
const readPageSQL = `
SELECT seq, stream, writer_id, writer_counter, type_flag,
       blob, size_bucket, blob_hash, prev_hash, created_at
  FROM (
    SELECT seq, stream, writer_id, writer_counter, type_flag,
           blob, size_bucket, blob_hash, prev_hash, created_at,
           sum(size_bucket) OVER (ORDER BY seq) AS running,
           row_number()     OVER (ORDER BY seq) AS rn
      FROM op_log
     WHERE user_id = $1 AND stream = $2 AND seq > $3
     ORDER BY seq
     LIMIT $4
  ) page
 WHERE page.rn = 1 OR page.running <= $5
 ORDER BY page.seq`

// Read returns up to limit rows of one stream for one user with seq > after, in
// seq order, stopping early once the accumulated blob bytes would exceed
// maxBytes.
//
// # The byte budget is not optional
//
// A row's blob can be a full megabyte (blob.MaxBucket), so a row count alone
// bounds nothing useful: at the plan's own page size the server would buffer
// half a gigabyte for one request, chosen by an unauthenticated-until-resolved
// caller. maxBytes is a parameter rather than a constant so it is testable and
// so the HTTP layer can size it against the response it is willing to write.
//
// The budget NEVER returns zero rows when rows exist: the first row is always
// included, whatever its size. A budget that could refuse the head of the
// stream would leave a client permanently unable to advance its cursor past one
// large blob — a livelock, and a silent one.
//
// A caller cannot distinguish "the page ended because of the budget" from "the
// stream ended" by counting rows, and must not try: ask [StreamMaxSeq] whether
// there is more.
func Read(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, stream string, after int64, limit, maxBytes int) ([]Row, error) {
	if err := checkStream(stream); err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, errors.New("oplog: read: pool is nil")
	}
	if limit < 1 {
		limit = 1
	}
	if maxBytes < 1 {
		maxBytes = 1
	}
	q, err := pool.Query(ctx, readPageSQL, userID, stream, after, limit, int64(maxBytes))
	if err != nil {
		return nil, fmt.Errorf("oplog: read %s log for user %s: %w", stream, userID, err)
	}
	defer q.Close()

	var (
		out   []Row
		total int
	)
	for q.Next() {
		var r Row
		r.UserID = userID
		if err := q.Scan(&r.Seq, &r.Stream, &r.WriterID, &r.WriterCounter, &r.TypeFlag,
			&r.Blob, &r.SizeBucket, &r.BlobHash, &r.PrevHash, &r.CreatedAt); err != nil {
			return nil, fmt.Errorf("oplog: read %s log for user %s: %w", stream, userID, err)
		}
		if len(out) > 0 && total+len(r.Blob) > maxBytes {
			// Belt to readPageSQL's braces. The database already applied this
			// budget; if an edit to that query ever stops doing so, the process
			// still refuses to accumulate more than it promised.
			break
		}
		total += len(r.Blob)
		out = append(out, r)
	}
	if err := q.Err(); err != nil {
		return nil, fmt.Errorf("oplog: read %s log for user %s: %w", stream, userID, err)
	}
	return out, nil
}

// Hashes returns the per-blob hash list for one stream, in seq order. It reads
// no blob bodies at all, which is the whole point: a client tracking the cold
// stream behind a rolling window (spec §3.3:70) can audit the chain's links and
// pin every blob's hash without fetching a byte of mail.
func Hashes(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, stream string, after int64, limit int) ([]HashRow, error) {
	if err := checkStream(stream); err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, errors.New("oplog: hashes: pool is nil")
	}
	if limit < 1 {
		limit = 1
	}
	q, err := pool.Query(ctx,
		`SELECT seq, stream, writer_id, writer_counter, blob_hash, prev_hash
		   FROM op_log
		  WHERE user_id = $1 AND stream = $2 AND seq > $3
		  ORDER BY seq
		  LIMIT $4`, userID, stream, after, limit)
	if err != nil {
		return nil, fmt.Errorf("oplog: read %s hashes for user %s: %w", stream, userID, err)
	}
	defer q.Close()

	var out []HashRow
	for q.Next() {
		var h HashRow
		if err := q.Scan(&h.Seq, &h.Stream, &h.WriterID, &h.WriterCounter, &h.BlobHash, &h.PrevHash); err != nil {
			return nil, fmt.Errorf("oplog: read %s hashes for user %s: %w", stream, userID, err)
		}
		out = append(out, h)
	}
	if err := q.Err(); err != nil {
		return nil, fmt.Errorf("oplog: read %s hashes for user %s: %w", stream, userID, err)
	}
	return out, nil
}

// StreamMaxSeq is the highest seq committed on one stream for one user, or 0.
//
// It is how a caller answers "is this client caught up", and it is deliberately
// a separate question from "did this page fill up". Inferring completeness from
// the page size is wrong the moment [Read]'s byte budget truncates a page, and
// wrong in the direction that matters: a client would believe it had the whole
// stream and stop.
//
// Run it AFTER the page, never before. Rows committed in between then make the
// answer "not complete" — a spurious extra round trip, which is the safe
// direction. The other order can report complete while rows exist.
func StreamMaxSeq(ctx context.Context, pool *pgxpool.Pool, userID uuid.UUID, stream string) (int64, error) {
	if err := checkStream(stream); err != nil {
		return 0, err
	}
	if pool == nil {
		return 0, errors.New("oplog: stream max seq: pool is nil")
	}
	var max int64
	err := pool.QueryRow(ctx,
		`SELECT coalesce(max(seq), 0) FROM op_log WHERE user_id = $1 AND stream = $2`,
		userID, stream).Scan(&max)
	if err != nil {
		return 0, fmt.Errorf("oplog: max %s seq for user %s: %w", stream, userID, err)
	}
	return max, nil
}

func checkStream(stream string) error {
	if stream != blob.StreamHot && stream != blob.StreamCold {
		return fmt.Errorf("%w: %q, want %q or %q", ErrUnknownStream, stream, blob.StreamHot, blob.StreamCold)
	}
	return nil
}
