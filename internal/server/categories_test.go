package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"ledger/internal/store"
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

func TestPutCategory(t *testing.T) {
	srv, st := newTestServer(t)
	id, _ := st.InsertCategory(store.CategoryRow{Name: "Coffee", Kind: "spending", Bucket: "want", IsActive: true})
	body := `{"name":"Coffee","kind":"spending","bucket":"need","apply_to_past":true}`
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/categories/"+strconv.FormatInt(id, 10), strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	cats, _ := st.SelectCategories()
	for _, c := range cats {
		if c.ID == id && c.Bucket != "need" {
			t.Errorf("bucket = %q, want need", c.Bucket)
		}
	}
}

func TestPutCategoryRejectsSpendingWithoutBucket(t *testing.T) {
	srv, st := newTestServer(t)
	id, _ := st.InsertCategory(store.CategoryRow{Name: "Z", Kind: "spending", Bucket: "want", IsActive: true})
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/categories/"+strconv.FormatInt(id, 10), strings.NewReader(`{"name":"Z","kind":"spending","bucket":""}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestGetCategoryUsage(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}

	r := httptest.NewRequest("GET", "/api/categories/"+strconv.FormatInt(id, 10)+"/usage", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var resp map[string]int
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp["transactions"] != 0 || resp["rules"] != 0 {
		t.Fatalf("usage = %+v, want zeros", resp)
	}
}
