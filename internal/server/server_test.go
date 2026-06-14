package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	mapfs "testing/fstest"
	"time"
)

// fakeChecker lets us drive the health handler's two branches.
type fakeChecker struct{ err error }

func (f fakeChecker) Ping() error { return f.err }

func testFS() mapfs.MapFS {
	return mapfs.MapFS{
		"index.html": &mapfs.MapFile{Data: []byte("<html>ledger</html>")},
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

// fakeIngest drives the ingest portion of the health response.
type fakeIngest struct {
	count int
	last  time.Time
	ok    bool
}

func (f fakeIngest) CountIngest() (int, error)              { return f.count, nil }
func (f fakeIngest) LastIngestAt() (time.Time, bool, error) { return f.last, f.ok, nil }

func TestHealthIncludesIngestWhenSet(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	srv.SetIngest(fakeIngest{count: 3, last: time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC), ok: true}, true)

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	var body struct {
		Ingest *struct {
			Configured bool   `json:"configured"`
			Count      int    `json:"count"`
			LastAt     string `json:"last_at"`
		} `json:"ingest"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Ingest == nil {
		t.Fatal("expected ingest section in health response")
	}
	if !body.Ingest.Configured || body.Ingest.Count != 3 {
		t.Errorf("ingest = %+v, want configured=true count=3", *body.Ingest)
	}
}

func TestHealthOmitsIngestWhenUnset(t *testing.T) {
	srv := New(fakeChecker{err: nil}, testFS())
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if got := rec.Body.String(); contains(got, "\"ingest\"") {
		t.Errorf("did not expect ingest section when unset: %s", got)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
