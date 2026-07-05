package server

import (
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ledger/internal/store"
)

func seedServerTxn(t *testing.T, st *store.Store, direction, merchant string, amountFils int64, postedAt, categoryName string) int64 {
	t.Helper()
	var catID int64
	if categoryName != "" {
		if err := st.DB.QueryRow(`SELECT id FROM categories WHERE name=?`, categoryName).Scan(&catID); err != nil {
			t.Fatalf("category %q: %v", categoryName, err)
		}
	}
	posted, err := time.Parse(time.RFC3339, postedAt)
	if err != nil {
		t.Fatalf("parse postedAt: %v", err)
	}
	id, err := st.InsertManualTransaction(store.ManualTxn{
		PostedAt: posted, AmountFils: amountFils, Direction: direction,
		MerchantRaw: merchant, CategoryID: catID,
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	return id
}

func TestLinkRefundEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/link-refund", creditID),
		strings.NewReader(fmt.Sprintf(`{"target_id":%d}`, debitID)))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	var refundOf int64
	var status string
	if err := st.DB.QueryRow(`SELECT refund_of_id, status FROM transactions WHERE id=?`, creditID).
		Scan(&refundOf, &status); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if refundOf != debitID || status != "confirmed" {
		t.Errorf("credit after link: refund_of=%d status=%q, want %d/confirmed", refundOf, status, debitID)
	}
}

func TestLinkRefundEndpointErrors(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	otherCredit := seedServerTxn(t, st, "credit", "Other", 900, "2026-07-02T10:00:00Z", "")

	cases := []struct {
		name     string
		url      string
		body     string
		wantCode int
	}{
		{"unknown credit", "/api/transactions/99999/link-refund", fmt.Sprintf(`{"target_id":%d}`, debitID), 404},
		{"target is a credit", fmt.Sprintf("/api/transactions/%d/link-refund", creditID), fmt.Sprintf(`{"target_id":%d}`, otherCredit), 400},
		{"missing target_id", fmt.Sprintf("/api/transactions/%d/link-refund", creditID), `{}`, 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", tc.url, strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, req)
			if w.Code != tc.wantCode {
				t.Errorf("status = %d, want %d (body %s)", w.Code, tc.wantCode, w.Body.String())
			}
		})
	}
}

func TestRefundCandidatesEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")

	req := httptest.NewRequest("GET", fmt.Sprintf("/api/transactions/%d/refund-candidates", creditID), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"MerchantRaw":"Carrefour"`) {
		t.Errorf("candidates body missing Carrefour: %s", body)
	}
	if !strings.Contains(body, fmt.Sprintf(`"ID":%d`, debitID)) {
		t.Errorf("candidates body missing debit id: %s", body)
	}

	// A credit with no candidates must return [] not null.
	lonely := seedServerTxn(t, st, "credit", "Lonely", 123, "2020-01-01T10:00:00Z", "")
	req = httptest.NewRequest("GET", fmt.Sprintf("/api/transactions/%d/refund-candidates", lonely), nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if got := strings.TrimSpace(w.Body.String()); got != "[]" {
		t.Errorf("empty candidates = %q, want []", got)
	}
}

func TestUnlinkRefundEndpoint(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	debitID := seedServerTxn(t, st, "debit", "Carrefour", 5000, "2026-07-01T10:00:00Z", "Groceries")
	creditID := seedServerTxn(t, st, "credit", "Refund", 5000, "2026-07-03T10:00:00Z", "")
	if err := st.LinkRefund(creditID, debitID); err != nil {
		t.Fatalf("LinkRefund: %v", err)
	}

	req := httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/unlink-refund", creditID), nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}

	// Second unlink: nothing to remove → 404.
	req = httptest.NewRequest("POST", fmt.Sprintf("/api/transactions/%d/unlink-refund", creditID), nil)
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Errorf("second unlink status = %d, want 404", w.Code)
	}
}
