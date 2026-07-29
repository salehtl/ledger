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

	// Created category must appear in GET /api/categories (is_active=1 check).
	r2 := httptest.NewRequest("GET", "/api/categories", nil)
	w2 := httptest.NewRecorder()
	srv.ServeHTTP(w2, r2)
	if w2.Code != http.StatusOK {
		t.Fatalf("GET /api/categories status = %d", w2.Code)
	}
	var cats []map[string]any
	json.NewDecoder(w2.Body).Decode(&cats)
	var found bool
	for _, c := range cats {
		if c["Name"] == "Hobbies" {
			found = true
		}
	}
	if !found {
		t.Error("created category 'Hobbies' not visible in GET /api/categories")
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

func TestPostCategoryDuplicateName(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{"name": "Dupe", "kind": "spending", "bucket": "want"})
	r1 := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	w1 := httptest.NewRecorder()
	srv.ServeHTTP(w1, r1)
	if w1.Code != http.StatusCreated {
		t.Fatalf("first create status = %d, want 201; body: %s", w1.Code, w1.Body)
	}

	r2 := httptest.NewRequest("POST", "/api/categories", bytes.NewReader(body))
	w2 := httptest.NewRecorder()
	srv.ServeHTTP(w2, r2)
	if w2.Code != http.StatusConflict {
		t.Fatalf("duplicate create status = %d, want 409; body: %s", w2.Code, w2.Body)
	}
	var resp map[string]any
	json.NewDecoder(w2.Body).Decode(&resp)
	if resp["error"] != "name exists" {
		t.Fatalf("unexpected body: %+v", resp)
	}
}

func TestDeleteCategoryClean(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}

	r := httptest.NewRequest("DELETE", "/api/categories/"+strconv.FormatInt(id, 10), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var count int
	st.DB.QueryRow(`SELECT count(*) FROM categories WHERE id=?`, id).Scan(&count)
	if count != 0 {
		t.Fatalf("category not deleted (count=%d)", count)
	}
}

func TestDeleteCategoryInUse(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}
	// Reference it from a rule so it is "in use".
	if _, err := st.InsertRule(store.RuleRow{MatchType: "contains", Pattern: "x", CategoryID: id, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}

	r := httptest.NewRequest("DELETE", "/api/categories/"+strconv.FormatInt(id, 10), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["rules"] == nil || resp["error"] != "in use" {
		t.Fatalf("unexpected 409 body: %+v", resp)
	}
}

// TestDeleteCategoryBlockedByEnvelopeAssignments: envelope_assignments is ON
// DELETE CASCADE, so without this guard deleting a category with assigned
// months (but no transactions/rules) would silently rewrite historical budget
// state — past assigned totals and RTA would snap to different values.
func TestDeleteCategoryBlockedByEnvelopeAssignments(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	id, err := st.InsertCategory(store.CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}
	if err := st.UpsertEnvelopeAssignment("2026-07", id, 100_000); err != nil {
		t.Fatalf("UpsertEnvelopeAssignment: %v", err)
	}

	r := httptest.NewRequest("DELETE", "/api/categories/"+strconv.FormatInt(id, 10), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "in use" || resp["assignments"] != float64(1) {
		t.Fatalf("unexpected 409 body: %+v", resp)
	}
	// The assignment history survived intact.
	if total, err := st.TotalAssigned("2026-07"); err != nil || total != 100_000 {
		t.Fatalf("assignment after blocked delete = %d err=%v, want 100000 intact", total, err)
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

// TestPutCategoryKindChangeGuardsAssignments: flipping a category's kind away
// from 'spending' while envelope months carry assigned fils would orphan
// those assignments (EnvelopeMonthSummary lists only active spending
// categories) — assigned money silently vanishes from Plan and RTA
// overstates. Same historical-budget rewrite the DELETE guard 409s against,
// so PUT must 409 too until the assignments are cleared.
func TestPutCategoryKindChangeGuardsAssignments(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)

	catID, err := st.InsertCategory(store.CategoryRow{Name: "KindGuard", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertEnvelopeAssignment("2026-07", catID, 50_000); err != nil {
		t.Fatal(err)
	}

	put := func(body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		raw, _ := json.Marshal(body)
		r := httptest.NewRequest("PUT", "/api/categories/"+strconv.FormatInt(catID, 10), bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		return w
	}

	// Kind change away from spending with live assignments → 409 + counts.
	w := put(map[string]any{"name": "KindGuard", "kind": "income"})
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", w.Code, w.Body)
	}
	var conflict struct {
		Error       string `json:"error"`
		Assignments int    `json:"assignments"`
	}
	json.NewDecoder(w.Body).Decode(&conflict)
	if conflict.Error != "in use" || conflict.Assignments != 1 {
		t.Fatalf("conflict body = %+v, want in use / 1 assignment", conflict)
	}
	var kind string
	if err := st.DB.QueryRow(`SELECT kind FROM categories WHERE id=?`, catID).Scan(&kind); err != nil {
		t.Fatal(err)
	}
	if kind != "spending" {
		t.Fatalf("kind = %q after refused PUT, want spending", kind)
	}

	// Staying spending (rename, rebucket) is never blocked.
	if w := put(map[string]any{"name": "KindGuard2", "kind": "spending", "bucket": "need"}); w.Code != http.StatusOK {
		t.Fatalf("spending rename status = %d; body: %s", w.Code, w.Body)
	}

	// Zero the assignment → the kind change goes through.
	if err := st.UpsertEnvelopeAssignment("2026-07", catID, 0); err != nil {
		t.Fatal(err)
	}
	if w := put(map[string]any{"name": "KindGuard2", "kind": "income"}); w.Code != http.StatusOK {
		t.Fatalf("kind change after zeroing status = %d; body: %s", w.Code, w.Body)
	}
}
