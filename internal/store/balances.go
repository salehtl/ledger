package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// ErrBalanceInvalid reports a balance row the store refuses to persist.
var ErrBalanceInvalid = errors.New("invalid account balance")

// AccountBalanceRow is one balance ground-truth point for an account: a
// 30-second check-in (the user typed the balance from the bank app) or an
// adjustment written when reconciling a discrepancy. BalanceFils is integer
// fils and may be negative (credit cards).
type AccountBalanceRow struct {
	ID          int64
	AccountID   int64
	AsOf        string // RFC3339; empty on insert = store clock now
	BalanceFils int64
	Source      string // 'checkin' | 'adjustment'; defaults to 'checkin'
	Note        string
	CreatedAt   string
}

// InsertAccountBalance writes one balance point and returns its row ID. The
// account must exist (foreign_keys=ON enforces it). A client-supplied as_of is
// normalized to UTC before storing: every downstream window compare (activity
// since anchor, net-worth month ends) is lexical against UTC-stored
// timestamps, so one accepted-but-offset RFC3339 value would silently corrupt
// all subsequent reconciliation math for the account.
func (s *Store) InsertAccountBalance(r AccountBalanceRow) (int64, error) {
	if r.AccountID <= 0 {
		return 0, fmt.Errorf("%w: account_id required", ErrBalanceInvalid)
	}
	if r.Source == "" {
		r.Source = "checkin"
	}
	if r.Source != "checkin" && r.Source != "adjustment" {
		return 0, fmt.Errorf("%w: source %q", ErrBalanceInvalid, r.Source)
	}
	now := isoNow(s)
	asOf := r.AsOf
	if asOf == "" {
		asOf = now
	} else if t, err := time.Parse(time.RFC3339, asOf); err != nil {
		return 0, fmt.Errorf("%w: as_of %q (want RFC3339)", ErrBalanceInvalid, asOf)
	} else {
		asOf = t.UTC().Format(time.RFC3339)
	}
	res, err := s.DB.Exec(
		`INSERT INTO account_balances (account_id, as_of, balance_fils, source, note, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		r.AccountID, asOf, r.BalanceFils, r.Source, nullableStr(r.Note), now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

const balanceColumns = `id, account_id, as_of, balance_fils, source, COALESCE(note,''), created_at`

func scanBalance(sc interface{ Scan(...any) error }) (AccountBalanceRow, error) {
	var r AccountBalanceRow
	err := sc.Scan(&r.ID, &r.AccountID, &r.AsOf, &r.BalanceFils, &r.Source, &r.Note, &r.CreatedAt)
	return r, err
}

// SelectAccountBalances lists one account's balance history, newest first.
// limit <= 0 returns everything.
func (s *Store) SelectAccountBalances(accountID int64, limit int) ([]AccountBalanceRow, error) {
	q := `SELECT ` + balanceColumns + ` FROM account_balances WHERE account_id=? ORDER BY as_of DESC, id DESC`
	args := []any{accountID}
	if limit > 0 {
		q += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AccountBalanceRow
	for rows.Next() {
		r, err := scanBalance(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// LatestAccountBalance fetches the most recent balance point for one account;
// ok=false when the account has never checked in.
func (s *Store) LatestAccountBalance(accountID int64) (AccountBalanceRow, bool, error) {
	r, err := scanBalance(s.DB.QueryRow(
		`SELECT `+balanceColumns+` FROM account_balances
		  WHERE account_id=? ORDER BY as_of DESC, id DESC LIMIT 1`, accountID))
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return r, false, err
	}
	return r, true, nil
}

// AccountBalanceCount reports how many balance points an account has — the
// in-use check behind DELETE /api/accounts/{id}: an account with check-in
// history is net-worth ground truth and must not cascade away silently.
func (s *Store) AccountBalanceCount(accountID int64) (int, error) {
	var n int
	err := s.DB.QueryRow(
		`SELECT COUNT(*) FROM account_balances WHERE account_id=?`, accountID).Scan(&n)
	return n, err
}

// LatestBalances returns the most recent balance point per account, keyed by
// account id — the accounts list and net-worth anchor query.
func (s *Store) LatestBalances() (map[int64]AccountBalanceRow, error) {
	rows, err := s.DB.Query(
		`SELECT ` + balanceColumns + ` FROM account_balances b
		  WHERE b.id = (SELECT b2.id FROM account_balances b2
		                 WHERE b2.account_id = b.account_id
		                 ORDER BY b2.as_of DESC, b2.id DESC LIMIT 1)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]AccountBalanceRow)
	for rows.Next() {
		r, err := scanBalance(rows)
		if err != nil {
			return nil, err
		}
		out[r.AccountID] = r
	}
	return out, rows.Err()
}
