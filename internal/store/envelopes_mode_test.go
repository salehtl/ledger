package store

import "testing"

// buildCarryoverFixture creates a category whose PRIOR month underspends (so
// envelope mode carries money forward) and whose month-before-that overspends
// (so envelope mode charges debt). Returns the category id and the month to
// query. The fixture must produce non-zero carryover AND non-zero debt under
// envelope mode, otherwise the simple-mode assertions below would pass
// vacuously — the envelope-mode test at the end is what proves it does.
//
// Uses the existing insertTxn helper (projects_test.go), which inserts a
// confirmed transaction by default — envelopeActivity only counts
// status='confirmed' rows, so a fixture built on anything else would produce
// zero activity and every assertion here would pass vacuously.
func buildCarryoverFixture(t *testing.T, st *Store) (int64, string) {
	t.Helper()
	cat := seedCat(t, st, "Groceries")
	// Two months back: assign 100, spend 300 -> 200 overspent, charged forward.
	if err := st.UpsertEnvelopeAssignment("2026-01", cat, 10000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, cat, "debit", 30000, "2026-01-15", "confirmed")
	// One month back: assign 500, spend 100 -> 400 left, carried forward.
	if err := st.UpsertEnvelopeAssignment("2026-02", cat, 50000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, cat, "debit", 10000, "2026-02-15", "confirmed")
	// The month under test.
	if err := st.UpsertEnvelopeAssignment("2026-03", cat, 20000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, cat, "debit", 5000, "2026-03-15", "confirmed")
	return cat, "2026-03"
}

func rowFor(t *testing.T, rows []EnvelopeMonthRow, categoryID int64) EnvelopeMonthRow {
	t.Helper()
	for _, r := range rows {
		if r.CategoryID == categoryID {
			return r
		}
	}
	t.Fatalf("category %d not in summary", categoryID)
	return EnvelopeMonthRow{}
}

// Envelope mode must keep working — it is sunset, not deleted. This test is
// also what proves the simple-mode tests below are not vacuous: it asserts
// the fixture genuinely exercises both halves of the fold.
//
// It checks carryover and debt at two different target months, not one, and
// this is load-bearing, not a stylistic choice: envelopeEraFold makes it
// mathematically impossible for a single category to show non-zero
// CarryoverFils and non-zero OverspendDebtFils in the SAME target month.
// debt = peak(final) - peak(before prevMonth) is only > 0 when prevMonth (the
// last folded month, since no month exists between prevMonth and the target)
// sets a NEW record low — but that forces the era balance at that final point
// to equal exactly -peak, which makes carry = b+peak = 0 by construction.
// Verified independently by direct calculation against this fixture's own
// numbers:
//
//	target=2026-02 (prevMonth=2026-01, only January folded): carry=0, debt=20000
//	target=2026-03 (prevMonth=2026-02, January+February folded): carry=40000, debt=0
//
// So this test reads OverspendDebtFils at "2026-02" (where the January
// overspend is freshly charged) and CarryoverFils at "2026-03" (where
// February's recovery has folded in) — the same underlying history, the same
// category, proving both branches of the fold actually run.
func TestEnvelopeMonthSummary_EnvelopeModeStillCarries(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	debtRows, err := st.EnvelopeMonthSummary("2026-02", BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	debtRow := rowFor(t, debtRows, cat)
	if debtRow.OverspendDebtFils == 0 {
		t.Error("envelope mode produced zero overspend debt at 2026-02 — fixture is not exercising the fold")
	}

	carryRows, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	carryRow := rowFor(t, carryRows, cat)
	if carryRow.CarryoverFils == 0 {
		t.Error("envelope mode produced zero carryover at 2026-03 — fixture is not exercising the fold")
	}
	t.Logf("envelope mode: debt(2026-02)=%d carryover(2026-03)=%d", debtRow.OverspendDebtFils, carryRow.CarryoverFils)
}

// Simple mode: the budget persists, spending resets, nothing carries.
//
// The OverspendDebtFils assertion here is checked at BOTH "2026-03" (where
// envelope mode also gives debt=0 — see TestEnvelopeMonthSummary_EnvelopeModeStillCarries
// — so on its own that assertion would pass whether or not simple mode
// suppresses the fold at all) AND at "2026-02" (where envelope mode gives
// debt=20000, so a genuine, non-vacuous check that simple mode actually
// zeroes it). Without the second read, no test in the package would ever
// catch a future refactor that silently restored prior-month overspend
// charging in simple mode.
func TestEnvelopeMonthSummary_SimpleModeCarriesNothing(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	rows, err := st.EnvelopeMonthSummary(month, BudgetModeSimple)
	if err != nil {
		t.Fatal(err)
	}
	r := rowFor(t, rows, cat)
	if r.CarryoverFils != 0 {
		t.Errorf("CarryoverFils = %d, want 0 in simple mode", r.CarryoverFils)
	}
	if r.OverspendDebtFils != 0 {
		t.Errorf("OverspendDebtFils = %d, want 0 in simple mode", r.OverspendDebtFils)
	}
	if r.AssignedFils != 20000 {
		t.Errorf("AssignedFils = %d, want 20000 — the budget itself must be untouched", r.AssignedFils)
	}
	if r.ActivityFils != 5000 {
		t.Errorf("ActivityFils = %d, want 5000 — this month's spending only", r.ActivityFils)
	}

	// Non-vacuous debt check: envelope mode gives debt=20000 at "2026-02"
	// (the January overspend freshly charged — see
	// TestEnvelopeMonthSummary_EnvelopeModeStillCarries), so this genuinely
	// discriminates simple mode's suppression of the fold.
	febRows, err := st.EnvelopeMonthSummary("2026-02", BudgetModeSimple)
	if err != nil {
		t.Fatal(err)
	}
	feb := rowFor(t, febRows, cat)
	if feb.OverspendDebtFils != 0 {
		t.Errorf("OverspendDebtFils at 2026-02 = %d, want 0 in simple mode (envelope mode gives 20000 here)", feb.OverspendDebtFils)
	}
	if feb.CarryoverFils != 0 {
		t.Errorf("CarryoverFils at 2026-02 = %d, want 0 in simple mode", feb.CarryoverFils)
	}
}

// An unknown mode must behave as simple, not error and not carry.
//
// Same non-vacuity concern as SimpleModeCarriesNothing: checking only
// "2026-03" would pass regardless of whether the fold ran, since envelope
// mode also gives debt=0 there. "2026-02" is where envelope mode gives
// debt=20000, so it is the assertion that actually proves something.
func TestEnvelopeMonthSummary_UnknownModeIsSimple(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	rows, err := st.EnvelopeMonthSummary(month, "nonsense")
	if err != nil {
		t.Fatal(err)
	}
	r := rowFor(t, rows, cat)
	if r.CarryoverFils != 0 || r.OverspendDebtFils != 0 {
		t.Errorf("unknown mode carried: carryover=%d debt=%d", r.CarryoverFils, r.OverspendDebtFils)
	}

	febRows, err := st.EnvelopeMonthSummary("2026-02", "nonsense")
	if err != nil {
		t.Fatal(err)
	}
	feb := rowFor(t, febRows, cat)
	if feb.OverspendDebtFils != 0 {
		t.Errorf("unknown mode carried debt at 2026-02: %d, want 0 (envelope mode gives 20000 here)", feb.OverspendDebtFils)
	}
}

// Flipping back must reproduce the original figures exactly — that is what
// makes the sunset reversible rather than a one-way door.
func TestEnvelopeMonthSummary_ModeIsReversible(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	before, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.EnvelopeMonthSummary(month, BudgetModeSimple); err != nil {
		t.Fatal(err)
	}
	after, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	b, a := rowFor(t, before, cat), rowFor(t, after, cat)
	if b != a {
		t.Errorf("envelope figures changed after a simple-mode read:\n before=%+v\n after =%+v", b, a)
	}
}
