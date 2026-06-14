package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

type categorizeReq struct {
	CategoryID int64 `json:"category_id"`
	MakeRule   bool  `json:"make_rule"`
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
	if req.MakeRule {
		// Look up merchant_raw from the concrete *store.Store via type assertion
		if st, ok := s.catStore.(*store.Store); ok {
			var merchant string
			st.DB.QueryRow("SELECT COALESCE(merchant_raw,'') FROM transactions WHERE id=?", txID).Scan(&merchant)
			if merchant != "" {
				_ = s.catStore.InsertRule(store.RuleRow{
					MatchType:  "contains",
					Pattern:    merchant,
					CategoryID: req.CategoryID,
					Priority:   100,
					Source:     "manual",
				})
			}
		}
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintln(w, `{"ok":true}`)
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
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintln(w, `{"ok":true}`)
}
