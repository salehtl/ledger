// Package server wires ledger's HTTP surface: a JSON API under /api and the
// embedded SPA served from everything else, on a single origin.
package server

import (
	"context"
	"io/fs"
	"net/http"
	"time"

	"ledger/internal/store"
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

// Reprocessor re-runs the parse cascade over retained raw email. bank is an
// optional sender/bank filter ("" = all).
type Reprocessor interface {
	Reprocess(ctx context.Context, bank string) (int, error)
}

// CategorizeFunc is called by POST /api/recategorize for each needs_review transaction.
type CategorizeFunc func(ctx context.Context, merchantRaw string) (categoryID int64, status string, ok bool)

// CategoryStore is the subset of store methods the category/review/transaction handlers need.
type CategoryStore interface {
	SelectCategories() ([]store.CategoryRow, error)
	InsertCategory(store.CategoryRow) (int64, error)
	SelectRules() ([]store.RuleRow, error)
	InsertRule(store.RuleRow) error
	SelectNeedsReview() ([]store.ReviewItem, error)
	SelectTransactions(status, from, to string) ([]store.ReviewItem, error)
	UpdateTransactionCategory(txID, catID int64, status string) error
	UpdateTransactionStatus(txID int64, status string) error
}

// Server holds the router and its dependencies.
type Server struct {
	mux            *http.ServeMux
	store          HealthChecker
	ingest         IngestStatus
	imapConfigured bool
	reprocessor    Reprocessor
	catStore       CategoryStore
	recatFn        CategorizeFunc
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

// SetReprocessor enables POST /api/reprocess.
func (s *Server) SetReprocessor(r Reprocessor) { s.reprocessor = r }

// SetCategoryStore wires the category/review/transaction handlers.
func (s *Server) SetCategoryStore(cs CategoryStore) { s.catStore = cs }

// SetRecategorizeFn wires the bulk-categorize function used by POST /api/recategorize.
func (s *Server) SetRecategorizeFn(fn CategorizeFunc) { s.recatFn = fn }

func (s *Server) routes(webFS fs.FS) {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("POST /api/reprocess", s.handleReprocess)
	s.mux.HandleFunc("GET /api/categories", s.handleGetCategories)
	s.mux.HandleFunc("POST /api/categories", s.handlePostCategory)
	s.mux.HandleFunc("GET /api/review", s.handleGetReview)
	s.mux.HandleFunc("GET /api/transactions", s.handleGetTransactions)
	s.mux.HandleFunc("POST /api/transactions/{id}/categorize", s.handleCategorize)
	s.mux.HandleFunc("POST /api/transactions/{id}/status", s.handleSetStatus)
	s.mux.HandleFunc("POST /api/recategorize", s.handleRecategorize)
	// Unknown /api/* paths return 404 so the SPA fallback never swallows them.
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	// Everything else is the SPA bundle.
	s.mux.Handle("/", spaHandler(webFS))
}

// ServeHTTP makes Server an http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}
