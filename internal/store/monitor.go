package store

import "time"

// DriftStat is the parse-success record for one sender within a query window.
type DriftStat struct {
	FromAddr string
	Total    int
	Parsed   int
}

// SuccessRate returns Parsed/Total, or 1.0 when Total is 0.
func (d DriftStat) SuccessRate() float64 {
	if d.Total == 0 {
		return 1.0
	}
	return float64(d.Parsed) / float64(d.Total)
}

// SelectDriftStats returns per-from_addr parse stats for emails received after
// `since`. Only senders with at least `minVolume` emails are included.
func (s *Store) SelectDriftStats(since time.Time, minVolume int) ([]DriftStat, error) {
	rows, err := s.DB.Query(`
		SELECT from_addr,
		       COUNT(*) AS total,
		       SUM(CASE WHEN parse_status = 'parsed' THEN 1 ELSE 0 END) AS parsed
		FROM ingest_log
		WHERE created_at >= ? AND from_addr IS NOT NULL
		GROUP BY from_addr
		HAVING total >= ?
	`, since.UTC().Format(time.RFC3339Nano), minVolume)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DriftStat
	for rows.Next() {
		var d DriftStat
		if err := rows.Scan(&d.FromAddr, &d.Total, &d.Parsed); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
