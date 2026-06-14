package server

import (
	"encoding/json"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

type categorizeReq struct {
	CategoryID  int64  `json:"category_id"`
	MerchantRaw string `json:"merchant_raw"`
	MakeRule    bool   `json:"make_rule"`
}

func (s *Server) handleCategorize(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categorize unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req categorizeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.CategoryID == 0 {
		http.Error(w, `{"error":"category_id required"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.UpdateTransactionCategory(txID, req.CategoryID, "confirmed"); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if req.MakeRule && req.MerchantRaw != "" {
		_ = s.catStore.InsertRule(store.RuleRow{
			MatchType:  "contains",
			Pattern:    req.MerchantRaw,
			CategoryID: req.CategoryID,
			Priority:   100,
			Source:     "manual",
		})
	}
	s.hub.broadcast("tx")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *Server) handleGetTransactions(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"transactions unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	q := r.URL.Query()
	items, err := s.catStore.SelectTransactions(q.Get("status"), q.Get("from"), q.Get("to"))
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []store.ReviewItem{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}

func (s *Server) handleRecategorize(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	items, err := s.catStore.SelectNeedsReview()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	processed := 0
	if s.recatFn != nil {
		for _, item := range items {
			catID, status, ok := s.recatFn(r.Context(), item.MerchantRaw)
			if !ok {
				continue
			}
			if err := s.catStore.UpdateTransactionCategory(item.ID, catID, status); err == nil {
				processed++
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"processed": processed})
}

var validStatuses = map[string]bool{
	"confirmed":    true,
	"ignored":      true,
	"transfer":     true,
	"needs_review": true,
}

type setStatusReq struct {
	Status string `json:"status"`
}

func (s *Server) handleSetStatus(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req setStatusReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Status == "" {
		http.Error(w, `{"error":"status required"}`, http.StatusBadRequest)
		return
	}
	if !validStatuses[req.Status] {
		http.Error(w, `{"error":"invalid status"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.UpdateTransactionStatus(txID, req.Status); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	s.hub.broadcast("tx")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
