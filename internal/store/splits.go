package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrSplitInvalid reports a split set the store refuses (bad line or sum
// mismatch); ErrSplitTxNotFound reports a missing parent transaction.
// ErrTxSplit reports an operation refused because the transaction currently
// has split lines (e.g. categorizing a split parent, whose category must stay
// NULL while its lines carry the truth — see UpdateTransactionCategory).
var (
	ErrSplitInvalid    = errors.New("invalid transaction splits")
	ErrSplitTxNotFound = errors.New("split parent transaction not found")
	ErrTxSplit         = errors.New("transaction is split")
)

// TransactionSplitRow is one line of a split transaction. AmountFils is in the
// PARENT transaction's currency minor units, always > 0; a full split set sums
// exactly to the parent amount (integer fils — the client puts any rounding
// remainder on its last line before calling the store).
type TransactionSplitRow struct {
	ID            int64
	TransactionID int64
	CategoryID    int64
	AmountFils    int64
	Note          string
}

// splitCategoryOK verifies one split line targets a category the money
// aggregates will actually count for the parent's direction: an existing,
// ACTIVE category whose kind is 'spending' (debit or credit parents — spend
// and refund) or 'income' (credit parents only). Anything else — missing,
// deactivated, excluded-kind, or an income-kind line on a debit parent —
// would pass the FK yet vanish from jars, envelopes, income and reports
// simultaneously: silently invisible fils, refused up front exactly like
// envelopeCategoryOK refuses non-envelope assignment targets.
func splitCategoryOK(q rowQuerier, parentDirection string, line int, categoryID int64) error {
	var kind string
	err := q.QueryRow(`SELECT kind FROM categories WHERE id=? AND is_active=1`, categoryID).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: line %d: category %d is not an active category", ErrSplitInvalid, line, categoryID)
	}
	if err != nil {
		return err
	}
	switch parentDirection {
	case "credit":
		if kind != "spending" && kind != "income" {
			return fmt.Errorf("%w: line %d: category %d must be a spending or income category", ErrSplitInvalid, line, categoryID)
		}
	default: // debit
		if kind != "spending" {
			return fmt.Errorf("%w: line %d: category %d must be a spending category", ErrSplitInvalid, line, categoryID)
		}
	}
	return nil
}

// ReplaceTransactionSplits replaces a transaction's entire split set in one
// SQL transaction. A non-empty set must sum exactly to the parent's amount and
// every line must pass splitCategoryOK; the parent's category_id and
// bucket_snapshot are cleared (split lines carry the categories) while its
// fingerprint, ingest provenance, refund and project links stay untouched. An
// empty set un-splits: all lines are deleted and the parent — categoryless,
// its spend no longer represented anywhere — returns to the review queue
// (status 'needs_review', matching ClearTransactionCategory) so it can never
// sit confirmed-but-invisible to every aggregate. Un-splitting a transaction
// that was never split is a no-op.
func (s *Store) ReplaceTransactionSplits(txID int64, splits []TransactionSplitRow) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var parentAmount int64
	var parentDirection string
	err = tx.QueryRow(`SELECT amount, direction FROM transactions WHERE id=?`, txID).Scan(&parentAmount, &parentDirection)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: id %d", ErrSplitTxNotFound, txID)
	}
	if err != nil {
		return err
	}

	var sum int64
	for i, sp := range splits {
		if sp.CategoryID <= 0 {
			return fmt.Errorf("%w: line %d needs a category", ErrSplitInvalid, i+1)
		}
		if sp.AmountFils <= 0 {
			return fmt.Errorf("%w: line %d amount must be > 0 fils", ErrSplitInvalid, i+1)
		}
		if err := splitCategoryOK(tx, parentDirection, i+1, sp.CategoryID); err != nil {
			return err
		}
		sum += sp.AmountFils
	}
	if len(splits) > 0 && sum != parentAmount {
		return fmt.Errorf("%w: splits sum %d != parent amount %d", ErrSplitInvalid, sum, parentAmount)
	}

	res, err := tx.Exec(`DELETE FROM transaction_splits WHERE transaction_id=?`, txID)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, sp := range splits {
		if _, err := tx.Exec(
			`INSERT INTO transaction_splits (transaction_id, category_id, amount_fils, note, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			txID, sp.CategoryID, sp.AmountFils, nullableStr(sp.Note), now,
		); err != nil {
			return err
		}
	}
	if len(splits) > 0 {
		// Parent goes categoryless while split; split lines are the truth.
		if _, err := tx.Exec(
			`UPDATE transactions SET category_id=NULL, bucket_snapshot=NULL, updated_at=? WHERE id=?`,
			now, txID,
		); err != nil {
			return err
		}
	} else if deleted, derr := res.RowsAffected(); derr == nil && deleted > 0 {
		// Un-split: the parent was split (category NULL) and now has no lines
		// either — back to the review queue, never confirmed-but-uncounted.
		if _, err := tx.Exec(
			`UPDATE transactions SET category_id=NULL, bucket_snapshot=NULL, status='needs_review', updated_at=? WHERE id=?`,
			now, txID,
		); err != nil {
			return err
		}
	} else {
		if derr != nil {
			return derr
		}
		if _, err := tx.Exec(`UPDATE transactions SET updated_at=? WHERE id=?`, now, txID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// splitAEDFils returns the SQL expression for one split line's AED value,
// scaled from its parent transaction by cumulative-floor allocation:
//
//	line_i = floor(cumInclusive_i × aed / amount) − floor(cumExclusive_i × aed / amount)
//
// The cumulative sums telescope, so a transaction's lines always sum to
// EXACTLY the parent's AED amount — the splits API's "remainder on the last
// line" invariant carried into AED space, foreign-currency parents included
// (naive per-line floor division loses up to n−1 fils per transaction).
// aedExpr is the parent-AED SQL the calling query already uses (projAmt, or
// the jar queries' COALESCE(t.amount_aed, 0)). Requires aliases sp
// (transaction_splits) and t (transactions); callers must guard t.amount > 0.
func splitAEDFils(aedExpr string) string {
	return `(((SELECT COALESCE(SUM(sp2.amount_fils),0) FROM transaction_splits sp2
	            WHERE sp2.transaction_id = sp.transaction_id AND sp2.id <= sp.id) * ` + aedExpr + `) / t.amount
	       - ((SELECT COALESCE(SUM(sp2.amount_fils),0) FROM transaction_splits sp2
	            WHERE sp2.transaction_id = sp.transaction_id AND sp2.id < sp.id) * ` + aedExpr + `) / t.amount)`
}

const splitColumns = `id, transaction_id, category_id, amount_fils, COALESCE(note,'')`

// SelectTransactionSplits lists one transaction's split lines, insertion order.
// Empty (nil) means the transaction is not split.
func (s *Store) SelectTransactionSplits(txID int64) ([]TransactionSplitRow, error) {
	rows, err := s.DB.Query(
		`SELECT `+splitColumns+` FROM transaction_splits WHERE transaction_id=? ORDER BY id`, txID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSplits(rows)
}

// SelectSplitsForTransactions fetches split lines for many transactions in one
// query (the list-payload decorator), keyed by transaction id. Transactions
// without splits are absent from the map.
func (s *Store) SelectSplitsForTransactions(txIDs []int64) (map[int64][]TransactionSplitRow, error) {
	out := make(map[int64][]TransactionSplitRow)
	if len(txIDs) == 0 {
		return out, nil
	}
	ph := make([]string, len(txIDs))
	args := make([]any, len(txIDs))
	for i, id := range txIDs {
		ph[i] = "?"
		args[i] = id
	}
	rows, err := s.DB.Query(
		`SELECT `+splitColumns+` FROM transaction_splits
		  WHERE transaction_id IN (`+strings.Join(ph, ",")+`) ORDER BY transaction_id, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all, err := scanSplits(rows)
	if err != nil {
		return nil, err
	}
	for _, sp := range all {
		out[sp.TransactionID] = append(out[sp.TransactionID], sp)
	}
	return out, nil
}

func scanSplits(rows *sql.Rows) ([]TransactionSplitRow, error) {
	var out []TransactionSplitRow
	for rows.Next() {
		var sp TransactionSplitRow
		if err := rows.Scan(&sp.ID, &sp.TransactionID, &sp.CategoryID, &sp.AmountFils, &sp.Note); err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}
