package oplog

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"ledger/internal/v2/blob"
)

// Type flags. This is the whole vocabulary of op_log.type_flag, and it is
// deliberately coarse: spec §2 discloses only that SOMETHING was ingested or
// edited, never what. The op type itself lives inside the blob, which is
// plaintext in Phase 1 and ciphertext in Phase 3 — lifting it into a column
// would put it permanently outside the envelope.
const (
	// TypeFlagIngest marks a row the server wrote from inbound mail.
	TypeFlagIngest = "ingest"
	// TypeFlagEdit marks a row a client device authored.
	TypeFlagEdit = "edit"
)

// Row is one op_log row: a sealed blob plus the position it occupies. Seq is
// assigned by the server and is the ONLY field a caller may not set — Append
// rejects a row that arrives with one, because a caller that believes it can
// choose its own seq has misunderstood the ordering guarantee.
type Row struct {
	UserID        uuid.UUID
	Seq           int64  // server-assigned; zero on the way in, populated on reads
	Stream        string // blob.StreamHot or blob.StreamCold
	WriterID      string
	WriterCounter int64 // 1-based position within (writer_id, stream)
	TypeFlag      string
	Blob          []byte // the framed, bucket-padded bytes from blob.Sealed
	SizeBucket    int
	BlobHash      []byte // 32 bytes: blob.Hash(prev, sealed)
	PrevHash      []byte // 32 bytes: the previous blob hash in this (writer, stream) chain
	CreatedAt     time.Time
}

// validate rejects a row that could never be stored, or that could be stored
// and then never read back. It runs BEFORE the append transaction opens, so an
// invalid batch cannot even reach the counter — a validation failure therefore
// cannot leave a gap.
func (r Row) validate() error {
	switch {
	case r.UserID == uuid.Nil:
		return errors.New("user_id is zero")
	case r.Seq != 0:
		return fmt.Errorf("seq is server-assigned; leave it zero (got %d)", r.Seq)
	case r.Stream != blob.StreamHot && r.Stream != blob.StreamCold:
		return fmt.Errorf("stream is %q, want %q or %q", r.Stream, blob.StreamHot, blob.StreamCold)
	case r.WriterID == "":
		return errors.New("writer_id is empty")
	case r.WriterCounter < 1:
		return fmt.Errorf("writer_counter is %d, and counters are 1-based", r.WriterCounter)
	case r.TypeFlag != TypeFlagIngest && r.TypeFlag != TypeFlagEdit:
		return fmt.Errorf("type_flag is %q, want %q or %q", r.TypeFlag, TypeFlagIngest, TypeFlagEdit)
	case len(r.Blob) == 0:
		return errors.New("blob is empty")
	case len(r.BlobHash) != 32:
		return fmt.Errorf("blob_hash is %d bytes, want 32", len(r.BlobHash))
	case len(r.PrevHash) != 32:
		return fmt.Errorf("prev_hash is %d bytes, want 32", len(r.PrevHash))
	}
	// Every blob is padded to exactly a size bucket by blob.Seal, so a blob
	// whose length is not a bucket was not produced by the sealer and will not
	// survive blob.Open. Deriving the check from blob.BucketFor keeps the ladder
	// in one place instead of copying it here.
	bucket, err := blob.BucketFor(len(r.Blob))
	if err != nil {
		return fmt.Errorf("blob is %d bytes: %w", len(r.Blob), err)
	}
	if bucket != len(r.Blob) {
		return fmt.Errorf("blob is %d bytes, which is not a size bucket", len(r.Blob))
	}
	if r.SizeBucket != len(r.Blob) {
		return fmt.Errorf("size_bucket is %d but the blob is %d bytes", r.SizeBucket, len(r.Blob))
	}
	return nil
}

// Appender writes rows to the op log. It owns the one place a seq is ever
// allocated.
type Appender struct {
	Pool *pgxpool.Pool
}

// EnsureSeqRow creates a user's counter row. It is called from auth.UpsertUser
// INSIDE the user-creation transaction, so the row exists before that user's
// first append and Append's own INSERT ... ON CONFLICT DO NOTHING never runs in
// steady state.
//
// It takes a pgx.Tx rather than a pool deliberately: a counter row created in a
// separate transaction from the user could be committed while the user is not,
// or vice versa.
//
// ON CONFLICT DO NOTHING, not DO UPDATE: re-running this for an existing user
// must not reset next_seq. A reset would hand the next append a seq that
// already exists in op_log, which the (user_id, seq) primary key would then
// reject — recoverable, but it would stall that user's appends permanently.
func EnsureSeqRow(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	if userID == uuid.Nil {
		return errors.New("oplog: EnsureSeqRow: user_id is zero")
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO oplog_seq (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, userID); err != nil {
		return fmt.Errorf("oplog: ensure seq row: %w", err)
	}
	return nil
}

// Append allocates a contiguous block of seqs for one user and writes rows in
// the order given, returning the assigned seqs in that same order. Every row
// must carry the same UserID; rows MAY span streams, because the ingest writer
// appends one hot and one cold row per message.
//
// # Gap-freeness
//
// seq must be gap-free and monotone per user: spec §3.7 resolves FX rates by
// folding the log by seq, so a hole changes computed budget totals. The
// guarantee comes from the per-user counter ROW, not from a sequence:
//
//   - The UPDATE below locks oplog_seq for this user until the transaction
//     commits, so a second append for the same user cannot even allocate until
//     this one finishes. Commit order is therefore identical to seq order, and
//     a committed seq N implies every seq below N is committed.
//   - Rollback is the reason this beats a sequence. A rolled-back UPDATE
//     restores the counter, so a failed append consumes nothing. nextval()
//     burns its value permanently and a watermark then has to reconstruct which
//     values were lost versus merely slow.
//
// Do NOT replace this with a sequence plus a published watermark.
//
// # Accepted cost
//
// The row lock is held across the blob INSERT, so a 1 MB cold blob serialises
// this one user's inbound SMTP for the duration of that write. It is bounded,
// per-user, and cheaper than reconstructing gap-freeness elsewhere. This is a
// deliberate trade, not an oversight — see the plan's Decision 3.
func (a *Appender) Append(ctx context.Context, rows []Row) ([]int64, error) {
	if len(rows) == 0 {
		// Appending nothing must not touch the counter. Opening a transaction
		// to allocate a zero-length block would take the lock for no reason.
		return nil, nil
	}
	userID := rows[0].UserID
	for i, r := range rows {
		if r.UserID != userID {
			// One user per call is not a convenience restriction: a call
			// spanning two users would have to lock two counter rows, and two
			// such calls in opposite order would deadlock.
			return nil, fmt.Errorf("oplog: append: row %d belongs to user %s, row 0 to %s", i, r.UserID, userID)
		}
		if err := r.validate(); err != nil {
			return nil, fmt.Errorf("oplog: append: row %d: %w", i, err)
		}
	}

	tx, err := a.Pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("oplog: append: begin: %w", err)
	}
	defer func() {
		// Rolled back on a context detached from the caller's. If ctx is
		// already cancelled, tx.Rollback(ctx) fails immediately and pgx
		// destroys the connection; gap-freeness does not depend on this either
		// way (a destroyed connection makes the server abort the transaction,
		// which is exactly what restores the counter) but a clean rollback
		// returns the connection to the pool instead of burning it. The timeout
		// stops a wedged server from pinning the connection forever.
		rbCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rbCtx)
	}()

	seqs, err := a.appendTx(ctx, tx, userID, rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("oplog: append: commit: %w", err)
	}
	return seqs, nil
}

// appendTx is the body of an append, minus the transaction management. Task 8
// adds the per-(writer, stream) chain check between allocSeq and insertRows, so
// seq allocation stays in exactly one place for every append path.
//
// ORDERING RULE for anything added here: allocSeq must come FIRST, before any
// read of a writer's chain head. Reading the head before taking the counter
// lock lets two concurrent uploads from one writer both observe head=5 and race
// for counter 6; the UNIQUE (user_id, writer_id, stream, writer_counter)
// constraint would catch that, but as a constraint violation rather than a
// chain break — the wrong error to hand a client, and detection where the
// ordering could have made it impossible.
func (a *Appender) appendTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, rows []Row) ([]int64, error) {
	if err := EnsureSeqRow(ctx, tx, userID); err != nil {
		return nil, err
	}
	start, err := allocSeq(ctx, tx, userID, len(rows))
	if err != nil {
		return nil, err
	}
	seqs := make([]int64, len(rows))
	for i := range rows {
		seqs[i] = start + int64(i)
	}
	if err := insertRows(ctx, tx, rows, seqs); err != nil {
		return nil, err
	}
	return seqs, nil
}

const insertRowSQL = `INSERT INTO op_log
	(user_id, seq, stream, writer_id, writer_counter, type_flag,
	 blob, size_bucket, blob_hash, prev_hash, created_at)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce($11::timestamptz, now()))`

// allocSeq takes the user's counter lock and reserves n consecutive values,
// returning the first. It is the ONLY place a seq is ever allocated.
//
// The two statements are deliberately not folded into one
// `INSERT ... ON CONFLICT ... RETURNING`: with DO NOTHING, Postgres suppresses
// RETURNING output on the conflict path, so the common case (the row already
// exists, which is every append after the first) returns zero rows and the Scan
// fails with pgx.ErrNoRows. The DO UPDATE form avoids that but turns every
// append into a write to a row it did not need to insert. Two statements are
// boring and correct.
//
// RETURNING sees the row as UPDATEd, so `next_seq - $2` is the value next_seq
// held BEFORE this call — i.e. the first seq of the reserved block.
func allocSeq(ctx context.Context, tx pgx.Tx, userID uuid.UUID, n int) (int64, error) {
	var start int64
	err := tx.QueryRow(ctx,
		`UPDATE oplog_seq SET next_seq = next_seq + $2 WHERE user_id = $1 RETURNING next_seq - $2`,
		userID, int64(n)).Scan(&start)
	if err != nil {
		return 0, fmt.Errorf("oplog: allocate %d seqs for user %s: %w", n, userID, err)
	}
	return start, nil
}

func insertRows(ctx context.Context, tx pgx.Tx, rows []Row, seqs []int64) error {
	batch := &pgx.Batch{}
	for i, r := range rows {
		var createdAt *time.Time
		if !r.CreatedAt.IsZero() {
			t := r.CreatedAt
			createdAt = &t
		}
		batch.Queue(insertRowSQL, r.UserID, seqs[i], r.Stream, r.WriterID, r.WriterCounter,
			r.TypeFlag, r.Blob, r.SizeBucket, r.BlobHash, r.PrevHash, createdAt)
	}
	br := tx.SendBatch(ctx, batch)
	var firstErr error
	for i := range rows {
		if _, err := br.Exec(); err != nil && firstErr == nil {
			firstErr = fmt.Errorf("oplog: append: insert row %d (seq %d): %w", i, seqs[i], err)
		}
	}
	// Close must happen before the transaction is used again, and it reports any
	// error the per-statement Execs did not surface.
	if err := br.Close(); err != nil && firstErr == nil {
		firstErr = fmt.Errorf("oplog: append: insert batch: %w", err)
	}
	return firstErr
}

// MaxSeq is the highest seq committed for a user, or 0 if there are none.
//
// It reads op_log rather than oplog_seq.next_seq on purpose: next_seq counts
// allocations, including one an in-flight transaction may still roll back,
// while op_log counts what a reader can actually see. Because seq order equals
// commit order, the two agree whenever nothing is in flight, and when something
// is, this is the answer a sync cursor wants.
func (a *Appender) MaxSeq(ctx context.Context, userID uuid.UUID) (int64, error) {
	var max int64
	err := a.Pool.QueryRow(ctx,
		`SELECT coalesce(max(seq), 0) FROM op_log WHERE user_id = $1`, userID).Scan(&max)
	if err != nil {
		return 0, fmt.Errorf("oplog: max seq for user %s: %w", userID, err)
	}
	return max, nil
}
