package server

import (
	"encoding/json"
	"net/http"
	"time"
)

// TransfersStore is the sweep surface /api/transfers/sweep needs.
type TransfersStore interface {
	NetTransferPairs(window time.Duration) (int, error)
}

// SetTransfersStore wires the transfer-sweep store. Required for /api/transfers/sweep.
func (s *Server) SetTransfersStore(ts TransfersStore) { s.transfersStore = ts }

// handleTransfersSweep retroactively nets self-transfer pairs over the whole
// history. Body is optional: {"window_hours": 2} widens/narrows the pairing
// window (default 2, max 48 — wide windows are for date-only import timestamps).
func (s *Server) handleTransfersSweep(w http.ResponseWriter, r *http.Request) {
	if s.transfersStore == nil {
		http.Error(w, `{"error":"transfers unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req struct {
		WindowHours float64 `json:"window_hours"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req) // absent/empty body → defaults
	hours := req.WindowHours
	if hours == 0 {
		hours = 2
	}
	if hours < 0 || hours > 48 {
		http.Error(w, `{"error":"window_hours must be between 0 and 48"}`, http.StatusBadRequest)
		return
	}
	marked, err := s.transfersStore.NetTransferPairs(time.Duration(hours * float64(time.Hour)))
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if marked > 0 {
		s.BroadcastEvent("tx", nil)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"marked": marked})
}
