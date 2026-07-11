// internal/store/ai_usage_test.go
package store

import "testing"

func TestRecordAndSumAIUsage(t *testing.T) {
	st := newTestStore(t)
	now := int64(1_000_000)
	st.SetNow(func() int64 { return now })

	if _, err := st.RecordAIUsage(AIUsageRow{Path: "extract", Model: "m", InputTokens: 10, OutputTokens: 2, CostMuUSD: 20, OK: true}); err != nil {
		t.Fatal(err)
	}
	// A row 40 days old must fall outside the 30-day window.
	old := now - 40*24*3600
	if _, err := st.RecordAIUsage(AIUsageRow{At: old, Path: "categorize", Model: "m", CostMuUSD: 500, OK: true}); err != nil {
		t.Fatal(err)
	}
	sum, err := st.SumAIUsageMuUSD(now - 30*24*3600)
	if err != nil {
		t.Fatal(err)
	}
	if sum != 20 {
		t.Fatalf("30d sum = %d, want 20 (old row excluded)", sum)
	}
	stats, err := st.AIUsageStats(now)
	if err != nil {
		t.Fatal(err)
	}
	if stats.CountAll != 2 || stats.Count30d != 1 || stats.CostAllMuUSD != 520 {
		t.Fatalf("stats = %+v", stats)
	}
}

func TestCapLatchDisablesAI(t *testing.T) {
	st := newTestStore(t)
	now := int64(2_000_000)
	st.SetNow(func() int64 { return now })

	s, _ := st.SelectAppSettings()
	s.AIEnabled = true
	s.SpendCapMuUSD = 100
	if err := st.UpdateAppSettings(s); err != nil {
		t.Fatal(err)
	}

	// Under cap: no latch.
	latched, err := st.RecordAIUsage(AIUsageRow{Path: "extract", Model: "m", CostMuUSD: 60, OK: true})
	if err != nil || latched {
		t.Fatalf("latched=%v err=%v, want false/nil", latched, err)
	}
	// Crossing cap: latch, AI disabled.
	latched, err = st.RecordAIUsage(AIUsageRow{Path: "extract", Model: "m", CostMuUSD: 60, OK: true})
	if err != nil {
		t.Fatal(err)
	}
	if !latched {
		t.Fatal("expected latched=true after crossing cap")
	}
	got, _ := st.SelectAppSettings()
	if got.AIEnabled {
		t.Fatal("AIEnabled should be false after latch")
	}
	if !got.CapLatched {
		t.Fatal("CapLatched should be true after latch")
	}
}

func TestReEnableClearsLatch(t *testing.T) {
	st := newTestStore(t)
	s, _ := st.SelectAppSettings()
	s.CapLatched = true
	s.AIEnabled = false
	if err := st.UpdateAppSettings(s); err != nil {
		t.Fatal(err)
	}
	// Turning AI back on clears the latch.
	s.AIEnabled = true
	if err := st.UpdateAppSettings(s); err != nil {
		t.Fatal(err)
	}
	got, _ := st.SelectAppSettings()
	if got.CapLatched {
		t.Fatal("re-enabling AI must clear CapLatched")
	}
}
