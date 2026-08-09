package store

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// thisMonth is the current calendar month; seeding refuses to touch anything
// earlier, so tests that must succeed have to use it or later.
func thisMonth() string { return time.Now().UTC().Format("2006-01") }

// monthsFromNow offsets the current calendar month by n, normalising year and
// month arithmetic directly. It deliberately does NOT use time.AddDate, which
// normalises DAY overflow (Jan 31 + 1 month → Mar 3) and would therefore skip a
// month whenever the suite runs on the 29th–31st — silently moving the horizon
// boundary these tests pin down.
func monthsFromNow(n int) string {
	now := time.Now().UTC()
	y, m := now.Year(), int(now.Month())+n
	y, m = y+floorDiv(m-1, 12), floorMod(m-1, 12)+1
	return fmt.Sprintf("%04d-%02d", y, m)
}

// Go's / and % truncate toward zero, which is wrong for negative offsets.
func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func floorMod(a, b int) int { return a - floorDiv(a, b)*b }

func assign(t *testing.T, st *Store, month string, categoryID, fils int64) {
	t.Helper()
	if err := st.UpsertEnvelopeAssignment(month, categoryID, fils); err != nil {
		t.Fatalf("assign %s cat=%d: %v", month, categoryID, err)
	}
}

func assignedIn(t *testing.T, st *Store, month string) map[int64]int64 {
	t.Helper()
	rows, err := st.SelectEnvelopeAssignments(month)
	if err != nil {
		t.Fatal(err)
	}
	out := map[int64]int64{}
	for _, r := range rows {
		out[r.CategoryID] = r.AssignedFils
	}
	return out
}

func rowCount(t *testing.T, st *Store, month string) int {
	t.Helper()
	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, month).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The feature: an untouched month inherits the previous month's plan.
func TestSeedAssignments_CarriesPreviousMonthForward(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Transport")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, prev, b, 50000)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("seeded %d rows, want 2", n)
	}
	got := assignedIn(t, st, next)
	if got[a] != 150000 || got[b] != 50000 {
		t.Errorf("seeded assignments = %v, want {%d:150000, %d:50000}", got, a, b)
	}
}

// Zeroing a month writes rows. Those rows are the record that the user touched
// it, so it must stay empty rather than refilling itself.
func TestSeedAssignments_LeavesDeliberatelyZeroedMonthAlone(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, next, a, 0) // user zeroed it on purpose

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows into a touched month, want 0", n)
	}
	if got := assignedIn(t, st, next); got[a] != 0 {
		t.Errorf("assignment = %d, want 0 — seeding overwrote a deliberate zero", got[a])
	}
}

// A month with a real plan must never be overwritten.
func TestSeedAssignments_LeavesPlannedMonthAlone(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, next, a, 999)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows, want 0", n)
	}
	if got := assignedIn(t, st, next); got[a] != 999 {
		t.Errorf("assignment = %d, want 999 (untouched)", got[a])
	}
}

// Browsing history must never rewrite it.
func TestSeedAssignments_RefusesMonthsBeforeThisOne(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	assign(t, st, monthsFromNow(-2), a, 150000)
	past := monthsFromNow(-1)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(past)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows into a past month, want 0", n)
	}
	if rowCount(t, st, past) != 0 {
		t.Error("a past month gained assignment rows")
	}
}

// Gaps: jumping ahead inherits the most recent PLANNED month, not the empty
// one immediately before.
func TestSeedAssignments_SkipsEmptyMonths(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	assign(t, st, thisMonth(), a, 150000)
	far := monthsFromNow(3)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(far)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("seeded %d rows, want 1", n)
	}
	if got := assignedIn(t, st, far); got[a] != 150000 {
		t.Errorf("assignment = %d, want 150000 inherited across the gap", got[a])
	}
}

// An all-zero month is not a plan; it must not be propagated as one.
func TestSeedAssignments_IgnoresAllZeroSourceMonth(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	assign(t, st, thisMonth(), a, 0)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(monthsFromNow(1))
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows from an all-zero month, want 0", n)
	}
}

// Only non-zero assignments are worth copying.
func TestSeedAssignments_CopiesOnlyNonZero(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Transport")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, prev, b, 0)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("seeded %d rows, want 1", n)
	}
	got := assignedIn(t, st, next)
	if _, present := got[b]; present {
		t.Errorf("a zero assignment was copied: %v", got)
	}
}

// Negative assignments are legal (move-money over-draws a source envelope) but
// record a ONE-OFF correction, not a recurring plan element, so they must not
// carry forward. See the long note on SeedEnvelopeAssignmentsFromPreviousMonth.
func TestSeedAssignments_DoesNotCarryNegativeAssignments(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Healthcare")
	b := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	if _, err := st.AddToEnvelopeAssignment(prev, a, -400000); err != nil {
		t.Fatal(err)
	}
	assign(t, st, prev, b, 150000) // keeps prev eligible as a source

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("seeded %d rows, want 1 (the positive one only)", n)
	}
	got := assignedIn(t, st, next)
	if v, present := got[a]; present {
		t.Errorf("a negative assignment was carried forward: %d", v)
	}
	if got[b] != 150000 {
		t.Errorf("positive assignment = %d, want 150000", got[b])
	}
}

// A month whose only non-zero rows are NEGATIVE is not a plan, so it must not
// be selected as a seed source — picking it would copy nothing and leave the
// target looking untouched forever.
func TestSeedAssignments_IgnoresSourceMonthWithOnlyNegativeRows(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Healthcare")
	assign(t, st, thisMonth(), a, -250000)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(monthsFromNow(1))
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows from an all-negative month, want 0", n)
	}
}

// THE REGRESSION THAT MATTERS. Checking the copied number alone is not enough —
// the original test did exactly that and passed while the bug was live. What
// makes a carried negative a bug is what envelopeEraFold does with it: the
// running era balance is b += assigned − activity, and the RISE in the negative
// high-water mark is charged to the next month's Ready to Assign. Copy the
// negative forward and every seeded month is billed fresh "overspend debt" for
// spending that never happened.
//
// The category is given a positive buffer in an earlier month that exactly
// absorbs the one-off over-draw, so the era balance never goes negative on its
// own. Any debt observed here is therefore manufactured purely by seeding.
func TestSeedAssignments_SeededMonthsAreNeverChargedOverspendDebt(t *testing.T) {
	st := newTestStore(t)
	health := seedCat(t, st, "Healthcare")
	groceries := seedCat(t, st, "Groceries")

	// Era opens with a buffer, then a one-off over-draw cancels it exactly.
	assign(t, st, monthsFromNow(-1), health, 250000)
	assign(t, st, thisMonth(), health, -250000)
	assign(t, st, thisMonth(), groceries, 150000) // the real, positive plan

	// Walk forward the way the UI does: open three consecutive months, each
	// seeding from the one before.
	for i := 1; i <= 3; i++ {
		month := monthsFromNow(i)
		if _, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(month); err != nil {
			t.Fatalf("seed %s: %v", month, err)
		}
	}

	for i := 1; i <= 3; i++ {
		month := monthsFromNow(i)
		rows, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
		if err != nil {
			t.Fatalf("summary %s: %v", month, err)
		}
		for _, r := range rows {
			if r.OverspendDebtFils != 0 {
				t.Errorf("%s: %s charged %d fils of overspend debt with zero activity — "+
					"a negative assignment was carried forward and folded as fresh debt",
					month, r.CategoryName, r.OverspendDebtFils)
			}
			if r.CategoryID == health && r.AssignedFils != 0 {
				t.Errorf("%s: Healthcare assigned = %d, want 0 (the negative must not carry)",
					month, r.AssignedFils)
			}
		}
	}
}

// Seeding is bounded: the month picker has no upper bound, and every seeded
// month counts as "touched" forever, so a month far in the future must not be
// silently frozen with today's plan.
func TestSeedAssignments_RefusesMonthsBeyondTheHorizon(t *testing.T) {
	for _, tc := range []struct {
		name  string
		month string
		want  int
	}{
		{"just inside the horizon", monthsFromNow(seedHorizonMonths), 1},
		{"just beyond the horizon", monthsFromNow(seedHorizonMonths + 1), 0},
		{"absurdly far ahead", "9999-12", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newTestStore(t)
			a := seedCat(t, st, "Groceries")
			assign(t, st, thisMonth(), a, 150000)

			n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(tc.month)
			if err != nil {
				t.Fatal(err)
			}
			if n != tc.want {
				t.Errorf("seeded %d rows into %s, want %d", n, tc.month, tc.want)
			}
			if rowCount(t, st, tc.month) != tc.want {
				t.Errorf("%s has %d rows, want %d", tc.month, rowCount(t, st, tc.month), tc.want)
			}
		})
	}
}

// Called twice (two page loads), the second call must be a no-op.
func TestSeedAssignments_IsIdempotent(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)

	first, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil || first != 1 {
		t.Fatalf("first call: n=%d err=%v", first, err)
	}
	second, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if second != 0 {
		t.Errorf("second call seeded %d rows, want 0", second)
	}
	if rowCount(t, st, next) != 1 {
		t.Errorf("rows = %d after two calls, want 1", rowCount(t, st, next))
	}
}

func TestSeedAssignments_RejectsBadMonth(t *testing.T) {
	st := newTestStore(t)
	for _, m := range []string{"", "2026", "2026-13", "26-08"} {
		if _, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(m); !errors.Is(err, ErrEnvelopeInvalid) {
			t.Errorf("month %q: err = %v, want ErrEnvelopeInvalid", m, err)
		}
	}
}

// A category re-kinded away from 'spending' (or deactivated) after being
// assigned is no longer eligible: EnvelopeMonthSummary would never surface it,
// so seeding must not copy its row even though it is still non-zero in the
// source month.
func TestSeedAssignments_IgnoresRowsFromIneligibleCategory(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Transport")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, prev, b, 50000)
	if _, err := st.DB.Exec(`UPDATE categories SET kind='income' WHERE id=?`, b); err != nil {
		t.Fatal(err)
	}

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("seeded %d rows, want 1", n)
	}
	got := assignedIn(t, st, next)
	if got[a] != 150000 {
		t.Errorf("assignment[a] = %d, want 150000", got[a])
	}
	if _, present := got[b]; present {
		t.Errorf("an ineligible category's assignment was copied: %v", got)
	}
}

// If a month's ONLY non-zero row belongs to a now-ineligible category, that
// month must not be picked as the source at all — picking it and then copying
// nothing would silently leave the target month with zero rows, which looks
// identical to "never seeded" and would keep re-attempting forever. An
// earlier month with a valid plan must be chosen instead.
func TestSeedAssignments_SkipsSourceMonthWhoseOnlyNonZeroRowIsIneligible(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Transport")
	older, prev, next := monthsFromNow(-1), thisMonth(), monthsFromNow(1)
	assign(t, st, older, a, 150000)
	assign(t, st, prev, b, 50000)
	if _, err := st.DB.Exec(`UPDATE categories SET kind='income' WHERE id=?`, b); err != nil {
		t.Fatal(err)
	}

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("seeded %d rows, want 1 (inherited from the older eligible month)", n)
	}
	got := assignedIn(t, st, next)
	if got[a] != 150000 {
		t.Errorf("assignment[a] = %d, want 150000 carried from the older month", got[a])
	}
	if _, present := got[b]; present {
		t.Errorf("an ineligible category's assignment was copied: %v", got)
	}
}

func TestSeedAssignments_NoPriorPlanIsANoOp(t *testing.T) {
	st := newTestStore(t)
	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(monthsFromNow(1))
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows with no prior plan, want 0", n)
	}
}
