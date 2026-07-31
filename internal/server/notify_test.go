package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"ledger/internal/store"
)

// newNotifyTestServer wires a real store with settings, envelopes and
// schedules plus a live hub, returning a subscribed event channel.
func newNotifyTestServer(t *testing.T) (*Server, *store.Store, chan []byte) {
	t.Helper()
	st := newTestServerStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateBudgetConfig(store.BudgetConfig{
		MonthlyIncome: 100_000_00, NeedPct: 0.5, WantPct: 0.3, SavingPct: 0.2, IncomeSource: "config",
	}); err != nil {
		t.Fatal(err)
	}
	srv := New(st, testFS())
	srv.SetNotifyStore(st)
	srv.SetEnvelopeStore(st)
	srv.SetScheduledStore(st)
	srv.SetSettingsStore(st)
	hub := NewHub()
	srv.SetHub(hub)
	ch, unsub := hub.Subscribe()
	t.Cleanup(unsub)
	return srv, st, ch
}

// drainEvents collects every event currently buffered on the channel.
func drainEvents(t *testing.T, ch chan []byte) []map[string]any {
	t.Helper()
	var out []map[string]any
	for {
		select {
		case data := <-ch:
			var ev map[string]any
			if err := json.Unmarshal(data, &ev); err != nil {
				t.Fatalf("bad event %s: %v", data, err)
			}
			out = append(out, ev)
		case <-time.After(50 * time.Millisecond):
			return out
		}
	}
}

func eventsOfType(evs []map[string]any, typ string) []map[string]any {
	var out []map[string]any
	for _, e := range evs {
		if e["type"] == typ {
			out = append(out, e)
		}
	}
	return out
}

func TestNotifySettingsRoundtrip(t *testing.T) {
	srv, _, _ := newNotifyTestServer(t)

	// Migration defaults: thresholds on, 3-day horizon.
	w := doJSON(t, srv, "GET", "/api/settings/notifications", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET status = %d", w.Code)
	}
	var dto struct {
		NotifyThresholds   bool `json:"notify_thresholds"`
		NotifyUpcomingDays int  `json:"notify_upcoming_days"`
	}
	json.Unmarshal(w.Body.Bytes(), &dto)
	if !dto.NotifyThresholds || dto.NotifyUpcomingDays != 3 {
		t.Fatalf("defaults = %+v, want thresholds on / 3 days", dto)
	}

	w = doJSON(t, srv, "PUT", "/api/settings/notifications", map[string]any{
		"notify_thresholds": false, "notify_upcoming_days": 7,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body: %s", w.Code, w.Body)
	}
	w = doJSON(t, srv, "GET", "/api/settings/notifications", nil)
	json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.NotifyThresholds || dto.NotifyUpcomingDays != 7 {
		t.Fatalf("after PUT = %+v", dto)
	}

	if w := doJSON(t, srv, "PUT", "/api/settings/notifications", map[string]any{
		"notify_upcoming_days": 61,
	}); w.Code != http.StatusBadRequest {
		t.Fatalf("days=61 status = %d, want 400", w.Code)
	}

	// The categorization settings PUT must not clobber notify fields.
	if w := doJSON(t, srv, "PUT", "/api/settings", map[string]any{
		"auto_categorize": true, "ai_threshold": 0.9, "ingest_silence_days": 3,
	}); w.Code != http.StatusOK {
		t.Fatalf("settings PUT status = %d", w.Code)
	}
	w = doJSON(t, srv, "GET", "/api/settings/notifications", nil)
	json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.NotifyThresholds || dto.NotifyUpcomingDays != 7 {
		t.Fatalf("after settings PUT = %+v, notify fields clobbered", dto)
	}
}

func TestEvaluateBudgetThresholdsEmitsOnCrossing(t *testing.T) {
	srv, st, ch := newNotifyTestServer(t)
	cat := projInsertCategory(t, st, "ThreshCat", "spending", "need")
	month := time.Now().UTC().Format("2006-01")
	if err := st.UpsertEnvelopeAssignment(month, cat, 100_00); err != nil {
		t.Fatal(err)
	}

	// First evaluation primes state silently.
	srv.EvaluateBudgetThresholds()
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("priming emitted %d events: %v", len(evs), evs)
	}

	// Spend to 90% → one envelope crossing at level 80.
	day := time.Now().UTC().Format("2006-01-02")
	projInsertTxn(t, st, cat, "debit", 90_00, day, "confirmed")
	srv.EvaluateBudgetThresholds()
	evs := eventsOfType(drainEvents(t, ch), "budget_threshold")
	if len(evs) != 1 {
		t.Fatalf("got %d budget_threshold events, want 1: %v", len(evs), evs)
	}
	data := evs[0]["data"].(map[string]any)
	if data["scope"] != "envelope" || data["level"] != float64(80) || data["name"] != "ThreshCat" {
		t.Fatalf("event data = %v", data)
	}

	// Re-evaluating at the same level stays silent.
	srv.EvaluateBudgetThresholds()
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("unchanged level re-emitted: %v", evs)
	}

	// Crossing 100% emits again.
	projInsertTxn(t, st, cat, "debit", 15_00, day, "confirmed")
	srv.EvaluateBudgetThresholds()
	evs = eventsOfType(drainEvents(t, ch), "budget_threshold")
	if len(evs) != 1 {
		t.Fatalf("100%% crossing: got %d events: %v", len(evs), evs)
	}
	if data := evs[0]["data"].(map[string]any); data["level"] != float64(100) {
		t.Fatalf("event data = %v", data)
	}

	// With thresholds off, nothing is evaluated or emitted.
	if err := st.UpdateNotifySettings(false, 3); err != nil {
		t.Fatal(err)
	}
	projInsertTxn(t, st, cat, "debit", 500_00, day, "confirmed")
	srv.EvaluateBudgetThresholds()
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("disabled setting still emitted: %v", evs)
	}
}

func TestCheckUpcomingBillsDedupAndGate(t *testing.T) {
	srv, st, ch := newNotifyTestServer(t)
	now := time.Now().UTC()
	due := now.AddDate(0, 0, 1).Format("2006-01-02")
	if _, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "du.ae", AmountFils: 300_00, IntervalDays: 30, NextDue: due,
	}); err != nil {
		t.Fatal(err)
	}

	// Default horizon is 3 days → due-tomorrow fires once.
	srv.CheckUpcomingBills(now)
	evs := eventsOfType(drainEvents(t, ch), "upcoming_bill")
	if len(evs) != 1 {
		t.Fatalf("got %d upcoming_bill events, want 1: %v", len(evs), evs)
	}
	data := evs[0]["data"].(map[string]any)
	if data["merchant"] != "du.ae" || data["due_in_days"] != float64(1) {
		t.Fatalf("event data = %v", data)
	}

	// Same (schedule, next_due) never re-fires.
	srv.CheckUpcomingBills(now)
	if evs := eventsOfType(drainEvents(t, ch), "upcoming_bill"); len(evs) != 0 {
		t.Fatalf("dedup failed: %v", evs)
	}

	// Horizon 0 disables entirely.
	if err := st.UpdateNotifySettings(true, 0); err != nil {
		t.Fatal(err)
	}
	srv.CheckUpcomingBills(now.AddDate(0, 0, 29))
	if evs := eventsOfType(drainEvents(t, ch), "upcoming_bill"); len(evs) != 0 {
		t.Fatalf("disabled horizon still emitted: %v", evs)
	}
}

func TestEmitScheduleEventsSSEAlwaysOn(t *testing.T) {
	srv, st, ch := newNotifyTestServer(t)
	// Even with all notify settings off, the SSE data channel stays live so
	// the UI can refresh its lists; only push is gated (no sender wired here).
	if err := st.UpdateNotifySettings(false, 0); err != nil {
		t.Fatal(err)
	}
	row := store.ScheduledTxnRow{
		ID: 7, NormalizedMerchant: "netflix.com", AmountFils: 39_00,
		IntervalDays: 30, NextDue: "2026-08-01", Direction: "debit",
		Source: "detected", Status: "proposed", Provenance: `{"count":6}`,
	}
	srv.EmitScheduleDetected(row)
	srv.EmitMissedBill(row)
	evs := drainEvents(t, ch)
	if len(eventsOfType(evs, "schedule_detected")) != 1 {
		t.Errorf("schedule_detected missing: %v", evs)
	}
	if len(eventsOfType(evs, "missed_bill")) != 1 {
		t.Errorf("missed_bill missing: %v", evs)
	}
	det := eventsOfType(evs, "schedule_detected")[0]["data"].(map[string]any)
	if prov, ok := det["provenance"].(map[string]any); !ok || prov["count"] != float64(6) {
		t.Errorf("provenance not passed through: %v", det)
	}
}

// TestEvaluateBudgetThresholdsMonthRollover: the dedup state is recorded per
// month. Comparing a new month's levels against LAST month's would swallow
// the new month's first crossing whenever the envelope ended the old month at
// an equal-or-higher level — the canonical case being a bill that is its
// envelope's whole budget (rent on the 1st): July ends at 100, August's first
// evaluation is triggered by the August rent insert itself, and 100 > 100
// never fires. The rollover must reset the baseline to zero (while staying
// primed).
func TestEvaluateBudgetThresholdsMonthRollover(t *testing.T) {
	srv, st, ch := newNotifyTestServer(t)
	cat := projInsertCategory(t, st, "RolloverCat", "spending", "need")
	month := time.Now().UTC().Format("2006-01")
	day := time.Now().UTC().Format("2006-01-02")
	if err := st.UpsertEnvelopeAssignment(month, cat, 100_00); err != nil {
		t.Fatal(err)
	}
	// The envelope sits at 100% and the state is primed there.
	projInsertTxn(t, st, cat, "debit", 100_00, day, "confirmed")
	srv.EvaluateBudgetThresholds()
	drainEvents(t, ch)
	srv.EvaluateBudgetThresholds()
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("same level re-fired: %v", evs)
	}

	// Simulate the month boundary on a long-running server: the recorded
	// levels belong to the PREVIOUS month. (Wall time can't be injected, so
	// the test moves the recorded month back instead of the clock forward —
	// the same divergence the first evaluation of a new month sees.)
	//
	// Anchor to the first of the month before stepping back. AddDate(0,-1,0)
	// on a 31st overflows into the month it started in — 2026-07-31 becomes
	// "June 31", which normalises to 2026-07-01 — so the month string would
	// be unchanged and the rollover never simulated. That made this test pass
	// every day except the 31st of July, October, December and March, where
	// it failed for a reason that had nothing to do with the code under test.
	srv.thresholdMu.Lock()
	now := time.Now().UTC()
	firstOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	srv.thresholdMonth = firstOfMonth.AddDate(0, -1, 0).Format("2006-01")
	srv.thresholdMu.Unlock()

	// First evaluation of the "new" month: same level 100 as the old month —
	// it must fire, because for THIS month it is a fresh upward crossing.
	srv.EvaluateBudgetThresholds()
	evs := eventsOfType(drainEvents(t, ch), "budget_threshold")
	if len(evs) != 1 {
		t.Fatalf("new month's first crossing: got %d events, want 1: %v", len(evs), evs)
	}
	if data := evs[0]["data"].(map[string]any); data["level"] != float64(100) || data["name"] != "RolloverCat" {
		t.Fatalf("event data = %v", data)
	}

	// And once per month still holds: no re-fire at the same level.
	srv.EvaluateBudgetThresholds()
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("re-fired after rollover crossing: %v", evs)
	}
}

// TestPutNotifySettingsPrimesThresholds: while notify_thresholds is off every
// evaluation returns before touching state, so turning it ON via the API must
// re-prime at then-current levels. Without that, the first mutation after
// enabling runs the unprimed transition and its crossing — exactly the one
// the user just asked to hear about — is silently recorded as baseline.
func TestPutNotifySettingsPrimesThresholds(t *testing.T) {
	srv, st, ch := newNotifyTestServer(t)
	cat := projInsertCategory(t, st, "PrimeCat", "spending", "need")
	month := time.Now().UTC().Format("2006-01")
	day := time.Now().UTC().Format("2006-01-02")
	if err := st.UpsertEnvelopeAssignment(month, cat, 100_00); err != nil {
		t.Fatal(err)
	}

	// Thresholds off; spending reaches 90% unheard, and unprimed.
	if err := st.UpdateNotifySettings(false, 3); err != nil {
		t.Fatal(err)
	}
	projInsertTxn(t, st, cat, "debit", 90_00, day, "confirmed")
	srv.EvaluateBudgetThresholds()
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("disabled setting emitted: %v", evs)
	}

	// Enable via the API: the handler primes silently at the current 80-level.
	w := doJSON(t, srv, "PUT", "/api/settings/notifications", map[string]any{
		"notify_thresholds": true, "notify_upcoming_days": 3,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT = %d; body: %s", w.Code, w.Body)
	}
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("the enable-PUT prime must be silent, got: %v", evs)
	}

	// The FIRST crossing after enabling must fire (the swallowed-crossing bug:
	// an unprimed state would record this 100 as baseline and emit nothing).
	projInsertTxn(t, st, cat, "debit", 15_00, day, "confirmed")
	srv.EvaluateBudgetThresholds()
	evs := eventsOfType(drainEvents(t, ch), "budget_threshold")
	if len(evs) != 1 {
		t.Fatalf("first crossing after enable: got %d events, want 1: %v", len(evs), evs)
	}
	if data := evs[0]["data"].(map[string]any); data["level"] != float64(100) {
		t.Fatalf("event data = %v", data)
	}
}

// TestManualEntryAndRestoreEvaluateThresholds: a categorized manual entry
// (POST /api/transactions) inserts directly as confirmed activity, and
// restoring an archived debit brings activity back — both must evaluate
// thresholds immediately, like confirm/categorize/split/assign, instead of
// leaving the crossing to fire on some later unrelated mutation.
func TestManualEntryAndRestoreEvaluateThresholds(t *testing.T) {
	srv, st, ch := newNotifyTestServer(t)
	srv.SetCategoryStore(st)
	cat := projInsertCategory(t, st, "ManualCat", "spending", "need")
	month := time.Now().UTC().Format("2006-01")
	day := time.Now().UTC().Format("2006-01-02")
	if err := st.UpsertEnvelopeAssignment(month, cat, 100_00); err != nil {
		t.Fatal(err)
	}
	srv.EvaluateBudgetThresholds() // prime at level 0
	drainEvents(t, ch)

	// Manual entry pushes the envelope to 90% → the 80 crossing fires NOW.
	w := doJSON(t, srv, "POST", "/api/transactions", map[string]any{
		"posted_at": day, "amount_fils": 90_00, "direction": "debit",
		"merchant_raw": "Manual Shop", "category_id": cat,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST = %d; body: %s", w.Code, w.Body)
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	evs := eventsOfType(drainEvents(t, ch), "budget_threshold")
	if len(evs) != 1 {
		t.Fatalf("manual entry crossing: got %d events, want 1: %v", len(evs), evs)
	}
	if data := evs[0]["data"].(map[string]any); data["level"] != float64(80) {
		t.Fatalf("event data = %v", data)
	}

	// Archive removes the activity (downward — silent, but the state follows).
	if w := doJSON(t, srv, "POST", "/api/transactions/"+itoa(created.ID)+"/archive", nil); w.Code != http.StatusOK {
		t.Fatalf("archive = %d", w.Code)
	}
	if evs := eventsOfType(drainEvents(t, ch), "budget_threshold"); len(evs) != 0 {
		t.Fatalf("downward move emitted: %v", evs)
	}

	// Restore re-crosses 80% → must fire again, immediately.
	if w := doJSON(t, srv, "POST", "/api/transactions/"+itoa(created.ID)+"/restore", nil); w.Code != http.StatusOK {
		t.Fatalf("restore = %d", w.Code)
	}
	evs = eventsOfType(drainEvents(t, ch), "budget_threshold")
	if len(evs) != 1 {
		t.Fatalf("restore crossing: got %d events, want 1: %v", len(evs), evs)
	}
	if data := evs[0]["data"].(map[string]any); data["level"] != float64(80) {
		t.Fatalf("event data = %v", data)
	}
}
