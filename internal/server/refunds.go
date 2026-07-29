package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

type linkRefundReq struct {
	TargetID int64 `json:"target_id"`
}

// writeRefundErr maps the store's refund sentinel errors onto HTTP statuses.
func writeRefundErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrRefundNotFound):
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
	case errors.Is(err, store.ErrTxSplit):
		// Same 409 the categorize path uses: a split credit must be un-split
		// (PUT /splits []) before it can carry an inherited refund category.
		http.Error(w, `{"error":"transaction is split"}`, http.StatusConflict)
	case errors.Is(err, store.ErrRefundBadLink):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
	default:
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
	}
}

// refundTxID does the shared handler preamble: store availability + id parse.
func (s *Server) refundTxID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return 0, false
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return 0, false
	}
	return txID, true
}

func (s *Server) handleLinkRefund(w http.ResponseWriter, r *http.Request) {
	txID, ok := s.refundTxID(w, r)
	if !ok {
		return
	}
	var req linkRefundReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.TargetID <= 0 {
		http.Error(w, `{"error":"target_id required"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.LinkRefund(txID, req.TargetID); err != nil {
		writeRefundErr(w, err)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *Server) handleUnlinkRefund(w http.ResponseWriter, r *http.Request) {
	txID, ok := s.refundTxID(w, r)
	if !ok {
		return
	}
	if err := s.catStore.UnlinkRefund(txID); err != nil {
		writeRefundErr(w, err)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

func (s *Server) handleRefundCandidates(w http.ResponseWriter, r *http.Request) {
	txID, ok := s.refundTxID(w, r)
	if !ok {
		return
	}
	items, err := s.catStore.SelectRefundCandidates(txID, 20)
	if err != nil {
		writeRefundErr(w, err)
		return
	}
	if items == nil {
		items = []store.ReviewItem{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}
