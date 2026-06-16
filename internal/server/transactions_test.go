package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ledger/internal/store"
)

func TestPostCategorize(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if catID == 0 {
		t.Fatal("Shopping category not found")
	}

	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{"category_id": catID, "make_rule": false})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var status string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&status)
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}
}

func TestPostCategorizeWithRule(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}

	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{"category_id": catID, "make_rule": true, "merchant_raw": "DAPPER DAN GENTS SAL"})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/categorize", txID), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	rules, _ := st.SelectRules()
	if len(rules) == 0 {
		t.Error("expected a rule to be written back when make_rule=true")
	}
}

func TestPostStatus(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)

	srv := newTestServerWithStore(t, st)
	body, _ := json.Marshal(map[string]any{"status": "ignored"})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/status", txID), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var dbStatus string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&dbStatus)
	if dbStatus != "ignored" {
		t.Errorf("db status = %q, want ignored", dbStatus)
	}
}

func TestPostStatusInvalid(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	body, _ := json.Marshal(map[string]any{"status": "deleted"})
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/status", txID), bytes.NewReader(body))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for invalid status", w.Code)
	}
}

func TestPostRecategorize_NoFn(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)
	// Without a categorizer fn set, recategorize returns 200 with 0 processed
	r := httptest.NewRequest("POST", "/api/recategorize", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if _, ok := resp["processed"]; !ok {
		t.Error("expected 'processed' in response")
	}
}

func TestPostRecategorize_WithFn(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	// Pick a real category ID
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	srv := newTestServerWithStore(t, st)
	// Wire a categorize fn that always returns Shopping/confirmed
	srv.SetRecategorizeFn(func(ctx context.Context, merchantRaw string) (int64, string, bool) {
		return catID, "confirmed", true
	})
	r := httptest.NewRequest("POST", "/api/recategorize", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["processed"] == nil || resp["processed"].(float64) != 1 {
		t.Errorf("expected processed=1, got %v", resp["processed"])
	}
	// Verify DB state
	var status string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", txID).Scan(&status)
	if status != "confirmed" {
		t.Errorf("db status = %q, want confirmed", status)
	}
}

func TestPostRecategorize_DedupesByMerchant(t *testing.T) {
	st := newTestServerStore(t)
	// Two needs_review transactions from the SAME merchant.
	for _, amt := range []int64{1000, 2000} {
		if _, _, err := st.InsertTransaction(store.TransactionRow{
			PostedAt:    time.Date(2026, 6, int(amt/1000), 0, 0, 0, 0, time.UTC),
			AmountFils:  amt,
			Currency:    "AED",
			Direction:   "debit",
			MerchantRaw: "ACME WIDGETS",
			Status:      "needs_review",
			Tier:        "template",
		}); err != nil {
			t.Fatal(err)
		}
	}
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	srv := newTestServerWithStore(t, st)
	calls := 0
	srv.SetRecategorizeFn(func(_ context.Context, _ string) (int64, string, bool) {
		calls++
		return catID, "confirmed", true
	})
	r := httptest.NewRequest("POST", "/api/recategorize", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["processed"] == nil || resp["processed"].(float64) != 2 {
		t.Errorf("processed=%v, want 2", resp["processed"])
	}
	if calls != 1 {
		t.Errorf("recatFn called %d times, want 1 (deduped by merchant)", calls)
	}
}

func TestClearCategorization(t *testing.T) {
	st := newTestServerStore(t)
	txID := seedTestTransaction(t, st)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if err := st.UpdateTransactionCategory(txID, catID, "confirmed"); err != nil {
		t.Fatalf("setup categorize: %v", err)
	}

	srv := newTestServerWithStore(t, st)
	r := httptest.NewRequest("POST", "/api/categorization/clear", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["cleared"] == nil || resp["cleared"].(float64) != 1 {
		t.Errorf("expected cleared=1, got %v", resp["cleared"])
	}

	var status string
	var cat sql.NullInt64
	st.DB.QueryRow("SELECT status, category_id FROM transactions WHERE id=?", txID).Scan(&status, &cat)
	if status != "needs_review" {
		t.Errorf("db status = %q, want needs_review", status)
	}
	if cat.Valid {
		t.Errorf("category_id not cleared: %d", cat.Int64)
	}
}
