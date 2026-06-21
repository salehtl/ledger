package store

import (
	"database/sql"
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
	if err := st.InsertRule(rule); err != nil {
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
	all, err := st.SelectTransactions("", "", "")
	if err != nil {
		t.Fatalf("SelectTransactions(): %v", err)
	}
	if len(all) != 1 {
		t.Errorf("no filter: got %d, want 1", len(all))
	}

	// Status filter match
	matched, _ := st.SelectTransactions("needs_review", "", "")
	if len(matched) != 1 {
		t.Errorf("status=needs_review: got %d, want 1", len(matched))
	}

	// Status filter miss
	missed, _ := st.SelectTransactions("confirmed", "", "")
	if len(missed) != 0 {
		t.Errorf("status=confirmed: got %d, want 0", len(missed))
	}

	// Date range filter: from after posted_at → no results
	after, _ := st.SelectTransactions("", "2030-01-01", "")
	if len(after) != 0 {
		t.Errorf("from=2030: got %d, want 0", len(after))
	}

	// Date range filter: to before posted_at → no results
	before, _ := st.SelectTransactions("", "", "2020-01-01")
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
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "spinneys", CategoryID: cat.ID, Priority: 100, Source: "manual"}); err != nil {
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
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "amzn", CategoryID: cat, Priority: 100, Source: "manual"}); err != nil {
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
	txns, rules, err := st.CategoryUsage(groceriesID)
	if err != nil {
		t.Fatalf("CategoryUsage: %v", err)
	}
	if txns != 0 || rules != 0 {
		t.Fatalf("fresh category usage = (%d,%d), want (0,0)", txns, rules)
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
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "spinneys", CategoryID: groceriesID, Priority: 100, Source: "manual"}); err != nil {
		t.Fatalf("InsertRule: %v", err)
	}

	txns, rules, err = st.CategoryUsage(groceriesID)
	if err != nil {
		t.Fatalf("CategoryUsage: %v", err)
	}
	if txns != 1 || rules != 1 {
		t.Fatalf("usage = (%d,%d), want (1,1)", txns, rules)
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
	if err := st.InsertRule(RuleRow{MatchType: "contains", Pattern: "CARREFOUR", CategoryID: groceriesID, Priority: 10, Source: "manual"}); err != nil {
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
	items, err := st.SelectTransactions("", "", "")
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
	rows, err := st.SelectTransactions("confirmed", "", "")
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
