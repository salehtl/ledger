package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"ledger/internal/store"
)

func newScheduledTestServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := New(st, testFS())
	srv.SetScheduledStore(st)
	return srv, st
}

type schedResp struct {
	ID           int64           `json:"id"`
	Merchant     string          `json:"merchant"`
	Label        string          `json:"label"`
	AmountFils   int64           `json:"amount_fils"`
	TolerancePct int64           `json:"tolerance_pct"`
	IntervalDays int64           `json:"interval_days"`
	NextDue      string          `json:"next_due"`
	Direction    string          `json:"direction"`
	Source       string          `json:"source"`
	Status       string          `json:"status"`
	Missed       bool            `json:"missed"`
	PriceChange  bool            `json:"price_change"`
	Provenance   json.RawMessage `json:"provenance"`
}

func TestScheduledCRUDAndStatusFlow(t *testing.T) {
	srv, _ := newScheduledTestServer(t)

	// Manual create defaults: tolerance 10, direction debit, status active.
	w := doJSON(t, srv, "POST", "/api/scheduled", map[string]any{
		"merchant": "Netflix.com", "label": "Netflix",
		"amount_fils": 39_00, "interval_days": 30, "next_due": "2026-08-01",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST status = %d; body: %s", w.Code, w.Body)
	}
	var created schedResp
	json.Unmarshal(w.Body.Bytes(), &created)
	if created.Merchant != "netflix.com" || created.Status != "active" || created.Source != "manual" ||
		created.TolerancePct != 10 || created.Direction != "debit" {
		t.Fatalf("created = %+v", created)
	}

	// Update user fields.
	w = doJSON(t, srv, "PUT", "/api/scheduled/"+itoa(created.ID), map[string]any{
		"merchant": "netflix.com", "label": "Netflix 4K", "amount_fils": 49_00,
		"tolerance_pct": 5, "interval_days": 30, "next_due": "2026-08-02",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT status = %d; body: %s", w.Code, w.Body)
	}
	var updated schedResp
	json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.AmountFils != 49_00 || updated.Label != "Netflix 4K" || updated.TolerancePct != 5 {
		t.Fatalf("updated = %+v", updated)
	}

	// pause → confirm(resume) → dismiss.
	steps := []struct {
		action, want string
	}{
		{"pause", "paused"},
		{"confirm", "active"},
		{"dismiss", "dismissed"},
	}
	for _, stp := range steps {
		w = doJSON(t, srv, "POST", "/api/scheduled/"+itoa(created.ID)+"/"+stp.action, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s status = %d; body: %s", stp.action, w.Code, w.Body)
		}
		var got schedResp
		json.Unmarshal(w.Body.Bytes(), &got)
		if got.Status != stp.want {
			t.Fatalf("after %s status = %s, want %s", stp.action, got.Status, stp.want)
		}
	}

	// Dismissed rows only show when asked for.
	w = doJSON(t, srv, "GET", "/api/scheduled?status=active,proposed", nil)
	var list []schedResp
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 0 {
		t.Fatalf("active/proposed list = %d rows, want 0", len(list))
	}
	w = doJSON(t, srv, "GET", "/api/scheduled", nil)
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 {
		t.Fatalf("full list = %d rows, want 1", len(list))
	}

	// Delete.
	w = doJSON(t, srv, "DELETE", "/api/scheduled/"+itoa(created.ID), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d", w.Code)
	}
}

func TestScheduledValidationAndNotFound(t *testing.T) {
	srv, _ := newScheduledTestServer(t)
	badBodies := []struct {
		name string
		body map[string]any
	}{
		{"missing merchant", map[string]any{"amount_fils": 100, "interval_days": 30, "next_due": "2026-08-01"}},
		{"zero amount", map[string]any{"merchant": "x", "amount_fils": 0, "interval_days": 30, "next_due": "2026-08-01"}},
		{"zero interval", map[string]any{"merchant": "x", "amount_fils": 100, "interval_days": 0, "next_due": "2026-08-01"}},
		{"bad next_due", map[string]any{"merchant": "x", "amount_fils": 100, "interval_days": 30, "next_due": "soon"}},
		{"bad direction", map[string]any{"merchant": "x", "amount_fils": 100, "interval_days": 30, "next_due": "2026-08-01", "direction": "sideways"}},
	}
	for _, tc := range badBodies {
		t.Run(tc.name, func(t *testing.T) {
			w := doJSON(t, srv, "POST", "/api/scheduled", tc.body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400; body: %s", w.Code, w.Body)
			}
		})
	}

	if w := doJSON(t, srv, "GET", "/api/scheduled?status=bogus", nil); w.Code != http.StatusBadRequest {
		t.Errorf("bad status filter = %d, want 400", w.Code)
	}
	if w := doJSON(t, srv, "PUT", "/api/scheduled/999", map[string]any{
		"merchant": "x", "amount_fils": 100, "interval_days": 30, "next_due": "2026-08-01",
	}); w.Code != http.StatusNotFound {
		t.Errorf("PUT missing = %d, want 404", w.Code)
	}
	if w := doJSON(t, srv, "POST", "/api/scheduled/999/confirm", nil); w.Code != http.StatusNotFound {
		t.Errorf("confirm missing = %d, want 404", w.Code)
	}
}

func TestUpcomingFeed(t *testing.T) {
	srv, st := newScheduledTestServer(t)
	today := time.Now().UTC()
	due := func(days int) string { return today.AddDate(0, 0, days).Format("2006-01-02") }

	soonID, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "du.ae", AmountFils: 300_00, IntervalDays: 30, NextDue: due(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	overdueID, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "dewa", AmountFils: 500_00, IntervalDays: 30, NextDue: due(-3),
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.MarkScheduledMissed(overdueID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertScheduled(store.ScheduledTxnRow{
		NormalizedMerchant: "annual thing", AmountFils: 900_00, IntervalDays: 365, NextDue: due(90),
	}); err != nil {
		t.Fatal(err)
	}

	w := doJSON(t, srv, "GET", "/api/upcoming?days=7", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp struct {
		Days  int `json:"days"`
		Items []struct {
			schedResp
			DueInDays int64 `json:"due_in_days"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Days != 7 || len(resp.Items) != 2 {
		t.Fatalf("days=%d items=%d, want 7/2; body: %s", resp.Days, len(resp.Items), w.Body)
	}
	byID := map[int64]struct {
		schedResp
		DueInDays int64 `json:"due_in_days"`
	}{}
	for _, it := range resp.Items {
		byID[it.ID] = it
	}
	if it := byID[overdueID]; !it.Missed || it.DueInDays != -3 {
		t.Errorf("overdue item = %+v, want missed & due_in_days=-3", it)
	}
	if it := byID[soonID]; it.DueInDays != 2 {
		t.Errorf("soon item due_in_days = %d, want 2", it.DueInDays)
	}

	if w := doJSON(t, srv, "GET", "/api/upcoming?days=999", nil); w.Code != http.StatusBadRequest {
		t.Errorf("days=999 status = %d, want 400", w.Code)
	}
}
