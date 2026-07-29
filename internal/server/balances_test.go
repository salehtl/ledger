package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"ledger/internal/store"
)

func newBalancesTestServer(t *testing.T) (*Server, *store.Store, int64) {
	t.Helper()
	st := newTestServerStore(t)
	srv := New(st, testFS())
	srv.SetBalancesStore(st)
	acctID, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	return srv, st, acctID
}

// balInsertTxn seeds a transaction attributed to the test account's last4.
func balInsertTxn(t *testing.T, st *store.Store, direction string, amountFils int64, postedAt, merchant string) {
	t.Helper()
	posted, err := time.Parse(time.RFC3339, postedAt)
	if err != nil {
		t.Fatal(err)
	}
	if _, inserted, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: posted, AmountFils: amountFils, Direction: direction,
		MerchantRaw: merchant, Last4: "1234", Status: "confirmed", Confidence: 1,
	}); err != nil || !inserted {
		t.Fatalf("InsertTransaction: inserted=%v err=%v", inserted, err)
	}
}

type checkinRespT struct {
	AccountID        int64  `json:"account_id"`
	StatedFils       int64  `json:"stated_fils"`
	ExpectedFils     int64  `json:"expected_fils"`
	DeltaFils        int64  `json:"delta_fils"`
	Since            string `json:"since"`
	TxnCount         int    `json:"txn_count"`
	UnconvertedCount int    `json:"unconverted_count"`
	FirstCheckin     bool   `json:"first_checkin"`
	BalanceID        int64  `json:"balance_id"`
	Unparsed         []struct {
		ID      int64  `json:"id"`
		Subject string `json:"subject"`
	} `json:"unparsed"`
}

func TestCheckinFlow(t *testing.T) {
	srv, st, acctID := newBalancesTestServer(t)
	base := "/api/accounts/" + itoa(acctID)

	// Drive the store clock so the anchors bracket the activity. Windows are
	// DAY-granular (an anchor states the balance as of end of its day), so the
	// activity must land on a LATER day than the first anchor to count:
	// first check-in on day D, activity on day D+1, second check-in on day D+2.
	t0 := time.Now().UTC().Add(-72 * time.Hour).Truncate(time.Second)
	clock := t0
	st.SetNow(func() int64 { return clock.Unix() })

	// First check-in: no anchor, stated becomes truth, delta 0.
	w := doJSON(t, srv, "POST", base+"/checkin", map[string]any{"stated_fils": 1000_00})
	if w.Code != http.StatusOK {
		t.Fatalf("first checkin status = %d; body: %s", w.Code, w.Body)
	}
	var first checkinRespT
	json.Unmarshal(w.Body.Bytes(), &first)
	if !first.FirstCheckin || first.DeltaFils != 0 || first.ExpectedFils != 1000_00 || first.BalanceID == 0 {
		t.Fatalf("first = %+v", first)
	}

	// Activity the day after the anchor: 200.00 out. A silent unparsed email
	// arrives too.
	mid := t0.Add(24 * time.Hour)
	balInsertTxn(t, st, "debit", 200_00, mid.Format(time.RFC3339), "spend after checkin")
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "silent1", ReceivedAt: mid, FromAddr: "bank@dib.ae",
		Subject: "Card transaction", ParseStatus: "unparsed", RawBody: []byte("x"),
	}); err != nil {
		t.Fatal(err)
	}
	clock = t0.Add(48 * time.Hour)

	// Second check-in disagrees by −100.00 (bank says 700, ledger expects 800).
	w = doJSON(t, srv, "POST", base+"/checkin", map[string]any{"stated_fils": 700_00})
	if w.Code != http.StatusOK {
		t.Fatalf("second checkin status = %d; body: %s", w.Code, w.Body)
	}
	var second checkinRespT
	json.Unmarshal(w.Body.Bytes(), &second)
	if second.FirstCheckin || second.ExpectedFils != 800_00 || second.DeltaFils != -100_00 || second.TxnCount != 1 {
		t.Fatalf("second = %+v", second)
	}
	if len(second.Unparsed) != 1 || second.Unparsed[0].Subject != "Card transaction" {
		t.Fatalf("unparsed candidates = %+v, want the silent email", second.Unparsed)
	}

	// Accepting the delta writes a backdated adjustment; the computed balance
	// then matches the stated truth.
	w = doJSON(t, srv, "POST", base+"/adjust", map[string]any{"delta_fils": second.DeltaFils, "note": "atm cash"})
	if w.Code != http.StatusCreated {
		t.Fatalf("adjust status = %d; body: %s", w.Code, w.Body)
	}
	var adj struct {
		OK            bool  `json:"ok"`
		TransactionID int64 `json:"transaction_id"`
	}
	json.Unmarshal(w.Body.Bytes(), &adj)
	if !adj.OK || adj.TransactionID == 0 {
		t.Fatalf("adjust resp = %+v", adj)
	}

	w = doJSON(t, srv, "GET", "/api/accounts/balances", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("summaries status = %d", w.Code)
	}
	var sums []struct {
		AccountID    int64 `json:"account_id"`
		HasCheckin   bool  `json:"has_checkin"`
		AnchorFils   int64 `json:"anchor_fils"`
		ComputedFils int64 `json:"computed_fils"`
	}
	json.Unmarshal(w.Body.Bytes(), &sums)
	if len(sums) != 1 {
		t.Fatalf("summaries = %+v", sums)
	}
	if !sums[0].HasCheckin || sums[0].AnchorFils != 700_00 || sums[0].ComputedFils != 700_00 {
		t.Fatalf("summary = %+v, want anchor=computed=700_00 after adjustment", sums[0])
	}
}

func TestBalancesListAndPost(t *testing.T) {
	srv, _, acctID := newBalancesTestServer(t)
	base := "/api/accounts/" + itoa(acctID)

	w := doJSON(t, srv, "POST", base+"/balances", map[string]any{
		"balance_fils": 5000_00, "as_of": "2026-07-01T10:00:00Z", "note": "opening",
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST balance status = %d; body: %s", w.Code, w.Body)
	}
	w = doJSON(t, srv, "POST", base+"/balances", map[string]any{"balance_fils": 5100_00})
	if w.Code != http.StatusCreated {
		t.Fatalf("POST balance 2 status = %d", w.Code)
	}

	w = doJSON(t, srv, "GET", base+"/balances", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET balances status = %d", w.Code)
	}
	var list []struct {
		BalanceFils int64  `json:"balance_fils"`
		Source      string `json:"source"`
		Note        string `json:"note"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 2 {
		t.Fatalf("list = %d rows, want 2", len(list))
	}
	if list[0].BalanceFils != 5100_00 { // newest first
		t.Errorf("list[0] = %+v, want newest first", list[0])
	}

	w = doJSON(t, srv, "GET", base+"/balances?limit=1", nil)
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 {
		t.Errorf("limited list = %d rows, want 1", len(list))
	}
}

func TestBalancesErrors(t *testing.T) {
	srv, _, acctID := newBalancesTestServer(t)
	tests := []struct {
		name, method, path string
		body               map[string]any
		want               int
	}{
		{"unknown account checkin", "POST", "/api/accounts/999/checkin", map[string]any{"stated_fils": 1}, http.StatusNotFound},
		{"unknown account balances", "GET", "/api/accounts/999/balances", nil, http.StatusNotFound},
		{"bad id", "GET", "/api/accounts/abc/balances", nil, http.StatusBadRequest},
		{"zero-delta adjust", "POST", "/api/accounts/" + itoa(acctID) + "/adjust", map[string]any{"delta_fils": 0}, http.StatusBadRequest},
		{"bad as_of", "POST", "/api/accounts/" + itoa(acctID) + "/balances", map[string]any{"balance_fils": 1, "as_of": "yesterday"}, http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := doJSON(t, srv, tc.method, tc.path, tc.body)
			if w.Code != tc.want {
				t.Errorf("status = %d, want %d; body: %s", w.Code, tc.want, w.Body)
			}
		})
	}
}

// TestCheckinUnconvertedForeign: a foreign-currency transaction with no FX
// rate contributes nothing to the expected balance (AED convention — never
// raw foreign minor units) and the check-in response names it via
// unconverted_count so the delta is explained instead of silently mis-summed.
func TestCheckinUnconvertedForeign(t *testing.T) {
	srv, st, acctID := newBalancesTestServer(t)
	base := "/api/accounts/" + itoa(acctID)

	t0 := time.Now().UTC().Add(-72 * time.Hour).Truncate(time.Second)
	clock := t0
	st.SetNow(func() int64 { return clock.Unix() })

	w := doJSON(t, srv, "POST", base+"/checkin", map[string]any{"stated_fils": 1000_00})
	if w.Code != http.StatusOK {
		t.Fatalf("first checkin status = %d; body: %s", w.Code, w.Body)
	}

	// The day after: one AED spend and one GBP spend with no GBP rate.
	mid := t0.Add(24 * time.Hour)
	balInsertTxn(t, st, "debit", 200_00, mid.Format(time.RFC3339), "aed spend")
	posted := mid.Add(time.Hour)
	if _, inserted, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: posted, AmountFils: 50_00, Currency: "GBP", Direction: "debit",
		MerchantRaw: "london shop", Last4: "1234", Status: "confirmed", Confidence: 1,
	}); err != nil || !inserted {
		t.Fatalf("insert GBP txn: inserted=%v err=%v", inserted, err)
	}
	clock = t0.Add(48 * time.Hour)

	// Bank says 750.00 (the GBP charge really came out as ~AED 231 — but the
	// ledger can't know that yet). Expected must be 800.00 (GBP row counts 0,
	// NOT as AED 50), and the response must name 1 unconverted row.
	w = doJSON(t, srv, "POST", base+"/checkin", map[string]any{"stated_fils": 750_00})
	if w.Code != http.StatusOK {
		t.Fatalf("second checkin status = %d; body: %s", w.Code, w.Body)
	}
	var resp checkinRespT
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp.ExpectedFils != 800_00 {
		t.Errorf("expected_fils = %d, want 80000 (no-rate GBP row must contribute nothing)", resp.ExpectedFils)
	}
	if resp.TxnCount != 2 || resp.UnconvertedCount != 1 {
		t.Errorf("txn_count/unconverted_count = %d/%d, want 2/1", resp.TxnCount, resp.UnconvertedCount)
	}
	if resp.DeltaFils != -50_00 {
		t.Errorf("delta_fils = %d, want -5000", resp.DeltaFils)
	}
}
