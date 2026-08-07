package store

import (
	"errors"
	"testing"
	"time"
)

// thisMonth is the current calendar month; seeding refuses to touch anything
// earlier, so tests that must succeed have to use it or later.
func thisMonth() string { return time.Now().UTC().Format("2006-01") }

func monthsFromNow(n int) string {
	return time.Now().UTC().AddDate(0, n, 0).Format("2006-01")
}

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

// Negative assignments are legal (move-money over-draws a source envelope) and
// are part of the plan, so they carry too.
func TestSeedAssignments_CarriesNegativeAssignments(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Healthcare")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	if _, err := st.AddToEnvelopeAssignment(prev, a, -400000); err != nil {
		t.Fatal(err)
	}

	if _, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next); err != nil {
		t.Fatal(err)
	}
	if got := assignedIn(t, st, next); got[a] != -250000 {
		t.Errorf("assignment = %d, want -250000 carried", got[a])
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
