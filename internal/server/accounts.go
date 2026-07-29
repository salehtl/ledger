package server

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"ledger/internal/store"
)

// AccountsStore is the own-account registry surface /api/accounts needs.
type AccountsStore interface {
	SelectAccounts() ([]store.Account, error)
	SelectAccount(id int64) (store.Account, bool, error)
	InsertAccount(name, bank, last4 string) (int64, error)
	UpdateAccountKind(id int64, kind string) error
	AccountBalanceCount(accountID int64) (int, error)
	DeleteAccount(id int64) error
}

// SetAccountsStore wires the accounts store. Required for /api/accounts.
func (s *Server) SetAccountsStore(as AccountsStore) { s.accountsStore = as }

var last4Re = regexp.MustCompile(`^[0-9]{4}$`)

type accountDTO struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Bank  string `json:"bank"`
	Last4 string `json:"last4"`
	Kind  string `json:"kind"` // 'budget' | 'tracking'
}

func (s *Server) handleGetAccounts(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	accs, err := s.accountsStore.SelectAccounts()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	out := []accountDTO{}
	for _, a := range accs {
		out = append(out, accountDTO{ID: a.ID, Name: a.Name, Bank: a.Bank, Last4: a.Last4, Kind: a.Kind})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handlePostAccount(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req struct {
		Name  string `json:"name"`
		Bank  string `json:"bank"`
		Last4 string `json:"last4"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
		return
	}
	if !last4Re.MatchString(req.Last4) {
		http.Error(w, `{"error":"last4 must be exactly 4 digits"}`, http.StatusBadRequest)
		return
	}
	id, err := s.accountsStore.InsertAccount(req.Name, strings.TrimSpace(req.Bank), req.Last4)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id})
}

// handlePutAccount updates an account's kind (budget ↔ tracking). Only kind
// is mutable — name/bank/last4 identify the account for transfer matching and
// stay fixed after creation.
func (s *Server) handlePutAccount(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req struct {
		Kind string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if req.Kind != "budget" && req.Kind != "tracking" {
		errJSON(w, http.StatusBadRequest, "kind must be 'budget' or 'tracking'")
		return
	}
	if _, found, err := s.accountsStore.SelectAccount(id); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	} else if !found {
		errJSON(w, http.StatusNotFound, "account not found")
		return
	}
	if err := s.accountsStore.UpdateAccountKind(id, req.Kind); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	a, _, err := s.accountsStore.SelectAccount(id)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(accountDTO{ID: a.ID, Name: a.Name, Bank: a.Bank, Last4: a.Last4, Kind: a.Kind})
}

// handleDeleteAccount hard-deletes an account — but only when it has no
// balance check-in history. account_balances is ON DELETE CASCADE, and those
// rows are net-worth ground truth: deleting past them would retroactively
// rewrite the net-worth report (pre-v3, when accounts were a bare last4
// registry, this delete was harmless cleanup). With history present it 409s
// with the count, matching the categories in-use convention.
func (s *Server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	if s.accountsStore == nil {
		http.Error(w, `{"error":"accounts unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	balances, err := s.accountsStore.AccountBalanceCount(id)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if balances > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]any{"error": "in use", "balances": balances})
		return
	}
	if err := s.accountsStore.DeleteAccount(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
