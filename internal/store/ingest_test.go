package store

import (
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func sampleRecord(uid string) IngestRecord {
	return IngestRecord{
		MessageUID:  uid,
		ReceivedAt:  time.Date(2026, 6, 1, 9, 30, 0, 0, time.UTC),
		FromAddr:    "alerts@emiratesnbd.com",
		Subject:     "Transaction Alert",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: alerts@emiratesnbd.com\r\n\r\nYou spent AED 42.00"),
		CreatedAt:   time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC),
	}
}

func TestInsertIngestReturnsTrueOnNew(t *testing.T) {
	st := newTestStore(t)
	inserted, err := st.InsertIngest(sampleRecord("1-100"))
	if err != nil {
		t.Fatalf("InsertIngest: %v", err)
	}
	if !inserted {
		t.Error("expected inserted = true for a new message")
	}
}

func TestInsertIngestIsIdempotent(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.InsertIngest(sampleRecord("1-100")); err != nil {
		t.Fatal(err)
	}
	inserted, err := st.InsertIngest(sampleRecord("1-100"))
	if err != nil {
		t.Fatalf("second InsertIngest: %v", err)
	}
	if inserted {
		t.Error("expected inserted = false for a duplicate message_uid")
	}
	n, err := st.CountIngest()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("CountIngest = %d, want 1", n)
	}
}

func TestKnownUIDs(t *testing.T) {
	st := newTestStore(t)
	for _, uid := range []string{"1-100", "1-101", "1-102"} {
		if _, err := st.InsertIngest(sampleRecord(uid)); err != nil {
			t.Fatal(err)
		}
	}
	known, err := st.KnownUIDs()
	if err != nil {
		t.Fatalf("KnownUIDs: %v", err)
	}
	if len(known) != 3 {
		t.Fatalf("KnownUIDs len = %d, want 3", len(known))
	}
	if _, ok := known["1-101"]; !ok {
		t.Error("expected 1-101 in known set")
	}
}

func TestLastIngestAt(t *testing.T) {
	st := newTestStore(t)
	if _, _, err := mustNoLast(t, st); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertIngest(sampleRecord("1-100")); err != nil {
		t.Fatal(err)
	}
	at, ok, err := st.LastIngestAt()
	if err != nil {
		t.Fatalf("LastIngestAt: %v", err)
	}
	if !ok {
		t.Fatal("expected ok = true after an insert")
	}
	if !at.Equal(time.Date(2026, 6, 14, 12, 0, 0, 0, time.UTC)) {
		t.Errorf("LastIngestAt = %s, want 2026-06-14T12:00:00Z", at)
	}
}

// mustNoLast asserts LastIngestAt reports ok=false on an empty table.
func mustNoLast(t *testing.T, st *Store) (time.Time, bool, error) {
	t.Helper()
	at, ok, err := st.LastIngestAt()
	if err == nil && ok {
		t.Fatal("expected ok = false on empty ingest_log")
	}
	return at, ok, err
}
