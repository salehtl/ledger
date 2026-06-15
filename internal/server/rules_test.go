package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"ledger/internal/store"
)

func TestRulesCRUD(t *testing.T) {
	srv, st := newTestServer(t)
	cat, _ := st.InsertCategory(store.CategoryRow{Name: "Groc2", Kind: "spending", Bucket: "need", IsActive: true})

	body := `{"match_type":"contains","pattern":"carrefour","category_id":` + strconv.FormatInt(cat, 10) + `,"priority":50}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/rules", strings.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/rules", nil))
	var rules []store.RuleRow
	json.Unmarshal(rec.Body.Bytes(), &rules)
	if len(rules) != 1 || rules[0].Pattern != "carrefour" {
		t.Fatalf("GET rules = %+v", rules)
	}

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/rules/"+strconv.FormatInt(rules[0].ID, 10), nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/rules", nil))
	json.Unmarshal(rec.Body.Bytes(), &rules)
	if len(rules) != 0 {
		t.Errorf("after delete: %+v", rules)
	}
}

func TestPostRuleRequiresFields(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/rules", strings.NewReader(`{"pattern":"x"}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

type stubRuleActive struct {
	id     int64
	active bool
	called bool
}

func (s *stubRuleActive) SetRuleActive(id int64, active bool) error {
	s.id, s.active, s.called = id, active, true
	return nil
}

func TestSetRuleActive(t *testing.T) {
	stub := &stubRuleActive{}
	srv := New(nil, fstest())
	srv.SetRuleActiveStore(stub)
	req := httptest.NewRequest("PUT", "/api/rules/7/active", strings.NewReader(`{"active":false}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	if !stub.called || stub.id != 7 || stub.active != false {
		t.Fatalf("stub got id=%d active=%v called=%v", stub.id, stub.active, stub.called)
	}
}

func TestSetRuleActiveUnset503(t *testing.T) {
	srv := New(nil, fstest())
	req := httptest.NewRequest("PUT", "/api/rules/7/active", strings.NewReader(`{"active":false}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("code=%d want 503", rec.Code)
	}
}

func TestSetRuleActiveBadID(t *testing.T) {
	stub := &stubRuleActive{}
	srv := New(nil, fstest())
	srv.SetRuleActiveStore(stub)
	req := httptest.NewRequest("PUT", "/api/rules/abc/active", strings.NewReader(`{"active":true}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code=%d want 400", rec.Code)
	}
}
