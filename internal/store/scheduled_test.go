package store

import (
	"errors"
	"testing"
	"time"
)

func validSchedule() ScheduledTxnRow {
	return ScheduledTxnRow{
		NormalizedMerchant: "netflix",
		Label:              "Netflix",
		AmountFils:         3_900,
		TolerancePct:       10,
		IntervalDays:       30,
		NextDue:            "2026-08-05",
	}
}

func TestInsertScheduledValidation(t *testing.T) {
	st := newTestStore(t)
	cases := []struct {
		name   string
		mutate func(*ScheduledTxnRow)
	}{
		{"empty merchant", func(r *ScheduledTxnRow) { r.NormalizedMerchant = "  " }},
		{"zero amount", func(r *ScheduledTxnRow) { r.AmountFils = 0 }},
		{"negative tolerance", func(r *ScheduledTxnRow) { r.TolerancePct = -1 }},
		{"tolerance over 100", func(r *ScheduledTxnRow) { r.TolerancePct = 101 }},
		{"zero interval", func(r *ScheduledTxnRow) { r.IntervalDays = 0 }},
		{"bad next_due", func(r *ScheduledTxnRow) { r.NextDue = "05/08/2026" }},
		{"bad direction", func(r *ScheduledTxnRow) { r.Direction = "sideways" }},
		{"bad source", func(r *ScheduledTxnRow) { r.Source = "psychic" }},
		{"bad status", func(r *ScheduledTxnRow) { r.Status = "zombie" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := validSchedule()
			tc.mutate(&r)
			if _, err := st.InsertScheduled(r); !errors.Is(err, ErrScheduleInvalid) {
				t.Fatalf("want ErrScheduleInvalid, got %v", err)
			}
		})
	}
}

func TestInsertScheduledDefaults(t *testing.T) {
	st := newTestStore(t)
	// Manual rows default to active; merchant is normalized.
	r := validSchedule()
	r.NormalizedMerchant = "  NetFlix  "
	id, err := st.InsertScheduled(r)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.SelectScheduledByID(id)
	if err != nil || !ok {
		t.Fatalf("select: ok=%v err=%v", ok, err)
	}
	if got.NormalizedMerchant != "netflix" || got.Source != "manual" || got.Status != "active" ||
		got.Direction != "debit" || got.Missed || got.PriceChange {
		t.Fatalf("got %+v", got)
	}
	// Detected rows default to proposed.
	d := validSchedule()
	d.NormalizedMerchant = "du telecom"
	d.Source = "detected"
	did, err := st.InsertScheduled(d)
	if err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.SelectScheduledByID(did); got.Status != "proposed" {
		t.Fatalf("detected default status=%q want proposed", got.Status)
	}
}

// TestScheduledMerchantCollapsesWhitespace: the matcher compares stored
// merchants byte-for-byte against recur.Normalize (lowercase + interior
// whitespace COLLAPSED). A pasted raw bank string with a run of spaces must
// store as the collapsed key, or the schedule could never match an arriving
// transaction and would sit missed forever — and a dismissed row with
// uncollapsed spaces wouldn't suppress the detector re-proposing the merchant.
func TestScheduledMerchantCollapsesWhitespace(t *testing.T) {
	st := newTestStore(t)
	r := validSchedule()
	r.NormalizedMerchant = "  Netflix.COM \t\t x  "
	id, err := st.InsertScheduled(r)
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := st.SelectScheduledByID(id)
	if err != nil || got.NormalizedMerchant != "netflix.com x" {
		t.Fatalf("stored merchant %q err=%v, want %q (collapsed, matcher-identical)",
			got.NormalizedMerchant, err, "netflix.com x")
	}
	// Update path collapses too.
	got.NormalizedMerchant = "CARREFOUR   DUBAI"
	if err := st.UpdateScheduled(got); err != nil {
		t.Fatal(err)
	}
	if again, _, _ := st.SelectScheduledByID(id); again.NormalizedMerchant != "carrefour dubai" {
		t.Fatalf("updated merchant %q, want %q", again.NormalizedMerchant, "carrefour dubai")
	}
	// The merchant set (detector suppression) sees the collapsed key.
	set, err := st.ScheduledMerchantSet()
	if err != nil || !set["carrefour dubai"] {
		t.Fatalf("merchant set = %v err=%v, want collapsed key present", set, err)
	}
}

// TestRearmScheduledNextDue: only next_due moves; missed and match
// bookkeeping stay put (the bill is still visibly missing until a real match).
func TestRearmScheduledNextDue(t *testing.T) {
	st := newTestStore(t)
	id, err := st.InsertScheduled(validSchedule())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MarkScheduledMissed(id); err != nil {
		t.Fatal(err)
	}
	if err := st.RearmScheduledNextDue(id, "2026-09-04"); err != nil {
		t.Fatal(err)
	}
	got, _, err := st.SelectScheduledByID(id)
	if err != nil {
		t.Fatal(err)
	}
	if got.NextDue != "2026-09-04" || !got.Missed {
		t.Fatalf("after rearm: next_due=%s missed=%v, want 2026-09-04/true", got.NextDue, got.Missed)
	}
	if err := st.RearmScheduledNextDue(id, "not-a-date"); !errors.Is(err, ErrScheduleInvalid) {
		t.Fatalf("bad date: want ErrScheduleInvalid, got %v", err)
	}
}

func TestScheduledStatusTransitions(t *testing.T) {
	st := newTestStore(t)
	cases := []struct {
		name    string
		start   string
		to      string
		allowed bool
	}{
		{"confirm proposed", "proposed", "active", true},
		{"dismiss proposed", "proposed", "dismissed", true},
		{"pause proposed", "proposed", "paused", false},
		{"pause active", "active", "paused", true},
		{"dismiss active", "active", "dismissed", true},
		{"resume paused", "paused", "active", true},
		{"dismiss paused", "paused", "dismissed", true},
		{"reactivate dismissed", "dismissed", "active", true},
		{"pause dismissed", "dismissed", "paused", false},
		{"back to proposed", "active", "proposed", false},
		{"same status idempotent", "active", "active", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := validSchedule()
			r.NormalizedMerchant = "m " + tc.name
			r.Status = tc.start
			id, err := st.InsertScheduled(r)
			if err != nil {
				t.Fatal(err)
			}
			err = st.SetScheduledStatus(id, tc.to)
			if tc.allowed && err != nil {
				t.Fatalf("transition %s→%s should pass: %v", tc.start, tc.to, err)
			}
			if !tc.allowed {
				if !errors.Is(err, ErrScheduleInvalid) {
					t.Fatalf("transition %s→%s should fail with ErrScheduleInvalid, got %v", tc.start, tc.to, err)
				}
				return
			}
			if got, _, _ := st.SelectScheduledByID(id); got.Status != tc.to {
				t.Fatalf("status=%q want %q", got.Status, tc.to)
			}
		})
	}
	if err := st.SetScheduledStatus(9999, "active"); !errors.Is(err, ErrScheduleInvalid) {
		t.Fatalf("missing id: want ErrScheduleInvalid, got %v", err)
	}
}

func TestScheduledUpdateAndDelete(t *testing.T) {
	st := newTestStore(t)
	catID := insertCategory(t, st, "SchedCat", "spending", "need")
	id, err := st.InsertScheduled(validSchedule())
	if err != nil {
		t.Fatal(err)
	}
	got, _, _ := st.SelectScheduledByID(id)
	got.Label = "Netflix Premium"
	got.AmountFils = 4_500
	got.CategoryID = &catID
	if err := st.UpdateScheduled(got); err != nil {
		t.Fatal(err)
	}
	after, _, _ := st.SelectScheduledByID(id)
	if after.Label != "Netflix Premium" || after.AmountFils != 4_500 ||
		after.CategoryID == nil || *after.CategoryID != catID {
		t.Fatalf("after=%+v", after)
	}
	missing := validSchedule()
	missing.ID = 9999
	if err := st.UpdateScheduled(missing); !errors.Is(err, ErrScheduleInvalid) {
		t.Fatalf("update missing: want ErrScheduleInvalid, got %v", err)
	}
	if err := st.DeleteScheduled(id); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.SelectScheduledByID(id); ok {
		t.Fatal("schedule should be deleted")
	}
}

func TestMarkScheduledMatchedAndMissed(t *testing.T) {
	st := newTestStore(t)
	catID := insertCategory(t, st, "SchedMatch", "spending", "want")
	txID := insertTxn(t, st, catID, "debit", 3_900, "2026-08-05", "confirmed")

	id, err := st.InsertScheduled(validSchedule()) // 3900 fils, ±10% → band 390
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MarkScheduledMissed(id); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.SelectScheduledByID(id); !got.Missed {
		t.Fatal("missed flag should be set")
	}

	// In-tolerance match clears missed, advances next_due, no price change.
	matchedAt := time.Date(2026, 8, 5, 9, 0, 0, 0, time.UTC)
	if err := st.MarkScheduledMatched(id, txID, matchedAt, 4_200); err != nil {
		t.Fatal(err)
	}
	got, _, _ := st.SelectScheduledByID(id)
	if got.Missed || got.PriceChange {
		t.Fatalf("flags after in-tolerance match: %+v", got)
	}
	if got.NextDue != "2026-09-04" { // 2026-08-05 + 30 days
		t.Fatalf("next_due=%q want 2026-09-04", got.NextDue)
	}
	if got.LastMatchedTxID == nil || *got.LastMatchedTxID != txID ||
		got.LastAmountFils == nil || *got.LastAmountFils != 4_200 || got.LastMatchedAt == "" {
		t.Fatalf("match bookkeeping: %+v", got)
	}

	// Out-of-tolerance match flags a price change (4400 - 3900 = 500 > 390).
	if err := st.MarkScheduledMatched(id, txID, matchedAt.AddDate(0, 0, 30), 4_400); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.SelectScheduledByID(id); !got.PriceChange {
		t.Fatal("price_change should be set")
	}
	if err := st.MarkScheduledMatched(9999, txID, matchedAt, 1); !errors.Is(err, ErrScheduleInvalid) {
		t.Fatalf("missing id: want ErrScheduleInvalid, got %v", err)
	}
}

func TestSelectUpcomingAndMerchantSet(t *testing.T) {
	st := newTestStore(t)
	mk := func(merchant, due, status string) int64 {
		r := validSchedule()
		r.NormalizedMerchant = merchant
		r.NextDue = due
		r.Status = status
		id, err := st.InsertScheduled(r)
		if err != nil {
			t.Fatalf("insert %s: %v", merchant, err)
		}
		return id
	}
	soon := mk("soon", "2026-08-02", "active")
	overdue := mk("overdue", "2026-07-20", "active")
	mk("far", "2026-09-15", "active")
	mk("paused", "2026-08-01", "paused")
	mk("dismissed", "2026-08-01", "dismissed")

	from := time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	up, err := st.SelectUpcoming(from, 7) // horizon 2026-08-05
	if err != nil {
		t.Fatal(err)
	}
	if len(up) != 2 || up[0].ID != overdue || up[1].ID != soon {
		t.Fatalf("upcoming=%+v (want overdue then soon)", up)
	}

	set, err := st.ScheduledMerchantSet()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []string{"soon", "overdue", "far", "paused", "dismissed"} {
		if !set[m] {
			t.Fatalf("merchant set missing %q (dismissed must block re-proposal): %v", m, set)
		}
	}

	// SelectScheduled: statuses filter vs everything.
	all, err := st.SelectScheduled()
	if err != nil || len(all) != 5 {
		t.Fatalf("all: n=%d err=%v", len(all), err)
	}
	act, err := st.SelectScheduled("active")
	if err != nil || len(act) != 3 {
		t.Fatalf("active: n=%d err=%v", len(act), err)
	}
}
