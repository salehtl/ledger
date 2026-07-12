package store

import (
	"strings"
	"time"
)

// ProjectRow is one row of the projects table. BudgetFils is nil when no budget
// is set. Date fields are ISO strings, empty when unset.
type ProjectRow struct {
	ID             int64
	Name           string
	BudgetFils     *int64
	Color          string
	StartsOn       string
	EndsOn         string
	Status         string
	CountInMonthly bool
	CompletedAt    string
	CreatedAt      string
	UpdatedAt      string
}

// InsertProject writes one project and returns its new row ID.
func (s *Store) InsertProject(p ProjectRow) (int64, error) {
	now := isoNow(s)
	if p.Status == "" {
		p.Status = "active"
	}
	res, err := s.DB.Exec(
		`INSERT INTO projects (name, budget_fils, color, starts_on, ends_on, status, count_in_monthly, completed_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.Name, p.BudgetFils, nullableStr(p.Color), nullableStr(p.StartsOn), nullableStr(p.EndsOn),
		p.Status, boolToInt(p.CountInMonthly), nullableStr(p.CompletedAt), now, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SelectProjects lists projects, active-first then most-recently-completed;
// completed projects are excluded unless includeCompleted is set.
func (s *Store) SelectProjects(includeCompleted bool) ([]ProjectRow, error) {
	q := `SELECT id, name, budget_fils, COALESCE(color,''), COALESCE(starts_on,''), COALESCE(ends_on,''),
	             status, count_in_monthly, COALESCE(completed_at,''), created_at, updated_at
	        FROM projects`
	if !includeCompleted {
		q += ` WHERE status != 'completed'`
	}
	q += ` ORDER BY (status='completed'), COALESCE(completed_at, updated_at) DESC, id DESC`
	rows, err := s.DB.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ProjectRow
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SelectProject fetches one project by id.
func (s *Store) SelectProject(id int64) (ProjectRow, error) {
	row := s.DB.QueryRow(
		`SELECT id, name, budget_fils, COALESCE(color,''), COALESCE(starts_on,''), COALESCE(ends_on,''),
		        status, count_in_monthly, COALESCE(completed_at,''), created_at, updated_at
		   FROM projects WHERE id = ?`, id)
	return scanProject(row)
}

// UpdateProject overwrites a project's mutable fields and bumps updated_at.
func (s *Store) UpdateProject(p ProjectRow) error {
	_, err := s.DB.Exec(
		`UPDATE projects SET name=?, budget_fils=?, color=?, starts_on=?, ends_on=?,
		        status=?, count_in_monthly=?, completed_at=?, updated_at=? WHERE id=?`,
		p.Name, p.BudgetFils, nullableStr(p.Color), nullableStr(p.StartsOn), nullableStr(p.EndsOn),
		p.Status, boolToInt(p.CountInMonthly), nullableStr(p.CompletedAt), isoNow(s), p.ID,
	)
	return err
}

// DeleteProject un-assigns the project's transactions, then deletes the
// project, in one transaction. Transactions are never deleted.
func (s *Store) DeleteProject(id int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE transactions SET project_id=NULL WHERE project_id=?`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM projects WHERE id=?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// AssignTransactionProject sets (or clears, when projectID is nil) a single
// transaction's project.
func (s *Store) AssignTransactionProject(txnID int64, projectID *int64) error {
	_, err := s.DB.Exec(`UPDATE transactions SET project_id=?, updated_at=? WHERE id=?`, projectID, isoNow(s), txnID)
	return err
}

// BulkAssignProject assigns projectID to every transaction in txnIDs,
// returning the number of rows affected.
func (s *Store) BulkAssignProject(projectID int64, txnIDs []int64) (int, error) {
	return s.bulkSetProject(&projectID, txnIDs)
}

// BulkUnassignProject clears project_id on every transaction in txnIDs.
func (s *Store) BulkUnassignProject(txnIDs []int64) (int, error) {
	return s.bulkSetProject(nil, txnIDs)
}

func (s *Store) bulkSetProject(projectID *int64, txnIDs []int64) (int, error) {
	if len(txnIDs) == 0 {
		return 0, nil
	}
	ph := make([]string, len(txnIDs))
	args := make([]any, 0, len(txnIDs)+2)
	args = append(args, projectID, isoNow(s))
	for i, id := range txnIDs {
		ph[i] = "?"
		args = append(args, id)
	}
	res, err := s.DB.Exec(
		`UPDATE transactions SET project_id=?, updated_at=? WHERE id IN (`+strings.Join(ph, ",")+`)`, args...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// --- small helpers ---

func scanProject(sc interface{ Scan(...any) error }) (ProjectRow, error) {
	var p ProjectRow
	var cim int
	if err := sc.Scan(&p.ID, &p.Name, &p.BudgetFils, &p.Color, &p.StartsOn, &p.EndsOn,
		&p.Status, &cim, &p.CompletedAt, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return p, err
	}
	p.CountInMonthly = cim == 1
	return p, nil
}

// isoNow returns the store clock (s.now(), unix seconds — overridable via
// SetNow for deterministic tests) formatted as an ISO/RFC3339 string, so
// project timestamps use the same clock as AI-usage rows while matching the
// TEXT ISO format the rest of the schema uses.
func isoNow(s *Store) string { return time.Unix(s.now(), 0).UTC().Format(time.RFC3339) }

// ProjectCategorySpend is one category's confirmed net spend within a project.
type ProjectCategorySpend struct {
	Category string `json:"category"`
	NetFils  int64  `json:"net_fils"`
}

// ProjectRollup is the computed spend summary for one project: net spend and
// transaction count over confirmed transactions, pending (needs_review)
// amount, and a confirmed-net breakdown by category (highest first).
type ProjectRollup struct {
	Project      ProjectRow             `json:"-"`
	NetSpentFils int64                  `json:"net_spent_fils"`
	PendingFils  int64                  `json:"pending_fils"`
	TxnCount     int                    `json:"txn_count"`
	ByCategory   []ProjectCategorySpend `json:"by_category"`
}

// projAmt AED-normalizes an amount: AED-native rows without a stored
// amount_aed still count via the fallback to amount.
const projAmt = `COALESCE(t.amount_aed, t.amount)`

// ProjectRollup computes the single-project rollup (net spend, pending,
// txn count, and by-category breakdown) for detail views.
func (s *Store) ProjectRollup(id int64) (ProjectRollup, error) {
	p, err := s.SelectProject(id)
	if err != nil {
		return ProjectRollup{}, err
	}
	r := ProjectRollup{Project: p}
	// net + count (confirmed) and pending in one pass.
	err = s.DB.QueryRow(
		`SELECT
		   COALESCE(SUM(CASE WHEN t.status='confirmed' THEN
		       (CASE t.direction WHEN 'debit' THEN `+projAmt+` WHEN 'credit' THEN -`+projAmt+` ELSE 0 END)
		     ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN t.status='needs_review' THEN
		       (CASE t.direction WHEN 'debit' THEN `+projAmt+` WHEN 'credit' THEN -`+projAmt+` ELSE 0 END)
		     ELSE 0 END), 0),
		   COALESCE(SUM(CASE WHEN t.status='confirmed' THEN 1 ELSE 0 END), 0)
		 FROM transactions t WHERE t.project_id = ?`, id,
	).Scan(&r.NetSpentFils, &r.PendingFils, &r.TxnCount)
	if err != nil {
		return r, err
	}
	// by-category (confirmed net), highest spend first.
	rows, err := s.DB.Query(
		`SELECT COALESCE(c.name,'Uncategorized'),
		        SUM(CASE t.direction WHEN 'debit' THEN `+projAmt+` WHEN 'credit' THEN -`+projAmt+` ELSE 0 END)
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  WHERE t.project_id = ? AND t.status='confirmed'
		  GROUP BY c.name ORDER BY 2 DESC`, id)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	for rows.Next() {
		var cs ProjectCategorySpend
		if err := rows.Scan(&cs.Category, &cs.NetFils); err != nil {
			return r, err
		}
		r.ByCategory = append(r.ByCategory, cs)
	}
	return r, rows.Err()
}

// ProjectRollups returns rollups for the list/cards without N+1: it fetches all
// projects then a single grouped aggregate, and attaches. ByCategory is left nil
// here (only the detail view needs it) to keep the list query cheap.
func (s *Store) ProjectRollups(includeCompleted bool) ([]ProjectRollup, error) {
	projects, err := s.SelectProjects(includeCompleted)
	if err != nil {
		return nil, err
	}
	agg := map[int64]*ProjectRollup{}
	out := make([]ProjectRollup, len(projects))
	for i := range projects {
		out[i] = ProjectRollup{Project: projects[i]}
		agg[projects[i].ID] = &out[i]
	}
	rows, err := s.DB.Query(
		`SELECT t.project_id,
		   COALESCE(SUM(CASE WHEN t.status='confirmed' THEN
		     (CASE t.direction WHEN 'debit' THEN ` + projAmt + ` WHEN 'credit' THEN -` + projAmt + ` ELSE 0 END) ELSE 0 END),0),
		   COALESCE(SUM(CASE WHEN t.status='needs_review' THEN
		     (CASE t.direction WHEN 'debit' THEN ` + projAmt + ` WHEN 'credit' THEN -` + projAmt + ` ELSE 0 END) ELSE 0 END),0),
		   COALESCE(SUM(CASE WHEN t.status='confirmed' THEN 1 ELSE 0 END),0)
		 FROM transactions t WHERE t.project_id IS NOT NULL GROUP BY t.project_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pid, net, pending int64
		var cnt int
		if err := rows.Scan(&pid, &net, &pending, &cnt); err != nil {
			return nil, err
		}
		if r, ok := agg[pid]; ok {
			r.NetSpentFils, r.PendingFils, r.TxnCount = net, pending, cnt
		}
	}
	return out, rows.Err()
}
