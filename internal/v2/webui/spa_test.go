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

// The admin console is on its own tailnet-only listener and is not mounted here
// at all — but the fallback used to answer /admin/* with the app shell, which
// makes the deploy gate's "curl the console from off-tailnet, it must fail"
// step unable to tell a served console from a 200 page.
func TestAdminPathsAreDeclinedSoTheDeployGateMeansSomething(t *testing.T) {
	h := Handler(testFS())
	for _, p := range []string{"/admin", "/admin/", "/admin/templates", "/admin/quarantine"} {
		rec := get(t, h, p)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", p, rec.Code)
		}
	}
	// Not a false positive on a route that merely starts with the same letters.
	if rec := get(t, h, "/administration"); rec.Code != http.StatusOK {
		t.Fatalf("GET /administration = %d, want the SPA fallback", rec.Code)
	}
}

func TestCheckBundleRejectsABundleThatIsNotTheV2UI(t *testing.T) {
	// A v1-era bundle: real JavaScript, no /api/v1 anywhere. This is exactly
	// the state the committed dist was in when the reviewer caught it.
	v1 := fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html>")},
		"assets/app-x.js": {Data: []byte(`fetch("/api/categorize/run")`)},
	}
	if err := CheckBundle(v1); err == nil {
		t.Fatal("CheckBundle accepted a bundle with no /api/v1 reference")
	}
	// Nothing built at all.
	if err := CheckBundle(fstest.MapFS{"favicon.svg": {Data: []byte("<svg/>")}}); err == nil {
		t.Fatal("CheckBundle accepted a bundle with no scripts in it")
	}
	// A v2 bundle.
	v2 := fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html>")},
		"assets/app-y.js": {Data: []byte(`fetch(s+"/api/v1/sync",{})`)},
	}
	if err := CheckBundle(v2); err != nil {
		t.Fatalf("CheckBundle rejected a v2 bundle: %v", err)
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
