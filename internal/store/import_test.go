package store

import (
	"testing"
)

func TestInsertAndSelectImportLog(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	id, err := st.InsertImportLog(ImportLogRow{
		FileName:    "all-transactions.csv",
		RowsTotal:   100,
		RowsAdded:   90,
		RowsSkipped: 5,
		RowsReview:  3,
		RowsError:   2,
	})
	if err != nil {
		t.Fatalf("InsertImportLog: %v", err)
	}
	if id == 0 {
		t.Error("expected non-zero id")
	}

	logs, err := st.SelectImportLogs()
	if err != nil {
		t.Fatalf("SelectImportLogs: %v", err)
	}
	if len(logs) != 1 {
		t.Fatalf("got %d logs, want 1", len(logs))
	}
	if logs[0].FileName != "all-transactions.csv" {
		t.Errorf("file_name = %q, want all-transactions.csv", logs[0].FileName)
	}
	if logs[0].RowsAdded != 90 {
		t.Errorf("rows_added = %d, want 90", logs[0].RowsAdded)
	}
}

func TestInsertTransactionSourceField(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	r := TransactionRow{
		PostedAt:    mustParseTime("2025-08-19T00:00:00Z"),
		AmountFils:  3825,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "Amazon.ae",
		Status:      "needs_review",
		Source:      "import",
	}
	_, created, err := st.InsertTransaction(r)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Error("expected row to be created")
	}
	var src string
	st.DB.QueryRow("SELECT source FROM transactions LIMIT 1").Scan(&src)
	if src != "import" {
		t.Errorf("source = %q, want import", src)
	}
}

func TestInsertTransactionDefaultsSourceToEmail(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	r := TransactionRow{
		PostedAt:    mustParseTime("2025-08-19T00:00:00Z"),
		AmountFils:  1000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DAPPER DAN",
		Status:      "needs_review",
		// Source intentionally empty — must default to "email"
	}
	_, _, err = st.InsertTransaction(r)
	if err != nil {
		t.Fatal(err)
	}
	var src string
	st.DB.QueryRow("SELECT source FROM transactions LIMIT 1").Scan(&src)
	if src != "email" {
		t.Errorf("source = %q, want email (default)", src)
	}
}
