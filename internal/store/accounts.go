package store

import (
	"database/sql"
	"errors"
	"fmt"
)

// Account is one of the user's own bank accounts (the accounts table). The
// registry exists so self-transfer matching can recognize "both legs are my
// accounts"; v3 also hangs balance check-ins and net worth off it. Kind is
// 'budget' (spendable, participates in envelopes) or 'tracking' (investments,
// property — net worth only).
type Account struct {
	ID       int64
	Name     string
	Bank     string
	Last4    string
	Currency string
	Kind     string // 'budget' | 'tracking'
	IsActive bool
}

const accountColumns = `id, name, bank, COALESCE(last4,''), currency, COALESCE(kind,'budget'), is_active`

func scanAccount(sc interface{ Scan(...any) error }) (Account, error) {
	var a Account
	var active int
	if err := sc.Scan(&a.ID, &a.Name, &a.Bank, &a.Last4, &a.Currency, &a.Kind, &active); err != nil {
		return a, err
	}
	a.IsActive = active == 1
	return a, nil
}

// SelectAccounts returns all accounts, insertion order.
func (s *Store) SelectAccounts() ([]Account, error) {
	rows, err := s.DB.Query(`SELECT ` + accountColumns + ` FROM accounts ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Account
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// SelectAccount fetches one account by id; ok=false when it doesn't exist.
func (s *Store) SelectAccount(id int64) (Account, bool, error) {
	a, err := scanAccount(s.DB.QueryRow(`SELECT `+accountColumns+` FROM accounts WHERE id=?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return a, false, nil
	}
	if err != nil {
		return a, false, err
	}
	return a, true, nil
}

// UpdateAccountKind flips an account between 'budget' and 'tracking'.
func (s *Store) UpdateAccountKind(id int64, kind string) error {
	if kind != "budget" && kind != "tracking" {
		return fmt.Errorf("account kind must be 'budget' or 'tracking', got %q", kind)
	}
	_, err := s.DB.Exec(`UPDATE accounts SET kind=? WHERE id=?`, kind, id)
	return err
}

// InsertAccount registers an own account. Validation (non-empty name, 4-digit
// last4) is the API layer's job; the store persists what it's given.
func (s *Store) InsertAccount(name, bank, last4 string) (int64, error) {
	res, err := s.DB.Exec(
		`INSERT INTO accounts (name, bank, last4, currency, is_active) VALUES (?, ?, ?, 'AED', 1)`,
		name, bank, last4)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// DeleteAccount removes an account. Hard delete: transactions.account_id is
// never populated, so no row can reference it.
func (s *Store) DeleteAccount(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM accounts WHERE id=?`, id)
	return err
}

// OwnAccountLast4s returns the set of last-4s of active accounts. An empty set
// means "registry unconfigured" and transfer matching must not tighten on it.
func (s *Store) OwnAccountLast4s() (map[string]bool, error) {
	rows, err := s.DB.Query(
		`SELECT last4 FROM accounts WHERE is_active=1 AND last4 IS NOT NULL AND last4 != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	own := make(map[string]bool)
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			return nil, err
		}
		own[l] = true
	}
	return own, rows.Err()
}
