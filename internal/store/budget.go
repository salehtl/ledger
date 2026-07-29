package store

import (
	"fmt"
	"time"
)

// BudgetConfig is the singleton budget_config row (§5).
type BudgetConfig struct {
	MonthlyIncome int64
	NeedPct       float64
	WantPct       float64
	SavingPct     float64
	IncomeSource  string // "config" | "categories"
	FreezeHistory bool
}

// EnsureBudgetConfig inserts the default singleton row if none exists. It never
// overwrites an existing row (INSERT OR IGNORE on the fixed id=1).
func (s *Store) EnsureBudgetConfig() error {
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO budget_config
		   (id, monthly_income, need_pct, want_pct, saving_pct, income_source, freeze_history)
		 VALUES (1, 0, 0.50, 0.30, 0.20, 'config', 0)`,
	)
	return err
}

// SelectBudgetConfig reads the singleton row.
func (s *Store) SelectBudgetConfig() (BudgetConfig, error) {
	var c BudgetConfig
	var freeze int
	err := s.DB.QueryRow(
		`SELECT monthly_income, need_pct, want_pct, saving_pct, income_source, freeze_history
		 FROM budget_config WHERE id=1`,
	).Scan(&c.MonthlyIncome, &c.NeedPct, &c.WantPct, &c.SavingPct, &c.IncomeSource, &freeze)
	c.FreezeHistory = freeze == 1
	return c, err
}

// UpdateBudgetConfig overwrites the singleton row.
func (s *Store) UpdateBudgetConfig(c BudgetConfig) error {
	_, err := s.DB.Exec(
		`UPDATE budget_config
		   SET monthly_income=?, need_pct=?, want_pct=?, saving_pct=?, income_source=?, freeze_history=?
		 WHERE id=1`,
		c.MonthlyIncome, c.NeedPct, c.WantPct, c.SavingPct, c.IncomeSource, boolToInt(c.FreezeHistory),
	)
	return err
}

// SpendRow is one confirmed spending transaction projected onto its bucket.
type SpendRow struct {
	Bucket     string // "need" | "want" | "saving"
	Direction  string // "debit" | "credit"
	AmountFils int64
}

// monthRange returns the half-open [start, end) ISO date bounds for "YYYY-MM".
func monthRange(period string) (string, string, error) {
	t, err := time.Parse("2006-01", period)
	if err != nil {
		return "", "", fmt.Errorf("bad period %q: %w", period, err)
	}
	start := t.Format("2006-01-02")
	end := t.AddDate(0, 1, 0).Format("2006-01-02")
	return start, end, nil
}

// jarAED is the AED expression the jar/insights aggregates have always used:
// amount_aed with a 0 fallback (a row without an AED snapshot contributes
// nothing rather than a raw foreign amount).
const jarAED = `COALESCE(t.amount_aed, 0)`

// projectCarveOut is the monthly-budget project exclusion: confirmed spend
// assigned to a carved-out life project (count_in_monthly=0) stays out of the
// monthly aggregates — jars, envelopes and insights must all agree on it, or
// the same transaction would count on one surface and not another. Requires
// the transactions alias `t`; the split-line queries share it because the
// project link lives on the parent.
const projectCarveOut = `(t.project_id IS NULL
	         OR EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.count_in_monthly = 1))`

// SelectMonthSpend returns confirmed, spending-kind activity in the period,
// one row per transaction (or per split line). The bucket is the category's
// current bucket, or bucket_snapshot when frozen. Split parents are excluded
// (their category is NULL while split — and defensively by NOT EXISTS);
// their split LINES contribute instead, under each line's own category,
// AED-scaled from the parent so splitting a transaction never changes the
// month's jar totals. Split lines always use the line category's current
// bucket: splitting clears the parent's bucket_snapshot.
func (s *Store) SelectMonthSpend(period string, frozen bool) ([]SpendRow, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return nil, err
	}
	bucketExpr := "c.bucket"
	if frozen {
		bucketExpr = "COALESCE(t.bucket_snapshot, c.bucket)"
	}
	var out []SpendRow
	collect := func(query string) error {
		rows, err := s.DB.Query(query, start, end)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var r SpendRow
			var bucket *string
			if err := rows.Scan(&bucket, &r.Direction, &r.AmountFils); err != nil {
				return err
			}
			if bucket != nil {
				r.Bucket = *bucket
			}
			out = append(out, r)
		}
		return rows.Err()
	}
	if err := collect(
		`SELECT ` + bucketExpr + `, t.direction, ` + jarAED + `
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='spending'
		    AND t.posted_at >= ? AND t.posted_at < ?
		    AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)
		    AND ` + projectCarveOut,
	); err != nil {
		return nil, err
	}
	if err := collect(
		`SELECT c.bucket, t.direction, ` + splitAEDFils(jarAED) + `
		   FROM transaction_splits sp
		   JOIN transactions t ON t.id = sp.transaction_id
		   JOIN categories c ON c.id = sp.category_id
		  WHERE t.status='confirmed' AND c.kind='spending' AND t.amount > 0
		    AND t.posted_at >= ? AND t.posted_at < ?
		    AND ` + projectCarveOut,
	); err != nil {
		return nil, err
	}
	return out, nil
}

// SelectMonthProjectExcluded returns the net AED spend in the period that was
// carved out of the monthly jars (confirmed spending txns whose project has
// count_in_monthly=0). Used for the "excludes AED X in project spend" note.
// Split parents contribute through their spending-category split lines (the
// project link lives on the parent).
func (s *Store) SelectMonthProjectExcluded(period string, frozen bool) (int64, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return 0, err
	}
	var total int64
	err = s.DB.QueryRow(
		`SELECT COALESCE(SUM(CASE t.direction WHEN 'debit' THEN `+projAmt+`
		                                      WHEN 'credit' THEN -`+projAmt+` ELSE 0 END), 0)
		   FROM transactions t
		   JOIN categories c ON c.id = t.category_id
		   JOIN projects p ON p.id = t.project_id
		  WHERE t.status='confirmed' AND c.kind='spending' AND p.count_in_monthly = 0
		    AND t.posted_at >= ? AND t.posted_at < ?
		    AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)`,
		start, end,
	).Scan(&total)
	if err != nil {
		return 0, err
	}
	scaled := splitAEDFils(projAmt)
	var splitTotal int64
	err = s.DB.QueryRow(
		`SELECT COALESCE(SUM(CASE t.direction WHEN 'debit' THEN `+scaled+`
		                                      WHEN 'credit' THEN -`+scaled+` ELSE 0 END), 0)
		   FROM transaction_splits sp
		   JOIN transactions t ON t.id = sp.transaction_id
		   JOIN categories c ON c.id = sp.category_id
		   JOIN projects p ON p.id = t.project_id
		  WHERE t.status='confirmed' AND c.kind='spending' AND p.count_in_monthly = 0
		    AND t.amount > 0
		    AND t.posted_at >= ? AND t.posted_at < ?`,
		start, end,
	).Scan(&splitTotal)
	return total + splitTotal, err
}

// SelectMonthIncome sums confirmed income-kind credits in the period. A split
// credit contributes through its income-category split lines (AED-scaled), so
// splitting a salary/refund credit never deletes it from income or RTA.
func (s *Store) SelectMonthIncome(period string) (int64, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return 0, err
	}
	var total int64
	err = s.DB.QueryRow(
		`SELECT COALESCE(SUM(`+jarAED+`), 0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='income' AND t.direction='credit'
		    AND t.posted_at >= ? AND t.posted_at < ?
		    AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)`,
		start, end,
	).Scan(&total)
	if err != nil {
		return 0, err
	}
	var splitTotal int64
	err = s.DB.QueryRow(
		`SELECT COALESCE(SUM(`+splitAEDFils(jarAED)+`), 0)
		   FROM transaction_splits sp
		   JOIN transactions t ON t.id = sp.transaction_id
		   JOIN categories c ON c.id = sp.category_id
		  WHERE t.status='confirmed' AND c.kind='income' AND t.direction='credit'
		    AND t.amount > 0
		    AND t.posted_at >= ? AND t.posted_at < ?`,
		start, end,
	).Scan(&splitTotal)
	return total + splitTotal, err
}

// SelectEarliestPeriod returns the "YYYY-MM" of the earliest confirmed
// transaction. ok is false when there are no confirmed transactions yet.
func (s *Store) SelectEarliestPeriod() (period string, ok bool, err error) {
	var p *string
	err = s.DB.QueryRow(
		`SELECT strftime('%Y-%m', MIN(posted_at)) FROM transactions WHERE status='confirmed'`,
	).Scan(&p)
	if err != nil {
		return "", false, err
	}
	if p == nil {
		return "", false, nil
	}
	return *p, true, nil
}

// SelectRecent returns the newest n transactions as ReviewItems for the dashboard list.
func (s *Store) SelectRecent(n int) ([]ReviewItem, error) {
	rows, err := s.DB.Query(
		`SELECT `+reviewItemColumns+`
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  ORDER BY t.posted_at DESC LIMIT ?`, n,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
