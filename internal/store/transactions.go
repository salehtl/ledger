package store

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// TransactionRow is an extracted transaction ready to persist. account_id and
// category_id are left NULL in Milestone 3 (no seeding/categorization yet).
type TransactionRow struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string
	Direction   string
	MerchantRaw string
	Last4       string
	Status      string
	Confidence  float64
	Tier        string
	IngestID    int64
}

// Fingerprint is sha256(last4 | amount | direction | normalize(merchant) | day),
// matching §6.4. With no account seeded yet we use Last4 in place of account_id.
func (r TransactionRow) Fingerprint() string {
	merchant := strings.ToLower(strings.Join(strings.Fields(r.MerchantRaw), " "))
	day := r.PostedAt.UTC().Format("2006-01-02")
	key := fmt.Sprintf("%s|%d|%s|%s|%s", r.Last4, r.AmountFils, r.Direction, merchant, day)
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// InsertTransaction writes a transaction idempotently (INSERT OR IGNORE on the
// UNIQUE fingerprint index). Returns true if a new row was created.
// ingest_id is stored only when a corresponding ingest_log row exists; callers
// that hold a verified ingest_log id should use InsertTransactionLinked.
func (s *Store) InsertTransaction(r TransactionRow) (bool, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, status, confidence,
		    fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, r.Currency, r.Direction,
		r.MerchantRaw, r.Status, r.Confidence, r.Fingerprint(), now, now,
	)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// IngestForParse is one ingest_log row the processor will run the cascade over.
type IngestForParse struct {
	ID       int64
	FromAddr string
	Subject  string
	RawBody  []byte
}

// SelectForParseOpts filters which ingest rows to (re)process.
type SelectForParseOpts struct {
	OnlyUnparsed bool   // true: only parse_status='unparsed'; false: also 'low_confidence'
	FromLike     string // optional: restrict to a sender substring (e.g. a bank)
}

// SelectForParse returns ingest rows for the cascade. Reprocess passes
// OnlyUnparsed=false to also retry low-confidence rows.
func (s *Store) SelectForParse(opts SelectForParseOpts) ([]IngestForParse, error) {
	statuses := "('unparsed','low_confidence')"
	if opts.OnlyUnparsed {
		statuses = "('unparsed')"
	}
	q := `SELECT id, from_addr, subject, raw_body FROM ingest_log WHERE parse_status IN ` + statuses
	args := []any{}
	if opts.FromLike != "" {
		q += " AND from_addr LIKE ?"
		args = append(args, "%"+opts.FromLike+"%")
	}
	q += " ORDER BY id"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IngestForParse
	for rows.Next() {
		var r IngestForParse
		var raw string
		if err := rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &raw); err != nil {
			return nil, err
		}
		r.RawBody = []byte(raw)
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkParsed stamps an ingest_log row's parse outcome.
func (s *Store) MarkParsed(ingestID int64, status, tier, parseErr string) error {
	_, err := s.DB.Exec(
		`UPDATE ingest_log SET parse_status=?, parse_tier=?, parse_error=? WHERE id=?`,
		status, nullable(tier), nullable(parseErr), ingestID)
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
