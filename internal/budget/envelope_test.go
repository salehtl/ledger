package budget

import (
	"testing"

	"ledger/internal/store"
)

// row is a shorthand EnvelopeMonthRow builder for tests. carry is the store's
// EFFECTIVE carryover (≥ 0 — see store.envelopeEraFold).
func row(id int64, name, bucket string, assigned, activity, carry int64) store.EnvelopeMonthRow {
	return store.EnvelopeMonthRow{
		CategoryID: id, CategoryName: name, Bucket: bucket,
		AssignedFils: assigned, ActivityFils: activity, CarryoverFils: carry,
	}
}

// rowDebt is row plus the store's one-time overspend debt charge.
func rowDebt(id int64, name, bucket string, assigned, activity, carry, debt int64) store.EnvelopeMonthRow {
	r := row(id, name, bucket, assigned, activity, carry)
	r.OverspendDebtFils = debt
	return r
}

func envByID(t *testing.T, s EnvelopeSummary, id int64) Envelope {
	t.Helper()
	for _, e := range s.Envelopes {
		if e.CategoryID == id {
			return e
		}
	}
	t.Fatalf("envelope for category %d missing", id)
	return Envelope{}
}

func mustCompute(t *testing.T, month string, income int64, rows []store.EnvelopeMonthRow, targets []store.CategoryTargetRow) EnvelopeSummary {
	t.Helper()
	s, err := ComputeEnvelopes(month, income, rows, targets)
	if err != nil {
		t.Fatalf("ComputeEnvelopes: %v", err)
	}
	return s
}

func TestComputeEnvelopesCoreIdentity(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		row(1, "groceries", "need", 100000, 40000, 25000), // carry 250 + assigned 1000 − activity 400 = 850
		row(2, "dining", "want", 20000, 50000, 0),         // 0 + 200 − 500 = −300 → overspent
	}
	s := mustCompute(t, "2026-07", 1000000, rows, nil)

	g := envByID(t, s, 1)
	if g.CarryoverFils != 25000 || g.AvailableFils != 85000 || g.Overspent {
		t.Errorf("groceries carry/avail/overspent = %d/%d/%v, want 25000/85000/false",
			g.CarryoverFils, g.AvailableFils, g.Overspent)
	}
	d := envByID(t, s, 2)
	if d.AvailableFils != -30000 || !d.Overspent {
		t.Errorf("dining avail/overspent = %d/%v, want -30000/true", d.AvailableFils, d.Overspent)
	}
	// Current-month overspend does NOT reduce this month's RTA.
	if s.AssignedFils != 120000 || s.OverspendDebtFils != 0 {
		t.Errorf("assigned/debt = %d/%d, want 120000/0", s.AssignedFils, s.OverspendDebtFils)
	}
	if s.ReadyToAssignFils != 1000000-120000 {
		t.Errorf("RTA = %d, want %d", s.ReadyToAssignFils, 1000000-120000)
	}
	// Row order preserved.
	if s.Envelopes[0].CategoryID != 1 || s.Envelopes[1].CategoryID != 2 {
		t.Errorf("row order not preserved: %+v", s.Envelopes)
	}
}

func TestComputeEnvelopesNegativeRTA(t *testing.T) {
	rows := []store.EnvelopeMonthRow{row(1, "rent", "need", 150000, 0, 0)}
	s := mustCompute(t, "2026-07", 100000, rows, nil)
	if s.ReadyToAssignFils != -50000 {
		t.Fatalf("RTA = %d, want -50000 (over-assignment allowed, goes negative)", s.ReadyToAssignFils)
	}
}

// YNAB-style rollover: last month's uncovered cash overspend arrives from the
// store as a ONE-TIME debt charge (carryover already settled to 0) and eats
// this month's RTA exactly once.
func TestComputeEnvelopesOverspendEatsRTA(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		rowDebt(1, "dining", "want", 10000, 0, 0, 30000), // overspent 300 last month → charged now
		row(2, "savings", "saving", 0, 0, 20000),         // healthy 200 carryover
		row(3, "groceries", "need", 5000, 2000, 0),       // untouched history
	}
	s := mustCompute(t, "2026-07", 1000000, rows, nil)

	d := envByID(t, s, 1)
	if d.CarryoverFils != 0 {
		t.Errorf("overspent envelope carryover = %d, want 0 (settled by the charge)", d.CarryoverFils)
	}
	if d.OverspendDebtFils != 30000 {
		t.Errorf("overspend debt = %d, want 30000", d.OverspendDebtFils)
	}
	if d.AvailableFils != 10000 { // 0 + 100 − 0: this month starts clean
		t.Errorf("overspent envelope avail = %d, want 10000", d.AvailableFils)
	}
	sv := envByID(t, s, 2)
	if sv.CarryoverFils != 20000 || sv.OverspendDebtFils != 0 {
		t.Errorf("healthy carryover = %d debt %d, want 20000/0", sv.CarryoverFils, sv.OverspendDebtFils)
	}
	if s.OverspendDebtFils != 30000 {
		t.Errorf("summary debt = %d, want 30000", s.OverspendDebtFils)
	}
	wantRTA := int64(1000000 - (10000 + 5000) - 30000)
	if s.ReadyToAssignFils != wantRTA {
		t.Errorf("RTA = %d, want %d (income − assigned − overspend debt)", s.ReadyToAssignFils, wantRTA)
	}
}

// A malformed row (negative carry or debt from a future store bug) must clamp
// to zero, never mint negative envelope money or a negative RTA charge.
func TestComputeEnvelopesClampsBadRows(t *testing.T) {
	rows := []store.EnvelopeMonthRow{rowDebt(1, "x", "need", 1000, 0, -5000, -7000)}
	s := mustCompute(t, "2026-07", 100000, rows, nil)
	e := envByID(t, s, 1)
	if e.CarryoverFils != 0 || e.OverspendDebtFils != 0 {
		t.Errorf("carry/debt = %d/%d, want 0/0 (clamped)", e.CarryoverFils, e.OverspendDebtFils)
	}
	if s.ReadyToAssignFils != 99000 {
		t.Errorf("RTA = %d, want 99000", s.ReadyToAssignFils)
	}
}

func TestComputeEnvelopesBadMonth(t *testing.T) {
	for _, bad := range []string{"", "2026", "2026-7", "July", "2026-07-01"} {
		if _, err := ComputeEnvelopes(bad, 0, nil, nil); err == nil {
			t.Errorf("ComputeEnvelopes(%q) accepted, want error", bad)
		}
	}
}

func TestNeededSetAside(t *testing.T) {
	tests := []struct {
		name       string
		month      string
		cadence    string
		amount     int64
		assigned   int64
		wantNeeded int64
		wantStill  int64
	}{
		{"monthly exact", "2026-06", "monthly", 50000, 0, 50000, 50000},
		{"monthly partially assigned", "2026-06", "monthly", 50000, 20000, 50000, 30000},
		{"monthly overfunded clamps still", "2026-06", "monthly", 50000, 60000, 50000, 0},
		{"yearly mid-year floor", "2026-06", "yearly", 120005, 0, 10000, 10000},   // 120005/12 = 10000
		{"yearly december absorbs", "2026-12", "yearly", 120005, 0, 10005, 10005}, // 120005 − 11×10000
		{"weekly mid-year", "2026-06", "weekly", 10000, 0, 43333, 43333},          // 520000/12
		{"weekly december absorbs", "2026-12", "weekly", 10000, 0, 43337, 43337},  // 520000 − 11×43333
		{"empty cadence treated monthly", "2026-06", "", 50000, 0, 50000, 50000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rows := []store.EnvelopeMonthRow{row(1, "c", "need", tc.assigned, 0, 0)}
			targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "set_aside", AmountFils: tc.amount, Cadence: tc.cadence}}
			s := mustCompute(t, tc.month, 0, rows, targets)
			tg := envByID(t, s, 1).Target
			if tg == nil {
				t.Fatal("target status missing")
			}
			if tg.NeededFils != tc.wantNeeded || tg.StillNeededFils != tc.wantStill {
				t.Errorf("needed/still = %d/%d, want %d/%d", tg.NeededFils, tg.StillNeededFils, tc.wantNeeded, tc.wantStill)
			}
			if tg.Funded != (tc.wantStill == 0) {
				t.Errorf("funded = %v, want %v", tg.Funded, tc.wantStill == 0)
			}
		})
	}
}

// Last-month remainder policy: twelve monthlyEquivalent slices always sum to
// the cadence's yearly total, December carrying the division remainder.
func TestMonthlyEquivalentYearConservation(t *testing.T) {
	for _, tc := range []struct {
		cadence string
		amount  int64
		yearly  int64
	}{
		{"weekly", 9999, 9999 * 52},
		{"monthly", 12345, 12345 * 12},
		{"yearly", 100001, 100001},
	} {
		var sum int64
		for m := 1; m <= 12; m++ {
			sum += monthlyEquivalent(tc.amount, tc.cadence, m)
		}
		if sum != tc.yearly {
			t.Errorf("%s %d: year sum = %d, want %d", tc.cadence, tc.amount, sum, tc.yearly)
		}
	}
}

func TestNeededRefill(t *testing.T) {
	tests := []struct {
		name       string
		amount     int64
		carryRaw   int64
		assigned   int64
		activity   int64
		wantNeeded int64
		wantStill  int64
	}{
		{"empty envelope asks full", 100000, 0, 0, 0, 100000, 100000},
		{"carryover reduces ask", 100000, 30000, 0, 0, 70000, 70000},
		{"already full asks nothing", 100000, 120000, 0, 0, 0, 0},
		{"spending raises the ask", 100000, 30000, 0, 25000, 95000, 95000},
		// StillNeeded == amount − available (the spec formula):
		// avail = 30000 + 50000 − 25000 = 55000 → still = 45000.
		{"assignment counts toward it", 100000, 30000, 50000, 25000, 95000, 45000},
		{"negative raw carry clamped before ask", 100000, -40000, 0, 0, 100000, 100000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rows := []store.EnvelopeMonthRow{row(1, "c", "need", tc.assigned, tc.activity, tc.carryRaw)}
			targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "refill", AmountFils: tc.amount}}
			s := mustCompute(t, "2026-07", 0, rows, targets)
			tg := envByID(t, s, 1).Target
			if tg.NeededFils != tc.wantNeeded || tg.StillNeededFils != tc.wantStill {
				t.Errorf("needed/still = %d/%d, want %d/%d", tg.NeededFils, tg.StillNeededFils, tc.wantNeeded, tc.wantStill)
			}
			// The spec identity: whenever the ask is live, still = max(0, amount − available).
			if tg.NeededFils > 0 {
				e := envByID(t, s, 1)
				if want := clamp0(tc.amount - e.AvailableFils); tg.StillNeededFils != want {
					t.Errorf("still = %d, want amount−available = %d", tg.StillNeededFils, want)
				}
			}
		})
	}
}

func TestNeededSaveByDate(t *testing.T) {
	tests := []struct {
		name           string
		month          string
		due            string
		amount         int64
		carryRaw       int64
		assigned       int64
		activity       int64
		wantMonthsLeft int64
		wantNeeded     int64
		wantStill      int64
	}{
		{"even split", "2026-07", "2026-12-31", 600000, 0, 0, 0, 6, 100000, 100000},
		{"floor division early month", "2026-07", "2026-09-15", 100000, 0, 0, 0, 3, 33333, 33333},
		{"due this month asks full remainder", "2026-07", "2026-07-20", 100000, 40000, 0, 0, 1, 60000, 60000},
		{"due in the past clamps to now", "2026-07", "2026-03-01", 100000, 0, 0, 0, 1, 100000, 100000},
		{"unparseable due date treated as due", "2026-07", "not-a-date", 100000, 0, 0, 0, 1, 100000, 100000},
		{"cross-year months", "2026-11", "2027-02-10", 400000, 0, 0, 0, 4, 100000, 100000},
		{"already saved asks nothing", "2026-07", "2026-12-31", 600000, 700000, 0, 0, 6, 0, 0},
		{"spending re-opens the goal", "2026-07", "2026-08-31", 100000, 100000, 0, 30000, 2, 15000, 15000},
		{"assigned pace zeroes still", "2026-07", "2026-09-30", 90000, 0, 30000, 0, 3, 30000, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rows := []store.EnvelopeMonthRow{row(1, "c", "saving", tc.assigned, tc.activity, tc.carryRaw)}
			targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "save_by_date", AmountFils: tc.amount, DueDate: tc.due}}
			s := mustCompute(t, tc.month, 0, rows, targets)
			tg := envByID(t, s, 1).Target
			if tg.MonthsLeft != tc.wantMonthsLeft {
				t.Errorf("monthsLeft = %d, want %d", tg.MonthsLeft, tc.wantMonthsLeft)
			}
			if tg.NeededFils != tc.wantNeeded || tg.StillNeededFils != tc.wantStill {
				t.Errorf("needed/still = %d/%d, want %d/%d", tg.NeededFils, tg.StillNeededFils, tc.wantNeeded, tc.wantStill)
			}
		})
	}
}

// The floor-division remainder rides forward month over month and the final
// month absorbs it exactly: assigning "needed" every month lands precisely on
// the goal by the due month (last-month absorption, nothing lost).
func TestSaveByDateRemainderAbsorbedByFinalMonth(t *testing.T) {
	const amount = 100000 // over 3 months: 33333, 33333, 33334
	months := []string{"2026-07", "2026-08", "2026-09"}
	due := "2026-09-30"
	var carry int64 // Σ prior assigned (no activity)
	var neededSeq []int64
	for _, m := range months {
		rows := []store.EnvelopeMonthRow{row(1, "c", "saving", 0, 0, carry)}
		targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "save_by_date", AmountFils: amount, DueDate: due}}
		s := mustCompute(t, m, 0, rows, targets)
		needed := envByID(t, s, 1).Target.NeededFils
		neededSeq = append(neededSeq, needed)
		carry += needed // user assigns exactly the ask; it carries into next month
	}
	if neededSeq[0] != 33333 || neededSeq[1] != 33333 || neededSeq[2] != 33334 {
		t.Errorf("needed sequence = %v, want [33333 33333 33334]", neededSeq)
	}
	if carry != amount {
		t.Errorf("total assigned = %d, want %d (exact landing)", carry, amount)
	}
}

// A target created mid-month evaluates against the month as it already stands:
// recorded activity and an empty assignment feed straight into the ask.
func TestTargetCreatedMidMonth(t *testing.T) {
	// Refill 1000 created after 400 of spending, nothing assigned yet.
	rows := []store.EnvelopeMonthRow{row(1, "dining", "want", 0, 40000, 0)}
	targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "refill", AmountFils: 100000}}
	s := mustCompute(t, "2026-07", 0, rows, targets)
	e := envByID(t, s, 1)
	if !e.Overspent || e.AvailableFils != -40000 {
		t.Fatalf("avail/overspent = %d/%v, want -40000/true", e.AvailableFils, e.Overspent)
	}
	if e.Target.NeededFils != 140000 || e.Target.StillNeededFils != 140000 {
		t.Errorf("refill needed/still = %d/%d, want 140000/140000 (covers the hole and tops up)",
			e.Target.NeededFils, e.Target.StillNeededFils)
	}

	// set_aside ignores activity: flat cadence ask regardless of mid-month state.
	targets[0] = store.CategoryTargetRow{CategoryID: 1, TargetType: "set_aside", AmountFils: 100000, Cadence: "monthly"}
	s = mustCompute(t, "2026-07", 0, rows, targets)
	if tg := envByID(t, s, 1).Target; tg.NeededFils != 100000 || tg.StillNeededFils != 100000 {
		t.Errorf("set_aside needed/still = %d/%d, want 100000/100000", tg.NeededFils, tg.StillNeededFils)
	}
}

func TestTargetForUnknownCategoryIgnored(t *testing.T) {
	rows := []store.EnvelopeMonthRow{row(1, "c", "need", 0, 0, 0)}
	targets := []store.CategoryTargetRow{{CategoryID: 99, TargetType: "refill", AmountFils: 100000}}
	s := mustCompute(t, "2026-07", 0, rows, targets)
	if envByID(t, s, 1).Target != nil {
		t.Error("target attached to wrong category")
	}
	if len(s.Envelopes) != 1 {
		t.Errorf("envelope count = %d, want 1", len(s.Envelopes))
	}
}

func cfg502030() store.BudgetConfig {
	return store.BudgetConfig{NeedPct: 0.50, WantPct: 0.30, SavingPct: 0.20}
}

func allocMap(allocs []Allocation) map[int64]int64 {
	m := make(map[int64]int64, len(allocs))
	for _, a := range allocs {
		m[a.CategoryID] = a.AmountFils
	}
	return m
}

func allocTotal(allocs []Allocation) int64 {
	var t int64
	for _, a := range allocs {
		t += a.AmountFils
	}
	return t
}

func TestAutoAssignTargetsFirstThenProRata(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		row(1, "rent", "need", 0, 0, 0),      // target: refill 300
		row(2, "groceries", "need", 0, 0, 0), // no target
		row(3, "dining", "want", 0, 0, 0),    // no target
		row(4, "savings", "saving", 0, 0, 0), // no target
	}
	targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "refill", AmountFils: 30000}}
	s := mustCompute(t, "2026-07", 130000, rows, targets)
	allocs := AutoAssign(s, cfg502030())

	m := allocMap(allocs)
	if m[1] != 30000 {
		t.Errorf("target category got %d, want 30000 (funded first)", m[1])
	}
	// Leftover 100000 → need 50000 (groceries), want 30000 (dining), saving 20000.
	if m[2] != 50000 || m[3] != 30000 || m[4] != 20000 {
		t.Errorf("pro-rata seed = %d/%d/%d, want 50000/30000/20000", m[2], m[3], m[4])
	}
	if total := allocTotal(allocs); total != s.ReadyToAssignFils {
		t.Errorf("Σ allocations = %d, want RTA %d (conservation)", total, s.ReadyToAssignFils)
	}
	// Row order in the plan.
	for i, want := range []int64{1, 2, 3, 4} {
		if allocs[i].CategoryID != want {
			t.Fatalf("alloc order = %v", allocs)
		}
	}
}

func TestAutoAssignInsufficientPoolFundsFirstRowsFirst(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		row(1, "a", "need", 0, 0, 0),
		row(2, "b", "want", 0, 0, 0),
	}
	targets := []store.CategoryTargetRow{
		{CategoryID: 1, TargetType: "refill", AmountFils: 30000},
		{CategoryID: 2, TargetType: "refill", AmountFils: 20000},
	}
	s := mustCompute(t, "2026-07", 35000, rows, targets)
	m := allocMap(AutoAssign(s, cfg502030()))
	if m[1] != 30000 || m[2] != 5000 {
		t.Errorf("allocations = %v, want 30000 to first row, 5000 partial to second", m)
	}
}

func TestAutoAssignWithinBucketRemainderToFirstCategory(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		row(1, "a", "need", 0, 0, 0),
		row(2, "b", "need", 0, 0, 0),
		row(3, "c", "need", 0, 0, 0),
	}
	// pool 100000, need share = 100000 (pct 1.0) → per 33333, remainder 1 → first.
	s := mustCompute(t, "2026-07", 100000, rows, nil)
	m := allocMap(AutoAssign(s, store.BudgetConfig{NeedPct: 1.0}))
	if m[1] != 33334 || m[2] != 33333 || m[3] != 33333 {
		t.Errorf("allocations = %v, want first category absorbing the remainder (33334/33333/33333)", m)
	}
}

func TestAutoAssignLeftoverAbsorbedByFirstSeeded(t *testing.T) {
	// The saving bucket's whole share has nowhere to go (its only envelope is
	// targeted-and-funded) and float truncation drops fils; everything lands on
	// the first seeded envelope so Σ == RTA.
	rows := []store.EnvelopeMonthRow{
		row(1, "savings", "saving", 20000, 0, 0), // funded refill target
		row(2, "groceries", "need", 0, 0, 0),
		row(3, "dining", "want", 0, 0, 0),
	}
	targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "refill", AmountFils: 20000}}
	s := mustCompute(t, "2026-07", 120001, rows, targets) // RTA = 100001
	allocs := AutoAssign(s, cfg502030())
	m := allocMap(allocs)
	if m[1] != 0 {
		t.Errorf("funded target got %d, want nothing", m[1])
	}
	// need share 50000, want share 30000, saving share 20000 undistributable,
	// float leftover 1 → groceries (first seeded) gets 50000+20000+1... but the
	// saving share is computed as int64(100001×0.2)=20000, need=50000, want=30000
	// → distributed 80000 for seeded buckets minus skipped saving = 80000;
	// leftover = 100001 − 80000 = 20001 → groceries.
	if m[2] != 70001 || m[3] != 30000 {
		t.Errorf("allocations = %v, want groceries 70001 / dining 30000", m)
	}
	if total := allocTotal(allocs); total != s.ReadyToAssignFils {
		t.Errorf("Σ allocations = %d, want RTA %d", total, s.ReadyToAssignFils)
	}
}

func TestAutoAssignFullyTargetedBudgetLeavesSurplusInRTA(t *testing.T) {
	rows := []store.EnvelopeMonthRow{row(1, "rent", "need", 0, 0, 0)}
	targets := []store.CategoryTargetRow{{CategoryID: 1, TargetType: "refill", AmountFils: 30000}}
	s := mustCompute(t, "2026-07", 100000, rows, targets)
	allocs := AutoAssign(s, cfg502030())
	if total := allocTotal(allocs); total != 30000 {
		t.Errorf("Σ allocations = %d, want 30000 (surplus stays in RTA)", total)
	}
}

func TestAutoAssignNoPool(t *testing.T) {
	rows := []store.EnvelopeMonthRow{row(1, "a", "need", 0, 0, 0)}
	for _, income := range []int64{0, -5000} {
		s := mustCompute(t, "2026-07", income, rows, nil)
		if allocs := AutoAssign(s, cfg502030()); allocs != nil {
			t.Errorf("income %d: allocations = %v, want nil (RTA ≤ 0)", income, allocs)
		}
	}
	// Negative RTA from over-assignment, too.
	s := mustCompute(t, "2026-07", 10000, []store.EnvelopeMonthRow{row(1, "a", "need", 20000, 0, 0)}, nil)
	if allocs := AutoAssign(s, cfg502030()); allocs != nil {
		t.Errorf("over-assigned month: allocations = %v, want nil", allocs)
	}
	// No envelopes at all.
	s = mustCompute(t, "2026-07", 10000, nil, nil)
	if allocs := AutoAssign(s, cfg502030()); allocs != nil {
		t.Errorf("no envelopes: allocations = %v, want nil", allocs)
	}
}

func TestAutoAssignSkipsBucketlessEnvelopes(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		row(1, "misc", "", 0, 0, 0), // no bucket → never seeded
		row(2, "groceries", "need", 0, 0, 0),
	}
	s := mustCompute(t, "2026-07", 100000, rows, nil)
	m := allocMap(AutoAssign(s, cfg502030()))
	if m[1] != 0 {
		t.Errorf("bucketless envelope got %d, want 0", m[1])
	}
	if m[2] != 100000 { // need share 50000 + leftover (want/saving shares undistributable) 50000
		t.Errorf("groceries got %d, want 100000", m[2])
	}
}

// Overspend debt shrinks the pool AutoAssign distributes.
func TestAutoAssignPoolNetOfOverspendDebt(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		rowDebt(1, "dining", "want", 0, 0, 0, 30000),
		row(2, "groceries", "need", 0, 0, 0),
	}
	s := mustCompute(t, "2026-07", 100000, rows, nil)
	if s.ReadyToAssignFils != 70000 {
		t.Fatalf("RTA = %d, want 70000", s.ReadyToAssignFils)
	}
	if total := allocTotal(AutoAssign(s, cfg502030())); total != 70000 {
		t.Errorf("Σ allocations = %d, want 70000 (debt-reduced pool)", total)
	}
}

// TestAutoAssignNeverOvershootsRTA: bucket pcts that pass the budget PUT's
// |Σ−1| ≤ 0.001 validation but sum slightly ABOVE 1 must never make the plan
// assign more than the pool — shares are integer pro-rata (floor division),
// never float money math.
func TestAutoAssignNeverOvershootsRTA(t *testing.T) {
	rows := []store.EnvelopeMonthRow{
		row(1, "a", "need", 0, 0, 0),
		row(2, "b", "want", 0, 0, 0),
		row(3, "c", "saving", 0, 0, 0),
	}
	over := store.BudgetConfig{NeedPct: 0.5005, WantPct: 0.30, SavingPct: 0.20} // Σ = 1.0005
	for _, income := range []int64{1_000_000, 999_999, 3, 100_001} {
		s := mustCompute(t, "2026-07", income, rows, nil)
		total := allocTotal(AutoAssign(s, over))
		if total != s.ReadyToAssignFils {
			t.Errorf("income %d: Σ allocations = %d, want exactly RTA %d (overshoot drives RTA negative)",
				income, total, s.ReadyToAssignFils)
		}
	}
	// All-zero weights: nothing distributable pro-rata, leftover still lands
	// on the first seeded envelope so conservation holds.
	s := mustCompute(t, "2026-07", 50_000, rows, nil)
	if total := allocTotal(AutoAssign(s, store.BudgetConfig{})); total != 50_000 {
		t.Errorf("zero-weight config: Σ allocations = %d, want 50000", total)
	}
}
