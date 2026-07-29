// Reports queries (v3): net-worth series from balance anchors + attributable
// activity, the income-v-expense category × month matrix, and the cashflow
// stream the age-of-money FIFO consumes. All money is int64 AED fils; months
// are 'YYYY-MM' buckets.
package store

import (
	"fmt"
	"sort"
	"time"
)

// NetWorthPoint is one month-end net-worth snapshot: budget accounts
// (spendable) and tracking accounts (investments, property) split out, plus
// their sum. Accounts with no balance check-in on or before the month end
// contribute nothing for that month.
type NetWorthPoint struct {
	Month        string // 'YYYY-MM'
	BudgetFils   int64
	TrackingFils int64
	NetWorthFils int64
}

// netWorthSignedTxn is one attributable transaction in balance terms
// (credit +, debit −), keyed by its raw posted_at for lexical windowing.
type netWorthSignedTxn struct {
	postedAt string
	signed   int64
}

// dayPrefix truncates an ISO timestamp ('YYYY-MM-DD…') to its calendar day for
// the day-granular balance windows.
func dayPrefix(ts string) string {
	if len(ts) > 10 {
		return ts[:10]
	}
	return ts
}

// NetWorthSeries computes the month-end net worth for the last `months`
// calendar months ending at now's month (oldest first). Per account, the
// month-end balance is the latest balance anchor at or before the month end
// plus the net signed activity attributed to the account (by last4) between
// the anchor and the month end — the same expected-balance math the check-in
// uses, evaluated historically. The activity window is DAY-granular, matching
// AccountActivitySince: bank-parsed posted_at is a bare date (midnight UTC)
// while anchors are wall-clock instants, so an instant compare would silently
// drop same-day transactions and double-count next-day ones. An anchor is
// treated as stating the balance as of the END of its calendar day. Amounts
// follow the app-wide AED convention: a foreign-currency row with no FX rate
// yet contributes nothing until a rate is added (see AccountActivitySince).
func (s *Store) NetWorthSeries(months int, now time.Time) ([]NetWorthPoint, error) {
	if months <= 0 {
		months = 12
	}
	if months > 120 {
		months = 120
	}
	accounts, err := s.SelectAccounts()
	if err != nil {
		return nil, err
	}
	type acctData struct {
		kind    string
		anchors []AccountBalanceRow // oldest first
		txns    []netWorthSignedTxn // oldest first
	}
	var accts []acctData
	for _, a := range accounts {
		if !a.IsActive {
			continue
		}
		anchors, err := s.SelectAccountBalances(a.ID, 0) // newest first
		if err != nil {
			return nil, err
		}
		if len(anchors) == 0 {
			continue // never checked in — unknown balance, contributes nothing
		}
		for i, j := 0, len(anchors)-1; i < j; i, j = i+1, j-1 {
			anchors[i], anchors[j] = anchors[j], anchors[i]
		}
		d := acctData{kind: a.Kind, anchors: anchors}
		if a.Last4 != "" {
			// jarAED convention: a foreign row with no FX rate contributes
			// nothing — never raw foreign minor units — matching
			// AccountActivitySince so the series and the check-in math agree.
			rows, err := s.DB.Query(
				`SELECT posted_at, CASE direction WHEN 'credit' THEN COALESCE(amount_aed, 0)
				                                   ELSE -COALESCE(amount_aed, 0) END
				   FROM transactions WHERE last4=? AND status IN `+balanceTxnStatuses+`
				  ORDER BY posted_at`, a.Last4)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var t netWorthSignedTxn
				if err := rows.Scan(&t.postedAt, &t.signed); err != nil {
					rows.Close()
					return nil, err
				}
				d.txns = append(d.txns, t)
			}
			if err := rows.Err(); err != nil {
				rows.Close()
				return nil, err
			}
			rows.Close()
		}
		accts = append(accts, d)
	}

	cur := time.Date(now.UTC().Year(), now.UTC().Month(), 1, 0, 0, 0, 0, time.UTC)
	start := cur.AddDate(0, -(months - 1), 0)
	var out []NetWorthPoint
	for m := start; !m.After(cur); m = m.AddDate(0, 1, 0) {
		monthEnd := m.AddDate(0, 1, 0).Format(time.RFC3339) // first instant of next month
		p := NetWorthPoint{Month: m.Format("2006-01")}
		for _, a := range accts {
			var anchor *AccountBalanceRow
			for i := len(a.anchors) - 1; i >= 0; i-- {
				if a.anchors[i].AsOf < monthEnd {
					anchor = &a.anchors[i]
					break
				}
			}
			if anchor == nil {
				continue // no ground truth yet at this month's end
			}
			bal := anchor.BalanceFils
			anchorDay, monthEndDay := dayPrefix(anchor.AsOf), dayPrefix(monthEnd)
			for _, t := range a.txns {
				if d := dayPrefix(t.postedAt); d > anchorDay && d < monthEndDay {
					bal += t.signed
				}
			}
			if a.kind == "tracking" {
				p.TrackingFils += bal
			} else {
				p.BudgetFils += bal
			}
		}
		p.NetWorthFils = p.BudgetFils + p.TrackingFils
		out = append(out, p)
	}
	return out, nil
}

// CategoryMonthNet is one category's net flow for one month. NetFils is
// debit − credit in AED: positive spend for spending categories, negative for
// income categories (whose credits dominate) — the server flips signs for
// display.
type CategoryMonthNet struct {
	CategoryID int64
	Name       string
	Kind       string // 'spending' | 'income'
	Month      string // 'YYYY-MM'
	NetFils    int64
}

// IncomeExpenseMatrix returns per-category per-month net flows over the
// inclusive [fromMonth, toMonth] 'YYYY-MM' range, confirmed transactions only.
// Amounts use the jar convention (jarAED): a foreign-currency row with no FX
// rate yet contributes nothing — never raw foreign minor units — so the matrix
// always agrees with the jar/insights/envelope surfaces. Split transactions
// contribute through their split lines (AED-scaled from the parent with
// cumulative-floor allocation — splitAEDFils, the same exact math as
// EnvelopeMonthSummary, so lines always sum to the parent's AED); the split
// parent — category NULL, and defensively excluded by NOT EXISTS — never
// double-counts. Rows are ordered income first, then spending, then name,
// then month.
func (s *Store) IncomeExpenseMatrix(fromMonth, toMonth string) ([]CategoryMonthNet, error) {
	if !validMonth(fromMonth) || !validMonth(toMonth) {
		return nil, fmt.Errorf("%w: month range %q..%q (want YYYY-MM)", ErrEnvelopeInvalid, fromMonth, toMonth)
	}
	type key struct {
		cat   int64
		month string
	}
	acc := make(map[key]*CategoryMonthNet)
	add := func(catID int64, name, kind, month string, net int64) {
		k := key{catID, month}
		if r, ok := acc[k]; ok {
			r.NetFils += net
			return
		}
		acc[k] = &CategoryMonthNet{CategoryID: catID, Name: name, Kind: kind, Month: month, NetFils: net}
	}

	rows, err := s.DB.Query(
		`SELECT t.category_id, c.name, c.kind, substr(t.posted_at,1,7) AS m,
		        COALESCE(SUM(CASE t.direction WHEN 'debit' THEN `+jarAED+` ELSE -`+jarAED+` END),0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind IN ('spending','income')
		    AND substr(t.posted_at,1,7) BETWEEN ? AND ?
		    AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)
		  GROUP BY t.category_id, m`, fromMonth, toMonth)
	if err != nil {
		return nil, err
	}
	if err := scanCategoryMonthNet(rows, add); err != nil {
		return nil, err
	}

	scaled := splitAEDFils(jarAED)
	splitRows, err := s.DB.Query(
		`SELECT sp.category_id, c.name, c.kind, substr(t.posted_at,1,7) AS m,
		        COALESCE(SUM(CASE t.direction
		          WHEN 'debit' THEN  `+scaled+`
		          ELSE              -`+scaled+` END),0)
		   FROM transaction_splits sp
		   JOIN transactions t ON t.id = sp.transaction_id
		   JOIN categories c ON c.id = sp.category_id
		  WHERE t.status='confirmed' AND t.amount > 0 AND c.kind IN ('spending','income')
		    AND substr(t.posted_at,1,7) BETWEEN ? AND ?
		  GROUP BY sp.category_id, m`, fromMonth, toMonth)
	if err != nil {
		return nil, err
	}
	if err := scanCategoryMonthNet(splitRows, add); err != nil {
		return nil, err
	}

	out := make([]CategoryMonthNet, 0, len(acc))
	for _, r := range acc {
		out = append(out, *r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind == "income" // income block first
		}
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Month < out[j].Month
	})
	return out, nil
}

// scanCategoryMonthNet drains one grouped query into the accumulator.
func scanCategoryMonthNet(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
	Close() error
}, add func(catID int64, name, kind, month string, net int64)) error {
	defer rows.Close()
	for rows.Next() {
		var catID, net int64
		var name, kind, month string
		if err := rows.Scan(&catID, &name, &kind, &month, &net); err != nil {
			return err
		}
		add(catID, name, kind, month, net)
	}
	return rows.Err()
}

// CashflowTxn is one confirmed money movement for the age-of-money FIFO:
// income credits fill the pool, spending debits drain it. Split DEBIT parents
// count as whole spends (the split lines only re-categorize them); split
// CREDIT parents contribute through their income-kind split lines.
type CashflowTxn struct {
	PostedAt   time.Time
	AmountFils int64
	IsIncome   bool
}

// SelectCashflowForAge returns the chronological confirmed cashflow stream:
// income-category credits (a SPLIT income credit contributes through its
// income-kind split lines, AED-scaled — splitting a salary never deletes it
// from the stream, mirroring SelectMonthIncome, and the credit arm carries
// the same defensive NOT EXISTS split-parent exclusion so a categorized
// split parent can never count both whole and through its lines) and
// spending debits (including uncategorized split parents, which count as
// whole spends — their lines only re-categorize them), oldest first. Amounts use the jar
// convention (jarAED): a foreign row with no FX rate contributes a 0-fil flow,
// which the FIFO engine skips, rather than raw foreign minor units polluting
// an AED pool.
func (s *Store) SelectCashflowForAge() ([]CashflowTxn, error) {
	rows, err := s.DB.Query(
		`SELECT posted, amt, is_income FROM (
		   SELECT t.posted_at AS posted, ` + jarAED + ` AS amt,
		          CASE WHEN c.kind='income' AND t.direction='credit' THEN 1 ELSE 0 END AS is_income,
		          t.id AS tid
		     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		    WHERE t.status='confirmed'
		      AND ( (c.kind='income' AND t.direction='credit'
		             AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id))
		         OR (t.direction='debit'
		             AND (c.kind='spending'
		                  OR (t.category_id IS NULL
		                      AND EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)))) )
		   UNION ALL
		   SELECT t.posted_at, ` + splitAEDFils(jarAED) + `, 1, t.id
		     FROM transaction_splits sp
		     JOIN transactions t ON t.id = sp.transaction_id
		     JOIN categories c ON c.id = sp.category_id
		    WHERE t.status='confirmed' AND t.amount > 0
		      AND c.kind='income' AND t.direction='credit'
		 ) ORDER BY posted, tid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CashflowTxn
	for rows.Next() {
		var c CashflowTxn
		var posted string
		var isIncome int
		if err := rows.Scan(&posted, &c.AmountFils, &isIncome); err != nil {
			return nil, err
		}
		t, perr := time.Parse(time.RFC3339, posted)
		if perr != nil {
			return nil, fmt.Errorf("cashflow: posted_at %q: %w", posted, perr)
		}
		c.PostedAt = t
		c.IsIncome = isIncome == 1
		out = append(out, c)
	}
	return out, rows.Err()
}
