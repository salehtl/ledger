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

func newRatesServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetRatesStore(st)
	return srv, st
}

func TestGetRates(t *testing.T) {
	srv, st := newRatesServer(t)
	// One unconverted EUR row so "missing" is non-empty.
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:   time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		AmountFils: 2412, Currency: "EUR", Direction: "debit",
		MerchantRaw: "m", Status: "confirmed",
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/rates", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got struct {
		Rates []struct {
			Currency string  `json:"currency"`
			Rate     float64 `json:"rate"`
		} `json:"rates"`
		Missing []string `json:"missing"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Rates) != 1 || got.Rates[0].Currency != "USD" || got.Rates[0].Rate != 3.6725 {
		t.Fatalf("rates = %+v, want seeded USD 3.6725", got.Rates)
	}
	if len(got.Missing) != 1 || got.Missing[0] != "EUR" {
		t.Fatalf("missing = %v, want [EUR]", got.Missing)
	}
}

func TestPutRateBackfills(t *testing.T) {
	srv, st := newRatesServer(t)
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:   time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC),
		AmountFils: 2412, Currency: "EUR", Direction: "debit",
		MerchantRaw: "m", Status: "confirmed",
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	req := httptest.NewRequest("PUT", "/api/rates/EUR", strings.NewReader(`{"rate":4.30}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["converted"] != float64(1) {
		t.Fatalf("converted = %v, want 1", got["converted"])
	}
	var aed int64
	if err := st.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE currency='EUR'`).Scan(&aed); err != nil {
		t.Fatalf("select: %v", err)
	}
	if aed != 10372 {
		t.Fatalf("amount_aed = %d, want 10372", aed)
	}
}

func TestPutRateValidation(t *testing.T) {
	srv, _ := newRatesServer(t)
	for _, c := range []struct{ path, body string }{
		{"/api/rates/AED", `{"rate":1}`},    // AED is identity, not editable
		{"/api/rates/usd", `{"rate":3.67}`}, // lowercase
		{"/api/rates/EURO", `{"rate":4.3}`}, // 4 letters
		{"/api/rates/EUR", `{"rate":0}`},    // non-positive
		{"/api/rates/EUR", `{"rate":-2}`},
		{"/api/rates/EUR", `{"rate":0.0000001}`}, // rounds to micro 0
	} {
		req := httptest.NewRequest("PUT", c.path, strings.NewReader(c.body))
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("PUT %s %s: code=%d, want 400", c.path, c.body, rec.Code)
		}
	}
}

func TestDeleteRate(t *testing.T) {
	srv, st := newRatesServer(t)
	if err := st.UpsertFXRate("EUR", 4300000); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	req := httptest.NewRequest("DELETE", "/api/rates/EUR", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d", rec.Code)
	}
	if _, ok, _ := st.RateMicroFor("EUR"); ok {
		t.Fatal("EUR rate should be deleted")
	}
}

// Saving a corrected rate must rewrite the rows already converted with the
// wrong one, not only the rows that were still unconverted.
func TestPutRateReconvertsExistingSnapshots(t *testing.T) {
	srv, st := newRatesServer(t)
	// Wrong rate first: 2.0 AED per ZAR.
	if err := st.UpsertFXRate("ZAR", 2_000_000); err != nil {
		t.Fatalf("UpsertFXRate: %v", err)
	}
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:   time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC),
		AmountFils: 3_000_000, Currency: "ZAR", Direction: "debit",
		MerchantRaw: "Woodford", Status: "confirmed",
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	var aed int64
	if err := st.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE currency='ZAR'`).Scan(&aed); err != nil {
		t.Fatalf("select: %v", err)
	}
	if aed != 6_000_000 {
		t.Fatalf("precondition: amount_aed = %d, want 6000000 at the wrong rate", aed)
	}

	req := httptest.NewRequest("PUT", "/api/rates/ZAR", strings.NewReader(`{"rate":0.2}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("code=%d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	json.Unmarshal(rec.Body.Bytes(), &got)
	if got["converted"] != float64(1) {
		t.Fatalf("converted = %v, want 1", got["converted"])
	}
	if err := st.DB.QueryRow(`SELECT amount_aed FROM transactions WHERE currency='ZAR'`).Scan(&aed); err != nil {
		t.Fatalf("select: %v", err)
	}
	if aed != 600_000 {
		t.Fatalf("amount_aed = %d, want 600000 after the corrected rate", aed)
	}
}
