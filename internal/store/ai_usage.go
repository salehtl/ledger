// internal/store/ai_usage.go
package store

// AIUsageRow is one recorded Anthropic call. At is unix seconds; if zero on insert
// it defaults to the store clock (s.now()).
type AIUsageRow struct {
	At           int64
	Path         string
	Model        string
	InputTokens  int64
	OutputTokens int64
	CostMuUSD    int64
	OK           bool
	Detail       string
}

// AIUsageStats aggregates usage over all time and the trailing 30 days.
type AIUsageStats struct {
	Count30d     int
	Cost30dMuUSD int64
	CountAll     int
	CostAllMuUSD int64
}

// RecordAIUsage inserts one usage row. It then enforces the monthly spend cap: if
// ai_spend_cap_musd > 0 and the trailing-30-day cost sum has reached the cap and AI
// is not already latched off, it sets ai_enabled=0 and ai_cap_latched=1 and returns
// latched=true. Callers fire a push notification when latched is true.
func (s *Store) RecordAIUsage(row AIUsageRow) (latched bool, err error) {
	at := row.At
	if at == 0 {
		at = s.now()
	}
	oki := 0
	if row.OK {
		oki = 1
	}
	if _, err = s.DB.Exec(
		`INSERT INTO ai_usage (at, path, model, input_tokens, output_tokens, cost_musd, ok, detail)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		at, row.Path, row.Model, row.InputTokens, row.OutputTokens, row.CostMuUSD, oki, row.Detail,
	); err != nil {
		return false, err
	}

	cur, err := s.SelectAppSettings()
	if err != nil {
		return false, err
	}
	if cur.SpendCapMuUSD <= 0 || cur.CapLatched {
		return false, nil
	}
	sum, err := s.SumAIUsageMuUSD(s.now() - 30*24*3600)
	if err != nil {
		return false, err
	}
	if sum < cur.SpendCapMuUSD {
		return false, nil
	}
	if _, err = s.DB.Exec(
		`UPDATE app_settings SET ai_enabled=0, ai_cap_latched=1 WHERE id=1`,
	); err != nil {
		return false, err
	}
	return true, nil
}

// SumAIUsageMuUSD returns total cost_musd for successful+failed rows at or after `since`.
func (s *Store) SumAIUsageMuUSD(since int64) (int64, error) {
	var sum int64
	err := s.DB.QueryRow(
		`SELECT COALESCE(SUM(cost_musd), 0) FROM ai_usage WHERE at >= ?`, since,
	).Scan(&sum)
	return sum, err
}

// AIUsageStats aggregates all-time and trailing-30-day counts and cost.
func (s *Store) AIUsageStats(now int64) (AIUsageStats, error) {
	var a AIUsageStats
	if err := s.DB.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(cost_musd),0) FROM ai_usage`,
	).Scan(&a.CountAll, &a.CostAllMuUSD); err != nil {
		return a, err
	}
	since := now - 30*24*3600
	if err := s.DB.QueryRow(
		`SELECT COUNT(*), COALESCE(SUM(cost_musd),0) FROM ai_usage WHERE at >= ?`, since,
	).Scan(&a.Count30d, &a.Cost30dMuUSD); err != nil {
		return a, err
	}
	return a, nil
}

// RecentAIUsage returns the most recent `limit` rows, newest first.
func (s *Store) RecentAIUsage(limit int) ([]AIUsageRow, error) {
	rows, err := s.DB.Query(
		`SELECT at, path, model, input_tokens, output_tokens, cost_musd, ok, COALESCE(detail,'')
		 FROM ai_usage ORDER BY at DESC, id DESC LIMIT ?`, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AIUsageRow
	for rows.Next() {
		var r AIUsageRow
		var oki int
		if err := rows.Scan(&r.At, &r.Path, &r.Model, &r.InputTokens, &r.OutputTokens, &r.CostMuUSD, &oki, &r.Detail); err != nil {
			return nil, err
		}
		r.OK = oki == 1
		out = append(out, r)
	}
	return out, rows.Err()
}
