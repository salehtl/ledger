package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"ledger/internal/store"
)

// ProjectStore is the store surface the projects endpoints need.
type ProjectStore interface {
	InsertProject(store.ProjectRow) (int64, error)
	SelectProjects(bool) ([]store.ProjectRow, error)
	SelectProject(int64) (store.ProjectRow, error)
	UpdateProject(store.ProjectRow) error
	DeleteProject(int64) error
	ProjectRollup(int64) (store.ProjectRollup, error)
	ProjectRollups(bool) ([]store.ProjectRollup, error)
	AssignTransactionProject(int64, *int64) error
	BulkAssignProject(int64, []int64) (int, error)
	BulkUnassignProject([]int64) (int, error)
}

// SetProjectStore wires the projects store. Required for /api/projects and
// the transaction/project assignment endpoints.
func (s *Server) SetProjectStore(ps ProjectStore) { s.projectStore = ps }

// projectDTO is the JSON representation of a project, snake_case to match
// the rest of the projects API surface. ByCategory is only populated on the
// single-project detail endpoint (omitted, via omitempty, on the list).
type projectDTO struct {
	ID             int64                        `json:"id"`
	Name           string                       `json:"name"`
	BudgetFils     *int64                       `json:"budget_fils"`
	Color          string                       `json:"color"`
	StartsOn       string                       `json:"starts_on"`
	EndsOn         string                       `json:"ends_on"`
	Status         string                       `json:"status"`
	CountInMonthly bool                         `json:"count_in_monthly"`
	CompletedAt    string                       `json:"completed_at"`
	NetSpentFils   int64                        `json:"net_spent_fils"`
	PendingFils    int64                        `json:"pending_fils"`
	TxnCount       int                          `json:"txn_count"`
	ByCategory     []store.ProjectCategorySpend `json:"by_category,omitempty"`
}

// projectInputDTO is the writable shape for POST/PUT. completed_at is never
// accepted from the client — it is always derived server-side from the
// status transition.
type projectInputDTO struct {
	Name           string `json:"name"`
	BudgetFils     *int64 `json:"budget_fils"`
	Color          string `json:"color"`
	StartsOn       string `json:"starts_on"`
	EndsOn         string `json:"ends_on"`
	Status         string `json:"status"`
	CountInMonthly bool   `json:"count_in_monthly"`
}

func toProjectDTO(rl store.ProjectRollup, detail bool) projectDTO {
	p := rl.Project
	dto := projectDTO{
		ID: p.ID, Name: p.Name, BudgetFils: p.BudgetFils, Color: p.Color,
		StartsOn: p.StartsOn, EndsOn: p.EndsOn, Status: p.Status,
		CountInMonthly: p.CountInMonthly, CompletedAt: p.CompletedAt,
		NetSpentFils: rl.NetSpentFils, PendingFils: rl.PendingFils, TxnCount: rl.TxnCount,
	}
	if detail {
		bc := rl.ByCategory
		if bc == nil {
			bc = []store.ProjectCategorySpend{}
		}
		dto.ByCategory = bc
	}
	return dto
}

// nowISO returns the current time formatted the same way the store formats
// project timestamps (RFC3339 UTC), so completed_at set by the server reads
// consistently with created_at/updated_at.
func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

func (s *Server) handleGetProjects(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	includeCompleted := r.URL.Query().Get("include_completed") == "1"
	rollups, err := s.projectStore.ProjectRollups(includeCompleted)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	out := make([]projectDTO, 0, len(rollups))
	for _, rl := range rollups {
		out = append(out, toProjectDTO(rl, false))
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

func (s *Server) handlePostProject(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var in projectInputDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}
	row := store.ProjectRow{
		Name: in.Name, BudgetFils: in.BudgetFils, Color: in.Color,
		StartsOn: in.StartsOn, EndsOn: in.EndsOn, Status: in.Status,
		CountInMonthly: in.CountInMonthly,
	}
	if row.Status == "" {
		row.Status = "active"
	}
	if row.Status == "completed" {
		row.CompletedAt = nowISO()
	}
	id, err := s.projectStore.InsertProject(row)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]any{"id": id})
}

// projectIDFromPath parses the {id} path value shared by all
// /api/projects/{id}... routes. Returns ok=false after writing a 400.
func (s *Server) projectIDFromPath(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return 0, false
	}
	return id, true
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, ok := s.projectIDFromPath(w, r)
	if !ok {
		return
	}
	rl, err := s.projectStore.ProjectRollup(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(toProjectDTO(rl, true))
}

func (s *Server) handlePutProject(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, ok := s.projectIDFromPath(w, r)
	if !ok {
		return
	}
	cur, err := s.projectStore.SelectProject(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	var in projectInputDTO
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}
	status := in.Status
	if status == "" {
		status = cur.Status
	}
	row := store.ProjectRow{
		ID: id, Name: in.Name, BudgetFils: in.BudgetFils, Color: in.Color,
		StartsOn: in.StartsOn, EndsOn: in.EndsOn, Status: status,
		CountInMonthly: in.CountInMonthly,
	}
	// completed_at is always server-derived from the transition, never
	// trusted from the client: set it the moment status flips to
	// 'completed', clear it the moment it flips away, otherwise carry the
	// existing value forward (covers PUTs that don't touch status at all).
	switch {
	case status == "completed" && cur.Status != "completed":
		row.CompletedAt = nowISO()
	case status != "completed":
		row.CompletedAt = ""
	default:
		row.CompletedAt = cur.CompletedAt
	}
	if err := s.projectStore.UpdateProject(row); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	id, ok := s.projectIDFromPath(w, r)
	if !ok {
		return
	}
	if err := s.projectStore.DeleteProject(id); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// assignProjectReq is the body for POST /api/transactions/{id}/project.
// ProjectID is a pointer so an explicit JSON null clears the assignment,
// distinct from the field being omitted.
type assignProjectReq struct {
	ProjectID *int64 `json:"project_id"`
}

func (s *Server) handleAssignTxnProject(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	txID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || txID <= 0 {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}
	var req assignProjectReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	if err := s.projectStore.AssignTransactionProject(txID, req.ProjectID); err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// bulkTxnIDsReq is the shared body for the project bulk assign/unassign
// endpoints.
type bulkTxnIDsReq struct {
	TransactionIDs []int64 `json:"transaction_ids"`
}

func (s *Server) handleBulkAssign(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	pid, ok := s.projectIDFromPath(w, r)
	if !ok {
		return
	}
	var req bulkTxnIDsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	n, err := s.projectStore.BulkAssignProject(pid, req.TransactionIDs)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"assigned": n})
}

func (s *Server) handleBulkUnassign(w http.ResponseWriter, r *http.Request) {
	if s.projectStore == nil {
		http.Error(w, `{"error":"projects unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if _, ok := s.projectIDFromPath(w, r); !ok {
		return
	}
	var req bulkTxnIDsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	n, err := s.projectStore.BulkUnassignProject(req.TransactionIDs)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"unassigned": n})
}
