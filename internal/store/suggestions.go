package store

import (
	"database/sql"
	"errors"
	"time"
)

// GetAISuggestion returns the remembered AI category suggestion for a
// normalized (lowercased, trimmed) merchant string. ok=false means no memo.
// The category name is resolved by JOIN so later renames stay correct; a memo
// whose category was deleted simply misses and the caller re-asks the AI.
func (s *Store) GetAISuggestion(merchantNorm string) (string, float64, bool, error) {
	var name string
	var conf float64
	err := s.DB.QueryRow(
		`SELECT c.name, m.confidence
		   FROM ai_suggestions m JOIN categories c ON c.id = m.category_id
		  WHERE m.merchant_norm = ?`, merchantNorm).Scan(&name, &conf)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, err
	}
	return name, conf, true, nil
}

// PutAISuggestion upserts the memo for a normalized merchant string.
func (s *Store) PutAISuggestion(merchantNorm string, categoryID int64, confidence float64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`INSERT INTO ai_suggestions (merchant_norm, category_id, confidence, created_at)
		 VALUES (?, ?, ?, ?)
		 ON CONFLICT(merchant_norm) DO UPDATE SET
		   category_id = excluded.category_id,
		   confidence  = excluded.confidence,
		   created_at  = excluded.created_at`,
		merchantNorm, categoryID, confidence, now)
	return err
}
