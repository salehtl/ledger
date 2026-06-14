package server

import (
	"encoding/json"
	"net/http"

	"ledger/internal/store"
)

func (s *Server) handleGetReview(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"review unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	items, err := s.catStore.SelectNeedsReview()
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
