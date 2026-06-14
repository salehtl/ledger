package server

import (
	"encoding/json"
	"math"
	"net/http"
	"time"

	"ledger/internal/budget"
	"ledger/internal/store"
)

// BudgetStore is the subset of store methods the budget/summary handlers need.
type BudgetStore interface {
	SelectBudgetConfig() (store.BudgetConfig, error)
	UpdateBudgetConfig(store.BudgetConfig) error
	SelectMonthSpend(period string, frozen bool) ([]store.SpendRow, error)
	SelectMonthIncome(period string) (int64, error)
	SelectRecent(n int) ([]store.ReviewItem, error)
}

// SetBudgetStore wires the summary + budget handlers.
func (s *Server) SetBudgetStore(b BudgetStore) { s.budgetStore = b }

// budgetJSON is the snake_case wire shape for /api/budget (both GET and PUT),
// keeping the budget config consistent with the rest of the snake_case API.
type budgetJSON struct {
	MonthlyIncome int64   `json:"monthly_income"`
	NeedPct       float64 `json:"need_pct"`
	WantPct       float64 `json:"want_pct"`
	SavingPct     float64 `json:"saving_pct"`
	IncomeSource  string  `json:"income_source"`
	FreezeHistory bool    `json:"freeze_history"`
}

func (s *Server) handleGetSummary(w http.ResponseWriter, r *http.Request) {
	if s.budgetStore == nil {
		http.Error(w, `{"error":"summary unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	cfg, err := s.budgetStore.SelectBudgetConfig()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	now := time.Now().UTC()
	period := now.Format("2006-01")

	income := cfg.MonthlyIncome
	if cfg.IncomeSource == "categories" {
		if income, err = s.budgetStore.SelectMonthIncome(period); err != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
	}
	spend, err := s.budgetStore.SelectMonthSpend(period, cfg.FreezeHistory)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	recent, err := s.budgetStore.SelectRecent(10)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if recent == nil {
		recent = []store.ReviewItem{}
	}
	sum := budget.Compute(cfg, income, spend, recent, now)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sum)
}

func (s *Server) handleGetBudget(w http.ResponseWriter, r *http.Request) {
	if s.budgetStore == nil {
		http.Error(w, `{"error":"budget unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	cfg, err := s.budgetStore.SelectBudgetConfig()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(budgetJSON{
		MonthlyIncome: cfg.MonthlyIncome,
		NeedPct:       cfg.NeedPct,
		WantPct:       cfg.WantPct,
		SavingPct:     cfg.SavingPct,
		IncomeSource:  cfg.IncomeSource,
		FreezeHistory: cfg.FreezeHistory,
	})
}

func (s *Server) handlePutBudget(w http.ResponseWriter, r *http.Request) {
	if s.budgetStore == nil {
		http.Error(w, `{"error":"budget unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req budgetJSON
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.IncomeSource != "config" && req.IncomeSource != "categories" {
		http.Error(w, `{"error":"income_source must be config or categories"}`, http.StatusBadRequest)
		return
	}
	if req.MonthlyIncome < 0 {
		http.Error(w, `{"error":"monthly_income must be >= 0"}`, http.StatusBadRequest)
		return
	}
	if sum := req.NeedPct + req.WantPct + req.SavingPct; math.Abs(sum-1.0) > 0.001 {
		http.Error(w, `{"error":"need/want/saving pcts must sum to 1.0"}`, http.StatusBadRequest)
		return
	}
	cfg := store.BudgetConfig{
		MonthlyIncome: req.MonthlyIncome,
		NeedPct:       req.NeedPct,
		WantPct:       req.WantPct,
		SavingPct:     req.SavingPct,
		IncomeSource:  req.IncomeSource,
		FreezeHistory: req.FreezeHistory,
	}
	if err := s.budgetStore.UpdateBudgetConfig(cfg); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
