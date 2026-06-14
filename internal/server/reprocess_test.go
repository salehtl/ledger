package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeReprocessor struct {
	gotBank string
	n       int
}

func (f *fakeReprocessor) Reprocess(ctx context.Context, bank string) (int, error) {
	f.gotBank = bank
	return f.n, nil
}

func TestReprocessEndpoint(t *testing.T) {
	srv := New(fakeChecker{}, testFS())
	fr := &fakeReprocessor{n: 12}
	srv.SetReprocessor(fr)

	req := httptest.NewRequest(http.MethodPost, "/api/reprocess", strings.NewReader(`{"bank":"dib"}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var body struct {
		Processed int `json:"processed"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Processed != 12 {
		t.Errorf("processed = %d, want 12", body.Processed)
	}
	if fr.gotBank != "dib" {
		t.Errorf("bank = %q, want dib", fr.gotBank)
	}
}

func TestReprocessUnavailableWhenUnset(t *testing.T) {
	srv := New(fakeChecker{}, testFS())
	req := httptest.NewRequest(http.MethodPost, "/api/reprocess", strings.NewReader(`{}`))
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
