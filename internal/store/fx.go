package store

import (
	"database/sql"
	"errors"
	"time"
)

// FXRate is one currency's AED conversion rate. RateMicro is AED per 1 unit
// of the currency × 1,000,000, kept integer so money math never touches floats.
type FXRate struct {
	Currency  string
	RateMicro int64
	UpdatedAt string
}

// aedIdentityMicro is the implicit AED->AED rate; AED never has an fx_rates row.
const aedIdentityMicro = 1_000_000

// ConvertToAEDFils converts a native minor-unit amount to fils, rounding half-up.
func ConvertToAEDFils(amountMinor, rateMicro int64) int64 {
	return (amountMinor*rateMicro + 500_000) / 1_000_000
}

// seedFXRates inserts the USD/AED peg (3.6725, fixed since 1997) once.
// Other currencies are user-entered; a wrong guessed seed applied silently
// would be worse than a visible missing rate.
func (s *Store) seedFXRates() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO fx_rates (currency, rate_micro, updated_at) VALUES ('USD', 3672500, ?)`,
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

// SelectFXRates returns all configured rates, alphabetical.
func (s *Store) SelectFXRates() ([]FXRate, error) {
	rows, err := s.DB.Query(`SELECT currency, rate_micro, updated_at FROM fx_rates ORDER BY currency`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FXRate
	for rows.Next() {
		var r FXRate
		if err := rows.Scan(&r.Currency, &r.RateMicro, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpsertFXRate creates or overwrites one currency's rate.
func (s *Store) UpsertFXRate(currency string, rateMicro int64) error {
	_, err := s.DB.Exec(
		`INSERT INTO fx_rates (currency, rate_micro, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(currency) DO UPDATE SET rate_micro=excluded.rate_micro, updated_at=excluded.updated_at`,
		currency, rateMicro, time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

// DeleteFXRate removes a rate. Existing amount_aed snapshots are untouched.
func (s *Store) DeleteFXRate(currency string) error {
	_, err := s.DB.Exec(`DELETE FROM fx_rates WHERE currency=?`, currency)
	return err
}

// RateMicroFor returns the micro-rate for a currency. AED (or empty, which
// defaults to AED throughout the store) is the identity; unknown currencies
// return ok=false.
func (s *Store) RateMicroFor(currency string) (int64, bool, error) {
	if currency == "" || currency == "AED" {
		return aedIdentityMicro, true, nil
	}
	var rate int64
	err := s.DB.QueryRow(`SELECT rate_micro FROM fx_rates WHERE currency=?`, currency).Scan(&rate)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return rate, true, nil
}

// amountAEDValue computes the AED snapshot to store with a new transaction:
// the amount itself for AED, the converted value when a rate exists, SQL NULL
// otherwise (backfilled later by ConvertUnconverted once a rate is added).
func (s *Store) amountAEDValue(amountFils int64, currency string) (any, error) {
	rate, ok, err := s.RateMicroFor(currency)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}
	return ConvertToAEDFils(amountFils, rate), nil
}

// UnconvertedCurrencies lists currencies present on transactions that still
// have no AED snapshot — i.e. rates the user needs to add.
func (s *Store) UnconvertedCurrencies() ([]string, error) {
	rows, err := s.DB.Query(
		`SELECT DISTINCT currency FROM transactions WHERE amount_aed IS NULL ORDER BY currency`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ConvertUnconverted fills amount_aed for rows that lack it: identity for AED,
// the current fx rate otherwise. Rows whose currency has no rate stay NULL.
// Existing snapshots are never rewritten (WHERE amount_aed IS NULL).
func (s *Store) ConvertUnconverted() (int64, error) {
	res1, err := s.DB.Exec(
		`UPDATE transactions SET amount_aed = amount WHERE amount_aed IS NULL AND currency = 'AED'`)
	if err != nil {
		return 0, err
	}
	n1, _ := res1.RowsAffected()
	res2, err := s.DB.Exec(
		`UPDATE transactions
		    SET amount_aed = (amount * (SELECT rate_micro FROM fx_rates WHERE fx_rates.currency = transactions.currency) + 500000) / 1000000
		  WHERE amount_aed IS NULL
		    AND currency IN (SELECT currency FROM fx_rates)`)
	if err != nil {
		return n1, err
	}
	n2, _ := res2.RowsAffected()
	return n1 + n2, nil
}
