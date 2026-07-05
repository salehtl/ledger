// Refund linking: a credit can point at the debit it refunds via
// transactions.refund_of_id. Linking copies the purchase's category (and
// frozen bucket snapshot) onto the credit and confirms it, so the budget and
// insights rollups net it against the purchase's category instead of treating
// it as income. Partial refunds are allowed; several credits may link the
// same purchase (installment refunds).
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"
)

var (
	// ErrRefundNotFound: the credit or target transaction does not exist
	// (or, for unlink, the transaction has no link to remove).
	ErrRefundNotFound = errors.New("refund: transaction not found")
	// ErrRefundBadLink: the pair is not a linkable credit→purchase combination.
	ErrRefundBadLink = errors.New("refund: invalid link")
)

// LinkRefund marks creditID as a refund of debitID. The credit must be a
// non-archived credit; the target must be a confirmed, categorized debit.
func (s *Store) LinkRefund(creditID, debitID int64) error {
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var creditDir, creditStatus string
	err = tx.QueryRow(`SELECT direction, status FROM transactions WHERE id=?`, creditID).
		Scan(&creditDir, &creditStatus)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: credit %d", ErrRefundNotFound, creditID)
	}
	if err != nil {
		return err
	}
	if creditDir != "credit" {
		return fmt.Errorf("%w: transaction %d is not a credit", ErrRefundBadLink, creditID)
	}
	if creditStatus == "archived" {
		return fmt.Errorf("%w: credit %d is archived", ErrRefundBadLink, creditID)
	}

	var debitDir, debitStatus string
	var catID sql.NullInt64
	var snap sql.NullString
	err = tx.QueryRow(`SELECT direction, status, category_id, bucket_snapshot FROM transactions WHERE id=?`, debitID).
		Scan(&debitDir, &debitStatus, &catID, &snap)
	if err == sql.ErrNoRows {
		return fmt.Errorf("%w: purchase %d", ErrRefundNotFound, debitID)
	}
	if err != nil {
		return err
	}
	if debitDir != "debit" {
		return fmt.Errorf("%w: target %d is not a debit", ErrRefundBadLink, debitID)
	}
	if debitStatus != "confirmed" {
		return fmt.Errorf("%w: purchase %d is not confirmed", ErrRefundBadLink, debitID)
	}
	if !catID.Valid {
		return fmt.Errorf("%w: purchase %d has no category", ErrRefundBadLink, debitID)
	}

	var snapVal any
	if snap.Valid && snap.String != "" {
		snapVal = snap.String
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(
		`UPDATE transactions
		    SET refund_of_id=?, category_id=?, bucket_snapshot=?, status='confirmed', updated_at=?
		  WHERE id=?`,
		debitID, catID.Int64, snapVal, now, creditID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

// UnlinkRefund reverses LinkRefund: the credit loses its link and inherited
// category and returns to the review queue.
func (s *Store) UnlinkRefund(txID int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`UPDATE transactions
		    SET refund_of_id=NULL, category_id=NULL, bucket_snapshot=NULL, status='needs_review', updated_at=?
		  WHERE id=? AND refund_of_id IS NOT NULL`,
		now, txID,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: transaction %d is not a linked refund", ErrRefundNotFound, txID)
	}
	return nil
}
