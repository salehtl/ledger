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

// carveOutPredicate mirrors SelectMonthSpend's project carve-out: spend
// assigned to a count_in_monthly=0 project stays out of monthly aggregates,
// so Insights agrees with the Home jars. Requires the projects LEFT JOIN.
const carveOutPredicate = `(t.project_id IS NULL OR p.count_in_monthly = 1)`

// SelectCategorySpend returns confirmed spending-kind activity in the period,
// netting credits (refunds) against debits, grouped by category, highest net
// spend first. Bucket honors bucket_snapshot when frozen. Spend carved out
// into excluded projects is omitted, matching the monthly jars. Split parents
// (category NULL while split) are excluded and their split lines contribute
// instead, AED-scaled, under each line's own category — splitting never
// changes a period's insight totals. Split lines always show the line
// category's current bucket (splitting clears the parent snapshot).
func (s *Store) SelectCategorySpend(period string, frozen bool) ([]CategorySpendRow, error) {
	start, end, err := monthRange(period)
	if err != nil {
		return nil, err
	}
	bucketExpr := "c.bucket"
	if frozen {
		bucketExpr = "COALESCE(t.bucket_snapshot, c.bucket)"
	}
	scaled := splitAEDFils(`COALESCE(t.amount_aed, 0)`)
	rows, err := s.DB.Query(
		`SELECT id, name, bucket, SUM(net) AS net FROM (
		   SELECT c.id AS id, c.name AS name, COALESCE(`+bucketExpr+`,'') AS bucket,
		          CASE WHEN t.direction='debit' THEN COALESCE(t.amount_aed, 0)
		               ELSE -COALESCE(t.amount_aed, 0) END AS net
		     FROM transactions t
		     JOIN categories c ON c.id = t.category_id
		     LEFT JOIN projects p ON p.id = t.project_id
		    WHERE t.status='confirmed' AND c.kind='spending'
		      AND t.posted_at >= ? AND t.posted_at < ?
		      AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)
		      AND `+carveOutPredicate+`
		   UNION ALL
		   SELECT c.id, c.name, COALESCE(c.bucket,''),
		          CASE WHEN t.direction='debit' THEN `+scaled+` ELSE -`+scaled+` END
		     FROM transaction_splits sp
		     JOIN transactions t ON t.id = sp.transaction_id
		     JOIN categories c ON c.id = sp.category_id
		     LEFT JOIN projects p ON p.id = t.project_id
		    WHERE t.status='confirmed' AND c.kind='spending' AND t.amount > 0
		      AND t.posted_at >= ? AND t.posted_at < ?
		      AND `+carveOutPredicate+`
		 )
		 GROUP BY id, name
		 ORDER BY net DESC`,
		start, end, start, end,
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
// Split parents are excluded; their split lines contribute (AED-scaled) under
// each line category's kind, so splitting never dents the trend series.
func (s *Store) SelectMonthlyTotals(months int) ([]MonthlyTotalRow, error) {
	if months < 1 {
		months = 1
	}
	now := time.Now().UTC()
	firstOfThis := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	start := firstOfThis.AddDate(0, -(months - 1), 0).Format("2006-01-02")
	// The carve-out applies to the spending series only — income is never
	// carved out, so a credit inside an excluded project still counts.
	scaled := splitAEDFils(`COALESCE(t.amount_aed, 0)`)
	rows, err := s.DB.Query(
		`SELECT ym, COALESCE(SUM(spend),0), COALESCE(SUM(income),0) FROM (
		   SELECT strftime('%Y-%m', t.posted_at) AS ym,
		          CASE WHEN c.kind='spending' AND t.direction='debit' AND `+carveOutPredicate+` THEN COALESCE(t.amount_aed, 0)
		               WHEN c.kind='spending' AND t.direction='credit' AND `+carveOutPredicate+` THEN -COALESCE(t.amount_aed, 0) END AS spend,
		          CASE WHEN c.kind='income'   AND t.direction='credit' THEN COALESCE(t.amount_aed, 0) END AS income
		     FROM transactions t
		     JOIN categories c ON c.id = t.category_id
		     LEFT JOIN projects p ON p.id = t.project_id
		    WHERE t.status='confirmed' AND t.posted_at >= ?
		      AND NOT EXISTS (SELECT 1 FROM transaction_splits sp WHERE sp.transaction_id = t.id)
		   UNION ALL
		   SELECT strftime('%Y-%m', t.posted_at),
		          CASE WHEN c.kind='spending' AND t.direction='debit' AND `+carveOutPredicate+` THEN `+scaled+`
		               WHEN c.kind='spending' AND t.direction='credit' AND `+carveOutPredicate+` THEN -`+scaled+` END,
		          CASE WHEN c.kind='income'   AND t.direction='credit' THEN `+scaled+` END
		     FROM transaction_splits sp
		     JOIN transactions t ON t.id = sp.transaction_id
		     JOIN categories c ON c.id = sp.category_id
		     LEFT JOIN projects p ON p.id = t.project_id
		    WHERE t.status='confirmed' AND t.amount > 0 AND t.posted_at >= ?
		 )
		 GROUP BY ym ORDER BY ym`,
		start, start,
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
