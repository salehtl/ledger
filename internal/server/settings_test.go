// internal/server/settings_test.go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ledger/internal/store"
)

type stubSettings struct{ s store.AppSettings }

func (st *stubSettings) SelectAppSettings() (store.AppSettings, error) { return st.s, nil }
func (st *stubSettings) UpdateAppSettings(a store.AppSettings) error   { st.s = a; return nil }

func TestGetSettings(t *testing.T) {
	srv := New(nil, fstest()) // mirror existing server-test construction
	srv.SetSettingsStore(&stubSettings{s: store.AppSettings{AutoCategorize: true, AIThreshold: 0.85}})
	req := httptest.NewRequest("GET", "/api/settings", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d", rec.Code)
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["auto_categorize"] != true {
		t.Fatalf("body=%s", rec.Body.String())
	}
}

func TestPutSettings(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AutoCategorize: true}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)
	body := `{"auto_categorize":false,"ai_enabled":true,"ai_auto_accept":false,"ai_threshold":0.9}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.AutoCategorize || !stub.s.AIEnabled || stub.s.AIAutoAccept || stub.s.AIThreshold != 0.9 {
		t.Fatalf("stored wrong: %+v", stub.s)
	}
}

func TestSettingsUnset503(t *testing.T) {
	srv := New(nil, fstest())
	req := httptest.NewRequest("GET", "/api/settings", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d want 503", rec.Code)
	}
}
