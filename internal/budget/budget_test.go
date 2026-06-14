package budget

import (
	"testing"
	"time"

	"ledger/internal/store"
)

func TestComputeBucketsAndProjection(t *testing.T) {
	cfg := store.BudgetConfig{NeedPct: 0.50, WantPct: 0.30, SavingPct: 0.20}
	spend := []store.SpendRow{
		{Bucket: "need", Direction: "debit", AmountFils: 600000},
		{Bucket: "need", Direction: "credit", AmountFils: 100000},
		{Bucket: "want", Direction: "debit", AmountFils: 300000},
	}
	now := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC)
	s := Compute(cfg, 2000000, spend, nil, now)

	if s.Period != "2026-06" {
		t.Errorf("period = %q", s.Period)
	}
	if s.Income != 2000000 {
		t.Errorf("income = %d", s.Income)
	}
	need := bucketByName(t, s, "need")
	if need.Target != 1000000 {
		t.Errorf("need target = %d, want 1000000", need.Target)
	}
	if need.Spent != 500000 {
		t.Errorf("need spent = %d, want 500000 (netted)", need.Spent)
	}
	if need.Remaining != 500000 {
		t.Errorf("need remaining = %d", need.Remaining)
	}
	if need.PctUsed < 0.49 || need.PctUsed > 0.51 {
		t.Errorf("need pct_used = %v, want ~0.5", need.PctUsed)
	}
	if need.Projection < 990000 || need.Projection > 1010000 {
		t.Errorf("need projection = %d, want ~1000000", need.Projection)
	}
	if s.MonthProgress < 0.49 || s.MonthProgress > 0.51 {
		t.Errorf("month progress = %v, want ~0.5", s.MonthProgress)
	}
}

func TestComputeZeroTargetNoDivByZero(t *testing.T) {
	cfg := store.BudgetConfig{NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2}
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	s := Compute(cfg, 0, nil, nil, now)
	for _, b := range s.Buckets {
		if b.PctUsed != 0 {
			t.Errorf("%s pct_used = %v, want 0 when target 0", b.Bucket, b.PctUsed)
		}
	}
}

func bucketByName(t *testing.T, s Summary, name string) BucketSummary {
	t.Helper()
	for _, b := range s.Buckets {
		if b.Bucket == name {
			return b
		}
	}
	t.Fatalf("bucket %q missing", name)
	return BucketSummary{}
}
