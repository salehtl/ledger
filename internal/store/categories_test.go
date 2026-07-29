package store

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

// seedIngestRow inserts a single ingest_log row and returns its ID.
// Needed because transactions.ingest_id has a FK to ingest_log.
func seedIngestRow(t *testing.T, st *Store) int64 {
	t.Helper()
	_, err := st.InsertIngest(IngestRecord{
		MessageUID:  "cat-test-seed",
		FromAddr:    "bank@test.com",
		Subject:     "tx alert",
		ParseStatus: "parsed",
		RawBody:     []byte("raw"),
		CreatedAt:   time.Now(),
	})
	if err != nil {
		t.Fatalf("seedIngestRow InsertIngest: %v", err)
	}
	var id int64
	if err := st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='cat-test-seed'").Scan(&id); err != nil {
		t.Fatalf("seedIngestRow QueryRow: %v", err)
	}
	return id
}

func TestSeedDefaultCategories(t *testing.T) {
	st := newTestStore(t)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("SeedDefaultCategories: %v", err)
	}
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	if len(cats) == 0 {
		t.Fatal("expected categories, got none")
	}
	// Verify Groceries/spending/need exists.
	var found bool
	for _, c := range cats {
		if c.Name == "Groceries" && c.Kind == "spending" && c.Bucket == "need" {
			found = true
		}
	}
	if !found {
		t.Error("Groceries (spending/need) not found in seeded categories")
	}
}

func TestSeedDefaultCategoriesIdempotent(t *testing.T) {
	st := newTestStore(t)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("first seed: %v", err)
	}
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	var count int
	if err := st.DB.QueryRow("SELECT COUNT(*) FROM categories WHERE name='Groceries'").Scan(&count); err != nil {
		t.Fatalf("count query: %v", err)
	}
	if count != 1 {
		t.Errorf("Groceries count = %d after two seeds, want 1", count)
	}
}

func TestInsertAndSelectRules(t *testing.T) {
	st := newTestStore(t)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	var groceriesID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceriesID = c.ID
		}
	}
	if groceriesID == 0 {
		t.Fatal("Groceries category not found")
	}

	rule := RuleRow{
		MatchType:  "contains",
		Pattern:    "CARREFOUR",
		CategoryID: groceriesID,
		Priority:   10,
		Source:     "manual",
	}
	if _, err := st.InsertRule(rule); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}
	rules, err := st.SelectRules()
	if err != nil {
		t.Fatalf("SelectRules: %v", err)
	}
	if len(rules) != 1 {
		t.Fatalf("SelectRules len = %d, want 1", len(rules))
	}
	r := rules[0]
	if r.MatchType != "contains" || r.Pattern != "CARREFOUR" || r.CategoryID != groceriesID {
		t.Errorf("unexpected rule: %+v", r)
	}
}

func TestInsertTransactionReturnsID(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)

	row := txnRow()
	row.IngestID = ingestID

	id, created, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}
	if !created {
		t.Error("first insert: created should be true")
	}
	if id <= 0 {
		t.Errorf("first insert: id = %d, want > 0", id)
	}

	// Duplicate — same fingerprint.
	id2, created2, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction (dup): %v", err)
	}
	if created2 {
		t.Error("duplicate insert: created should be false")
	}
	if id2 != 0 {
		t.Errorf("duplicate insert: id = %d, want 0", id2)
	}
}

func TestUpdateTransactionCategory(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	var groceriesID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceriesID = c.ID
		}
	}

	row := txnRow()
	row.IngestID = ingestID
	txID, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}

	if err := st.UpdateTransactionCategory(txID, groceriesID, "categorized"); err != nil {
		t.Fatalf("UpdateTransactionCategory: %v", err)
	}

	var catID int64
	var status string
	if err := st.DB.QueryRow(
		"SELECT category_id, status FROM transactions WHERE id=?", txID,
	).Scan(&catID, &status); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if catID != groceriesID {
		t.Errorf("category_id = %d, want %d", catID, groceriesID)
	}
	if status != "categorized" {
		t.Errorf("status = %q, want %q", status, "categorized")
	}
}

// TestUpdateTransactionCategoryRefusesSplitParent: a split parent's category
// must stay NULL — the split lines carry the categories. Categorizing it
// would make the amount count twice on any aggregate arm without a NOT EXISTS
// guard (whole via the category, again via the lines), so the store refuses
// with ErrTxSplit; un-splitting first makes the categorize legal again.
func TestUpdateTransactionCategoryRefusesSplitParent(t *testing.T) {
	st := newTestStore(t)
	spend := insertCategory(t, st, "SplitGuardS", "spending", "need")
	other := insertCategory(t, st, "SplitGuardO", "spending", "want")
	txID := insertTxn(t, st, spend, "debit", 10_000, "2026-07-01", "confirmed")
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: spend, AmountFils: 6_000},
		{CategoryID: other, AmountFils: 4_000},
	}); err != nil {
		t.Fatal(err)
	}

	if err := st.UpdateTransactionCategory(txID, spend, "confirmed"); !errors.Is(err, ErrTxSplit) {
		t.Fatalf("categorize split parent: want ErrTxSplit, got %v", err)
	}
	var catID *int64
	if err := st.DB.QueryRow(`SELECT category_id FROM transactions WHERE id=?`, txID).Scan(&catID); err != nil {
		t.Fatal(err)
	}
	if catID != nil {
		t.Fatalf("split parent category = %v, want NULL after refused categorize", *catID)
	}

	// Un-split, then categorize normally.
	if err := st.ReplaceTransactionSplits(txID, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateTransactionCategory(txID, other, "confirmed"); err != nil {
		t.Fatalf("categorize after un-split: %v", err)
	}
}

func TestUpdateTransactionStatus(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)

	row := txnRow()
	row.IngestID = ingestID
	txID, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}

	if err := st.UpdateTransactionStatus(txID, "ignored"); err != nil {
		t.Fatalf("UpdateTransactionStatus: %v", err)
	}

	var status string
	if err := st.DB.QueryRow(
		"SELECT status FROM transactions WHERE id=?", txID,
	).Scan(&status); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if status != "ignored" {
		t.Errorf("status = %q, want %q", status, "ignored")
	}
}

func TestSelectTransactions(t *testing.T) {
	st := newTestStore(t)
	// Seed ingest row
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "x@y.com",
		Subject: "s", ParseStatus: "parsed", RawBody: []byte("r"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log LIMIT 1").Scan(&ingestID)

	row := txnRow()
	row.IngestID = ingestID
	st.InsertTransaction(row) // status="needs_review" from txnRow()

	// No filters — returns all
	all, err := st.SelectTransactions("", "", "", "")
	if err != nil {
		t.Fatalf("SelectTransactions(): %v", err)
	}
	if len(all) != 1 {
		t.Errorf("no filter: got %d, want 1", len(all))
	}

	// Status filter match
	matched, _ := st.SelectTransactions("needs_review", "", "", "")
	if len(matched) != 1 {
		t.Errorf("status=needs_review: got %d, want 1", len(matched))
	}

	// Status filter miss
	missed, _ := st.SelectTransactions("confirmed", "", "", "")
	if len(missed) != 0 {
		t.Errorf("status=confirmed: got %d, want 0", len(missed))
	}

	// Date range filter: from after posted_at → no results
	after, _ := st.SelectTransactions("", "2030-01-01", "", "")
	if len(after) != 0 {
		t.Errorf("from=2030: got %d, want 0", len(after))
	}

	// Date range filter: to before posted_at → no results
	before, _ := st.SelectTransactions("", "", "2020-01-01", "")
	if len(before) != 0 {
		t.Errorf("to=2020: got %d, want 0", len(before))
	}
}

func TestUpdateCategory(t *testing.T) {
	st := openTestStore(t)
	id, err := st.InsertCategory(CategoryRow{Name: "Coffee", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateCategory(CategoryRow{ID: id, Name: "Coffee", Kind: "spending", Bucket: "need", IsActive: true}); err != nil {
		t.Fatalf("UpdateCategory: %v", err)
	}
	cats, _ := st.SelectCategories()
	var found bool
	for _, c := range cats {
		if c.ID == id {
			found = true
			if c.Bucket != "need" {
				t.Errorf("bucket = %q, want need", c.Bucket)
			}
		}
	}
	if !found {
		t.Fatal("updated category missing")
	}
}

func TestRuleActiveToggleAndSelect(t *testing.T) {
	st := openTestStore(t)
	cats, _ := st.SelectCategories()
	cat := cats[0]
	if _, err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "spinneys", CategoryID: cat.ID, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	all, _ := st.SelectRules()
	if len(all) != 1 || !all[0].IsActive {
		t.Fatalf("new rule should be active by default: %+v", all)
	}
	if err := st.SetRuleActive(all[0].ID, false); err != nil {
		t.Fatalf("toggle: %v", err)
	}
	active, _ := st.SelectActiveRules()
	if len(active) != 0 {
		t.Fatalf("disabled rule must be excluded from SelectActiveRules, got %d", len(active))
	}
	all2, _ := st.SelectRules()
	if all2[0].IsActive {
		t.Fatalf("SelectRules should report is_active=false after toggle")
	}
}

func TestDeleteRule(t *testing.T) {
	st := openTestStore(t)
	cat, _ := st.InsertCategory(CategoryRow{Name: "X", Kind: "spending", Bucket: "want", IsActive: true})
	if _, err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "amzn", CategoryID: cat, Priority: 100, Source: "manual"}); err != nil {
		t.Fatal(err)
	}
	rules, _ := st.SelectRules()
	if len(rules) != 1 {
		t.Fatalf("setup: %d rules", len(rules))
	}
	if err := st.DeleteRule(rules[0].ID); err != nil {
		t.Fatalf("DeleteRule: %v", err)
	}
	rules, _ = st.SelectRules()
	if len(rules) != 0 {
		t.Errorf("after delete: %d rules", len(rules))
	}
}

func TestDeleteCategory(t *testing.T) {
	st := newTestStore(t)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	id, err := st.InsertCategory(CategoryRow{Name: "Temp", Kind: "spending", Bucket: "want", IsActive: true})
	if err != nil {
		t.Fatalf("InsertCategory: %v", err)
	}

	if err := st.DeleteCategory(id); err != nil {
		t.Fatalf("DeleteCategory: %v", err)
	}

	var count int
	if err := st.DB.QueryRow(`SELECT count(*) FROM categories WHERE id=?`, id).Scan(&count); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if count != 0 {
		t.Fatalf("category still present after delete (count=%d)", count)
	}
}

func TestCategoryUsage(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	var groceriesID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceriesID = c.ID
		}
	}

	// Initially unused.
	txns, rules, assignments, err := st.CategoryUsage(groceriesID)
	if err != nil {
		t.Fatalf("CategoryUsage: %v", err)
	}
	if txns != 0 || rules != 0 || assignments != 0 {
		t.Fatalf("fresh category usage = (%d,%d,%d), want (0,0,0)", txns, rules, assignments)
	}

	// Assign one transaction and one rule.
	row := txnRow()
	row.IngestID = ingestID
	txID, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}
	if err := st.UpdateTransactionCategory(txID, groceriesID, "categorized"); err != nil {
		t.Fatalf("UpdateTransactionCategory: %v", err)
	}
	if _, err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "spinneys", CategoryID: groceriesID, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}

	txns, rules, assignments, err = st.CategoryUsage(groceriesID)
	if err != nil {
		t.Fatalf("CategoryUsage: %v", err)
	}
	if txns != 1 || rules != 1 || assignments != 0 {
		t.Fatalf("usage = (%d,%d,%d), want (1,1,0)", txns, rules, assignments)
	}

	// Envelope assignments count too (they are ON DELETE CASCADE — deleting
	// would silently rewrite past budget state), but a zeroed-out assignment
	// row carries no money and does not block.
	if err := st.UpsertEnvelopeAssignment("2026-07", groceriesID, 100_000); err != nil {
		t.Fatalf("UpsertEnvelopeAssignment: %v", err)
	}
	if _, _, assignments, err = st.CategoryUsage(groceriesID); err != nil || assignments != 1 {
		t.Fatalf("usage after assignment = %d err=%v, want 1", assignments, err)
	}
	if err := st.UpsertEnvelopeAssignment("2026-07", groceriesID, 0); err != nil {
		t.Fatalf("zero assignment: %v", err)
	}
	if _, _, assignments, err = st.CategoryUsage(groceriesID); err != nil || assignments != 0 {
		t.Fatalf("usage after zeroing = %d err=%v, want 0 (zero rows don't block)", assignments, err)
	}
}

func TestClearAllCategorization(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)
	if err := st.SeedDefaultCategories(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	cats, _ := st.SelectCategories()
	var groceriesID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceriesID = c.ID
		}
	}

	// A categorized transaction (with a frozen bucket snapshot).
	row := txnRow()
	row.IngestID = ingestID
	catID, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}
	if err := st.UpdateTransactionCategory(catID, groceriesID, "confirmed"); err != nil {
		t.Fatalf("UpdateTransactionCategory: %v", err)
	}
	if err := st.SnapshotBucketForCategory(groceriesID, "need"); err != nil {
		t.Fatalf("SnapshotBucketForCategory: %v", err)
	}

	// An intentionally-ignored transaction (no category).
	row2 := txnRow()
	row2.IngestID = ingestID
	row2.MerchantRaw = "TRANSFER OUT"
	row2.AmountFils = 99900
	ignoredID, _, err := st.InsertTransaction(row2)
	if err != nil {
		t.Fatalf("InsertTransaction 2: %v", err)
	}
	if err := st.UpdateTransactionStatus(ignoredID, "ignored"); err != nil {
		t.Fatalf("UpdateTransactionStatus: %v", err)
	}

	// A learned rule that must survive the wipe.
	if _, err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "CARREFOUR", CategoryID: groceriesID, Priority: 10, Source: "manual"}); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}

	n, err := st.ClearAllCategorization()
	if err != nil {
		t.Fatalf("ClearAllCategorization: %v", err)
	}
	if n != 2 {
		t.Errorf("cleared count = %d, want 2", n)
	}

	// Every transaction is back to needs_review with no category or bucket.
	rows, err := st.DB.Query(`SELECT category_id, bucket_snapshot, status FROM transactions`)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var cat sql.NullInt64
		var bucket sql.NullString
		var status string
		if err := rows.Scan(&cat, &bucket, &status); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen++
		if cat.Valid {
			t.Errorf("category_id not cleared: %d", cat.Int64)
		}
		if bucket.Valid {
			t.Errorf("bucket_snapshot not cleared: %q", bucket.String)
		}
		if status != "needs_review" {
			t.Errorf("status = %q, want needs_review", status)
		}
	}
	if seen != 2 {
		t.Errorf("scanned %d transactions, want 2", seen)
	}

	// Rules are untouched.
	rules, _ := st.SelectRules()
	if len(rules) != 1 {
		t.Errorf("rules len = %d, want 1 (rules must survive)", len(rules))
	}
}

func mustTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestSelectTransactionsIncludesCategory(t *testing.T) {
	st := openTestStore(t)
	cats, _ := st.SelectCategories()
	var groceries CategoryRow
	for _, c := range cats {
		if c.Name == "Groceries" {
			groceries = c
		}
	}
	if groceries.ID == 0 {
		t.Fatal("Groceries not found in seed")
	}
	id, _, err := st.InsertTransaction(TransactionRow{
		PostedAt: mustTime("2026-06-10T09:00:00Z"), AmountFils: 5000, Currency: "AED",
		Direction: "debit", MerchantRaw: "SPINNEYS", Status: "confirmed", Source: "email",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if err := st.UpdateTransactionCategory(id, groceries.ID, "confirmed"); err != nil {
		t.Fatalf("setcategory: %v", err)
	}
	items, err := st.SelectTransactions("", "", "", "")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("want 1 item, got %d", len(items))
	}
	got := items[0]
	if got.CategoryID == nil || *got.CategoryID != groceries.ID {
		t.Fatalf("CategoryID = %v, want %d", got.CategoryID, groceries.ID)
	}
	if got.CategoryName != "Groceries" || got.Bucket != "need" {
		t.Fatalf("CategoryName/Bucket = %q/%q, want Groceries/need", got.CategoryName, got.Bucket)
	}
}

// Transactions carry their bank-email last4 and, when it matches a registered
// account, that account's name — so the review UI can show where money moved.
func TestSelectTransactionsIncludesAccount(t *testing.T) {
	st := openTestStore(t)
	if _, err := st.InsertAccount("Main current", "ENBD", "4821"); err != nil {
		t.Fatalf("InsertAccount: %v", err)
	}
	if _, _, err := st.InsertTransaction(TransactionRow{
		PostedAt: mustTime("2026-06-10T09:00:00Z"), AmountFils: 5000, Currency: "AED",
		Direction: "debit", MerchantRaw: "SPINNEYS", Last4: "4821", Status: "needs_review", Source: "email",
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	// A second transaction with an unregistered last4 keeps the raw digits only.
	if _, _, err := st.InsertTransaction(TransactionRow{
		PostedAt: mustTime("2026-06-11T09:00:00Z"), AmountFils: 7000, Currency: "AED",
		Direction: "debit", MerchantRaw: "LULU", Last4: "9999", Status: "needs_review", Source: "email",
	}); err != nil {
		t.Fatalf("insert 2: %v", err)
	}

	items, err := st.SelectTransactions("", "", "", "")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d", len(items))
	}
	// Newest first: LULU then SPINNEYS.
	if items[0].Last4 != "9999" || items[0].AccountName != "" {
		t.Errorf("unregistered: Last4/AccountName = %q/%q, want 9999/(empty)", items[0].Last4, items[0].AccountName)
	}
	if items[1].Last4 != "4821" || items[1].AccountName != "Main current" {
		t.Errorf("registered: Last4/AccountName = %q/%q, want 4821/Main current", items[1].Last4, items[1].AccountName)
	}
}

func TestSelectTransactionsExposesKindAndSnapshot(t *testing.T) {
	st := openTestStore(t)
	// Get the default categories.
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	var diningID int64
	for _, c := range cats {
		if c.Name == "Dining" && c.Kind == "spending" && c.Bucket == "want" {
			diningID = c.ID
		}
	}
	if diningID == 0 {
		t.Fatal("Dining category not found")
	}
	// A confirmed debit in the Dining category, with a frozen bucket snapshot.
	id, _, err := st.InsertTransaction(TransactionRow{
		PostedAt:    time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC),
		AmountFils:  5000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "Deliveroo",
		Status:      "confirmed",
		Source:      "email",
	})
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}
	if err := st.UpdateTransactionCategory(id, diningID, "confirmed"); err != nil {
		t.Fatalf("UpdateTransactionCategory: %v", err)
	}
	// Set bucket_snapshot directly on this transaction.
	if _, err := st.DB.Exec("UPDATE transactions SET bucket_snapshot=? WHERE id=?", "need", id); err != nil {
		t.Fatalf("SetBucketSnapshot: %v", err)
	}
	rows, err := st.SelectTransactions("confirmed", "", "", "")
	if err != nil {
		t.Fatalf("SelectTransactions: %v", err)
	}
	var got *ReviewItem
	for i := range rows {
		if rows[i].ID == id {
			got = &rows[i]
		}
	}
	if got == nil {
		t.Fatal("transaction not returned")
	}
	if got.Kind != "spending" {
		t.Errorf("Kind = %q, want %q", got.Kind, "spending")
	}
	if got.BucketSnapshot != "need" {
		t.Errorf("BucketSnapshot = %q, want %q", got.BucketSnapshot, "need")
	}
}

func TestSelectTransactionsSearch(t *testing.T) {
	st := newTestStore(t)
	seed := func(merchant string) {
		t.Helper()
		if _, _, err := st.InsertTransaction(TransactionRow{
			PostedAt:    time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC),
			AmountFils:  5000,
			Currency:    "AED",
			Direction:   "debit",
			MerchantRaw: merchant,
			Status:      "needs_review",
		}); err != nil {
			t.Fatalf("insert %q: %v", merchant, err)
		}
	}
	seed("SPINNEYS DUBAI MARINA")
	seed("NETFLIX.COM")
	seed("100% NATURAL JUICE")
	seed("1000 THINGS STORE")

	// Case-insensitive contains-match.
	got, err := st.SelectTransactions("", "", "", "spinneys")
	if err != nil {
		t.Fatalf("SelectTransactions(search): %v", err)
	}
	if len(got) != 1 || got[0].MerchantRaw != "SPINNEYS DUBAI MARINA" {
		t.Errorf("search=spinneys: got %+v, want only the SPINNEYS row", got)
	}

	// No match.
	none, _ := st.SelectTransactions("", "", "", "carrefour")
	if len(none) != 0 {
		t.Errorf("search=carrefour: got %d rows, want 0", len(none))
	}

	// LIKE wildcards in the term are literal text, not patterns: "100%" must
	// match only the "100%" merchant, not everything containing "100".
	pct, _ := st.SelectTransactions("", "", "", "100%")
	if len(pct) != 1 || pct[0].MerchantRaw != "100% NATURAL JUICE" {
		t.Errorf("search=100%%: got %+v, want only the 100%% NATURAL JUICE row", pct)
	}

	// Empty search matches all.
	all, _ := st.SelectTransactions("", "", "", "")
	if len(all) != 4 {
		t.Errorf("empty search: got %d rows, want 4", len(all))
	}
}

// TestTransactionRowCarriesProjectID asserts that a transaction assigned to a
// project reports ProjectID non-nil through SelectTransactions — the same
// read path the /api/transactions handler uses.
func TestTransactionRowCarriesProjectID(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "Auto", "spending", "want")
	id := insertTxn(t, st, cat, "debit", 100_000, "2026-07-01", "confirmed")
	pid, err := st.InsertProject(ProjectRow{Name: "Car", Status: "active"})
	if err != nil {
		t.Fatalf("InsertProject: %v", err)
	}
	if err := st.AssignTransactionProject(id, &pid); err != nil {
		t.Fatalf("AssignTransactionProject: %v", err)
	}

	items, err := st.SelectTransactions("confirmed", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	var found *int64
	for _, it := range items {
		if it.ID == id {
			found = it.ProjectID
		}
	}
	if found == nil || *found != pid {
		t.Fatalf("ProjectID = %v, want %d", found, pid)
	}
}

// Decategorizing one transaction clears its category and frozen snapshot and
// returns it to the review queue, but keeps orthogonal links (project, refund).
func TestClearTransactionCategory(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "Trip dining", "spending", "want")
	id := insertTxn(t, st, cat, "debit", 12_000, "2026-07-01", "confirmed")
	pid, _ := st.InsertProject(ProjectRow{Name: "Trip", Status: "active"})
	if err := st.AssignTransactionProject(id, &pid); err != nil {
		t.Fatalf("assign: %v", err)
	}
	if err := st.SnapshotBucketForCategory(cat, "want"); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	if err := st.ClearTransactionCategory(id); err != nil {
		t.Fatalf("ClearTransactionCategory: %v", err)
	}

	var catID, projectID *int64
	var snapshot *string
	var status string
	if err := st.DB.QueryRow(
		"SELECT category_id, bucket_snapshot, status, project_id FROM transactions WHERE id=?", id,
	).Scan(&catID, &snapshot, &status, &projectID); err != nil {
		t.Fatalf("scan: %v", err)
	}
	if catID != nil {
		t.Errorf("category_id = %v, want NULL", *catID)
	}
	if snapshot != nil {
		t.Errorf("bucket_snapshot = %v, want NULL", *snapshot)
	}
	if status != "needs_review" {
		t.Errorf("status = %q, want needs_review", status)
	}
	if projectID == nil || *projectID != pid {
		t.Errorf("project_id = %v, want %d (must survive decategorization)", projectID, pid)
	}
}

// TestClearTransactionCategoryRefusesSplitParent: the decategorize path must
// carry the same split guard as categorize. Without it, "decategorizing" a
// split parent (category already NULL) would only flip status to needs_review
// with the lines still attached — the whole amount silently drops out of
// every aggregate (split-line sums require the parent confirmed) and the row
// jams: re-categorizing 409s with "transaction is split". PUT splits [] is
// the sanctioned way out of the split state.
func TestClearTransactionCategoryRefusesSplitParent(t *testing.T) {
	st := newTestStore(t)
	spend := insertCategory(t, st, "ClearGuardS", "spending", "need")
	other := insertCategory(t, st, "ClearGuardO", "spending", "want")
	txID := insertTxn(t, st, spend, "debit", 10_000, "2026-07-01", "confirmed")
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: spend, AmountFils: 6_000},
		{CategoryID: other, AmountFils: 4_000},
	}); err != nil {
		t.Fatal(err)
	}

	if err := st.ClearTransactionCategory(txID); !errors.Is(err, ErrTxSplit) {
		t.Fatalf("decategorize split parent: want ErrTxSplit, got %v", err)
	}
	var status string
	var lines int
	if err := st.DB.QueryRow(`SELECT status FROM transactions WHERE id=?`, txID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transaction_splits WHERE transaction_id=?`, txID).Scan(&lines); err != nil {
		t.Fatal(err)
	}
	if status != "confirmed" || lines != 2 {
		t.Fatalf("after refused decategorize: status=%q lines=%d, want confirmed/2 (the split amount must keep counting)", status, lines)
	}

	// Un-split (which itself parks the parent in the review queue), then a
	// plain decategorize is legal again.
	if err := st.ReplaceTransactionSplits(txID, nil); err != nil {
		t.Fatal(err)
	}
	if err := st.ClearTransactionCategory(txID); err != nil {
		t.Fatalf("decategorize after un-split: %v", err)
	}
}

// TestClearAllCategorizationDeletesSplitLines: the danger-zone bulk reset must
// not strand needs_review parents with split lines still attached — those
// rows would 409 on every categorize attempt ("transaction is split") until
// each one was manually un-split, a dead end for a whole-history reset.
func TestClearAllCategorizationDeletesSplitLines(t *testing.T) {
	st := newTestStore(t)
	spend := insertCategory(t, st, "ResetSplitS", "spending", "need")
	other := insertCategory(t, st, "ResetSplitO", "spending", "want")
	txID := insertTxn(t, st, spend, "debit", 10_000, "2026-07-01", "confirmed")
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: spend, AmountFils: 6_000},
		{CategoryID: other, AmountFils: 4_000},
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := st.ClearAllCategorization(); err != nil {
		t.Fatal(err)
	}
	var lines int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transaction_splits`).Scan(&lines); err != nil {
		t.Fatal(err)
	}
	if lines != 0 {
		t.Fatalf("split lines after bulk reset = %d, want 0", lines)
	}
	// The reset row must be recoverable through the normal review flow.
	if err := st.UpdateTransactionCategory(txID, spend, "confirmed"); err != nil {
		t.Fatalf("re-categorize after reset: %v", err)
	}
}
