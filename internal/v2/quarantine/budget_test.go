package quarantine

// budget_test.go covers the quarantine half of P1 in
// docs/superpowers/specs/2026-08-09-account-isolation-design.md: the usage
// ledger is maintained in the same transaction as the write that changes it,
// every path that removes a hold gives the budget back, and a refusal is an
// error the caller can see plus a receipt the user can read.
//
// Every test here was proven to bite by mutating the implementation and
// watching it fail — the mutations are named in the comments on the tests they
// belong to.

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"ledger/internal/v2/budget"
	"ledger/internal/v2/verify"
)

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// setQuarantineLimits lowers the default policy row so a test can reach a
// ceiling with a handful of bytes rather than 100 MB.
func setQuarantineLimits(t *testing.T, pool *pgxpool.Pool, maxBytes, maxHolds int64) {
	t.Helper()
	if _, err := pool.Exec(bg,
		`UPDATE account_limits SET quarantine_bytes = $1, quarantine_count = $2 WHERE user_id IS NULL`,
		maxBytes, maxHolds); err != nil {
		t.Fatal(err)
	}
}

// ledger reads the two quarantine resources for one account.
func ledger(t *testing.T, pool *pgxpool.Pool, u uuid.UUID) (heldBytes, holds int64) {
	t.Helper()
	g := budget.New(pool)
	b, err := g.Usage(bg, u, budget.ResourceQuarantineBytes)
	if err != nil {
		t.Fatal(err)
	}
	n, err := g.Usage(bg, u, budget.ResourceQuarantineCount)
	if err != nil {
		t.Fatal(err)
	}
	return b, n
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

// assertNoDrift runs the SAME reconciliation `ledgerd verify` runs — verify's
// usage ledger check, which recomputes sum(octet_length(blob)) and count(*) from
// the quarantine table itself — and requires it to find nothing.
//
// It is the point of this whole file rather than a bonus assertion: the ledger
// is a number nobody reads, so an internal check that the ledger equals what
// this package thinks it wrote would pass just as happily on two copies of the
// same mistake. This one asks the stored rows.
func assertNoDrift(t *testing.T, pool *pgxpool.Pool, users ...uuid.UUID) {
	t.Helper()
	findings, err := verify.UsageLedgerFor(bg, pool, users)
	if err != nil {
		t.Fatalf("usage reconciliation: %v", err)
	}
	for _, f := range findings {
		t.Errorf("usage drift: %s %s: %s", f.UserID, f.ID, f.Detail)
	}
}

// ---------------------------------------------------------------------------
// The charge
// ---------------------------------------------------------------------------

// TestHoldChargesTheAccountsQuarantineBudget is the seam itself. The charged
// bytes must be the STORED bytes — the same octet_length(blob) migration 00031
// backfills and internal/v2/verify recomputes — or a healthy box reports drift
// forever.
//
// Proven to bite: charging len(it.Blob)+1, or charging it.SizeBucket instead of
// len(it.Blob), fails both the amount assertion and assertNoDrift. Deleting the
// two Admit calls fails every assertion here.
func TestHoldChargesTheAccountsQuarantineBudget(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)

	a := hold(t, s, item(u, *now, "one"))
	b := hold(t, s, item(u, now.Add(time.Second), "two"))

	wantBytes := int64(len(a.Blob) + len(b.Blob))
	gotBytes, gotHolds := ledger(t, pool, u)
	if gotBytes != wantBytes || gotHolds != 2 {
		t.Fatalf("ledger after two holds = %d bytes / %d holds, want %d / 2", gotBytes, gotHolds, wantBytes)
	}
	assertNoDrift(t, pool, u)
}

// TestOneAccountsHoldIsNotChargedToAnother pins the "attributable to exactly one
// account" half of the principle.
//
// Proven to bite: charging it.UserID with a hard-coded other user's id, or
// summing both users into one row, fails the second account's assertion.
func TestOneAccountsHoldIsNotChargedToAnother(t *testing.T) {
	s, now, pool := newStore(t)
	one, two := insertUser(t, pool), insertUser(t, pool)

	it := hold(t, s, item(one, *now, "mine"))

	if b, n := ledger(t, pool, one); b != int64(len(it.Blob)) || n != 1 {
		t.Fatalf("holder's ledger = %d / %d, want %d / 1", b, n, len(it.Blob))
	}
	if b, n := ledger(t, pool, two); b != 0 || n != 0 {
		t.Fatalf("a bystander was charged %d bytes / %d holds, want 0 / 0", b, n)
	}
	assertNoDrift(t, pool, one, two)
}

// TestARedeliveryIsNotChargedTwice is the difference between a budget and a
// slow lockout. Hold is idempotent per (user, ingest id) because an SMTP retry
// is the same message arriving again — and a sender that retries for three days
// would otherwise bill the account for every attempt.
//
// Proven to bite: charging before the INSERT (or dropping the RowsAffected
// guard) doubles both amounts and fails assertNoDrift as well.
func TestARedeliveryIsNotChargedTwice(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)

	it := item(u, *now, "retried")
	hold(t, s, it)
	// The same message, a new row id, exactly as a redelivery arrives.
	again := it
	again.ID = uuid.Nil
	hold(t, s, again)

	if b, n := ledger(t, pool, u); b != int64(len(it.Blob)) || n != 1 {
		t.Fatalf("ledger after a redelivery = %d / %d, want %d / 1", b, n, len(it.Blob))
	}
	assertNoDrift(t, pool, u)
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

// TestHoldIsRefusedAtTheByteCeilingAndStoresNothing covers all three halves of
// "nothing is silently dropped": the caller can tell refused from stored, the
// message really is not stored, and the refusal is counted where the user's own
// app can read it.
//
// Proven to bite: returning nil instead of the Admit error stores the message
// and fails the "not stored" assertion; committing before Admit leaves the row
// behind; a refusal recorded inside the caller's transaction (the mistake
// budget.recordRefusal exists to prevent) makes the account_refusals assertion
// read 0.
func TestHoldIsRefusedAtTheByteCeilingAndStoresNothing(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)

	first := item(u, *now, "first")
	setQuarantineLimits(t, pool, int64(len(first.Blob)), 500)
	hold(t, s, first)

	second := item(u, now.Add(time.Second), "second")
	err := s.Hold(bg, second)
	if !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("a hold over the byte ceiling = %v, want budget.ErrRefused", err)
	}
	if items := listAll(t, s, u); len(items) != 1 {
		t.Fatalf("a refused hold stored %d messages, want the first one only", len(items))
	}
	if b, n := ledger(t, pool, u); b != int64(len(first.Blob)) || n != 1 {
		t.Fatalf("ledger after a refused hold = %d / %d, want %d / 1", b, n, len(first.Blob))
	}
	if got := refusalCount(t, pool, u, budget.ResourceQuarantineBytes); got != 1 {
		t.Fatalf("account_refusals for quarantine_bytes = %d, want 1", got)
	}
	assertNoDrift(t, pool, u)
}

// TestHoldIsRefusedAtTheHoldCountCeiling: 500 tiny held messages are as much of
// a nuisance as 100 MB of large ones, so the two ceilings refuse independently.
//
// Proven to bite: charging only quarantine_bytes and not quarantine_count makes
// the second hold succeed.
func TestHoldIsRefusedAtTheHoldCountCeiling(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	setQuarantineLimits(t, pool, 100<<20, 1)

	hold(t, s, item(u, *now, "first"))

	err := s.Hold(bg, item(u, now.Add(time.Second), "second"))
	if !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("a hold over the count ceiling = %v, want budget.ErrRefused", err)
	}
	if got := refusalCount(t, pool, u, budget.ResourceQuarantineCount); got != 1 {
		t.Fatalf("account_refusals for quarantine_count = %d, want 1", got)
	}
	assertNoDrift(t, pool, u)
}

// TestTheLedgerIsUnchangedByARolledBackHold is the case that makes transactional
// co-location worth the trouble, and it is built so the transaction really does
// roll back with a charge already written inside it: the byte ceiling is
// generous, so quarantine_bytes is incremented; the hold ceiling is full, so the
// SECOND Admit refuses. Whether the ledger is left as it was found is then a
// property of the transaction and of nothing else.
//
// Proven to bite: charging on a separate, committed transaction rather than on
// the caller's tx — the one-line difference between co-located accounting and
// the bug this whole design is aimed at — leaves the byte increment behind, and
// this test reads the inflated amount.
//
// The ORDER of the two Admit calls is load bearing for the test and not for the
// implementation: charging the count first would refuse before anything was
// written, and the test would then pass without ever exercising a rollback. If
// that order is ever changed, this test has to be rebuilt around whichever
// resource is charged first.
func TestTheLedgerIsUnchangedByARolledBackHold(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	setQuarantineLimits(t, pool, 100<<20, 1)

	first := hold(t, s, item(u, *now, "first"))
	beforeBytes, beforeHolds := ledger(t, pool, u)
	if beforeBytes != int64(len(first.Blob)) || beforeHolds != 1 {
		t.Fatalf("precondition: ledger = %d / %d, want %d / 1", beforeBytes, beforeHolds, len(first.Blob))
	}

	// This hold's bytes are admitted and its count is refused, so the
	// transaction rolls back having already written to account_usage.
	if err := s.Hold(bg, item(u, now.Add(time.Second), "rolled back")); !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("hold = %v, want budget.ErrRefused", err)
	}

	afterBytes, afterHolds := ledger(t, pool, u)
	if afterBytes != beforeBytes || afterHolds != beforeHolds {
		t.Fatalf("ledger after a rolled-back hold = %d / %d, want it unchanged at %d / %d",
			afterBytes, afterHolds, beforeBytes, beforeHolds)
	}
	if items := listAll(t, s, u); len(items) != 1 {
		t.Fatalf("a rolled-back hold left %d messages stored, want 1", len(items))
	}
	assertNoDrift(t, pool, u)
}

// ---------------------------------------------------------------------------
// The releases — every path that removes a hold
// ---------------------------------------------------------------------------

// TestTheExpirySweepReleasesTheQuarantineBudget is release path 1. A quarantine
// budget that only ever grows is a slow lockout of an honest user: mail expires
// after 30 days, and if the bytes never come back the account is permanently
// billed for messages the server itself deleted.
//
// Proven to bite: deleting the release call from removeLocked leaves the ledger
// at the held amount, which fails both the amount assertion and assertNoDrift.
func TestTheExpirySweepReleasesTheQuarantineBudget(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)

	kept := hold(t, s, item(u, *now, "kept"))
	// Received earlier, so it expires first and the surviving hold's charge is
	// still visible afterwards. A release that zeroed the row rather than
	// subtracting would pass a test where nothing was left.
	hold(t, s, item(u, now.Add(-14*24*time.Hour), "expiring"))

	*now = now.Add(DefaultTTL - DefaultWarnBefore - 13*24*time.Hour)
	if warned, _, err := s.ExpireDue(bg); err != nil || warned != 1 {
		t.Fatalf("warning sweep = %d warned, %v; want 1 warned", warned, err)
	}
	*now = now.Add(DefaultWarnBefore)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 1 {
		t.Fatalf("deleting sweep = %d deleted, %v; want 1 deleted", deleted, err)
	}

	if b, n := ledger(t, pool, u); b != int64(len(kept.Blob)) || n != 1 {
		t.Fatalf("ledger after an expiry = %d / %d, want the surviving hold's %d / 1", b, n, len(kept.Blob))
	}
	assertNoDrift(t, pool, u)
}

// TestPromotionReleasesTheQuarantineBudget is release path 2:
// confirm-and-reingest (handleConfirmSender -> Confirm -> reingest ->
// Store.Promote). It moves the bytes OUT of quarantine and INTO the op log, so
// they are released here while the append charges them there — an account
// confirming a sender must not stay billed for the copy this store deleted.
//
// Proven to bite: the same mutation as above (removeLocked is the one seam both
// paths run through), and separately, releasing only in sweepBatch rather than
// in removeLocked leaves this test failing while the expiry one passes — which
// is exactly the "there are three paths, not one" error the design warns about.
func TestPromotionReleasesTheQuarantineBudget(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)

	promoted := hold(t, s, item(u, *now, "promoted"))
	kept := hold(t, s, item(u, now.Add(time.Second), "kept"))

	n, err := s.Promote(bg, u, [][]byte{promoted.IngestID})
	if err != nil || n != 1 {
		t.Fatalf("promote = %d, %v; want 1", n, err)
	}
	if b, holds := ledger(t, pool, u); b != int64(len(kept.Blob)) || holds != 1 {
		t.Fatalf("ledger after a promotion = %d / %d, want the surviving hold's %d / 1", b, holds, len(kept.Blob))
	}
	assertNoDrift(t, pool, u)
}

// TestAReleasedBudgetCanBeSpentAgain is the lockout stated as behaviour rather
// than as arithmetic: an account at its ceiling whose held mail expires must be
// able to receive again.
//
// Proven to bite: any mutation that skips the release makes the second hold
// return ErrRefused.
func TestAReleasedBudgetCanBeSpentAgain(t *testing.T) {
	s, now, pool := newStore(t)
	u := insertUser(t, pool)
	setQuarantineLimits(t, pool, 100<<20, 1)

	hold(t, s, item(u, *now, "first"))
	if err := s.Hold(bg, item(u, now.Add(time.Second), "blocked")); !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("precondition: a full lane = %v, want budget.ErrRefused", err)
	}

	*now = now.Add(DefaultTTL - DefaultWarnBefore)
	if warned, _, err := s.ExpireDue(bg); err != nil || warned != 1 {
		t.Fatalf("warning sweep = %d warned, %v; want 1 warned", warned, err)
	}
	*now = now.Add(DefaultWarnBefore)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 1 {
		t.Fatalf("deleting sweep = %d deleted, %v; want 1 deleted", deleted, err)
	}

	if err := s.Hold(bg, item(u, *now, "after the sweep")); err != nil {
		t.Fatalf("a hold after the lane emptied = %v, want it admitted", err)
	}
	assertNoDrift(t, pool, u)
}

// TestOneSweepReleasesEachAccountsOwnBytes is the multi-account batch. The sweep
// scans by expiry and not by user, so one transaction can remove holds belonging
// to several accounts — and a release that credited the whole batch to the first
// user it saw would hand one account another's budget.
//
// Proven to bite: aggregating the RETURNING rows without keying on user_id (or
// crediting ids[0]'s owner) fails one of the two assertions and assertNoDrift.
func TestOneSweepReleasesEachAccountsOwnBytes(t *testing.T) {
	s, now, pool := newStore(t)
	one, two := insertUser(t, pool), insertUser(t, pool)

	expiring := now.Add(-14 * 24 * time.Hour)
	hold(t, s, item(one, expiring, "one-expiring"))
	hold(t, s, item(two, expiring, "two-expiring"))
	keptTwo := hold(t, s, item(two, *now, "two-kept"))

	*now = now.Add(DefaultTTL - DefaultWarnBefore - 13*24*time.Hour)
	if warned, _, err := s.ExpireDue(bg); err != nil || warned != 2 {
		t.Fatalf("warning sweep = %d warned, %v; want 2 warned", warned, err)
	}
	*now = now.Add(DefaultWarnBefore)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 2 {
		t.Fatalf("deleting sweep = %d deleted, %v; want 2 deleted", deleted, err)
	}

	if b, n := ledger(t, pool, one); b != 0 || n != 0 {
		t.Fatalf("the emptied account's ledger = %d / %d, want 0 / 0", b, n)
	}
	if b, n := ledger(t, pool, two); b != int64(len(keptTwo.Blob)) || n != 1 {
		t.Fatalf("the other account's ledger = %d / %d, want %d / 1", b, n, len(keptTwo.Blob))
	}
	assertNoDrift(t, pool, one, two)
}

// TestTheUsageLedgerReconcilesAcrossAWholeQuarantineLifecycle is the end-to-end
// the task exists for: hold, redeliver, refuse, promote and expire, and then ask
// `ledgerd verify`'s own reconciliation whether the ledger still describes the
// stored rows. Standing quarantine drift on a box with held mail was the
// symptom; this is the assertion that it is gone.
//
// Proven to bite: every mutation named on the tests above also fails this one,
// which is the point — it is the check that does not take this package's word
// for anything.
func TestTheUsageLedgerReconcilesAcrossAWholeQuarantineLifecycle(t *testing.T) {
	s, now, pool := newStore(t)
	one, two := insertUser(t, pool), insertUser(t, pool)
	setQuarantineLimits(t, pool, 100<<20, 3)

	held := hold(t, s, item(one, now.Add(-14*24*time.Hour), "will expire"))
	promoted := hold(t, s, item(one, *now, "will be promoted"))
	hold(t, s, item(one, now.Add(time.Second), "will stay"))
	// A redelivery of one already held, and then one message past the ceiling.
	redelivered := held
	redelivered.ID = uuid.Nil
	hold(t, s, redelivered)
	if err := s.Hold(bg, item(one, now.Add(2*time.Second), "refused")); !errors.Is(err, budget.ErrRefused) {
		t.Fatalf("the fourth hold = %v, want budget.ErrRefused", err)
	}
	hold(t, s, forwarded(two, *now, "another account"))

	if n, err := s.Promote(bg, one, [][]byte{promoted.IngestID}); err != nil || n != 1 {
		t.Fatalf("promote = %d, %v; want 1", n, err)
	}
	*now = now.Add(DefaultTTL - DefaultWarnBefore - 13*24*time.Hour)
	if _, _, err := s.ExpireDue(bg); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(DefaultWarnBefore)
	if _, deleted, err := s.ExpireDue(bg); err != nil || deleted != 1 {
		t.Fatalf("deleting sweep = %d deleted, %v; want 1 deleted", deleted, err)
	}

	// Every account on the box, not just the two this test named: a drift the
	// reconciliation attributes to somebody else is still drift.
	assertNoDrift(t, pool)
}
