package verify

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/blob"
	"ledger/internal/v2/budget"
	"ledger/internal/v2/pgtest"
)

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

// ledgerAmount reads one account_usage row directly, with no coalesce: a
// MISSING row and a zero row are different states here, and a helper that hid
// the difference would make half of this file untestable.
func ledgerAmount(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, resource string) (int64, bool) {
	t.Helper()
	rows, err := pool.Query(bg,
		`SELECT amount FROM account_usage WHERE user_id = $1 AND resource = $2`, u, resource)
	if err != nil {
		t.Fatalf("read usage: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return 0, false
	}
	var amount int64
	if err := rows.Scan(&amount); err != nil {
		t.Fatalf("read usage: %v", err)
	}
	return amount, true
}

// storedBytes is the truth, computed by the test's own query rather than by the
// code under test.
func storedBytes(t *testing.T, pool *pgxpool.Pool, u uuid.UUID, stream string) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(bg,
		`SELECT coalesce(sum(octet_length(blob)), 0)::bigint FROM op_log
		  WHERE user_id = $1 AND stream = $2`, u, stream).Scan(&n); err != nil {
		t.Fatalf("stored bytes: %v", err)
	}
	return n
}

func usageFindings(t *testing.T, pool *pgxpool.Pool, users ...uuid.UUID) []Finding {
	t.Helper()
	f, err := UsageLedgerFor(bg, pool, users)
	if err != nil {
		t.Fatalf("UsageLedgerFor: %v", err)
	}
	return f
}

// findingFor returns the one finding whose detail names this resource.
func findingFor(t *testing.T, f []Finding, u uuid.UUID, resource string) Finding {
	t.Helper()
	var out []Finding
	for _, x := range f {
		if x.UserID == u && strings.HasPrefix(x.Detail, resource+":") {
			out = append(out, x)
		}
	}
	if len(out) != 1 {
		t.Fatalf("want exactly one %s finding for %s, got %d: %+v", resource, u, len(out), f)
	}
	return out[0]
}

// ---------------------------------------------------------------------------
// the reconciliation
// ---------------------------------------------------------------------------

// A log written by the REAL appender reconciles clean, and the number it wrote
// is the padded stored size rather than the plaintext.
//
// That second half is the point of the test. The design says outright that the
// charged bytes are the padded stored bytes, matching 00031's backfill;
// reconciling against a plaintext length would report drift on every account of
// a perfectly healthy box, and the gap would widen once Phase 3 seals the blob.
func TestTheLedgerReconcilesAgainstARealAppend(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendPairs(t, pool, u, 3)

	if f := usageFindings(t, pool, u); len(f) != 0 {
		t.Fatalf("a log written by the appender itself does not reconcile: %+v", f)
	}

	hot, ok := ledgerAmount(t, pool, u, budget.ResourceOplogHotBytes)
	if !ok {
		t.Fatal("the appender charged nothing: there is no oplog_hot_bytes row at all")
	}
	if want := storedBytes(t, pool, u, blob.StreamHot); hot != want {
		t.Fatalf("ledger holds %d hot bytes, stored rows total %d", hot, want)
	}
	// Three ops of eight bytes of plaintext each. Anything near 24 means the
	// ledger — or this check — is counting the payload and not the column.
	if hot <= 24 {
		t.Fatalf("hot usage is %d bytes: that is the plaintext, not the padded stored blob", hot)
	}
	cold, _ := ledgerAmount(t, pool, u, budget.ResourceOplogColdBytes)
	if want := storedBytes(t, pool, u, blob.StreamCold); cold != want {
		t.Fatalf("ledger holds %d cold bytes, stored rows total %d", cold, want)
	}
}

// Both directions are reported, and each says which one it is.
//
// They are not the same failure: a ledger that reads HIGH refuses an honest
// account writes it was entitled to, and one that reads LOW hands out budget
// that is already spent. An operator reading a wall of findings must not have to
// do the subtraction to tell them apart.
func TestUsageDriftIsReportedInBothDirectionsWithBothNumbers(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 2)
	actual := storedBytes(t, pool, u, blob.StreamHot)

	exec(t, pool, `UPDATE account_usage SET amount = $2 WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`,
		u, actual+1000)
	high := findingFor(t, usageFindings(t, pool, u), u, budget.ResourceOplogHotBytes)
	if high.ID != U1UsageDrift {
		t.Fatalf("finding id = %q, want %s", high.ID, U1UsageDrift)
	}
	for _, want := range []string{"too HIGH", "1000"} {
		if !strings.Contains(high.Detail, want) {
			t.Fatalf("a ledger 1000 bytes over reality reads %q, which does not contain %q", high.Detail, want)
		}
	}

	exec(t, pool, `UPDATE account_usage SET amount = $2 WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`,
		u, actual-500)
	low := findingFor(t, usageFindings(t, pool, u), u, budget.ResourceOplogHotBytes)
	for _, want := range []string{"too LOW", "500"} {
		if !strings.Contains(low.Detail, want) {
			t.Fatalf("a ledger 500 bytes under reality reads %q, which does not contain %q", low.Detail, want)
		}
	}
}

// A ledger row that is GONE is drift, not silence.
//
// This is the shape a bug in a decrement path leaves behind, and it is also
// what an account written by a build that never charged its bytes looks like.
// A reconciliation that only compared rows it found on both sides would report
// a clean box while nothing at all was being counted.
func TestStoredBytesWithNoLedgerRowAreDrift(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendPairs(t, pool, u, 2)
	exec(t, pool, `DELETE FROM account_usage WHERE user_id = $1`, u)

	f := usageFindings(t, pool, u)
	if len(f) != 2 {
		t.Fatalf("want a finding for each stream with a deleted ledger, got %d: %+v", len(f), f)
	}
	hot := findingFor(t, f, u, budget.ResourceOplogHotBytes)
	if !strings.Contains(hot.Detail, "the ledger says 0 bytes") {
		t.Fatalf("a missing row does not read as zero: %q", hot.Detail)
	}
	if !strings.Contains(hot.Detail, "too LOW") {
		t.Fatalf("a missing row with stored bytes must read LOW: %q", hot.Detail)
	}
}

// The mirror: an account with neither rows nor a ledger is silent. An audit that
// reported every quiet account would be one nobody reads.
func TestAnAccountWithNothingStoredIsSilent(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	if f := usageFindings(t, pool, u); len(f) != 0 {
		t.Fatalf("an empty account produced findings: %+v", f)
	}
	// And a zero row means the same thing as an absent one (00031's own words).
	exec(t, pool, `INSERT INTO account_usage (user_id, resource, amount)
	  VALUES ($1, 'oplog_hot_bytes', 0), ($1, 'quarantine_count', 0)`, u)
	if f := usageFindings(t, pool, u); len(f) != 0 {
		t.Fatalf("a zero ledger row on an empty account produced findings: %+v", f)
	}
}

// Held mail is reconciled too, in both of its resources.
//
// This test seeds quarantine rows with raw SQL, deliberately bypassing
// quarantine.Hold, so it measures the RECONCILIATION rather than the charging.
// That is why it still expects drift.
//
// It carried a ⚠ noting that Hold did not yet maintain the ledger and that every
// held message was therefore standing drift. That seam landed in 92cf546: Hold is
// transactional and charges both quarantine resources, and removeLocked releases
// them on the expiry sweep and on confirm-and-reingest alike. A box whose held
// mail arrived through Hold now reconciles to zero.
func TestHeldMailIsReconciledByBytesAndByCount(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		hold(t, pool, u, randBytes(t, 32), now)
	}

	f := usageFindings(t, pool, u)
	bytesF := findingFor(t, f, u, budget.ResourceQuarantineBytes)
	if !strings.Contains(bytesF.Detail, "3072") {
		t.Fatalf("three 1024-byte holds do not total 3072 in %q", bytesF.Detail)
	}
	countF := findingFor(t, f, u, budget.ResourceQuarantineCount)
	if !strings.Contains(countF.Detail, "held message(s)") {
		t.Fatalf("the hold COUNT is reported in bytes: %q", countF.Detail)
	}
	if !strings.Contains(countF.Detail, "total 3") {
		t.Fatalf("three holds do not total 3 in %q", countF.Detail)
	}
}

// Scoping answers about one account and stays silent about the other, so an
// operator investigating one abuser is not handed the whole box.
func TestUsageReconciliationCanBeScopedToOneAccount(t *testing.T) {
	pool := pgtest.New(t)
	a, b := insertUser(t, pool), insertUser(t, pool)
	for _, u := range []uuid.UUID{a, b} {
		appendHot(t, pool, u, 1)
		exec(t, pool, `UPDATE account_usage SET amount = amount + 7
		                WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`, u)
	}
	if f := usageFindings(t, pool, a); len(f) != 1 || f[0].UserID != a {
		t.Fatalf("scoping to one account returned %+v", f)
	}
	if f := usageFindings(t, pool); len(f) != 2 {
		t.Fatalf("unscoped, both accounts must be reported, got %+v", f)
	}
}

// ---------------------------------------------------------------------------
// the repair
// ---------------------------------------------------------------------------

// The repair writes the recomputed total, in both directions and for a row that
// was missing entirely — and the reconciliation is clean afterwards.
//
// This is §7's deploy window: migrations run out of band before the new binary
// starts, so the old binary keeps writing between 00031's backfill and the
// restart. The first run after a deploy is expected to find that drift and to
// repair it.
func TestRepairSetsEachDriftingRowToItsRecomputedTotal(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendPairs(t, pool, u, 2)
	hot := storedBytes(t, pool, u, blob.StreamHot)
	cold := storedBytes(t, pool, u, blob.StreamCold)

	exec(t, pool, `UPDATE account_usage SET amount = amount + 4096
	                WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`, u)
	exec(t, pool, `DELETE FROM account_usage WHERE user_id = $1 AND resource = 'oplog_cold_bytes'`, u)

	corrections, err := RepairUsageLedger(bg, pool, []uuid.UUID{u})
	if err != nil {
		t.Fatalf("RepairUsageLedger: %v", err)
	}
	if len(corrections) != 2 {
		t.Fatalf("want a correction per drifting row, got %d: %+v", len(corrections), corrections)
	}
	for _, c := range corrections {
		switch c.Resource {
		case budget.ResourceOplogHotBytes:
			if c.From != hot+4096 || c.To != hot {
				t.Fatalf("hot correction %+v, want from %d to %d", c, hot+4096, hot)
			}
		case budget.ResourceOplogColdBytes:
			if c.From != 0 || c.To != cold {
				t.Fatalf("cold correction %+v, want from 0 to %d", c, cold)
			}
		default:
			t.Fatalf("unexpected correction %+v", c)
		}
	}
	if f := usageFindings(t, pool, u); len(f) != 0 {
		t.Fatalf("the ledger still drifts after a repair: %+v", f)
	}
	if got, _ := ledgerAmount(t, pool, u, budget.ResourceOplogColdBytes); got != cold {
		t.Fatalf("cold row holds %d after the repair, want %d", got, cold)
	}
}

// A correct ledger is left ALONE: no corrections, and no write.
//
// The write half matters as much as the number. A repair that rewrote every row
// with the value it already had would churn account_usage on every run and would
// report a repair where nothing was wrong, which is how "it repaired something"
// stops meaning anything.
func TestRepairLeavesACorrectLedgerUntouched(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 2)

	var before string
	if err := pool.QueryRow(bg,
		`SELECT max(updated_at)::text FROM account_usage WHERE user_id = $1`, u).Scan(&before); err != nil {
		t.Fatal(err)
	}
	corrections, err := RepairUsageLedger(bg, pool, []uuid.UUID{u})
	if err != nil {
		t.Fatalf("RepairUsageLedger: %v", err)
	}
	if len(corrections) != 0 {
		t.Fatalf("a correct ledger was 'repaired': %+v", corrections)
	}
	var after string
	if err := pool.QueryRow(bg,
		`SELECT max(updated_at)::text FROM account_usage WHERE user_id = $1`, u).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("the repair rewrote a correct row: updated_at moved from %s to %s", before, after)
	}
}

// A row that stopped drifting between the survey and its turn is skipped.
//
// The repair surveys first and then takes one row at a time, so a live append
// can correct a row in between — that is the ledger working, not a repair, and
// writing over it would report a correction that corrected nothing. The guard is
// exercised directly here because there is no way to schedule that race from a
// test, and a guard nothing can fail is a comment.
func TestRepairSkipsARowThatStoppedDriftingBeforeItsTurn(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 1)

	// A stale survey result: it CLAIMS drift, the row is in fact correct.
	stale := drift{UserID: u, Resource: budget.ResourceOplogHotBytes, Ledger: 999999, Actual: 0}
	c, ok, err := repairOne(bg, pool, stale)
	if err != nil {
		t.Fatalf("repairOne: %v", err)
	}
	if ok {
		t.Fatalf("a row that no longer drifts was rewritten and reported as %+v", c)
	}
	if got, _ := ledgerAmount(t, pool, u, budget.ResourceOplogHotBytes); got != storedBytes(t, pool, u, blob.StreamHot) {
		t.Fatalf("the ledger holds %d after a skipped repair", got)
	}
}

// An account purged between the survey and the repair is skipped, not an error.
//
// The usage rows cascade with the account, so the insert that would recreate one
// hits the foreign key. Recreating it is not an option — that is a record of how
// much a forgotten person stored — and failing the whole run would let one
// deletion abandon every other account's repair.
func TestRepairSkipsAnAccountThatWasPurgedMidRun(t *testing.T) {
	pool := pgtest.New(t)
	gone := uuid.New()
	c, ok, err := repairOne(bg, pool, drift{
		UserID: gone, Resource: budget.ResourceOplogHotBytes, Ledger: 0, Actual: 4096,
	})
	if err != nil {
		t.Fatalf("repairing a deleted account is an error rather than a skip: %v", err)
	}
	if ok {
		t.Fatalf("a usage row was written for an account that does not exist: %+v", c)
	}
}

// The report itself never writes. It is the half a cron runs unattended, and a
// self-healing audit is indistinguishable from a correct one.
func TestTheReconciliationReportsAndDoesNotRepair(t *testing.T) {
	pool := pgtest.New(t)
	u := insertUser(t, pool)
	appendHot(t, pool, u, 1)
	exec(t, pool, `UPDATE account_usage SET amount = 999999 WHERE user_id = $1 AND resource = 'oplog_hot_bytes'`, u)

	if f := usageFindings(t, pool, u); len(f) != 1 {
		t.Fatalf("want one finding, got %+v", f)
	}
	if got, _ := ledgerAmount(t, pool, u, budget.ResourceOplogHotBytes); got != 999999 {
		t.Fatalf("the report changed the ledger: amount is now %d, want the drifting 999999", got)
	}
	// And it is still reported on the second run, rather than having been
	// quietly healed by the first.
	if f := usageFindings(t, pool, u); len(f) != 1 {
		t.Fatalf("the second run reads %+v; a report that heals hides the bug it found", f)
	}
}

// The resource names this file builds in SQL are the ledger's own.
//
// They are assembled from the stream ('oplog_' || stream || '_bytes'), exactly
// as 00031's backfill assembles them, so nothing in Go spells them for that
// path. A typo would compare every account's hot bytes against a resource
// nothing writes: the whole log would read as drift, and the repair would write
// a row the CHECK constraint refuses.
func TestTheReconciledResourceNamesAreTheLedgersOwn(t *testing.T) {
	if got := "oplog_" + blob.StreamHot + "_bytes"; got != budget.ResourceOplogHotBytes {
		t.Errorf("the hot stream builds %q, the ledger holds %q", got, budget.ResourceOplogHotBytes)
	}
	if got := "oplog_" + blob.StreamCold + "_bytes"; got != budget.ResourceOplogColdBytes {
		t.Errorf("the cold stream builds %q, the ledger holds %q", got, budget.ResourceOplogColdBytes)
	}
	if got := streamForResource(budget.ResourceOplogColdBytes); got != blob.StreamCold {
		t.Errorf("streamForResource(cold bytes) = %q, want %q", got, blob.StreamCold)
	}
	if got := streamForResource(budget.ResourceOplogHotBytes); got != blob.StreamHot {
		t.Errorf("streamForResource(hot bytes) = %q, want %q", got, blob.StreamHot)
	}
	for _, r := range repairable {
		if usageUnit(r) == "" {
			t.Errorf("resource %q has no unit", r)
		}
	}
	if len(repairable) != 4 {
		t.Errorf("repairable names %d resources, the ledger has 4", len(repairable))
	}
}
