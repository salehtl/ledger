package store

import (
	"errors"
	"testing"
)

func TestEnvelopeMonthValidation(t *testing.T) {
	st := newTestStore(t)
	for _, month := range []string{"", "2026", "2026-7", "2026/07", "2026-13", "2026-00", "26-07", "2026-ab"} {
		t.Run("month "+month, func(t *testing.T) {
			if err := st.UpsertEnvelopeAssignment(month, 1, 100); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Fatalf("upsert %q: want ErrEnvelopeInvalid, got %v", month, err)
			}
			if _, err := st.AddToEnvelopeAssignment(month, 1, 100); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Fatalf("add %q: want ErrEnvelopeInvalid, got %v", month, err)
			}
			if _, err := st.EnvelopeMonthSummary(month); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Fatalf("summary %q: want ErrEnvelopeInvalid, got %v", month, err)
			}
		})
	}
	if err := st.UpsertEnvelopeAssignment("2026-07", 0, 100); !errors.Is(err, ErrEnvelopeInvalid) {
		t.Fatalf("zero category: want ErrEnvelopeInvalid, got %v", err)
	}
}

func TestEnvelopeAssignmentUpsertAddTotal(t *testing.T) {
	st := newTestStore(t)
	catA := insertCategory(t, st, "EnvA", "spending", "need")
	catB := insertCategory(t, st, "EnvB", "spending", "want")

	if err := st.UpsertEnvelopeAssignment("2026-07", catA, 100_000); err != nil {
		t.Fatal(err)
	}
	// Absolute overwrite.
	if err := st.UpsertEnvelopeAssignment("2026-07", catA, 120_000); err != nil {
		t.Fatal(err)
	}
	// Delta add creates the row when absent and accumulates when present.
	if got, err := st.AddToEnvelopeAssignment("2026-07", catB, 50_000); err != nil || got != 50_000 {
		t.Fatalf("add new: got %d err=%v", got, err)
	}
	if got, err := st.AddToEnvelopeAssignment("2026-07", catB, -20_000); err != nil || got != 30_000 {
		t.Fatalf("add delta: got %d err=%v", got, err)
	}
	// Batch set in one transaction.
	if err := st.UpsertEnvelopeAssignments("2026-08", map[int64]int64{catA: 5_000, catB: 7_000}); err != nil {
		t.Fatal(err)
	}

	rows, err := st.SelectEnvelopeAssignments("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	got := map[int64]int64{}
	for _, r := range rows {
		got[r.CategoryID] = r.AssignedFils
	}
	if got[catA] != 120_000 || got[catB] != 30_000 {
		t.Fatalf("assignments=%v", got)
	}
	if total, err := st.TotalAssigned("2026-07"); err != nil || total != 150_000 {
		t.Fatalf("total 07: %d err=%v", total, err)
	}
	if total, err := st.TotalAssigned("2026-08"); err != nil || total != 12_000 {
		t.Fatalf("total 08: %d err=%v", total, err)
	}
}

// summaryFor picks one category's row out of the month summary.
func summaryFor(t *testing.T, rows []EnvelopeMonthRow, catID int64) EnvelopeMonthRow {
	t.Helper()
	for _, r := range rows {
		if r.CategoryID == catID {
			return r
		}
	}
	t.Fatalf("category %d missing from summary", catID)
	return EnvelopeMonthRow{}
}

func TestEnvelopeMonthSummary(t *testing.T) {
	st := newTestStore(t)
	grocery := insertCategory(t, st, "EnvGroceries", "spending", "need")
	dining := insertCategory(t, st, "EnvDining", "spending", "want")

	// Prior month: assigned 100_000, spent 60_000 → carryover +40_000.
	if err := st.UpsertEnvelopeAssignment("2026-06", grocery, 100_000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, grocery, "debit", 60_000, "2026-06-10", "confirmed")

	// This month: assigned 150_000; spent 30_000 debit, refunded 5_000 credit → 25_000.
	if err := st.UpsertEnvelopeAssignment("2026-07", grocery, 150_000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, grocery, "debit", 30_000, "2026-07-05", "confirmed")
	insertTxn(t, st, grocery, "credit", 5_000, "2026-07-06", "confirmed")
	// Pending rows never count as activity.
	insertTxn(t, st, grocery, "debit", 99_000, "2026-07-07", "needs_review")

	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	g := summaryFor(t, rows, grocery)
	if g.AssignedFils != 150_000 {
		t.Fatalf("assigned=%d want 150000", g.AssignedFils)
	}
	if g.ActivityFils != 25_000 {
		t.Fatalf("activity=%d want 25000", g.ActivityFils)
	}
	if g.CarryoverFils != 40_000 {
		t.Fatalf("carryover=%d want 40000", g.CarryoverFils)
	}
	// Untouched category rides along with zeros (graceful degradation).
	d := summaryFor(t, rows, dining)
	if d.AssignedFils != 0 || d.ActivityFils != 0 || d.CarryoverFils != 0 {
		t.Fatalf("dining should be all-zero, got %+v", d)
	}
	// Buckets order: need before want.
	gi, di := -1, -1
	for i, r := range rows {
		if r.CategoryID == grocery {
			gi = i
		}
		if r.CategoryID == dining {
			di = i
		}
	}
	if gi > di {
		t.Fatalf("need category should sort before want (grocery=%d dining=%d)", gi, di)
	}
}

func TestEnvelopeActivityIncludesSplitLines(t *testing.T) {
	st := newTestStore(t)
	grocery := insertCategory(t, st, "SplitEnvG", "spending", "need")
	dining := insertCategory(t, st, "SplitEnvD", "spending", "want")

	// Grocery is budgeted from July (envelope era starts at the first
	// assignment month); dining is never assigned.
	if err := st.UpsertEnvelopeAssignment("2026-07", grocery, 0); err != nil {
		t.Fatal(err)
	}
	// One confirmed 100_000 transaction, split 70/30 across the two envelopes.
	txID := insertTxn(t, st, grocery, "debit", 100_000, "2026-07-10", "confirmed")
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: grocery, AmountFils: 70_000},
		{CategoryID: dining, AmountFils: 30_000},
	}); err != nil {
		t.Fatal(err)
	}

	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.ActivityFils != 70_000 {
		t.Fatalf("grocery activity=%d want 70000 (split line, no parent double-count)", g.ActivityFils)
	}
	if d := summaryFor(t, rows, dining); d.ActivityFils != 30_000 {
		t.Fatalf("dining activity=%d want 30000", d.ActivityFils)
	}

	// Splits in a prior month flow into overspend debt the same way — but only
	// inside the category's envelope era: budgeted grocery's July overspend is
	// charged (once) to August, never-assigned dining enters August clean.
	rows, err = st.EnvelopeMonthSummary("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.CarryoverFils != 0 || g.OverspendDebtFils != 70_000 {
		t.Fatalf("grocery carry/debt=%d/%d want 0/70000", g.CarryoverFils, g.OverspendDebtFils)
	}
	if d := summaryFor(t, rows, dining); d.CarryoverFils != 0 || d.OverspendDebtFils != 0 {
		t.Fatalf("dining carry/debt=%d/%d want 0/0 (never assigned → no envelope era)", d.CarryoverFils, d.OverspendDebtFils)
	}
}

// TestEnvelopeCarryoverScopedToEnvelopeEra is the brownfield regression: on a
// database with months of pre-envelope confirmed history and zero assignments,
// GET /api/envelopes on day one must NOT charge lifetime spend against
// Ready-to-Assign as overspend debt.
func TestEnvelopeCarryoverScopedToEnvelopeEra(t *testing.T) {
	st := newTestStore(t)
	grocery := insertCategory(t, st, "EraG", "spending", "need")

	// Six months of ordinary v2 history, no envelope assignments anywhere.
	for _, day := range []string{"2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10", "2026-06-10"} {
		insertTxn(t, st, grocery, "debit", 100_000, day, "confirmed")
	}
	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.CarryoverFils != 0 {
		t.Fatalf("pre-envelope history leaked into carryover: %d, want 0", g.CarryoverFils)
	}

	// The user starts budgeting grocery in July. From then on, uncovered
	// in-era overspend DOES charge — but the pre-era months still never count.
	if err := st.UpsertEnvelopeAssignment("2026-07", grocery, 60_000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, grocery, "debit", 90_000, "2026-07-15", "confirmed")
	rows, err = st.EnvelopeMonthSummary("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.CarryoverFils != 0 || g.OverspendDebtFils != 30_000 {
		t.Fatalf("in-era carry/debt=%d/%d want 0/30000 (60000 assigned − 90000 spent; pre-era spend excluded)",
			g.CarryoverFils, g.OverspendDebtFils)
	}
}

// TestEnvelopeOverspendChargedExactlyOnce is the RTA-identity regression: a
// cash overspend must cost Ready-to-Assign its exact amount, exactly once —
// never a perpetual monthly charge, and never a double charge when the user
// later assigns to the category. Scenario from the review: June assign 500,
// spend 500; July spend 100 unassigned.
func TestEnvelopeOverspendChargedExactlyOnce(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "OnceCat", "spending", "want")
	if err := st.UpsertEnvelopeAssignment("2026-06", cat, 50_000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, cat, "debit", 50_000, "2026-06-10", "confirmed")
	insertTxn(t, st, cat, "debit", 10_000, "2026-07-10", "confirmed")

	// August: the July overspend is charged, once, and settles the envelope.
	rows, err := st.EnvelopeMonthSummary("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.CarryoverFils != 0 || g.OverspendDebtFils != 10_000 {
		t.Fatalf("Aug carry/debt=%d/%d, want 0/10000 (charged once)", g.CarryoverFils, g.OverspendDebtFils)
	}

	// September, nothing covered by hand: the SAME overspend must NOT charge
	// again — the August charge already settled it.
	rows, err = st.EnvelopeMonthSummary("2026-09")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.CarryoverFils != 0 || g.OverspendDebtFils != 0 {
		t.Fatalf("Sep carry/debt=%d/%d, want 0/0 (no perpetual re-charge)", g.CarryoverFils, g.OverspendDebtFils)
	}

	// The user assigns 100 in September anyway (the old "covering" reflex).
	// That is ordinary new funding: it must stay spendable and carry into
	// October — not vanish into the already-settled debt, and not trigger a
	// second charge.
	if err := st.UpsertEnvelopeAssignment("2026-09", cat, 10_000); err != nil {
		t.Fatal(err)
	}
	rows, err = st.EnvelopeMonthSummary("2026-10")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.CarryoverFils != 10_000 || g.OverspendDebtFils != 0 {
		t.Fatalf("Oct carry/debt=%d/%d, want 10000/0 (assignment carries forward, debt settled)",
			g.CarryoverFils, g.OverspendDebtFils)
	}
}

// TestEnvelopeRepeatedOverspendChargesOnlyNewDebt: each month's NEW unfunded
// overspend charges its following month; funded spending never charges.
func TestEnvelopeRepeatedOverspendChargesOnlyNewDebt(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "DeltaDebtCat", "spending", "need")
	// June: assign 200, spend 300 → 100 unfunded.
	if err := st.UpsertEnvelopeAssignment("2026-06", cat, 20_000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, cat, "debit", 30_000, "2026-06-15", "confirmed")
	// July: assign 50, spend 100 → another 50 unfunded.
	if err := st.UpsertEnvelopeAssignment("2026-07", cat, 5_000); err != nil {
		t.Fatal(err)
	}
	insertTxn(t, st, cat, "debit", 10_000, "2026-07-15", "confirmed")

	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.OverspendDebtFils != 10_000 {
		t.Fatalf("Jul debt=%d, want 10000 (June's unfunded overspend)", g.OverspendDebtFils)
	}
	rows, err = st.EnvelopeMonthSummary("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.CarryoverFils != 0 || g.OverspendDebtFils != 5_000 {
		t.Fatalf("Aug carry/debt=%d/%d, want 0/5000 (only July's NEW unfunded 50)",
			g.CarryoverFils, g.OverspendDebtFils)
	}
}

// TestEnvelopeActivityIgnoresUnconvertedForeign: a foreign-currency
// transaction with NO FX rate yet must contribute nothing to envelope
// activity (jar convention: COALESCE(amount_aed, 0)) — never its raw foreign
// minor units — so Plan and Home can never disagree about the same month, and
// fake-unit "spend" can never surface as overspend debt charged against RTA.
// It backfills once a rate exists, like the jars.
func TestEnvelopeActivityIgnoresUnconvertedForeign(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "FxNoRateCat", "spending", "want")
	if err := st.UpsertEnvelopeAssignment("2026-06", cat, 0); err != nil { // era starts June
		t.Fatal(err)
	}
	// GBP 100.00 (10000 pence) with no GBP rate seeded: amount_aed is NULL.
	txID := insertTxn(t, st, cat, "debit", 10_000, "2026-06-10", "confirmed")
	if _, err := st.DB.Exec(`UPDATE transactions SET currency='GBP', amount_aed=NULL WHERE id=?`, txID); err != nil {
		t.Fatal(err)
	}
	aedID := insertTxn(t, st, cat, "debit", 4_000, "2026-06-12", "confirmed")
	_ = aedID

	rows, err := st.EnvelopeMonthSummary("2026-06")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.ActivityFils != 4_000 {
		t.Fatalf("activity=%d want 4000 (unconverted GBP contributes 0, matching SelectMonthSpend)", g.ActivityFils)
	}
	// And it never becomes phantom overspend debt in the next month.
	rows, err = st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, cat); g.OverspendDebtFils != 4_000 {
		t.Fatalf("Jul debt=%d want 4000 (only the real AED spend, not raw pence)", g.OverspendDebtFils)
	}
}

// TestEnvelopeSplitActivityExactForForeignCurrency: a foreign-currency parent's
// split lines must sum to EXACTLY the parent's AED value — cumulative-floor
// scaling absorbs the integer-division remainder in the last line.
func TestEnvelopeSplitActivityExactForForeignCurrency(t *testing.T) {
	st := newTestStore(t)
	catA := insertCategory(t, st, "FxSplitA", "spending", "need")
	catB := insertCategory(t, st, "FxSplitB", "spending", "want")

	// USD 100.00 (amount 10000 minor units) worth 3673.0 fils-hundred AED.
	txID := insertTxn(t, st, catA, "debit", 10_000, "2026-07-10", "confirmed")
	if _, err := st.DB.Exec(
		`UPDATE transactions SET currency='USD', amount_aed=36730 WHERE id=?`, txID); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: catA, AmountFils: 3_333},
		{CategoryID: catB, AmountFils: 3_333},
		{CategoryID: catB, AmountFils: 3_334},
	}); err != nil {
		t.Fatal(err)
	}

	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	a := summaryFor(t, rows, catA).ActivityFils
	b := summaryFor(t, rows, catB).ActivityFils
	if a+b != 36_730 {
		t.Fatalf("split AED activity %d+%d = %d, want exactly the parent's 36730", a, b, a+b)
	}
	if a != 12_242 || b != 24_488 {
		t.Fatalf("per-category split activity = %d/%d, want 12242/24488 (last line absorbs the remainder)", a, b)
	}
}

// TestEnvelopeAssignmentRejectsNonEnvelopeCategories: money must never land in
// an assignment row the summary can't surface (income kinds, inactive rows,
// unknown ids) — that would silently break the RTA identity.
func TestEnvelopeAssignmentRejectsNonEnvelopeCategories(t *testing.T) {
	st := newTestStore(t)
	salary := insertCategory(t, st, "EnvSalary", "income", "")
	retired, err := st.InsertCategory(CategoryRow{Name: "EnvRetired", Kind: "spending", Bucket: "want", IsActive: false})
	if err != nil {
		t.Fatal(err)
	}
	ok := insertCategory(t, st, "EnvOK", "spending", "need")

	for name, catID := range map[string]int64{"income kind": salary, "inactive": retired, "unknown": 999_999} {
		t.Run(name, func(t *testing.T) {
			if err := st.UpsertEnvelopeAssignment("2026-07", catID, 50_000); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Errorf("upsert: want ErrEnvelopeInvalid, got %v", err)
			}
			if _, err := st.AddToEnvelopeAssignment("2026-07", catID, 50_000); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Errorf("add: want ErrEnvelopeInvalid, got %v", err)
			}
			if err := st.UpsertEnvelopeAssignments("2026-07", map[int64]int64{ok: 10_000, catID: 50_000}); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Errorf("batch: want ErrEnvelopeInvalid, got %v", err)
			}
			if err := st.ApplyEnvelopeDeltas("2026-07", []EnvelopeDelta{{CategoryID: catID, DeltaFils: 50_000}}); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Errorf("deltas: want ErrEnvelopeInvalid, got %v", err)
			}
		})
	}
	// Nothing leaked into the table (the batch with a bad member rolled back).
	if total, err := st.TotalAssigned("2026-07"); err != nil || total != 0 {
		t.Fatalf("total assigned = %d err=%v, want 0 (all rejected writes rolled back)", total, err)
	}
}

// TestMoveEnvelopeAssignmentAtomic: both legs land in one transaction; a
// rejected leg leaves the source untouched — assigned money can never vanish.
func TestMoveEnvelopeAssignmentAtomic(t *testing.T) {
	st := newTestStore(t)
	from := insertCategory(t, st, "MoveFrom", "spending", "need")
	to := insertCategory(t, st, "MoveTo", "spending", "want")
	salary := insertCategory(t, st, "MoveSalary", "income", "")
	if err := st.UpsertEnvelopeAssignment("2026-07", from, 100_000); err != nil {
		t.Fatal(err)
	}

	if err := st.MoveEnvelopeAssignment("2026-07", from, to, 40_000); err != nil {
		t.Fatalf("move: %v", err)
	}
	rows, err := st.SelectEnvelopeAssignments("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	got := map[int64]int64{}
	for _, r := range rows {
		got[r.CategoryID] = r.AssignedFils
	}
	if got[from] != 60_000 || got[to] != 40_000 {
		t.Fatalf("after move: from=%d to=%d, want 60000/40000", got[from], got[to])
	}

	// Moving to a non-envelope target must not shrink the source.
	if err := st.MoveEnvelopeAssignment("2026-07", from, salary, 10_000); !errors.Is(err, ErrEnvelopeInvalid) {
		t.Fatalf("move to income category: want ErrEnvelopeInvalid, got %v", err)
	}
	if total, err := st.TotalAssigned("2026-07"); err != nil || total != 100_000 {
		t.Fatalf("total after failed move = %d err=%v, want 100000 unchanged", total, err)
	}

	// Validation table.
	for name, args := range map[string][3]int64{
		"same category": {from, from, 10},
		"zero amount":   {from, to, 0},
		"negative":      {from, to, -5},
		"zero from":     {0, to, 10},
	} {
		t.Run(name, func(t *testing.T) {
			if err := st.MoveEnvelopeAssignment("2026-07", args[0], args[1], args[2]); !errors.Is(err, ErrEnvelopeInvalid) {
				t.Errorf("want ErrEnvelopeInvalid, got %v", err)
			}
		})
	}
}

// TestApplyEnvelopeDeltasBatch: the auto-assign application path is one SQL
// transaction and accumulates onto existing assignments.
func TestApplyEnvelopeDeltasBatch(t *testing.T) {
	st := newTestStore(t)
	catA := insertCategory(t, st, "DeltaA", "spending", "need")
	catB := insertCategory(t, st, "DeltaB", "spending", "want")
	if err := st.UpsertEnvelopeAssignment("2026-07", catA, 10_000); err != nil {
		t.Fatal(err)
	}
	if err := st.ApplyEnvelopeDeltas("2026-07", []EnvelopeDelta{
		{CategoryID: catA, DeltaFils: 5_000},
		{CategoryID: catB, DeltaFils: 7_000},
	}); err != nil {
		t.Fatal(err)
	}
	if total, err := st.TotalAssigned("2026-07"); err != nil || total != 22_000 {
		t.Fatalf("total = %d err=%v, want 22000", total, err)
	}
	// Empty plan is a no-op, not an error.
	if err := st.ApplyEnvelopeDeltas("2026-07", nil); err != nil {
		t.Fatalf("nil plan: %v", err)
	}
}

// TestEnvelopeActivityHonorsProjectCarveOut: spend inside a count_in_monthly=0
// life project is excluded from monthly budgeting everywhere — the jars filter
// it, so envelope activity must too, or Plan and Home disagree over the same
// transaction AND the carved-out spend folds into overspend debt charged
// against next month's Ready-to-Assign (money the monthly plan deliberately
// does not budget draining RTA with no opt-out).
func TestEnvelopeActivityHonorsProjectCarveOut(t *testing.T) {
	st := newTestStore(t)
	grocery := insertCategory(t, st, "CarveEnvG", "spending", "need")
	if err := st.UpsertEnvelopeAssignment("2026-07", grocery, 100_000); err != nil {
		t.Fatal(err)
	}
	spend := insertTxn(t, st, grocery, "debit", 500_000, "2026-07-10", "confirmed")
	pid, err := st.InsertProject(ProjectRow{Name: "CarveReno", Status: "active"}) // count_in_monthly=0
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AssignTransactionProject(spend, &pid); err != nil {
		t.Fatal(err)
	}

	// Carved out: no envelope activity in July…
	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.ActivityFils != 0 {
		t.Fatalf("July activity = %d, want 0 (carved-out project spend)", g.ActivityFils)
	}
	// …and no overspend debt charged to August's RTA; the assignment carries.
	rows, err = st.EnvelopeMonthSummary("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.OverspendDebtFils != 0 || g.CarryoverFils != 100_000 {
		t.Fatalf("August carryover/debt = %d/%d, want 100000/0", g.CarryoverFils, g.OverspendDebtFils)
	}

	// Toggling the project back into monthly counting restores the activity —
	// same recompute-on-read behavior as the jars.
	p, err := st.SelectProject(pid)
	if err != nil {
		t.Fatal(err)
	}
	p.CountInMonthly = true
	if err := st.UpdateProject(p); err != nil {
		t.Fatal(err)
	}
	rows, err = st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.ActivityFils != 500_000 {
		t.Fatalf("July activity after toggle = %d, want 500000", g.ActivityFils)
	}
	rows, err = st.EnvelopeMonthSummary("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if g := summaryFor(t, rows, grocery); g.OverspendDebtFils != 400_000 || g.CarryoverFils != 0 {
		t.Fatalf("August carryover/debt after toggle = %d/%d, want 0/400000", g.CarryoverFils, g.OverspendDebtFils)
	}
}

// TestEnvelopeSplitActivityHonorsProjectCarveOut: the carve-out rides the
// PARENT's project link into the split-line pass too.
func TestEnvelopeSplitActivityHonorsProjectCarveOut(t *testing.T) {
	st := newTestStore(t)
	grocery := insertCategory(t, st, "CarveSpG", "spending", "need")
	dining := insertCategory(t, st, "CarveSpD", "spending", "want")
	if err := st.UpsertEnvelopeAssignment("2026-07", grocery, 10_000); err != nil {
		t.Fatal(err)
	}
	parent := insertTxn(t, st, grocery, "debit", 100_000, "2026-07-12", "confirmed")
	pid, err := st.InsertProject(ProjectRow{Name: "CarveSplitReno", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AssignTransactionProject(parent, &pid); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceTransactionSplits(parent, []TransactionSplitRow{
		{CategoryID: grocery, AmountFils: 60_000},
		{CategoryID: dining, AmountFils: 40_000},
	}); err != nil {
		t.Fatal(err)
	}

	rows, err := st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g, d := summaryFor(t, rows, grocery), summaryFor(t, rows, dining); g.ActivityFils != 0 || d.ActivityFils != 0 {
		t.Fatalf("split-line activity = %d/%d, want 0/0 while parent is carved out", g.ActivityFils, d.ActivityFils)
	}

	p, err := st.SelectProject(pid)
	if err != nil {
		t.Fatal(err)
	}
	p.CountInMonthly = true
	if err := st.UpdateProject(p); err != nil {
		t.Fatal(err)
	}
	rows, err = st.EnvelopeMonthSummary("2026-07")
	if err != nil {
		t.Fatal(err)
	}
	if g, d := summaryFor(t, rows, grocery), summaryFor(t, rows, dining); g.ActivityFils != 60_000 || d.ActivityFils != 40_000 {
		t.Fatalf("split-line activity after toggle = %d/%d, want 60000/40000", g.ActivityFils, d.ActivityFils)
	}
}
