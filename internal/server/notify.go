// notify.go owns the v3 notification surface: the notification-preference
// endpoints, and the budget_threshold / upcoming_bill / missed_bill /
// schedule_detected SSE+push emitters that main.go wires next to the existing
// new_transaction and drift_alert triggers.
//
// Channel policy (documented in docs/v3/api-contract.md): state-change events
// the UI lists (schedule_detected, missed_bill) are always broadcast on SSE;
// push — the interrupting channel — is gated by the notify settings. Purely
// notification-shaped events (budget_threshold, upcoming_bill) are gated
// entirely: with the setting off they are not emitted at all.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"ledger/internal/budget"
	"ledger/internal/store"
)

// NotifyStore is the settings surface the notification endpoints and event
// gates need.
type NotifyStore interface {
	SelectAppSettings() (store.AppSettings, error)
	UpdateNotifySettings(thresholds bool, upcomingDays int) error
}

// SetNotifyStore wires the notification-settings store. Required for
// /api/settings/notifications and for gating the v3 events.
func (s *Server) SetNotifyStore(ns NotifyStore) { s.notifyStore = ns }

// notifySettingsDTO is the wire shape of GET/PUT /api/settings/notifications.
type notifySettingsDTO struct {
	NotifyThresholds   bool `json:"notify_thresholds"`
	NotifyUpcomingDays int  `json:"notify_upcoming_days"` // 0 = off
}

func (s *Server) handleGetNotifySettings(w http.ResponseWriter, r *http.Request) {
	if s.notifyStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "notifications unavailable")
		return
	}
	a, err := s.notifyStore.SelectAppSettings()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(notifySettingsDTO{
		NotifyThresholds:   a.NotifyThresholds,
		NotifyUpcomingDays: a.NotifyUpcomingDays,
	})
}

func (s *Server) handlePutNotifySettings(w http.ResponseWriter, r *http.Request) {
	if s.notifyStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "notifications unavailable")
		return
	}
	var dto notifySettingsDTO
	if err := json.NewDecoder(r.Body).Decode(&dto); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if dto.NotifyUpcomingDays < 0 || dto.NotifyUpcomingDays > 60 {
		errJSON(w, http.StatusBadRequest, "notify_upcoming_days must be 0..60")
		return
	}
	if err := s.notifyStore.UpdateNotifySettings(dto.NotifyThresholds, dto.NotifyUpcomingDays); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	if dto.NotifyThresholds {
		// Re-prime the threshold diff state at then-current levels, mirroring
		// the startup prime in main.go. While the setting was off every
		// evaluation returned before touching state, so without this the FIRST
		// mutation after enabling would run the unprimed transition and its
		// crossing — exactly the one the user just asked to hear about — would
		// be silently recorded as baseline. Resetting first also discards any
		// stale levels recorded before the setting was last turned off.
		s.thresholdMu.Lock()
		s.thresholdLevels = nil
		s.thresholdMonth = ""
		s.thresholdMu.Unlock()
		s.EvaluateBudgetThresholds()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(dto)
}

// notifySettings reads the current notify preferences; on any failure it fails
// quiet (no notifications) rather than spamming on a broken read.
func (s *Server) notifySettings() (store.AppSettings, bool) {
	if s.notifyStore == nil {
		return store.AppSettings{}, false
	}
	a, err := s.notifyStore.SelectAppSettings()
	if err != nil {
		return store.AppSettings{}, false
	}
	return a, true
}

// pushAll delivers one web-push payload to every subscription, asynchronously,
// best-effort — the same fire-and-forget the new_transaction path uses. No-op
// without a configured sender.
func (s *Server) pushAll(title, body string) {
	if s.pushSender == nil || s.pushStore == nil {
		return
	}
	subs, err := s.pushStore.SelectPushSubs()
	if err != nil {
		return
	}
	payload, err := json.Marshal(map[string]string{"title": title, "body": body})
	if err != nil {
		return
	}
	for _, sub := range subs {
		go func(p store.PushSubRow) {
			// Log failures. Discarding this error hid a 403 BadJwtToken that
			// made every push to an iPhone fail silently: the endpoint still
			// answered 204 and nothing appeared in the log, so a broken
			// delivery chain was indistinguishable from having nothing to say.
			if err := s.pushSender.Send(context.Background(), p.Endpoint, p.P256dh, p.Auth, payload); err != nil {
				log.Printf("push: send failed for %.40s...: %v", p.Endpoint, err)
			}
		}(sub)
	}
}

// filsAED renders int64 fils as a display string ("1,234.50" without the
// comma: "1234.50"). Pure integer math — display only, never computation.
func filsAED(fils int64) string {
	sign := ""
	if fils < 0 {
		sign = "-"
		fils = -fils
	}
	return fmt.Sprintf("%sAED %d.%02d", sign, fils/100, fils%100)
}

// scheduleDisplayName picks the human name for a schedule: label, else the
// normalized merchant.
func scheduleDisplayName(row store.ScheduledTxnRow) string {
	if row.Label != "" {
		return row.Label
	}
	return row.NormalizedMerchant
}

// EmitScheduleDetected broadcasts a schedule_detected event for a freshly
// mined recurring-bill proposal (recur.Runner OnDetected hook). SSE always;
// push only when upcoming-bill notifications are on.
func (s *Server) EmitScheduleDetected(row store.ScheduledTxnRow) {
	s.BroadcastEvent("schedule_detected", toScheduledDTO(row))
	if set, ok := s.notifySettings(); ok && set.NotifyUpcomingDays > 0 {
		s.pushAll("Recurring bill detected",
			fmt.Sprintf("%s ~%s every ~%d days — confirm or dismiss in Recurring",
				scheduleDisplayName(row), filsAED(row.AmountFils), row.IntervalDays))
	}
}

// EmitMissedBill broadcasts a missed_bill event for a schedule whose expected
// email never arrived (recur.Runner OnMissed hook). SSE always; push only when
// upcoming-bill notifications are on.
func (s *Server) EmitMissedBill(row store.ScheduledTxnRow) {
	s.BroadcastEvent("missed_bill", toScheduledDTO(row))
	if set, ok := s.notifySettings(); ok && set.NotifyUpcomingDays > 0 {
		s.pushAll("Bill may be missed",
			fmt.Sprintf("%s (~%s) was due %s and no matching email arrived",
				scheduleDisplayName(row), filsAED(row.AmountFils), row.NextDue))
	}
}

// EvaluateBudgetThresholds recomputes the current month's envelope summary and
// emits budget_threshold events for envelopes/buckets that newly crossed
// 80%/100%. Level state is tracked in memory and diffed so a category sitting
// at 90% doesn't re-fire on every confirm; the first evaluation after startup
// primes the state silently — which is why main.go calls this once at boot,
// so the nil→primed transition happens BEFORE any real mutation and a
// crossing caused by the first post-restart transaction is emitted rather
// than swallowed as baseline. Entirely gated by the notify_thresholds setting.
// Called after every mutation that can move envelope activity or limits
// (confirm, categorize, splits, assignments) and from the ingest insert hook.
func (s *Server) EvaluateBudgetThresholds() {
	if s.envelopeStore == nil {
		return
	}
	set, ok := s.notifySettings()
	if !ok || !set.NotifyThresholds {
		return
	}
	month := time.Now().UTC().Format("2006-01")
	sum, cfg, err := s.computeEnvelopeSummary(month)
	if err != nil {
		return
	}
	crossings := budget.CurrentThresholdLevels(sum, cfg)

	s.thresholdMu.Lock()
	prev := s.thresholdLevels
	if prev != nil && s.thresholdMonth != month {
		// Month rollover: the recorded levels are LAST month's, and comparing
		// against them would swallow the new month's first crossings whenever
		// an envelope ended the old month at an equal-or-higher level. The
		// canonical case is a bill that is its envelope's whole budget (rent
		// on the 1st): every month ends at 100, the first evaluation of the
		// new month is triggered by the new rent insert itself, and 100 > 100
		// never fires. Reset to an empty — but still primed — baseline so
		// new-month crossings compare against 0, keeping the contract's "once
		// per upward crossing per month".
		prev = map[string]int{}
	}
	s.thresholdMonth = month
	cur := make(map[string]int, len(crossings))
	var emit []budget.ThresholdCrossing
	for _, c := range crossings {
		cur[c.Key] = c.Level
		if prev != nil && c.Level > prev[c.Key] {
			emit = append(emit, c)
		}
	}
	s.thresholdLevels = cur
	s.thresholdMu.Unlock()

	for _, c := range emit {
		s.BroadcastEvent("budget_threshold", c)
		scope := c.Name
		if c.Scope == "bucket" {
			scope = c.Name + " bucket"
		}
		s.pushAll(fmt.Sprintf("Budget at %d%%", c.Level),
			fmt.Sprintf("%s: %s of %s spent this month", scope,
				filsAED(c.ActivityFils), filsAED(c.LimitFils)))
	}
}

// upcomingBillEvent is the SSE payload of one upcoming_bill emission.
type upcomingBillEvent struct {
	scheduledDTO
	DueInDays int64 `json:"due_in_days"`
}

// CheckUpcomingBills emits upcoming_bill events (SSE + push) for active
// schedules due within the notify_upcoming_days horizon. Deduplicated per
// (schedule, next_due) in memory: each occurrence notifies once, and a matched
// bill's advanced next_due re-arms it for the next cycle. main.go calls this
// on startup and on an hourly tick; notify_upcoming_days = 0 disables it
// entirely.
func (s *Server) CheckUpcomingBills(now time.Time) {
	if s.scheduledStore == nil {
		return
	}
	set, ok := s.notifySettings()
	if !ok || set.NotifyUpcomingDays <= 0 {
		return
	}
	rows, err := s.scheduledStore.SelectUpcoming(now, set.NotifyUpcomingDays)
	if err != nil {
		return
	}
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	for _, row := range rows {
		s.upcomingMu.Lock()
		if s.upcomingSent == nil {
			s.upcomingSent = make(map[int64]string)
		}
		if s.upcomingSent[row.ID] == row.NextDue {
			s.upcomingMu.Unlock()
			continue
		}
		s.upcomingSent[row.ID] = row.NextDue
		s.upcomingMu.Unlock()

		ev := upcomingBillEvent{scheduledDTO: toScheduledDTO(row)}
		if due, perr := time.Parse("2006-01-02", row.NextDue); perr == nil {
			ev.DueInDays = int64(due.Sub(today) / (24 * time.Hour))
		}
		s.BroadcastEvent("upcoming_bill", ev)
		when := "due " + row.NextDue
		if ev.DueInDays == 0 {
			when = "due today"
		} else if ev.DueInDays < 0 {
			when = "overdue since " + row.NextDue
		}
		s.pushAll("Upcoming bill",
			fmt.Sprintf("%s ~%s %s", scheduleDisplayName(row), filsAED(row.AmountFils), when))
	}
}

// threshold / upcoming dedup state lives on the Server so handlers, the ingest
// hook, and the notifier loop share one view.
type notifyState struct {
	thresholdMu     sync.Mutex
	thresholdLevels map[string]int // budget.ThresholdCrossing.Key → level; nil = unprimed
	thresholdMonth  string         // YYYY-MM the levels were recorded for; reset on rollover
	upcomingMu      sync.Mutex
	upcomingSent    map[int64]string // schedule id → next_due already notified
}
