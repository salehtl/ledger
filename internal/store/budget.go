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

// SelectMonthSpend returns confirmed, spending-kind transactions in the period.
// The bucket is the category's current bucket, or bucket_snapshot when frozen.
func (s *Store) SelectMonthSpend(period string, frozen bool) ([]SpendRow, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return nil, err
	}
	bucketExpr := "c.bucket"
	if frozen {
		bucketExpr = "COALESCE(t.bucket_snapshot, c.bucket)"
	}
	rows, err := s.DB.Query(
		`SELECT `+bucketExpr+`, t.direction, t.amount
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='spending'
		    AND t.posted_at >= ? AND t.posted_at < ?`,
		start, end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SpendRow
	for rows.Next() {
		var r SpendRow
		var bucket *string
		if err := rows.Scan(&bucket, &r.Direction, &r.AmountFils); err != nil {
			return nil, err
		}
		if bucket != nil {
			r.Bucket = *bucket
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SelectMonthIncome sums confirmed income-kind credits in the period.
func (s *Store) SelectMonthIncome(period string) (int64, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return 0, err
	}
	var total int64
	err = s.DB.QueryRow(
		`SELECT COALESCE(SUM(t.amount), 0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='income' AND t.direction='credit'
		    AND t.posted_at >= ? AND t.posted_at < ?`,
		start, end,
	).Scan(&total)
	return total, err
}

// SelectRecent returns the newest n transactions as ReviewItems for the dashboard list.
func (s *Store) SelectRecent(n int) ([]ReviewItem, error) {
	rows, err := s.DB.Query(
		`SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
		        COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,'')
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  ORDER BY t.posted_at DESC LIMIT ?`, n,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}
