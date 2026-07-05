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
	InsertAccount(name, bank, last4 string) (int64, error)
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
		out = append(out, accountDTO{ID: a.ID, Name: a.Name, Bank: a.Bank, Last4: a.Last4})
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
	if err := s.accountsStore.DeleteAccount(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
