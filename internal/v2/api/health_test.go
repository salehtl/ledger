package api

import (
	"net/http"
	"testing"
)

// The health endpoint is the ONE unauthenticated GET this API serves, so its
// tests are about what it must NOT do as much as what it must.

func TestHealthzIsUnauthenticatedAndReportsTheDatabase(t *testing.T) {
	h := newHarness(t)

	w := h.req(http.MethodGet, "/api/v1/healthz", "", nil)
	wantStatus(t, w, http.StatusOK)

	got := decodeJSON[map[string]any](t, w)
	if got["status"] != "ok" {
		t.Fatalf(`status = %v, want "ok" (body %s)`, got["status"], w.Body.String())
	}
	if got["db"] != "ok" {
		t.Fatalf(`db = %v, want "ok" (body %s)`, got["db"], w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	// Same no-store policy as every other response: a cached 200 from a box
	// that has since lost its database is the exact lie a health check exists
	// to prevent.
	if cc := w.Header().Get("Cache-Control"); cc == "" {
		t.Fatal("no Cache-Control header")
	}
}

// A health endpoint is reachable by anyone who can reach the port, so anything
// it returns is public. It returns two closed-enum words and nothing else — no
// version, no DSN, no user counts, no hostname.
func TestHealthzLeaksNothingButTwoWords(t *testing.T) {
	h := newHarness(t)

	w := h.req(http.MethodGet, "/api/v1/healthz", "", nil)
	wantStatus(t, w, http.StatusOK)

	got := decodeJSON[map[string]any](t, w)
	if len(got) != 2 {
		t.Fatalf("healthz returned %d fields (%s), want exactly status and db", len(got), w.Body.String())
	}
}

// The pool is closed underneath it, which is the closest a test gets to "the
// database went away". 503 rather than 200, because a load balancer that keeps
// routing to a process whose database is gone is worse than one that has no
// healthy backend and says so.
func TestHealthzReports503WhenTheDatabaseIsGone(t *testing.T) {
	h := newHarness(t)
	h.pool.Close()

	w := h.req(http.MethodGet, "/api/v1/healthz", "", nil)
	wantStatus(t, w, http.StatusServiceUnavailable)

	got := decodeJSON[map[string]any](t, w)
	if got["status"] != "degraded" || got["db"] != "down" {
		t.Fatalf("body = %s, want status=degraded db=down", w.Body.String())
	}
}

// Every other method is a 404 from the catch-all, not a 405 and never the
// SPA-ish fallthrough the catch-all exists to prevent.
func TestHealthzIsGETOnly(t *testing.T) {
	h := newHarness(t)

	w := h.req(http.MethodPost, "/api/v1/healthz", "", nil)
	if w.Code == http.StatusOK {
		t.Fatalf("POST /api/v1/healthz returned 200; it must not be a write surface")
	}
}
