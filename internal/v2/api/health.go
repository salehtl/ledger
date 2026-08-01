package api

import (
	"context"
	"net/http"
	"time"
)

// healthzTimeout bounds the database probe.
//
// Short on purpose. A health check that blocks for as long as the pool's own
// connect timeout turns one sick database into a pile of stalled health
// requests, and every caller of this endpoint — a load balancer, a deploy
// script, the e2e harness's readiness loop — would rather have a fast "not
// yet" than a slow truth.
const healthzTimeout = 2 * time.Second

// healthBody is the WHOLE response. Two closed-enum words, deliberately.
//
// This is the only unauthenticated GET the API serves, so everything in it is
// public to anyone who can reach the port. That rules out the fields a health
// endpoint usually accretes: a build version tells an attacker which
// vulnerabilities apply, a hostname or DSN describes the deployment, and a
// user or row count is a business metric nobody outside should be able to
// poll. The admin console (tailnet-only, token-gated) is where detail belongs.
type healthBody struct {
	// Status is "ok" or "degraded".
	Status string `json:"status"`
	// DB is "ok" or "down".
	DB string `json:"db"`
}

// handleHealthz answers "is this process able to serve requests?".
//
// It PINGS the database rather than answering 200 unconditionally. A process
// whose pool is unreachable can still accept TCP connections and route
// requests — it just fails every one of them with a 500 — so a health check
// that only proves the router is mounted reports a box as healthy for the
// entire duration of a database outage, which is precisely when something
// needs to notice.
//
// It is mounted unconditionally and requires no session: a caller that needs a
// credential to ask whether the service is up cannot be a load balancer, and
// making it authenticated would only move the question to "is auth up?".
//
// The Cache-Control that writeJSON sets on every response matters more here
// than anywhere else: a cached 200 is a health check that reports the state of
// the past.
func (s *Server) handleHealthz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), healthzTimeout)
	defer cancel()

	if s.Pool == nil || s.Pool.Ping(ctx) != nil {
		// 503, not 200-with-a-sad-field. The status line is the part a load
		// balancer reads, and a body that says "degraded" under a 200 is a
		// body nothing consults.
		writeJSON(w, http.StatusServiceUnavailable, healthBody{Status: "degraded", DB: "down"})
		return
	}
	writeJSON(w, http.StatusOK, healthBody{Status: "ok", DB: "ok"})
}
