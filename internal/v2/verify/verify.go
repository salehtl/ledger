// Package verify is the operator's instrument for spec §5's Phase 1 exit
// criterion: "zero drops without notice — every inbound email accounted for in
// diagnostics or quarantine".
//
// It has three halves, and they answer three different questions.
//
//   - [Structural] answers "is the stored log internally consistent?" — five
//     invariants over op_log that the append path cannot violate and that
//     therefore only a bug, a repair script, a restore from a damaged backup or
//     a tampering operator can produce. Four (S1-S4) check the rows that
//     survive; the fifth, S5, is the only one that can tell a truncated tail
//     apart from a healthy log, because deleted rows leave nothing behind for
//     the others to see a hole in.
//   - [Accounting] answers "did every message that arrived end up somewhere we
//     can name?" — the arrival split, the reprocessing split beside it, the
//     protocol-level refusals that never resolved a recipient, and the
//     reconciliation of held mail against the quarantine ledger.
//   - [ParseRate] (parserate.go) answers "of the mail that carried a
//     transaction, how much did we extract?" — the ≥95% exit criterion, which
//     needs an operator in the loop because the denominator is not derivable
//     from anything recorded.
//
// # This package reads no content
//
// It runs on the operator's box against real user data, so the rule is
// absolute: nothing here opens a blob, decompresses a payload, or reads a
// header, a subject or a body. [Structural] hashes stored bytes and compares
// CLEARTEXT FRAMING (blob.EmbeddedAAD, which sits outside the sealed region in
// both phases); [Accounting] reads counts and closed enums out of
// parse_diagnostics. Findings never echo a value taken from a blob — only the
// position the ROW claims — because a malformed blob's "embedded AAD" is just
// bytes from somebody's mail.
//
// The one exception is quarantined behind its own subcommand and its own phase
// marker: parse-rate ADJUDICATION reads cold bodies, because a human has to look
// at an unparsed message to say whether it was a bank alert or a newsletter.
// That is item 4 of docs/superpowers/specs/v2-phase1-only-inventory.md and it is
// deleted at the Phase 3 cutover. The REPORTING half ([ParseRate]) reads no
// content either.
//
// # What "accounted for" is allowed to mean
//
// Honestly, and stated in the instrument rather than only in a report: this
// accounting can UNDERCOUNT, by design, and it cannot see several classes of
// protocol refusal at all. [BlindSpots] is the complete list, it travels
// attached to every [Report], and TestAccountingNamesWhatItCannotSee fails if an
// entry loses its reason. A report that claimed "every email accounted for"
// while three refusal classes vanished inside a dependency's command loop would
// be worse than one that says which three.
package verify

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/oplog"
)

// Finding is one violated invariant. Detail is written for an operator with a
// psql session: it names the position, never a value read out of a blob.
type Finding struct {
	ID     string    `json:"id"`
	UserID uuid.UUID `json:"user_id"`
	Detail string    `json:"detail"`
}

// The invariant identifiers. S-series are structural (op_log); A-series come
// from the accounting report, so that `ledgerd verify` has ONE exit path
// whichever half found the problem.
const (
	// S1SeqDense: per user, count(*) == max(seq) and min(seq) == 1. The seq
	// space has no holes, ever — see 00002_oplog.sql on why the counter is a
	// locked row and not a sequence.
	S1SeqDense = "S1_seq_dense"
	// S2IngestChain: per (user, writer_id, stream), counters run 1..N and
	// blob_hash[n] == SHA256(blob_hash[n-1] ‖ blob[n]) RECOMPUTED from the
	// stored bytes. Per stream, not per writer — Decision 13.
	S2IngestChain = "S2_ingest_chain"
	// S3AADMatchesRow: every blob's embedded associated data equals its row's
	// (user_id, stream, writer_id, writer_counter).
	S3AADMatchesRow = "S3_aad_matches_row"
	// S4BucketValid: octet_length(blob) == size_bucket, and size_bucket is one
	// of the seven rungs of blob.Buckets.
	S4BucketValid = "S4_bucket_valid"
	// S5CounterMatchesHead: per user, oplog_seq.next_seq == max(seq)+1 exactly.
	//
	// This is the only invariant that can see mail that is GONE rather than
	// out of order. S1 asks whether the surviving rows have holes between them,
	// which a truncated TAIL does not — 1..N-1 is perfectly dense, and an
	// entirely deleted log has nothing to be dense about. Restoring from a
	// short backup produces the first and a botched repair the second, and they
	// are the most likely real loss this system will ever see.
	//
	// The counter is the witness because nothing in production deletes an op
	// row and a rolled-back append restores the counter rather than burning the
	// value (00002_oplog.sql), so the equality is exact rather than an
	// approximation with slack.
	S5CounterMatchesHead = "S5_counter_matches_head"

	// A1UnaccountedRow: a diagnostics row this build cannot classify — an
	// event or an outcome the database accepted and the constants here do not
	// name. It is the drift detector between the CHECK constraint and this
	// build, and it covers reprocessing as well as arrivals, which is why it is
	// not called "unaccounted arrival".
	A1UnaccountedRow = "A1_unaccounted_row"
	// A2QuarantineUntraced: mail the diagnostics ledger says was held, which is
	// neither still held nor recorded as removed.
	A2QuarantineUntraced = "A2_quarantine_untraced"
	// A3DuplicateOfNothing: a message refused as a 'duplicate' that is in no
	// store at all — not appended, not held, not promoted. See [Report].
	A3DuplicateOfNothing = "A3_duplicate_of_nothing"
)

// Paging. A row's blob can be a megabyte, so a row count alone bounds nothing:
// the byte budget is what keeps a verify of a large account from being an OOM
// on the operator's box.
const (
	pageRows  = 512
	pageBytes = 8 << 20
)

// maxFindings caps one run. A restore from a truncated backup can break every
// chain of every user, and an instrument that answers with a million lines is
// one nobody reads; the truncation is itself reported.
const maxFindings = 2000

// Structural runs the five op_log invariants (S1-S5) over every account.
func Structural(ctx context.Context, pool *pgxpool.Pool) ([]Finding, error) {
	return StructuralFor(ctx, pool, nil)
}

// StructuralFor runs them over the named accounts, or over all of them when
// users is empty. Findings are ordered by user, then by seq, so two runs over an
// unchanged database produce byte-identical output and a diff is meaningful.
func StructuralFor(ctx context.Context, pool *pgxpool.Pool, users []uuid.UUID) ([]Finding, error) {
	if pool == nil {
		return nil, errors.New("verify: pool is nil")
	}
	targets, err := userList(ctx, pool, users)
	if err != nil {
		return nil, err
	}
	var out []Finding
	for _, u := range targets {
		f, err := structuralUser(ctx, pool, u)
		if err != nil {
			return nil, err
		}
		out = append(out, f...)
		if len(out) >= maxFindings {
			out = out[:maxFindings]
			out = append(out, Finding{
				ID:     "truncated",
				Detail: fmt.Sprintf("stopped after %d findings; fix these and re-run", maxFindings),
			})
			return out, nil
		}
	}
	return out, nil
}

func userList(ctx context.Context, pool *pgxpool.Pool, want []uuid.UUID) ([]uuid.UUID, error) {
	if len(want) > 0 {
		out := slices.Clone(want)
		slices.SortFunc(out, func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
		return out, nil
	}
	rows, err := pool.Query(ctx, `SELECT id FROM users ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("verify: list users: %w", err)
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var u uuid.UUID
		if err := rows.Scan(&u); err != nil {
			return nil, fmt.Errorf("verify: list users: %w", err)
		}
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("verify: list users: %w", err)
	}
	return out, nil
}

func structuralUser(ctx context.Context, pool *pgxpool.Pool, u uuid.UUID) ([]Finding, error) {
	var out []Finding

	// --- S1: the seq space is dense ------------------------------------------
	var n, lo, hi int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*), coalesce(min(seq),0), coalesce(max(seq),0) FROM op_log WHERE user_id = $1`,
		u).Scan(&n, &lo, &hi); err != nil {
		return nil, fmt.Errorf("verify: seq density for user %s: %w", u, err)
	}
	if n > 0 && (lo != 1 || hi != n) {
		out = append(out, Finding{ID: S1SeqDense, UserID: u, Detail: fmt.Sprintf(
			"%d rows spanning seq %d..%d: a dense log has min 1 and max == count, so %d position(s) are missing",
			n, lo, hi, hi-n)})
	}

	// --- S5: the counter agrees with the head --------------------------------
	//
	// Read in ONE statement with max(seq). Two statements are two snapshots, and
	// an append committing between them reports a break on a healthy log — the
	// counter row is UPDATEd inside the append transaction, so a reader that saw
	// the old counter and the new head would see next_seq <= max(seq) and cry
	// wolf on the busiest accounts.
	var (
		nextSeq int64
		headSeq int64
		haveSeq bool
	)
	err := pool.QueryRow(ctx, `
		SELECT s.next_seq, coalesce(max(o.seq), 0)
		  FROM oplog_seq s LEFT JOIN op_log o ON o.user_id = s.user_id
		 WHERE s.user_id = $1
		 GROUP BY s.next_seq`, u).Scan(&nextSeq, &headSeq)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// No counter row. Harmless for an account that has never written an op
		// (auth.UpsertUser creates it, so this is a pre-EnsureSeqRow account);
		// a hole in the evidence for one that has.
		if n > 0 {
			out = append(out, Finding{ID: S5CounterMatchesHead, UserID: u, Detail: fmt.Sprintf(
				"%d op rows exist but this account has no oplog_seq row, so there is nothing "+
					"left that knows how many ops it should have", n)})
		}
	case err != nil:
		return nil, fmt.Errorf("verify: seq counter for user %s: %w", u, err)
	default:
		haveSeq = true
	}
	if haveSeq && nextSeq != headSeq+1 {
		out = append(out, Finding{ID: S5CounterMatchesHead, UserID: u, Detail: fmt.Sprintf(
			"oplog_seq.next_seq is %d and the highest stored seq is %d: %d op(s) were assigned "+
				"a position and are no longer stored", nextSeq, headSeq, nextSeq-1-headSeq)})
	}

	// --- S2/S3/S4: one pass per stream, in seq order -------------------------
	//
	// Reading a STREAM in seq order yields each (writer, stream) chain in
	// counter order, because seq order is commit order and a chain's counters
	// only ever increase. That is what lets one pass verify every chain on the
	// stream at once without holding the log in memory.
	for _, stream := range []string{blob.StreamHot, blob.StreamCold} {
		f, err := structuralStream(ctx, pool, u, stream)
		if err != nil {
			return nil, err
		}
		out = append(out, f...)
	}
	return out, nil
}

// chain is one (writer_id, stream) hash chain, mid-verification.
type chain struct {
	wantCounter int64
	prev        [32]byte
}

func structuralStream(ctx context.Context, pool *pgxpool.Pool, u uuid.UUID, stream string) ([]Finding, error) {
	var (
		out    []Finding
		chains = map[string]*chain{}
		after  int64
	)
	for {
		rows, err := oplog.Read(ctx, pool, u, stream, after, pageRows, pageBytes)
		if err != nil {
			return nil, fmt.Errorf("verify: read %s log for user %s: %w", stream, u, err)
		}
		if len(rows) == 0 {
			return out, nil
		}
		for _, r := range rows {
			after = r.Seq
			out = append(out, checkBucket(u, r)...)
			out = append(out, checkAAD(u, r)...)

			c, ok := chains[r.WriterID]
			if !ok {
				c = &chain{wantCounter: 1, prev: blob.ZeroHash}
				chains[r.WriterID] = c
			}
			out = append(out, checkChain(u, r, c)...)
		}
		if len(out) > maxFindings {
			return out, nil
		}
	}
}

func checkBucket(u uuid.UUID, r oplog.Row) []Finding {
	var out []Finding
	if len(r.Blob) != r.SizeBucket {
		out = append(out, Finding{ID: S4BucketValid, UserID: u, Detail: fmt.Sprintf(
			"seq %d: blob is %d bytes but size_bucket says %d", r.Seq, len(r.Blob), r.SizeBucket)})
	}
	if !slices.Contains(blob.Buckets, r.SizeBucket) {
		out = append(out, Finding{ID: S4BucketValid, UserID: u, Detail: fmt.Sprintf(
			"seq %d: size_bucket %d is not one of the seven rungs %v", r.Seq, r.SizeBucket, blob.Buckets)})
	}
	return out
}

// checkAAD compares the blob's cleartext framing against the position the ROW
// claims. It never reports what it found: on a malformed blob the "embedded
// AAD" is arbitrary bytes lifted out of somebody's mail, and this package does
// not put those in an operator log.
func checkAAD(u uuid.UUID, r oplog.Row) []Finding {
	want := blob.Envelope{
		UserID: u, Stream: r.Stream, WriterID: r.WriterID, WriterCounter: r.WriterCounter,
	}
	got, err := blob.EmbeddedAAD(r.Blob)
	if err != nil {
		return []Finding{{ID: S3AADMatchesRow, UserID: u, Detail: fmt.Sprintf(
			"seq %d: the blob's framing is unreadable, so it carries no position at all", r.Seq)}}
	}
	if !bytes.Equal(got, want.AAD()) {
		return []Finding{{ID: S3AADMatchesRow, UserID: u, Detail: fmt.Sprintf(
			"seq %d: the blob was sealed for a different position than the row it occupies "+
				"(row says stream %q, writer %q, counter %d)", r.Seq, r.Stream, r.WriterID, r.WriterCounter)}}
	}
	return nil
}

// checkChain advances one chain by one row, reporting at most one finding and
// then RESYNCHRONIZING from the stored values. Without the resync a single
// tampered blob reports a break on every row after it, and the operator cannot
// tell one edit from a wholesale rewrite — which is the difference between a
// restore and an investigation.
func checkChain(u uuid.UUID, r oplog.Row, c *chain) []Finding {
	var out []Finding
	switch {
	case r.WriterCounter != c.wantCounter:
		out = append(out, Finding{ID: S2IngestChain, UserID: u, Detail: fmt.Sprintf(
			"seq %d: writer %q on the %s stream is at counter %d, but the chain expected %d",
			r.Seq, r.WriterID, r.Stream, r.WriterCounter, c.wantCounter)})
	case !bytes.Equal(r.PrevHash, c.prev[:]):
		out = append(out, Finding{ID: S2IngestChain, UserID: u, Detail: fmt.Sprintf(
			"seq %d: writer %q counter %d links to a prev_hash that is not the chain's head",
			r.Seq, r.WriterID, r.WriterCounter)})
	default:
		// The check that matters: RECOMPUTED from the stored bytes, so an
		// operator who edits a blob cannot keep the chain intact by also editing
		// the hash column.
		got := blob.Hash(c.prev, blob.Sealed{Bytes: r.Blob, SizeBucket: r.SizeBucket})
		if !bytes.Equal(r.BlobHash, got[:]) {
			out = append(out, Finding{ID: S2IngestChain, UserID: u, Detail: fmt.Sprintf(
				"seq %d: writer %q counter %d stores a blob_hash its own bytes do not produce",
				r.Seq, r.WriterID, r.WriterCounter)})
		}
	}
	c.wantCounter = r.WriterCounter + 1
	if len(r.BlobHash) == 32 {
		c.prev = [32]byte(r.BlobHash)
	} else {
		// op_log_hashes_are_sha256 makes this unreachable; resync to genesis
		// rather than panicking on a database that has had its constraints
		// removed, which is exactly the database this tool is pointed at.
		c.prev = blob.ZeroHash
	}
	return out
}

// ---------------------------------------------------------------------------
// The mail accounting
// ---------------------------------------------------------------------------

// ArrivalOutcomes and ReprocessOutcomes are the vocabularies the report splits
// by. They mirror the CHECK constraint in 00006_diagnostics.sql; a row whose
// outcome is not in the matching list is Unaccounted, which is how the drift
// between the constraint and this build becomes visible instead of silent.
var (
	ArrivalOutcomes = []string{
		diag.OutcomeAppended, diag.OutcomeQuarantined, diag.OutcomeRejected,
		diag.OutcomeOverQuota, diag.OutcomeDuplicate,
	}
	ReprocessOutcomes = []string{
		diag.OutcomeAppended, diag.OutcomeSuperseded, diag.OutcomeUnchanged,
	}
	rejectReasons = []string{
		diag.RejectTooLarge, diag.RejectUnknownRcpt, diag.RejectOverQuota,
		diag.RejectNoTextPart, diag.RejectNormalizeError,
	}
	// heldReasons are the refusals that nevertheless STORED the message: the
	// pipeline holds a body it could not normalize so the user can see it and a
	// fixed normalizer can re-read it. The outcome is 'rejected' only because
	// parse_diagnostics pairs reject_reason with a refusal outcome. Missing this
	// would report every normalizer failure as mail that vanished.
	heldReasons = []string{diag.RejectNoTextPart, diag.RejectNormalizeError}
)

// Bias directions for a [BlindSpot].
const (
	// Undercount: real inbound traffic this report does not see, so the true
	// number is higher than the one printed.
	Undercount = "undercount"
	// Overcount: something this report may count twice or attribute to the
	// wrong window.
	Overcount = "overcount"
)

// BlindSpot is one thing the accounting cannot see, why, and which way it bends
// the number.
type BlindSpot struct {
	ID        string `json:"id"`
	Direction string `json:"direction"`
	Reason    string `json:"reason"`
}

// BlindSpots is the complete list, attached to every [Report].
//
// It is a claim about a DEPENDENCY's behaviour as much as about our own code —
// entries 1-3 are go-smtp's command loop — so it has to be re-derived from that
// library's source when it is upgraded rather than assumed stable. Each entry
// names the exact reply so a change is visible in a test rather than in
// production; internal/v2/smtpd's package doc carries the same list from the
// receiver's side.
var BlindSpots = []BlindSpot{
	{
		ID: "smtp_500_long_line", Direction: Undercount,
		Reason: "go-smtp answers an over-long command line 500 and closes inside its own " +
			"command loop (server.go handleConn), without consulting the backend. No body was " +
			"ever offered, so no mail is discarded — but the attempt is counted nowhere. An " +
			"over-long line during DATA/BDAT surfaces instead as a read error answered 451, " +
			"also uncounted.",
	},
	{
		ID: "smtp_501_malformed_path", Direction: Undercount,
		Reason: "a syntactically invalid MAIL/RCPT path, an unparseable SIZE parameter and " +
			"the 500 'too many errors' disconnect are all answered inside go-smtp's command " +
			"loop before any backend call. Protocol errors rather than messages.",
	},
	{
		ID: "smtp_452_extra_recipient", Direction: Undercount,
		Reason: "MaxRecipients is 1 and go-smtp enforces it BEFORE calling Rcpt, so the second " +
			"recipient of a multi-recipient message is refused 452 with no session method " +
			"reached. The first recipient's copy is accounted normally.",
	},
	{
		ID: "smtp_421_connection_cap", Direction: Undercount,
		Reason: "the total and per-source connection caps refuse before the greeting, on the " +
			"listener, so go-smtp never sees the connection and there is no session to record " +
			"anything against. 421 is temporary, so a legitimate sender retries.",
	},
	{
		ID: "smtp_guard_line_ceiling", Direction: Undercount,
		Reason: "guardConn's backstop line ceiling and per-transaction byte budget trip on the " +
			"socket, under the library. The command-phase trip becomes 421 and the DATA-phase " +
			"trip 451. Neither is counted, and the closed reject_reason enum has no value that " +
			"could describe it without becoming a free-text field.",
	},
	{
		ID: "smtp_tarpit_block", Direction: Undercount,
		Reason: "a source past the invalid-recipient disconnect threshold is dropped 421 at RCPT " +
			"by Limiter.Blocked, which deliberately records nothing: the counter exists to stop " +
			"an address-enumeration sweep, and one row per probe would restore the " +
			"storage-amplification bug it prevents. Highest-volume uncounted path in the receiver.",
	},
	{
		ID: "smtp_transfer_error", Direction: Undercount,
		Reason: "a DATA/BDAT transfer that fails mid-stream (timeout, reset, abandoned chunk), " +
			"a DATA with no accepted recipient, and a handler failure are all answered 451 and " +
			"logged, not counted. 451 means the sending MTA retries, so this is a delayed " +
			"message rather than a lost one.",
	},
	{
		ID: "smtp_unknown_rcpt_write_failure", Direction: Undercount,
		Reason: "the unknown-recipient counter is written synchronously and its error is logged " +
			"and dropped: the 550 must not vary with our database's health, or the reply becomes " +
			"an oracle for whether an address exists. During a database outage every " +
			"unknown-recipient refusal is permanently refused with no trace. A chosen trade.",
	},
	{
		ID: "rejection_flush_window", Direction: Undercount,
		Reason: "too_large and over_quota counts are aggregated in memory and flushed every 2s, " +
			"so a crash loses at most 2s of them — and more if flushes have been failing, since " +
			"failed counts are re-queued in memory with no cap. Aggregation is what stops the " +
			"open :25 from turning this counter into a storage-amplification bug. Note the " +
			"declared-SIZE refusal is answered 552 PERMANENTLY without waiting to confirm the " +
			"count was written, so for that one path a crash inside the window loses the " +
			"attempt with no retry.",
	},
	{
		ID: "diagnostics_notice_budget", Direction: Undercount,
		Reason: "past the per-user notice budget a refusal is recorded in the aggregate counter " +
			"only, with no user-scoped diagnostics row. The refusal is still counted; which USER " +
			"it belonged to is not.",
	},
	{
		ID: "diagnostics_write_failure", Direction: Undercount,
		Reason: "the ingest pipeline returns success once a message is durably stored even if " +
			"the diagnostics write then fails, because the alternative is a 4xx that re-delivers " +
			"a message already in the log. So a lost instrument row can never become a duplicate " +
			"transaction, and this report can undercount arrivals BY DESIGN. op_log and " +
			"quarantine are the authoritative stores; parse_diagnostics is the instrument.",
	},
	{
		ID: "relay_spool_writes_no_diagnostics", Direction: Undercount,
		Reason: "the backup MX (relay mode) accepts mail on port 25 and writes it to a disk " +
			"spool with NO parse_diagnostics row: it deliberately has no database, because a " +
			"second box on the internet holding a copy of the schema is what that design " +
			"refuses. Mail that arrives at the relay is therefore invisible to inbound_total " +
			"until the drain delivers it to the primary, which then counts it as an ordinary " +
			"arrival. A relay holding an undrained spool is a real gap between what was " +
			"received and what this report says; the spool's own file count is the only place " +
			"it is visible. Pinned by verify.InboundPaths.",
	},
	{
		ID: "retention_and_deletion_shrink_past_windows", Direction: Undercount,
		Reason: "parse_diagnostics rows cascade away with the account (§3.10) and with the " +
			"plaintext retention sweep, so re-running a window that has already been reported " +
			"returns SMALLER numbers than the first run, with nothing to say why. Two reports " +
			"over the same period are not comparable across a deletion. Deliberate — the " +
			"alternative is a record about somebody who asked to be forgotten — but it means " +
			"an exit measurement has to be taken and kept, not recomputed later.",
	},
	{
		ID: "quarantine_expiry_is_an_announced_drop", Direction: Undercount,
		Reason: "an expired hold IS mail that was dropped: the user was warned and the removal " +
			"is recorded, which is what §2's drop policy requires, but the message is gone and " +
			"was never in the log. It is reported as quarantine.expired rather than folded " +
			"into the arrival split, because it happens long after the window the message " +
			"arrived in and would otherwise make two windows disagree about the same email.",
	},
	{
		ID: "inbound_total_counts_deliveries_not_emails", Direction: Overcount,
		Reason: "one row per DELIVERY ATTEMPT that resolved a recipient, not one per distinct " +
			"message: a retried message contributes an 'appended' and one or more 'duplicate' " +
			"rows, and ingest's dedup window can append the same bytes up to N times under " +
			"concurrent delivery. Report.InboundIdentities counts distinct (user, ingest id) " +
			"beside it, which is the per-EMAIL number the exit criterion is about.",
	},
	{
		ID: "rejection_day_granularity", Direction: Overcount,
		Reason: "smtp_rejections is a per-UTC-day aggregate with no finer resolution, so a " +
			"window that does not start and end on a day boundary includes whole days at both " +
			"edges. Report.RejectionDays states the days actually summed.",
	},
}

// QuarantineRecon closes the one arrival outcome that is not terminal.
//
// 'quarantined' means "held, pending a decision", so the accounting is not
// finished until each held message is either still held or recorded as removed.
// It is computed over ALL TIME rather than the report window on purpose: a
// message held in January and expired in March is reconciled by neither month's
// window alone.
type QuarantineRecon struct {
	// Expected counts distinct (user, ingest id) pairs the diagnostics ledger
	// says were stored in quarantine — the 'quarantined' outcome plus the
	// normalizer failures, which are held too.
	Expected int64 `json:"expected"`
	Held     int64 `json:"held"`
	// Expired and Promoted split quarantine_removals by reason, because they
	// are opposite facts. A promoted hold entered the op log; an EXPIRED hold is
	// mail that died unread, which is a drop — an announced one, with a warning
	// the user saw (00008_quarantine.sql), but a drop. Summing them into one
	// "removed" hid the single number an operator most wants from this report.
	Expired  int64 `json:"expired"`
	Promoted int64 `json:"promoted"`
	// Accounted is the distinct union of held and removed: a message held,
	// promoted and held again is one identity, not two.
	Accounted int64 `json:"accounted"`
	// Untraced is held mail that is neither present nor recorded as removed,
	// counted as a SET DIFFERENCE and not as Expected-Accounted.
	//
	// The subtraction was wrong in a way that mattered: one message lost and one
	// message held whose diagnostics row never landed are opposite errors of
	// size one, so they cancelled and the report read clean. The second half of
	// that pair is the diagnostics_write_failure blind spot, which this very
	// report describes as routine — so the one genuine cross-store check in the
	// instrument was disarmed by a documented-normal event.
	Untraced int64 `json:"untraced"`
	// Extra is the opposite direction and is NOT a failure — see
	// diagnostics_write_failure in [BlindSpots]. It is now an independent set
	// difference, so it can no longer mask an Untraced.
	Extra int64 `json:"extra"`
}

// Report is the "zero drops without notice" instrument over one window.
//
// The equation it asserts, with every term:
//
//	inbound_total = arrival[appended] + arrival[quarantined] + arrival[rejected]
//	              + arrival[over_quota] + arrival[duplicate] + unaccounted
//
// where inbound_total counts event='arrival' rows ONLY. `unaccounted` is rows
// whose event or outcome this build cannot name, and a non-zero value is a hard
// failure — the equation is deliberately NOT written so that it balances by
// construction, because an equation that cannot fail is not a check.
//
// Reported beside it, never folded in:
//
//	reprocess[appended|superseded|unchanged]  — re-parses of mail already stored
//	protocol_rejections[reason]               — refusals that never resolved a
//	                                            recipient, so no row could be
//	                                            scoped to a user (Task 23)
//	quarantine.expected = quarantine.accounted + quarantine.untraced
//
// and, always, [BlindSpots]: what this report cannot see.
type Report struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`

	InboundTotal int64 `json:"inbound_total"`
	// InboundIdentities counts DISTINCT (user, ingest id) arrivals in the same
	// window. InboundTotal counts delivery attempts that resolved a recipient,
	// which is not the same thing and is the larger number: a retried message
	// contributes an 'appended' and one or more 'duplicate' rows. The exit
	// criterion is about EMAILS, so both are printed and the difference is the
	// redelivery traffic.
	InboundIdentities int64            `json:"inbound_identities"`
	Arrival           map[string]int64 `json:"arrival"`
	Reprocess         map[string]int64 `json:"reprocess"`

	// UnknownOutcomes names what could not be classified, so an operator can act
	// on it. In a database whose CHECK constraints are intact this is always
	// empty: the outcome column is a closed enum, and the only way a value gets
	// in that is not in it is a caller that dropped the constraint.
	UnknownOutcomes map[string]int64 `json:"unknown_outcomes,omitempty"`
	Unaccounted     int64            `json:"unaccounted"`

	ProtocolRejections map[string]int64 `json:"protocol_rejections"`
	// RejectionDays is the inclusive UTC day range actually summed above. See
	// the rejection_day_granularity blind spot.
	RejectionDays [2]string `json:"rejection_days"`

	Quarantine QuarantineRecon `json:"quarantine"`

	// Discarded counts messages refused as a 'duplicate' whose bytes are in no
	// store at all. See the equation note above: this is the drop class the
	// arrival split cannot express, because a duplicate is an ASSERTION about
	// another row rather than a fact about itself.
	Discarded int64 `json:"discarded"`

	BlindSpots []BlindSpot `json:"blind_spots"`
}

// ArrivalSum adds the NAMED arrival outcomes only. It excludes Unaccounted on
// purpose: that is what makes `ArrivalSum() + Unaccounted == InboundTotal` a
// statement with content.
func (r Report) ArrivalSum() int64 {
	var n int64
	for _, o := range ArrivalOutcomes {
		n += r.Arrival[o]
	}
	return n
}

// ReprocessSum adds the named reprocessing outcomes.
func (r Report) ReprocessSum() int64 {
	var n int64
	for _, o := range ReprocessOutcomes {
		n += r.Reprocess[o]
	}
	return n
}

// ProtocolRejectionsTotal adds the aggregated protocol refusals.
func (r Report) ProtocolRejectionsTotal() int64 {
	var n int64
	for _, v := range r.ProtocolRejections {
		n += v
	}
	return n
}

// Findings turns the report's failures into the same shape [Structural]
// produces, so `ledgerd verify` exits 1 by one rule whichever half found it.
func (r Report) Findings() []Finding {
	var out []Finding
	for _, o := range sortedKeys(r.UnknownOutcomes) {
		out = append(out, Finding{ID: A1UnaccountedRow, Detail: fmt.Sprintf(
			"%d row(s) carry the event/outcome pair %q, which this build cannot classify: "+
				"the equation cannot close over a row nobody can name", r.UnknownOutcomes[o], o)})
	}
	if r.Discarded > 0 {
		out = append(out, Finding{ID: A3DuplicateOfNothing, Detail: fmt.Sprintf(
			"%d message(s) were refused as a duplicate of something this server does not have: "+
				"not appended, not held, and not promoted. A duplicate is a CLAIM that we "+
				"already kept the message; where the claim is false the message was discarded, "+
				"and it was counted twice in inbound_total on the way out", r.Discarded)})
	}
	if r.Quarantine.Untraced > 0 {
		out = append(out, Finding{ID: A2QuarantineUntraced, Detail: fmt.Sprintf(
			"%d message(s) were recorded as held but are neither in quarantine nor in "+
				"quarantine_removals; the BEFORE DELETE trigger makes that impossible on the "+
				"normal path, so something bypassed it", r.Quarantine.Untraced)})
	}
	return out
}

// Err reports the hard failures: an arrival nobody can classify, or held mail
// that vanished without a removal record.
func (r Report) Err() error {
	f := r.Findings()
	if len(f) == 0 {
		return nil
	}
	return fmt.Errorf("verify: accounting: %d unreconciled finding(s), first: %s: %s",
		len(f), f[0].ID, f[0].Detail)
}

func sortedKeys(m map[string]int64) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// Accounting builds the report for [from, to).
func Accounting(ctx context.Context, pool *pgxpool.Pool, from, to time.Time) (Report, error) {
	if pool == nil {
		return Report{}, errors.New("verify: pool is nil")
	}
	rep := Report{
		From: from, To: to,
		Arrival:            zeroed(ArrivalOutcomes),
		Reprocess:          zeroed(ReprocessOutcomes),
		ProtocolRejections: zeroed(rejectReasons),
		UnknownOutcomes:    map[string]int64{},
		BlindSpots:         BlindSpots,
	}

	rows, err := pool.Query(ctx, `SELECT event, outcome, count(*) FROM parse_diagnostics
	  WHERE received_at >= $1 AND received_at < $2 GROUP BY event, outcome`, from, to)
	if err != nil {
		return Report{}, fmt.Errorf("verify: accounting: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var event, outcome string
		var n int64
		if err := rows.Scan(&event, &outcome, &n); err != nil {
			return Report{}, fmt.Errorf("verify: accounting: %w", err)
		}
		switch {
		case event == diag.EventArrival && slices.Contains(ArrivalOutcomes, outcome):
			rep.InboundTotal += n
			rep.Arrival[outcome] += n
		case event == diag.EventArrival:
			// Still an arrival — a message did reach us — but not one the
			// equation can place. Counted in the total and NOT in any named
			// bucket, so ArrivalSum() falls short by exactly this much.
			rep.InboundTotal += n
			rep.Unaccounted += n
			rep.UnknownOutcomes[event+"/"+clip(outcome)] += n
		case event == diag.EventReprocess && slices.Contains(ReprocessOutcomes, outcome):
			rep.Reprocess[outcome] += n
		default:
			rep.Unaccounted += n
			rep.UnknownOutcomes[clip(event)+"/"+clip(outcome)] += n
		}
	}
	if err := rows.Err(); err != nil {
		return Report{}, fmt.Errorf("verify: accounting: %w", err)
	}

	if err := pool.QueryRow(ctx, `SELECT count(*) FROM (
	      SELECT DISTINCT user_id, ingest_id FROM parse_diagnostics
	       WHERE event = 'arrival' AND user_id IS NOT NULL
	         AND received_at >= $1 AND received_at < $2) t`,
		from, to).Scan(&rep.InboundIdentities); err != nil {
		return Report{}, fmt.Errorf("verify: accounting: distinct arrivals: %w", err)
	}

	if err := rep.readRejections(ctx, pool, from, to); err != nil {
		return Report{}, err
	}
	if err := rep.readQuarantine(ctx, pool); err != nil {
		return Report{}, err
	}
	if err := rep.readDiscarded(ctx, pool, from, to); err != nil {
		return Report{}, err
	}
	return rep, nil
}

// clip bounds a value this build did not expect. The outcome column is a closed
// enum, so an unexpected value can only exist in a database whose constraints
// have been removed — at which point it is arbitrary text, and this package does
// not put unbounded strings from user data into an operator's terminal.
func clip(s string) string {
	const max = 32
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func zeroed(keys []string) map[string]int64 {
	m := make(map[string]int64, len(keys))
	for _, k := range keys {
		m[k] = 0
	}
	return m
}

func (r *Report) readRejections(ctx context.Context, pool *pgxpool.Pool, from, to time.Time) error {
	// The window is half-open, so the LAST day summed is the day containing the
	// instant just before `to`. Formatting `to` itself adds a whole extra day
	// whenever an operator does the natural thing and aligns the window to
	// midnight: [Aug 1 00:00Z, Aug 15 00:00Z) is fourteen days, and summing
	// through "2026-08-15" silently reported fifteen.
	//
	// The subtraction is a microsecond because that is Postgres's timestamptz
	// resolution; a nanosecond is not representable and would round back to `to`.
	last := to.UTC().Add(-time.Microsecond)
	if !last.After(from.UTC()) {
		last = from.UTC()
	}
	r.RejectionDays = [2]string{
		from.UTC().Format("2006-01-02"), last.Format("2006-01-02"),
	}
	rows, err := pool.Query(ctx, `SELECT reason, coalesce(sum(count),0) FROM smtp_rejections
	  WHERE day >= $1::date AND day <= $2::date GROUP BY reason`,
		r.RejectionDays[0], r.RejectionDays[1])
	if err != nil {
		return fmt.Errorf("verify: accounting: protocol rejections: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var reason string
		var n int64
		if err := rows.Scan(&reason, &n); err != nil {
			return fmt.Errorf("verify: accounting: protocol rejections: %w", err)
		}
		r.ProtocolRejections[clip(reason)] += n
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verify: accounting: protocol rejections: %w", err)
	}
	return nil
}

// heldExpectedSQL counts the distinct message identities the diagnostics ledger
// says are in quarantine. Identity, not row: quarantine.Hold is ON CONFLICT DO
// NOTHING per (user, ingest id), so two arrival rows for the same bytes are one
// held message.
const heldExpectedSQL = `
SELECT count(*) FROM (
  SELECT DISTINCT user_id, ingest_id FROM parse_diagnostics
   WHERE event = 'arrival' AND user_id IS NOT NULL
     AND (outcome = 'quarantined' OR (outcome = 'rejected' AND reject_reason = ANY($1)))
) t`

// storedIdentitiesSQL is every (user, ingest id) this server can still show
// somebody, from the diagnostics ledger and the quarantine tables together.
//
// It is deliberately the SAME three sources ingest.alreadyHandled consults to
// decide that a redelivery is a duplicate: an appended or superseded op, a live
// hold, or a promoted removal. That symmetry is the whole check — the pipeline
// answered "we already have this" at delivery time, and the verifier re-asks the
// identical question against the store as it is NOW.
const storedIdentitiesSQL = `
  SELECT user_id, ingest_id FROM parse_diagnostics
   WHERE user_id IS NOT NULL AND outcome IN ('appended','superseded')
  UNION
  SELECT user_id, ingest_id FROM quarantine
  UNION
  SELECT user_id, ingest_id FROM quarantine_removals WHERE reason = 'promoted'`

// discardedDuplicatesSQL counts messages refused as a duplicate that no store
// holds.
//
// The duplicates are WINDOWED and the evidence is not: the original of a
// redelivery is routinely older than the window being reported on, and requiring
// it to be inside would report every legitimate retry across a window boundary
// as a drop.
//
// The stored set is PARENTHESIZED. EXCEPT and UNION share a precedence level in
// SQL and associate left to right, so `a EXCEPT b UNION c` means
// `(a EXCEPT b) UNION c` — which adds every quarantined message to the answer
// instead of subtracting it, and reports held mail as discarded. Caught by the
// healthy-duplicate cases below, which is exactly what they are for.
const discardedDuplicatesSQL = `
SELECT count(*) FROM (
  (SELECT DISTINCT user_id, ingest_id FROM parse_diagnostics
    WHERE event = 'arrival' AND outcome = 'duplicate' AND user_id IS NOT NULL
      AND received_at >= $1 AND received_at < $2)
  EXCEPT
  (` + storedIdentitiesSQL + `)
) t`

// heldSetSQL and removedSetSQL are the two sides of the quarantine
// reconciliation, as SETS. See QuarantineRecon.Untraced for why this is not
// arithmetic on two totals.
const heldSetSQL = `
  SELECT DISTINCT user_id, ingest_id FROM parse_diagnostics
   WHERE event = 'arrival' AND user_id IS NOT NULL
     AND (outcome = 'quarantined' OR (outcome = 'rejected' AND reject_reason = ANY($1)))`

const removedSetSQL = `
  SELECT user_id, ingest_id FROM quarantine
  UNION
  SELECT user_id, ingest_id FROM quarantine_removals`

func (r *Report) readQuarantine(ctx context.Context, pool *pgxpool.Pool) error {
	q := &r.Quarantine
	counts := []struct {
		into *int64
		sql  string
		args []any
	}{
		{&q.Expected, `SELECT count(*) FROM (` + heldSetSQL + `) t`, []any{heldReasons}},
		{&q.Held, `SELECT count(*) FROM (SELECT DISTINCT user_id, ingest_id FROM quarantine) t`, nil},
		{&q.Expired, `SELECT count(*) FROM (SELECT DISTINCT user_id, ingest_id
		               FROM quarantine_removals WHERE reason = 'expired') t`, nil},
		{&q.Promoted, `SELECT count(*) FROM (SELECT DISTINCT user_id, ingest_id
		                FROM quarantine_removals WHERE reason = 'promoted') t`, nil},
		{&q.Accounted, `SELECT count(*) FROM (` + removedSetSQL + `) t`, nil},
		// The two set differences, each computed independently so neither can
		// cancel the other.
		{&q.Untraced, `SELECT count(*) FROM ((` + heldSetSQL + `) EXCEPT (` + removedSetSQL + `)) t`,
			[]any{heldReasons}},
		{&q.Extra, `SELECT count(*) FROM ((` + removedSetSQL + `) EXCEPT (` + heldSetSQL + `)) t`,
			[]any{heldReasons}},
	}
	for _, c := range counts {
		if err := pool.QueryRow(ctx, c.sql, c.args...).Scan(c.into); err != nil {
			return fmt.Errorf("verify: accounting: quarantine reconciliation: %w", err)
		}
	}
	return nil
}

func (r *Report) readDiscarded(ctx context.Context, pool *pgxpool.Pool, from, to time.Time) error {
	if err := pool.QueryRow(ctx, discardedDuplicatesSQL, from, to).Scan(&r.Discarded); err != nil {
		return fmt.Errorf("verify: accounting: discarded duplicates: %w", err)
	}
	return nil
}
