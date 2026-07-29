package budget

import (
	"testing"

	"ledger/internal/store"
)

func TestThresholdLevel(t *testing.T) {
	tests := []struct {
		name            string
		activity, limit int64
		want            int
	}{
		{"zero limit never fires", 500, 0, 0},
		{"negative activity never fires", -100, 1000, 0},
		{"below 80", 799, 1000, 0},
		{"exactly 80", 800, 1000, 80},
		{"between 80 and 100", 999, 1000, 80},
		{"exactly 100", 1000, 1000, 100},
		{"over 100", 1500, 1000, 100},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := thresholdLevel(tc.activity, tc.limit); got != tc.want {
				t.Errorf("thresholdLevel(%d, %d) = %d, want %d", tc.activity, tc.limit, got, tc.want)
			}
		})
	}
}

func TestCurrentThresholdLevels(t *testing.T) {
	cfg := store.BudgetConfig{NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2}
	sum := EnvelopeSummary{
		Month:      "2026-07",
		IncomeFils: 10_000_00, // need jar target 5000.00, want 3000.00, saving 2000.00
		Envelopes: []Envelope{
			// 90% of carryover+assigned → envelope level 80.
			{CategoryID: 1, CategoryName: "Groceries", Bucket: "need",
				CarryoverFils: 100_00, AssignedFils: 900_00, ActivityFils: 900_00},
			// Fully spent → level 100.
			{CategoryID: 2, CategoryName: "Rent", Bucket: "need",
				AssignedFils: 3200_00, ActivityFils: 3200_00},
			// Nothing budgeted → never fires even with spend.
			{CategoryID: 3, CategoryName: "Misc", Bucket: "want",
				ActivityFils: 500_00},
			// Under 80% → silent.
			{CategoryID: 4, CategoryName: "Fun", Bucket: "want",
				AssignedFils: 1000_00, ActivityFils: 100_00},
		},
	}
	got := CurrentThresholdLevels(sum, cfg)

	byKey := make(map[string]ThresholdCrossing)
	for _, c := range got {
		byKey[c.Key] = c
	}
	// Envelope crossings.
	if c := byKey["env:1"]; c.Level != 80 || c.LimitFils != 1000_00 || c.Scope != "envelope" {
		t.Errorf("env:1 = %+v, want level 80 limit 1000_00", c)
	}
	if c := byKey["env:2"]; c.Level != 100 {
		t.Errorf("env:2 = %+v, want level 100", c)
	}
	if _, ok := byKey["env:3"]; ok {
		t.Error("env:3 fired despite zero limit")
	}
	if _, ok := byKey["env:4"]; ok {
		t.Error("env:4 fired below 80%")
	}
	// Bucket crossing: need activity 4100.00 of 5000.00 = 82% → level 80.
	if c := byKey["bucket:need"]; c.Level != 80 || c.LimitFils != 5000_00 || c.ActivityFils != 4100_00 {
		t.Errorf("bucket:need = %+v, want level 80 activity 4100_00 of 5000_00", c)
	}
	// want bucket: 600.00 of 3000.00 = 20% → silent.
	if _, ok := byKey["bucket:want"]; ok {
		t.Error("bucket:want fired below 80%")
	}
	if len(got) != 3 {
		t.Errorf("got %d crossings (%v), want 3", len(got), byKey)
	}
	// Month is stamped on every crossing.
	for _, c := range got {
		if c.Month != "2026-07" {
			t.Errorf("crossing %s month = %q, want 2026-07", c.Key, c.Month)
		}
	}
}
