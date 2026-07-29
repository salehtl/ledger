package server

import (
	"encoding/json"
	"net/http"
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
		"target_type": "set_aside", "amount_fils": 50_000, "cadence": "monthly",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body: %s", w.Code, w.Body)
	}
	var dto struct {
		CategoryID int64  `json:"category_id"`
		TargetType string `json:"target_type"`
		AmountFils int64  `json:"amount_fils"`
		Cadence    string `json:"cadence"`
	}
	json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.CategoryID != catID || dto.TargetType != "set_aside" || dto.AmountFils != 50_000 || dto.Cadence != "monthly" {
		t.Fatalf("PUT dto = %+v", dto)
	}

	// Single get.
	w = doJSON(t, srv, "GET", "/api/targets/"+itoa(catID), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET one status = %d", w.Code)
	}

	// List.
	w = doJSON(t, srv, "GET", "/api/targets", nil)
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
		"target_type": "save_by_date", "amount_fils": 120_000, "due_date": "2026-12-01",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("overwrite status = %d; body: %s", w.Code, w.Body)
	}

	// Delete, then 404.
	w = doJSON(t, srv, "DELETE", "/api/targets/"+itoa(catID), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", w.Code)
	}
	w = doJSON(t, srv, "GET", "/api/targets/"+itoa(catID), nil)
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
		{"bad type", "/api/targets/" + itoa(catID), map[string]any{"target_type": "wat", "amount_fils": 100}},
		{"zero amount", "/api/targets/" + itoa(catID), map[string]any{"target_type": "refill", "amount_fils": 0}},
		{"bad cadence", "/api/targets/" + itoa(catID), map[string]any{"target_type": "refill", "amount_fils": 100, "cadence": "daily"}},
		{"save_by_date without due_date", "/api/targets/" + itoa(catID), map[string]any{"target_type": "save_by_date", "amount_fils": 100}},
		{"unknown category", "/api/targets/424242", map[string]any{"target_type": "refill", "amount_fils": 100}},
		{"non-numeric id", "/api/targets/abc", map[string]any{"target_type": "refill", "amount_fils": 100}},
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
