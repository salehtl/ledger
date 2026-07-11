package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"ledger/internal/ingest"
)

var t0 = time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC)

func snap(mod func(*ingest.HealthSnapshot)) ingest.HealthSnapshot {
	// Baseline: healthy worker, 60s interval, started an hour ago,
	// successful poll one minute ago.
	s := ingest.HealthSnapshot{
		StartedAt:     t0.Add(-time.Hour),
		LastAttemptAt: t0.Add(-time.Minute),
		LastSuccessAt: t0.Add(-time.Minute),
		Interval:      time.Minute,
	}
	if mod != nil {
		mod(&s)
	}
	return s
}

func TestDeriveIngestStatus(t *testing.T) {
	cases := []struct {
		name        string
		snap        ingest.HealthSnapshot
		lastMail    time.Time
		haveMail    bool
		silenceDays int
		wantStatus  string
		wantReasons []string
	}{
		{
			name: "healthy", snap: snap(nil),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "ok", wantReasons: []string{},
		},
		{
			name: "starting within grace",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.StartedAt = t0.Add(-time.Minute)
				s.LastAttemptAt = time.Time{}
				s.LastSuccessAt = time.Time{}
			}),
			haveMail: false, silenceDays: 3,
			wantStatus: "starting", wantReasons: []string{},
		},
		{
			name: "starting expired becomes poll_stale (hung first poll)",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.StartedAt = t0.Add(-time.Hour)
				s.LastAttemptAt = time.Time{}
				s.LastSuccessAt = time.Time{}
			}),
			haveMail: false, silenceDays: 3,
			wantStatus: "warn", wantReasons: []string{"poll_stale"},
		},
		{
			name: "polls failing after streak and 15m",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.ConsecutiveFailures = 3
				s.LastSuccessAt = t0.Add(-20 * time.Minute)
				s.LastAttemptAt = t0.Add(-time.Minute)
			}),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "warn", wantReasons: []string{"polls_failing", "poll_stale"},
		},
		{
			name: "failure streak with recent success is stale but not polls_failing",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.ConsecutiveFailures = 3
				s.LastSuccessAt = t0.Add(-10 * time.Minute)
			}),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			// 10m > 3×interval(=5m min window)? window = max(3m, 5m) = 5m → stale.
			wantStatus: "warn", wantReasons: []string{"poll_stale"},
		},
		{
			name: "two failures below streak threshold",
			snap: snap(func(s *ingest.HealthSnapshot) {
				s.ConsecutiveFailures = 2
				s.LastError = "dial: timeout"
			}),
			lastMail: t0.Add(-2 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "ok", wantReasons: []string{},
		},
		{
			name:     "mail silent",
			snap:     snap(nil),
			lastMail: t0.Add(-4 * 24 * time.Hour), haveMail: true, silenceDays: 3,
			wantStatus: "warn", wantReasons: []string{"mail_silent"},
		},
		{
			name:     "no mail ever does not fire mail_silent",
			snap:     snap(nil),
			haveMail: false, silenceDays: 3,
			wantStatus: "ok", wantReasons: []string{},
		},
		{
			name:     "custom silence threshold respected",
			snap:     snap(nil),
			lastMail: t0.Add(-4 * 24 * time.Hour), haveMail: true, silenceDays: 7,
			wantStatus: "ok", wantReasons: []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, reasons := deriveIngestStatus(tc.snap, tc.lastMail, tc.haveMail, tc.silenceDays, t0)
			if status != tc.wantStatus || !reflect.DeepEqual(reasons, tc.wantReasons) {
				t.Errorf("got (%s, %v), want (%s, %v)", status, reasons, tc.wantStatus, tc.wantReasons)
			}
		})
	}
}

func TestHealthEndpointReportsIngestStatus(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	// The endpoint derives status against real time.Now(), so the last-mail
	// time must be relative too — a fixed date rots into mail_silent.
	srv.SetIngest(fakeIngest{count: 9, last: time.Now().UTC().Add(-2 * time.Hour), ok: true}, true)
	srv.SetIngestHealth(func() ingest.HealthSnapshot {
		return ingest.HealthSnapshot{
			StartedAt:           time.Now().UTC().Add(-time.Hour),
			LastAttemptAt:       time.Now().UTC().Add(-30 * time.Second),
			LastSuccessAt:       time.Now().UTC().Add(-30 * time.Second),
			ConsecutiveFailures: 0,
			Interval:            time.Minute,
		}
	})

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	var body struct {
		Ingest *struct {
			Status              string   `json:"status"`
			Reasons             []string `json:"reasons"`
			LastPollSuccessAt   string   `json:"last_poll_success_at"`
			ConsecutiveFailures int      `json:"consecutive_failures"`
			PollIntervalSeconds int      `json:"poll_interval_seconds"`
			SilenceDays         int      `json:"silence_days"`
		} `json:"ingest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Ingest == nil {
		t.Fatal("expected ingest section")
	}
	if body.Ingest.Status != "ok" {
		t.Errorf("status = %q, want ok (body=%s)", body.Ingest.Status, rec.Body.String())
	}
	if body.Ingest.Reasons == nil {
		t.Error("reasons must be [] not null")
	}
	if body.Ingest.LastPollSuccessAt == "" {
		t.Error("last_poll_success_at missing")
	}
	if body.Ingest.PollIntervalSeconds != 60 {
		t.Errorf("poll_interval_seconds = %d, want 60", body.Ingest.PollIntervalSeconds)
	}
	if body.Ingest.SilenceDays != 3 {
		t.Errorf("silence_days = %d, want default 3 (no settings store wired)", body.Ingest.SilenceDays)
	}
}

func TestHealthEndpointOffWhenNotConfigured(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	srv.SetIngest(fakeIngest{count: 0}, false)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	var body struct {
		Ingest *struct {
			Status string `json:"status"`
		} `json:"ingest"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Ingest == nil || body.Ingest.Status != "off" {
		t.Fatalf("want ingest.status=off, body=%s", rec.Body.String())
	}
}
