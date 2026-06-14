package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetCategories(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/categories", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var cats []map[string]any
	if err := json.NewDecoder(w.Body).Decode(&cats); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(cats) == 0 {
		t.Error("expected seeded categories in response")
	}
}

func TestPostCategory(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{
		"name":   "Hobbies",
		"kind":   "spending",
		"bucket": "want",
	})
	r := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["id"] == nil {
		t.Error("expected id in response")
	}
}

func TestPostCategoryMissingKind(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{"name": "Foo"})
	r := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestPostCategorySpendingMissingBucket(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{"name": "Foo", "kind": "spending"})
	r := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 (spending needs bucket)", w.Code)
	}
}
