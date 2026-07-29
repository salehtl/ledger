package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ledger/internal/recur"
	"ledger/internal/store"
)

// ScheduledStore is the store surface the scheduled-transaction endpoints and
// the upcoming-bill notifier need.
type ScheduledStore interface {
	InsertScheduled(store.ScheduledTxnRow) (int64, error)
	SelectScheduled(statuses ...string) ([]store.ScheduledTxnRow, error)
	SelectScheduledByID(id int64) (store.ScheduledTxnRow, bool, error)
	UpdateScheduled(store.ScheduledTxnRow) error
	DeleteScheduled(id int64) error
	SetScheduledStatus(id int64, status string) error
	SelectUpcoming(from time.Time, days int) ([]store.ScheduledTxnRow, error)
}

// SetScheduledStore wires the scheduled store. Required for /api/scheduled
// and /api/upcoming.
func (s *Server) SetScheduledStore(ss ScheduledStore) { s.scheduledStore = ss }

// scheduledDTO is the wire shape of one schedule. Provenance is the detector's
// raw JSON object ({count, avg_interval_days, last_amounts_fils, tx_ids, …});
// omitted for manual rows. It is read-only — never accepted on writes.
type scheduledDTO struct {
	ID              int64           `json:"id"`
	Merchant        string          `json:"merchant"` // normalized (lowercase, whitespace-collapsed)
	Label           string          `json:"label"`
	AmountFils      int64           `json:"amount_fils"`
	TolerancePct    int64           `json:"tolerance_pct"`
	IntervalDays    int64           `json:"interval_days"`
	NextDue         string          `json:"next_due"` // YYYY-MM-DD
	Direction       string          `json:"direction"`
	CategoryID      *int64          `json:"category_id"`
	AccountID       *int64          `json:"account_id"`
	Source          string          `json:"source"` // manual | detected
	Status          string          `json:"status"` // proposed | active | paused | dismissed
	LastMatchedTxID *int64          `json:"last_matched_tx_id"`
	LastMatchedAt   string          `json:"last_matched_at,omitempty"`
	LastAmountFils  *int64          `json:"last_amount_fils"`
	Missed          bool            `json:"missed"`
	PriceChange     bool            `json:"price_change"`
	Provenance      json.RawMessage `json:"provenance,omitempty"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
}

func toScheduledDTO(r store.ScheduledTxnRow) scheduledDTO {
	dto := scheduledDTO{
		ID: r.ID, Merchant: r.NormalizedMerchant, Label: r.Label,
		AmountFils: r.AmountFils, TolerancePct: r.TolerancePct, IntervalDays: r.IntervalDays,
		NextDue: r.NextDue, Direction: r.Direction, CategoryID: r.CategoryID, AccountID: r.AccountID,
		Source: r.Source, Status: r.Status, LastMatchedTxID: r.LastMatchedTxID,
		LastMatchedAt: r.LastMatchedAt, LastAmountFils: r.LastAmountFils,
		Missed: r.Missed, PriceChange: r.PriceChange,
		CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt,
	}
	if r.Provenance != "" && json.Valid([]byte(r.Provenance)) {
		dto.Provenance = json.RawMessage(r.Provenance)
	}
	return dto
}

// scheduledInputDTO is the writable shape for POST/PUT. TolerancePct is a
// pointer so an omitted field defaults to the detector's ±10% rather than
// exact-amount matching.
type scheduledInputDTO struct {
	Merchant     string `json:"merchant"`
	Label        string `json:"label"`
	AmountFils   int64  `json:"amount_fils"`
	TolerancePct *int64 `json:"tolerance_pct"`
	IntervalDays int64  `json:"interval_days"`
	NextDue      string `json:"next_due"`
	Direction    string `json:"direction"`
	CategoryID   *int64 `json:"category_id"`
	AccountID    *int64 `json:"account_id"`
}

func (in scheduledInputDTO) toRow() store.ScheduledTxnRow {
	tol := int64(recur.DefaultTolerancePct)
	if in.TolerancePct != nil {
		tol = *in.TolerancePct
	}
	return store.ScheduledTxnRow{
		NormalizedMerchant: in.Merchant, Label: in.Label, AmountFils: in.AmountFils,
		TolerancePct: tol, IntervalDays: in.IntervalDays, NextDue: in.NextDue,
		Direction: in.Direction, CategoryID: in.CategoryID, AccountID: in.AccountID,
	}
}

// scheduledIDFromPath parses the {id} path value. Returns ok=false after
// writing a 400.
func scheduledIDFromPath(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	return id, true
}

func (s *Server) handleGetScheduled(w http.ResponseWriter, r *http.Request) {
	if s.scheduledStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "scheduled unavailable")
		return
	}
	var statuses []string
	if raw := r.URL.Query().Get("status"); raw != "" {
		for _, st := range strings.Split(raw, ",") {
			st = strings.TrimSpace(st)
			switch st {
			case "proposed", "active", "paused", "dismissed":
				statuses = append(statuses, st)
			default:
				errJSON(w, http.StatusBadRequest, "invalid status "+strconv.Quote(st))
				return
			}
		}
	}
	rows, err := s.scheduledStore.SelectScheduled(statuses...)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	out := make([]scheduledDTO, 0, len(rows))
	for _, r := range rows {
		out = append(out, toScheduledDTO(r))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handlePostScheduled(w http.ResponseWriter, r *http.Request) {
	if s.scheduledStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "scheduled unavailable")
		return
	}
	var in scheduledInputDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	row := in.toRow()
	row.Source = "manual" // this endpoint only creates hand-entered schedules
	id, err := s.scheduledStore.InsertScheduled(row)
	if errors.Is(err, store.ErrScheduleInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFKViolation(err) {
		errJSON(w, http.StatusBadRequest, "unknown category or account")
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	created, _, err := s.scheduledStore.SelectScheduledByID(id)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toScheduledDTO(created))
}

func (s *Server) handlePutScheduled(w http.ResponseWriter, r *http.Request) {
	if s.scheduledStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "scheduled unavailable")
		return
	}
	id, ok := scheduledIDFromPath(w, r)
	if !ok {
		return
	}
	if _, found, err := s.scheduledStore.SelectScheduledByID(id); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	} else if !found {
		errJSON(w, http.StatusNotFound, "not found")
		return
	}
	var in scheduledInputDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	row := in.toRow()
	row.ID = id
	err := s.scheduledStore.UpdateScheduled(row)
	if errors.Is(err, store.ErrScheduleInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if isFKViolation(err) {
		errJSON(w, http.StatusBadRequest, "unknown category or account")
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	updated, _, err := s.scheduledStore.SelectScheduledByID(id)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toScheduledDTO(updated))
}

func (s *Server) handleDeleteScheduled(w http.ResponseWriter, r *http.Request) {
	if s.scheduledStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "scheduled unavailable")
		return
	}
	id, ok := scheduledIDFromPath(w, r)
	if !ok {
		return
	}
	if err := s.scheduledStore.DeleteScheduled(id); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// handleScheduledStatus is the shared confirm/dismiss/pause implementation.
// confirm also resumes a paused schedule (active ← proposed/paused/dismissed).
func (s *Server) handleScheduledStatus(w http.ResponseWriter, r *http.Request, status string) {
	if s.scheduledStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "scheduled unavailable")
		return
	}
	id, ok := scheduledIDFromPath(w, r)
	if !ok {
		return
	}
	if _, found, err := s.scheduledStore.SelectScheduledByID(id); err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	} else if !found {
		errJSON(w, http.StatusNotFound, "not found")
		return
	}
	err := s.scheduledStore.SetScheduledStatus(id, status)
	if errors.Is(err, store.ErrScheduleInvalid) {
		errJSON(w, http.StatusBadRequest, err.Error())
		return
	}
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	updated, _, err := s.scheduledStore.SelectScheduledByID(id)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toScheduledDTO(updated))
}

func (s *Server) handleScheduledConfirm(w http.ResponseWriter, r *http.Request) {
	s.handleScheduledStatus(w, r, "active")
}

func (s *Server) handleScheduledDismiss(w http.ResponseWriter, r *http.Request) {
	s.handleScheduledStatus(w, r, "dismissed")
}

func (s *Server) handleScheduledPause(w http.ResponseWriter, r *http.Request) {
	s.handleScheduledStatus(w, r, "paused")
}

// upcomingItemDTO is one upcoming (or overdue) bill in the feed. DueInDays is
// relative to today UTC; negative means overdue.
type upcomingItemDTO struct {
	scheduledDTO
	DueInDays int64 `json:"due_in_days"`
}

// upcomingResp is the GET /api/upcoming payload.
type upcomingResp struct {
	Days  int               `json:"days"`
	Items []upcomingItemDTO `json:"items"`
}

// defaultUpcomingDays is the horizon when ?days= is absent.
const defaultUpcomingDays = 14

func (s *Server) handleGetUpcoming(w http.ResponseWriter, r *http.Request) {
	if s.scheduledStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "scheduled unavailable")
		return
	}
	days := defaultUpcomingDays
	if raw := r.URL.Query().Get("days"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 || n > 366 {
			errJSON(w, http.StatusBadRequest, "days must be 0..366")
			return
		}
		days = n
	}
	now := time.Now().UTC()
	rows, err := s.scheduledStore.SelectUpcoming(now, days)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	items := make([]upcomingItemDTO, 0, len(rows))
	for _, row := range rows {
		item := upcomingItemDTO{scheduledDTO: toScheduledDTO(row)}
		if due, perr := time.Parse("2006-01-02", row.NextDue); perr == nil {
			item.DueInDays = int64(due.Sub(today) / (24 * time.Hour))
		}
		items = append(items, item)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(upcomingResp{Days: days, Items: items})
}
