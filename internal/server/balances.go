package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"ledger/internal/store"
)

// BalancesStore is the store surface the balance/check-in/reconcile endpoints
// need.
type BalancesStore interface {
	SelectAccounts() ([]store.Account, error)
	SelectAccount(id int64) (store.Account, bool, error)
	InsertAccountBalance(store.AccountBalanceRow) (int64, error)
	SelectAccountBalances(accountID int64, limit int) ([]store.AccountBalanceRow, error)
	LatestAccountBalance(accountID int64) (store.AccountBalanceRow, bool, error)
	AccountActivitySince(accountID int64, since string) (net int64, count, unconverted int, err error)
	UnparsedIngestSince(since string, limit int) ([]store.UnparsedIngestRow, error)
	InsertAdjustmentTransaction(accountID, deltaFils int64, note string) (int64, error)
}

// SetBalancesStore wires the balances store. Required for the
// /api/accounts/{id}/balances|checkin|adjust endpoints.
func (s *Server) SetBalancesStore(bs BalancesStore) { s.balancesStore = bs }

// balanceDTO is the wire shape of one balance point.
type balanceDTO struct {
	ID          int64  `json:"id"`
	AccountID   int64  `json:"account_id"`
	AsOf        string `json:"as_of"`
	BalanceFils int64  `json:"balance_fils"`
	Source      string `json:"source"` // checkin | adjustment
	Note        string `json:"note,omitempty"`
	CreatedAt   string `json:"created_at"`
}

func toBalanceDTO(r store.AccountBalanceRow) balanceDTO {
	return balanceDTO{
		ID: r.ID, AccountID: r.AccountID, AsOf: r.AsOf, BalanceFils: r.BalanceFils,
		Source: r.Source, Note: r.Note, CreatedAt: r.CreatedAt,
	}
}

// accountIDFromPath parses the {id} path value for account routes and checks
// the account exists. Returns ok=false after writing the error.
func (s *Server) accountIDFromPath(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	_, found, err := s.balancesStore.SelectAccount(id)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return 0, false
	}
	if !found {
		errJSON(w, http.StatusNotFound, "account not found")
		return 0, false
	}
	return id, true
}

func (s *Server) handleGetAccountBalances(w http.ResponseWriter, r *http.Request) {
	if s.balancesStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "balances unavailable")
		return
	}
	id, ok := s.accountIDFromPath(w, r)
	if !ok {
		return
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			errJSON(w, http.StatusBadRequest, "invalid limit")
			return
		}
		limit = n
	}
	rows, err := s.balancesStore.SelectAccountBalances(id, limit)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	out := make([]balanceDTO, 0, len(rows))
	for _, row := range rows {
		out = append(out, toBalanceDTO(row))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// postBalanceReq is the body of POST /api/accounts/{id}/balances — a plain
// balance point (tracking accounts' simple updates). as_of optional RFC3339.
type postBalanceReq struct {
	BalanceFils int64  `json:"balance_fils"`
	AsOf        string `json:"as_of"`
	Note        string `json:"note"`
}

func (s *Server) handlePostAccountBalance(w http.ResponseWriter, r *http.Request) {
	if s.balancesStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "balances unavailable")
		return
	}
	id, ok := s.accountIDFromPath(w, r)
	if !ok {
		return
	}
	var req postBalanceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	balID, err := s.balancesStore.InsertAccountBalance(store.AccountBalanceRow{
		AccountID: id, AsOf: req.AsOf, BalanceFils: req.BalanceFils, Source: "checkin", Note: req.Note,
	})
	if errors.Is(err, store.ErrBalanceInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": balID})
}

// unparsedDTO is one retained email that produced no transaction — a candidate
// cause of a check-in discrepancy, linked back to the raw source by id.
type unparsedDTO struct {
	ID         int64  `json:"id"`
	ReceivedAt string `json:"received_at"`
	FromAddr   string `json:"from_addr"`
	Subject    string `json:"subject"`
	ParseError string `json:"parse_error,omitempty"`
}

// checkinReq is the body of POST /api/accounts/{id}/checkin: the balance the
// user just read from the bank app.
type checkinReq struct {
	StatedFils int64  `json:"stated_fils"`
	Note       string `json:"note"`
}

// checkinResp is the reconcile report. delta_fils = stated − expected; the
// stated balance is persisted as the account's new anchor regardless of the
// delta (it IS the bank's truth). unparsed lists candidate silent emails since
// the previous anchor.
type checkinResp struct {
	AccountID    int64  `json:"account_id"`
	StatedFils   int64  `json:"stated_fils"`
	ExpectedFils int64  `json:"expected_fils"`
	DeltaFils    int64  `json:"delta_fils"`
	Since        string `json:"since,omitempty"` // previous anchor as_of; "" on first check-in
	TxnCount     int    `json:"txn_count"`       // attributable txns since the previous anchor
	// UnconvertedCount is how many of those transactions are in a foreign
	// currency with no FX rate configured yet: they contribute NOTHING to
	// expected_fils (the AED convention), so a non-zero count is a named
	// discrepancy cause — add the missing rate and check in again.
	UnconvertedCount int           `json:"unconverted_count"`
	FirstCheckin     bool          `json:"first_checkin"`
	BalanceID        int64         `json:"balance_id"`
	Unparsed         []unparsedDTO `json:"unparsed"`
}

func (s *Server) handleAccountCheckin(w http.ResponseWriter, r *http.Request) {
	if s.balancesStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "balances unavailable")
		return
	}
	id, ok := s.accountIDFromPath(w, r)
	if !ok {
		return
	}
	var req checkinReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}

	anchor, hasAnchor, err := s.balancesStore.LatestAccountBalance(id)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	since := ""
	var expected int64
	if hasAnchor {
		since = anchor.AsOf
		expected = anchor.BalanceFils
	}
	activity, txnCount, unconverted, err := s.balancesStore.AccountActivitySince(id, since)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	resp := checkinResp{
		AccountID:        id,
		StatedFils:       req.StatedFils,
		Since:            since,
		TxnCount:         txnCount,
		UnconvertedCount: unconverted,
		FirstCheckin:     !hasAnchor,
		Unparsed:         []unparsedDTO{},
	}
	if hasAnchor {
		resp.ExpectedFils = expected + activity
		resp.DeltaFils = req.StatedFils - resp.ExpectedFils
		if resp.DeltaFils != 0 {
			rows, uerr := s.balancesStore.UnparsedIngestSince(since, 20)
			if uerr != nil {
				errJSON(w, http.StatusInternalServerError, "db error")
				return
			}
			for _, u := range rows {
				resp.Unparsed = append(resp.Unparsed, unparsedDTO{
					ID: u.ID, ReceivedAt: u.ReceivedAt, FromAddr: u.FromAddr,
					Subject: u.Subject, ParseError: u.ParseError,
				})
			}
		}
	} else {
		// First check-in: no anchor to reconcile against — the stated balance
		// simply becomes ground truth.
		resp.ExpectedFils = req.StatedFils
	}

	balID, err := s.balancesStore.InsertAccountBalance(store.AccountBalanceRow{
		AccountID: id, BalanceFils: req.StatedFils, Source: "checkin", Note: req.Note,
	})
	if errors.Is(err, store.ErrBalanceInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	resp.BalanceID = balID
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// adjustReq is the body of POST /api/accounts/{id}/adjust. delta_fils is the
// check-in's reported delta (stated − expected): positive writes a credit,
// negative a debit.
type adjustReq struct {
	DeltaFils int64  `json:"delta_fils"`
	Note      string `json:"note"`
}

func (s *Server) handleAccountAdjust(w http.ResponseWriter, r *http.Request) {
	if s.balancesStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "balances unavailable")
		return
	}
	id, ok := s.accountIDFromPath(w, r)
	if !ok {
		return
	}
	var req adjustReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	txID, err := s.balancesStore.InsertAdjustmentTransaction(id, req.DeltaFils, req.Note)
	if errors.Is(err, store.ErrBalanceInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	s.BroadcastEvent("tx", nil)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "transaction_id": txID})
}

// accountBalanceSummaryDTO is one row of GET /api/accounts/balances: the
// accounts screen's whole state in one call. computed_fils = anchor + signed
// attributable activity since the anchor; has_checkin=false means the account
// has never been checked in (computed_fils is 0 and meaningless).
type accountBalanceSummaryDTO struct {
	AccountID         int64  `json:"account_id"`
	Name              string `json:"name"`
	Bank              string `json:"bank"`
	Last4             string `json:"last4"`
	Kind              string `json:"kind"`
	HasCheckin        bool   `json:"has_checkin"`
	AnchorFils        int64  `json:"anchor_fils"`
	AnchorAsOf        string `json:"anchor_as_of,omitempty"`
	AnchorSource      string `json:"anchor_source,omitempty"`
	ActivitySinceFils int64  `json:"activity_since_fils"`
	TxnCount          int    `json:"txn_count"`
	ComputedFils      int64  `json:"computed_fils"`
}

func (s *Server) handleGetAccountBalanceSummaries(w http.ResponseWriter, r *http.Request) {
	if s.balancesStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "balances unavailable")
		return
	}
	accounts, err := s.balancesStore.SelectAccounts()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	out := make([]accountBalanceSummaryDTO, 0, len(accounts))
	for _, a := range accounts {
		if !a.IsActive {
			continue
		}
		dto := accountBalanceSummaryDTO{
			AccountID: a.ID, Name: a.Name, Bank: a.Bank, Last4: a.Last4, Kind: a.Kind,
		}
		anchor, hasAnchor, err := s.balancesStore.LatestAccountBalance(a.ID)
		if err != nil {
			errJSON(w, http.StatusInternalServerError, "db error")
			return
		}
		if hasAnchor {
			dto.HasCheckin = true
			dto.AnchorFils = anchor.BalanceFils
			dto.AnchorAsOf = anchor.AsOf
			dto.AnchorSource = anchor.Source
			activity, count, _, err := s.balancesStore.AccountActivitySince(a.ID, anchor.AsOf)
			if err != nil {
				errJSON(w, http.StatusInternalServerError, "db error")
				return
			}
			dto.ActivitySinceFils = activity
			dto.TxnCount = count
			dto.ComputedFils = anchor.BalanceFils + activity
		}
		out = append(out, dto)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
