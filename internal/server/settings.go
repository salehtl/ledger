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
	UpdateBudgetMode(mode string) error
}

// SetSettingsStore wires the settings store. Required for /api/settings.
func (s *Server) SetSettingsStore(ss SettingsStore) { s.settingsStore = ss }

type settingsDTO struct {
	AutoCategorize    bool    `json:"auto_categorize"`
	AIEnabled         bool    `json:"ai_enabled"`
	AIAutoAccept      bool    `json:"ai_auto_accept"`
	AIThreshold       float64 `json:"ai_threshold"`
	IngestSilenceDays int     `json:"ingest_silence_days"`
	// AIKeyPresent is read-only output: whether an Anthropic key is loaded
	// (env-only). It is ignored on PUT.
	AIKeyPresent bool `json:"ai_key_present"`
	// AISpendCapMuUSD is the monthly AI spend cap in micro-USD (0 = no cap).
	// A pointer so PUT can tell "omitted" from an explicit 0: this endpoint
	// takes the whole settings object, so any client that forgot this field
	// silently erased the user's spend cap. Omitted now carries forward, the
	// same as IngestSilenceDays and CapLatched.
	AISpendCapMuUSD *int64 `json:"ai_spend_cap_musd"`
	// AICapLatched is read-only output: whether the spend cap has tripped and
	// AI calls are currently blocked. The store clears the latch when
	// AIEnabled is set true; the client cannot set this field directly.
	AICapLatched bool `json:"ai_cap_latched"`
	// BudgetMode is the budgeting method (BudgetModeSimple/BudgetModeEnvelope).
	// A pointer, same pattern as AISpendCapMuUSD: on GET it is always
	// populated (never nil); on PUT nil means "omitted, leave unchanged" — a
	// hidden switch, so an older client that has never heard of it can never
	// silently flip the user back to envelope mode.
	BudgetMode *string `json:"budget_mode"`
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
	json.NewEncoder(w).Encode(settingsDTO{
		AutoCategorize: a.AutoCategorize, AIEnabled: a.AIEnabled,
		AIAutoAccept: a.AIAutoAccept, AIThreshold: a.AIThreshold,
		IngestSilenceDays: a.IngestSilenceDays,
		AIKeyPresent:      s.aiKeyPresent,
		AISpendCapMuUSD:   &a.SpendCapMuUSD,
		AICapLatched:      a.CapLatched,
		BudgetMode:        &a.BudgetMode,
	})
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
	// Hidden switch: omitted (nil) leaves the stored mode untouched. An
	// explicit unknown value is rejected rather than silently normalised, so a
	// typo surfaces immediately instead of quietly landing in simple mode.
	if dto.BudgetMode != nil {
		if err := s.settingsStore.UpdateBudgetMode(*dto.BudgetMode); err != nil {
			http.Error(w, `{"error":"invalid budget_mode"}`, http.StatusBadRequest)
			return
		}
	}
	// Single read of the current settings, reused below for both the
	// IngestSilenceDays fallback and the CapLatched carry-forward.
	cur, curErr := s.settingsStore.SelectAppSettings()
	if dto.IngestSilenceDays < 1 {
		// Omitted (older client) or invalid: preserve the stored value.
		if curErr == nil && cur.IngestSilenceDays >= 1 {
			dto.IngestSilenceDays = cur.IngestSilenceDays
		} else {
			dto.IngestSilenceDays = 3
		}
	}
	// CapLatched: the client cannot set this field directly (dto.AICapLatched
	// is intentionally never read). We carry forward the stored value so the
	// hard latch persists across unrelated settings changes made while AI is
	// off; the store still clears it when AIEnabled is true. If the read
	// failed, fail safe by treating it as false (at worst the banner clears
	// early, never a safety issue).
	capLatched := false
	if curErr == nil {
		capLatched = cur.CapLatched
	}
	// Omitted spend cap: keep what's stored. Only an explicit value (including
	// an explicit 0, meaning "no cap") changes it.
	spendCap := int64(0)
	if curErr == nil {
		spendCap = cur.SpendCapMuUSD
	}
	if dto.AISpendCapMuUSD != nil {
		spendCap = *dto.AISpendCapMuUSD
	}
	if err := s.settingsStore.UpdateAppSettings(store.AppSettings{
		AutoCategorize: dto.AutoCategorize, AIEnabled: dto.AIEnabled,
		AIAutoAccept: dto.AIAutoAccept, AIThreshold: dto.AIThreshold,
		IngestSilenceDays: dto.IngestSilenceDays,
		SpendCapMuUSD:     spendCap,
		CapLatched:        capLatched,
	}); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}
