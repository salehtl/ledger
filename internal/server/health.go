package server

import (
	"encoding/json"
	"net/http"
	"time"
)

// healthResponse is the JSON shape of /api/health. The ingest section is present
// only when an ingest source has been wired (SetIngest).
type healthResponse struct {
	Status string        `json:"status"`
	DB     string        `json:"db"`
	Ingest *ingestHealth `json:"ingest,omitempty"`
}

type ingestHealth struct {
	Configured bool   `json:"configured"`
	Count      int    `json:"count"`
	LastAt     string `json:"last_at,omitempty"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", DB: "ok"}
	code := http.StatusOK
	if err := s.store.Ping(); err != nil {
		resp.Status = "degraded"
		resp.DB = "unreachable"
		code = http.StatusServiceUnavailable
	}
	if s.ingest != nil {
		ih := &ingestHealth{Configured: s.imapConfigured}
		if count, err := s.ingest.CountIngest(); err == nil {
			ih.Count = count
		}
		if at, ok, err := s.ingest.LastIngestAt(); err == nil && ok {
			ih.LastAt = at.UTC().Format(time.RFC3339)
		}
		resp.Ingest = ih
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}
