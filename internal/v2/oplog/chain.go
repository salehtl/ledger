package oplog

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"ledger/internal/v2/blob"
)

// This file implements the per-(writer_id, stream) hash chains of spec §3.3.
//
// # The rule, frozen
//
// For each (writer_id, stream) INDEPENDENTLY:
//
//	blob_hash[n] = SHA256(blob_hash[n-1] || blob_bytes[n]),  blob_hash[0] = 32 zero bytes
//
// The hash covers the STORED bytes — the framed, padded envelope, which is
// plaintext in Phase 1 and ciphertext in Phase 3 — so the formula does not
// change when sealing turns on, and anyone holding the stored blob can
// recompute it, including a server that cannot read it. [blob.Hash] is the one
// implementation; the TypeScript port mirrors it and
// TestChainRuleIsPinnedByAGoldenVector pins the bytes both must produce.
//
// # Why per (writer, stream) and not per writer (Decision 13)
//
// The ingest writer appends a hot blob and a cold blob for the same email. A
// single chain per writer would interleave them, so a hot-only pull would see
// counters 1, 3, 5, … whose prev_hash values point at cold blobs the client
// deliberately did not fetch. Spec §3.3:70 makes the cold stream lazily synced
// behind a rolling client-side window, so those gaps are permanent and by
// design — the client would be unable to tell "I skipped cold on purpose" from
// "the server dropped an op". Splitting the chain per stream makes the hot
// chain self-verifying from hot rows alone and confines lazy verification to
// cold, where spec §3.3:72's per-blob hash list is the mechanism.
//
// # What these chains prove, and what they do NOT (spec §3.3(b))
//
// Read the Phase 1 caveat below before quoting either of these.
//
//   - A CLIENT writer's chain is computed on the device, over blobs sealed
//     under a key the server does not hold. ONCE THAT IS TRUE (Phase 3), the
//     server cannot forge it, so a server that drops or reorders that device's
//     ops is detected — by that device, and at sync by the user's other
//     devices. That is a real integrity claim about the operator.
//
//   - The INGEST writer's chain is computed by the server, over material the
//     server itself sealed. It proves storage and backup integrity — a blob
//     silently altered or lost after the fact is detectable — and it proves
//     NOTHING about operator honesty, in any phase. A compromised server can
//     fabricate a perfectly well-formed ingest chain of transactions that never
//     happened. Nothing in this file narrows that gap, and no caller may present
//     a valid ingest chain as evidence that the ingest history is genuine. It is
//     why the ingest writer has no key (auth.KindIngest) and why the client UI
//     labels server-ingested provenance distinctly.
//
// # What Phase 1 does NOT claim
//
// Phase 1 blobs are PLAINTEXT with a zero tag (blob's "What Phase 1 does NOT
// claim"). There is no DEK yet, so "the server cannot forge a client writer's
// chain" is a property of the finished system and NOT of what ships today: as
// built, the server could author a client writer's blobs and chain them
// flawlessly, and nothing here would notice. The chains are still worth
// building now, because their shape is what Phase 3 makes unforgeable and
// because they already detect accidental loss and reordering in storage — but
// a Phase 1 chain is evidence about mistakes, not about an adversary.
//
// What DOES hold in both phases: the chain is computed over the stored bytes,
// so the formula never changes; and Row.validate binds every blob to the
// position it is stored at, because the AAD is cleartext framing in both phases
// (blob.EmbeddedAAD).
//
// # Where the roster check lives (deliberately not here)
//
// A revoked or unknown writer must not be able to append. That decision needs
// auth.Writers.Roster, and auth imports this package (auth.UpsertUser calls
// EnsureSeqRow), so it cannot be made here without an import cycle. It belongs
// to the sync handler, which authenticates the session anyway; [Appender.AppendClient]
// therefore assumes its caller has already checked that writerID is a live
// writer of userID.

// ErrChainBreak means a writer's hash chain does not line up: a counter that
// skips, a prev_hash that does not match the row before it, or a blob_hash that
// is not SHA256(prev || bytes).
//
// It is a HARD STOP for a syncing client (spec §3.3:68) — the same class as
// oplog.ErrUnknownNewerVersion and deliberately NOT the same class as
// blob.ErrSetAside, which is a warning about one unreadable blob. Do not return
// it for anything less: a protocol mistake that costs nothing (a partially
// applied resend, say) must not raise a non-dismissable "your server may have
// tampered with your data" warning.
var ErrChainBreak = errors.New("writer hash chain break")

// IngestWriterID is the fixed writer id of every user's server-side writer.
// auth.IngestWriterID is defined as this constant so the two cannot drift: the
// string travels in op_log.writer_id and in every ingest blob's AAD, where a
// mismatch would strand rows under a writer that has no roster row.
const IngestWriterID = "ingest"

// The unique key that makes a (writer, stream, counter) position exclusive, and
// the SQLSTATE a collision on it raises. Named here because two code paths need
// to recognise exactly this violation and nothing else — see [isPositionTaken].
const (
	uniqueViolation    = "23505"
	positionConstraint = "op_log_user_id_writer_id_stream_writer_counter_key"
)

// errBatchAlreadyApplied unwinds the append transaction when the batch turns
// out to be a replay of rows that already committed. It never escapes
// AppendClient: the point is to roll back (returning the reserved seqs to the
// counter) and then answer with the seqs the rows already have.
var errBatchAlreadyApplied = errors.New("oplog: batch already applied")

// ErrPositionTaken means the database rejected a (writer, stream, counter) that
// the chain check had just approved. That combination is impossible while the
// ORDERING RULE on appendTx holds — the head is read under the counter lock, so
// a taken position is recognised as a replay before any INSERT — which is
// exactly why it is its own error and not ErrChainBreak.
//
// The distinction is load bearing in two directions. Down: ErrChainBreak is a
// client-facing sync hard stop (spec §3.3:68), and a server-side invariant
// violation must not masquerade as evidence that the operator dropped data. Up:
// if this error were folded into ErrChainBreak, reversing the two lines in
// appendTx would produce an identical error to the correct implementation and
// the ordering rule would become untestable.
var ErrPositionTaken = errors.New("oplog: chain position already held by different bytes")

// ErrPartiallyApplied means the batch STRADDLES the committed head: some of its
// rows are already stored and some are not. AppendClient refuses such a batch
// rather than trimming it (see that method's "Idempotent replay" section), and
// the remedy is the one this error states.
//
// It is deliberately NOT ErrChainBreak. A chain break is a sync hard stop with
// a non-dismissable "your server may have tampered with your data" warning
// (spec §3.3:68); a partial resend is a protocol mistake that costs nothing and
// has a trivial fix. Naming it is what lets the HTTP layer answer with that fix
// instead of an opaque 500 — the wording below is the client contract, quoted
// verbatim in the api package's doc and in the response body.
var ErrPartiallyApplied = errors.New("oplog: this batch is partly applied already: read the chain head and resend only the rows above it")

// querier is the read surface shared by *pgxpool.Pool and pgx.Tx, so the head
// read has ONE implementation whether it runs standalone or inside an append
// transaction. Two implementations would be two places for the chain rule to
// drift.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Head returns the highest committed counter of one (writer, stream) chain and
// its blob hash, or (0, blob.ZeroHash) when that chain has no rows yet — which
// is exactly the (counter, prev) a chain's first blob must be built against.
func (a *Appender) Head(ctx context.Context, userID uuid.UUID, writerID, stream string) (int64, [32]byte, error) {
	return headOf(ctx, a.Pool, userID, writerID, stream)
}

// headOf reads one chain head. Counters within a (writer, stream) are
// contiguous by construction, so the row with the largest counter IS the head;
// the UNIQUE (user_id, writer_id, stream, writer_counter) index serves this
// ordered lookup directly.
func headOf(ctx context.Context, q querier, userID uuid.UUID, writerID, stream string) (int64, [32]byte, error) {
	var (
		counter int64
		hash    []byte
	)
	err := q.QueryRow(ctx,
		`SELECT writer_counter, blob_hash FROM op_log
		  WHERE user_id = $1 AND writer_id = $2 AND stream = $3
		  ORDER BY writer_counter DESC LIMIT 1`, userID, writerID, stream).Scan(&counter, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, blob.ZeroHash, nil
	}
	if err != nil {
		return 0, blob.ZeroHash, fmt.Errorf("oplog: head of (%s, %s) for user %s: %w", writerID, stream, userID, err)
	}
	if len(hash) != 32 {
		return 0, blob.ZeroHash, fmt.Errorf("oplog: head of (%s, %s) for user %s: blob_hash is %d bytes", writerID, stream, userID, len(hash))
	}
	return counter, [32]byte(hash), nil
}

// VerifyChain reports whether rows are a contiguous, correctly hashed
// continuation of the chain head (fromCounter, fromHash) — use (0,
// blob.ZeroHash) to verify from genesis. Rows must be in counter order and all
// from one (writer_id, stream).
//
// This is the CLIENT's check. Every hash is RECOMPUTED from the row's stored
// bytes rather than read from the row, so a server that substitutes a blob
// cannot keep the chain intact by also editing the hash column.
//
// # Exactly what it detects, and what it cannot
//
// It detects any break RELATIVE TO (fromCounter, fromHash): an op missing from
// the middle, two ops served out of order, a substituted or edited blob, a
// forged prev_hash, a run that does not continue the head it was verified
// against, and rows from more than one (writer, stream) spliced together.
//
// It does NOT, by itself, detect a server that RE-CHAINS what it serves. A
// truncation (a genuine 1..5 served as 1..3) verifies. A whole alternative
// history, correctly chained from genesis, verifies. Both are caught only by
// comparing the head this function ends at against a head the verifier already
// trusts — which is what a persisted local head gives a returning device, what
// spec §3.3(c)'s writer_checkpoint op gives a device auditing a PEER's chain,
// and what plan invariant I11_roster_checkpoint enforces. Callers must not read
// "VerifyChain passed" as "the server served me everything"; it means "what the
// server served me is a consistent continuation of the head I gave it".
//
// Every failure wraps ErrChainBreak, including "these rows are not all from one
// writer and stream" — a caller that mixed them has a bug, but a SERVER that
// returned them has misbehaved (interleaving two writers with continuous
// counters and honestly recomputed hashes passes every other check here), and
// failing closed is the safe reading of an ambiguous input.
func VerifyChain(rows []Row, fromCounter int64, fromHash [32]byte) error {
	if len(rows) == 0 {
		return nil
	}
	writerID, stream := rows[0].WriterID, rows[0].Stream
	prev := fromHash
	want := fromCounter + 1
	for i, r := range rows {
		if r.WriterID != writerID || r.Stream != stream {
			return fmt.Errorf("%w: row %d is (%s, %s), but the chain is (%s, %s)",
				ErrChainBreak, i, r.WriterID, r.Stream, writerID, stream)
		}
		if r.WriterCounter != want {
			return fmt.Errorf("%w: (%s, %s) row %d has counter %d, want %d",
				ErrChainBreak, writerID, stream, i, r.WriterCounter, want)
		}
		if !bytes.Equal(r.PrevHash, prev[:]) {
			return fmt.Errorf("%w: (%s, %s) counter %d links to %x, but the chain is at %x",
				ErrChainBreak, writerID, stream, r.WriterCounter, r.PrevHash, prev)
		}
		got := blob.Hash(prev, blob.Sealed{Bytes: r.Blob, SizeBucket: r.SizeBucket})
		if !bytes.Equal(r.BlobHash, got[:]) {
			return fmt.Errorf("%w: (%s, %s) counter %d claims hash %x, but its bytes hash to %x",
				ErrChainBreak, writerID, stream, r.WriterCounter, r.BlobHash, got)
		}
		prev = got
		want++
	}
	return nil
}

// AppendClient appends one writer's blobs to one stream, verifying that they
// continue that (writer, stream) chain before anything is stored. The client
// authored these blobs and their hashes — the server only checks arithmetic it
// can redo from the stored bytes, which is all it is able to check without the
// key (and all it should be trusted to check).
//
// The caller must have established that writerID is a live, registered writer
// of userID; see the roster note at the top of this file.
//
// # Idempotent replay (the ambiguous-commit contract)
//
// appendRows documents that a deadline expiring during Commit returns an error
// for an append that may have committed. This is the method that makes a naive
// retry safe: a batch whose counters are at or below the committed head is a
// REPLAY, not a gap, so if every row's blob_hash matches what is already stored
// at that position the call returns those rows' original seqs and appends
// nothing. Byte-identical is the whole test — different bytes at an applied
// counter is a forked writer, which is ErrChainBreak.
//
// A batch that straddles the head (some rows applied, some not) is refused with
// a plain error rather than ErrChainBreak: the seq block is reserved for the
// whole batch before the head is known, so shrinking it mid-transaction would
// either burn a seq or unwind the counter, and neither is worth doing for a
// case the client can avoid by reading its head and resending only the rows
// above it.
func (a *Appender) AppendClient(ctx context.Context, userID uuid.UUID, writerID, stream string, rows []Row) ([]int64, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	if writerID == IngestWriterID {
		// The ingest writer is the server's own, and the client UI labels its
		// ops "server-ingested". A device allowed to append here would be
		// laundering its own ops into that provenance — the same reason
		// auth.Writers.Register reserves the id.
		return nil, fmt.Errorf("oplog: append client: %q is the server's own writer and is not client-writable", IngestWriterID)
	}
	if stream == blob.StreamCold {
		// Invariant I16: the cold stream carries raw email bodies and never
		// ops. Only the ingest writer produces those, so a client-authored cold
		// row would be an op blob on the stream a hot-only client skips —
		// exactly the thing that makes "hot-only sync is a COMPLETE
		// materialization" false.
		//
		// The stream PARAMETER still exists rather than being assumed: it is
		// what makes the position explicit in every AAD and lets a future
		// client-side cold producer arrive without a signature change. This
		// check is the thing that would then be revisited — deliberately, and
		// together with I16.
		return nil, fmt.Errorf("oplog: append client: the %q stream carries raw bodies from the ingest writer only (invariant I16)", blob.StreamCold)
	}

	// Copied, not mutated in place: a caller's slice is its own, and filling in
	// fields it left blank must not be visible to it as a side effect.
	batch := make([]Row, len(rows))
	copy(batch, rows)
	for i := range batch {
		r := &batch[i]
		// Zero means "as this call says"; a conflicting value means the caller
		// disagrees with itself, and guessing which half it meant is worse than
		// refusing.
		if r.UserID != uuid.Nil && r.UserID != userID {
			return nil, fmt.Errorf("oplog: append client: row %d names user %s, the call names %s", i, r.UserID, userID)
		}
		if r.WriterID != "" && r.WriterID != writerID {
			return nil, fmt.Errorf("oplog: append client: row %d names writer %q, the call names %q", i, r.WriterID, writerID)
		}
		if r.Stream != "" && r.Stream != stream {
			return nil, fmt.Errorf("oplog: append client: row %d names stream %q, the call names %q", i, r.Stream, stream)
		}
		r.UserID, r.WriterID, r.Stream = userID, writerID, stream
		if r.TypeFlag == "" {
			r.TypeFlag = TypeFlagEdit
		}
		if r.TypeFlag != TypeFlagEdit {
			// type_flag is the provenance column. TypeFlagIngest means "the
			// server wrote this from inbound mail", which a device writer's row
			// is by definition not.
			return nil, fmt.Errorf("oplog: append client: row %d has type_flag %q, want %q", i, r.TypeFlag, TypeFlagEdit)
		}
		if err := r.validate(); err != nil {
			return nil, fmt.Errorf("oplog: append client: row %d: %w", i, err)
		}
	}
	// Everything checkable without the database is checked before the counter
	// is touched: the links WITHIN the batch and every recomputed hash. Only
	// the join to the stored head needs the append transaction, and it is the
	// one thing that must be read under the counter lock.
	var claimedPrev [32]byte
	copy(claimedPrev[:], batch[0].PrevHash)
	if err := VerifyChain(batch, batch[0].WriterCounter-1, claimedPrev); err != nil {
		return nil, err
	}

	var replayed []int64
	prepare := func(ctx context.Context, tx pgx.Tx, rows []Row) error {
		headCounter, headHash, err := headOf(ctx, tx, userID, writerID, stream)
		if err != nil {
			return err
		}
		if rows[0].WriterCounter <= headCounter {
			seqs, err := appliedSeqs(ctx, tx, userID, writerID, stream, rows)
			if err != nil {
				return err
			}
			replayed = seqs
			return errBatchAlreadyApplied
		}
		if rows[0].WriterCounter != headCounter+1 {
			return fmt.Errorf("%w: (%s, %s) is at counter %d, this batch starts at %d",
				ErrChainBreak, writerID, stream, headCounter, rows[0].WriterCounter)
		}
		if !bytes.Equal(rows[0].PrevHash, headHash[:]) {
			return fmt.Errorf("%w: (%s, %s) counter %d links to %x, but the stored head is %x",
				ErrChainBreak, writerID, stream, rows[0].WriterCounter, rows[0].PrevHash, headHash)
		}
		return nil
	}

	seqs, err := a.appendRows(ctx, batch, prepare)
	if errors.Is(err, errBatchAlreadyApplied) {
		return replayed, nil
	}
	return a.resolveAppendErr(ctx, userID, writerID, stream, batch, seqs, err)
}

// resolveAppendErr turns the outcome of appendRows into AppendClient's answer.
//
// It is a separate function so its SQLSTATE 23505 arm can be tested. That arm
// is unreachable in a correct build — the head is read under the counter lock,
// so a taken position is recognised as a replay before any INSERT, and
// headOf returns max(writer_counter), so a position that passes the head check
// cannot already exist. It is implemented anyway because the alternative is
// handing a client a raw duplicate-key error it cannot act on (the
// ambiguous-commit contract on appendRows names this SQLSTATE explicitly), and
// because an edit that reverses the ordering rule must fail loudly rather than
// corrupt anything. Splitting it out beat the alternative of a test-only hook
// in the production path.
func (a *Appender) resolveAppendErr(ctx context.Context, userID uuid.UUID, writerID, stream string, batch []Row, seqs []int64, err error) ([]int64, error) {
	switch {
	case err == nil:
		return seqs, nil
	case isPositionTaken(err):
		applied, resolveErr := appliedSeqs(ctx, a.Pool, userID, writerID, stream, batch)
		if resolveErr != nil {
			// Deliberately NOT wrapped with %w: resolveErr may be
			// ErrChainBreak, and a client must not be hard-stopped by a
			// server-side invariant violation. See ErrPositionTaken.
			return nil, fmt.Errorf("%w: (%s, %s): %v", ErrPositionTaken, writerID, stream, resolveErr)
		}
		return applied, nil
	default:
		return nil, err
	}
}

// IngestBlob is one blob the SERVER authors: its plaintext and the stream it
// belongs to. The counter, the chain hashes and the framing are all computed by
// AppendIngest.
//
// It carries plaintext rather than a sealed blob on purpose. blob.Envelope's
// AAD binds writer_counter, so the bytes depend on the position — and the
// position is not known until the append transaction holds the user's counter
// lock. A caller that sealed first would have to guess its counter, and a wrong
// guess stores a blob that can never be opened at the position it occupies
// (blob.ErrAADMismatch), permanently and silently. Sealing inside the
// transaction removes the guess.
type IngestBlob struct {
	Stream    string // blob.StreamHot or blob.StreamCold
	Plaintext []byte
	// CreatedAt is the message's received time. Zero means now().
	CreatedAt time.Time
}

// AppendIngest appends the server's own blobs under the ingest writer,
// computing each one's counter and chain hash PER STREAM: a call carrying a hot
// and a cold blob for the same email gets the next hot counter and the next
// cold counter, which are two independent numbers and usually not consecutive
// (Decision 13).
//
// What the resulting chain proves is stated at the top of this file and is
// worth repeating at the call site: it is evidence about storage integrity, not
// about the operator. A compromised server can produce a flawless ingest chain
// over transactions that never existed.
//
// AppendIngest is NOT idempotent — it cannot be, since it assigns the counters.
// A redelivered message appended twice becomes two well-chained ops. Dedup is
// by ingest identity (spec §3.3:67) and belongs to the pipeline, which checks
// for the ingest id before calling this.
//
// Accepted cost: sealing happens inside the append transaction, so gzip of a
// ~1 MB cold body runs while the user's counter row is locked. That is the same
// trade appendRows already documents for the blob INSERT — bounded, per-user,
// and the price of not guessing a counter.
func (a *Appender) AppendIngest(ctx context.Context, userID uuid.UUID, blobs []IngestBlob) ([]int64, error) {
	if len(blobs) == 0 {
		return nil, nil
	}
	rows := make([]Row, len(blobs))
	for i, b := range blobs {
		if b.Stream != blob.StreamHot && b.Stream != blob.StreamCold {
			return nil, fmt.Errorf("oplog: append ingest: blob %d has stream %q, want %q or %q", i, b.Stream, blob.StreamHot, blob.StreamCold)
		}
		if len(b.Plaintext) == 0 {
			return nil, fmt.Errorf("oplog: append ingest: blob %d is empty", i)
		}
		if len(b.Plaintext) > blob.MaxPlaintext {
			return nil, fmt.Errorf("oplog: append ingest: blob %d is %d bytes, cap is %d", i, len(b.Plaintext), blob.MaxPlaintext)
		}
		rows[i] = Row{
			UserID:    userID,
			Stream:    b.Stream,
			WriterID:  IngestWriterID,
			TypeFlag:  TypeFlagIngest,
			CreatedAt: b.CreatedAt,
		}
	}

	sealer := a.sealer()
	prepare := func(ctx context.Context, tx pgx.Tx, rows []Row) error {
		// One head per stream, advanced as the batch is built, so two rows on
		// the same stream in one call chain to each other rather than both
		// claiming the same counter.
		type head struct {
			counter int64
			hash    [32]byte
		}
		heads := make(map[string]head, 2)
		for i := range rows {
			h, ok := heads[rows[i].Stream]
			if !ok {
				c, hh, err := headOf(ctx, tx, userID, IngestWriterID, rows[i].Stream)
				if err != nil {
					return err
				}
				h = head{counter: c, hash: hh}
			}
			counter := h.counter + 1
			sealed, err := sealer.Seal(blob.Envelope{
				UserID: userID, Stream: rows[i].Stream, WriterID: IngestWriterID, WriterCounter: counter,
			}, blobs[i].Plaintext)
			if err != nil {
				return fmt.Errorf("oplog: append ingest: seal blob %d: %w", i, err)
			}
			hash := blob.Hash(h.hash, sealed)
			prev := h.hash
			rows[i].WriterCounter = counter
			rows[i].Blob = sealed.Bytes
			rows[i].SizeBucket = sealed.SizeBucket
			rows[i].PrevHash = prev[:]
			rows[i].BlobHash = hash[:]
			heads[rows[i].Stream] = head{counter: counter, hash: hash}
		}
		return nil
	}
	return a.appendRows(ctx, rows, prepare)
}

// sealer is the Phase 3 swap point for the ingest path: today it frames,
// compresses and pads; then it will encrypt to the user's public key. Nothing
// else in this file changes on that day, because the chain hashes the stored
// bytes either way.
func (a *Appender) sealer() blob.Sealer {
	if a.Sealer != nil {
		return a.Sealer
	}
	return blob.PlaintextSealer{}
}

// appliedSeqs resolves a batch that appears to have been stored already: it
// returns each row's committed seq when EVERY row is present at its position
// with byte-identical content.
//
//   - A position holding different bytes is a forked writer — two devices
//     sharing one writer id, or a device that lost state and reused counters —
//     and that is a genuine ErrChainBreak.
//   - A position that is not stored at all means the batch is only partly
//     applied. That is a protocol mistake with a trivial fix, so it is a plain
//     error: reporting it as a chain break would hard-stop the client's sync
//     over nothing (spec §3.3:68).
func appliedSeqs(ctx context.Context, q querier, userID uuid.UUID, writerID, stream string, rows []Row) ([]int64, error) {
	counters := make([]int64, len(rows))
	for i, r := range rows {
		counters[i] = r.WriterCounter
	}
	q1, err := q.Query(ctx,
		`SELECT writer_counter, seq, blob_hash FROM op_log
		  WHERE user_id = $1 AND writer_id = $2 AND stream = $3 AND writer_counter = ANY($4)`,
		userID, writerID, stream, counters)
	if err != nil {
		return nil, fmt.Errorf("oplog: read applied rows for (%s, %s): %w", writerID, stream, err)
	}
	defer q1.Close()
	type stored struct {
		seq  int64
		hash []byte
	}
	found := make(map[int64]stored, len(rows))
	for q1.Next() {
		var (
			counter, seq int64
			hash         []byte
		)
		if err := q1.Scan(&counter, &seq, &hash); err != nil {
			return nil, fmt.Errorf("oplog: read applied rows for (%s, %s): %w", writerID, stream, err)
		}
		found[counter] = stored{seq: seq, hash: hash}
	}
	if err := q1.Err(); err != nil {
		return nil, fmt.Errorf("oplog: read applied rows for (%s, %s): %w", writerID, stream, err)
	}

	out := make([]int64, len(rows))
	for i, r := range rows {
		s, ok := found[r.WriterCounter]
		if !ok {
			return nil, fmt.Errorf("%w: (%s, %s) counter %d is not stored, but this batch also contains counters that are",
				ErrPartiallyApplied, writerID, stream, r.WriterCounter)
		}
		if !bytes.Equal(s.hash, r.BlobHash) {
			return nil, fmt.Errorf("%w: (%s, %s) counter %d already holds different bytes (stored %x, submitted %x)",
				ErrChainBreak, writerID, stream, r.WriterCounter, s.hash, r.BlobHash)
		}
		out[i] = s.seq
	}
	return out, nil
}

// isPositionTaken reports whether err is a unique violation on the
// (user_id, writer_id, stream, writer_counter) key specifically. It is
// deliberately narrow: a 23505 on op_log_pkey is a corrupted seq counter
// (append.go's TestACorruptedCounterFailsLoudly...), an entirely different
// failure that must not be translated into "already applied".
func isPositionTaken(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolation && pgErr.ConstraintName == positionConstraint
}
