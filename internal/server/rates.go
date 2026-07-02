package server

import (
	"encoding/json"
	"math"
	"net/http"
	"regexp"

	"ledger/internal/store"
)

// RatesStore is the fx-rate surface the /api/rates endpoints need.
type RatesStore interface {
	SelectFXRates() ([]store.FXRate, error)
	UpsertFXRate(currency string, rateMicro int64) error
	DeleteFXRate(currency string) error
	UnconvertedCurrencies() ([]string, error)
	ConvertUnconverted() (int64, error)
}

// SetRatesStore wires the fx-rate store. Required for /api/rates.
func (s *Server) SetRatesStore(rs RatesStore) { s.ratesStore = rs }

var currencyCodeRe = regexp.MustCompile(`^[A-Z]{3}$`)

type rateDTO struct {
	Currency  string  `json:"currency"`
	Rate      float64 `json:"rate"` // AED per 1 unit; display/input form of rate_micro
	UpdatedAt string  `json:"updated_at"`
}

func (s *Server) handleGetRates(w http.ResponseWriter, r *http.Request) {
	if s.ratesStore == nil {
		http.Error(w, `{"error":"rates unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	rates, err := s.ratesStore.SelectFXRates()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	missing, err := s.ratesStore.UnconvertedCurrencies()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	out := struct {
		Rates   []rateDTO `json:"rates"`
		Missing []string  `json:"missing"`
	}{Rates: []rateDTO{}, Missing: []string{}}
	for _, fr := range rates {
		out.Rates = append(out.Rates, rateDTO{
			Currency: fr.Currency, Rate: float64(fr.RateMicro) / 1e6, UpdatedAt: fr.UpdatedAt,
		})
	}
	out.Missing = append(out.Missing, missing...)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handlePutRate(w http.ResponseWriter, r *http.Request) {
	if s.ratesStore == nil {
		http.Error(w, `{"error":"rates unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	currency := r.PathValue("currency")
	if !currencyCodeRe.MatchString(currency) || currency == "AED" {
		http.Error(w, `{"error":"currency must be a 3-letter uppercase code other than AED"}`, http.StatusBadRequest)
		return
	}
	var req struct {
		Rate float64 `json:"rate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if !(req.Rate > 0 && req.Rate < 1000) {
		http.Error(w, `{"error":"rate must be between 0 and 1000"}`, http.StatusBadRequest)
		return
	}
	// The float exists only at the API boundary; storage and math are integer micro-units.
	rateMicro := int64(math.Round(req.Rate * 1e6))
	if rateMicro < 1 {
		http.Error(w, `{"error":"rate too small"}`, http.StatusBadRequest)
		return
	}
	if err := s.ratesStore.UpsertFXRate(currency, rateMicro); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	converted, err := s.ratesStore.ConvertUnconverted()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if converted > 0 {
		s.BroadcastEvent("tx", nil)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "converted": converted})
}

func (s *Server) handleDeleteRate(w http.ResponseWriter, r *http.Request) {
	if s.ratesStore == nil {
		http.Error(w, `{"error":"rates unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	currency := r.PathValue("currency")
	if !currencyCodeRe.MatchString(currency) {
		http.Error(w, `{"error":"invalid currency"}`, http.StatusBadRequest)
		return
	}
	if err := s.ratesStore.DeleteFXRate(currency); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
