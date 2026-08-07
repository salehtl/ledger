package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ledger/internal/parse"
	"ledger/internal/store"
)

// categorizeReq's CategoryID is a pointer so an explicit JSON null (or 0)
// decategorizes the transaction instead of being rejected.
type categorizeReq struct {
	CategoryID  *int64 `json:"category_id"`
	MerchantRaw string `json:"merchant_raw"`
	MakeRule    bool   `json:"make_rule"`
}

func (s *Server) handleCategorize(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categorize unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req categorizeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if req.CategoryID == nil || *req.CategoryID == 0 {
		// Decategorize: back to the review queue; never write a rule.
		if err := s.catStore.ClearTransactionCategory(txID); err != nil {
			if errors.Is(err, store.ErrTxSplit) {
				// Same guard as the categorize branch below: a split parent
				// leaves the split state only via PUT /splits with [] —
				// decategorizing it would strand confirmed split lines on a
				// needs_review parent and silently drop the whole amount from
				// every aggregate.
				http.Error(w, `{"error":"transaction is split"}`, http.StatusConflict)
				return
			}
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
		s.BroadcastEvent("tx", nil)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true})
		return
	}
	if err := s.catStore.UpdateTransactionCategory(txID, *req.CategoryID, "confirmed"); err != nil {
		if errors.Is(err, store.ErrTxSplit) {
			// A split parent's category stays NULL; its lines carry the truth.
			// Categorizing it would double-count the amount — un-split first.
			http.Error(w, `{"error":"transaction is split"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	s.EvaluateBudgetThresholds()
	resp := map[string]any{"ok": true}
	if req.MakeRule && req.MerchantRaw != "" {
		ruleID, err := s.catStore.InsertRule(store.RuleRow{
			MatchType:  "contains",
			Pattern:    req.MerchantRaw,
			CategoryID: *req.CategoryID,
			Priority:   100,
			Source:     "manual",
		})
		// Rule write-back is best-effort; report the ID only when it landed so
		// the client's undo can delete exactly what was created.
		if err == nil {
			resp["rule_id"] = ruleID
		}
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (s *Server) handleGetTransactions(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"transactions unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	q := r.URL.Query()
	items, err := s.catStore.SelectTransactions(q.Get("status"), q.Get("from"), q.Get("to"), q.Get("q"))
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if items == nil {
		items = []store.ReviewItem{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.decorateSplits(items))
}

// txnListItem decorates a ReviewItem with its split lines. The embedded item
// keeps the list's Go-field-name JSON shape; Splits joins it under the same
// convention and is omitted for unsplit transactions.
type txnListItem struct {
	store.ReviewItem
	Splits []store.TransactionSplitRow `json:",omitempty"`
}

// decorateSplits attaches split lines to a transaction list in one batched
// query. Without a wired splits store the list passes through undecorated.
func (s *Server) decorateSplits(items []store.ReviewItem) []txnListItem {
	out := make([]txnListItem, len(items))
	for i, it := range items {
		out[i] = txnListItem{ReviewItem: it}
	}
	if s.splitsStore == nil || len(items) == 0 {
		return out
	}
	ids := make([]int64, len(items))
	for i, it := range items {
		ids[i] = it.ID
	}
	byTx, err := s.splitsStore.SelectSplitsForTransactions(ids)
	if err != nil {
		return out // decoration is best-effort; the list itself must not fail
	}
	for i := range out {
		out[i].Splits = byTx[out[i].ID]
	}
	return out
}

// putNoteReq is the body of PUT /api/transactions/{id}/note. An empty note
// clears the memo.
type putNoteReq struct {
	Note string `json:"note"`
}

func (s *Server) handlePutTransactionNote(w http.ResponseWriter, r *http.Request) {
	if s.noteStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "notes unavailable")
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid id")
		return
	}
	var req putNoteReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if err := s.noteStore.UpdateTransactionNote(txID, req.Note); err != nil {
		if errors.Is(err, store.ErrTxNotFound) {
			errJSON(w, http.StatusNotFound, "transaction not found")
			return
		}
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// NoteStore is the store surface the transaction-note endpoint needs.
type NoteStore interface {
	UpdateTransactionNote(txID int64, note string) error
}

// SetNoteStore wires the note store. Required for PUT /api/transactions/{id}/note.
func (s *Server) SetNoteStore(ns NoteStore) { s.noteStore = ns }

func (s *Server) handleTransactionEmail(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"transactions unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	email, ok, err := s.catStore.TransactionEmail(txID)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, `{"error":"source email unavailable"}`, http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(readableEmail(email))
}

// readableEmail turns the retained RFC822 message into something a human can
// actually read: the preview exists to answer "what is this email about", and
// the raw source buries one sentence under kilobytes of DKIM headers and MIME
// boundaries. It runs the same BodyText+Unwrap pipeline the parse cascade
// feeds its templates, so the review queue shows exactly the text the parser
// saw — the most useful view when a row landed there unparsed.
//
// A message BodyText cannot extract (no text part) keeps its raw body rather
// than rendering empty: unreadable beats invisible.
func readableEmail(email store.TransactionEmail) store.TransactionEmail {
	text, err := parse.BodyText([]byte(email.Body))
	if err != nil {
		return email
	}
	from, subject, fwdDate, text := parse.Unwrap(email.From, email.Subject, text)
	email.From, email.Subject, email.Body = from, subject, text
	// For an inline forward the original Date header is the transaction's real
	// time; the mailbox arrival time is just when it was forwarded on.
	if fwdDate != "" {
		if d, derr := parse.ParseForwardDate(fwdDate); derr == nil {
			email.ReceivedAt = d.Format(time.RFC3339)
		}
	}
	return email
}

// handleClearCategorization moves every transaction back to needs_review and
// clears its category, leaving learned rules intact. Destructive bulk reset
// exposed in the Settings "Danger zone".
func (s *Server) handleClearCategorization(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"categories unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	n, err := s.catStore.ClearAllCategorization()
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"cleared": n})
}

func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	s.archiveOrRestore(w, r, true)
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	s.archiveOrRestore(w, r, false)
}

// archiveOrRestore handles both soft-delete directions: archive (true) stashes
// the current status and hides the row; restore (false) brings it back.
func (s *Server) archiveOrRestore(w http.ResponseWriter, r *http.Request, archive bool) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	if archive {
		err = s.catStore.ArchiveTransaction(txID)
	} else {
		err = s.catStore.RestoreTransaction(txID)
	}
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	// Archiving removes a confirmed row's activity; restoring brings it back.
	// Either direction can move an envelope/jar across (or back under) 80%/100%,
	// so refresh the threshold diff state like every other activity-moving
	// mutation — otherwise a crossing caused by a restore stays silent until
	// some later evaluated mutation happens to run.
	s.EvaluateBudgetThresholds()
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}

type manualTxnReq struct {
	PostedAt    string `json:"posted_at"`
	AmountFils  int64  `json:"amount_fils"`
	Currency    string `json:"currency"`
	Direction   string `json:"direction"`
	MerchantRaw string `json:"merchant_raw"`
	CategoryID  int64  `json:"category_id"`
	// AccountID optionally attributes the entry to a registered account: the
	// row is stamped with the account's last4 so reconciliation expected-
	// balance math and net worth see it (the discrepancy card's manual path).
	AccountID int64 `json:"account_id"`
}

// parseManualDate accepts a full RFC3339 timestamp or a bare YYYY-MM-DD date.
func parseManualDate(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC(), true
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.UTC(), true
	}
	return time.Time{}, false
}

func (s *Server) handlePostTransaction(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req manualTxnReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if req.AmountFils <= 0 {
		http.Error(w, `{"error":"amount must be positive"}`, http.StatusBadRequest)
		return
	}
	if req.Direction != "debit" && req.Direction != "credit" {
		http.Error(w, `{"error":"direction must be debit or credit"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.MerchantRaw) == "" {
		http.Error(w, `{"error":"merchant required"}`, http.StatusBadRequest)
		return
	}
	posted, ok := parseManualDate(req.PostedAt)
	if !ok {
		http.Error(w, `{"error":"invalid posted_at"}`, http.StatusBadRequest)
		return
	}
	id, err := s.catStore.InsertManualTransaction(store.ManualTxn{
		PostedAt:    posted,
		AmountFils:  req.AmountFils,
		Currency:    req.Currency,
		Direction:   req.Direction,
		MerchantRaw: strings.TrimSpace(req.MerchantRaw),
		CategoryID:  req.CategoryID,
		AccountID:   req.AccountID,
	})
	if errors.Is(err, store.ErrBalanceInvalid) {
		http.Error(w, `{"error":"unknown account"}`, http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if req.CategoryID > 0 {
		// A categorized manual entry inserts directly as confirmed activity
		// (the reconcile discrepancy card's "open manual entry" path) —
		// evaluate thresholds like the confirm/categorize/split/assign paths,
		// so a crossing it causes notifies now, not on some later mutation.
		s.EvaluateBudgetThresholds()
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id})
}

var validStatuses = map[string]bool{
	"confirmed":    true,
	"ignored":      true,
	"transfer":     true,
	"needs_review": true,
}

type setStatusReq struct {
	Status string `json:"status"`
}

func (s *Server) handleSetStatus(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil {
		http.Error(w, `{"error":"unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req setStatusReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Status == "" {
		http.Error(w, `{"error":"status required"}`, http.StatusBadRequest)
		return
	}
	if !validStatuses[req.Status] {
		http.Error(w, `{"error":"invalid status"}`, http.StatusBadRequest)
		return
	}
	if err := s.catStore.UpdateTransactionStatus(txID, req.Status); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if req.Status == "confirmed" {
		s.EvaluateBudgetThresholds()
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
