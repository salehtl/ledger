package server

import (
	"encoding/json"
	"net/http"
	"time"

	"ledger/internal/store"
)

type healthResponse struct {
	Status string        `json:"status"`
	DB     string        `json:"db"`
	Ingest *ingestHealth `json:"ingest,omitempty"`
	Drift  []driftHealth `json:"drift,omitempty"`
}

type ingestHealth struct {
	Configured          bool          `json:"configured"`
	Count               int           `json:"count"`
	LastAt              string        `json:"last_at,omitempty"`
	Status              string        `json:"status"`
	Reasons             []string      `json:"reasons"`
	LastPollSuccessAt   string        `json:"last_poll_success_at,omitempty"`
	LastPollAttemptAt   string        `json:"last_poll_attempt_at,omitempty"`
	ConsecutiveFailures int           `json:"consecutive_failures"`
	LastError           string        `json:"last_error,omitempty"`
	PollIntervalSeconds int           `json:"poll_interval_seconds"`
	SilenceDays         int           `json:"silence_days"`
	Unread              *unreadHealth `json:"unread,omitempty"`
}

type unreadHealth struct {
	Transaction    int `json:"transaction"`
	NotTransaction int `json:"not_transaction"`
	Unchecked      int `json:"unchecked"`
	SetAside       int `json:"set_aside"`
}

// verdictCounter is optional: the store has it, test fakes need not.
type verdictCounter interface {
	UnparsedVerdictCounts() (store.VerdictCounts, error)
}

// The health handler finds the counts by a type assertion, which fails
// silently if the store's method changes. This makes that a build error.
var _ verdictCounter = (*store.Store)(nil)

type driftHealth struct {
	FromAddr    string  `json:"from_addr"`
	SuccessRate float64 `json:"success_rate"`
	Threshold   float64 `json:"threshold"`
	Alert       bool    `json:"alert"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", DB: "ok"}
	code := http.StatusOK
	if err := s.store.Ping(); err != nil {
		resp.Status = "degraded"
		resp.DB = "unreachable"
		code = http.StatusServiceUnavailable
	}
	if s.ingest != nil {
		ih := &ingestHealth{Configured: s.imapConfigured, Status: "off", Reasons: []string{}}
		if count, err := s.ingest.CountIngest(); err == nil {
			ih.Count = count
		}
		if vc, ok := s.ingest.(verdictCounter); ok {
			if v, err := vc.UnparsedVerdictCounts(); err == nil {
				ih.Unread = &unreadHealth{Transaction: v.Transaction, NotTransaction: v.NotTransaction,
					Unchecked: v.Unchecked, SetAside: v.SetAside}
			}
		}
		var lastMail time.Time
		haveMail := false
		if at, ok, err := s.ingest.LastIngestAt(); err == nil && ok {
			lastMail, haveMail = at, true
			ih.LastAt = at.UTC().Format(time.RFC3339)
		}
		if s.imapConfigured && s.ingestHealthFn != nil {
			snap := s.ingestHealthFn()
			silence := 3
			if s.settingsStore != nil {
				if a, err := s.settingsStore.SelectAppSettings(); err == nil && a.IngestSilenceDays >= 1 {
					silence = a.IngestSilenceDays
				}
			}
			ih.Status, ih.Reasons = deriveIngestStatus(snap, lastMail, haveMail, silence, time.Now().UTC())
			if !snap.LastSuccessAt.IsZero() {
				ih.LastPollSuccessAt = snap.LastSuccessAt.UTC().Format(time.RFC3339)
			}
			if !snap.LastAttemptAt.IsZero() {
				ih.LastPollAttemptAt = snap.LastAttemptAt.UTC().Format(time.RFC3339)
			}
			ih.ConsecutiveFailures = snap.ConsecutiveFailures
			ih.LastError = snap.LastError
			ih.PollIntervalSeconds = int(snap.Interval / time.Second)
			ih.SilenceDays = silence
		}
		resp.Ingest = ih
	}
	if s.driftMon != nil {
		for _, a := range s.driftMon.Alerts() {
			resp.Drift = append(resp.Drift, driftHealth{
				FromAddr:    a.FromAddr,
				SuccessRate: a.SuccessRate,
				Threshold:   a.Threshold,
				Alert:       true,
			})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}
