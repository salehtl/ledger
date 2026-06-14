package server

import (
	"encoding/json"
	"net/http"
)

// healthResponse is the JSON shape of /api/health. Later milestones add IMAP
// connectivity and last-ingest fields (§6.7); the skeleton reports DB liveness.
type healthResponse struct {
	Status string `json:"status"`
	DB     string `json:"db"`
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := healthResponse{Status: "ok", DB: "ok"}
	code := http.StatusOK
	if err := s.store.Ping(); err != nil {
		resp.Status = "degraded"
		resp.DB = "unreachable"
		code = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(resp)
}
