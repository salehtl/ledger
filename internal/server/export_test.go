package server

import (
	"encoding/csv"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestFilsToDecimal(t *testing.T) {
	cases := []struct {
		fils int64
		want string
	}{
		{0, "0.00"}, {5, "0.05"}, {50, "0.50"}, {21500, "215.00"}, {123456789, "1234567.89"},
	}
	for _, c := range cases {
		if got := filsToDecimal(c.fils); got != c.want {
			t.Errorf("filsToDecimal(%d) = %q, want %q", c.fils, got, c.want)
		}
	}
}

func TestExportTransactionsCSV(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st) // 21500 fils AED debit, "DAPPER DAN GENTS SAL", needs_review
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions/export", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/csv") {
		t.Errorf("Content-Type = %q, want text/csv", ct)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, `attachment; filename="ledger-export-`) {
		t.Errorf("Content-Disposition = %q, want attachment with dated filename", cd)
	}

	rows, err := csv.NewReader(w.Body).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d csv rows, want header + 1 record", len(rows))
	}
	wantHeader := []string{"id", "posted_at", "amount", "currency", "amount_aed", "direction",
		"merchant", "category", "bucket", "status", "source"}
	if !slices.Equal(rows[0], wantHeader) {
		t.Errorf("header = %v, want %v", rows[0], wantHeader)
	}
	rec := rows[1]
	if rec[2] != "215.00" {
		t.Errorf("amount = %q, want 215.00", rec[2])
	}
	if rec[3] != "AED" {
		t.Errorf("currency = %q, want AED", rec[3])
	}
	if rec[6] != "DAPPER DAN GENTS SAL" {
		t.Errorf("merchant = %q", rec[6])
	}
	if rec[9] != "needs_review" {
		t.Errorf("status = %q, want needs_review", rec[9])
	}
}

func TestExportTransactionsHonorsFilters(t *testing.T) {
	st := newTestServerStore(t)
	seedTestTransaction(t, st)
	srv := newTestServerWithStore(t, st)

	r := httptest.NewRequest("GET", "/api/transactions/export?q=nomatch", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	rows, err := csv.NewReader(w.Body).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("q=nomatch: got %d rows, want header only", len(rows))
	}
}
