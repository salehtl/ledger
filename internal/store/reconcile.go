// Reconciliation queries (v3 balances piece): the expected-balance math behind
// the 30-second check-in, the unparsed-email candidates a discrepancy points
// at, and the balance-adjustment transaction writer. All money is int64 AED
// fils.
package store

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// balanceTxnStatuses are the statuses that move real money through an account:
// confirmed and still-unreviewed rows both came from the bank, and a transfer
// changes an individual account's balance even though it nets out globally.
// Ignored and archived rows never touch a balance.
const balanceTxnStatuses = `('confirmed','needs_review','transfer')`

// AccountActivitySince returns the net signed activity (credit − debit, AED
// fils), transaction count, and count of unconverted rows for one account
// since an RFC3339 anchor ("" = all history). The window is DAY-granular:
// bank-parsed posted_at is a bare date (midnight UTC) while a check-in anchor
// is a wall-clock instant, so an instant compare would permanently exclude
// every same-day transaction (dated 00:00, "before" a 16:37 anchor) and
// double-count next-day-dated ones across consecutive check-ins. The anchor
// is therefore treated as stating the balance as of the END of its calendar
// day — only transactions dated on LATER days count.
//
// Amounts follow the app-wide AED convention (jarAED): a foreign-currency row
// with no FX rate yet contributes NOTHING to net — never its raw foreign
// minor units, which would mix currencies into an AED balance. Such rows
// still count in `count` and are reported in `unconverted` so a check-in can
// explain the resulting delta instead of silently mis-summing; they backfill
// once a rate is added, exactly like the jars. Transactions are attributed to
// the account by last4 — an account without a registered last4 has no
// attributable activity and returns all zeros.
func (s *Store) AccountActivitySince(accountID int64, since string) (net int64, count, unconverted int, err error) {
	acct, ok, err := s.SelectAccount(accountID)
	if err != nil {
		return 0, 0, 0, err
	}
	if !ok {
		return 0, 0, 0, fmt.Errorf("%w: account %d not found", ErrBalanceInvalid, accountID)
	}
	if acct.Last4 == "" {
		return 0, 0, 0, nil
	}
	q := `SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN COALESCE(amount_aed, 0)
	                                          ELSE -COALESCE(amount_aed, 0) END),0), COUNT(*),
	             COUNT(CASE WHEN amount_aed IS NULL THEN 1 END)
	        FROM transactions WHERE last4=? AND status IN ` + balanceTxnStatuses
	args := []any{acct.Last4}
	if since != "" {
		q += ` AND substr(posted_at,1,10) > substr(?,1,10)`
		args = append(args, since)
	}
	err = s.DB.QueryRow(q, args...).Scan(&net, &count, &unconverted)
	return net, count, unconverted, err
}

// UnparsedIngestRow is one retained email that produced no transaction — a
// candidate cause when a balance check-in disagrees with the ledger.
type UnparsedIngestRow struct {
	ID         int64
	ReceivedAt string
	FromAddr   string
	Subject    string
	ParseError string
}

// UnparsedIngestSince lists ingest_log rows still unparsed that arrived after
// an RFC3339 instant (exclusive; "" = all history), newest first, capped at
// limit (<=0 defaults to 20). These are the "nothing silently dropped"
// receipts a reconciliation discrepancy can cite.
func (s *Store) UnparsedIngestSince(since string, limit int) ([]UnparsedIngestRow, error) {
	if limit <= 0 {
		limit = 20
	}
	q := `SELECT id, COALESCE(NULLIF(received_at,''), created_at), COALESCE(from_addr,''),
	             COALESCE(subject,''), COALESCE(parse_error,'')
	        FROM ingest_log WHERE parse_status='unparsed'`
	var args []any
	if since != "" {
		q += ` AND COALESCE(NULLIF(received_at,''), created_at) > ?`
		args = append(args, since)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []UnparsedIngestRow
	for rows.Next() {
		var r UnparsedIngestRow
		if err := rows.Scan(&r.ID, &r.ReceivedAt, &r.FromAddr, &r.Subject, &r.ParseError); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// InsertAdjustmentTransaction writes the reconciliation adjustment: a
// confirmed, uncategorized manual transaction that brings the books in line
// with a checked-in balance. deltaFils is stated − expected: positive means
// the bank shows more than the ledger (a credit), negative less (a debit).
//
// The row is backdated to one second BEFORE the account's latest balance
// anchor so the computed balance (anchor + activity since anchor) is not
// double-adjusted — the anchor already embodies the stated truth; the
// adjustment only corrects history. Uncategorized-but-confirmed keeps it out
// of jar/envelope math (both join categories) while it still counts in
// account-balance and net-worth series.
func (s *Store) InsertAdjustmentTransaction(accountID, deltaFils int64, note string) (int64, error) {
	if deltaFils == 0 {
		return 0, fmt.Errorf("%w: delta_fils must be non-zero", ErrBalanceInvalid)
	}
	acct, ok, err := s.SelectAccount(accountID)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, fmt.Errorf("%w: account %d not found", ErrBalanceInvalid, accountID)
	}
	direction := "credit"
	amount := deltaFils
	if deltaFils < 0 {
		direction = "debit"
		amount = -deltaFils
	}
	postedAt := time.Unix(s.now(), 0).UTC()
	if anchor, hasAnchor, aerr := s.LatestAccountBalance(accountID); aerr != nil {
		return 0, aerr
	} else if hasAnchor {
		if t, perr := time.Parse(time.RFC3339, anchor.AsOf); perr == nil {
			postedAt = t.Add(-time.Second)
		}
	}
	salt := make([]byte, 8)
	if _, err := rand.Read(salt); err != nil {
		return 0, err
	}
	fp := fmt.Sprintf("adjust|%d|%d|%s|%s", accountID, deltaFils,
		postedAt.Format(time.RFC3339), hex.EncodeToString(salt))
	now := isoNow(s)
	res, err := s.DB.Exec(
		`INSERT INTO transactions
		   (posted_at, amount, amount_aed, currency, direction, merchant_raw, description, last4,
		    category_id, status, confidence, fingerprint, source, note, created_at, updated_at)
		 VALUES (?, ?, ?, 'AED', ?, 'Balance adjustment', 'Reconciliation balance adjustment', ?,
		         NULL, 'confirmed', 1.0, ?, 'manual', ?, ?, ?)`,
		postedAt.Format(time.RFC3339), amount, amount, direction, nullableStr(acct.Last4),
		fp, nullableStr(note), now, now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}
