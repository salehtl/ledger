package store

import (
	"testing"
	"time"
)

func mustParseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

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
	st := newTestStore(t)
	// Seed a real ingest_log row so transactions.ingest_id satisfies the FK.
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "seed", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	if err := st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='seed'").Scan(&ingestID); err != nil {
		t.Fatal(err)
	}
	row := txnRow()
	row.IngestID = ingestID

	_, ins1, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("insert1: %v", err)
	}
	if !ins1 {
		t.Error("first insert should be new")
	}
	_, ins2, err := st.InsertTransaction(row) // identical → same fingerprint
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
	// Linkage is persisted.
	var linked int64
	st.DB.QueryRow("SELECT ingest_id FROM transactions LIMIT 1").Scan(&linked)
	if linked != ingestID {
		t.Errorf("ingest_id = %d, want %d", linked, ingestID)
	}
}

func seedConfirmedTxn(t *testing.T, st *Store) int64 {
	t.Helper()
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "arch-seed", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='arch-seed'").Scan(&ingestID)
	row := txnRow()
	row.IngestID = ingestID
	row.PostedAt = time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC)
	id, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatal(err)
	}
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if err := st.UpdateTransactionCategory(id, catID, "confirmed"); err != nil {
		t.Fatal(err)
	}
	return id
}

func statusOf(t *testing.T, st *Store, id int64) string {
	t.Helper()
	var s string
	if err := st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestArchiveAndRestoreRoundTrip(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if got := statusOf(t, st, id); got != "archived" {
		t.Fatalf("status after archive = %q, want archived", got)
	}

	if err := st.RestoreTransaction(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := statusOf(t, st, id); got != "confirmed" {
		t.Fatalf("status after restore = %q, want confirmed (prior status preserved)", got)
	}
}

func TestArchiveHidesFromBudget(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	before, _ := st.SelectMonthSpend("2026-06", false)
	if len(before) != 1 {
		t.Fatalf("pre-archive month spend rows = %d, want 1", len(before))
	}
	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatal(err)
	}
	after, _ := st.SelectMonthSpend("2026-06", false)
	if len(after) != 0 {
		t.Fatalf("archived txn still counted in budget: %d rows", len(after))
	}
}

func TestRestoreNonArchivedIsNoOp(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)
	if err := st.RestoreTransaction(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := statusOf(t, st, id); got != "confirmed" {
		t.Fatalf("status = %q, want unchanged confirmed", got)
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
