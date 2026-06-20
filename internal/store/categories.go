package store

import (
	"database/sql"
	"time"
)

// CategoryRow represents a row in the categories table.
type CategoryRow struct {
	ID       int64
	Name     string
	Kind     string // "spending" | "income" | "excluded"
	Bucket   string // "need" | "want" | "saving"; empty when kind != "spending"
	IsActive bool
}

// RuleRow represents a row in the rules table.
type RuleRow struct {
	ID         int64
	MatchType  string // "contains" | "exact" | "regex"
	Pattern    string
	CategoryID int64
	Priority   int
	Source     string // "manual" | "ai_confirmed"
	IsActive   bool
}

// ReviewItem is a flattened transaction row returned for manual review.
type ReviewItem struct {
	ID           int64
	PostedAt     string
	AmountFils   int64
	Currency     string
	Direction    string
	MerchantRaw  string
	Status       string
	Confidence   float64
	Source       string
	CategoryID   *int64 // nil when uncategorized
	CategoryName string // "" when uncategorized
	Bucket       string // "" when uncategorized or category has no bucket
}

// nullableStr maps an empty string to SQL NULL.
func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// seedCategories is the standard 50/30/20 default category set.
var seedCategories = []CategoryRow{
	// Spending / Need
	{Name: "Rent", Kind: "spending", Bucket: "need"},
	{Name: "Utilities", Kind: "spending", Bucket: "need"},
	{Name: "Groceries", Kind: "spending", Bucket: "need"},
	{Name: "Transport", Kind: "spending", Bucket: "need"},
	{Name: "Healthcare", Kind: "spending", Bucket: "need"},
	{Name: "Insurance", Kind: "spending", Bucket: "need"},
	// Spending / Want
	{Name: "Dining", Kind: "spending", Bucket: "want"},
	{Name: "Entertainment", Kind: "spending", Bucket: "want"},
	{Name: "Shopping", Kind: "spending", Bucket: "want"},
	{Name: "Travel", Kind: "spending", Bucket: "want"},
	{Name: "Subscriptions", Kind: "spending", Bucket: "want"},
	// Spending / Saving
	{Name: "Savings", Kind: "spending", Bucket: "saving"},
	{Name: "Investments", Kind: "spending", Bucket: "saving"},
	{Name: "Debt Repayment", Kind: "spending", Bucket: "saving"},
	// Income (bucket = NULL)
	{Name: "Salary", Kind: "income"},
	{Name: "Freelance", Kind: "income"},
	// Excluded (bucket = NULL)
	{Name: "Transfers", Kind: "excluded"},
	{Name: "Reimbursements", Kind: "excluded"},
}

// SeedDefaultCategories writes the standard 50/30/20 category set idempotently
// (INSERT OR IGNORE on name).
func (s *Store) SeedDefaultCategories() error {
	for _, c := range seedCategories {
		_, err := s.DB.Exec(
			`INSERT OR IGNORE INTO categories (name, kind, bucket, is_active) VALUES (?, ?, ?, 1)`,
			c.Name, c.Kind, nullableStr(c.Bucket),
		)
		if err != nil {
			return err
		}
	}
	return nil
}

// InsertCategory writes one category and returns its new row ID.
func (s *Store) InsertCategory(c CategoryRow) (int64, error) {
	res, err := s.DB.Exec(
		`INSERT INTO categories (name, kind, bucket, is_active) VALUES (?, ?, ?, ?)`,
		c.Name, c.Kind, nullableStr(c.Bucket), boolToInt(c.IsActive),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// SelectCategories returns all active categories ordered by kind then name.
func (s *Store) SelectCategories() ([]CategoryRow, error) {
	rows, err := s.DB.Query(
		`SELECT id, name, kind, COALESCE(bucket,''), is_active
		 FROM categories WHERE is_active=1
		 ORDER BY kind, name`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CategoryRow
	for rows.Next() {
		var c CategoryRow
		var active int
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Bucket, &active); err != nil {
			return nil, err
		}
		c.IsActive = active == 1
		out = append(out, c)
	}
	return out, rows.Err()
}

// InsertRule writes a new categorization rule.
func (s *Store) InsertRule(r RuleRow) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`INSERT INTO rules (match_type, pattern, category_id, priority, source, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		r.MatchType, r.Pattern, r.CategoryID, r.Priority, r.Source, now,
	)
	return err
}

// SelectRules returns all rules ordered by priority ascending (lower = higher priority).
func (s *Store) SelectRules() ([]RuleRow, error) {
	return scanRules(s.DB.Query(
		`SELECT id, match_type, pattern, category_id, priority, source, is_active
		 FROM rules ORDER BY priority ASC`,
	))
}

// SelectActiveRules returns only enabled rules, priority ascending — for the categorizer.
func (s *Store) SelectActiveRules() ([]RuleRow, error) {
	return scanRules(s.DB.Query(
		`SELECT id, match_type, pattern, category_id, priority, source, is_active
		 FROM rules WHERE is_active=1 ORDER BY priority ASC`,
	))
}

func scanRules(rows *sql.Rows, qerr error) ([]RuleRow, error) {
	if qerr != nil {
		return nil, qerr
	}
	defer rows.Close()
	var out []RuleRow
	for rows.Next() {
		var r RuleRow
		var active int
		if err := rows.Scan(&r.ID, &r.MatchType, &r.Pattern, &r.CategoryID, &r.Priority, &r.Source, &active); err != nil {
			return nil, err
		}
		r.IsActive = active == 1
		out = append(out, r)
	}
	return out, rows.Err()
}

// SetRuleActive enables/disables a rule.
func (s *Store) SetRuleActive(id int64, active bool) error {
	_, err := s.DB.Exec(`UPDATE rules SET is_active=? WHERE id=?`, boolToInt(active), id)
	return err
}

// UpdateTransactionCategory sets category_id and status on one transaction.
func (s *Store) UpdateTransactionCategory(txID, categoryID int64, status string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`UPDATE transactions SET category_id=?, status=?, updated_at=? WHERE id=?`,
		categoryID, status, now, txID,
	)
	return err
}

// UpdateTransactionStatus sets only the status on one transaction.
func (s *Store) UpdateTransactionStatus(txID int64, status string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.DB.Exec(
		`UPDATE transactions SET status=?, updated_at=? WHERE id=?`,
		status, now, txID,
	)
	return err
}

// SelectNeedsReview returns transactions with status='needs_review', newest first.
func (s *Store) SelectNeedsReview() ([]ReviewItem, error) {
	rows, err := s.DB.Query(
		`SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
		        COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
		        t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,'')
		   FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
		  WHERE t.status='needs_review' ORDER BY t.posted_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}

// SelectTransactions returns transactions matching optional status and date filters.
// Empty status matches all. from/to are RFC3339 or date strings (SQLite text compare).
func (s *Store) SelectTransactions(status, from, to string) ([]ReviewItem, error) {
	q := `SELECT t.id, t.posted_at, t.amount, t.currency, t.direction,
	             COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	             t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,'')
	      FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
	      WHERE 1=1`
	var args []any
	if status != "" {
		q += " AND t.status=?"
		args = append(args, status)
	} else {
		// Archived rows are soft-deleted: hidden from the default list, reachable
		// only by explicitly asking for status='archived'.
		q += " AND t.status!='archived'"
	}
	if from != "" {
		q += " AND t.posted_at >= ?"
		args = append(args, from)
	}
	if to != "" {
		q += " AND t.posted_at <= ?"
		args = append(args, to)
	}
	q += " ORDER BY t.posted_at DESC"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}

func scanReviewItems(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]ReviewItem, error) {
	var out []ReviewItem
	for rows.Next() {
		var r ReviewItem
		var catID sql.NullInt64
		if err := rows.Scan(
			&r.ID, &r.PostedAt, &r.AmountFils, &r.Currency, &r.Direction,
			&r.MerchantRaw, &r.Status, &r.Confidence, &r.Source,
			&catID, &r.CategoryName, &r.Bucket,
		); err != nil {
			return nil, err
		}
		if catID.Valid {
			id := catID.Int64
			r.CategoryID = &id
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteCategory hard-deletes a category row. Callers MUST verify the category
// is unused (see CategoryUsage) first — foreign_keys=ON would otherwise reject
// the delete if any transaction or rule still references it.
func (s *Store) DeleteCategory(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM categories WHERE id=?`, id)
	return err
}

// CategoryUsage returns how many transactions and rules reference a category.
// Used to enforce block-if-in-use deletes.
func (s *Store) CategoryUsage(id int64) (txns int, rules int, err error) {
	if err = s.DB.QueryRow(`SELECT count(*) FROM transactions WHERE category_id=?`, id).Scan(&txns); err != nil {
		return 0, 0, err
	}
	if err = s.DB.QueryRow(`SELECT count(*) FROM rules WHERE category_id=?`, id).Scan(&rules); err != nil {
		return 0, 0, err
	}
	return txns, rules, nil
}

// UpdateCategory overwrites name/kind/bucket for one category.
func (s *Store) UpdateCategory(c CategoryRow) error {
	_, err := s.DB.Exec(
		`UPDATE categories SET name=?, kind=?, bucket=? WHERE id=?`,
		c.Name, c.Kind, nullableStr(c.Bucket), c.ID,
	)
	return err
}

// SnapshotBucketForCategory stamps bucket_snapshot onto every transaction of a
// category (used by the "apply to past" action when freeze_history is on).
func (s *Store) SnapshotBucketForCategory(categoryID int64, bucket string) error {
	_, err := s.DB.Exec(
		`UPDATE transactions SET bucket_snapshot=? WHERE category_id=?`,
		nullableStr(bucket), categoryID,
	)
	return err
}

// ClearAllCategorization moves every transaction back to needs_review and clears
// its category and frozen bucket snapshot. Learned rules are left intact, so
// re-categorizing known merchants stays fast. Returns the number of rows affected.
func (s *Store) ClearAllCategorization() (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`UPDATE transactions
		    SET category_id=NULL, bucket_snapshot=NULL, status='needs_review', updated_at=?`,
		now,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DeleteRule removes one rule by id.
func (s *Store) DeleteRule(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM rules WHERE id=?`, id)
	return err
}
