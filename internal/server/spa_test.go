package server

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"

	mapfs "testing/fstest"
)

// fstest returns a tiny in-memory bundle used by all server tests.
func fstest() fs.FS {
	return fstestFS
}

var fstestFS = mapfs.MapFS{
	"index.html":    {Data: []byte("<!doctype html><title>ledger</title>")},
	"assets/app.js": {Data: []byte("console.log('app')")},
}

func TestSPAServesAsset(t *testing.T) {
	srv := New(nil, fstest())
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "console.log('app')" {
		t.Fatalf("asset: code=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestSPAFallsBackToIndex(t *testing.T) {
	srv := New(nil, fstest())
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/review", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("fallback code = %d", rec.Code)
	}
	if got := rec.Body.String(); got == "" || got[0] != '<' {
		t.Errorf("fallback body = %q, want index.html", got)
	}
}

func TestSPAUnknownAPIIs404NotIndex(t *testing.T) {
	srv := New(nil, fstest())
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))
	if rec.Code == http.StatusOK {
		t.Errorf("unknown /api path returned 200 (served index?)")
	}
}
