package store

import "bytes"

// CompressRawBodies gzips every still-plain raw_body in ingest_log, in id-order
// batches so the whole table is never held in memory. Returns how many rows
// were converted. Idempotent: already-gzipped rows are skipped.
func (s *Store) CompressRawBodies() (int, error) {
	converted := 0
	lastID := int64(0)
	for {
		type rowT struct {
			id  int64
			raw []byte
		}
		var batch []rowT
		rows, err := s.DB.Query(
			`SELECT id, raw_body FROM ingest_log
			  WHERE id > ? AND raw_body IS NOT NULL ORDER BY id LIMIT 200`, lastID)
		if err != nil {
			return converted, err
		}
		for rows.Next() {
			var r rowT
			if err := rows.Scan(&r.id, &r.raw); err != nil {
				rows.Close()
				return converted, err
			}
			batch = append(batch, r)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return converted, err
		}
		rows.Close()
		if len(batch) == 0 {
			return converted, nil
		}
		for _, r := range batch {
			lastID = r.id
			if bytes.HasPrefix(r.raw, gzipMagic) {
				continue
			}
			if _, err := s.DB.Exec(
				`UPDATE ingest_log SET raw_body=? WHERE id=?`, compressBody(r.raw), r.id); err != nil {
				return converted, err
			}
			converted++
		}
	}
}

// Vacuum reclaims file space after CompressRawBodies rewrote the big rows.
func (s *Store) Vacuum() error {
	_, err := s.DB.Exec("VACUUM")
	return err
}
