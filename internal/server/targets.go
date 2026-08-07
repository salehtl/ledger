package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"ledger/internal/store"
)

// TargetsStore is the store surface the category-target endpoints need.
type TargetsStore interface {
	UpsertCategoryTarget(store.CategoryTargetRow) error
	SelectCategoryTargetsForMonth(month string) ([]store.CategoryTargetRow, error)
	SelectCategoryTargetForMonth(categoryID int64, month string) (store.CategoryTargetRow, bool, error)
	DeleteCategoryTarget(categoryID int64, month string) error
}

// SetTargetsStore wires the targets store. Required for /api/targets.
func (s *Server) SetTargetsStore(ts TargetsStore) { s.targetsStore = ts }

// errJSON writes {"error": msg} with the given status — the shared error body
// for the v3 endpoints, whose store sentinels carry useful messages.
func errJSON(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// isFKViolation sniffs SQLite's foreign-key error so a target/split against a
// nonexistent category maps to 400, not 500.
func isFKViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "FOREIGN KEY constraint")
}

// targetDTO is the wire shape of one category target, snake_case like the rest
// of the v3 API surface.
type targetDTO struct {
	CategoryID int64 `json:"category_id"`
	// The month this version was set from. A later month inheriting it reports
	// the earlier month, which is how the client can say where a target came from.
	EffectiveMonth string `json:"effective_month"`
	TargetType     string `json:"target_type"` // set_aside | refill | save_by_date
	AmountFils     int64  `json:"amount_fils"`
	Cadence        string `json:"cadence"`            // weekly | monthly | yearly
	DueDate        string `json:"due_date,omitempty"` // YYYY-MM-DD, save_by_date only
	CreatedAt      string `json:"created_at"`
	UpdatedAt      string `json:"updated_at"`
}

func toTargetDTO(t store.CategoryTargetRow) targetDTO {
	return targetDTO{
		CategoryID: t.CategoryID, EffectiveMonth: t.EffectiveMonth, TargetType: t.TargetType,
		AmountFils: t.AmountFils, Cadence: t.Cadence, DueDate: t.DueDate,
		CreatedAt: t.CreatedAt, UpdatedAt: t.UpdatedAt,
	}
}

// targetInputDTO is the writable shape for PUT /api/targets/{categoryId}.
type targetInputDTO struct {
	Month      string `json:"month"` // 'YYYY-MM'; the version is written here
	TargetType string `json:"target_type"`
	AmountFils int64  `json:"amount_fils"`
	Cadence    string `json:"cadence"`
	DueDate    string `json:"due_date"`
}

// categoryIDFromPath parses the {categoryId} path value shared by the target
// routes. Returns ok=false after writing a 400.
func categoryIDFromPath(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("categoryId"), 10, 64)
	if err != nil || id <= 0 {
		errJSON(w, http.StatusBadRequest, "invalid category id")
		return 0, false
	}
	return id, true
}

// monthFromQuery reads ?month=YYYY-MM. Returns ok=false after writing a 400.
// Deliberately required rather than defaulting to the current month: these
// endpoints now change history from a point forward, and guessing which point
// is not a decision the server should make on the client's behalf.
func monthFromQuery(w http.ResponseWriter, r *http.Request) (string, bool) {
	m := r.URL.Query().Get("month")
	if !store.ValidMonth(m) {
		errJSON(w, http.StatusBadRequest, "month required (YYYY-MM)")
		return "", false
	}
	return m, true
}

func (s *Server) handleGetTargets(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	month, ok := monthFromQuery(w, r)
	if !ok {
		return
	}
	targets, err := s.targetsStore.SelectCategoryTargetsForMonth(month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	out := make([]targetDTO, 0, len(targets))
	for _, t := range targets {
		out = append(out, toTargetDTO(t))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handleGetTarget(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	catID, ok := categoryIDFromPath(w, r)
	if !ok {
		return
	}
	month, ok := monthFromQuery(w, r)
	if !ok {
		return
	}
	t, found, err := s.targetsStore.SelectCategoryTargetForMonth(catID, month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	if !found {
		errJSON(w, http.StatusNotFound, "no target for category")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toTargetDTO(t))
}

func (s *Server) handlePutTarget(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	catID, ok := categoryIDFromPath(w, r)
	if !ok {
		return
	}
	var in targetInputDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid json")
		return
	}
	if !store.ValidMonth(in.Month) {
		errJSON(w, http.StatusBadRequest, "month required (YYYY-MM)")
		return
	}
	err := s.targetsStore.UpsertCategoryTarget(store.CategoryTargetRow{
		CategoryID: catID, EffectiveMonth: in.Month, TargetType: in.TargetType,
		AmountFils: in.AmountFils, Cadence: in.Cadence, DueDate: in.DueDate,
	})
	if errors.Is(err, store.ErrTargetInvalid) {
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
	t, found, err := s.targetsStore.SelectCategoryTargetForMonth(catID, in.Month)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	if !found {
		// The write just succeeded, so a miss here means something else (e.g. a
		// concurrent delete for the same category+month) raced the read. Report
		// it rather than serialize a zero-value target the client would render
		// as if it were real.
		errJSON(w, http.StatusInternalServerError, "target vanished after write")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toTargetDTO(t))
}

func (s *Server) handleDeleteTarget(w http.ResponseWriter, r *http.Request) {
	if s.targetsStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "targets unavailable")
		return
	}
	catID, ok := categoryIDFromPath(w, r)
	if !ok {
		return
	}
	month, ok := monthFromQuery(w, r)
	if !ok {
		return
	}
	if err := s.targetsStore.DeleteCategoryTarget(catID, month); err != nil {
		if errors.Is(err, store.ErrTargetInvalid) {
			errJSON(w, http.StatusBadRequest, err.Error())
			return
		}
		if isFKViolation(err) {
			errJSON(w, http.StatusBadRequest, "unknown category")
			return
		}
		errJSON(w, http.StatusInternalServerError, "db error")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}
