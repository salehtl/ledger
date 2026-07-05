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
