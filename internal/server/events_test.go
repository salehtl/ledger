package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHub_BroadcastReachesSubscriber(t *testing.T) {
	hub := NewHub()
	ch, unsub := hub.Subscribe()
	defer unsub()

	hub.BroadcastEvent("test_event", map[string]any{"key": "value"})

	select {
	case data := <-ch:
		if !strings.Contains(string(data), "test_event") {
			t.Errorf("broadcast data = %q, want to contain 'test_event'", data)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("timed out waiting for broadcast")
	}
}

func TestHub_SlowClientDropped(t *testing.T) {
	hub := NewHub()
	_, unsub := hub.Subscribe()
	defer unsub()
	// Overfill without reading — should not block
	for i := 0; i < 20; i++ {
		hub.BroadcastEvent("event", nil)
	}
	// If we get here without blocking, the test passes
}

func TestHandleEvents_SetsSSEContentType(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	hub := NewHub()
	srv.SetHub(hub)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	ct := w.Header().Get("Content-Type")
	if ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}
}

func TestHandleEvents_SendsHeartbeat(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	hub := NewHub()
	srv.SetHub(hub)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	body := w.Body.String()
	if !strings.Contains(body, "heartbeat") {
		t.Errorf("SSE body = %q, expected heartbeat event", body)
	}
}
