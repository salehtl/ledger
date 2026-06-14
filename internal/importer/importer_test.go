package importer_test

import (
	"context"
	"testing"

	"ledger/internal/importer"
	"ledger/internal/store"
)

func newTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func baseMapConfig() importer.MapConfig {
	return importer.MapConfig{
		Columns: importer.ColumnMap{
			Date:        "Date",
			Description: "Description",
			Amount:      "Amount",
			Category:    "Category",
		},
		DateFormat:      "02/01/2006",
		Currency:        "AED",
		DirectionMode:   "sign",
		SkipZeroAmounts: true,
	}
}

func TestRun_DryRun_NoWrites(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"},
		{"Date": "20/08/2025", "Description": "Salary", "Amount": "10000.00", "Category": "Salary"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsTotal != 2 {
		t.Errorf("total = %d, want 2", result.RowsTotal)
	}
	if result.RowsAdded != 2 {
		t.Errorf("added (dry) = %d, want 2", result.RowsAdded)
	}
	// dry-run must not write to DB
	txns, _ := st.SelectTransactions("", "", "")
	if len(txns) != 0 {
		t.Errorf("dry-run wrote %d txns, want 0", len(txns))
	}
	logs, _ := st.SelectImportLogs()
	if len(logs) != 0 {
		t.Errorf("dry-run wrote %d import_log rows, want 0", len(logs))
	}
}

func TestRun_WetRun_InsertsAndCategorizes(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsAdded != 1 {
		t.Fatalf("added = %d, want 1", result.RowsAdded)
	}
	txns, _ := st.SelectTransactions("confirmed", "", "")
	if len(txns) != 1 {
		t.Fatalf("confirmed txns = %d, want 1", len(txns))
	}
	if txns[0].MerchantRaw != "Amazon.ae" {
		t.Errorf("merchant = %q, want Amazon.ae", txns[0].MerchantRaw)
	}
	// Import log should be written
	logs, _ := st.SelectImportLogs()
	if len(logs) != 1 {
		t.Errorf("import_log rows = %d, want 1", len(logs))
	}
	if logs[0].FileName != "test.csv" {
		t.Errorf("file_name = %q, want test.csv", logs[0].FileName)
	}
}

func TestRun_NoCategoryColumn_RoutesToReview(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	m := baseMapConfig()
	m.Columns.Category = "" // no category column
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Unknown Merchant", "Amount": "-100.00"},
	}
	result, err := imp.Run(context.Background(), rows, m, "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsReview != 1 {
		t.Errorf("review = %d, want 1", result.RowsReview)
	}
	txns, _ := st.SelectTransactions("needs_review", "", "")
	if len(txns) != 1 {
		t.Errorf("needs_review txns = %d, want 1", len(txns))
	}
}

func TestRun_Idempotent(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Amazon.ae", "Amount": "-38.25", "Category": "Shopping"},
	}
	r1, _ := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	r2, _ := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if r1.RowsAdded != 1 {
		t.Errorf("first run: added = %d, want 1", r1.RowsAdded)
	}
	if r2.RowsSkipped != 1 {
		t.Errorf("second run: skipped = %d, want 1 (fingerprint dedup)", r2.RowsSkipped)
	}
	if r2.RowsAdded != 0 {
		t.Errorf("second run: added = %d, want 0", r2.RowsAdded)
	}
}

func TestRun_SkipZeroAmounts(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	m := baseMapConfig()
	m.SkipZeroAmounts = true
	rows := []importer.RawRow{
		{"Date": "19/08/2025", "Description": "Zero", "Amount": "0.00", "Category": "Shopping"},
		{"Date": "20/08/2025", "Description": "Real", "Amount": "-50.00", "Category": "Shopping"},
	}
	result, _ := imp.Run(context.Background(), rows, m, "test.csv", false)
	if result.RowsSkipped != 1 {
		t.Errorf("skipped = %d, want 1 (zero amount)", result.RowsSkipped)
	}
	if result.RowsAdded != 1 {
		t.Errorf("added = %d, want 1", result.RowsAdded)
	}
}

func TestRun_DeriveRules_ThresholdThree(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	// Same merchant, same category, 3 different days → should derive a rule
	rows := []importer.RawRow{
		{"Date": "01/08/2025", "Description": "AMAZON.AE", "Amount": "-10.00", "Category": "Shopping"},
		{"Date": "02/08/2025", "Description": "AMAZON.AE", "Amount": "-20.00", "Category": "Shopping"},
		{"Date": "03/08/2025", "Description": "AMAZON.AE", "Amount": "-30.00", "Category": "Shopping"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.DerivedRules != 1 {
		t.Errorf("derived rules = %d, want 1", result.DerivedRules)
	}
	rules, _ := st.SelectRules()
	var found bool
	for _, r := range rules {
		if r.Source == "import_derived" {
			found = true
		}
	}
	if !found {
		t.Error("expected an import_derived rule in rules table")
	}
}

func TestRun_DeriveRules_BelowThreshold(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	// Only 2 occurrences — below threshold of 3
	rows := []importer.RawRow{
		{"Date": "01/08/2025", "Description": "RARE SHOP", "Amount": "-10.00", "Category": "Shopping"},
		{"Date": "02/08/2025", "Description": "RARE SHOP", "Amount": "-20.00", "Category": "Shopping"},
	}
	result, _ := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if result.DerivedRules != 0 {
		t.Errorf("derived rules = %d, want 0 (below threshold)", result.DerivedRules)
	}
}

func TestRun_ErrorRows_DoNotBlock(t *testing.T) {
	st := newTestStore(t)
	imp := importer.New(st, nil)
	rows := []importer.RawRow{
		{"Date": "BAD DATE", "Description": "Broken", "Amount": "-10.00", "Category": "Shopping"},
		{"Date": "19/08/2025", "Description": "Good", "Amount": "-20.00", "Category": "Shopping"},
	}
	result, err := imp.Run(context.Background(), rows, baseMapConfig(), "test.csv", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsError != 1 {
		t.Errorf("errors = %d, want 1", result.RowsError)
	}
	if result.RowsAdded != 1 {
		t.Errorf("added = %d, want 1 (good row still inserted)", result.RowsAdded)
	}
}
