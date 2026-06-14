package server

import (
	"encoding/json"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

func (s *Server) handleGetRules(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"rules unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	rules, err := s.catStore.SelectRules()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if rules == nil {
		rules = []store.RuleRow{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(rules)
}

type createRuleReq struct {
	MatchType  string `json:"match_type"`
	Pattern    string `json:"pattern"`
	CategoryID int64  `json:"category_id"`
	Priority   int    `json:"priority"`
}

func (s *Server) handlePostRule(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"rules unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req createRuleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.MatchType == "" || req.Pattern == "" || req.CategoryID == 0 {
		http.Error(w, `{"error":"match_type, pattern, category_id required"}`, http.StatusBadRequest)
		return
	}
	if req.Priority == 0 {
		req.Priority = 100
	}
	if err := s.catStore.InsertRule(store.RuleRow{
		MatchType:  req.MatchType,
		Pattern:    req.Pattern,
		CategoryID: req.CategoryID,
		Priority:   req.Priority,
		Source:     "manual",
	}); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleDeleteRule(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"rules unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.DeleteRule(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
