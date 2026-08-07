package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"ledger/internal/store"
)

func newTargetsTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := New(st, testFS())
	srv.SetTargetsStore(st)
	return srv, st
}

func TestTargetsCRUD(t *testing.T) {
	srv, st := newTargetsTestServer(t)
	catID := projInsertCategory(t, st, "TargetCat", "spending", "need")

	// Upsert.
	w := doJSON(t, srv, "PUT", "/api/targets/"+itoa(catID), map[string]any{
		"month": "2026-07", "target_type": "set_aside", "amount_fils": 50_000, "cadence": "monthly",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body: %s", w.Code, w.Body)
	}
	var dto struct {
		CategoryID     int64  `json:"category_id"`
		EffectiveMonth string `json:"effective_month"`
		TargetType     string `json:"target_type"`
		AmountFils     int64  `json:"amount_fils"`
		Cadence        string `json:"cadence"`
	}
	json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.CategoryID != catID || dto.EffectiveMonth != "2026-07" || dto.TargetType != "set_aside" || dto.AmountFils != 50_000 || dto.Cadence != "monthly" {
		t.Fatalf("PUT dto = %+v", dto)
	}

	// Single get.
	w = doJSON(t, srv, "GET", "/api/targets/"+itoa(catID)+"?month=2026-07", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET one status = %d", w.Code)
	}

	// List.
	w = doJSON(t, srv, "GET", "/api/targets?month=2026-07", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET list status = %d", w.Code)
	}
	var list []json.RawMessage
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 {
		t.Fatalf("list has %d targets, want 1", len(list))
	}

	// Overwrite with a save_by_date target.
	w = doJSON(t, srv, "PUT", "/api/targets/"+itoa(catID), map[string]any{
		"month": "2026-07", "target_type": "save_by_date", "amount_fils": 120_000, "due_date": "2026-12-01",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("overwrite status = %d; body: %s", w.Code, w.Body)
	}

	// Delete, then 404.
	w = doJSON(t, srv, "DELETE", "/api/targets/"+itoa(catID)+"?month=2026-07", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", w.Code)
	}
	w = doJSON(t, srv, "GET", "/api/targets/"+itoa(catID)+"?month=2026-07", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET after delete status = %d, want 404", w.Code)
	}
}

func TestPutTargetValidation(t *testing.T) {
	srv, st := newTargetsTestServer(t)
	catID := projInsertCategory(t, st, "TargetCat", "spending", "need")

	tests := []struct {
		name string
		path string
		body map[string]any
	}{
		{"bad type", "/api/targets/" + itoa(catID), map[string]any{"month": "2026-07", "target_type": "wat", "amount_fils": 100}},
		{"zero amount", "/api/targets/" + itoa(catID), map[string]any{"month": "2026-07", "target_type": "refill", "amount_fils": 0}},
		{"bad cadence", "/api/targets/" + itoa(catID), map[string]any{"month": "2026-07", "target_type": "refill", "amount_fils": 100, "cadence": "daily"}},
		{"save_by_date without due_date", "/api/targets/" + itoa(catID), map[string]any{"month": "2026-07", "target_type": "save_by_date", "amount_fils": 100}},
		{"unknown category", "/api/targets/424242", map[string]any{"month": "2026-07", "target_type": "refill", "amount_fils": 100}},
		{"non-numeric id", "/api/targets/abc", map[string]any{"month": "2026-07", "target_type": "refill", "amount_fils": 100}},
		{"missing month", "/api/targets/" + itoa(catID), map[string]any{"target_type": "refill", "amount_fils": 100}},
		{"bad month", "/api/targets/" + itoa(catID), map[string]any{"month": "2026-13", "target_type": "refill", "amount_fils": 100}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := doJSON(t, srv, "PUT", tc.path, tc.body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body)
			}
		})
	}
}

func TestTargetsUnavailableWithoutStore(t *testing.T) {
	srv := New(fakeChecker{}, testFS())
	w := doJSON(t, srv, "GET", "/api/targets", nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func seedServerCategory(t *testing.T, st *store.Store, name string) int64 {
	t.Helper()
	res, err := st.DB.Exec(`INSERT INTO categories (name, kind, bucket) VALUES (?, 'spending', 'need')`, name)
	if err != nil {
		// Fresh test stores seed default categories; a name collision here
		// (e.g. "Groceries") means the category already exists — reuse it.
		var id int64
		if qerr := st.DB.QueryRow(`SELECT id FROM categories WHERE name = ?`, name).Scan(&id); qerr == nil {
			return id
		}
		t.Fatal(err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// putTargetAt PUTs a target effective from month and returns the response code.
func putTargetAt(t *testing.T, srv *Server, catID int64, month string, amount int64) int {
	t.Helper()
	body, _ := json.Marshal(map[string]any{
		"month": month, "target_type": "set_aside", "amount_fils": amount, "cadence": "monthly",
	})
	r := httptest.NewRequest("PUT", fmt.Sprintf("/api/targets/%d", catID), bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	return w.Code
}

// getTargetsAt returns the resolved target list for month.
func getTargetsAt(t *testing.T, srv *Server, month string) []map[string]any {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/targets?month="+month, nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/targets?month=%s = %d; body: %s", month, w.Code, w.Body)
	}
	var out []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestTargets_EditIsScopedForward(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if code := putTargetAt(t, srv, cat, "2026-07", 150000); code != http.StatusOK {
		t.Fatalf("PUT July = %d", code)
	}
	if code := putTargetAt(t, srv, cat, "2026-08", 200000); code != http.StatusOK {
		t.Fatalf("PUT August = %d", code)
	}

	jul := getTargetsAt(t, srv, "2026-07")
	if len(jul) != 1 || jul[0]["amount_fils"].(float64) != 150000 {
		t.Errorf("July = %+v, want a single 150000 target (an August edit changed July)", jul)
	}
	aug := getTargetsAt(t, srv, "2026-08")
	if len(aug) != 1 || aug[0]["amount_fils"].(float64) != 200000 {
		t.Errorf("August = %+v, want a single 200000 target", aug)
	}
	sep := getTargetsAt(t, srv, "2026-09")
	if len(sep) != 1 || sep[0]["amount_fils"].(float64) != 200000 {
		t.Errorf("September = %+v, want August's 200000 carried forward", sep)
	}
}

func TestTargets_DeleteIsScopedForward(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")
	putTargetAt(t, srv, cat, "2026-07", 150000)

	r := httptest.NewRequest("DELETE", fmt.Sprintf("/api/targets/%d?month=2026-08", cat), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE = %d; body: %s", w.Code, w.Body)
	}

	if got := getTargetsAt(t, srv, "2026-07"); len(got) != 1 {
		t.Errorf("July lost its target to an August removal: %+v", got)
	}
	if got := getTargetsAt(t, srv, "2026-08"); len(got) != 0 {
		t.Errorf("August still has a target: %+v", got)
	}
	if got := getTargetsAt(t, srv, "2026-12"); len(got) != 0 {
		t.Errorf("December still has a target — tombstone did not carry: %+v", got)
	}
}

func TestTargets_MonthIsRequired(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	for _, tc := range []struct{ method, url string }{
		{"GET", "/api/targets"},
		{"GET", fmt.Sprintf("/api/targets/%d", cat)},
		{"DELETE", fmt.Sprintf("/api/targets/%d", cat)},
	} {
		r := httptest.NewRequest(tc.method, tc.url, nil)
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s %s = %d, want 400", tc.method, tc.url, w.Code)
		}
	}

	body, _ := json.Marshal(map[string]any{"target_type": "set_aside", "amount_fils": 1000})
	r := httptest.NewRequest("PUT", fmt.Sprintf("/api/targets/%d", cat), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("PUT without month = %d, want 400", w.Code)
	}
}

func TestTargets_ResponseCarriesEffectiveMonth(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTargetsStore(st)
	cat := seedServerCategory(t, st, "Groceries")
	putTargetAt(t, srv, cat, "2026-07", 150000)

	got := getTargetsAt(t, srv, "2026-09")
	if len(got) != 1 {
		t.Fatalf("got %+v", got)
	}
	// September inherits July's version; the client shows where it came from.
	if got[0]["effective_month"] != "2026-07" {
		t.Errorf("effective_month = %v, want 2026-07", got[0]["effective_month"])
	}
}
