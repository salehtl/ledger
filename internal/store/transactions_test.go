package store

import (
	"testing"
	"time"
)

func txnRow() TransactionRow {
	return TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  21500,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DAPPER DAN GENTS SAL",
		Last4:       "1502",
		Status:      "needs_review",
		Confidence:  0.97,
		Tier:        "template",
		IngestID:    1,
	}
}

func TestInsertTransactionAndFingerprintDedup(t *testing.T) {
	st := newTestStore(t) // helper from ingest_test.go in the same package
	ins1, err := st.InsertTransaction(txnRow())
	if err != nil {
		t.Fatalf("insert1: %v", err)
	}
	if !ins1 {
		t.Error("first insert should be new")
	}
	ins2, err := st.InsertTransaction(txnRow()) // identical → same fingerprint
	if err != nil {
		t.Fatalf("insert2: %v", err)
	}
	if ins2 {
		t.Error("duplicate (same fingerprint) must not insert again")
	}
	var n int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions").Scan(&n)
	if n != 1 {
		t.Errorf("transactions count = %d, want 1", n)
	}
}

func TestSelectForParseAndMarkParsed(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "unparsed", RawBody: []byte("raw1"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u2", FromAddr: "x@y.com",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw2"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(rows) != 1 || rows[0].FromAddr != "DIB.notification@dib.ae" {
		t.Fatalf("got %d rows: %+v", len(rows), rows)
	}
	if err := st.MarkParsed(rows[0].ID, "parsed", "template", ""); err != nil {
		t.Fatalf("mark: %v", err)
	}
	rows2, _ := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if len(rows2) != 0 {
		t.Errorf("expected 0 unparsed after mark, got %d", len(rows2))
	}
}
