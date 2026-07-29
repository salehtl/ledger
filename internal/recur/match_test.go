package recur

import (
	"testing"
	"time"
)

func txnOn(t *testing.T, day string, amt int64, merchant, direction string) Txn {
	t.Helper()
	return Txn{
		ID: 999, PostedAt: d(t, day).Add(10 * time.Hour),
		AmountFils: amt, Merchant: merchant, Direction: direction,
	}
}

func TestMatch(t *testing.T) {
	monthly := Schedule{
		ID: 1, NormalizedMerchant: "netflix.com", AmountFils: 3_900,
		TolerancePct: 10, IntervalDays: 30, NextDue: time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC),
		Direction: "debit",
	}
	weekly := Schedule{
		ID: 2, NormalizedMerchant: "gym club", AmountFils: 15_000,
		TolerancePct: 10, IntervalDays: 7, NextDue: time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC),
		Direction: "debit",
	}
	schedules := []Schedule{monthly, weekly}

	cases := []struct {
		name   string
		tx     Txn
		want   int64
		wantOK bool
	}{
		{"on the due day", txnOn(t, "2026-07-05", 3_900, "NETFLIX.COM", "debit"), 1, true},
		{"normalization: case and whitespace", txnOn(t, "2026-07-05", 3_900, "  NetFlix.COM  ", "debit"), 1, true},
		{"three days early", txnOn(t, "2026-07-02", 3_900, "netflix.com", "debit"), 1, true},
		{"early boundary: seven days for monthly", txnOn(t, "2026-06-28", 3_900, "netflix.com", "debit"), 1, true},
		{"too early: eight days", txnOn(t, "2026-06-27", 3_900, "netflix.com", "debit"), 0, false},
		{"late boundary: fifteen days for monthly", txnOn(t, "2026-07-20", 3_900, "netflix.com", "debit"), 1, true},
		{"too late: sixteen days", txnOn(t, "2026-07-21", 3_900, "netflix.com", "debit"), 0, false},
		{"price creep 33% still matches (flagging is the store's job)", txnOn(t, "2026-07-05", 5_200, "netflix.com", "debit"), 1, true},
		{"60% off is an unrelated purchase", txnOn(t, "2026-07-05", 6_240, "netflix.com", "debit"), 0, false},
		{"early arrivals only match inside the schedule's own tolerance", txnOn(t, "2026-07-02", 4_900, "netflix.com", "debit"), 0, false},
		{"early within tolerance matches (bill posted ahead)", txnOn(t, "2026-07-02", 4_100, "netflix.com", "debit"), 1, true},
		{"the loose band re-opens on the due day", txnOn(t, "2026-07-05", 4_900, "netflix.com", "debit"), 1, true},
		{"and stays open late (repriced late bill)", txnOn(t, "2026-07-12", 4_900, "netflix.com", "debit"), 1, true},
		{"wrong merchant", txnOn(t, "2026-07-05", 3_900, "hulu.com", "debit"), 0, false},
		{"wrong direction", txnOn(t, "2026-07-05", 3_900, "netflix.com", "credit"), 0, false},
		{"weekly early window is tighter: three days early misses", txnOn(t, "2026-07-02", 15_000, "gym club", "debit"), 0, false},
		{"weekly two days early matches", txnOn(t, "2026-07-03", 15_000, "gym club", "debit"), 2, true},
		{"weekly late window: three days", txnOn(t, "2026-07-08", 15_000, "gym club", "debit"), 2, true},
		{"weekly four days late misses", txnOn(t, "2026-07-09", 15_000, "gym club", "debit"), 0, false},
		{"empty merchant never matches", txnOn(t, "2026-07-05", 3_900, "   ", "debit"), 0, false},
		{"non-positive amount never matches", txnOn(t, "2026-07-05", 0, "netflix.com", "debit"), 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Match(tc.tx, schedules)
			if ok != tc.wantOK || got != tc.want {
				t.Fatalf("Match = (%d, %v), want (%d, %v)", got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestMatchPicksClosestAmountThenDateThenID(t *testing.T) {
	due := time.Date(2026, 7, 5, 0, 0, 0, 0, time.UTC)
	a := Schedule{ID: 1, NormalizedMerchant: "axa insurance", AmountFils: 3_900,
		TolerancePct: 10, IntervalDays: 30, NextDue: due, Direction: "debit"}
	b := Schedule{ID: 2, NormalizedMerchant: "axa insurance", AmountFils: 2_000,
		TolerancePct: 10, IntervalDays: 30, NextDue: due, Direction: "debit"}

	// 2100 is inside both loose bands; the 2000-schedule is the closer amount.
	if got, ok := Match(txnOn(t, "2026-07-05", 2_100, "axa insurance", "debit"), []Schedule{a, b}); !ok || got != 2 {
		t.Fatalf("closest amount: got (%d, %v), want (2, true)", got, ok)
	}

	// Identical schedules except due date: the closer date wins.
	c := b
	c.ID = 3
	c.NextDue = due.AddDate(0, 0, 10)
	if got, ok := Match(txnOn(t, "2026-07-06", 2_000, "axa insurance", "debit"), []Schedule{c, b}); !ok || got != 2 {
		t.Fatalf("closest date: got (%d, %v), want (2, true)", got, ok)
	}

	// Full tie: lowest id wins regardless of slice order.
	e := b
	e.ID = 9
	if got, ok := Match(txnOn(t, "2026-07-05", 2_000, "axa insurance", "debit"), []Schedule{e, b}); !ok || got != 2 {
		t.Fatalf("tie on id: got (%d, %v), want (2, true)", got, ok)
	}
}

// TestMatchRescue: the dead-zone matcher only serves MISSED schedules, only
// on the early side of next_due, and only within the schedule's own STRICT
// tolerance band — never the loose 50% floor Match applies on/after due.
func TestMatchRescue(t *testing.T) {
	sched := Schedule{
		ID: 1, NormalizedMerchant: "netflix.com", AmountFils: 3_900,
		TolerancePct: 10, IntervalDays: 30, NextDue: d(t, "2026-02-04"),
		Direction: "debit", Missed: true,
	}
	tx := func(day string, amt int64) Txn {
		return Txn{ID: 99, PostedAt: d(t, day), AmountFils: amt, Merchant: "NETFLIX.COM", Direction: "debit"}
	}

	// The canonical dead-zone arrival (offset −10, outside early window 7).
	if id, ok := MatchRescue(tx("2026-01-25", 3_900), []Schedule{sched}); !ok || id != 1 {
		t.Fatalf("dead-zone arrival: got (%d,%v), want (1,true)", id, ok)
	}
	// Healthy schedules are never rescued — normal Match owns them.
	healthy := sched
	healthy.Missed = false
	if _, ok := MatchRescue(tx("2026-01-25", 3_900), []Schedule{healthy}); ok {
		t.Fatal("rescued a schedule that is not missed")
	}
	// Strict band only: 5_400 is within Match's 50% floor but outside the
	// schedule's own ±10% — an off-phase re-anchor must not accept it.
	if _, ok := MatchRescue(tx("2026-01-25", 5_400), []Schedule{sched}); ok {
		t.Fatal("rescued an amount outside the schedule's own tolerance")
	}
	// Window edges: −1 in; 0 out (Match's territory); −(interval−1) in;
	// −interval (the previous cycle's due date) out.
	if _, ok := MatchRescue(tx("2026-02-03", 3_900), []Schedule{sched}); !ok {
		t.Fatal("offset -1 must rescue")
	}
	if _, ok := MatchRescue(tx("2026-02-04", 3_900), []Schedule{sched}); ok {
		t.Fatal("offset 0 must be left to normal Match")
	}
	if _, ok := MatchRescue(tx("2026-01-06", 3_900), []Schedule{sched}); !ok {
		t.Fatal("offset -(interval-1) must rescue")
	}
	if _, ok := MatchRescue(tx("2026-01-05", 3_900), []Schedule{sched}); ok {
		t.Fatal("offset -interval is the previous cycle, not rescueable")
	}
}
