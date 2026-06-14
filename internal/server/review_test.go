package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"ledger/internal/store"
)

func seedTestTransaction(t *testing.T, st *store.Store) int64 {
	t.Helper()
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "t1",
		FromAddr:    "DIB.notification@dib.ae",
		Subject:     "s",
		ParseStatus: "parsed",
		RawBody:     []byte("r"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

	id, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  21500,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DAPPER DAN GENTS SAL",
		Last4:       "1502",
		Status:      "needs_review",
		Confidence:  0.97,
		Tier:        "template",
		IngestID:    ingestID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestGetReview(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/review", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var items []map[string]any
	json.NewDecoder(w.Body).Decode(&items)
	if len(items) != 1 {
		t.Errorf("got %d items, want 1", len(items))
	}
}

func TestGetTransactions(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	var items []map[string]any
	json.NewDecoder(w.Body).Decode(&items)
	if len(items) == 0 {
		t.Error("expected at least one transaction")
	}
}

func TestGetTransactionsStatusFilter(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	// Filter by confirmed — should return 0 (our tx is needs_review)
	r := httptest.NewRequest("GET", "/api/transactions?status=confirmed", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var items []map[string]any
	json.NewDecoder(w.Body).Decode(&items)
	if len(items) != 0 {
		t.Errorf("confirmed filter: got %d items, want 0", len(items))
	}
}
