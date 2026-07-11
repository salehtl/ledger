package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"ledger/internal/store"
)

func itoa(id int64) string { return strconv.FormatInt(id, 10) }

// projInsertCategory seeds a category via InsertCategory, mirroring the
// helper in internal/store/projects_test.go.
func projInsertCategory(t *testing.T, st *store.Store, name, kind, bucket string) int64 {
	t.Helper()
	id, err := st.InsertCategory(store.CategoryRow{Name: name, Kind: kind, Bucket: bucket, IsActive: true})
	if err != nil {
		t.Fatalf("insertCategory: %v", err)
	}
	return id
}

// projInsertTxn seeds a confirmed manual transaction, mirroring insertTxn in
// internal/store/projects_test.go.
func projInsertTxn(t *testing.T, st *store.Store, catID int64, direction string, amountFils int64, postedAt, status string) int64 {
	t.Helper()
	posted, err := time.Parse("2006-01-02", postedAt)
	if err != nil {
		t.Fatalf("projInsertTxn: parse postedAt %q: %v", postedAt, err)
	}
	id, err := st.InsertManualTransaction(store.ManualTxn{
		PostedAt:    posted,
		AmountFils:  amountFils,
		Direction:   direction,
		MerchantRaw: "Test Merchant",
		CategoryID:  catID,
	})
	if err != nil {
		t.Fatalf("projInsertTxn: %v", err)
	}
	if status != "" && status != "confirmed" {
		if err := st.UpdateTransactionStatus(id, status); err != nil {
			t.Fatalf("projInsertTxn: set status: %v", err)
		}
	}
	return id
}

func newProjectTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := New(st, fstest())
	srv.SetProjectStore(st)
	return srv, st
}

func doJSON(t *testing.T, srv *Server, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		r = httptest.NewRequest(method, path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
	} else {
		r = httptest.NewRequest(method, path, nil)
	}
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	return w
}

func TestPostProjectRequiresName(t *testing.T) {
	srv, _ := newProjectTestServer(t)
	w := doJSON(t, srv, "POST", "/api/projects", map[string]any{"color": "#fff"})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body)
	}
}

func TestPostProjectCreates(t *testing.T) {
	srv, _ := newProjectTestServer(t)
	budget := int64(1_000_000)
	w := doJSON(t, srv, "POST", "/api/projects", map[string]any{
		"name":             "Project Car",
		"budget_fils":      budget,
		"color":            "#c2703d",
		"ends_on":          "2026-09-30",
		"count_in_monthly": true,
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["id"] == nil || resp["id"].(float64) <= 0 {
		t.Fatalf("expected id in response, got %v", resp)
	}
}

func TestGetProjectsListWithRollups(t *testing.T) {
	srv, st := newProjectTestServer(t)
	catID := projInsertCategory(t, st, "Auto", "spending", "want")
	t1 := projInsertTxn(t, st, catID, "debit", 500_000, "2026-07-01", "confirmed")
	t2 := projInsertTxn(t, st, catID, "debit", 200_000, "2026-07-02", "needs_review")

	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AssignTransactionProject(t1, &pid); err != nil {
		t.Fatal(err)
	}
	if err := st.AssignTransactionProject(t2, &pid); err != nil {
		t.Fatal(err)
	}

	w := doJSON(t, srv, "GET", "/api/projects", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var list []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 project, got %d: %v", len(list), list)
	}
	got := list[0]
	if got["net_spent_fils"].(float64) != 500_000 {
		t.Fatalf("net_spent_fils = %v, want 500000", got["net_spent_fils"])
	}
	if got["pending_fils"].(float64) != 200_000 {
		t.Fatalf("pending_fils = %v, want 200000", got["pending_fils"])
	}
	if got["txn_count"].(float64) != 1 {
		t.Fatalf("txn_count = %v, want 1", got["txn_count"])
	}
	if _, ok := got["by_category"]; ok {
		t.Fatalf("list response should omit by_category, got %v", got["by_category"])
	}
}

func TestGetProjectsIncludeCompleted(t *testing.T) {
	srv, st := newProjectTestServer(t)
	st.SetNow(func() int64 { return 1_000_000 })
	id, err := st.InsertProject(store.ProjectRow{Name: "Done", Status: "completed", CompletedAt: "2026-01-01T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	_ = id

	w := doJSON(t, srv, "GET", "/api/projects", nil)
	var list []map[string]any
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 0 {
		t.Fatalf("default list should exclude completed, got %d", len(list))
	}

	w2 := doJSON(t, srv, "GET", "/api/projects?include_completed=1", nil)
	var list2 []map[string]any
	json.Unmarshal(w2.Body.Bytes(), &list2)
	if len(list2) != 1 {
		t.Fatalf("include_completed=1 should return 1, got %d", len(list2))
	}
}

func TestGetProjectDetailByCategory(t *testing.T) {
	srv, st := newProjectTestServer(t)
	catID := projInsertCategory(t, st, "Auto", "spending", "want")
	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	t1 := projInsertTxn(t, st, catID, "debit", 500_000, "2026-07-01", "confirmed")
	if err := st.AssignTransactionProject(t1, &pid); err != nil {
		t.Fatal(err)
	}

	w := doJSON(t, srv, "GET", "/api/projects/"+itoa(pid), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var got map[string]any
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["name"] != "Car" {
		t.Fatalf("name = %v", got["name"])
	}
	bc, ok := got["by_category"].([]any)
	if !ok || len(bc) != 1 {
		t.Fatalf("by_category = %v", got["by_category"])
	}
	entry := bc[0].(map[string]any)
	if entry["category"] != "Auto" || entry["net_fils"].(float64) != 500_000 {
		t.Fatalf("by_category entry = %v", entry)
	}
}

func TestGetProjectNotFound(t *testing.T) {
	srv, _ := newProjectTestServer(t)
	w := doJSON(t, srv, "GET", "/api/projects/999", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body: %s", w.Code, w.Body)
	}
}

func TestPutProjectUpdatesAndSetsCompletedAt(t *testing.T) {
	srv, st := newProjectTestServer(t)
	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}

	before := time.Now().UTC()
	w := doJSON(t, srv, "PUT", "/api/projects/"+itoa(pid), map[string]any{
		"name":   "Car Renamed",
		"status": "completed",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	got, err := st.SelectProject(pid)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "Car Renamed" || got.Status != "completed" {
		t.Fatalf("got = %+v", got)
	}
	if got.CompletedAt == "" {
		t.Fatalf("expected completed_at to be set")
	}
	completedAt, err := time.Parse(time.RFC3339, got.CompletedAt)
	if err != nil {
		t.Fatalf("completed_at not RFC3339: %v", got.CompletedAt)
	}
	if completedAt.Before(before.Add(-time.Minute)) {
		t.Fatalf("completed_at %v looks stale relative to %v", completedAt, before)
	}

	// Reopen: completed_at should clear.
	w2 := doJSON(t, srv, "PUT", "/api/projects/"+itoa(pid), map[string]any{
		"name":   "Car Renamed",
		"status": "active",
	})
	if w2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w2.Code, w2.Body)
	}
	got2, err := st.SelectProject(pid)
	if err != nil {
		t.Fatal(err)
	}
	if got2.CompletedAt != "" {
		t.Fatalf("expected completed_at cleared on reopen, got %q", got2.CompletedAt)
	}
}

func TestPutProjectRequiresName(t *testing.T) {
	srv, st := newProjectTestServer(t)
	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	w := doJSON(t, srv, "PUT", "/api/projects/"+itoa(pid), map[string]any{"name": ""})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", w.Code, w.Body)
	}
}

func TestDeleteProject(t *testing.T) {
	srv, st := newProjectTestServer(t)
	catID := projInsertCategory(t, st, "Auto", "spending", "want")
	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	t1 := projInsertTxn(t, st, catID, "debit", 500_000, "2026-07-01", "confirmed")
	if err := st.AssignTransactionProject(t1, &pid); err != nil {
		t.Fatal(err)
	}

	w := doJSON(t, srv, "DELETE", "/api/projects/"+itoa(pid), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	if _, err := st.SelectProject(pid); err == nil {
		t.Fatal("project should be gone")
	}
	var withProj int
	st.DB.QueryRow(`SELECT COUNT(project_id) FROM transactions WHERE id = ?`, t1).Scan(&withProj)
	if withProj != 0 {
		t.Fatalf("transaction should be unassigned, withProj=%d", withProj)
	}
}

func TestAssignSingleTransactionProject(t *testing.T) {
	srv, st := newProjectTestServer(t)
	catID := projInsertCategory(t, st, "Auto", "spending", "want")
	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	t1 := projInsertTxn(t, st, catID, "debit", 500_000, "2026-07-01", "confirmed")

	w := doJSON(t, srv, "POST", "/api/transactions/"+itoa(t1)+"/project", map[string]any{"project_id": pid})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var raw *int64
	if err := st.DB.QueryRow(`SELECT project_id FROM transactions WHERE id = ?`, t1).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw == nil || *raw != pid {
		t.Fatalf("project_id = %v, want %d", raw, pid)
	}

	// Clear with null.
	w2 := doJSON(t, srv, "POST", "/api/transactions/"+itoa(t1)+"/project", map[string]any{"project_id": nil})
	if w2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w2.Code, w2.Body)
	}
	var raw2 *int64
	if err := st.DB.QueryRow(`SELECT project_id FROM transactions WHERE id = ?`, t1).Scan(&raw2); err != nil {
		t.Fatal(err)
	}
	if raw2 != nil {
		t.Fatalf("project_id = %v, want nil", raw2)
	}
}

func TestBulkAssignProject(t *testing.T) {
	srv, st := newProjectTestServer(t)
	catID := projInsertCategory(t, st, "Auto", "spending", "want")
	pid, err := st.InsertProject(store.ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatal(err)
	}
	t1 := projInsertTxn(t, st, catID, "debit", 500_000, "2026-07-01", "confirmed")
	t2 := projInsertTxn(t, st, catID, "debit", 200_000, "2026-07-02", "confirmed")

	w := doJSON(t, srv, "POST", "/api/projects/"+itoa(pid)+"/assign", map[string]any{
		"transaction_ids": []int64{t1, t2},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["assigned"].(float64) != 2 {
		t.Fatalf("assigned = %v, want 2", resp["assigned"])
	}

	// Bulk unassign.
	w2 := doJSON(t, srv, "POST", "/api/projects/"+itoa(pid)+"/unassign", map[string]any{
		"transaction_ids": []int64{t1, t2},
	})
	if w2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w2.Code, w2.Body)
	}
	var resp2 map[string]any
	json.Unmarshal(w2.Body.Bytes(), &resp2)
	if resp2["unassigned"].(float64) != 2 {
		t.Fatalf("unassigned = %v, want 2", resp2["unassigned"])
	}
}

func TestProjectEndpointsUnset503(t *testing.T) {
	srv := New(nil, fstest())
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/projects"},
		{"POST", "/api/projects"},
		{"GET", "/api/projects/1"},
		{"PUT", "/api/projects/1"},
		{"DELETE", "/api/projects/1"},
		{"POST", "/api/projects/1/assign"},
		{"POST", "/api/projects/1/unassign"},
		{"POST", "/api/transactions/1/project"},
	} {
		w := doJSON(t, srv, tc.method, tc.path, map[string]any{})
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s: status = %d, want 503; body: %s", tc.method, tc.path, w.Code, w.Body)
		}
	}
}
