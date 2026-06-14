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
func (s *Store) InsertPushSub(r PushSubRow) error {
	_, err := s.DB.Exec(
		`INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, created_at)
		 VALUES (?, ?, ?, ?)`,
		r.Endpoint, r.P256dh, r.Auth, time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
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
