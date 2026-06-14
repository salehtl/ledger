// Package server wires ledger's HTTP surface: a JSON API under /api and the
// embedded SPA served from everything else, on a single origin.
package server

import (
	"io/fs"
	"net/http"
	"time"
)

// HealthChecker is the minimal dependency the health endpoint needs. The store
// satisfies it; tests supply a fake.
type HealthChecker interface {
	Ping() error
}

// IngestStatus is the optional ingest data the health endpoint reports. The
// store satisfies it; if unset, /api/health omits the ingest section.
type IngestStatus interface {
	CountIngest() (int, error)
	LastIngestAt() (time.Time, bool, error)
}

// Server holds the router and its dependencies.
type Server struct {
	mux            *http.ServeMux
	store          HealthChecker
	ingest         IngestStatus
	imapConfigured bool
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

// SetIngest wires the optional ingest status into /api/health. configured
// reflects whether a mailbox is set in config.
func (s *Server) SetIngest(src IngestStatus, configured bool) {
	s.ingest = src
	s.imapConfigured = configured
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
