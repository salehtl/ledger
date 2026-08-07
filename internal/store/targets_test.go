package store

import (
	"database/sql"
	"errors"
	"testing"
)

func TestUpsertCategoryTargetValidation(t *testing.T) {
	st := newTestStore(t)
	catID := insertCategory(t, st, "TargetsCat", "spending", "need")

	cases := []struct {
		name string
		row  CategoryTargetRow
	}{
		{"missing category", CategoryTargetRow{TargetType: "set_aside", AmountFils: 100}},
		{"bad type", CategoryTargetRow{CategoryID: catID, TargetType: "weird", AmountFils: 100}},
		{"zero amount", CategoryTargetRow{CategoryID: catID, TargetType: "set_aside", AmountFils: 0}},
		{"negative amount", CategoryTargetRow{CategoryID: catID, TargetType: "refill", AmountFils: -5}},
		{"bad cadence", CategoryTargetRow{CategoryID: catID, TargetType: "set_aside", AmountFils: 100, Cadence: "daily"}},
		{"save_by_date without due", CategoryTargetRow{CategoryID: catID, TargetType: "save_by_date", AmountFils: 100}},
		// Malformed dates must 400, not degrade: the engine clamps an
		// unparseable due date to "due now", which would inflate needed_fils
		// and let auto-assign drain RTA into the envelope.
		{"save_by_date garbage due", CategoryTargetRow{CategoryID: catID, TargetType: "save_by_date", AmountFils: 100, DueDate: "banana"}},
		{"save_by_date wrong format", CategoryTargetRow{CategoryID: catID, TargetType: "save_by_date", AmountFils: 100, DueDate: "01/12/2026"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := st.UpsertCategoryTarget(tc.row); !errors.Is(err, ErrTargetInvalid) {
				t.Fatalf("want ErrTargetInvalid, got %v", err)
			}
		})
	}
}

// TestTargetDueDateClearedForNonSaveByDate: due_date exists iff save_by_date
// (contract §1) — a stray value on the other types is dropped, never stored
// or echoed.
func TestTargetDueDateClearedForNonSaveByDate(t *testing.T) {
	st := newTestStore(t)
	for _, typ := range []string{"set_aside", "refill"} {
		t.Run(typ, func(t *testing.T) {
			catID := insertCategory(t, st, "DueClear-"+typ, "spending", "need")
			if err := st.UpsertCategoryTarget(CategoryTargetRow{
				CategoryID: catID, EffectiveMonth: "2026-01", TargetType: typ, AmountFils: 10_000, DueDate: "2026-12-01",
			}); err != nil {
				t.Fatal(err)
			}
			got, ok, err := st.SelectCategoryTargetForMonth(catID, "2026-01")
			if err != nil || !ok {
				t.Fatalf("select: ok=%v err=%v", ok, err)
			}
			if got.DueDate != "" {
				t.Fatalf("due_date=%q, want cleared for %s", got.DueDate, typ)
			}
		})
	}
}

func TestCategoryTargetCRUD(t *testing.T) {
	st := newTestStore(t)
	st.SetNow(func() int64 { return 1_000_000 })
	catID := insertCategory(t, st, "TargetsCRUD", "spending", "want")

	// No target yet.
	if _, ok, err := st.SelectCategoryTargetForMonth(catID, "2026-01"); err != nil || ok {
		t.Fatalf("expected no target, ok=%v err=%v", ok, err)
	}
	// Insert; cadence defaults to monthly.
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: catID, EffectiveMonth: "2026-01", TargetType: "set_aside", AmountFils: 150_000,
	}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.SelectCategoryTargetForMonth(catID, "2026-01")
	if err != nil || !ok {
		t.Fatalf("select: ok=%v err=%v", ok, err)
	}
	if got.TargetType != "set_aside" || got.AmountFils != 150_000 || got.Cadence != "monthly" || got.DueDate != "" {
		t.Fatalf("got %+v", got)
	}
	// Upsert overwrites in place (still one version at that month).
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: catID, EffectiveMonth: "2026-01", TargetType: "save_by_date", AmountFils: 900_000,
		Cadence: "yearly", DueDate: "2026-12-01",
	}); err != nil {
		t.Fatal(err)
	}
	all, err := st.SelectCategoryTargetsForMonth("2026-01")
	if err != nil {
		t.Fatal(err)
	}
	var mine []CategoryTargetRow
	for _, r := range all {
		if r.CategoryID == catID {
			mine = append(mine, r)
		}
	}
	if len(mine) != 1 || mine[0].TargetType != "save_by_date" || mine[0].DueDate != "2026-12-01" {
		t.Fatalf("mine=%+v", mine)
	}
	// Delete is idempotent.
	if err := st.DeleteCategoryTarget(catID, "2026-01"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteCategoryTarget(catID, "2026-01"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.SelectCategoryTargetForMonth(catID, "2026-01"); ok {
		t.Fatal("target should be deleted")
	}
}

func TestCategoryTargetCascadesWithCategory(t *testing.T) {
	st := newTestStore(t)
	catID := insertCategory(t, st, "TargetsCascade", "spending", "need")
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: catID, EffectiveMonth: "2026-01", TargetType: "refill", AmountFils: 40_000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteCategory(catID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.SelectCategoryTargetForMonth(catID, "2026-01"); err != nil || ok {
		t.Fatalf("target should cascade away with its category, ok=%v err=%v", ok, err)
	}
}

// seedCat inserts a category and returns its id. newTestStore's Open() already
// seeds the default 50/30/20 set (which includes "Groceries", "Dining",
// "Travel" — the names these tests use), so a plain INSERT would 409 on the
// UNIQUE(name) constraint; reuse the existing row instead of erroring.
func seedCat(t *testing.T, st *Store, name string) int64 {
	t.Helper()
	var id int64
	err := st.DB.QueryRow(`SELECT id FROM categories WHERE name = ?`, name).Scan(&id)
	if err == nil {
		return id
	}
	if !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	res, err := st.DB.Exec(`INSERT INTO categories (name, kind, bucket) VALUES (?, 'spending', 'need')`, name)
	if err != nil {
		t.Fatal(err)
	}
	id, err = res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func putTarget(t *testing.T, st *Store, cat int64, month string, amount int64) {
	t.Helper()
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: cat, EffectiveMonth: month, TargetType: "set_aside",
		AmountFils: amount, Cadence: "monthly",
	}); err != nil {
		t.Fatalf("upsert %s: %v", month, err)
	}
}

func resolved(t *testing.T, st *Store, cat int64, month string) (int64, bool) {
	t.Helper()
	row, ok, err := st.SelectCategoryTargetForMonth(cat, month)
	if err != nil {
		t.Fatal(err)
	}
	return row.AmountFils, ok
}

// The whole point of the feature: a target set once keeps applying to later
// months without being restated.
func TestTargetForMonth_CarriesForwardImplicitly(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-03", 150000)

	for _, m := range []string{"2026-03", "2026-04", "2026-09", "2027-01"} {
		amount, ok := resolved(t, st, cat, m)
		if !ok || amount != 150000 {
			t.Errorf("%s: got (%d, %v), want (150000, true)", m, amount, ok)
		}
	}
}

// Months before the first version have no target at all.
func TestTargetForMonth_NotRetroactiveBeforeFirstVersion(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-03", 150000)

	if _, ok := resolved(t, st, cat, "2026-02"); ok {
		t.Error("2026-02 resolved a target set from 2026-03")
	}
}

// The property the feature exists for: editing in August must not touch July.
func TestTargetForMonth_EditIsScopedForward(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-07", 150000)
	putTarget(t, st, cat, "2026-08", 200000)

	for _, tc := range []struct {
		month string
		want  int64
	}{
		{"2026-07", 150000}, // frozen
		{"2026-08", 200000},
		{"2026-12", 200000}, // carries forward from the edit
	} {
		amount, ok := resolved(t, st, cat, tc.month)
		if !ok || amount != tc.want {
			t.Errorf("%s: got (%d, %v), want (%d, true)", tc.month, amount, ok, tc.want)
		}
	}
}

// Re-editing the same month overwrites that version rather than stacking.
func TestTargetForMonth_SameMonthOverwrites(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-08", 200000)
	putTarget(t, st, cat, "2026-08", 250000)

	amount, ok := resolved(t, st, cat, "2026-08")
	if !ok || amount != 250000 {
		t.Errorf("got (%d, %v), want (250000, true)", amount, ok)
	}
	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM category_targets WHERE category_id=? AND effective_month='2026-08'`, cat).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("versions at 2026-08 = %d, want 1", n)
	}
}

// Removal must not let the previous version resurrect — that is what a plain
// DELETE would do, and it is the opposite of "remove".
func TestDeleteCategoryTarget_TombstonesForwardOnly(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-07", 150000)

	if err := st.DeleteCategoryTarget(cat, "2026-08"); err != nil {
		t.Fatal(err)
	}
	if amount, ok := resolved(t, st, cat, "2026-07"); !ok || amount != 150000 {
		t.Errorf("July: got (%d, %v), want (150000, true) — removal reached backwards", amount, ok)
	}
	if _, ok := resolved(t, st, cat, "2026-08"); ok {
		t.Error("August still resolves a target after removal")
	}
	if _, ok := resolved(t, st, cat, "2026-11"); ok {
		t.Error("November resolves a target: the tombstone did not carry forward")
	}
}

// Setting a target again after a removal wins from its own month.
func TestTargetForMonth_ReAddAfterTombstone(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	putTarget(t, st, cat, "2026-07", 150000)
	if err := st.DeleteCategoryTarget(cat, "2026-08"); err != nil {
		t.Fatal(err)
	}
	putTarget(t, st, cat, "2026-10", 300000)

	if _, ok := resolved(t, st, cat, "2026-09"); ok {
		t.Error("September should still be tombstoned")
	}
	if amount, ok := resolved(t, st, cat, "2026-10"); !ok || amount != 300000 {
		t.Errorf("October: got (%d, %v), want (300000, true)", amount, ok)
	}
}

func TestSelectCategoryTargetsForMonth_ExcludesTombstonesAndFuture(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Dining")
	c := seedCat(t, st, "Travel")
	putTarget(t, st, a, "2026-07", 150000)
	putTarget(t, st, b, "2026-07", 500000)
	if err := st.DeleteCategoryTarget(b, "2026-08"); err != nil {
		t.Fatal(err)
	}
	putTarget(t, st, c, "2026-09", 900000) // starts after the queried month

	rows, err := st.SelectCategoryTargetsForMonth("2026-08")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (Groceries only); rows=%+v", len(rows), rows)
	}
	if rows[0].CategoryID != a || rows[0].AmountFils != 150000 {
		t.Errorf("row = %+v, want Groceries at 150000", rows[0])
	}
	for _, r := range rows {
		if r.TargetType == "none" {
			t.Error("a tombstone leaked into the resolved list")
		}
	}
}

func TestUpsertCategoryTarget_RejectsBadMonth(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	for _, m := range []string{"", "2026", "2026-13", "26-08", "2026-08-01"} {
		err := st.UpsertCategoryTarget(CategoryTargetRow{
			CategoryID: cat, EffectiveMonth: m, TargetType: "set_aside",
			AmountFils: 1000, Cadence: "monthly",
		})
		if !errors.Is(err, ErrTargetInvalid) {
			t.Errorf("month %q: err = %v, want ErrTargetInvalid", m, err)
		}
	}
}

// 'none' is internal. A caller must not be able to plant a tombstone through
// the normal write path and dodge amount validation.
func TestUpsertCategoryTarget_RejectsTombstoneType(t *testing.T) {
	st := newTestStore(t)
	cat := seedCat(t, st, "Groceries")
	err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: cat, EffectiveMonth: "2026-08", TargetType: "none", AmountFils: 0,
	})
	if !errors.Is(err, ErrTargetInvalid) {
		t.Errorf("err = %v, want ErrTargetInvalid", err)
	}
}
