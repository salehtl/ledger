package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"ledger/internal/push"
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
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var resp struct {
		Devices int `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Devices != 2 {
		t.Errorf("body = %s (err %v), want devices 2", w.Body, err)
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

// goneSender rejects every send as a permanently dead subscription.
type goneSender struct {
	mu    sync.Mutex
	calls int
}

func (g *goneSender) PublicKey() string { return "fake_public_key" }
func (g *goneSender) Send(_ context.Context, endpoint, _, _ string, _ []byte) error {
	g.mu.Lock()
	g.calls++
	g.mu.Unlock()
	return fmt.Errorf("push service returned 410 for %s: %w", endpoint, push.ErrSubscriptionGone)
}

// failSender fails every send for a reason that is NOT the subscription's fault.
type failSender struct{}

func (failSender) PublicKey() string { return "fake_public_key" }
func (failSender) Send(_ context.Context, endpoint, _, _ string, _ []byte) error {
	return fmt.Errorf("push service returned 403 for %s", endpoint)
}

func seedSubs(t *testing.T, st *store.Store, endpoints ...string) {
	t.Helper()
	for _, e := range endpoints {
		if err := st.InsertPushSub(store.PushSubRow{Endpoint: e, P256dh: "p", Auth: "a"}); err != nil {
			t.Fatal(err)
		}
	}
}

func subCount(t *testing.T, st *store.Store) int {
	t.Helper()
	subs, err := st.SelectPushSubs()
	if err != nil {
		t.Fatal(err)
	}
	return len(subs)
}

// A device that reinstalled the PWA answers 410 forever. Without pruning it
// stays in the table and is retried on every single push.
func TestPushAll_PrunesGoneSubscriptions(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	srv.SetPushSender(&goneSender{})
	seedSubs(t, st, "https://push.example.com/dead1", "https://push.example.com/dead2")

	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/push/test", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	for i := 0; i < 200; i++ {
		if subCount(t, st) == 0 {
			// The prune must also remember the endpoints, or the phone's
			// next re-sync brings a dead subscription straight back.
			for _, ep := range []string{"https://push.example.com/dead1", "https://push.example.com/dead2"} {
				if gone, err := st.PushSubGone(ep); err != nil || !gone {
					t.Errorf("%s: gone=%v err=%v, want true nil", ep, gone, err)
				}
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("gone subscriptions were not pruned: %d remain", subCount(t, st))
}

// A 403 means OUR credentials are wrong while the subscriptions are fine.
// Pruning on it would delete every device the first time the keys drift.
func TestPushAll_KeepsSubscriptionsOnNonGoneFailure(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	srv.SetPushSender(failSender{})
	seedSubs(t, st, "https://push.example.com/alive")

	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/push/test", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	time.Sleep(200 * time.Millisecond)
	if n := subCount(t, st); n != 1 {
		t.Errorf("subscriptions = %d, want 1 kept: a 403 must never prune", n)
	}
}

func postSubscribe(t *testing.T, srv *Server, endpoint string, resync bool) int {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"endpoint": endpoint,
		"keys":     map[string]string{"p256dh": "p", "auth": "a"},
		"resync":   resync,
	})
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/push/subscribe", bytes.NewReader(body)))
	return w.Code
}

// The PWA re-sends its subscription on every open, so a server that lost the
// row (pruned, restored from backup) gets it back without a tap.
func TestHandlePushSubscribe_ResyncRestoresLiveEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	if code := postSubscribe(t, srv, "https://push.example.com/live", true); code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", code)
	}
	if n := subCount(t, st); n != 1 {
		t.Errorf("subscriptions = %d, want 1", n)
	}
}

// A dead endpoint the phone still holds must not come back through a re-sync:
// Settings would show "Enabled" while nothing can ever arrive. 410 tells the
// app to drop it, so Settings offers "Enable on this device" again.
func TestHandlePushSubscribe_ResyncOfGoneEndpointReturns410(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	const ep = "https://push.example.com/dead"
	seedSubs(t, st, ep)
	if err := st.PrunePushSub(ep); err != nil {
		t.Fatal(err)
	}
	if code := postSubscribe(t, srv, ep, true); code != http.StatusGone {
		t.Fatalf("status = %d, want 410", code)
	}
	if n := subCount(t, st); n != 0 {
		t.Errorf("subscriptions = %d, want 0", n)
	}
}

// Tapping Enable is explicit and always registers, even an endpoint once gone.
func TestHandlePushSubscribe_ExplicitRegistersGoneEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	const ep = "https://push.example.com/again"
	seedSubs(t, st, ep)
	if err := st.PrunePushSub(ep); err != nil {
		t.Fatal(err)
	}
	if code := postSubscribe(t, srv, ep, false); code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", code)
	}
	if n := subCount(t, st); n != 1 {
		t.Errorf("subscriptions = %d, want 1", n)
	}
}

// With no device registered the test push reaches nobody. The response must
// say so, so the app does not report "sent".
func TestHandlePushTest_ReportsZeroDevices(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetPushStore(st)
	srv.SetPushSender(&fakeSender{})

	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/push/test", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Devices *int `json:"devices"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || resp.Devices == nil || *resp.Devices != 0 {
		t.Errorf("body = %s (err %v), want devices 0", w.Body, err)
	}
}
