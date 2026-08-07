package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"ledger/internal/budget"
	"ledger/internal/store"
)

// EnvelopeStore is the store surface the envelope endpoints need. Both
// mutation batches (move legs, auto-assign deltas) run inside a single store
// transaction — a mid-write failure must never leave assigned money vanished
// or a half-applied plan.
type EnvelopeStore interface {
	EnvelopeMonthSummary(month string) ([]store.EnvelopeMonthRow, error)
	SelectCategoryTargetsForMonth(month string) ([]store.CategoryTargetRow, error)
	SelectBudgetConfig() (store.BudgetConfig, error)
	SelectMonthIncome(period string) (int64, error)
	UpsertEnvelopeAssignments(month string, byCategory map[int64]int64) error
	MoveEnvelopeAssignment(month string, fromCategoryID, toCategoryID, amountFils int64) error
	ApplyEnvelopeDeltas(month string, deltas []store.EnvelopeDelta) error
	SeedEnvelopeAssignmentsFromPreviousMonth(month string) (int, error)
}

// SetEnvelopeStore wires the envelope store. Required for /api/envelopes.
func (s *Server) SetEnvelopeStore(es EnvelopeStore) { s.envelopeStore = es }

// envelopeMonth resolves the ?month= param (default: current UTC month) and
// validates the YYYY-MM shape. ok=false after writing a 400.
func envelopeMonth(w http.ResponseWriter, r *http.Request) (string, bool) {
	month := r.URL.Query().Get("month")
	if month == "" {
		return time.Now().UTC().Format("2006-01"), true
	}
	if _, err := time.Parse("2006-01", month); err != nil {
		errJSON(w, http.StatusBadRequest, "bad month (want YYYY-MM)")
		return "", false
	}
	return month, true
}

// computeEnvelopeSummary assembles one month's EnvelopeSummary: store rows +
// targets + income resolved by the same config-vs-income-categories switch the
// jar summary uses. Also returns the budget config for callers that plan
// (auto-assign) or evaluate thresholds.
func (s *Server) computeEnvelopeSummary(month string) (budget.EnvelopeSummary, store.BudgetConfig, error) {
	cfg, err := s.envelopeStore.SelectBudgetConfig()
	if err != nil {
		return budget.EnvelopeSummary{}, cfg, err
	}
	income := cfg.MonthlyIncome
	if cfg.IncomeSource == "categories" {
		if income, err = s.envelopeStore.SelectMonthIncome(month); err != nil {
			return budget.EnvelopeSummary{}, cfg, err
		}
	}
	rows, err := s.envelopeStore.EnvelopeMonthSummary(month)
	if err != nil {
		return budget.EnvelopeSummary{}, cfg, err
	}
	targets, err := s.envelopeStore.SelectCategoryTargetsForMonth(month)
	if err != nil {
		return budget.EnvelopeSummary{}, cfg, err
	}
	sum, err := budget.ComputeEnvelopes(month, income, rows, targets)
	if err != nil {
		return budget.EnvelopeSummary{}, cfg, err
	}
	if sum.Envelopes == nil {
		sum.Envelopes = []budget.Envelope{}
	}
	return sum, cfg, nil
}

// writeEnvelopeSummary recomputes and writes the month's summary — the shared
// success response of every envelope mutation, so the client always has fresh
// RTA and availability without a second round trip.
func (s *Server) writeEnvelopeSummary(w http.ResponseWriter, month string) {
	sum, _, err := s.computeEnvelopeSummary(month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sum)
}

func (s *Server) handleGetEnvelopes(w http.ResponseWriter, r *http.Request) {
	if s.envelopeStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "envelopes unavailable")
		return
	}
	month, ok := envelopeMonth(w, r)
	if !ok {
		return
	}
	// Opening a month the user has never planned carries the previous month's
	// assignments into it, so a stable budget survives the month boundary
	// without being re-typed. This is a write on a GET — a real smell, kept
	// because the alternative (a month-rollover job) can only ever seed the
	// CURRENT month, so planning ahead would still land on an empty screen.
	// The store guards it to fire at most once per month and never on history;
	// envelopeMu is the same lock the mutation handlers take, so two
	// simultaneous page loads cannot double-seed.
	//
	// A seeding failure must not blank the screen: log nothing, fall through,
	// and serve the (unseeded) summary rather than 500.
	s.envelopeMu.Lock()
	_, _ = s.envelopeStore.SeedEnvelopeAssignmentsFromPreviousMonth(month)
	s.envelopeMu.Unlock()

	s.writeEnvelopeSummary(w, month)
}

// assignReq is the body of POST /api/envelopes/assign: absolute (batch) sets.
type assignReq struct {
	Month       string `json:"month"`
	Assignments []struct {
		CategoryID   int64 `json:"category_id"`
		AssignedFils int64 `json:"assigned_fils"`
	} `json:"assignments"`
}

func (s *Server) handleEnvelopesAssign(w http.ResponseWriter, r *http.Request) {
	if s.envelopeStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "envelopes unavailable")
		return
	}
	s.envelopeMu.Lock()
	defer s.envelopeMu.Unlock()
	var req assignReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(req.Assignments) == 0 {
		errJSON(w, http.StatusBadRequest, "assignments required")
		return
	}
	byCategory := make(map[int64]int64, len(req.Assignments))
	for _, a := range req.Assignments {
		if a.AssignedFils < 0 {
			errJSON(w, http.StatusBadRequest, "assigned_fils must be >= 0")
			return
		}
		byCategory[a.CategoryID] = a.AssignedFils
	}
	err := s.envelopeStore.UpsertEnvelopeAssignments(req.Month, byCategory)
	if errors.Is(err, store.ErrEnvelopeInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFKViolation(err) {
		errJSON(w, http.StatusBadRequest, "unknown category")
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	s.EvaluateBudgetThresholds()
	s.writeEnvelopeSummary(w, req.Month)
}

// moveReq is the body of POST /api/envelopes/move — YNAB's roll-with-the-
// punches: take amount_fils from one envelope's assignment, give it to
// another, same month.
type moveReq struct {
	Month          string `json:"month"`
	FromCategoryID int64  `json:"from_category_id"`
	ToCategoryID   int64  `json:"to_category_id"`
	AmountFils     int64  `json:"amount_fils"`
}

func (s *Server) handleEnvelopesMove(w http.ResponseWriter, r *http.Request) {
	if s.envelopeStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "envelopes unavailable")
		return
	}
	s.envelopeMu.Lock()
	defer s.envelopeMu.Unlock()
	var req moveReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.AmountFils <= 0 {
		errJSON(w, http.StatusBadRequest, "amount_fils must be > 0")
		return
	}
	if req.FromCategoryID <= 0 || req.ToCategoryID <= 0 || req.FromCategoryID == req.ToCategoryID {
		errJSON(w, http.StatusBadRequest, "from_category_id and to_category_id must differ")
		return
	}
	// One store transaction moves both legs: either the source loses and the
	// destination gains, or nothing changes — assigned money can never vanish.
	if err := s.envelopeStore.MoveEnvelopeAssignment(req.Month, req.FromCategoryID, req.ToCategoryID, req.AmountFils); err != nil {
		if errors.Is(err, store.ErrEnvelopeInvalid) {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if isFKViolation(err) {
			errJSON(w, http.StatusBadRequest, "unknown category")
			return
		}
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	s.EvaluateBudgetThresholds()
	s.writeEnvelopeSummary(w, req.Month)
}

// autoAssignReq is the body of POST /api/envelopes/auto-assign.
type autoAssignReq struct {
	Month string `json:"month"`
}

// autoAssignResp reports what the planner did plus the fresh summary.
type autoAssignResp struct {
	Allocations []budget.Allocation    `json:"allocations"`
	Summary     budget.EnvelopeSummary `json:"summary"`
}

func (s *Server) handleEnvelopesAutoAssign(w http.ResponseWriter, r *http.Request) {
	if s.envelopeStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "envelopes unavailable")
		return
	}
	// The lock must span compute→apply: auto-assign plans against a summary it
	// read outside the store transaction, so two interleaved requests could
	// both see the same positive RTA and both apply full plans (RTA negative).
	s.envelopeMu.Lock()
	defer s.envelopeMu.Unlock()
	var req autoAssignReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Month == "" {
		req.Month = time.Now().UTC().Format("2006-01")
	}
	if _, err := time.Parse("2006-01", req.Month); err != nil {
		errJSON(w, http.StatusBadRequest, "bad month (want YYYY-MM)")
		return
	}
	sum, cfg, err := s.computeEnvelopeSummary(req.Month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	allocations := budget.AutoAssign(sum, cfg)
	// The whole plan lands in one store transaction, so the response's
	// "allocations are the deltas applied" contract holds even under failure.
	deltas := make([]store.EnvelopeDelta, len(allocations))
	for i, a := range allocations {
		deltas[i] = store.EnvelopeDelta{CategoryID: a.CategoryID, DeltaFils: a.AmountFils}
	}
	if err := s.envelopeStore.ApplyEnvelopeDeltas(req.Month, deltas); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	if allocations == nil {
		allocations = []budget.Allocation{}
	}
	fresh, _, err := s.computeEnvelopeSummary(req.Month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	s.EvaluateBudgetThresholds()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(autoAssignResp{Allocations: allocations, Summary: fresh})
}
