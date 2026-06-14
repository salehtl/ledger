package server

import (
	"encoding/json"
	"net/http"
)

type reprocessRequest struct {
	Bank string `json:"bank"`
}

type reprocessResponse struct {
	Processed int `json:"processed"`
}

func (s *Server) handleReprocess(w http.ResponseWriter, r *http.Request) {
	if s.reprocessor == nil {
		http.Error(w, `{"error":"reprocess unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req reprocessRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // empty body is fine → bank=""
	}
	n, err := s.reprocessor.Reprocess(r.Context(), req.Bank)
	if err != nil {
		http.Error(w, `{"error":"reprocess failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(reprocessResponse{Processed: n})
}
