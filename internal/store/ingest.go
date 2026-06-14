package store

import (
	"database/sql"
	"time"
)

// IngestRecord is one row destined for ingest_log. Milestone 2 records the raw
// message and envelope metadata only; parse_status is always "unparsed" until
// Milestone 3 runs the cascade. bank_detected, parse_tier, and structure_sig
// stay NULL for now.
type IngestRecord struct {
	MessageUID  string
	ReceivedAt  time.Time
	FromAddr    string
	Subject     string
	ParseStatus string
	RawBody     []byte
	CreatedAt   time.Time
}

func rfc3339OrEmpty(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

// InsertIngest writes a message idempotently. It returns true if a new row was
// created, false if message_uid already existed (INSERT OR IGNORE on the UNIQUE
// constraint).
func (s *Store) InsertIngest(r IngestRecord) (bool, error) {
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO ingest_log
		   (message_uid, received_at, from_addr, subject, parse_status, raw_body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.MessageUID,
		rfc3339OrEmpty(r.ReceivedAt),
		r.FromAddr,
		r.Subject,
		r.ParseStatus,
		string(r.RawBody),
		rfc3339OrEmpty(r.CreatedAt),
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// KnownUIDs returns the set of message_uid values already stored, for backfill
// diffing.
func (s *Store) KnownUIDs() (map[string]struct{}, error) {
	rows, err := s.DB.Query(`SELECT message_uid FROM ingest_log WHERE message_uid IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	known := make(map[string]struct{})
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		known[uid] = struct{}{}
	}
	return known, rows.Err()
}

// CountIngest returns the number of rows in ingest_log.
func (s *Store) CountIngest() (int, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM ingest_log`).Scan(&n)
	return n, err
}

// LastIngestAt returns the most recent created_at. ok is false when the table is
// empty.
func (s *Store) LastIngestAt() (time.Time, bool, error) {
	var v sql.NullString
	if err := s.DB.QueryRow(`SELECT MAX(created_at) FROM ingest_log`).Scan(&v); err != nil {
		return time.Time{}, false, err
	}
	if !v.Valid || v.String == "" {
		return time.Time{}, false, nil
	}
	t, err := time.Parse(time.RFC3339Nano, v.String)
	if err != nil {
		return time.Time{}, false, err
	}
	return t, true, nil
}
