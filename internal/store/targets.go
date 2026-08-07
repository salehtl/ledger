package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrTargetInvalid reports a category-target payload the store refuses to persist.
var ErrTargetInvalid = errors.New("invalid category target")

// tombstoneTarget marks "no target from this month on". Removal writes one of
// these instead of deleting the row, because deleting would let the previous
// version resurrect and apply forever — the opposite of removing. It is never
// returned to callers; resolution filters it out.
const tombstoneTarget = "none"

// CategoryTargetRow is one *version* of a category's budgeting target. It
// applies from EffectiveMonth ('YYYY-MM') onward until a later version
// supersedes it, so a target set once carries forward and an edit made in
// month M never changes any month before M. AmountFils is integer AED fils.
// DueDate ('YYYY-MM-DD') is set only for save_by_date targets.
type CategoryTargetRow struct {
	CategoryID     int64
	EffectiveMonth string // 'YYYY-MM'
	TargetType     string // 'set_aside' | 'refill' | 'save_by_date'
	AmountFils     int64
	Cadence        string // 'weekly' | 'monthly' | 'yearly'; defaults to 'monthly'
	DueDate        string // "" unless save_by_date
	CreatedAt      string
	UpdatedAt      string
}

func validateTarget(t *CategoryTargetRow) error {
	if t.CategoryID <= 0 {
		return fmt.Errorf("%w: category_id required", ErrTargetInvalid)
	}
	if !validMonth(t.EffectiveMonth) {
		return fmt.Errorf("%w: effective_month %q (want YYYY-MM)", ErrTargetInvalid, t.EffectiveMonth)
	}
	switch t.TargetType {
	case "set_aside", "refill", "save_by_date":
	default:
		// tombstoneTarget lands here too: it is internal, and letting a caller
		// write one through this path would dodge the amount check below.
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

// UpsertCategoryTarget writes the target version effective from t.EffectiveMonth,
// overwriting an existing version at exactly that month. Earlier months are
// untouched.
func (s *Store) UpsertCategoryTarget(t CategoryTargetRow) error {
	if err := validateTarget(&t); err != nil {
		return err
	}
	return s.writeTargetVersion(t)
}

// writeTargetVersion is the unvalidated insert shared by the normal write path
// and the tombstone path.
func (s *Store) writeTargetVersion(t CategoryTargetRow) error {
	now := isoNow(s)
	_, err := s.DB.Exec(
		`INSERT INTO category_targets
		   (category_id, effective_month, target_type, amount_fils, cadence, due_date, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(category_id, effective_month) DO UPDATE SET
		   target_type=excluded.target_type, amount_fils=excluded.amount_fils,
		   cadence=excluded.cadence, due_date=excluded.due_date, updated_at=excluded.updated_at`,
		t.CategoryID, t.EffectiveMonth, t.TargetType, t.AmountFils, t.Cadence,
		nullableStr(t.DueDate), now, now,
	)
	return err
}

const targetColumns = `category_id, effective_month, target_type, amount_fils, cadence, COALESCE(due_date,''), created_at, updated_at`

func scanTarget(sc interface{ Scan(...any) error }) (CategoryTargetRow, error) {
	var t CategoryTargetRow
	err := sc.Scan(&t.CategoryID, &t.EffectiveMonth, &t.TargetType, &t.AmountFils,
		&t.Cadence, &t.DueDate, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

// resolveClause keeps only each category's newest version at or before the
// month, then drops tombstones. Both placeholders take the same month.
const resolveClause = `
	  FROM category_targets t
	 WHERE t.effective_month <= ?
	   AND t.effective_month = (SELECT MAX(x.effective_month) FROM category_targets x
	                             WHERE x.category_id = t.category_id
	                               AND x.effective_month <= ?)
	   AND t.target_type <> '` + tombstoneTarget + `'`

// SelectCategoryTargetsForMonth lists the targets in force during month
// ('YYYY-MM'), category order. A category whose newest version is a tombstone,
// or whose first version starts later, is absent.
func (s *Store) SelectCategoryTargetsForMonth(month string) ([]CategoryTargetRow, error) {
	if !validMonth(month) {
		return nil, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrTargetInvalid, month)
	}
	rows, err := s.DB.Query(
		`SELECT `+targetColumns+resolveClause+` ORDER BY t.category_id`, month, month)
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

// SelectCategoryTargetForMonth resolves one category's target for month;
// ok=false when it has none in force.
func (s *Store) SelectCategoryTargetForMonth(categoryID int64, month string) (CategoryTargetRow, bool, error) {
	if !validMonth(month) {
		return CategoryTargetRow{}, false, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrTargetInvalid, month)
	}
	t, err := scanTarget(s.DB.QueryRow(
		`SELECT `+targetColumns+resolveClause+` AND t.category_id = ?`, month, month, categoryID))
	if errors.Is(err, sql.ErrNoRows) {
		return t, false, nil
	}
	if err != nil {
		return t, false, err
	}
	return t, true, nil
}

// DeleteCategoryTarget stops the target from month onward by writing a
// tombstone version. Months before it keep whatever was in force.
func (s *Store) DeleteCategoryTarget(categoryID int64, month string) error {
	if categoryID <= 0 {
		return fmt.Errorf("%w: category_id required", ErrTargetInvalid)
	}
	if !validMonth(month) {
		return fmt.Errorf("%w: month %q (want YYYY-MM)", ErrTargetInvalid, month)
	}
	return s.writeTargetVersion(CategoryTargetRow{
		CategoryID: categoryID, EffectiveMonth: month,
		TargetType: tombstoneTarget, AmountFils: 0, Cadence: "monthly",
	})
}
