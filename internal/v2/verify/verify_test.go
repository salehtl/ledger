package verify

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/diag"
	"ledger/internal/v2/oplog"
	"ledger/internal/v2/pgtest"
)

func TestMain(m *testing.M) { os.Exit(pgtest.Main(m)) }

var bg = context.Background()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// insertUser mirrors auth.UpsertUser: the user row and its oplog_seq row are
// created together, which is what every append below assumes.
func insertUser(t *testing.T, pool *pgxpool.Pool) uuid.UUID {
	t.Helper()
	tx, err := pool.Begin(bg)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(bg)
	var id uuid.UUID
	if err := tx.QueryRow(bg,
		`INSERT INTO users (idp, idp_sub_hash, created_at) VALUES ('apple', $1, now()) RETURNING id`,
		randBytes(t, 32)).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := oplog.EnsureSeqRow(bg, tx, id); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(bg); err != nil {
		t.Fatal(err)
	}
	return id
}

func randBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

// appendHot appends n ingest ops on the hot stream, one per call to the real
// appender — so every chain hash, counter and AAD is produced by production
// code rather than by the test.
func appendHot(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, n int) {
	t.Helper()
	ap := &oplog.Appender{Pool: pool}
	for i := 0; i < n; i++ {
		if _, err := ap.AppendIngest(bg, u, []oplog.IngestBlob{
			{Stream: blob.StreamHot, Plaintext: []byte(fmt.Sprintf(`{"op":%d}`, i)), CreatedAt: time.Now()},
		}); err != nil {
			t.Fatalf("append hot %d: %v", i, err)
		}
	}
}

// appendPairs appends n hot+cold PAIRS in one call each, which is what the real
// ingest path does for one email. The result is a log whose ingest writer holds
// two independent chains whose rows interleave by seq.
func appendPairs(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, n int) {
	t.Helper()
	ap := &oplog.Appender{Pool: pool}
	for i := 0; i < n; i++ {
		if _, err := ap.AppendIngest(bg, u, []oplog.IngestBlob{
			{Stream: blob.StreamHot, Plaintext: []byte(fmt.Sprintf(`{"op":%d}`, i)), CreatedAt: time.Now()},
			{Stream: blob.StreamCold, Plaintext: []byte(fmt.Sprintf(`{"body":%d}`, i)), CreatedAt: time.Now()},
		}); err != nil {
			t.Fatalf("append pair %d: %v", i, err)
		}
	}
}

func exec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(bg, sql, args...); err != nil {
		t.Fatalf("exec %q: %v", sql, err)
	}
}

func ids(f []Finding) []string {
	out := make([]string, 0, len(f))
	for _, x := range f {
		out = append(out, x.ID)
	}
	return out
}

func hasFinding(f []Finding, id string) bool {
	for _, x := range f {
		if x.ID == id {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// The four structural invariants
// ---------------------------------------------------------------------------

func TestS1DetectsAnInjectedGap(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 5)

	exec(t, pool, `DELETE FROM op_log WHERE user_id = $1 AND seq = 3`, u)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if !hasFinding(got, S1SeqDense) {
		t.Fatalf("findings %v do not include %s: a hole in the seq space is the one thing "+
			"the append path can never produce, so nothing else will report it", ids(got), S1SeqDense)
	}
}

func TestS2DetectsATamperedIngestBlob(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 3)

	// The LAST byte: the reserved tag slot. It is inside the hashed bytes and
	// outside the AAD, so exactly one invariant can notice — which is what makes
	// this a test of S2 rather than of "something is wrong somewhere".
	exec(t, pool, `UPDATE op_log SET blob = set_byte(blob, octet_length(blob) - 1, 7)
	               WHERE user_id = $1 AND seq = 2`, u)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if !hasFinding(got, S2IngestChain) {
		t.Fatalf("findings %v do not include %s", ids(got), S2IngestChain)
	}
	if hasFinding(got, S3AADMatchesRow) {
		t.Fatalf("findings %v include %s: the edited byte is outside the AAD, so reporting it "+
			"means the AAD check is reading the wrong bytes", ids(got), S3AADMatchesRow)
	}
}

// TestS2ChecksHotAndColdSeparately is the regression test for Decision 13. A
// healthy ingest log interleaves hot and cold rows, so a single combined chain
// per writer reports a break on EVERY user — an instrument that cries wolf on a
// clean database is worse than none.
func TestS2ChecksHotAndColdSeparately(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendPairs(t, pool, u, 4)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("a healthy interleaved log yields %v, want none", ids(got))
	}

	// And prove the test is not vacuous: the combined-chain check this one
	// replaces really would fail here. Chaining every ingest row in seq order,
	// ignoring the stream, must NOT reproduce the stored hashes.
	rows := allRows(t, pool, u)
	if len(rows) != 8 {
		t.Fatalf("fixture holds %d rows, want 8", len(rows))
	}
	prev := blob.ZeroHash
	combinedHolds := true
	for _, r := range rows {
		h := blob.Hash(prev, blob.Sealed{Bytes: r.Blob, SizeBucket: r.SizeBucket})
		if string(h[:]) != string(r.BlobHash) {
			combinedHolds = false
			break
		}
		prev = h
	}
	if combinedHolds {
		t.Fatal("a single combined chain over both streams verifies, so this test could not " +
			"have caught the bug it exists for")
	}
}

func TestS3DetectsARowMovedToAnotherStream(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 3)

	// Moved, not copied: the row keeps its bytes, so its embedded AAD still says
	// "hot" while its row says "cold". Nothing else in the schema notices — the
	// unique key is satisfied, the bucket check is satisfied, the seq space is
	// still dense.
	exec(t, pool, `UPDATE op_log SET stream = 'cold' WHERE user_id = $1 AND seq = 3`, u)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if !hasFinding(got, S3AADMatchesRow) {
		t.Fatalf("findings %v do not include %s", ids(got), S3AADMatchesRow)
	}
}

func TestS4DetectsABlobThatIsNotASizeBucket(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 2)

	// op_log_blob_fills_bucket is the FIRST line: a blob whose length disagrees
	// with its bucket cannot be stored at all. S4 is the second, and it also
	// covers the half the constraint does not — that the agreed number is one of
	// the seven rungs. Dropping the constraint is how the second line gets to be
	// tested at all.
	exec(t, pool, `ALTER TABLE op_log DROP CONSTRAINT op_log_blob_fills_bucket`)
	exec(t, pool, `UPDATE op_log SET blob = substring(blob from 1 for 2048), size_bucket = 2048
	               WHERE user_id = $1 AND seq = 1`, u)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if !hasFinding(got, S4BucketValid) {
		t.Fatalf("findings %v do not include %s: 2048 is not one of %v", ids(got), S4BucketValid, blob.Buckets)
	}
}

func TestCleanDatabaseYieldsNoFindings(t *testing.T) {
	pool := pgtest.New(t)
	for i := 0; i < 3; i++ {
		u := insertUser(t, pool)
		appendPairs(t, pool, u, 2)
		appendHot(t, pool, u, 1)
	}
	// A user with no log at all: the empty case must not be a finding either.
	insertUser(t, pool)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("clean database yields %v, want none", got)
	}
}

func TestStructuralCanBeScopedToOneUser(t *testing.T) {
	pool := pgtest.New(t)
	broken := insertUser(t, pool)
	clean := insertUser(t, pool)
	appendHot(t, pool, broken, 3)
	appendHot(t, pool, clean, 3)
	exec(t, pool, `DELETE FROM op_log WHERE user_id = $1 AND seq = 2`, broken)

	only, err := StructuralFor(bg, pool, []uuid.UUID{clean})
	if err != nil {
		t.Fatalf("StructuralFor: %v", err)
	}
	if len(only) != 0 {
		t.Fatalf("scoping to the healthy user yields %v, want none", ids(only))
	}
	all, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if len(all) == 0 {
		t.Fatal("the unscoped run found nothing, so the scoped run proved nothing")
	}
	for _, f := range all {
		if f.UserID != broken {
			t.Fatalf("finding %s names user %s, want %s", f.ID, f.UserID, broken)
		}
	}
}

func allRows(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) []oplog.Row {
	t.Helper()
	q, err := pool.Query(bg, `SELECT seq, stream, writer_id, writer_counter, blob, size_bucket, blob_hash
	                            FROM op_log WHERE user_id = $1 ORDER BY seq`, u)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	var out []oplog.Row
	for q.Next() {
		var r oplog.Row
		if err := q.Scan(&r.Seq, &r.Stream, &r.WriterID, &r.WriterCounter, &r.Blob, &r.SizeBucket, &r.BlobHash); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	if err := q.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// ---------------------------------------------------------------------------
// The mail accounting
// ---------------------------------------------------------------------------

// arrival writes one diagnostics row directly. Raw SQL rather than diag.Record
// on purpose: this file is a test ABOUT the accounting arithmetic, and it has to
// be able to write rows diag.Record would refuse.
func arrival(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, at time.Time, outcome, tier, reason string) []byte {
	t.Helper()
	return diagRow(t, pool, u, at, diag.EventArrival, outcome, tier, reason)
}

func reprocess(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, at time.Time, outcome string) []byte {
	t.Helper()
	return diagRow(t, pool, u, at, diag.EventReprocess, outcome, diag.TierTemplate, "")
}

var diagSeq int

func diagRow(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, at time.Time,
	event, outcome, tier, reason string) []byte {
	t.Helper()
	diagSeq++
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s/%d", u, diagSeq)))
	return diagRowFor(t, pool, u, sum[:], at, event, outcome, tier, reason)
}

// diagRowFor writes a row for an EXPLICIT ingest id, so a test can build several
// rows about the SAME message — which is what every identity-level check in this
// file is about, and what diagRow's per-call digest cannot express.
func diagRowFor(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte, at time.Time,
	event, outcome, tier, reason string) []byte {
	t.Helper()
	sum := [32]byte(id)
	var user any = u
	if u == uuid.Nil {
		user = nil
	}
	var rej any
	if reason != "" {
		rej = reason
	}
	matched := tier == diag.TierTemplate
	var tmplID, tmplVer any
	if matched {
		tmplID, tmplVer = "test.bank", 1
	}
	exec(t, pool, `INSERT INTO parse_diagnostics
	  (user_id, event, ingest_id, received_at, sender_domain, dkim_result, arc_result,
	   template_id, template_version, normalizer_version, matched, tier,
	   body_size_bucket, structure_sig, outcome, reject_reason)
	  VALUES ($1,$2,$3,$4,'bank.test','pass','none',$5,$6,1,$7,$8,1024,'',$9,$10)`,
		user, event, sum[:], at, tmplID, tmplVer, matched, tier, outcome, rej)
	return sum[:]
}

// hold puts a message in quarantine, which is what the pipeline does alongside
// every 'quarantined' arrival row and every normalizer failure. Writing the
// diagnostics row without it would leave the fixture in the state
// TestAccountingReportsHeldMailThatVanished exists to detect.
func hold(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte, at time.Time) {
	t.Helper()
	exec(t, pool, `INSERT INTO quarantine
	  (user_id, ingest_id, received_at, expires_at, envelope_from, outer_domain,
	   attested, dkim, arc, blob, size_bucket)
	  VALUES ($1,$2,$3::timestamptz,$3::timestamptz + interval '30 days',
	          's@bank.test','bank.test',false,'pass','none',$4,1024)`,
		u, id, at, make([]byte, 1024))
}

func TestAccountingSeparatesArrivalsFromReprocessing(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()
	from, to := now.Add(-time.Hour), now.Add(time.Hour)

	for i := 0; i < 20; i++ {
		arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	}
	for i := 0; i < 3; i++ {
		hold(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)
	}
	for i := 0; i < 3; i++ {
		reprocess(t, pool, u, now, diag.OutcomeAppended)
	}

	rep, err := Accounting(bg, pool, from, to)
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.InboundTotal != 23 {
		t.Fatalf("inbound_total = %d, want 23 (reprocessing is never folded in)", rep.InboundTotal)
	}
	if rep.Arrival[diag.OutcomeAppended] != 20 || rep.Arrival[diag.OutcomeQuarantined] != 3 {
		t.Fatalf("arrival split = %v, want appended 20 / quarantined 3", rep.Arrival)
	}
	if rep.Reprocess[diag.OutcomeAppended] != 3 {
		t.Fatalf("reprocess.appended = %d, want 3", rep.Reprocess[diag.OutcomeAppended])
	}
	if rep.Unaccounted != 0 {
		t.Fatalf("unaccounted = %d, want 0", rep.Unaccounted)
	}
	if got := rep.ArrivalSum(); got != rep.InboundTotal {
		t.Fatalf("the arrival parts sum to %d but inbound_total is %d", got, rep.InboundTotal)
	}
	if err := rep.Err(); err != nil {
		t.Fatalf("a balanced report reports a failure: %v", err)
	}
	// Every known outcome is present even at zero. A key that is simply absent
	// is indistinguishable from a key the report forgot to count.
	for _, o := range ArrivalOutcomes {
		if _, ok := rep.Arrival[o]; !ok {
			t.Fatalf("arrival split omits %q entirely", o)
		}
	}
	for _, o := range ReprocessOutcomes {
		if _, ok := rep.Reprocess[o]; !ok {
			t.Fatalf("reprocess split omits %q entirely", o)
		}
	}
}

func TestAccountingFailsWhenAnOutcomeIsUnknown(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()

	arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")
	// The closed enum is the first line of defence and it holds — so the only
	// way an unnameable outcome reaches the table is a caller that walked past
	// it. Dropping the constraint IS that caller, and it is the only way to
	// prove this instrument can report a real gap rather than only ever saying
	// "fine".
	exec(t, pool, `ALTER TABLE parse_diagnostics DROP CONSTRAINT parse_diagnostics_outcome_matches_event`)
	exec(t, pool, `ALTER TABLE parse_diagnostics DROP CONSTRAINT parse_diagnostics_reject_reason_pairs_with_a_refusal`)
	arrival(t, pool, u, now, "", diag.TierNone, "")

	rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.Unaccounted != 1 {
		t.Fatalf("unaccounted = %d, want 1", rep.Unaccounted)
	}
	if rep.InboundTotal != 2 {
		t.Fatalf("inbound_total = %d, want 2: an unclassifiable row is still an arrival", rep.InboundTotal)
	}
	if rep.ArrivalSum() != 1 {
		t.Fatalf("the arrival parts sum to %d, want 1 — the unknown row must NOT be smuggled "+
			"into a named bucket, or the equation balances for the wrong reason", rep.ArrivalSum())
	}
	if rep.Err() == nil {
		t.Fatal("Err() is nil with an unaccounted arrival: a non-zero unaccounted is a hard failure")
	}
	if len(rep.Findings()) == 0 {
		t.Fatal("Findings() is empty with an unaccounted arrival")
	}
}

func TestAccountingReportsProtocolRejections(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()
	arrival(t, pool, u, now, diag.OutcomeAppended, diag.TierTemplate, "")

	exec(t, pool, `INSERT INTO smtp_rejections (day, reason, count)
	               VALUES ($1::date, 'unknown_rcpt', 7), ($1::date, 'too_large', 2)`,
		now.Format("2006-01-02"))

	rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.ProtocolRejections["unknown_rcpt"] != 7 || rep.ProtocolRejections["too_large"] != 2 {
		t.Fatalf("protocol rejections = %v, want unknown_rcpt 7 / too_large 2", rep.ProtocolRejections)
	}
	if rep.ProtocolRejectionsTotal() != 9 {
		t.Fatalf("protocol rejection total = %d, want 9", rep.ProtocolRejectionsTotal())
	}
	// They are NOT arrivals: nothing about them resolved a recipient, so folding
	// them into inbound_total would claim a user received mail nobody received.
	if rep.InboundTotal != 1 {
		t.Fatalf("inbound_total = %d, want 1", rep.InboundTotal)
	}
	if rep.Err() != nil {
		t.Fatalf("protocol rejections are accounted, not a failure: %v", rep.Err())
	}
}

// TestAccountingReportsHeldMailThatVanished is the second falsifiability proof.
// 'quarantined' is the one arrival outcome that is not terminal, and the only
// closure for it is "still held, or removed with a record". The BEFORE DELETE
// trigger is what makes an untraced removal impossible; disabling it is how the
// verifier's own ability to notice gets tested.
func TestAccountingReportsHeldMailThatVanished(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()

	hold(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)

	clean, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if clean.Quarantine.Untraced != 0 {
		t.Fatalf("held mail that is still held reads as untraced: %+v", clean.Quarantine)
	}
	if clean.Err() != nil {
		t.Fatalf("a message sitting in quarantine is a failure: %v", clean.Err())
	}

	exec(t, pool, `ALTER TABLE quarantine DISABLE TRIGGER quarantine_no_untraced_removal`)
	exec(t, pool, `DELETE FROM quarantine WHERE user_id = $1`, u)

	gone, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if gone.Quarantine.Untraced != 1 {
		t.Fatalf("quarantine reconciliation = %+v, want 1 untraced", gone.Quarantine)
	}
	if gone.Err() == nil {
		t.Fatal("Err() is nil after a held message disappeared with no removal record")
	}
	if !hasFinding(gone.Findings(), A2QuarantineUntraced) {
		t.Fatalf("findings %v do not include %s", ids(gone.Findings()), A2QuarantineUntraced)
	}
}

func TestAccountingReconcilesAPromotedAndAnExpiredHold(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()

	// Two holds, both since removed with a record — the normal path.
	for _, reason := range []string{"promoted", "expired"} {
		id := arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
		exec(t, pool, `INSERT INTO quarantine_removals
		  (quarantine_id, user_id, ingest_id, received_at, expires_at, warned_at, removed_at,
		   reason, outer_domain, attested, size_bucket)
		  VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 days',$4,$4,$5,'bank.test',false,1024)`,
			uuid.New(), u, id, now, reason)
	}
	// A normalizer failure is ALSO a hold, even though its outcome is
	// 'rejected'. Missing that would report every one of them as untraced.
	hold(t, pool, u, arrival(t, pool, u, now, diag.OutcomeRejected, diag.TierNone, diag.RejectNoTextPart), now)

	// And a protocol refusal, which stored NOTHING and must not be expected in
	// quarantine at all.
	arrival(t, pool, u, now, diag.OutcomeRejected, diag.TierNone, diag.RejectTooLarge)

	rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.Quarantine.Expected != 3 {
		t.Fatalf("expected holds = %d, want 3 (2 quarantined + 1 normalizer failure, "+
			"and NOT the too_large refusal)", rep.Quarantine.Expected)
	}
	if rep.Quarantine.Held != 1 || rep.Quarantine.Expired != 1 || rep.Quarantine.Promoted != 1 {
		t.Fatalf("quarantine reconciliation = %+v, want held 1 / expired 1 / promoted 1", rep.Quarantine)
	}
	if rep.Quarantine.Untraced != 0 {
		t.Fatalf("untraced = %d, want 0", rep.Quarantine.Untraced)
	}
	if err := rep.Err(); err != nil {
		t.Fatalf("a fully reconciled quarantine reports a failure: %v", err)
	}
}

// TestAccountingNamesWhatItCannotSee is the honesty gate. A report that claims
// "every email accounted for" while three refusal classes vanish inside a
// dependency's command loop is worse than one that says which three, so the
// blind spots travel WITH the report rather than in a document nobody reads
// beside it.
func TestAccountingNamesWhatItCannotSee(t *testing.T) {
	pool := pgtest.New(t)
	now := time.Now().UTC()
	rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if len(rep.BlindSpots) == 0 {
		t.Fatal("the report names no blind spots at all")
	}
	joined := strings.Join(blindSpotIDs(rep.BlindSpots), " ")
	for _, want := range []string{
		"smtp_500_long_line",
		"smtp_501_malformed_path",
		"smtp_452_extra_recipient",
		"rejection_flush_window",
		"diagnostics_write_failure",
		"rejection_day_granularity",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("blind spots %q do not name %q", joined, want)
		}
	}
	for _, b := range rep.BlindSpots {
		if b.Reason == "" {
			t.Errorf("blind spot %q has no reason: naming a gap without saying why it is "+
				"there is how it stops being revisited", b.ID)
		}
		if b.Direction != Undercount && b.Direction != Overcount {
			t.Errorf("blind spot %q does not say which way it biases the count", b.ID)
		}
	}
}

func blindSpotIDs(b []BlindSpot) []string {
	out := make([]string, 0, len(b))
	for _, x := range b {
		out = append(out, x.ID)
	}
	return out
}

// TestAccountingWindowIsHalfOpen pins both edges. The step is a MICROSECOND,
// not a nanosecond: Postgres stores timestamptz at microsecond resolution, so a
// nanosecond offset is not representable and the "just past the row" bound would
// silently be the row's own timestamp — a test that passed without testing
// anything.
func TestAccountingWindowIsHalfOpen(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for _, at := range []time.Time{now.Add(-2 * time.Hour), now, now.Add(2 * time.Hour)} {
		arrival(t, pool, u, at, diag.OutcomeAppended, diag.TierTemplate, "")
	}

	rep, err := Accounting(bg, pool, now, now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.InboundTotal != 1 {
		t.Fatalf("inbound_total = %d, want 1: the lower bound is inclusive", rep.InboundTotal)
	}
	if !rep.From.Equal(now) || !rep.To.Equal(now.Add(time.Hour)) {
		t.Fatalf("the report echoes the window %v..%v, want %v..%v", rep.From, rep.To, now, now.Add(time.Hour))
	}

	rep, err = Accounting(bg, pool, now.Add(time.Microsecond), now.Add(2*time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.InboundTotal != 0 {
		t.Fatalf("inbound_total = %d, want 0 with the row just below the window", rep.InboundTotal)
	}
}

// ---------------------------------------------------------------------------
// The dedup lane: a duplicate is a CLAIM that we already hold the message
// ---------------------------------------------------------------------------

// expire puts a message through the state Task 29's fix closed: held, then the
// hold expires and is traced away. The message is gone, and the trace says so.
func expire(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte, at time.Time) {
	t.Helper()
	exec(t, pool, `INSERT INTO quarantine_removals
	  (quarantine_id, user_id, ingest_id, received_at, expires_at, warned_at, removed_at,
	   reason, outer_domain, attested, size_bucket)
	  VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 days',$4,$4,
	          'expired','bank.test',false,1024)`, uuid.New(), u, id, at)
}

func promote(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte, at time.Time) {
	t.Helper()
	exec(t, pool, `INSERT INTO quarantine_removals
	  (quarantine_id, user_id, ingest_id, received_at, expires_at, warned_at, removed_at,
	   reason, outer_domain, attested, size_bucket)
	  VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 days',$4,$4,
	          'promoted','bank.test',false,1024)`, uuid.New(), u, id, at)
}

// TestAccountingDetectsADuplicateOfAMessageWeNoLongerHold is the drop class the
// first version of this instrument certified as healthy.
//
// The sequence, all of it legal against every constraint: a message is
// quarantined; the hold expires and is traced away with a removal record, which
// satisfies the quarantine reconciliation completely; the sender retries; the
// retry is refused as a 'duplicate' of a message that no longer exists anywhere.
// Nothing is stored, and the equation not only balanced but counted the lost
// email TWICE in inbound_total — so the drop INFLATED the number the exit
// criterion is read off.
//
// Task 29's fix (b65c8f8) means the pipeline can no longer produce this. That is
// exactly why the verifier must be able to see it: an instrument whose only
// evidence is that the code is currently correct is not an instrument.
func TestAccountingDetectsADuplicateOfAMessageWeNoLongerHold(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()
	from, to := now.Add(-time.Hour), now.Add(time.Hour)

	id := arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
	expire(t, pool, u, id, now)
	diagRowFor(t, pool, u, id, now, diag.EventArrival, diag.OutcomeDuplicate, diag.TierNone, "")

	rep, err := Accounting(bg, pool, from, to)
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	// The precondition: everything the old instrument looked at is spotless.
	if rep.Unaccounted != 0 || rep.Quarantine.Untraced != 0 {
		t.Fatalf("precondition lost: unaccounted %d, untraced %d — this test only proves "+
			"something if the OLD checks pass", rep.Unaccounted, rep.Quarantine.Untraced)
	}
	if rep.Discarded != 1 {
		t.Fatalf("discarded = %d, want 1: a 'duplicate' whose message is in no store is a "+
			"message we threw away", rep.Discarded)
	}
	if !hasFinding(rep.Findings(), A3DuplicateOfNothing) {
		t.Fatalf("findings %v do not include %s", ids(rep.Findings()), A3DuplicateOfNothing)
	}
	if rep.Err() == nil {
		t.Fatal("Err() is nil for a message that was received twice and kept zero times")
	}
}

// The other side of the same check: every state in which a duplicate is a
// CORRECT refusal must stay silent, or the finding is noise. These are exactly
// the three sources ingest.alreadyHandled consults, which is the point — the
// verifier re-asks the question the pipeline answered, against the store as it
// is NOW rather than as it was then.
func TestADuplicateOfSomethingWeStillHoldIsHealthy(t *testing.T) {
	now := time.Now().UTC()
	for _, tc := range []struct {
		name  string
		store func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte)
	}{
		{"the op was appended", func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte) {
			diagRowFor(t, pool, u, id, now, diag.EventArrival, diag.OutcomeAppended, diag.TierTemplate, "")
		}},
		{"a re-parse superseded it", func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte) {
			diagRowFor(t, pool, u, id, now, diag.EventReprocess, diag.OutcomeSuperseded, diag.TierTemplate, "")
		}},
		{"it is still held", func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte) {
			diagRowFor(t, pool, u, id, now, diag.EventArrival, diag.OutcomeQuarantined, diag.TierNone, "")
			hold(t, pool, u, id, now)
		}},
		{"the hold was promoted into the log", func(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, id []byte) {
			diagRowFor(t, pool, u, id, now, diag.EventArrival, diag.OutcomeQuarantined, diag.TierNone, "")
			promote(t, pool, u, id, now)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := pgtest.New(t)
			u := insertUser(t, pool)
			id := sha256.Sum256([]byte("one message"))
			tc.store(t, pool, u, id[:])
			diagRowFor(t, pool, u, id[:], now, diag.EventArrival, diag.OutcomeDuplicate, diag.TierNone, "")

			rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
			if err != nil {
				t.Fatalf("Accounting: %v", err)
			}
			if rep.Discarded != 0 {
				t.Fatalf("discarded = %d, want 0: refusing a redelivery of something we hold "+
					"is the dedup lane working", rep.Discarded)
			}
			if err := rep.Err(); err != nil {
				t.Fatalf("a correct duplicate refusal reports a failure: %v", err)
			}
		})
	}
}

// TestQuarantineReconciliationComparesIdentitiesNotCounts.
//
// Untraced was `max(0, Expected - Accounted)` — arithmetic on two totals. One
// message lost and one message held whose diagnostics row never landed are
// opposite errors of size one, so together they cancel and the report reads
// clean. The second condition is the `diagnostics_write_failure` blind spot,
// which the report itself describes as routine — so the one cross-store check
// was disarmed by a documented-normal event.
func TestQuarantineReconciliationComparesIdentitiesNotCounts(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()

	// (a) held mail that vanished with no removal record.
	lost := arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, "")
	hold(t, pool, u, lost, now)
	exec(t, pool, `ALTER TABLE quarantine DISABLE TRIGGER quarantine_no_untraced_removal`)
	exec(t, pool, `DELETE FROM quarantine WHERE ingest_id = $1`, lost)

	// (b) a message genuinely held whose diagnostics row failed to write.
	orphan := sha256.Sum256([]byte("held but unrecorded"))
	hold(t, pool, u, orphan[:], now)

	rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.Quarantine.Untraced != 1 {
		t.Fatalf("untraced = %d, want 1: an equal and opposite extra must not cancel a loss "+
			"(%+v)", rep.Quarantine.Untraced, rep.Quarantine)
	}
	if rep.Quarantine.Extra != 1 {
		t.Fatalf("extra = %d, want 1 reported in its own right", rep.Quarantine.Extra)
	}
	if !hasFinding(rep.Findings(), A2QuarantineUntraced) {
		t.Fatalf("findings %v do not include %s", ids(rep.Findings()), A2QuarantineUntraced)
	}
}

// Held mail that DIED unpromoted is the number an operator most wants, and it
// was summed into one 'Removed' with the promotions.
func TestAccountingSeparatesExpiredHoldsFromPromotedOnes(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()

	for i := 0; i < 3; i++ {
		expire(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)
	}
	promote(t, pool, u, arrival(t, pool, u, now, diag.OutcomeQuarantined, diag.TierNone, ""), now)

	rep, err := Accounting(bg, pool, now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.Quarantine.Expired != 3 || rep.Quarantine.Promoted != 1 {
		t.Fatalf("quarantine = %+v, want expired 3 / promoted 1", rep.Quarantine)
	}
	if rep.Quarantine.Untraced != 0 {
		t.Fatalf("untraced = %d, want 0", rep.Quarantine.Untraced)
	}
}

// ---------------------------------------------------------------------------
// S5: the counter is the only witness a truncated log has
// ---------------------------------------------------------------------------

// S1 answers "are there holes between the rows that survive". It cannot answer
// "were there more rows" — deleting the TAIL leaves 1..N-1, which is dense, and
// deleting everything leaves nothing to be dense about. Restoring from a short
// backup produces exactly the first; a botched purge produces the second. Both
// are the most likely real loss, and both were zero findings.
//
// oplog_seq.next_seq is the witness: no production path deletes an op row, and a
// rolled-back append restores the counter, so next_seq == max(seq)+1 exactly.
func TestS5DetectsATruncatedTail(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 5)

	exec(t, pool, `DELETE FROM op_log WHERE user_id = $1 AND seq = 5`, u)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if hasFinding(got, S1SeqDense) {
		t.Fatal("S1 reported a truncated tail; if it can, this test is not about S5")
	}
	if !hasFinding(got, S5CounterMatchesHead) {
		t.Fatalf("findings %v do not include %s: 4 dense rows under a counter that says 6 "+
			"means a row was destroyed", ids(got), S5CounterMatchesHead)
	}
}

func TestS5DetectsAWhollyDeletedLog(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 3)

	exec(t, pool, `DELETE FROM op_log WHERE user_id = $1`, u)

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if !hasFinding(got, S5CounterMatchesHead) {
		t.Fatalf("findings %v do not include %s: an empty log under a counter of 4 is not "+
			"a new account", ids(got), S5CounterMatchesHead)
	}
}

func TestS5IsSilentOnAHealthyAndOnAnEmptyLog(t *testing.T) {
	pool := pgtest.New(t)
	busy := insertUser(t, pool)
	appendPairs(t, pool, busy, 3)
	insertUser(t, pool) // never wrote an op: next_seq 1, no rows, and that is correct

	got, err := Structural(bg, pool)
	if err != nil {
		t.Fatalf("Structural: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("clean database yields %v, want none", got)
	}
}

// ---------------------------------------------------------------------------
// The blind-spot list has to be able to go stale LOUDLY
// ---------------------------------------------------------------------------

// TestBlindSpotsNameEveryInboundDeliveryPath.
//
// BlindSpots was prose with nothing holding it to the code, and it went stale in
// one commit: the relay landed a whole second inbound mode that writes a message
// to disk and no parse_diagnostics row at all, so its mail is invisible to
// inbound_total — and nothing failed.
//
// A delivery path IS an implementation of smtpd.Handler. Enumerating them from
// the source means a third one cannot arrive without either writing diagnostics
// or being declared here.
func TestBlindSpotsNameEveryInboundDeliveryPath(t *testing.T) {
	found, err := inboundHandlers("../..")
	if err != nil {
		t.Fatalf("scanning for smtpd.Handler implementations: %v", err)
	}
	// The scanner must not pass by finding nothing.
	for _, want := range []string{"Pipeline", "Relay"} {
		if !slices.Contains(found, want) {
			t.Fatalf("the scan found %v, which does not include the known handler %q — "+
				"the search is broken, so a green result would mean nothing", found, want)
		}
	}
	for _, h := range found {
		if _, ok := InboundPaths[h]; !ok {
			t.Errorf("%s implements smtpd.Handler and is a way mail enters this system, but "+
				"verify.InboundPaths does not classify it. Either it writes a parse_diagnostics "+
				"row (say so) or its mail is invisible to inbound_total (add a BlindSpot).", h)
		}
	}
	for h, p := range InboundPaths {
		if !slices.Contains(found, h) {
			t.Errorf("verify.InboundPaths classifies %q, which no longer implements "+
				"smtpd.Handler; a stale entry is how the list stops being read", h)
		}
		if p.BlindSpot == "" {
			continue
		}
		if !slices.ContainsFunc(BlindSpots, func(b BlindSpot) bool { return b.ID == p.BlindSpot }) {
			t.Errorf("inbound path %q names blind spot %q, which is not in BlindSpots", h, p.BlindSpot)
		}
	}
}

func TestBlindSpotsNameTheRelaySpoolAndTheRetentionCascade(t *testing.T) {
	joined := strings.Join(blindSpotIDs(BlindSpots), " ")
	for _, want := range []string{
		"relay_spool_writes_no_diagnostics",
		"retention_and_deletion_shrink_past_windows",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("blind spots %q do not name %q", joined, want)
		}
	}
}

func TestProtocolRejectionDaysDoNotOverrunADayAlignedWindow(t *testing.T) {
	pool := pgtest.New(t)
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC)
	exec(t, pool, `INSERT INTO smtp_rejections (day, reason, count)
	               VALUES ('2026-08-14','unknown_rcpt',3), ('2026-08-15','unknown_rcpt',9)`)

	rep, err := Accounting(bg, pool, from, to)
	if err != nil {
		t.Fatalf("Accounting: %v", err)
	}
	if rep.ProtocolRejections["unknown_rcpt"] != 3 {
		t.Fatalf("unknown_rcpt = %d, want 3: [Aug 1 00:00Z, Aug 15 00:00Z) does not contain "+
			"Aug 15, and a window an operator aligned to whole days must not silently widen",
			rep.ProtocolRejections["unknown_rcpt"])
	}
	if rep.RejectionDays[1] != "2026-08-14" {
		t.Fatalf("rejection days = %v, want the range to end 2026-08-14", rep.RejectionDays)
	}
}
