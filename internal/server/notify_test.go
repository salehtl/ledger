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
