package recur

import (
	"reflect"
	"testing"
	"time"
)

func schedDue(id int64, interval int64, due string, missed bool) Schedule {
	d, _ := time.Parse("2006-01-02", due)
	return Schedule{ID: id, NormalizedMerchant: "m", AmountFils: 1000,
		IntervalDays: interval, NextDue: d.UTC(), Direction: "debit", Missed: missed}
}

func TestSweep(t *testing.T) {
	cases := []struct {
		name      string
		now       string
		schedules []Schedule
		want      []int64
	}{
		{
			name: "monthly: inside three-day grace",
			now:  "2026-07-23",
			schedules: []Schedule{
				schedDue(1, 30, "2026-07-20", false),
			},
			want: nil,
		},
		{
			name: "monthly: one day past grace",
			now:  "2026-07-24",
			schedules: []Schedule{
				schedDue(1, 30, "2026-07-20", false),
			},
			want: []int64{1},
		},
		{
			name: "weekly grace is two days",
			now:  "2026-07-23",
			schedules: []Schedule{
				schedDue(1, 7, "2026-07-20", false), // 3 > 2 → missed
				schedDue(2, 7, "2026-07-21", false), // 2 = grace → not yet
			},
			want: []int64{1},
		},
		{
			name: "yearly grace caps at seven days",
			now:  "2026-07-09",
			schedules: []Schedule{
				schedDue(1, 365, "2026-07-01", false), // 8 > 7 → missed
			},
			want: []int64{1},
		},
		{
			name: "already-missed rows are not re-flagged",
			now:  "2026-08-01",
			schedules: []Schedule{
				schedDue(1, 30, "2026-07-01", true),
			},
			want: nil,
		},
		{
			name: "future due dates never sweep",
			now:  "2026-07-01",
			schedules: []Schedule{
				schedDue(1, 30, "2026-07-15", false),
			},
			want: nil,
		},
		{
			name: "multiple missed come back sorted",
			now:  "2026-08-01",
			schedules: []Schedule{
				schedDue(9, 30, "2026-06-01", false),
				schedDue(3, 7, "2026-07-01", false),
			},
			want: []int64{3, 9},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Sweep(d(t, tc.now), tc.schedules)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Sweep = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestRearmStale: a fully-missed cycle must not kill a schedule forever —
// once next_due falls beyond the late match window, it advances by whole
// intervals (original cadence phase preserved) back to matchable range.
func TestRearmStale(t *testing.T) {
	cases := []struct {
		name      string
		now       string
		schedules []Schedule
		want      map[int64]string // id → re-armed next_due; absent = untouched
	}{
		{
			// The review scenario: monthly bill due 06-01 missed entirely; by
			// 07-05 the offset (34) exceeds the late window (15) and no future
			// occurrence could ever match without a re-arm.
			name:      "monthly one full cycle behind",
			now:       "2026-07-05",
			schedules: []Schedule{schedDue(1, 30, "2026-06-01", true)},
			want:      map[int64]string{1: "2026-07-01"},
		},
		{
			// A year behind: jumps multiple intervals in one call, keeping the
			// 06-01 phase (…-05-27, -06-26 — the first date within ±15 of now).
			name:      "monthly a year behind jumps many cycles",
			now:       "2027-06-01",
			schedules: []Schedule{schedDue(1, 30, "2026-06-01", true)},
			want:      map[int64]string{1: "2027-05-27"},
		},
		{
			name:      "inside the late window is untouched",
			now:       "2026-06-14", // offset 13 ≤ late 15
			schedules: []Schedule{schedDue(1, 30, "2026-06-01", true)},
			want:      map[int64]string{},
		},
		{
			name:      "weekly re-arms too",
			now:       "2026-06-15", // offset 14 > late 3
			schedules: []Schedule{schedDue(1, 7, "2026-06-01", true)},
			want:      map[int64]string{1: "2026-06-15"},
		},
		{
			name:      "future due never re-arms",
			now:       "2026-06-01",
			schedules: []Schedule{schedDue(1, 30, "2026-06-20", false)},
			want:      map[int64]string{},
		},
		{
			name: "output sorted by id",
			now:  "2026-09-01",
			schedules: []Schedule{
				schedDue(9, 30, "2026-06-01", true),
				schedDue(3, 30, "2026-05-15", true),
			},
			want: map[int64]string{3: "2026-09-12", 9: "2026-08-30"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RearmStale(d(t, tc.now), tc.schedules)
			if len(got) != len(tc.want) {
				t.Fatalf("RearmStale = %+v, want %d re-arms", got, len(tc.want))
			}
			lastID := int64(0)
			for _, ra := range got {
				if ra.ID <= lastID {
					t.Fatalf("output not sorted by id: %+v", got)
				}
				lastID = ra.ID
				if want, ok := tc.want[ra.ID]; !ok || ra.NextDue.Format("2006-01-02") != want {
					t.Errorf("re-arm %d = %s, want %s", ra.ID, ra.NextDue.Format("2006-01-02"), want)
				}
			}
		})
	}
}
