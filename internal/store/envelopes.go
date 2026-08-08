package store

import (
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"time"
)

// ErrEnvelopeInvalid reports an envelope-assignment payload the store refuses.
var ErrEnvelopeInvalid = errors.New("invalid envelope assignment")

// EnvelopeAssignmentRow is one month's assignment to one category ("give every
// dirham a job"). AssignedFils is integer AED fils; unique per (month, category).
type EnvelopeAssignmentRow struct {
	Month        string // 'YYYY-MM'
	CategoryID   int64
	AssignedFils int64
	UpdatedAt    string
}

// validMonth accepts 'YYYY-MM' only — the format every envelope query compares
// lexically against substr(posted_at, 1, 7).
func validMonth(month string) bool {
	if len(month) != 7 || month[4] != '-' {
		return false
	}
	for i, c := range month {
		if i == 4 {
			continue
		}
		if c < '0' || c > '9' {
			return false
		}
	}
	mm := int(month[5]-'0')*10 + int(month[6]-'0')
	return mm >= 1 && mm <= 12
}

// ValidMonth reports whether s is a 'YYYY-MM' month string. Exported for
// handlers that must validate a month before it reaches a store method.
func ValidMonth(s string) bool { return validMonth(s) }

// rowQuerier is the QueryRow slice of *sql.DB / *sql.Tx, so validation helpers
// run inside or outside an explicit transaction.
type rowQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

// envelopeCategoryOK verifies the assignment target is an actual envelope: an
// existing, active, spending-kind category. Money assigned to anything else
// (income kinds, deactivated rows) would be accepted by the FK but never
// surfaced by EnvelopeMonthSummary — silently invisible assigned fils that
// break the RTA identity — so the store refuses it up front.
func envelopeCategoryOK(q rowQuerier, categoryID int64) error {
	var one int
	err := q.QueryRow(
		`SELECT 1 FROM categories WHERE id=? AND is_active=1 AND kind='spending'`, categoryID,
	).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: category %d is not an active spending category", ErrEnvelopeInvalid, categoryID)
	}
	return err
}

// UpsertEnvelopeAssignment sets the absolute assigned amount for one category
// in one month.
func (s *Store) UpsertEnvelopeAssignment(month string, categoryID, assignedFils int64) error {
	if !validMonth(month) {
		return fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	if categoryID <= 0 {
		return fmt.Errorf("%w: category_id required", ErrEnvelopeInvalid)
	}
	if err := envelopeCategoryOK(s.DB, categoryID); err != nil {
		return err
	}
	_, err := s.DB.Exec(
		`INSERT INTO envelope_assignments (month, category_id, assigned_fils, updated_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(month, category_id) DO UPDATE SET
		   assigned_fils=excluded.assigned_fils, updated_at=excluded.updated_at`,
		month, categoryID, assignedFils, isoNow(s),
	)
	return err
}

// UpsertEnvelopeAssignments batch-sets absolute assignments for one month in a
// single SQL transaction (the /api/envelopes/assign payload).
func (s *Store) UpsertEnvelopeAssignments(month string, byCategory map[int64]int64) error {
	if !validMonth(month) {
		return fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := isoNow(s)
	for categoryID, fils := range byCategory {
		if categoryID <= 0 {
			return fmt.Errorf("%w: category_id required", ErrEnvelopeInvalid)
		}
		if err := envelopeCategoryOK(tx, categoryID); err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO envelope_assignments (month, category_id, assigned_fils, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT(month, category_id) DO UPDATE SET
			   assigned_fils=excluded.assigned_fils, updated_at=excluded.updated_at`,
			month, categoryID, fils, now,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AddToEnvelopeAssignment adds deltaFils (may be negative — the move-money
// source side) to a category's assignment for a month, creating the row at
// deltaFils if absent, and returns the new assigned value. Negative results
// are allowed; over-assignment policy is the engine's concern.
func (s *Store) AddToEnvelopeAssignment(month string, categoryID, deltaFils int64) (int64, error) {
	if !validMonth(month) {
		return 0, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	if categoryID <= 0 {
		return 0, fmt.Errorf("%w: category_id required", ErrEnvelopeInvalid)
	}
	if err := envelopeCategoryOK(s.DB, categoryID); err != nil {
		return 0, err
	}
	var assigned int64
	err := s.DB.QueryRow(
		envelopeAddDeltaSQL,
		month, categoryID, deltaFils, isoNow(s),
	).Scan(&assigned)
	return assigned, err
}

// envelopeAddDeltaSQL is the shared add-delta upsert AddToEnvelopeAssignment,
// MoveEnvelopeAssignment and ApplyEnvelopeDeltas all execute.
const envelopeAddDeltaSQL = `INSERT INTO envelope_assignments (month, category_id, assigned_fils, updated_at)
	 VALUES (?, ?, ?, ?)
	 ON CONFLICT(month, category_id) DO UPDATE SET
	   assigned_fils = assigned_fils + excluded.assigned_fils, updated_at=excluded.updated_at
	 RETURNING assigned_fils`

// MoveEnvelopeAssignment is the move-money primitive: it takes amountFils from
// one envelope's assignment and gives it to another, same month, in ONE SQL
// transaction — either both legs land or neither, so a mid-move failure can
// never leave assigned money vanished (the scope's move-money atomicity
// requirement). The source may go negative-assigned (over-move is the user's
// call; RTA math absorbs it).
func (s *Store) MoveEnvelopeAssignment(month string, fromCategoryID, toCategoryID, amountFils int64) error {
	if !validMonth(month) {
		return fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	if fromCategoryID <= 0 || toCategoryID <= 0 || fromCategoryID == toCategoryID {
		return fmt.Errorf("%w: from/to category ids must be set and differ", ErrEnvelopeInvalid)
	}
	if amountFils <= 0 {
		return fmt.Errorf("%w: amount_fils must be > 0", ErrEnvelopeInvalid)
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := isoNow(s)
	for _, leg := range []struct {
		categoryID int64
		delta      int64
	}{
		{fromCategoryID, -amountFils},
		{toCategoryID, amountFils},
	} {
		if err := envelopeCategoryOK(tx, leg.categoryID); err != nil {
			return err
		}
		var assigned int64
		if err := tx.QueryRow(envelopeAddDeltaSQL, month, leg.categoryID, leg.delta, now).Scan(&assigned); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// seedHorizonMonths is how far beyond the current calendar month seeding will
// reach. The month picker has no upper bound and both the Plan screen and the
// Home strip hit GET /api/envelopes, so without a ceiling a few taps of "next
// month" write a full plan into each month passed through. That is worse than
// wasted rows: a seeded month HAS rows, so it counts as "touched" forever and
// can never re-inherit a later revision of the plan — the stale snapshot is
// frozen in. A year of look-ahead is far more than the UI is used for.
const seedHorizonMonths = 12

// SeedEnvelopeAssignmentsFromPreviousMonth copies the most recent planned
// month's positive assignments into month, so a stable budget does not have to
// be re-entered every month. Returns how many rows it wrote; 0 when it
// declines. Idempotent.
//
// It declines unless all four hold:
//
//   - month has NO rows at all. Zeroing a month through the assign sheet
//     WRITES rows, so "has rows" is the faithful record of "the user has
//     touched this month" — a month deliberately emptied stays empty instead
//     of refilling itself. Do not weaken this to "has no non-zero rows".
//   - some earlier month has a POSITIVE assignment to a category still
//     eligible (active, kind='spending' — the same predicate
//     envelopeCategoryOK/EnvelopeMonthSummary use). The greatest such month
//     wins, so jumping ahead over empty months inherits the last real plan
//     rather than an empty one. A month with no positive eligible row — every
//     row zero, negative, or belonging to a category since deactivated or
//     re-kinded (e.g. edited to 'income') — is not eligible as a source at
//     all; otherwise it would be picked and then nothing would be copied,
//     silently producing a zero-row "seed" that leaves the target month
//     looking untouched forever.
//   - month is the current calendar month or later. Browsing back through
//     history must never rewrite it.
//   - month is at most seedHorizonMonths beyond the current calendar month
//     (see that constant).
//
// Negative assignments do NOT carry, and this is load-bearing. A negative
// assigned_fils is legitimate — move-money may over-draw a source envelope —
// but it records a ONE-OFF correction ("I took money out of this envelope this
// month to fund another"), not a recurring plan element. envelopeEraFold runs
// the era balance as b += assigned − activity and charges the RISE in the
// negative high-water mark to the next month's Ready to Assign; a carried
// negative therefore drives the balance further negative every month it is
// copied, and each copy is billed as fresh overspend debt for spending that
// never happened. Seeding three months ahead of a single −218,510 over-draw
// used to charge that amount against RTA three separate times and render the
// envelope overspent in months with zero activity.
//
// Rows belonging to a category that is no longer an active spending category
// are never copied — EnvelopeMonthSummary would never surface them, so copying
// them would produce assigned fils invisible to every budget view (silently
// breaking the RTA identity).
func (s *Store) SeedEnvelopeAssignmentsFromPreviousMonth(month string) (int, error) {
	if !validMonth(month) {
		return 0, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	now := time.Now().UTC()
	if month < now.Format("2006-01") {
		return 0, nil
	}
	// Build the horizon by normalising year/month arithmetic rather than
	// time.AddDate, which normalises DAY overflow (Jan 31 + 1 month → Mar 3)
	// and would shift the boundary by a whole month at the end of long months.
	horizonY, horizonM := now.Year(), int(now.Month())+seedHorizonMonths
	horizonY, horizonM = horizonY+(horizonM-1)/12, (horizonM-1)%12+1
	if month > fmt.Sprintf("%04d-%02d", horizonY, horizonM) {
		return 0, nil
	}

	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Re-check inside the transaction: the caller's mutex serialises the HTTP
	// handlers, but nothing stops another writer.
	var existing int
	if err := tx.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, month).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	var source sql.NullString
	err = tx.QueryRow(
		`SELECT MAX(ea.month) FROM envelope_assignments ea
		   JOIN categories c ON c.id = ea.category_id
		  WHERE ea.month < ? AND ea.assigned_fils > 0
		    AND c.is_active=1 AND c.kind='spending'`,
		month).Scan(&source)
	if err != nil {
		return 0, err
	}
	if !source.Valid {
		return 0, nil
	}

	res, err := tx.Exec(
		`INSERT INTO envelope_assignments (month, category_id, assigned_fils, updated_at)
		 SELECT ?, ea.category_id, ea.assigned_fils, ?
		   FROM envelope_assignments ea
		   JOIN categories c ON c.id = ea.category_id
		  WHERE ea.month = ? AND ea.assigned_fils > 0
		    AND c.is_active=1 AND c.kind='spending'`,
		month, isoNow(s), source.String)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int(n), nil
}

// EnvelopeDelta is one category's share of a batch add-delta write (the
// auto-assign plan application).
type EnvelopeDelta struct {
	CategoryID int64
	DeltaFils  int64
}

// ApplyEnvelopeDeltas applies a whole allocation plan in ONE SQL transaction,
// so a mid-plan failure never leaves a partially applied auto-assign the
// client can't see. A nil/empty plan is a no-op.
func (s *Store) ApplyEnvelopeDeltas(month string, deltas []EnvelopeDelta) error {
	if !validMonth(month) {
		return fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	if len(deltas) == 0 {
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := isoNow(s)
	for _, d := range deltas {
		if d.CategoryID <= 0 {
			return fmt.Errorf("%w: category_id required", ErrEnvelopeInvalid)
		}
		if err := envelopeCategoryOK(tx, d.CategoryID); err != nil {
			return err
		}
		var assigned int64
		if err := tx.QueryRow(envelopeAddDeltaSQL, month, d.CategoryID, d.DeltaFils, now).Scan(&assigned); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SelectEnvelopeAssignments lists one month's assignments, category order.
func (s *Store) SelectEnvelopeAssignments(month string) ([]EnvelopeAssignmentRow, error) {
	rows, err := s.DB.Query(
		`SELECT month, category_id, assigned_fils, updated_at
		   FROM envelope_assignments WHERE month=? ORDER BY category_id`, month)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []EnvelopeAssignmentRow
	for rows.Next() {
		var r EnvelopeAssignmentRow
		if err := rows.Scan(&r.Month, &r.CategoryID, &r.AssignedFils, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// TotalAssigned sums one month's assignments (the Ready-to-Assign subtrahend).
func (s *Store) TotalAssigned(month string) (int64, error) {
	var total int64
	err := s.DB.QueryRow(
		`SELECT COALESCE(SUM(assigned_fils),0) FROM envelope_assignments WHERE month=?`, month,
	).Scan(&total)
	return total, err
}

// EnvelopeMonthRow is one category's envelope numbers for a month. All values
// are integer AED fils.
//
// CarryoverFils is the EFFECTIVE carryover into the month, always ≥ 0: the raw
// prior balance (Σ prior assigned − Σ prior activity) plus the cumulative
// overspend ever charged to RTA (see OverspendDebtFils) — a charge permanently
// settles the overspend, so the envelope starts clean instead of re-owing it.
//
// OverspendDebtFils is the overspend charged to THIS month's Ready-to-Assign:
// only the NEW uncovered overspend that appeared during the immediately
// preceding month (the increase of the uncovered-overspend high-water mark —
// see envelopeEraFold). Each fil of overspend is charged exactly once, the
// month after it happened; it never re-charges, and covering it "by hand" with
// a later assignment is never required (such an assignment is simply new
// envelope funding that carries forward like any other).
//
// Both are scoped to the category's ENVELOPE ERA: prior activity only counts
// from the category's first envelope_assignments month onward. A category
// never assigned to has carryover and debt 0 no matter how much confirmed
// history it carries — years of pre-envelope (v2) spend, or a category the
// user deliberately leaves un-enveloped, must not surface as overspend debt
// against Ready-to-Assign.
type EnvelopeMonthRow struct {
	CategoryID        int64
	CategoryName      string
	Bucket            string // 'need' | 'want' | 'saving'
	AssignedFils      int64  // this month's assignment
	ActivityFils      int64  // confirmed net spend this month (debit +, credit −), incl. split lines
	CarryoverFils     int64  // effective carryover into the month, ≥ 0
	OverspendDebtFils int64  // prior-month overspend charged to this month's RTA, ≥ 0
}

// envelopeEraFold folds one category's per-month envelope-era history (all
// months strictly BEFORE the target month; assigned and activity keyed by
// 'YYYY-MM') into the effective carryover entering the target month and the
// overspend debt charged to it. prevMonth is the calendar month immediately
// before the target ('YYYY-MM').
//
// Accounting (all derived — nothing is persisted, so history edits always
// recompute consistently):
//
//	B(k)  = running era balance through month k (Σ assigned − Σ activity)
//	P(k)  = max(P(k−1), max(0, −B(k))) — the uncovered-overspend high-water
//	        mark: the total overspend ever charged to RTA through month k
//	carry = B(final) + P(final)   — ≥ 0 by construction, because every charged
//	        fil is simultaneously credited back to the envelope's baseline
//	        (the charge IS the coverage — YNAB semantics)
//	debt  = P(final) − P(before prevMonth) — only the high-water rise during
//	        the immediately preceding month is charged now; older overspend
//	        was already charged to its own following month and never repeats
//
// Consequences: a 100-fil overspend costs RTA exactly 100 fils, exactly once;
// an assignment made to the category afterwards is real money that carries
// forward (never silently consumed by the old debt); and a month viewed
// historically shows the charge in the month it belonged to.
func envelopeEraFold(assigned, activity map[string]int64, prevMonth string) (carry, debt int64) {
	months := make([]string, 0, len(assigned)+len(activity))
	seen := make(map[string]bool, len(assigned)+len(activity))
	for m := range assigned {
		if !seen[m] {
			seen[m] = true
			months = append(months, m)
		}
	}
	for m := range activity {
		if !seen[m] {
			seen[m] = true
			months = append(months, m)
		}
	}
	sort.Strings(months)

	var b, peak int64
	peakPrev, snapped := int64(0), false
	for _, m := range months {
		if !snapped && m >= prevMonth {
			peakPrev = peak
			snapped = true
		}
		b += assigned[m] - activity[m]
		if over := -b; over > peak {
			peak = over
		}
	}
	if !snapped {
		peakPrev = peak // no data in prevMonth: nothing new to charge
	}
	return b + peak, peak - peakPrev
}

// envelopeEpochJoin is the per-category envelope-era lower bound: each
// category's epoch is its earliest envelope_assignments month. The prior
// ('<') activity pass joins against it so only months the user was actually
// budgeting that category count toward carryover/overspend debt — on a
// brownfield v2 database, lifetime pre-envelope spend must never surface as
// debt charged against Ready-to-Assign (and never-assigned categories drop
// out of the join entirely: carryover 0).
const envelopeEpochJoin = `JOIN (SELECT category_id, MIN(month) AS epoch
	   FROM envelope_assignments GROUP BY category_id) ep`

// envelopeActivity returns net confirmed spend (debit − credit) per category
// per month for months matching `op` ('=' or '<') against month, keyed
// category → 'YYYY-MM' → net fils. Amounts use the jar convention (jarAED =
// COALESCE(amount_aed, 0)): a foreign-currency row with no FX rate yet
// contributes NOTHING — never its raw foreign minor units — so envelope math
// can never disagree with the jar/insights surfaces over the same
// transaction; the row backfills on reprocess or when a rate is added,
// exactly like the jars. The project carve-out (projectCarveOut) applies for
// the same reason: spend inside a count_in_monthly=0 life project is excluded
// from monthly budgeting everywhere, so it must not surface as envelope
// activity — and must never fold into overspend debt charged against
// Ready-to-Assign. The prior ('<') pass is additionally scoped to each
// category's envelope era (see envelopeEpochJoin). Split transactions
// contribute through their split lines: the parent (category NULL while
// split, and defensively excluded by NOT EXISTS) never double-counts, and
// split lines are AED-scaled from the parent with cumulative-floor allocation
// (splitAEDFils) so they sum exactly to the parent's AED amount, foreign
// currency included (the carve-out rides the parent's project link).
func (s *Store) envelopeActivity(op, month string) (map[int64]map[string]int64, error) {
	if op != "=" && op != "<" {
		return nil, fmt.Errorf("envelopeActivity: bad op %q", op)
	}
	epochJoin, epochBound := "", ""
	if op == "<" {
		epochJoin = envelopeEpochJoin + ` ON ep.category_id = t.category_id`
		epochBound = ` AND substr(t.posted_at,1,7) >= ep.epoch`
	}
	activity := make(map[int64]map[string]int64)
	add := func(catID int64, m string, net int64) {
		if activity[catID] == nil {
			activity[catID] = make(map[string]int64)
		}
		activity[catID][m] += net
	}
	rows, err := s.DB.Query(
		`SELECT t.category_id, substr(t.posted_at,1,7) AS m,
		        COALESCE(SUM(CASE t.direction WHEN 'debit' THEN `+jarAED+` WHEN 'credit' THEN -`+jarAED+` ELSE 0 END),0)
		   FROM transactions t
		   `+epochJoin+`
		  WHERE t.status='confirmed' AND t.category_id IS NOT NULL
		    AND substr(t.posted_at,1,7) `+op+` ?`+epochBound+`
		    AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)
		    AND `+projectCarveOut+`
		  GROUP BY t.category_id, m`, month)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var catID, net int64
		var m string
		if err := rows.Scan(&catID, &m, &net); err != nil {
			return nil, err
		}
		add(catID, m, net)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if op == "<" {
		epochJoin = envelopeEpochJoin + ` ON ep.category_id = sp.category_id`
	}
	scaled := splitAEDFils(jarAED)
	splitRows, err := s.DB.Query(
		`SELECT sp.category_id, substr(t.posted_at,1,7) AS m,
		        COALESCE(SUM(CASE t.direction
		          WHEN 'debit'  THEN  `+scaled+`
		          WHEN 'credit' THEN -`+scaled+`
		          ELSE 0 END),0)
		   FROM transaction_splits sp
		   JOIN transactions t ON t.id = sp.transaction_id
		   `+epochJoin+`
		  WHERE t.status='confirmed' AND t.amount > 0
		    AND substr(t.posted_at,1,7) `+op+` ?`+epochBound+`
		    AND `+projectCarveOut+`
		  GROUP BY sp.category_id, m`, month)
	if err != nil {
		return nil, err
	}
	defer splitRows.Close()
	for splitRows.Next() {
		var catID, net int64
		var m string
		if err := splitRows.Scan(&catID, &m, &net); err != nil {
			return nil, err
		}
		add(catID, m, net)
	}
	return activity, splitRows.Err()
}

// EnvelopeMonthSummary returns one row per active spending category with the
// month's assigned, activity, effective carryover and one-time overspend debt
// (scoped to each category's envelope era — see EnvelopeMonthRow and
// envelopeEraFold). Categories with no assignments/activity still appear (all
// zeros) so the Plan screen can list every envelope; ordering is bucket
// (need, want, saving) then name.
func (s *Store) EnvelopeMonthSummary(month string) ([]EnvelopeMonthRow, error) {
	if !validMonth(month) {
		return nil, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	monthStart, err := time.Parse("2006-01", month)
	if err != nil {
		return nil, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	prevMonth := monthStart.AddDate(0, -1, 0).Format("2006-01")

	catRows, err := s.DB.Query(
		`SELECT id, name, COALESCE(bucket,'')
		   FROM categories WHERE is_active=1 AND kind='spending'
		  ORDER BY CASE COALESCE(bucket,'') WHEN 'need' THEN 0 WHEN 'want' THEN 1 WHEN 'saving' THEN 2 ELSE 3 END, name`)
	if err != nil {
		return nil, err
	}
	defer catRows.Close()
	var out []EnvelopeMonthRow
	index := make(map[int64]int)
	for catRows.Next() {
		var r EnvelopeMonthRow
		if err := catRows.Scan(&r.CategoryID, &r.CategoryName, &r.Bucket); err != nil {
			return nil, err
		}
		index[r.CategoryID] = len(out)
		out = append(out, r)
	}
	if err := catRows.Err(); err != nil {
		return nil, err
	}

	// Assignments: this month flat, prior months per month (the fold needs the
	// calendar position of every prior assignment, not just their sum).
	priorAssigned := make(map[int64]map[string]int64)
	rows, err := s.DB.Query(
		`SELECT category_id, month, COALESCE(SUM(assigned_fils),0)
		   FROM envelope_assignments WHERE month <= ? GROUP BY category_id, month`, month)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var catID, fils int64
		var m string
		if err := rows.Scan(&catID, &m, &fils); err != nil {
			rows.Close()
			return nil, err
		}
		i, ok := index[catID]
		if !ok {
			continue
		}
		if m == month {
			out[i].AssignedFils = fils
			continue
		}
		if priorAssigned[catID] == nil {
			priorAssigned[catID] = make(map[string]int64)
		}
		priorAssigned[catID][m] = fils
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	current, err := s.envelopeActivity("=", month)
	if err != nil {
		return nil, err
	}
	prior, err := s.envelopeActivity("<", month)
	if err != nil {
		return nil, err
	}
	for catID, byMonth := range current {
		if i, ok := index[catID]; ok {
			out[i].ActivityFils = byMonth[month]
		}
	}
	for i := range out {
		catID := out[i].CategoryID
		if priorAssigned[catID] == nil && prior[catID] == nil {
			continue // no envelope-era history: carryover and debt stay 0
		}
		out[i].CarryoverFils, out[i].OverspendDebtFils = envelopeEraFold(priorAssigned[catID], prior[catID], prevMonth)
	}
	return out, nil
}
