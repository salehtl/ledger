package server

import (
	"encoding/json"
	"net/http"
	"strconv"

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

type updateCategoryReq struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	Bucket      string `json:"bucket"`
	ApplyToPast bool   `json:"apply_to_past"`
}

func (s *Server) handleDeleteCategory(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	txns, rules, err := s.catStore.CategoryUsage(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if txns > 0 || rules > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": "in use", "transactions": txns, "rules": rules})
		return
	}
	if err := s.catStore.DeleteCategory(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleGetCategoryUsage(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	txns, rules, err := s.catStore.CategoryUsage(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"transactions": txns, "rules": rules})
}

func (s *Server) handlePutCategory(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req updateCategoryReq
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
	if err := s.catStore.UpdateCategory(store.CategoryRow{ID: id, Name: req.Name, Kind: req.Kind, Bucket: req.Bucket}); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if req.ApplyToPast && req.Bucket != "" {
		if err := s.catStore.SnapshotBucketForCategory(id, req.Bucket); err != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
