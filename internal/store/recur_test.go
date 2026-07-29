package store

import (
	"testing"
	"time"
)

func insertRecurFixture(t *testing.T, st *Store, day string, amt int64, currency, merchant, status string) int64 {
	t.Helper()
	posted, err := time.Parse("2006-01-02", day)
	if err != nil {
		t.Fatalf("day %q: %v", day, err)
	}
	id, created, err := st.InsertTransaction(TransactionRow{
		PostedAt:    posted.UTC().Add(8 * time.Hour),
		AmountFils:  amt,
		Currency:    currency,
		Direction:   "debit",
		MerchantRaw: merchant,
		Status:      status,
		Confidence:  1,
	})
	if err != nil || !created {
		t.Fatalf("insert %s: created=%v err=%v", merchant, created, err)
	}
	return id
}

func TestSelectConfirmedForRecur(t *testing.T) {
	st := newTestStore(t)

	a := insertRecurFixture(t, st, "2026-05-01", 3_900, "AED", "netflix", "confirmed")
	insertRecurFixture(t, st, "2026-05-02", 1_000, "AED", "pending shop", "needs_review")
	insertRecurFixture(t, st, "2026-05-03", 5_000, "AED", "own transfer", "transfer")
	archived := insertRecurFixture(t, st, "2026-05-04", 2_000, "AED", "old shop", "confirmed")
	if err := st.ArchiveTransaction(archived); err != nil {
		t.Fatalf("archive: %v", err)
	}
	// Foreign currency with no rate: amount_aed is NULL → falls back to the
	// raw amount rather than dropping the row.
	gbp := insertRecurFixture(t, st, "2026-05-05", 7_700, "GBP", "uk shop", "confirmed")

	got, err := st.SelectConfirmedForRecur()
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(got) != 2 || got[0].ID != a || got[1].ID != gbp {
		t.Fatalf("got %+v, want confirmed rows %d,%d oldest first", got, a, gbp)
	}
	if got[0].Merchant != "netflix" || got[0].AmountFils != 3_900 || got[0].Direction != "debit" {
		t.Fatalf("row 0 = %+v", got[0])
	}
	if got[1].AmountFils != 7_700 {
		t.Fatalf("no-rate fallback amount = %d, want 7700", got[1].AmountFils)
	}
	if got[0].PostedAt.Format("2006-01-02") != "2026-05-01" {
		t.Fatalf("posted at = %v", got[0].PostedAt)
	}
	if got[0].CategoryID != nil {
		t.Fatalf("uncategorized row carries category %v", *got[0].CategoryID)
	}
}

func TestSelectConfirmedForRecurCarriesCategory(t *testing.T) {
	st := newTestStore(t)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, err := st.SelectCategories()
	if err != nil || len(cats) == 0 {
		t.Fatalf("categories: %v", err)
	}
	id := insertRecurFixture(t, st, "2026-05-01", 3_900, "AED", "netflix", "needs_review")
	if err := st.UpdateTransactionCategory(id, cats[0].ID, "confirmed"); err != nil {
		t.Fatalf("categorize: %v", err)
	}
	got, err := st.SelectConfirmedForRecur()
	if err != nil || len(got) != 1 {
		t.Fatalf("select: n=%d err=%v", len(got), err)
	}
	if got[0].CategoryID == nil || *got[0].CategoryID != cats[0].ID {
		t.Fatalf("category = %v, want %d", got[0].CategoryID, cats[0].ID)
	}
}

func TestSelectRecurTxnsBetween(t *testing.T) {
	st := newTestStore(t)

	a := insertRecurFixture(t, st, "2026-05-01", 3_900, "AED", "netflix", "confirmed")
	b := insertRecurFixture(t, st, "2026-05-02", 1_000, "AED", "pending shop", "needs_review")
	insertRecurFixture(t, st, "2026-05-03", 5_000, "AED", "own transfer", "transfer")
	insertRecurFixture(t, st, "2026-05-10", 9_000, "AED", "late shop", "confirmed")

	from, _ := time.Parse("2006-01-02", "2026-05-01")
	to, _ := time.Parse("2006-01-02", "2026-05-03")
	got, err := st.SelectRecurTxnsBetween(from, to)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	// Inclusive day bounds; needs_review included (bills match before the user
	// confirms them); transfers excluded; 05-10 outside the window.
	if len(got) != 2 || got[0].ID != a || got[1].ID != b {
		t.Fatalf("got %+v, want ids %d,%d", got, a, b)
	}
}

// TestScheduledProvenanceMigration simulates a database whose
// scheduled_transactions table predates the provenance column: reopening must
// add it via addColumnIfMissing and leave the table fully usable.
func TestScheduledProvenanceMigration(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := st.DB.Exec(`ALTER TABLE scheduled_transactions DROP COLUMN provenance`); err != nil {
		st.Close()
		t.Skipf("driver lacks DROP COLUMN: %v", err)
	}
	st.Close()

	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen pre-provenance db: %v", err)
	}
	defer st2.Close()
	r := validSchedule()
	r.Source = "detected"
	r.Provenance = `{"count":3}`
	id, err := st2.InsertScheduled(r)
	if err != nil {
		t.Fatalf("insert after migration: %v", err)
	}
	got, ok, err := st2.SelectScheduledByID(id)
	if err != nil || !ok || got.Provenance != `{"count":3}` {
		t.Fatalf("roundtrip after migration: ok=%v err=%v row=%+v", ok, err, got)
	}
}

func TestScheduledProvenanceRoundTrip(t *testing.T) {
	st := newTestStore(t)
	prov := `{"count":4,"avg_interval_days":30,"last_amounts_fils":[3900],"tx_ids":[1,2,3,4]}`
	r := validSchedule()
	r.Source = "detected"
	r.Provenance = prov
	id, err := st.InsertScheduled(r)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	got, ok, err := st.SelectScheduledByID(id)
	if err != nil || !ok {
		t.Fatalf("select: ok=%v err=%v", ok, err)
	}
	if got.Provenance != prov {
		t.Fatalf("provenance = %q, want %q", got.Provenance, prov)
	}
	if got.Status != "proposed" {
		t.Fatalf("detected rows default to proposed, got %q", got.Status)
	}
	// User edits never clobber detector provenance.
	got.Label = "Netflix (renamed)"
	if err := st.UpdateScheduled(got); err != nil {
		t.Fatalf("update: %v", err)
	}
	after, _, err := st.SelectScheduledByID(id)
	if err != nil {
		t.Fatalf("reselect: %v", err)
	}
	if after.Provenance != prov || after.Label != "Netflix (renamed)" {
		t.Fatalf("after update: %+v", after)
	}
}
