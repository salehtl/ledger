package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"ledger/internal/store"
)

// writeCategoryDBErr maps a UNIQUE(name) violation to 409, anything else to 500.
func writeCategoryDBErr(w http.ResponseWriter, err error) {
	if strings.Contains(err.Error(), "UNIQUE") {
		http.Error(w, `{"error":"name exists"}`, http.StatusConflict)
		return
	}
	http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
}

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
		Name:     req.Name,
		Kind:     req.Kind,
		Bucket:   req.Bucket,
		IsActive: true,
	})
	if err != nil {
		writeCategoryDBErr(w, err)
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

// usageBody merges the usage counts into a response body. The DELETE conflict
// and the usage endpoint share it so the counts the UI disables its delete
// button on are literally the counts the guard refused on.
func usageBody(u store.CategoryUsage, into map[string]any) map[string]any {
	into["transactions"] = u.Transactions
	into["rules"] = u.Rules
	into["assignments"] = u.Assignments
	into["targets"] = u.Targets
	return into
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
	u, err := s.catStore.CategoryUsage(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	// Assigned envelope months and targets block too: both are ON DELETE
	// CASCADE, so deleting past this guard would silently discard budget state
	// (assigned totals and RTA, or a target the user typed) with no warning.
	if u.InUse() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(usageBody(u, map[string]any{"error": "in use"}))
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
	u, err := s.catStore.CategoryUsage(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(usageBody(u, map[string]any{}))
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
	// Changing kind away from 'spending' with envelope assignments on the
	// books would orphan them: EnvelopeMonthSummary lists only active spending
	// categories, so every assigned fil would silently vanish from Plan and
	// RTA would overstate — the exact rewrite of historical budget state the
	// DELETE guard 409s against. Same guard, same shape.
	if req.Kind != "spending" {
		u, err := s.catStore.CategoryUsage(id)
		if err != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
		// Only assignments block here, not targets: a kind change doesn't
		// cascade, so a target merely goes dormant while the category is
		// non-spending and comes back intact if the kind is changed back.
		if u.Assignments > 0 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]any{"error": "in use", "assignments": u.Assignments})
			return
		}
	}
	if err := s.catStore.UpdateCategory(store.CategoryRow{ID: id, Name: req.Name, Kind: req.Kind, Bucket: req.Bucket}); err != nil {
		writeCategoryDBErr(w, err)
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
