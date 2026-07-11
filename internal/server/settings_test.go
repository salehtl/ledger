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
	if got["ai_key_present"] != false {
		t.Fatalf("ai_key_present should default false: body=%s", rec.Body.String())
	}
}

func TestGetSettingsReportsAIKeyPresent(t *testing.T) {
	srv := New(nil, fstest())
	srv.SetSettingsStore(&stubSettings{s: store.AppSettings{AIThreshold: 0.85}})
	srv.SetAIKeyPresent(true)
	req := httptest.NewRequest("GET", "/api/settings", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["ai_key_present"] != true {
		t.Fatalf("ai_key_present=true expected, body=%s", rec.Body.String())
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

func TestPutSettingsClampsThreshold(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)
	body := `{"auto_categorize":false,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":2.0}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.AIThreshold != 0.85 {
		t.Fatalf("AIThreshold=%v, want 0.85 (clamped)", stub.s.AIThreshold)
	}
}

func TestPutSettingsBadJSON(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader("not json"))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d want 400", rec.Code)
	}
}

func TestSettingsIngestSilenceDaysRoundTrip(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85, IngestSilenceDays: 3}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	body := `{"auto_categorize":true,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85,"ingest_silence_days":7}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.IngestSilenceDays != 7 {
		t.Fatalf("IngestSilenceDays=%d, want 7", stub.s.IngestSilenceDays)
	}

	req = httptest.NewRequest("GET", "/api/settings", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["ingest_silence_days"] != float64(7) {
		t.Fatalf("GET ingest_silence_days=%v, want 7: %s", got["ingest_silence_days"], rec.Body.String())
	}
}

// The spend-cap field round-trips through PUT/GET.
func TestSettingsSpendCapRoundTrip(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	body := `{"auto_categorize":true,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85,"ai_spend_cap_musd":50000}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.SpendCapMuUSD != 50000 {
		t.Fatalf("SpendCapMuUSD=%d, want 50000", stub.s.SpendCapMuUSD)
	}

	req = httptest.NewRequest("GET", "/api/settings", nil)
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["ai_spend_cap_musd"] != float64(50000) {
		t.Fatalf("GET ai_spend_cap_musd=%v, want 50000: %s", got["ai_spend_cap_musd"], rec.Body.String())
	}
}

// ai_cap_latched is read-only output: GET reports whatever the store holds,
// but the PUT handler never forwards a client-sent value for it — the store
// is the sole authority (it sets the latch itself when the spend cap trips,
// via a path this handler never touches).
func TestSettingsCapLatchedReadOnlyOnGET(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85, CapLatched: true}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	req := httptest.NewRequest("GET", "/api/settings", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["ai_cap_latched"] != true {
		t.Fatalf("GET ai_cap_latched=%v, want true: %s", got["ai_cap_latched"], rec.Body.String())
	}
}

// A client cannot force the latch true by including ai_cap_latched:true in
// the PUT body — the handler must not read that field into the store write.
func TestSettingsCapLatchedNotSettableByClient(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85, CapLatched: false}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	body := `{"auto_categorize":true,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85,"ai_cap_latched":true}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.CapLatched {
		t.Fatalf("client-sent ai_cap_latched:true must not be forwarded to the store")
	}
}

// A PUT that omits ingest_silence_days (older client) must not clobber the
// stored value back to the default.
func TestPutSettingsOmittedSilenceDaysPreserved(t *testing.T) {
	stub := &stubSettings{s: store.AppSettings{AIThreshold: 0.85, IngestSilenceDays: 7}}
	srv := New(nil, fstest())
	srv.SetSettingsStore(stub)

	body := `{"auto_categorize":true,"ai_enabled":false,"ai_auto_accept":false,"ai_threshold":0.85}`
	req := httptest.NewRequest("PUT", "/api/settings", strings.NewReader(body))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if stub.s.IngestSilenceDays != 7 {
		t.Fatalf("IngestSilenceDays=%d, want preserved 7", stub.s.IngestSilenceDays)
	}
}
