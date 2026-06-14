// Package server wires ledger's HTTP surface: a JSON API under /api and the
// embedded SPA served from everything else, on a single origin.
package server

import (
	"io/fs"
	"net/http"
)

// HealthChecker is the minimal dependency the health endpoint needs. The store
// satisfies it; tests supply a fake.
type HealthChecker interface {
	Ping() error
}

// Server holds the router and its dependencies.
type Server struct {
	mux   *http.ServeMux
	store HealthChecker
}

// New builds a Server that serves /api/health and the embedded webFS bundle.
func New(store HealthChecker, webFS fs.FS) *Server {
	s := &Server{
		mux:   http.NewServeMux(),
		store: store,
	}
	s.routes(webFS)
	return s
}

func (s *Server) routes(webFS fs.FS) {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	// Everything else is the SPA bundle.
	s.mux.Handle("/", http.FileServer(http.FS(webFS)))
}

// ServeHTTP makes Server an http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}
