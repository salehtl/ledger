package store

import "time"

// PushSubRow is one web push subscription stored in push_subscriptions.
type PushSubRow struct {
	ID        int64
	Endpoint  string
	P256dh    string
	Auth      string
	CreatedAt string
}

// InsertPushSub stores (or replaces) a web push subscription keyed by endpoint.
// It also clears any gone mark for the endpoint: callers reach it only on an
// explicit subscribe, or on a re-sync the server has already checked.
func (s *Store) InsertPushSub(r PushSubRow) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM push_gone WHERE endpoint = ?`, r.Endpoint); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at)
		 VALUES (?, ?, ?, ?)`,
		r.Endpoint, r.P256dh, r.Auth, time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		return err
	}
	return tx.Commit()
}

// PrunePushSub removes a subscription the push service reported permanently
// gone (404/410) and remembers the endpoint, so a re-sync cannot restore it.
func (s *Store) PrunePushSub(endpoint string) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO push_gone (endpoint, gone_at) VALUES (?, ?)`,
		endpoint, time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		return err
	}
	return tx.Commit()
}

// PushSubGone reports whether a push service declared the endpoint gone.
func (s *Store) PushSubGone(endpoint string) (bool, error) {
	var n int
	err := s.DB.QueryRow(`SELECT COUNT(*) FROM push_gone WHERE endpoint = ?`, endpoint).Scan(&n)
	return n > 0, err
}

// SelectPushSubs returns all stored push subscriptions.
func (s *Store) SelectPushSubs() ([]PushSubRow, error) {
	rows, err := s.DB.Query(
		`SELECT id, endpoint, p256dh, auth, created_at FROM push_subscriptions ORDER BY id`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PushSubRow
	for rows.Next() {
		var r PushSubRow
		if err := rows.Scan(&r.ID, &r.Endpoint, &r.P256dh, &r.Auth, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeletePushSub removes the subscription with the given endpoint (no-op if not found).
func (s *Store) DeletePushSub(endpoint string) error {
	_, err := s.DB.Exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint)
	return err
}
