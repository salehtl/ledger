package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// fakeChecker lets us drive the health handler's two branches.
type fakeChecker struct{ err error }

func (f fakeChecker) Ping() error { return f.err }

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>ledger</html>")},
	}
}

func TestHealthOK(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Status string `json:"status"`
		DB     string `json:"db"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "ok" || body.DB != "ok" {
		t.Errorf("body = %+v, want status=ok db=ok", body)
	}
}

func TestHealthDBUnreachable(t *testing.T) {
	srv := New(fakeChecker{err: http.ErrAbortHandler}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestServesIndexAtRoot(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "<html>ledger</html>" {
		t.Errorf("body = %q, want the index.html contents", got)
	}
}
