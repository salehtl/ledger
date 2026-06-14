package store

import "time"

// ImportLogRow records one completed import batch for auditability.
type ImportLogRow struct {
	ID          int64
	FileName    string
	RowsTotal   int
	RowsAdded   int
	RowsSkipped int
	RowsReview  int
	RowsError   int
	CreatedAt   string
}

// InsertImportLog records a completed import batch and returns the new row ID.
func (s *Store) InsertImportLog(r ImportLogRow) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT INTO import_log
		   (file_name, rows_total, rows_added, rows_skipped, rows_review, rows_error, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		nullableStr(r.FileName), r.RowsTotal, r.RowsAdded, r.RowsSkipped, r.RowsReview, r.RowsError, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SelectImportLogs returns all import_log rows, newest first.
func (s *Store) SelectImportLogs() ([]ImportLogRow, error) {
	rows, err := s.DB.Query(
		`SELECT id, COALESCE(file_name,''), rows_total, rows_added, rows_skipped,
		        rows_review, rows_error, created_at
		 FROM import_log ORDER BY id DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ImportLogRow
	for rows.Next() {
		var r ImportLogRow
		if err := rows.Scan(
			&r.ID, &r.FileName, &r.RowsTotal, &r.RowsAdded,
			&r.RowsSkipped, &r.RowsReview, &r.RowsError, &r.CreatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
