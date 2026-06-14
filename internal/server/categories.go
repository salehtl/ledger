package server

import (
	"encoding/json"
	"net/http"

	"ledger/internal/store"
)

func (s *Server) handleGetCategories(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	cats, err := s.catStore.SelectCategories()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if cats == nil {
		cats = []store.CategoryRow{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cats)
}

type createCategoryReq struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Bucket string `json:"bucket"`
}

func (s *Server) handlePostCategory(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req createCategoryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.Name == "" || req.Kind == "" {
		http.Error(w, `{"error":"name and kind are required"}`, http.StatusBadRequest)
		return
	}
	if req.Kind == "spending" && req.Bucket == "" {
		http.Error(w, `{"error":"bucket required for spending categories"}`, http.StatusBadRequest)
		return
	}
	id, err := s.catStore.InsertCategory(store.CategoryRow{
		Name:   req.Name,
		Kind:   req.Kind,
		Bucket: req.Bucket,
	})
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id})
}
