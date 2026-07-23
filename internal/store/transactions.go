package store

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
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
	amountAED, err := s.amountAEDValue(r.AmountFils, r.Currency)
	if err != nil {
		return 0, false, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT OR IGNORE INTO transactions
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, last4, status, confidence,
		    fingerprint, source, ingest_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.PostedAt.UTC().Format(time.RFC3339Nano), r.AmountFils, amountAED, r.Currency, r.Direction,
		r.MerchantRaw, nullable(r.Last4), r.Status, r.Confidence, r.Fingerprint(), source, nullableID(r.IngestID), now, now,
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

// TransactionIDByIngest returns the transaction created from the given
// ingest_log row, if any. The fingerprint index can't catch a re-parse of the
// same email that extracts different text (tier or AI wording drift), so
// reprocessing guards on this instead.
func (s *Store) TransactionIDByIngest(ingestID int64) (int64, bool, error) {
	var id int64
	err := s.DB.QueryRow(`SELECT id FROM transactions WHERE ingest_id = ? LIMIT 1`, ingestID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return id, true, nil
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
	ID          int64
	FromAddr    string
	Subject     string
	ParseStatus string
	RawBody     []byte
}

// SelectForParseOpts filters which ingest rows to (re)process.
type SelectForParseOpts struct {
	OnlyUnparsed bool   // true: only parse_status='unparsed'; false: also 'low_confidence'
	FromLike     string // optional: restrict to a sender substring (e.g. a bank)
	MaxAttempts  int    // >0: skip rows already failed this many times (periodic hook); 0: no cap (manual reprocess)
}

// SelectForParse returns ingest rows for the cascade. Reprocess passes
// OnlyUnparsed=false to also retry low-confidence rows.
func (s *Store) SelectForParse(opts SelectForParseOpts) ([]IngestForParse, error) {
	statuses := "('unparsed','low_confidence')"
	if opts.OnlyUnparsed {
		statuses = "('unparsed')"
	}
	q := `SELECT id, from_addr, subject, parse_status, raw_body FROM ingest_log WHERE parse_status IN ` + statuses
	args := []any{}
	if opts.FromLike != "" {
		q += " AND from_addr LIKE ?"
		args = append(args, "%"+opts.FromLike+"%")
	}
	if opts.MaxAttempts > 0 {
		q += " AND parse_attempts < ?"
		args = append(args, opts.MaxAttempts)
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
		var raw []byte
		if err := rows.Scan(&r.ID, &r.FromAddr, &r.Subject, &r.ParseStatus, &raw); err != nil {
			return nil, err
		}
		body, derr := decodeBody(raw)
		if derr != nil {
			// Corrupt stored gzip must not stall the whole batch: pass the raw
			// bytes through — the cascade will fail this one row and mark it
			// unparsed with an error, keeping it visible and recoverable while
			// every other row still parses.
			body = raw
		}
		r.RawBody = body
		out = append(out, r)
	}
	return out, rows.Err()
}

// MarkParsed stamps an ingest_log row's parse outcome. A failed parse
// (status 'unparsed') consumes one automatic-retry attempt.
func (s *Store) MarkParsed(ingestID int64, status, tier, parseErr string) error {
	_, err := s.DB.Exec(
		`UPDATE ingest_log
		    SET parse_status=?, parse_tier=?, parse_error=?,
		        parse_attempts = CASE WHEN ?='unparsed' THEN parse_attempts+1 ELSE parse_attempts END
		  WHERE id=?`,
		status, nullable(tier), nullable(parseErr), status, ingestID)
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
	amountAED, err := s.amountAEDValue(m.AmountFils, currency)
	if err != nil {
		return 0, err
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
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, category_id, status,
		    confidence, fingerprint, source, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
		m.PostedAt.UTC().Format(time.RFC3339Nano), m.AmountFils, amountAED, currency, m.Direction,
		m.MerchantRaw, catID, status, 1.0, fp, now, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// TransferLeg is one side of a potential self-transfer, used to search for its
// counterpart.
type TransferLeg struct {
	TxID       int64
	AmountFils int64
	Currency   string
	Direction  string
	Last4      string
	PostedAt   time.Time
}

// transferLast4Compatible applies the last-4 heuristics for pairing two legs.
// A same-account opposite pair is a refund/reversal, never a transfer. When the
// own-accounts registry is configured (non-empty own set) and both last4s are
// known, both must be registered own accounts. A missing last4 (old rows, CSV
// imports) never blocks a match.
func transferLast4Compatible(a, b string, own map[string]bool) bool {
	if a == "" || b == "" {
		return true
	}
	if a == b {
		return false
	}
	if len(own) > 0 && (!own[a] || !own[b]) {
		return false
	}
	return true
}

// FindTransferMatch looks for the other leg of a self-transfer: same amount and
// currency, opposite direction, within `window` of the leg, still in a nettable
// status (needs_review / low_confidence / confirmed), and last4-compatible.
// Returns the closest-in-time hit. Ignored, archived and already-netted rows
// are never candidates.
func (s *Store) FindTransferMatch(leg TransferLeg, window time.Duration) (int64, bool, error) {
	own, err := s.OwnAccountLast4s()
	if err != nil {
		return 0, false, err
	}
	opp := "credit"
	if leg.Direction == "credit" {
		opp = "debit"
	}
	start := leg.PostedAt.Add(-window).UTC().Format(time.RFC3339Nano)
	end := leg.PostedAt.Add(window).UTC().Format(time.RFC3339Nano)
	postedStr := leg.PostedAt.UTC().Format(time.RFC3339Nano)

	rows, err := s.DB.Query(`
		SELECT id, COALESCE(last4,'') FROM transactions
		 WHERE id != ?
		   AND amount = ?
		   AND currency = ?
		   AND direction = ?
		   AND posted_at >= ?
		   AND posted_at <= ?
		   AND status IN ('needs_review','low_confidence','confirmed')
		 ORDER BY ABS(CAST((julianday(posted_at) - julianday(?)) * 86400 AS INTEGER))
	`, leg.TxID, leg.AmountFils, leg.Currency, opp, start, end, postedStr)
	if err != nil {
		return 0, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var last4 string
		if err := rows.Scan(&id, &last4); err != nil {
			return 0, false, err
		}
		if transferLast4Compatible(leg.Last4, last4, own) {
			return id, true, nil
		}
	}
	return 0, false, rows.Err()
}

// NetTransferPairs retroactively pairs and nets self-transfers across all
// nettable rows (needs_review / low_confidence / confirmed): same amount and
// currency, opposite directions, within `window`, last4-compatible (see
// transferLast4Compatible). Greedy nearest-in-time pairing; each leg is used at
// most once. Both legs of every pair get status='transfer'. Returns the number
// of transactions marked (2 per pair). User-initiated (sweep endpoint) — it is
// deliberately not run automatically on ingest or import.
func (s *Store) NetTransferPairs(window time.Duration) (int, error) {
	own, err := s.OwnAccountLast4s()
	if err != nil {
		return 0, err
	}
	type leg struct {
		id        int64
		amount    int64
		currency  string
		direction string
		last4     string
		postedAt  time.Time
	}
	rows, err := s.DB.Query(
		`SELECT id, amount, currency, direction, COALESCE(last4,''), posted_at
		   FROM transactions
		  WHERE status IN ('needs_review','low_confidence','confirmed')
		  ORDER BY posted_at, id`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var legs []leg
	for rows.Next() {
		var l leg
		var posted string
		if err := rows.Scan(&l.id, &l.amount, &l.currency, &l.direction, &l.last4, &posted); err != nil {
			return 0, err
		}
		t, err := time.Parse(time.RFC3339Nano, posted)
		if err != nil {
			continue // unparseable timestamp: skip the row, never fail the sweep
		}
		l.postedAt = t
		legs = append(legs, l)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	used := make(map[int64]bool)
	marked := 0
	for i := range legs {
		if legs[i].direction != "debit" || used[legs[i].id] {
			continue
		}
		best := -1
		var bestDelta time.Duration
		for j := range legs {
			if legs[j].direction != "credit" || used[legs[j].id] {
				continue
			}
			if legs[j].amount != legs[i].amount || legs[j].currency != legs[i].currency {
				continue
			}
			delta := legs[j].postedAt.Sub(legs[i].postedAt)
			if delta < 0 {
				delta = -delta
			}
			if delta > window {
				continue
			}
			if !transferLast4Compatible(legs[i].last4, legs[j].last4, own) {
				continue
			}
			if best == -1 || delta < bestDelta {
				best, bestDelta = j, delta
			}
		}
		if best == -1 {
			continue
		}
		used[legs[i].id], used[legs[best].id] = true, true
		if err := s.UpdateTransactionStatus(legs[i].id, "transfer"); err != nil {
			return marked, err
		}
		if err := s.UpdateTransactionStatus(legs[best].id, "transfer"); err != nil {
			return marked, err
		}
		marked += 2
	}
	return marked, nil
}
