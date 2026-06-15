// internal/store/insights.go
package store

import "time"

// CategorySpendRow is one category's confirmed spend in a period.
type CategorySpendRow struct {
	CategoryID int64
	Name       string
	Bucket     string
	AmountFils int64
}

// SelectCategorySpend returns confirmed spending-kind debits in the period,
// grouped by category, highest spend first. Bucket honors bucket_snapshot when frozen.
func (s *Store) SelectCategorySpend(period string, frozen bool) ([]CategorySpendRow, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return nil, err
	}
	bucketExpr := "c.bucket"
	if frozen {
		bucketExpr = "COALESCE(t.bucket_snapshot, c.bucket)"
	}
	rows, err := s.DB.Query(
		`SELECT c.id, c.name, COALESCE(`+bucketExpr+`,''), SUM(t.amount)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND c.kind='spending' AND t.direction='debit'
		    AND t.posted_at >= ? AND t.posted_at < ?
		  GROUP BY c.id, c.name
		  ORDER BY SUM(t.amount) DESC`,
		start, end,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CategorySpendRow
	for rows.Next() {
		var r CategorySpendRow
		if err := rows.Scan(&r.CategoryID, &r.Name, &r.Bucket, &r.AmountFils); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// MonthlyTotalRow is confirmed spend + income for one calendar month.
type MonthlyTotalRow struct {
	Period     string // "YYYY-MM"
	SpentFils  int64
	IncomeFils int64
}

// SelectMonthlyTotals returns the trailing `months` calendar months (oldest first),
// each with confirmed spending debits and income credits. Months with no activity
// are omitted by the GROUP BY; the caller (frontend) fills gaps for display.
func (s *Store) SelectMonthlyTotals(months int) ([]MonthlyTotalRow, error) {
	if months < 1 {
		months = 1
	}
	now := time.Now().UTC()
	firstOfThis := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	start := firstOfThis.AddDate(0, -(months-1), 0).Format("2006-01-02")
	rows, err := s.DB.Query(
		`SELECT strftime('%Y-%m', t.posted_at) AS ym,
		        COALESCE(SUM(CASE WHEN c.kind='spending' AND t.direction='debit' THEN t.amount END),0),
		        COALESCE(SUM(CASE WHEN c.kind='income'   AND t.direction='credit' THEN t.amount END),0)
		   FROM transactions t JOIN categories c ON c.id = t.category_id
		  WHERE t.status='confirmed' AND t.posted_at >= ?
		  GROUP BY ym ORDER BY ym`,
		start,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MonthlyTotalRow
	for rows.Next() {
		var r MonthlyTotalRow
		if err := rows.Scan(&r.Period, &r.SpentFils, &r.IncomeFils); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
