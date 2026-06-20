package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
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
	Source      string // "email" | "import" | "manual"; defaults to "email" if empty
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
// UNIQUE fingerprint index). Returns (rowID, created, error).
// rowID is the new row's ID when created=true, and 0 when the fingerprint already existed.
// A zero IngestID is stored as NULL; non-zero values must reference an existing
// ingest_log row (PRAGMA foreign_keys=ON is active).
func (s *Store) InsertTransaction(r TransactionRow) (int64, bool, error) {
	source := r.Source
	if source == "" {
		source = "email"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, status, confidence,
		    fingerprint, source, ingest_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, r.Currency, r.Direction,
		r.MerchantRaw, r.Status, r.Confidence, r.Fingerprint(), source, nullableID(r.IngestID), now, now,
	)
	if err != nil {
		return 0, false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}
	if n == 0 {
		return 0, false, nil
	}
	id, err := res.LastInsertId()
	return id, true, err
}

// nullableID maps a zero rowid to SQL NULL (0 is never a valid ingest_log id).
func nullableID(id int64) any {
	if id == 0 {
		return nil
	}
	return id
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

// ArchiveTransaction soft-deletes a transaction: it stashes the current status
// in archived_from and sets status='archived'. Archived rows are hidden from the
// default transaction list and fall out of budgets/insights (which count only
// status='confirmed'). No row is ever physically deleted. No-op if already archived.
func (s *Store) ArchiveTransaction(txID int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`UPDATE transactions
		    SET archived_from=status, status='archived', updated_at=?
		  WHERE id=? AND status!='archived'`,
		now, txID,
	)
	return err
}

// RestoreTransaction reverses ArchiveTransaction: it returns the row to its
// pre-archive status (or 'needs_review' when unknown) and clears archived_from.
// No-op if the row is not archived.
func (s *Store) RestoreTransaction(txID int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`UPDATE transactions
		    SET status=COALESCE(NULLIF(archived_from,''), 'needs_review'),
		        archived_from=NULL, updated_at=?
		  WHERE id=? AND status='archived'`,
		now, txID,
	)
	return err
}

// ManualTxn is a user-entered transaction. CategoryID 0 means uncategorized.
type ManualTxn struct {
	PostedAt    time.Time
	AmountFils  int64
	Currency    string // "" defaults to "AED"
	Direction   string // "debit" | "credit"
	MerchantRaw string
	CategoryID  int64
}

// InsertManualTransaction writes a user-entered transaction (source='manual',
// confidence 1.0). A row with a category is trusted and stored 'confirmed';
// without one it lands in 'needs_review'. The fingerprint is salted with random
// bytes so a deliberate manual entry never trips the UNIQUE fingerprint index
// (two identical real-world purchases on the same day are legitimate).
func (s *Store) InsertManualTransaction(m ManualTxn) (int64, error) {
	currency := m.Currency
	if currency == "" {
		currency = "AED"
	}
	status := "needs_review"
	var catID any
	if m.CategoryID > 0 {
		status = "confirmed"
		catID = m.CategoryID
	}
	base := TransactionRow{
		PostedAt:    m.PostedAt,
		AmountFils:  m.AmountFils,
		Direction:   m.Direction,
		MerchantRaw: m.MerchantRaw,
	}
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return 0, err
	}
	fp := base.Fingerprint() + "|manual|" + hex.EncodeToString(salt)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT INTO transactions
		   (posted_at, amount, currency, direction, merchant_raw, category_id, status,
		    confidence, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
		m.PostedAt.UTC().Format(time.RFC3339Nano), m.AmountFils, currency, m.Direction,
		m.MerchantRaw, catID, status, 1.0, fp, now, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// FindTransferMatch looks for an existing transaction that could be the other leg
// of a self-transfer: same amount, opposite direction, within `window` of `postedAt`,
// and not already marked as a transfer. Returns (matchID, true, nil) on hit.
func (s *Store) FindTransferMatch(txID, amountFils int64, direction string, postedAt time.Time, window time.Duration) (int64, bool, error) {
	opp := "credit"
	if direction == "credit" {
		opp = "debit"
	}
	start := postedAt.Add(-window).UTC().Format(time.RFC3339Nano)
	end := postedAt.Add(window).UTC().Format(time.RFC3339Nano)
	postedStr := postedAt.UTC().Format(time.RFC3339Nano)

	var matchID int64
	err := s.DB.QueryRow(`
		SELECT id FROM transactions
		 WHERE id != ?
		   AND amount = ?
		   AND direction = ?
		   AND posted_at >= ?
		   AND posted_at <= ?
		   AND status != 'transfer'
		 ORDER BY ABS(CAST((julianday(posted_at) - julianday(?)) * 86400 AS INTEGER))
		 LIMIT 1
	`, txID, amountFils, opp, start, end, postedStr).Scan(&matchID)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return matchID, true, nil
}
