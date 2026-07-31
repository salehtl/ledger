package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// CategoryRow represents a row in the categories table.
type CategoryRow struct {
	ID       int64
	Name     string
	Kind     string // "spending" | "income" | "excluded"
	Bucket   string // "need" | "want" | "saving"; empty when kind != "spending"
	IsActive bool
	Color    string // palette name (see lib/paletteColor.ts); "" = never chosen, resolves to neutral
}

// RuleRow represents a row in the rules table. DisplayName, when set, is the
// merchant clean-name shown for every transaction the rule matches.
type RuleRow struct {
	ID          int64
	MatchType   string // "contains" | "exact" | "regex"
	Pattern     string
	CategoryID  int64
	Priority    int
	Source      string // "manual" | "ai_confirmed"
	IsActive    bool
	DisplayName string // "" = no clean-name
}

// ReviewItem is a flattened transaction row returned for manual review.
type ReviewItem struct {
	ID             int64
	PostedAt       string
	AmountFils     int64
	AmountAedFils  *int64 // AED snapshot; nil when the currency has no rate yet
	Currency       string
	Direction      string
	MerchantRaw    string
	Status         string
	Confidence     float64
	Source         string
	CategoryID     *int64 // nil when uncategorized
	CategoryName   string // "" when uncategorized
	Bucket         string // "" when uncategorized or category has no bucket
	Kind           string // category kind: "spending" | "income" | "excluded" | "" (uncategorized)
	BucketSnapshot string // frozen bucket at categorization time; "" when unset
	RefundOfID     *int64 // set when this credit is a linked refund of another transaction
	ProjectID      *int64 // set when this transaction is assigned to a life-project
	Last4          string // account last-4 from the bank email; "" when unknown
	AccountName    string // registered account name matching Last4; "" when unregistered
	Note           string // user memo, distinct from the parsed description; "" when unset
	DisplayName    string // merchant clean-name from the highest-priority matching rule; "" when none
}

// reviewItemColumns is the shared SELECT list every scanReviewItems query uses;
// the two lists must stay in lockstep. The account name is a scalar subquery so
// a duplicated last4 in accounts can never fan a transaction into extra rows.
// The display-name subquery mirrors the Go categorizer's case-insensitive
// exact/contains matching (categorize.ruleMatches); regex rules cannot resolve
// a display name here (SQLite has no regex built in) — the rename flow always
// writes contains/exact rules, so that path never carries a clean-name anyway.
const reviewItemColumns = `t.id, t.posted_at, t.amount, t.amount_aed, t.currency, t.direction,
	COALESCE(t.merchant_raw,''), t.status, COALESCE(t.confidence,0), COALESCE(t.source,''),
	t.category_id, COALESCE(c.name,''), COALESCE(c.bucket,''),
	COALESCE(c.kind,''), COALESCE(t.bucket_snapshot,''), t.refund_of_id, t.project_id,
	COALESCE(t.last4,''),
	COALESCE((SELECT a.name FROM accounts a WHERE a.last4 = t.last4 AND a.is_active=1 LIMIT 1),''),
	COALESCE(t.note,''),
	COALESCE((SELECT r.display_name FROM rules r
	   WHERE r.is_active=1 AND r.display_name IS NOT NULL AND r.display_name != '' AND r.pattern != ''
	     AND ((r.match_type='exact' AND lower(r.pattern) = lower(t.merchant_raw))
	       OR (r.match_type='contains' AND instr(lower(t.merchant_raw), lower(r.pattern)) > 0))
	   ORDER BY r.priority ASC, r.id ASC LIMIT 1),'')`

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

// SeedDefaultCategories bootstraps the standard 50/30/20 category set into a
// fresh database. It is a first-run bootstrap, not an invariant: once the table
// holds any category the seed never runs again, because Open calls this on
// every start and INSERT OR IGNORE would otherwise resurrect a default the user
// deliberately deleted (delete succeeds, category is back after a restart).
//
// Two boundary consequences follow from the existing-count gate: (a) if the
// user deletes every category, the table is empty again, so the next restart
// treats it as a fresh database and re-seeds the full default set; (b) if a
// future release adds new entries to seedCategories, an existing DB (which
// already has existing > 0) never receives them — only genuinely new
// databases see the expanded set.
func (s *Store) SeedDefaultCategories() error {
	var existing int
	if err := s.DB.QueryRow(`SELECT count(*) FROM categories`).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
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
		`SELECT id, name, kind, COALESCE(bucket,''), is_active, COALESCE(color,'')
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
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Bucket, &active, &c.Color); err != nil {
			return nil, err
		}
		c.IsActive = active == 1
		out = append(out, c)
	}
	return out, rows.Err()
}

// Category returns one category row by id, active or not (unlike
// SelectCategories, which lists only active ones). sql.ErrNoRows if the id
// doesn't exist.
func (s *Store) Category(id int64) (CategoryRow, error) {
	var c CategoryRow
	var active int
	err := s.DB.QueryRow(
		`SELECT id, name, kind, COALESCE(bucket,''), is_active, COALESCE(color,'')
		 FROM categories WHERE id=?`, id,
	).Scan(&c.ID, &c.Name, &c.Kind, &c.Bucket, &active, &c.Color)
	if err != nil {
		return CategoryRow{}, err
	}
	c.IsActive = active == 1
	return c, nil
}

// paletteNames mirrors frontend/src/lib/paletteColor.ts's PALETTE_NAMES,
// base names first then the -deep variants in the same order. Order is
// load-bearing: SeedCategoryColor indexes into this slice by id, so a
// different order here than the frontend's array hands out different
// colours than the frontend would predict for the same id.
var paletteNames = []string{
	"azure", "amber", "lilac", "sage", "rose", "slate",
	"ochre", "moss", "teal", "sky", "indigo", "orchid",
	"azure-deep", "amber-deep", "lilac-deep", "sage-deep", "rose-deep", "slate-deep",
	"ochre-deep", "moss-deep", "teal-deep", "sky-deep", "indigo-deep", "orchid-deep",
}

// SeedCategoryColor picks a starting colour for a category that has none.
//
// 7 is coprime to 24, so id -> index is a bijection mod 24: ids 1..24 get
// distinct colours, and consecutive ids land far apart on the hue wheel
// rather than side by side (a plain "% 24" would not have this property for
// most multipliers, and definitely not for one that shares a factor with 24
// — don't "simplify" this to that). It depends only on the row's own id, so
// adding or deleting a category never reshuffles anyone else's colour. Ids
// above 24 wrap and may collide with an existing assignment; that's
// acceptable — colour uniqueness across categories is a non-goal.
//
// The extra +n, %n normalizes the index into [0, n): Go's % preserves the
// dividend's sign, so a negative id would otherwise compute a negative index
// and panic. No caller can produce one today — InsertCategory never lets a
// caller supply an id, and SQLite autoincrements category ids from 1 — so
// this is belt-and-braces against a future or hand-rolled caller, not a live
// path.
func SeedCategoryColor(id int64) string {
	n := int64(len(paletteNames))
	return paletteNames[((id*7)%n+n)%n]
}

// BackfillCategoryColors assigns SeedCategoryColor to every category row
// that doesn't have one yet (color IS NULL or the empty string). Safe to
// call repeatedly: once a row has a colour it is never touched again. Open
// calls this once after the column is guaranteed to exist (schema.sql on a
// fresh database, the addColumnIfMissing migration on an older one) and
// after SeedDefaultCategories, so it covers both a pre-color database's
// existing rows and the default set a brand-new database just seeded.
func (s *Store) BackfillCategoryColors() error {
	rows, err := s.DB.Query(`SELECT id FROM categories WHERE color IS NULL OR color=''`)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	for _, id := range ids {
		if _, err := s.DB.Exec(`UPDATE categories SET color=? WHERE id=?`, SeedCategoryColor(id), id); err != nil {
			return err
		}
	}
	return nil
}

// InsertRule writes a new categorization rule and returns its ID.
func (s *Store) InsertRule(r RuleRow) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := s.DB.Exec(
		`INSERT INTO rules (match_type, pattern, category_id, priority, source, display_name, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		r.MatchType, r.Pattern, r.CategoryID, r.Priority, r.Source, nullableStr(r.DisplayName), now,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// SetRuleDisplayName sets (or clears, when name is empty) the merchant
// clean-name carried by one rule.
func (s *Store) SetRuleDisplayName(id int64, name string) error {
	_, err := s.DB.Exec(`UPDATE rules SET display_name=? WHERE id=?`, nullableStr(name), id)
	return err
}

// SelectRules returns all rules ordered by priority ascending (lower = higher priority).
func (s *Store) SelectRules() ([]RuleRow, error) {
	return scanRules(s.DB.Query(
		`SELECT id, match_type, pattern, category_id, priority, source, is_active, COALESCE(display_name,'')
		 FROM rules ORDER BY priority ASC`,
	))
}

// SelectActiveRules returns only enabled rules, priority ascending — for the categorizer.
func (s *Store) SelectActiveRules() ([]RuleRow, error) {
	return scanRules(s.DB.Query(
		`SELECT id, match_type, pattern, category_id, priority, source, is_active, COALESCE(display_name,'')
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
		if err := rows.Scan(&r.ID, &r.MatchType, &r.Pattern, &r.CategoryID, &r.Priority, &r.Source, &active, &r.DisplayName); err != nil {
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
// A split parent is refused (ErrTxSplit): its category must stay NULL while
// the split lines carry the categories — a categorized split parent would
// double-count on any aggregate that lacks the defensive NOT EXISTS guard
// (its whole amount via the category arm, its lines again via the split arm).
// Remove the splits first, then recategorize.
func (s *Store) UpdateTransactionCategory(txID, categoryID int64, status string) error {
	var one int
	err := s.DB.QueryRow(
		`SELECT 1 FROM transaction_splits WHERE transaction_id=? LIMIT 1`, txID,
	).Scan(&one)
	if err == nil {
		return fmt.Errorf("%w: transaction %d has split lines; remove the splits first", ErrTxSplit, txID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.DB.Exec(
		`UPDATE transactions SET category_id=?, status=?, updated_at=? WHERE id=?`,
		categoryID, status, now, txID,
	)
	return err
}

// ClearTransactionCategory decategorizes one transaction: category and frozen
// bucket snapshot are cleared and it returns to the review queue. Orthogonal
// links (project, refund) are left intact — unlike the bulk
// ClearAllCategorization reset, this is a routine single-row correction.
// A split parent is refused (ErrTxSplit), mirroring UpdateTransactionCategory:
// its category is already NULL, so "decategorizing" it would only flip status
// to needs_review with the split lines still attached — the whole amount would
// silently drop out of every aggregate (split-line sums require the parent
// confirmed) and the row would jam (re-categorizing 409s while split). The
// sanctioned way out of the split state is PUT splits with an empty array.
func (s *Store) ClearTransactionCategory(txID int64) error {
	var one int
	err := s.DB.QueryRow(
		`SELECT 1 FROM transaction_splits WHERE transaction_id=? LIMIT 1`, txID,
	).Scan(&one)
	if err == nil {
		return fmt.Errorf("%w: transaction %d has split lines; remove the splits first", ErrTxSplit, txID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.DB.Exec(
		`UPDATE transactions SET category_id=NULL, bucket_snapshot=NULL, status='needs_review', updated_at=? WHERE id=?`,
		now, txID,
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

// SelectTransactions returns transactions matching optional status, date, and
// free-text filters. Empty status matches all. from/to are RFC3339 or date
// strings (SQLite text compare). search does a case-insensitive contains-match
// on merchant_raw; LIKE wildcards in the term are escaped so they match
// literally.
func (s *Store) SelectTransactions(status, from, to, search string) ([]ReviewItem, error) {
	q := `SELECT ` + reviewItemColumns + `
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
	if search != "" {
		q += ` AND t.merchant_raw LIKE ? ESCAPE '\'`
		args = append(args, "%"+escapeLike(search)+"%")
	}
	q += " ORDER BY t.posted_at DESC"
	rows, err := s.DB.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanReviewItems(rows)
}

// escapeLike backslash-escapes LIKE metacharacters so user text matches literally.
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
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
		var aed sql.NullInt64
		var refundOf sql.NullInt64
		var projectID sql.NullInt64
		if err := rows.Scan(
			&r.ID, &r.PostedAt, &r.AmountFils, &aed, &r.Currency, &r.Direction,
			&r.MerchantRaw, &r.Status, &r.Confidence, &r.Source,
			&catID, &r.CategoryName, &r.Bucket,
			&r.Kind, &r.BucketSnapshot, &refundOf, &projectID,
			&r.Last4, &r.AccountName, &r.Note, &r.DisplayName,
		); err != nil {
			return nil, err
		}
		if aed.Valid {
			v := aed.Int64
			r.AmountAedFils = &v
		}
		if catID.Valid {
			id := catID.Int64
			r.CategoryID = &id
		}
		if refundOf.Valid {
			id := refundOf.Int64
			r.RefundOfID = &id
		}
		if projectID.Valid {
			id := projectID.Int64
			r.ProjectID = &id
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

// CategoryUsage counts everything a delete would take with the category. Used
// to enforce block-if-in-use deletes.
type CategoryUsage struct {
	Transactions int
	Rules        int
	Assignments  int
	Targets      int
}

// InUse reports whether anything references the category, i.e. whether the
// delete guard must refuse. One place decides, so the DELETE handler, the
// usage endpoint and the UI can never drift into disagreeing about it.
func (u CategoryUsage) InUse() bool {
	return u.Transactions > 0 || u.Rules > 0 || u.Assignments > 0 || u.Targets > 0
}

// CategoryUsage returns what references a category. Split lines count into
// Transactions: transaction_splits has a plain FK to categories (no cascade),
// so a category referenced by a split must block deletion the same way a
// directly categorized transaction does. Envelope assignments count because
// they are ON DELETE CASCADE — deleting a category with assigned months would
// silently rewrite historical budget state (past assigned totals and RTA);
// zero-amount assignment rows carry no money and don't block.
//
// Targets count for the same cascade reason. A target is budgeting intent the
// user typed (an envelope depth, a save-by-date goal), and ON DELETE CASCADE
// discards it with no warning and no way back — the delete toast's Undo
// re-creates the category, not the state that cascaded out from under it.
// Only scheduled_transactions stays silent: it detaches cleanly (SET NULL).
func (s *Store) CategoryUsage(id int64) (CategoryUsage, error) {
	var u CategoryUsage
	if err := s.DB.QueryRow(
		`SELECT (SELECT count(*) FROM transactions WHERE category_id=?)
		      + (SELECT count(*) FROM transaction_splits WHERE category_id=?)`,
		id, id).Scan(&u.Transactions); err != nil {
		return CategoryUsage{}, err
	}
	if err := s.DB.QueryRow(`SELECT count(*) FROM rules WHERE category_id=?`, id).Scan(&u.Rules); err != nil {
		return CategoryUsage{}, err
	}
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE category_id=? AND assigned_fils != 0`,
		id).Scan(&u.Assignments); err != nil {
		return CategoryUsage{}, err
	}
	if err := s.DB.QueryRow(
		`SELECT count(*) FROM category_targets WHERE category_id=?`, id).Scan(&u.Targets); err != nil {
		return CategoryUsage{}, err
	}
	return u, nil
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
// re-categorizing known merchants stays fast. Split lines of the reset rows are
// deleted too — leaving them would strand needs_review parents that 409 on
// every categorize attempt ("transaction is split") until each one is manually
// un-split. Returns the number of transaction rows affected.
func (s *Store) ClearAllCategorization() (int64, error) {
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`DELETE FROM transaction_splits
		  WHERE transaction_id IN (SELECT id FROM transactions WHERE status!='archived')`,
	); err != nil {
		return 0, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := tx.Exec(
		`UPDATE transactions
		    SET category_id=NULL, bucket_snapshot=NULL, refund_of_id=NULL, status='needs_review', updated_at=?
		  WHERE status!='archived'`,
		now,
	)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	return n, tx.Commit()
}

// DeleteRule removes one rule by id.
func (s *Store) DeleteRule(id int64) error {
	_, err := s.DB.Exec(`DELETE FROM rules WHERE id=?`, id)
	return err
}
