package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

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
