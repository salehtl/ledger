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
	SelectEarliestPeriod() (string, bool, error)
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
	q := r.URL.Query()
	cur := now.Format("2006-01")

	// Resolve which months this summary spans. A single ?period= (or none) is the
	// month-at-a-glance default; from/to and all=1 aggregate across the span.
	var months []string
	switch {
	case q.Get("all") != "":
		earliest, ok, derr := s.budgetStore.SelectEarliestPeriod()
		if derr != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
		if !ok {
			earliest = cur
		}
		if months, err = monthsBetween(earliest, cur); err != nil {
			http.Error(w, "bad range", http.StatusBadRequest)
			return
		}
	case q.Get("from") != "" || q.Get("to") != "":
		if months, err = monthsBetween(q.Get("from"), q.Get("to")); err != nil {
			http.Error(w, "bad range", http.StatusBadRequest)
			return
		}
	default:
		period := q.Get("period")
		if period == "" {
			period = cur
		}
		if _, perr := time.Parse("2006-01", period); perr != nil {
			http.Error(w, "bad period", http.StatusBadRequest)
			return
		}
		months = []string{period}
	}

	// Aggregate spend + income across every month in the span. progress is the
	// elapsed fraction: past months count whole, the current month by its day
	// progress, future months as zero.
	var spend []store.SpendRow
	var income int64
	elapsed := 0.0
	for _, m := range months {
		rows, derr := s.budgetStore.SelectMonthSpend(m, cfg.FreezeHistory)
		if derr != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
		spend = append(spend, rows...)
		if cfg.IncomeSource == "categories" {
			mi, derr := s.budgetStore.SelectMonthIncome(m)
			if derr != nil {
				http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
				return
			}
			income += mi
		} else {
			income += cfg.MonthlyIncome
		}
		switch {
		case m < cur:
			elapsed += 1
		case m == cur:
			elapsed += budget.MonthProgress(now)
		}
	}
	progress := elapsed / float64(len(months))

	recent, err := s.budgetStore.SelectRecent(10)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if recent == nil {
		recent = []store.ReviewItem{}
	}

	// Single month keeps its bare "YYYY-MM" label; a span is "from..to".
	period := months[0]
	if len(months) > 1 {
		period = months[0] + ".." + months[len(months)-1]
	}
	sum := budget.ComputeRange(cfg, income, spend, recent, period, progress)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(sum)
}

// monthsBetween lists the inclusive "YYYY-MM" months from..to in ascending order.
// Either bound may be the earlier one; the span is capped so a pathological
// request can't spin forever.
func monthsBetween(from, to string) ([]string, error) {
	ft, err := time.Parse("2006-01", from)
	if err != nil {
		return nil, err
	}
	tt, err := time.Parse("2006-01", to)
	if err != nil {
		return nil, err
	}
	if tt.Before(ft) {
		ft, tt = tt, ft
	}
	var out []string
	for m := ft; !m.After(tt) && len(out) < 600; m = m.AddDate(0, 1, 0) {
		out = append(out, m.Format("2006-01"))
	}
	return out, nil
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
