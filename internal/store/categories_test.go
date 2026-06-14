package store

import (
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

func TestSelectNeedsReview(t *testing.T) {
	st := newTestStore(t)
	ingestID := seedIngestRow(t, st)

	row := txnRow() // status is "needs_review"
	row.IngestID = ingestID
	txID, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("InsertTransaction: %v", err)
	}

	items, err := st.SelectNeedsReview()
	if err != nil {
		t.Fatalf("SelectNeedsReview: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("SelectNeedsReview len = %d, want 1", len(items))
	}
	if items[0].ID != txID {
		t.Errorf("ID = %d, want %d", items[0].ID, txID)
	}
	if items[0].AmountFils != row.AmountFils {
		t.Errorf("AmountFils = %d, want %d", items[0].AmountFils, row.AmountFils)
	}
	if items[0].Status != "needs_review" {
		t.Errorf("Status = %q, want needs_review", items[0].Status)
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
