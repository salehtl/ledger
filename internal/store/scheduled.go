package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrScheduleInvalid reports a scheduled-transaction payload or status
// transition the store refuses.
var ErrScheduleInvalid = errors.New("invalid scheduled transaction")

// ScheduledTxnRow is one recurring bill/income schedule — hand-entered
// (source 'manual') or mined from ingest history by the deterministic detector
// (source 'detected', status 'proposed' until the user confirms). Amounts are
// integer AED fils; TolerancePct is integer percent points (10 = ±10%) so the
// matching band stays pure integer math.
type ScheduledTxnRow struct {
	ID                 int64
	NormalizedMerchant string
	Label              string
	AmountFils         int64
	TolerancePct       int64  // ± percent points; 0 = exact-amount matching
	IntervalDays       int64  // 7/14/30/365-style cadence
	NextDue            string // 'YYYY-MM-DD'
	Direction          string // 'debit' | 'credit'; defaults to 'debit'
	CategoryID         *int64
	AccountID          *int64
	Source             string // 'manual' | 'detected'; defaults to 'manual'
	Status             string // 'proposed' | 'active' | 'paused' | 'dismissed'
	LastMatchedTxID    *int64
	LastMatchedAt      string // RFC3339; "" when never matched
	LastAmountFils     *int64 // most recent matched amount
	Missed             bool   // next_due + grace passed with no match
	PriceChange        bool   // last match landed outside the tolerance band
	Provenance         string // detector provenance JSON (recur.Provenance); "" for manual rows
	CreatedAt          string
	UpdatedAt          string
}

func validateScheduled(r *ScheduledTxnRow) error {
	// Normalize exactly like recur.Normalize (lowercase + interior whitespace
	// collapsed): the matcher compares stored merchants byte-for-byte against
	// that key, so a schedule stored with an uncollapsed run of spaces (a
	// pasted raw bank string) could never match and would sit missed forever.
	// The collapse is duplicated here because store cannot import recur
	// (recur imports store).
	r.NormalizedMerchant = strings.ToLower(strings.Join(strings.Fields(r.NormalizedMerchant), " "))
	if r.NormalizedMerchant == "" {
		return fmt.Errorf("%w: normalized_merchant required", ErrScheduleInvalid)
	}
	if r.AmountFils <= 0 {
		return fmt.Errorf("%w: amount_fils must be > 0", ErrScheduleInvalid)
	}
	if r.TolerancePct < 0 || r.TolerancePct > 100 {
		return fmt.Errorf("%w: tolerance_pct must be 0..100", ErrScheduleInvalid)
	}
	if r.IntervalDays <= 0 {
		return fmt.Errorf("%w: interval_days must be > 0", ErrScheduleInvalid)
	}
	if _, err := time.Parse("2006-01-02", r.NextDue); err != nil {
		return fmt.Errorf("%w: next_due %q (want YYYY-MM-DD)", ErrScheduleInvalid, r.NextDue)
	}
	if r.Direction == "" {
		r.Direction = "debit"
	}
	if r.Direction != "debit" && r.Direction != "credit" {
		return fmt.Errorf("%w: direction %q", ErrScheduleInvalid, r.Direction)
	}
	if r.Source == "" {
		r.Source = "manual"
	}
	if r.Source != "manual" && r.Source != "detected" {
		return fmt.Errorf("%w: source %q", ErrScheduleInvalid, r.Source)
	}
	if r.Status == "" {
		if r.Source == "detected" {
			r.Status = "proposed"
		} else {
			r.Status = "active"
		}
	}
	if !validScheduleStatus(r.Status) {
		return fmt.Errorf("%w: status %q", ErrScheduleInvalid, r.Status)
	}
	return nil
}

func validScheduleStatus(s string) bool {
	switch s {
	case "proposed", "active", "paused", "dismissed":
		return true
	}
	return false
}

func ptrToAny(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

// InsertScheduled writes one schedule. Empty Direction/Source/Status default
// to debit/manual/active (detected rows default to proposed).
func (s *Store) InsertScheduled(r ScheduledTxnRow) (int64, error) {
	if err := validateScheduled(&r); err != nil {
		return 0, err
	}
	now := isoNow(s)
	res, err := s.DB.Exec(
		`INSERT INTO scheduled_transactions
		   (normalized_merchant, label, amount_fils, tolerance_pct, interval_days, next_due,
		    direction, category_id, account_id, source, status, provenance, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.NormalizedMerchant, r.Label, r.AmountFils, r.TolerancePct, r.IntervalDays, r.NextDue,
		r.Direction, ptrToAny(r.CategoryID), ptrToAny(r.AccountID), r.Source, r.Status, r.Provenance, now, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

const scheduledColumns = `id, normalized_merchant, COALESCE(label,''), amount_fils, tolerance_pct,
	interval_days, next_due, direction, category_id, account_id, source, status,
	last_matched_tx_id, COALESCE(last_matched_at,''), last_amount_fils, missed, price_change,
	COALESCE(provenance,''), created_at, updated_at`

func scanScheduled(sc interface{ Scan(...any) error }) (ScheduledTxnRow, error) {
	var r ScheduledTxnRow
	var catID, acctID, lastTx, lastAmt sql.NullInt64
	var missed, priceChange int
	err := sc.Scan(&r.ID, &r.NormalizedMerchant, &r.Label, &r.AmountFils, &r.TolerancePct,
		&r.IntervalDays, &r.NextDue, &r.Direction, &catID, &acctID, &r.Source, &r.Status,
		&lastTx, &r.LastMatchedAt, &lastAmt, &missed, &priceChange, &r.Provenance,
		&r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return r, err
	}
	for _, p := range []struct {
		src sql.NullInt64
		dst **int64
	}{{catID, &r.CategoryID}, {acctID, &r.AccountID}, {lastTx, &r.LastMatchedTxID}, {lastAmt, &r.LastAmountFils}} {
		if p.src.Valid {
			v := p.src.Int64
			*p.dst = &v
		}
	}
	r.Missed = missed == 1
	r.PriceChange = priceChange == 1
	return r, nil
}

// SelectScheduled lists schedules, soonest next_due first. With no statuses it
// returns everything (including proposed and dismissed); otherwise only rows
// in the given statuses.
func (s *Store) SelectScheduled(statuses ...string) ([]ScheduledTxnRow, error) {
	q := `SELECT ` + scheduledColumns + ` FROM scheduled_transactions`
	var args []any
	if len(statuses) > 0 {
		ph := make([]string, len(statuses))
		for i, st := range statuses {
			ph[i] = "?"
			args = append(args, st)
		}
		q += ` WHERE status IN (` + strings.Join(ph, ",") + `)`
	}
	q += ` ORDER BY next_due, id`
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScheduledTxnRow
	for rows.Next() {
		r, err := scanScheduled(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SelectScheduledByID fetches one schedule; ok=false when it doesn't exist.
func (s *Store) SelectScheduledByID(id int64) (ScheduledTxnRow, bool, error) {
	r, err := scanScheduled(s.DB.QueryRow(
		`SELECT `+scheduledColumns+` FROM scheduled_transactions WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return r, false, err
	}
	return r, true, nil
}

// UpdateScheduled overwrites a schedule's user-editable fields (merchant,
// label, amount, tolerance, interval, next_due, direction, category, account).
// Status and match bookkeeping have dedicated methods; provenance is
// detector-owned and never touched here.
func (s *Store) UpdateScheduled(r ScheduledTxnRow) error {
	if err := validateScheduled(&r); err != nil {
		return err
	}
	res, err := s.DB.Exec(
		`UPDATE scheduled_transactions SET
		   normalized_merchant=?, label=?, amount_fils=?, tolerance_pct=?, interval_days=?,
		   next_due=?, direction=?, category_id=?, account_id=?, updated_at=?
		 WHERE id=?`,
		r.NormalizedMerchant, r.Label, r.AmountFils, r.TolerancePct, r.IntervalDays,
		r.NextDue, r.Direction, ptrToAny(r.CategoryID), ptrToAny(r.AccountID), isoNow(s), r.ID,
	)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return fmt.Errorf("%w: id %d not found", ErrScheduleInvalid, r.ID)
	}
	return nil
}

// DeleteScheduled removes one schedule.
func (s *Store) DeleteScheduled(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM scheduled_transactions WHERE id=?`, id)
	return err
}

// scheduleTransitions maps a target status to the statuses it may be reached
// from. 'proposed' is insert-only (the detector's entry state).
var scheduleTransitions = map[string][]string{
	"active":    {"proposed", "paused", "dismissed"},
	"paused":    {"active"},
	"dismissed": {"proposed", "active", "paused"},
}

// SetScheduledStatus applies a status transition (confirm = proposed→active,
// dismiss, pause, resume). Illegal transitions return ErrScheduleInvalid.
func (s *Store) SetScheduledStatus(id int64, status string) error {
	from, ok := scheduleTransitions[status]
	if !ok {
		return fmt.Errorf("%w: cannot transition to status %q", ErrScheduleInvalid, status)
	}
	cur, found, err := s.SelectScheduledByID(id)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%w: id %d not found", ErrScheduleInvalid, id)
	}
	if cur.Status == status {
		return nil // idempotent
	}
	allowed := false
	for _, f := range from {
		if cur.Status == f {
			allowed = true
			break
		}
	}
	if !allowed {
		return fmt.Errorf("%w: cannot go %s → %s", ErrScheduleInvalid, cur.Status, status)
	}
	_, err = s.DB.Exec(
		`UPDATE scheduled_transactions SET status=?, updated_at=? WHERE id=?`,
		status, isoNow(s), id)
	return err
}

// MarkScheduledMatched records that txID paid the schedule: it stamps the match
// bookkeeping, clears the missed flag, flags a price change when amountFils
// lands outside the ± tolerance band (integer fils math), and advances
// next_due to the matched date + interval_days.
func (s *Store) MarkScheduledMatched(id, txID int64, matchedAt time.Time, amountFils int64) error {
	cur, found, err := s.SelectScheduledByID(id)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%w: id %d not found", ErrScheduleInvalid, id)
	}
	band := cur.AmountFils * cur.TolerancePct / 100
	diff := amountFils - cur.AmountFils
	if diff < 0 {
		diff = -diff
	}
	priceChange := 0
	if diff > band {
		priceChange = 1
	}
	nextDue := matchedAt.UTC().AddDate(0, 0, int(cur.IntervalDays)).Format("2006-01-02")
	_, err = s.DB.Exec(
		`UPDATE scheduled_transactions SET
		   last_matched_tx_id=?, last_matched_at=?, last_amount_fils=?,
		   missed=0, price_change=?, next_due=?, updated_at=?
		 WHERE id=?`,
		txID, matchedAt.UTC().Format(time.RFC3339), amountFils,
		priceChange, nextDue, isoNow(s), id,
	)
	return err
}

// MarkScheduledMissed flags a schedule whose next_due + grace passed with no
// matching transaction — the expected email never arrived.
func (s *Store) MarkScheduledMissed(id int64) error {
	_, err := s.DB.Exec(
		`UPDATE scheduled_transactions SET missed=1, updated_at=? WHERE id=?`, isoNow(s), id)
	return err
}

// RearmScheduledNextDue advances a stale schedule's next_due to the given date
// (recur.RearmStale: a fully-missed cycle would otherwise leave next_due
// permanently outside every future match window). Only next_due moves — the
// missed flag and match bookkeeping are untouched, so the bill stays visibly
// missed until an arrival actually matches.
func (s *Store) RearmScheduledNextDue(id int64, nextDue string) error {
	if _, err := time.Parse("2006-01-02", nextDue); err != nil {
		return fmt.Errorf("%w: next_due %q (want YYYY-MM-DD)", ErrScheduleInvalid, nextDue)
	}
	_, err := s.DB.Exec(
		`UPDATE scheduled_transactions SET next_due=?, updated_at=? WHERE id=?`,
		nextDue, isoNow(s), id)
	return err
}

// SelectUpcoming returns active schedules due within `days` of `from`
// (inclusive), soonest first — including overdue/missed rows, which are by
// definition "upcoming money" the user should see.
func (s *Store) SelectUpcoming(from time.Time, days int) ([]ScheduledTxnRow, error) {
	if days < 0 {
		days = 0
	}
	horizon := from.UTC().AddDate(0, 0, days).Format("2006-01-02")
	rows, err := s.DB.Query(
		`SELECT `+scheduledColumns+` FROM scheduled_transactions
		  WHERE status='active' AND next_due <= ? ORDER BY next_due, id`, horizon)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ScheduledTxnRow
	for rows.Next() {
		r, err := scanScheduled(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ScheduledMerchantSet returns the normalized merchants that already have a
// schedule in ANY status — including dismissed, so the detector never
// re-proposes a bill the user said no to.
func (s *Store) ScheduledMerchantSet() (map[string]bool, error) {
	rows, err := s.DB.Query(`SELECT DISTINCT normalized_merchant FROM scheduled_transactions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]bool)
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		out[m] = true
	}
	return out, rows.Err()
}
