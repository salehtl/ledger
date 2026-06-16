// Package server wires ledger's HTTP surface: a JSON API under /api and the
// embedded SPA served from everything else, on a single origin.
package server

import (
	"context"
	"io/fs"
	"net/http"
	"time"

	"ledger/internal/monitor"
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
	DeleteRule(id int64) error
	SelectNeedsReview() ([]store.ReviewItem, error)
	SelectTransactions(status, from, to string) ([]store.ReviewItem, error)
	UpdateTransactionCategory(txID, catID int64, status string) error
	UpdateTransactionStatus(txID int64, status string) error
	UpdateCategory(store.CategoryRow) error
	SnapshotBucketForCategory(categoryID int64, bucket string) error
	CategoryUsage(id int64) (txns int, rules int, err error)
	DeleteCategory(id int64) error
}

// PushStore is the subset of the store needed by push-subscription handlers.
type PushStore interface {
	InsertPushSub(store.PushSubRow) error
	SelectPushSubs() ([]store.PushSubRow, error)
	DeletePushSub(endpoint string) error
}

// PushSender delivers web push notifications.
type PushSender interface {
	Send(ctx context.Context, endpoint, p256dh, auth string, payload []byte) error
	PublicKey() string
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
	budgetStore    BudgetStore
	insightsStore  InsightsStore
	hub            *Hub                // SSE fan-out hub
	driftMon       DriftStatusProvider // optional drift monitor for /api/health
	pushStore       PushStore
	pushSender      PushSender
	settingsStore   SettingsStore
	ruleActiveStore RuleActiveStore
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

// DriftStatusProvider surfaces the monitor's current alert list for /api/health.
type DriftStatusProvider interface {
	Alerts() []monitor.DriftAlert
}

// SetHub wires the SSE hub. Required for GET /api/events.
func (s *Server) SetHub(h *Hub) { s.hub = h }

// SetDriftMonitor wires the drift monitor into /api/health.
func (s *Server) SetDriftMonitor(m DriftStatusProvider) { s.driftMon = m }

// SetPushStore wires the push subscription store.
func (s *Server) SetPushStore(ps PushStore) { s.pushStore = ps }

// SetPushSender wires the VAPID push sender.
func (s *Server) SetPushSender(ps PushSender) { s.pushSender = ps }

// BroadcastEvent is a convenience wrapper over the hub (no-op if hub is nil).
func (s *Server) BroadcastEvent(eventType string, data any) {
	if s.hub != nil {
		s.hub.BroadcastEvent(eventType, data)
	}
}

func (s *Server) routes(webFS fs.FS) {
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("POST /api/reprocess", s.handleReprocess)
	s.mux.HandleFunc("GET /api/categories", s.handleGetCategories)
	s.mux.HandleFunc("POST /api/categories", s.handlePostCategory)
	s.mux.HandleFunc("PUT /api/categories/{id}", s.handlePutCategory)
	s.mux.HandleFunc("GET /api/categories/{id}/usage", s.handleGetCategoryUsage)
	s.mux.HandleFunc("GET /api/review", s.handleGetReview)
	s.mux.HandleFunc("GET /api/transactions", s.handleGetTransactions)
	s.mux.HandleFunc("POST /api/transactions/{id}/categorize", s.handleCategorize)
	s.mux.HandleFunc("POST /api/transactions/{id}/status", s.handleSetStatus)
	s.mux.HandleFunc("POST /api/recategorize", s.handleRecategorize)
	s.mux.HandleFunc("GET /api/settings", s.handleGetSettings)
	s.mux.HandleFunc("PUT /api/settings", s.handlePutSettings)
	s.mux.HandleFunc("GET /api/rules", s.handleGetRules)
	s.mux.HandleFunc("POST /api/rules", s.handlePostRule)
	s.mux.HandleFunc("DELETE /api/rules/{id}", s.handleDeleteRule)
	s.mux.HandleFunc("PUT /api/rules/{id}/active", s.handleSetRuleActive)
	s.mux.HandleFunc("GET /api/summary", s.handleGetSummary)
	s.mux.HandleFunc("GET /api/budget", s.handleGetBudget)
	s.mux.HandleFunc("PUT /api/budget", s.handlePutBudget)
	s.mux.HandleFunc("GET /api/insights/categories", s.handleGetCategorySpend)
	s.mux.HandleFunc("GET /api/insights/trend", s.handleGetTrend)
	s.mux.HandleFunc("GET /api/events", s.handleEvents)
	s.mux.HandleFunc("POST /api/push/subscribe", s.handlePushSubscribe)
	s.mux.HandleFunc("DELETE /api/push/subscribe", s.handlePushUnsubscribe)
	s.mux.HandleFunc("GET /api/push/vapid-public", s.handleVapidPublicKey)
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
