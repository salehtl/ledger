package ingest

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestHealthBeforeFirstPoll(t *testing.T) {
	w := New(&fakeDialer{mb: mailboxWith(1)}, newTestStore(t), time.Minute, quietLogger())
	h := w.Health()
	if !h.LastAttemptAt.IsZero() || !h.LastSuccessAt.IsZero() {
		t.Errorf("expected zero attempt/success before first poll, got %+v", h)
	}
	if h.StartedAt.IsZero() {
		t.Error("StartedAt should be set at construction")
	}
	if h.Interval != time.Minute {
		t.Errorf("Interval = %s, want 1m", h.Interval)
	}
}

func TestHealthRecordsSuccessFailureAndRecovery(t *testing.T) {
	d := &fakeDialer{mb: mailboxWith(1, msg(100, "a@bank.com"))}
	w := New(d, newTestStore(t), time.Minute, quietLogger())
	w.now = func() time.Time { return time.Date(2026, 7, 5, 10, 0, 0, 0, time.UTC) }

	if _, err := w.pollOnce(context.Background()); err != nil {
		t.Fatalf("pollOnce: %v", err)
	}
	h := w.Health()
	if h.LastSuccessAt.IsZero() || h.ConsecutiveFailures != 0 || h.LastError != "" {
		t.Errorf("after success: %+v", h)
	}
	firstSuccess := h.LastSuccessAt

	d.dialErr = errors.New("imap login failed")
	w.pollOnce(context.Background())
	w.pollOnce(context.Background())
	h = w.Health()
	if h.ConsecutiveFailures != 2 {
		t.Errorf("failures = %d, want 2", h.ConsecutiveFailures)
	}
	if !strings.Contains(h.LastError, "imap login failed") {
		t.Errorf("LastError = %q, want dial error", h.LastError)
	}
	if !h.LastSuccessAt.Equal(firstSuccess) {
		t.Errorf("LastSuccessAt moved on failure: %s", h.LastSuccessAt)
	}

	d.dialErr = nil
	w.pollOnce(context.Background())
	h = w.Health()
	if h.ConsecutiveFailures != 0 || h.LastError != "" {
		t.Errorf("after recovery: %+v", h)
	}
}

func TestHealthIgnoresCancelledContext(t *testing.T) {
	w := New(&fakeDialer{mb: mailboxWith(1)}, newTestStore(t), time.Minute, quietLogger())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w.pollOnce(ctx)
	if h := w.Health(); !h.LastAttemptAt.IsZero() {
		t.Errorf("cancelled poll must not be recorded as a failure: %+v", h)
	}
}
