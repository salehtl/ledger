// internal/server/insights.go
package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"ledger/internal/store"
)

// InsightsStore is the read surface the insights endpoints need.
type InsightsStore interface {
	SelectCategorySpend(period string, frozen bool) ([]store.CategorySpendRow, error)
	SelectMonthlyTotals(months int) ([]store.MonthlyTotalRow, error)
	SelectBudgetConfig() (store.BudgetConfig, error)
}

// SetInsightsStore wires the insights read store. Required for /api/insights/*.
func (s *Server) SetInsightsStore(i InsightsStore) { s.insightsStore = i }

type categorySpendDTO struct {
	CategoryID int64  `json:"category_id"`
	Name       string `json:"name"`
	Bucket     string `json:"bucket"`
	Spent      int64  `json:"spent"`
}

type trendDTO struct {
	Period string `json:"period"`
	Spent  int64  `json:"spent"`
	Income int64  `json:"income"`
}

func (s *Server) handleGetCategorySpend(w http.ResponseWriter, r *http.Request) {
	if s.insightsStore == nil {
		http.Error(w, "insights unavailable", http.StatusServiceUnavailable)
		return
	}
	period := r.URL.Query().Get("period")
	if period == "" {
		period = time.Now().UTC().Format("2006-01")
	}
	cfg, err := s.insightsStore.SelectBudgetConfig()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	rows, err := s.insightsStore.SelectCategorySpend(period, cfg.FreezeHistory)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]categorySpendDTO, 0, len(rows))
	for _, c := range rows {
		out = append(out, categorySpendDTO{c.CategoryID, c.Name, c.Bucket, c.AmountFils})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handleGetTrend(w http.ResponseWriter, r *http.Request) {
	if s.insightsStore == nil {
		http.Error(w, "insights unavailable", http.StatusServiceUnavailable)
		return
	}
	months := 6
	if v := r.URL.Query().Get("months"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 24 {
			months = n
		}
	}
	rows, err := s.insightsStore.SelectMonthlyTotals(months)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]trendDTO, 0, len(rows))
	for _, m := range rows {
		out = append(out, trendDTO{m.Period, m.SpentFils, m.IncomeFils})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
