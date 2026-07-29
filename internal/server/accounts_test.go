package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ledger/internal/store"
)

func newAccountsServer(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st)
	srv.SetAccountsStore(st)
	return srv, st
}

func TestAccountsCreateListDelete(t *testing.T) {
	srv, _ := newAccountsServer(t)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/accounts",
		strings.NewReader(`{"name":"DIB Current","bank":"DIB","last4":"1234"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create code=%d body=%s", rec.Code, rec.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil || created.ID == 0 {
		t.Fatalf("create body=%s err=%v", rec.Body.String(), err)
	}

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list code=%d", rec.Code)
	}
	var got []struct {
		ID    int64  `json:"id"`
		Name  string `json:"name"`
		Last4 string `json:"last4"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, rec.Body.String())
	}
	if len(got) != 1 || got[0].Name != "DIB Current" || got[0].Last4 != "1234" {
		t.Fatalf("list = %+v", got)
	}

	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/accounts/1", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("delete code=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))
	if body := strings.TrimSpace(rec.Body.String()); body != "[]" {
		t.Errorf("after delete list = %s, want []", body)
	}
}

// TestDeleteAccountBlockedByBalanceHistory: account_balances is ON DELETE
// CASCADE and check-ins are net-worth ground truth — deleting an account with
// history used to silently rewrite past net-worth points. With history the
// delete 409s (deactivation is the reversible "stop counting this account");
// hard delete stays available for accounts that never checked in.
func TestDeleteAccountBlockedByBalanceHistory(t *testing.T) {
	srv, st := newAccountsServer(t)
	id, err := st.InsertAccount("Third", "ENBD", "9999")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertAccountBalance(store.AccountBalanceRow{
		AccountID: id, BalanceFils: 250_000,
	}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/accounts/"+itoa(id), nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("delete with history: status = %d, want 409; body: %s", rec.Code, rec.Body)
	}
	var resp map[string]any
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["error"] != "in use" || resp["balances"] != float64(1) {
		t.Fatalf("unexpected 409 body: %+v", resp)
	}
	// Account and its history survived.
	if _, ok, err := st.SelectAccount(id); err != nil || !ok {
		t.Fatalf("account gone after blocked delete: ok=%v err=%v", ok, err)
	}
	if n, _ := st.AccountBalanceCount(id); n != 1 {
		t.Fatalf("balance history rows = %d, want 1 intact", n)
	}
}

func TestAccountsCreateValidation(t *testing.T) {
	srv, _ := newAccountsServer(t)
	for _, body := range []string{
		`{"name":"","last4":"1234"}`,  // empty name
		`{"name":"X","last4":"12"}`,   // short last4
		`{"name":"X","last4":"12ab"}`, // non-digit last4
	} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest("POST", "/api/accounts", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: code=%d, want 400", body, rec.Code)
		}
	}
}

func TestAccountsUnavailableWithoutStore(t *testing.T) {
	st := newTestServerStore(t)
	srv := newTestServerWithStore(t, st) // no SetAccountsStore
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest("GET", "/api/accounts", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("code=%d, want 503", rec.Code)
	}
}

func TestPutAccountKind(t *testing.T) {
	srv, st := newAccountsServer(t)
	id, err := st.InsertAccount("Broker", "IBKR", "")
	if err != nil {
		t.Fatal(err)
	}

	w := doJSON(t, srv, "PUT", "/api/accounts/"+itoa(id), map[string]any{"kind": "tracking"})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT kind status = %d; body: %s", w.Code, w.Body)
	}
	var dto struct {
		ID   int64  `json:"id"`
		Kind string `json:"kind"`
	}
	json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.ID != id || dto.Kind != "tracking" {
		t.Fatalf("dto = %+v, want kind tracking", dto)
	}

	// List exposes kind too.
	w = doJSON(t, srv, "GET", "/api/accounts", nil)
	var list []struct {
		ID   int64  `json:"id"`
		Kind string `json:"kind"`
	}
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list) != 1 || list[0].Kind != "tracking" {
		t.Fatalf("list = %+v, want single tracking account", list)
	}

	tests := []struct {
		name, path string
		body       map[string]any
		want       int
	}{
		{"bad kind", "/api/accounts/" + itoa(id), map[string]any{"kind": "offshore"}, http.StatusBadRequest},
		{"missing account", "/api/accounts/424242", map[string]any{"kind": "budget"}, http.StatusNotFound},
		{"bad id", "/api/accounts/abc", map[string]any{"kind": "budget"}, http.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if w := doJSON(t, srv, "PUT", tc.path, tc.body); w.Code != tc.want {
				t.Errorf("status = %d, want %d; body: %s", w.Code, tc.want, w.Body)
			}
		})
	}
}
