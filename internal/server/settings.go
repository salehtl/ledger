package server

import (
	"encoding/json"
	"net/http"

	"ledger/internal/store"
)

// SettingsStore is the read/write surface the settings endpoints need.
type SettingsStore interface {
	SelectAppSettings() (store.AppSettings, error)
	UpdateAppSettings(store.AppSettings) error
}

// SetSettingsStore wires the settings store. Required for /api/settings.
func (s *Server) SetSettingsStore(ss SettingsStore) { s.settingsStore = ss }

type settingsDTO struct {
	AutoCategorize bool    `json:"auto_categorize"`
	AIEnabled      bool    `json:"ai_enabled"`
	AIAutoAccept   bool    `json:"ai_auto_accept"`
	AIThreshold    float64 `json:"ai_threshold"`
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsStore == nil {
		http.Error(w, `{"error":"settings unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	a, err := s.settingsStore.SelectAppSettings()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(settingsDTO{a.AutoCategorize, a.AIEnabled, a.AIAutoAccept, a.AIThreshold})
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	if s.settingsStore == nil {
		http.Error(w, `{"error":"settings unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var dto settingsDTO
	if err := json.NewDecoder(r.Body).Decode(&dto); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if dto.AIThreshold <= 0 || dto.AIThreshold > 1 {
		dto.AIThreshold = 0.85
	}
	if err := s.settingsStore.UpdateAppSettings(store.AppSettings{
		AutoCategorize: dto.AutoCategorize, AIEnabled: dto.AIEnabled,
		AIAutoAccept: dto.AIAutoAccept, AIThreshold: dto.AIThreshold,
	}); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}
