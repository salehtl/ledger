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
