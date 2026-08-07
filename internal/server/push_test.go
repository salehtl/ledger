package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"ledger/internal/store"
)

func TestHandlePushSubscribe_StoresSubscription(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	body, _ := json.Marshal(map[string]any{
		"endpoint": "https://push.example.com/test",
		"keys": map[string]string{
			"p256dh": "fake_p256dh_key",
			"auth":   "fake_auth_key",
		},
	})
	req := httptest.NewRequest("POST", "/api/push/subscribe", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204; body: %s", w.Code, w.Body)
	}

	subs, _ := st.SelectPushSubs()
	if len(subs) != 1 {
		t.Errorf("got %d subs in DB, want 1", len(subs))
	}
}

func TestHandlePushSubscribe_MissingField_Returns400(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	body, _ := json.Marshal(map[string]any{"endpoint": ""})
	req := httptest.NewRequest("POST", "/api/push/subscribe", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestHandlePushUnsubscribe_RemovesSub(t *testing.T) {
	st := newTestServerStore(t)
	_ = st.InsertPushSub(store.PushSubRow{
		Endpoint: "https://push.example.com/del",
		P256dh:   "k",
		Auth:     "a",
	})
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	body, _ := json.Marshal(map[string]string{"endpoint": "https://push.example.com/del"})
	req := httptest.NewRequest("DELETE", "/api/push/subscribe", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
	subs, _ := st.SelectPushSubs()
	if len(subs) != 0 {
		t.Errorf("got %d subs after delete, want 0", len(subs))
	}
}

// fakeSender records what pushAll handed it instead of hitting a push service.
type fakeSender struct {
	mu       sync.Mutex
	payloads []string
	endpoint []string
}

func (f *fakeSender) PublicKey() string { return "fake_public_key" }
func (f *fakeSender) Send(_ context.Context, endpoint, _, _ string, payload []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.endpoint = append(f.endpoint, endpoint)
	f.payloads = append(f.payloads, string(payload))
	return nil
}

func (f *fakeSender) wait(t *testing.T, want int) {
	t.Helper()
	// pushAll fans out in goroutines; poll rather than sleep a fixed span.
	for i := 0; i < 200; i++ {
		f.mu.Lock()
		n := len(f.payloads)
		f.mu.Unlock()
		if n >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d payload(s)", want)
}

// The test push is the only way to prove the chain reaches the phone: every
// other trigger needs a real budget threshold or a due bill.
func TestHandlePushTest_SendsToEverySubscription(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	f := &fakeSender{}
	srv.SetPushSender(f)

	for _, e := range []string{"https://push.example.com/a", "https://push.example.com/b"} {
		if err := st.InsertPushSub(store.PushSubRow{Endpoint: e, P256dh: "p", Auth: "a"}); err != nil {
			t.Fatal(err)
		}
	}

	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/push/test", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204; body: %s", w.Code, w.Body)
	}

	f.wait(t, 2)
	var got map[string]string
	if err := json.Unmarshal([]byte(f.payloads[0]), &got); err != nil {
		t.Fatalf("payload is not the {title,body} shape push-sw.js expects: %v", err)
	}
	if got["title"] == "" || got["body"] == "" {
		t.Errorf("payload = %#v, want non-empty title and body", got)
	}
	if len(f.endpoint) != 2 {
		t.Errorf("delivered to %d endpoints, want 2", len(f.endpoint))
	}
}

func TestHandlePushTest_WithoutSenderReturns503(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)

	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/push/test", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 when VAPID is unconfigured", w.Code)
	}
}
