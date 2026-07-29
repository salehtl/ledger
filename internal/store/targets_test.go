package store

import (
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
				CategoryID: catID, TargetType: typ, AmountFils: 10_000, DueDate: "2026-12-01",
			}); err != nil {
				t.Fatal(err)
			}
			got, ok, err := st.SelectCategoryTarget(catID)
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
	if _, ok, err := st.SelectCategoryTarget(catID); err != nil || ok {
		t.Fatalf("expected no target, ok=%v err=%v", ok, err)
	}
	// Insert; cadence defaults to monthly.
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: catID, TargetType: "set_aside", AmountFils: 150_000,
	}); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.SelectCategoryTarget(catID)
	if err != nil || !ok {
		t.Fatalf("select: ok=%v err=%v", ok, err)
	}
	if got.TargetType != "set_aside" || got.AmountFils != 150_000 || got.Cadence != "monthly" || got.DueDate != "" {
		t.Fatalf("got %+v", got)
	}
	// Upsert overwrites in place (still one target per category).
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: catID, TargetType: "save_by_date", AmountFils: 900_000,
		Cadence: "yearly", DueDate: "2026-12-01",
	}); err != nil {
		t.Fatal(err)
	}
	all, err := st.SelectCategoryTargets()
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
	if err := st.DeleteCategoryTarget(catID); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteCategoryTarget(catID); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.SelectCategoryTarget(catID); ok {
		t.Fatal("target should be deleted")
	}
}

func TestCategoryTargetCascadesWithCategory(t *testing.T) {
	st := newTestStore(t)
	catID := insertCategory(t, st, "TargetsCascade", "spending", "need")
	if err := st.UpsertCategoryTarget(CategoryTargetRow{
		CategoryID: catID, TargetType: "refill", AmountFils: 40_000,
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteCategory(catID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.SelectCategoryTarget(catID); err != nil || ok {
		t.Fatalf("target should cascade away with its category, ok=%v err=%v", ok, err)
	}
}
