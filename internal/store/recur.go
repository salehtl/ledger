package store

import (
	"database/sql"
	"fmt"
	"time"
)

// RecurTxn is the lean transaction view the recurring detector/matcher reads:
// just enough to group by merchant, judge interval and amount stability, and
// match arrivals to schedules. AmountFils is the amount_aed snapshot, falling
// back to the RAW amount when no rate exists — deliberately unlike the jar
// convention (COALESCE(amount_aed, 0)): detection and matching only compare a
// merchant's amounts against each other, so an unconverted foreign
// subscription still forms a self-consistent series, whereas zeroing it would
// make its bills undetectable and unmatchable. These amounts feed schedule
// bookkeeping only, never money aggregates.
type RecurTxn struct {
	ID         int64
	PostedAt   time.Time
	AmountFils int64
	Merchant   string
	Direction  string // 'debit' | 'credit'
	CategoryID *int64 // nil when uncategorized
}

const recurTxnColumns = `id, posted_at, COALESCE(amount_aed, amount),
	COALESCE(merchant_raw,''), direction, category_id`

func scanRecurTxn(sc interface{ Scan(...any) error }) (RecurTxn, error) {
	var r RecurTxn
	var posted string
	var catID sql.NullInt64
	if err := sc.Scan(&r.ID, &posted, &r.AmountFils, &r.Merchant, &r.Direction, &catID); err != nil {
		return r, err
	}
	t, err := time.Parse(time.RFC3339, posted) // accepts RFC3339Nano input too
	if err != nil {
		return r, fmt.Errorf("recur txn %d: posted_at %q: %w", r.ID, posted, err)
	}
	r.PostedAt = t
	if catID.Valid {
		v := catID.Int64
		r.CategoryID = &v
	}
	return r, nil
}

func collectRecurTxns(rows *sql.Rows) ([]RecurTxn, error) {
	defer rows.Close()
	var out []RecurTxn
	for rows.Next() {
		r, err := scanRecurTxn(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SelectConfirmedForRecur returns the full confirmed transaction history,
// oldest first — the detector's mining input. Confirmed only: the detector
// must never learn a pattern from unreviewed or transfer rows.
func (s *Store) SelectConfirmedForRecur() ([]RecurTxn, error) {
	rows, err := s.DB.Query(
		`SELECT ` + recurTxnColumns + ` FROM transactions
		  WHERE status='confirmed' ORDER BY posted_at, id`)
	if err != nil {
		return nil, err
	}
	return collectRecurTxns(rows)
}

// SelectRecurTxnsBetween returns spending-relevant transactions posted within
// the inclusive [from, to] day range (date granularity), oldest first — the
// matcher's candidate pool. needs_review rows are included: a bill's email
// arrives before the user confirms it, and the schedule should still mark
// paid. Transfers and archived rows never match a bill.
func (s *Store) SelectRecurTxnsBetween(from, to time.Time) ([]RecurTxn, error) {
	rows, err := s.DB.Query(
		`SELECT `+recurTxnColumns+` FROM transactions
		  WHERE status IN ('confirmed','needs_review')
		    AND substr(posted_at,1,10) BETWEEN ? AND ?
		  ORDER BY posted_at, id`,
		from.UTC().Format("2006-01-02"), to.UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	return collectRecurTxns(rows)
}
