package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

// SplitsStore is the store surface the split endpoints and the transaction-
// list decoration need.
type SplitsStore interface {
	ReplaceTransactionSplits(txID int64, splits []store.TransactionSplitRow) error
	SelectTransactionSplits(txID int64) ([]store.TransactionSplitRow, error)
	SelectSplitsForTransactions(txIDs []int64) (map[int64][]store.TransactionSplitRow, error)
}

// SetSplitsStore wires the splits store. Required for
// /api/transactions/{id}/splits; also enables split decoration of the
// transaction list.
func (s *Server) SetSplitsStore(ss SplitsStore) { s.splitsStore = ss }

// splitDTO is the wire shape of one split line, snake_case like the other v3
// endpoints. amount_fils is in the PARENT transaction's currency minor units.
type splitDTO struct {
	ID            int64  `json:"id"`
	TransactionID int64  `json:"transaction_id"`
	CategoryID    int64  `json:"category_id"`
	AmountFils    int64  `json:"amount_fils"`
	Note          string `json:"note,omitempty"`
}

func toSplitDTOs(rows []store.TransactionSplitRow) []splitDTO {
	out := make([]splitDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, splitDTO{
			ID: r.ID, TransactionID: r.TransactionID, CategoryID: r.CategoryID,
			AmountFils: r.AmountFils, Note: r.Note,
		})
	}
	return out
}

// splitsPutReq is the body of PUT /api/transactions/{id}/splits. An empty
// splits array un-splits the transaction: the uncategorized parent returns to
// the review queue (needs_review) — recategorize it afterwards.
type splitsPutReq struct {
	Splits []struct {
		CategoryID int64  `json:"category_id"`
		AmountFils int64  `json:"amount_fils"`
		Note       string `json:"note"`
	} `json:"splits"`
}

func (s *Server) handlePutSplits(w http.ResponseWriter, r *http.Request) {
	if s.splitsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "splits unavailable")
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req splitsPutReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	rows := make([]store.TransactionSplitRow, 0, len(req.Splits))
	for _, sp := range req.Splits {
		rows = append(rows, store.TransactionSplitRow{
			CategoryID: sp.CategoryID, AmountFils: sp.AmountFils, Note: sp.Note,
		})
	}
	err = s.splitsStore.ReplaceTransactionSplits(txID, rows)
	if errors.Is(err, store.ErrSplitTxNotFound) {
		errJSON(w, http.StatusNotFound, "transaction not found")
		return
	}
	if errors.Is(err, store.ErrSplitInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFKViolation(err) {
		errJSON(w, http.StatusBadRequest, "unknown category")
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	saved, err := s.splitsStore.SelectTransactionSplits(txID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	s.BroadcastEvent("tx", nil)
	s.EvaluateBudgetThresholds()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "splits": toSplitDTOs(saved)})
}

func (s *Server) handleGetSplits(w http.ResponseWriter, r *http.Request) {
	if s.splitsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "splits unavailable")
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid id")
		return
	}
	rows, err := s.splitsStore.SelectTransactionSplits(txID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toSplitDTOs(rows))
}
