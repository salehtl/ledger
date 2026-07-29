package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrTargetInvalid reports a category-target payload the store refuses to persist.
var ErrTargetInvalid = errors.New("invalid category target")

// CategoryTargetRow is one budgeting target attached to a category (at most
// one per category — category_id is the primary key). AmountFils is integer
// AED fils. DueDate ('YYYY-MM-DD') is set only for save_by_date targets.
type CategoryTargetRow struct {
	CategoryID int64
	TargetType string // 'set_aside' | 'refill' | 'save_by_date'
	AmountFils int64
	Cadence    string // 'weekly' | 'monthly' | 'yearly'; defaults to 'monthly'
	DueDate    string // "" unless save_by_date
	CreatedAt  string
	UpdatedAt  string
}

func validateTarget(t *CategoryTargetRow) error {
	if t.CategoryID <= 0 {
		return fmt.Errorf("%w: category_id required", ErrTargetInvalid)
	}
	switch t.TargetType {
	case "set_aside", "refill", "save_by_date":
	default:
		return fmt.Errorf("%w: target_type %q", ErrTargetInvalid, t.TargetType)
	}
	if t.AmountFils <= 0 {
		return fmt.Errorf("%w: amount_fils must be > 0", ErrTargetInvalid)
	}
	if t.Cadence == "" {
		t.Cadence = "monthly"
	}
	switch t.Cadence {
	case "weekly", "monthly", "yearly":
	default:
		return fmt.Errorf("%w: cadence %q", ErrTargetInvalid, t.Cadence)
	}
	if t.TargetType == "save_by_date" {
		if t.DueDate == "" {
			return fmt.Errorf("%w: save_by_date requires due_date", ErrTargetInvalid)
		}
		// Malformed dates must 400 here, not degrade later: the engine clamps
		// an unparseable due date to "due now", which would silently turn a
		// long-horizon goal into "entire remainder needed this month" and let
		// auto-assign drain RTA into it.
		if _, err := time.Parse("2006-01-02", t.DueDate); err != nil {
			return fmt.Errorf("%w: due_date %q (want YYYY-MM-DD)", ErrTargetInvalid, t.DueDate)
		}
	} else {
		// due_date exists iff save_by_date (contract §1); a stray value on a
		// set_aside/refill payload is dropped, never stored or echoed.
		t.DueDate = ""
	}
	return nil
}

// UpsertCategoryTarget inserts or overwrites the target for a category.
func (s *Store) UpsertCategoryTarget(t CategoryTargetRow) error {
	if err := validateTarget(&t); err != nil {
		return err
	}
	now := isoNow(s)
	_, err := s.DB.Exec(
		`INSERT INTO category_targets (category_id, target_type, amount_fils, cadence, due_date, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(category_id) DO UPDATE SET
		   target_type=excluded.target_type, amount_fils=excluded.amount_fils,
		   cadence=excluded.cadence, due_date=excluded.due_date, updated_at=excluded.updated_at`,
		t.CategoryID, t.TargetType, t.AmountFils, t.Cadence, nullableStr(t.DueDate), now, now,
	)
	return err
}

const targetColumns = `category_id, target_type, amount_fils, cadence, COALESCE(due_date,''), created_at, updated_at`

func scanTarget(sc interface{ Scan(...any) error }) (CategoryTargetRow, error) {
	var t CategoryTargetRow
	err := sc.Scan(&t.CategoryID, &t.TargetType, &t.AmountFils, &t.Cadence, &t.DueDate, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// SelectCategoryTargets lists every target, category order.
func (s *Store) SelectCategoryTargets() ([]CategoryTargetRow, error) {
	rows, err := s.DB.Query(`SELECT ` + targetColumns + ` FROM category_targets ORDER BY category_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CategoryTargetRow
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// SelectCategoryTarget fetches one category's target; ok=false when it has none.
func (s *Store) SelectCategoryTarget(categoryID int64) (CategoryTargetRow, bool, error) {
	t, err := scanTarget(s.DB.QueryRow(
		`SELECT `+targetColumns+` FROM category_targets WHERE category_id=?`, categoryID))
	if errors.Is(err, sql.ErrNoRows) {
		return t, false, nil
	}
	if err != nil {
		return t, false, err
	}
	return t, true, nil
}

// DeleteCategoryTarget removes a category's target (no-op if none).
func (s *Store) DeleteCategoryTarget(categoryID int64) error {
	_, err := s.DB.Exec(`DELETE FROM category_targets WHERE category_id=?`, categoryID)
	return err
}
