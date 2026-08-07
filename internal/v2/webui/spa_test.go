package webui

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func testFS() fs.FS {
	return fstest.MapFS{
		"index.html":           {Data: []byte("<!doctype html><title>ledger</title>")},
		"assets/app-abc.js":    {Data: []byte("console.log(1)")},
		"sw.js":                {Data: []byte("// service worker")},
		"apple-touch-icon.png": {Data: []byte("\x89PNG")},
	}
}

func get(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestRootServesTheIndex(t *testing.T) {
	rec := get(t, Handler(testFS()), "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET / = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>ledger</title>") {
		t.Fatalf("GET / did not serve index.html: %s", rec.Body.String())
	}
}

func TestClientRoutesFallBackToTheIndex(t *testing.T) {
	h := Handler(testFS())
	for _, p := range []string{"/budget", "/onboarding/passkey", "/transactions/2026-08"} {
		rec := get(t, h, p)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want the SPA fallback", p, rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "<title>ledger</title>") {
			t.Fatalf("GET %s did not fall back to index.html", p)
		}
	}
}

// THE property. An unknown /api/ path must never be answered with the app
// shell: a sync client would parse an HTML document as a sync response and the
// failure would surface nowhere near the mistyped route.
func TestUnknownAPIPathsAreNeverSwallowedByTheFallback(t *testing.T) {
	h := Handler(testFS())
	for _, p := range []string{"/api", "/api/", "/api/v1/nope", "/api/v1/sync"} {
		rec := get(t, h, p)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404 (the fallback must decline /api/)", p, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<title>ledger</title>") {
			t.Fatalf("GET %s was answered with the app shell", p)
		}
	}
}

func TestHashedAssetsAreImmutableAndEntryPointsRevalidate(t *testing.T) {
	h := Handler(testFS())
	cases := map[string]string{
		"/assets/app-abc.js":    "public, max-age=31536000, immutable",
		"/sw.js":                "no-cache",
		"/":                     "no-cache",
		"/apple-touch-icon.png": "public, max-age=86400",
		// A client route serves index.html, so it must revalidate too.
		"/budget": "no-cache",
	}
	for p, want := range cases {
		if got := get(t, h, p).Header().Get("Cache-Control"); got != want {
			t.Errorf("Cache-Control for %s = %q, want %q", p, got, want)
		}
	}
}

// The embedded bundle must actually be there: //go:embed all:dist compiles as
// long as the directory exists, even if it is empty, and an empty bundle is a
// binary that serves a blank page.
func TestTheEmbeddedBundleContainsAnIndex(t *testing.T) {
	files, err := FS()
	if err != nil {
		t.Fatalf("FS: %v", err)
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		t.Fatalf("the embedded dist has no index.html — run (cd web && bun run build): %v", err)
	}
}
