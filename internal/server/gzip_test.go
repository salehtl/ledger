package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzGet(t *testing.T, h http.Handler, path string, acceptGzip bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptGzip {
		req.Header.Set("Accept-Encoding", "gzip")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGzipCompressesAssetThroughServer(t *testing.T) {
	srv := New(nil, fstest())
	rec := gzGet(t, srv, "/assets/app.js", true)
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary = %q, want Accept-Encoding", rec.Header().Get("Vary"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil || string(body) != "console.log('app')" {
		t.Fatalf("round-trip = %q, %v", body, err)
	}
}

func TestGzipSkippedWithoutAcceptEncoding(t *testing.T) {
	srv := New(nil, fstest())
	rec := gzGet(t, srv, "/assets/app.js", false)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want none", got)
	}
	if rec.Body.String() != "console.log('app')" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}

func TestGzipSkipsEventStreamPath(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("data: hello\n\n"))
	})
	rec := gzGet(t, withGzip(inner), "/api/events", true)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("SSE Content-Encoding = %q, want none", got)
	}
	if rec.Body.String() != "data: hello\n\n" {
		t.Fatalf("SSE body = %q", rec.Body.String())
	}
}

func TestGzipCompressesJSON(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	rec := gzGet(t, withGzip(inner), "/api/anything", true)
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
}

func TestGzipSkipsAlreadyCompressedTypes(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "font/woff2")
		w.Write([]byte("binaryfontbytes"))
	})
	rec := gzGet(t, withGzip(inner), "/assets/font.woff2", true)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("woff2 Content-Encoding = %q, want none", got)
	}
}

func TestGzipSkipsRangeRequests(t *testing.T) {
	srv := New(nil, fstest())
	req := httptest.NewRequest(http.MethodGet, "/assets/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-4")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("ranged Content-Encoding = %q, want none", got)
	}
}

func TestGzipFlushBeforeWriteStillCompresses(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.(http.Flusher).Flush()
		w.Write([]byte(`{"ok":true}`))
	})
	rec := gzGet(t, withGzip(inner), "/api/anything", true)
	if got := rec.Result().Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil || string(body) != `{"ok":true}` {
		t.Fatalf("round-trip = %q, %v", body, err)
	}
}
