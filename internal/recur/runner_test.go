package recur

import (
	"encoding/json"
	"testing"
	"time"

	"ledger/internal/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func insertTxn(t *testing.T, st *store.Store, day string, amt int64, merchant, direction, status string) int64 {
	t.Helper()
	id, created, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    d(t, day).Add(9 * time.Hour),
		AmountFils:  amt,
		Currency:    "AED",
		Direction:   direction,
		MerchantRaw: merchant,
		Status:      status,
		Confidence:  1,
	})
	if err != nil || !created {
		t.Fatalf("insert txn %s %s: created=%v err=%v", day, merchant, created, err)
	}
	return id
}

func mustSchedule(t *testing.T, st *store.Store, id int64) store.ScheduledTxnRow {
	t.Helper()
	row, ok, err := st.SelectScheduledByID(id)
	if err != nil || !ok {
		t.Fatalf("select schedule %d: ok=%v err=%v", id, ok, err)
	}
	return row
}

// TestRunnerLifecycle drives the full loop against a real store: detect from
// confirmed history → confirm → match an arriving bill → miss a bill → match
// its late, repriced arrival.
func TestRunnerLifecycle(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)

	var detected []store.ScheduledTxnRow
	var missed []store.ScheduledTxnRow
	r.SetOnDetected(func(row store.ScheduledTxnRow) { detected = append(detected, row) })
	r.SetOnMissed(func(row store.ScheduledTxnRow) { missed = append(missed, row) })

	// Confirmed monthly history + noise that must not detect.
	ids := []int64{
		insertTxn(t, st, "2026-01-05", 3_900, "NETFLIX.COM", "debit", "confirmed"),
		insertTxn(t, st, "2026-02-04", 3_900, "NETFLIX.COM", "debit", "confirmed"),
		insertTxn(t, st, "2026-03-06", 3_900, "NETFLIX.COM", "debit", "confirmed"),
		insertTxn(t, st, "2026-04-05", 3_900, "NETFLIX.COM", "debit", "confirmed"),
	}
	insertTxn(t, st, "2026-03-11", 25_000, "One-Off Shop", "debit", "confirmed")

	// Detect → one proposed schedule with provenance.
	n, err := r.DetectAndPropose(d(t, "2026-04-10"))
	if err != nil || n != 1 {
		t.Fatalf("DetectAndPropose = (%d, %v), want (1, nil)", n, err)
	}
	proposed, err := st.SelectScheduled("proposed")
	if err != nil || len(proposed) != 1 {
		t.Fatalf("proposed rows = %d err=%v", len(proposed), err)
	}
	sched := proposed[0]
	if sched.NormalizedMerchant != "netflix.com" || sched.Source != "detected" ||
		sched.AmountFils != 3_900 || sched.IntervalDays != 30 || sched.NextDue != "2026-05-05" {
		t.Fatalf("unexpected proposal: %+v", sched)
	}
	var prov Provenance
	if err := json.Unmarshal([]byte(sched.Provenance), &prov); err != nil {
		t.Fatalf("provenance json: %v (%q)", err, sched.Provenance)
	}
	if prov.Count != 4 || prov.AvgIntervalDays != 30 || len(prov.TxIDs) != 4 || prov.TxIDs[0] != ids[0] {
		t.Fatalf("provenance = %+v", prov)
	}
	if len(detected) != 1 || detected[0].ID != sched.ID {
		t.Fatalf("onDetected hook: %+v", detected)
	}

	// Re-detect never duplicates (merchant set includes proposed rows).
	if n, err := r.DetectAndPropose(d(t, "2026-04-11")); err != nil || n != 0 {
		t.Fatalf("re-detect = (%d, %v), want (0, nil)", n, err)
	}

	// Confirm, then a new bill email arrives (still needs_review) → matched.
	if err := st.SetScheduledStatus(sched.ID, "active"); err != nil {
		t.Fatalf("confirm: %v", err)
	}
	mayID := insertTxn(t, st, "2026-05-06", 3_900, "netflix.com", "debit", "needs_review")
	if err := r.PostProcess(d(t, "2026-05-06")); err != nil {
		t.Fatalf("post-process: %v", err)
	}
	got := mustSchedule(t, st, sched.ID)
	if got.LastMatchedTxID == nil || *got.LastMatchedTxID != mayID {
		t.Fatalf("last matched = %v, want %d", got.LastMatchedTxID, mayID)
	}
	if got.NextDue != "2026-06-05" || got.Missed || got.PriceChange {
		t.Fatalf("after match: %+v", got)
	}

	// Idempotent: re-running the hook must not re-match or move anything.
	if err := r.PostProcess(d(t, "2026-05-07")); err != nil {
		t.Fatalf("post-process (again): %v", err)
	}
	if again := mustSchedule(t, st, sched.ID); again.NextDue != "2026-06-05" || *again.LastMatchedTxID != mayID {
		t.Fatalf("hook is not idempotent: %+v", again)
	}

	// June's email never arrives: past due + grace → missed, hook fires.
	if err := r.PostProcess(d(t, "2026-06-09")); err != nil {
		t.Fatalf("post-process (sweep): %v", err)
	}
	if got := mustSchedule(t, st, sched.ID); !got.Missed {
		t.Fatalf("want missed after grace, got %+v", got)
	}
	if len(missed) != 1 || missed[0].ID != sched.ID {
		t.Fatalf("onMissed hook: %+v", missed)
	}

	// The bill finally lands, late and repriced: match clears missed, flags
	// price_change (600 fils > 10% band), advances next_due from the match date.
	lateID := insertTxn(t, st, "2026-06-12", 4_500, "netflix.com", "debit", "needs_review")
	if err := r.PostProcess(d(t, "2026-06-12")); err != nil {
		t.Fatalf("post-process (late match): %v", err)
	}
	got = mustSchedule(t, st, sched.ID)
	if got.Missed || !got.PriceChange || *got.LastMatchedTxID != lateID || got.NextDue != "2026-07-12" {
		t.Fatalf("after late repriced match: %+v", got)
	}
	if got.LastAmountFils == nil || *got.LastAmountFils != 4_500 {
		t.Fatalf("last amount = %v", got.LastAmountFils)
	}
}

// TestRunnerBackfillMatchesTwoOccurrences: a reprocess that lands two months
// of a bill in one batch advances the schedule twice in a single hook run.
func TestRunnerBackfillMatchesTwoOccurrences(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)

	id, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "dewa", AmountFils: 60_000, TolerancePct: 10,
		IntervalDays: 30, NextDue: "2026-05-01", Direction: "debit",
	})
	if err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	insertTxn(t, st, "2026-05-02", 60_000, "DEWA", "debit", "needs_review")
	juneID := insertTxn(t, st, "2026-06-01", 61_000, "DEWA", "debit", "needs_review")

	if err := r.PostProcess(d(t, "2026-06-02")); err != nil {
		t.Fatalf("post-process: %v", err)
	}
	got := mustSchedule(t, st, id)
	if got.LastMatchedTxID == nil || *got.LastMatchedTxID != juneID || got.NextDue != "2026-07-01" {
		t.Fatalf("backfill did not advance twice: %+v", got)
	}
}

// TestRunnerDismissedNeverReproposed: dismissing a proposal makes the merchant
// permanently ineligible for detection.
func TestRunnerDismissedNeverReproposed(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)

	insertTxn(t, st, "2026-01-05", 3_900, "hulu.com", "debit", "confirmed")
	insertTxn(t, st, "2026-02-04", 3_900, "hulu.com", "debit", "confirmed")
	insertTxn(t, st, "2026-03-06", 3_900, "hulu.com", "debit", "confirmed")

	if n, err := r.DetectAndPropose(d(t, "2026-03-10")); err != nil || n != 1 {
		t.Fatalf("detect = (%d, %v)", n, err)
	}
	proposed, _ := st.SelectScheduled("proposed")
	if err := st.SetScheduledStatus(proposed[0].ID, "dismissed"); err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	// Another month of history arrives; still no re-proposal.
	insertTxn(t, st, "2026-04-05", 3_900, "hulu.com", "debit", "confirmed")
	if n, err := r.DetectAndPropose(d(t, "2026-04-10")); err != nil || n != 0 {
		t.Fatalf("re-detect after dismiss = (%d, %v), want (0, nil)", n, err)
	}
}

// TestRunnerNoActiveSchedulesIsCheap: the hook is a no-op without active rows.
func TestRunnerNoActiveSchedules(t *testing.T) {
	st := newTestStore(t)
	if err := NewRunner(st).PostProcess(d(t, "2026-06-01")); err != nil {
		t.Fatalf("post-process on empty store: %v", err)
	}
}

// TestRunnerMissedCycleRearmsAndMatchesNextOccurrence is the dead-schedule
// regression: a bill whose email fails to arrive ONCE (spam/outage) used to
// leave next_due permanently outside every future match window — every later
// on-cadence occurrence posts at offset ≥ interval > lateWindow, so
// auto-matching was silently dead forever. The runner must re-arm the stale
// next_due onto the cadence and match the next natural occurrence, in the
// SAME hook run it arrives in.
func TestRunnerMissedCycleRearmsAndMatchesNextOccurrence(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)

	id, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "dewa", AmountFils: 60_000, TolerancePct: 10,
		IntervalDays: 30, NextDue: "2026-06-01", Direction: "debit",
	})
	if err != nil {
		t.Fatalf("insert schedule: %v", err)
	}

	// June's email never arrives. Sweep flags missed; by mid-July the old
	// next_due is beyond the late window (offset 44 > 15).
	if err := r.PostProcess(d(t, "2026-06-10")); err != nil {
		t.Fatalf("post-process (sweep): %v", err)
	}
	if got := mustSchedule(t, st, id); !got.Missed || got.NextDue != "2026-06-01" {
		t.Fatalf("after sweep: %+v", got)
	}

	// July's bill posts on cadence. Without re-arm this could never match.
	julyID := insertTxn(t, st, "2026-07-01", 60_000, "DEWA", "debit", "needs_review")
	if err := r.PostProcess(d(t, "2026-07-15")); err != nil {
		t.Fatalf("post-process (re-arm + match): %v", err)
	}
	got := mustSchedule(t, st, id)
	if got.LastMatchedTxID == nil || *got.LastMatchedTxID != julyID {
		t.Fatalf("july bill not matched after re-arm: %+v", got)
	}
	if got.Missed {
		t.Error("missed flag not cleared by the match")
	}
	if got.NextDue != "2026-07-31" {
		t.Errorf("next_due = %s, want 2026-07-31 (anchored to the matched bill)", got.NextDue)
	}
}

// TestRunnerRearmWithoutArrivalKeepsMissed: when the schedule goes stale and
// nothing arrives, re-arm moves next_due onto the next cadence date but the
// missed flag stays — the bill genuinely went missing and the UI must keep
// saying so (and no duplicate missed_bill event fires).
func TestRunnerRearmWithoutArrivalKeepsMissed(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)
	var missedEvents int
	r.SetOnMissed(func(store.ScheduledTxnRow) { missedEvents++ })

	id, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "gym co", AmountFils: 25_000, TolerancePct: 10,
		IntervalDays: 30, NextDue: "2026-06-01", Direction: "debit",
	})
	if err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	if err := r.PostProcess(d(t, "2026-06-10")); err != nil { // flags missed
		t.Fatalf("post-process (sweep): %v", err)
	}
	if missedEvents != 1 {
		t.Fatalf("missed events = %d, want 1", missedEvents)
	}
	if err := r.PostProcess(d(t, "2026-07-20")); err != nil { // stale → re-arm
		t.Fatalf("post-process (re-arm): %v", err)
	}
	got := mustSchedule(t, st, id)
	// 07-01 is itself already 19 days past (beyond the late window), so the
	// first matchable cadence date is 07-31 — phase kept, whole intervals only.
	if got.NextDue != "2026-07-31" {
		t.Errorf("next_due = %s, want 2026-07-31 (advanced whole intervals, phase kept)", got.NextDue)
	}
	if !got.Missed {
		t.Error("missed flag must survive a re-arm (nothing actually arrived)")
	}
	if missedEvents != 1 {
		t.Errorf("missed events = %d, want still 1 (sticky flag, no re-fire)", missedEvents)
	}
}

// TestRunnerEarlyOneOffDoesNotStealMatch is the "amazon.ae problem": at
// merchants where subscriptions and one-off purchases share a normalized
// merchant string, a one-off landing a few days before the due date must not
// bind the schedule — that would advance next_due off-cycle, raise a false
// price_change, and lock the real bill out of matching.
func TestRunnerEarlyOneOffDoesNotStealMatch(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)

	id, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "amazon.ae", AmountFils: 3_900, TolerancePct: 10,
		IntervalDays: 30, NextDue: "2026-07-10", Direction: "debit",
	})
	if err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	// One-off purchase five days early, outside the ±10% tolerance band.
	oneOff := insertTxn(t, st, "2026-07-05", 4_900, "amazon.ae", "debit", "needs_review")
	// The real subscription bill arrives on the due date.
	bill := insertTxn(t, st, "2026-07-10", 3_900, "amazon.ae", "debit", "needs_review")

	if err := r.PostProcess(d(t, "2026-07-10")); err != nil {
		t.Fatalf("post-process: %v", err)
	}
	got := mustSchedule(t, st, id)
	if got.LastMatchedTxID == nil || *got.LastMatchedTxID != bill {
		t.Fatalf("matched tx = %v, want the real bill %d (one-off %d stole the match)",
			got.LastMatchedTxID, bill, oneOff)
	}
	if got.NextDue != "2026-08-09" {
		t.Errorf("next_due = %s, want 2026-08-09 (anchored to the real bill)", got.NextDue)
	}
	if got.PriceChange {
		t.Error("price_change flagged by an unrelated one-off purchase")
	}
	if got.Missed {
		t.Error("schedule marked missed despite an on-time match")
	}
}

// TestRunnerDowntimeGapStillFlagsMissed is the sweep-order regression: the
// sweep must run against the PRE-rearm due dates. When the runner's first pass
// after an outage comes once the whole grace-to-late span has already slipped
// by, re-arm advances next_due onto the next cycle — and a sweep running
// AFTER re-arm sees a fresh date and never flags the miss: the bill whose
// email never arrived is silently forgotten, exactly in the situation
// (box down) where absence-noticing matters most.
func TestRunnerDowntimeGapStillFlagsMissed(t *testing.T) {
	cases := []struct {
		name        string
		interval    int64
		nextDue     string
		wakeup      string // first PostProcess after the gap
		wantNextDue string // re-armed cadence date
	}{
		// Monthly: grace 3, late 15. Waking on day 19 is past the late window,
		// so the old order re-armed to 07-01 (offset -11) and swept nothing.
		{"monthly bill, 19-day gap", 30, "2026-06-01", "2026-06-20", "2026-07-01"},
		// Weekly: grace 2, late 3 — a 4-day outage is already enough.
		{"weekly bill, 4-day gap", 7, "2026-06-01", "2026-06-05", "2026-06-08"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := newTestStore(t)
			r := NewRunner(st)
			var missedEvents int
			r.SetOnMissed(func(store.ScheduledTxnRow) { missedEvents++ })

			id, err := st.InsertScheduled(store.ScheduledTxnRow{
				NormalizedMerchant: "gap co", AmountFils: 25_000, TolerancePct: 10,
				IntervalDays: tc.interval, NextDue: tc.nextDue, Direction: "debit",
			})
			if err != nil {
				t.Fatalf("insert schedule: %v", err)
			}

			// Nothing arrived during the outage; first run after waking up.
			if err := r.PostProcess(d(t, tc.wakeup)); err != nil {
				t.Fatalf("post-process: %v", err)
			}
			got := mustSchedule(t, st, id)
			if !got.Missed {
				t.Error("missed flag not set — the gap swallowed the miss")
			}
			if missedEvents != 1 {
				t.Errorf("missed events = %d, want 1", missedEvents)
			}
			if got.NextDue != tc.wantNextDue {
				t.Errorf("next_due = %s, want %s (re-armed onto cadence)", got.NextDue, tc.wantNextDue)
			}

			// Idempotent: the next quiet run must not re-fire or move anything.
			if err := r.PostProcess(d(t, tc.wakeup)); err != nil {
				t.Fatalf("post-process (again): %v", err)
			}
			if again := mustSchedule(t, st, id); !again.Missed || again.NextDue != tc.wantNextDue {
				t.Errorf("second run changed state: %+v", again)
			}
			if missedEvents != 1 {
				t.Errorf("missed events after rerun = %d, want still 1 (sticky)", missedEvents)
			}
		})
	}
}

// TestRunnerGapArrivalMatchesRearmedCycle: after a gap, a bill that DID
// arrive on the next cadence inside the re-armed window is matched in the
// same run — and the missed flag (fired for the cycle nothing arrived for)
// is cleared by that match.
func TestRunnerGapArrivalMatchesRearmedCycle(t *testing.T) {
	st := newTestStore(t)
	r := NewRunner(st)
	var missedEvents int
	r.SetOnMissed(func(store.ScheduledTxnRow) { missedEvents++ })

	id, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "dewa", AmountFils: 60_000, TolerancePct: 10,
		IntervalDays: 30, NextDue: "2026-06-01", Direction: "debit",
	})
	if err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	// June's email never arrived; July's bill posted on cadence during the
	// outage and is in this batch.
	julyID := insertTxn(t, st, "2026-07-01", 60_000, "DEWA", "debit", "needs_review")
	if err := r.PostProcess(d(t, "2026-07-02")); err != nil {
		t.Fatalf("post-process: %v", err)
	}
	got := mustSchedule(t, st, id)
	if got.LastMatchedTxID == nil || *got.LastMatchedTxID != julyID {
		t.Fatalf("july bill not matched: %+v", got)
	}
	if got.Missed {
		t.Error("missed flag not cleared by the re-armed-window match")
	}
	if missedEvents != 1 {
		t.Errorf("missed events = %d, want 1 (June's cycle genuinely missed)", missedEvents)
	}
	if got.NextDue != "2026-07-31" {
		t.Errorf("next_due = %s, want 2026-07-31 (anchored to the matched bill)", got.NextDue)
	}
}
