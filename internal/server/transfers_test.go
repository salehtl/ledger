package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ledger/internal/store"
)

func seedSweepPair(t *testing.T, st *store.Store) {
	t.Helper()
	base := time.Date(2026, 6, 15, 9, 0, 0, 0, time.UTC)
	for _, d := range []struct {
		dir string
		at  time.Time
	}{{"debit", base}, {"credit", base.Add(15 * time.Minute)}} {
		if _, created, err := st.InsertTransaction(store.TransactionRow{
			PostedAt: d.at, AmountFils: 200000, Currency: "AED", Direction: d.dir,
			MerchantRaw: "SWEEP " + d.dir, Status: "needs_review",
		}); err != nil || !created {
			t.Fatalf("seed %s: created=%v err=%v", d.dir, created, err)
		}
	}
}

func TestTransfersSweep(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTransfersStore(st)
	seedSweepPair(t, st)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/transfers/sweep", strings.NewReader(`{}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Marked int `json:"marked"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Marked != 2 {
		t.Errorf("marked = %d, want 2", got.Marked)
	}
	var transfers int
	st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status='transfer'`).Scan(&transfers)
	if transfers != 2 {
		t.Errorf("transfer rows = %d, want 2", transfers)
	}
}

func TestTransfersSweepWindowValidation(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetTransfersStore(st)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/transfers/sweep",
		strings.NewReader(`{"window_hours": 500}`)))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("window 500h: code=%d, want 400", rec.Code)
	}
}

func TestTransfersSweepUnavailableWithoutStore(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st) // no SetTransfersStore
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/transfers/sweep", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("code=%d, want 503", rec.Code)
	}
}
