package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func seedMonth(n int) string {
	return time.Now().UTC().AddDate(0, n, 0).Format("2006-01")
}

// getEnvelopes fetches the summary for a month and returns assigned_fils by
// category name.
func getEnvelopes(t *testing.T, srv *Server, month string) map[string]int64 {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/envelopes?month="+month, nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/envelopes?month=%s = %d; body: %s", month, w.Code, w.Body)
	}
	var resp struct {
		Envelopes []struct {
			CategoryName string `json:"category_name"`
			AssignedFils int64  `json:"assigned_fils"`
		} `json:"envelopes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, e := range resp.Envelopes {
		out[e.CategoryName] = e.AssignedFils
	}
	return out
}

// Opening an unplanned month must show last month's plan already in place.
func TestGetEnvelopes_SeedsUnplannedMonth(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if err := st.UpsertEnvelopeAssignment(seedMonth(0), cat, 150000); err != nil {
		t.Fatal(err)
	}

	got := getEnvelopes(t, srv, seedMonth(1))
	if got["Groceries"] != 150000 {
		t.Errorf("Groceries assigned = %d, want 150000 carried forward", got["Groceries"])
	}
}

// A month the user has touched must come back exactly as they left it.
func TestGetEnvelopes_DoesNotSeedTouchedMonth(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if err := st.UpsertEnvelopeAssignment(seedMonth(0), cat, 150000); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertEnvelopeAssignment(seedMonth(1), cat, 0); err != nil {
		t.Fatal(err)
	}

	got := getEnvelopes(t, srv, seedMonth(1))
	if got["Groceries"] != 0 {
		t.Errorf("Groceries assigned = %d, want 0 — a deliberate zero was overwritten", got["Groceries"])
	}
}

// Reading a past month must never plan it.
func TestGetEnvelopes_DoesNotSeedPastMonth(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if err := st.UpsertEnvelopeAssignment(seedMonth(-2), cat, 150000); err != nil {
		t.Fatal(err)
	}
	past := seedMonth(-1)
	getEnvelopes(t, srv, past)

	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, past).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("past month gained %d assignment rows from a read", n)
	}
}

// Two simultaneous page loads must not double-seed.
func TestGetEnvelopes_ConcurrentReadsSeedOnce(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")
	if err := st.UpsertEnvelopeAssignment(seedMonth(0), cat, 150000); err != nil {
		t.Fatal(err)
	}
	target := seedMonth(1)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/api/envelopes?month="+target, nil)
			srv.ServeHTTP(httptest.NewRecorder(), r)
		}()
	}
	wg.Wait()

	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, target).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("rows = %d after 8 concurrent reads, want 1", n)
	}
}
