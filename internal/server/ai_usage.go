package server

import (
	"encoding/json"
	"net/http"
	"time"

	"ledger/internal/store"
)

// AIUsageStore is the read surface the AI-usage endpoint needs.
type AIUsageStore interface {
	AIUsageStats(now int64) (store.AIUsageStats, error)
	RecentAIUsage(limit int) ([]store.AIUsageRow, error)
}

// SetAIUsageStore wires the AI-usage store. Required for GET /api/ai/usage.
func (s *Server) SetAIUsageStore(a AIUsageStore) { s.aiUsageStore = a }

type aiUsageRowDTO struct {
	At           int64  `json:"at"`
	Path         string `json:"path"`
	Model        string `json:"model"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
	CostMuUSD    int64  `json:"cost_musd"`
	OK           bool   `json:"ok"`
	Detail       string `json:"detail"`
}

func (s *Server) handleGetAIUsage(w http.ResponseWriter, r *http.Request) {
	if s.aiUsageStore == nil {
		http.Error(w, `{"error":"ai usage unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	stats, err := s.aiUsageStore.AIUsageStats(time.Now().Unix())
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	rows, err := s.aiUsageStore.RecentAIUsage(50)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	recent := make([]aiUsageRowDTO, 0, len(rows))
	for _, row := range rows {
		recent = append(recent, aiUsageRowDTO{
			At: row.At, Path: row.Path, Model: row.Model,
			InputTokens: row.InputTokens, OutputTokens: row.OutputTokens,
			CostMuUSD: row.CostMuUSD, OK: row.OK, Detail: row.Detail,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"count_30d":     stats.Count30d,
		"cost_30d_musd": stats.Cost30dMuUSD,
		"count_all":     stats.CountAll,
		"cost_all_musd": stats.CostAllMuUSD,
		"recent":        recent,
	})
}
