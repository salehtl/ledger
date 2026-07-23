package store

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestRawBodyRoundTripCompressed(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	body := []byte(strings.Repeat("<tr><td>transaction row</td></tr>\n", 500))
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "u1", ParseStatus: "unparsed", RawBody: body,
		ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	// Stored form must be gzip (much smaller, gzip magic prefix)...
	var stored []byte
	if err := st.DB.QueryRow(`SELECT raw_body FROM ingest_log WHERE message_uid='u1'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(stored, []byte{0x1f, 0x8b}) {
		t.Fatal("stored raw_body is not gzip")
	}
	if len(stored) >= len(body) {
		t.Fatalf("no size win: stored %d >= raw %d", len(stored), len(body))
	}

	// ...and the read path must return the original bytes.
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || !bytes.Equal(rows[0].RawBody, body) {
		t.Fatal("SelectForParse did not round-trip the body")
	}
}

func TestLegacyPlainRowsStillReadAndCompact(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// A pre-compression row: plain text inserted directly.
	plain := "legacy plain email body"
	if _, err := st.DB.Exec(
		`INSERT INTO ingest_log (message_uid, from_addr, subject, parse_status, raw_body, created_at)
		 VALUES ('legacy', 'a@b.c', 's', 'unparsed', ?, '2026-01-01T00:00:00Z')`, plain); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil || len(rows) != 1 || string(rows[0].RawBody) != plain {
		t.Fatalf("legacy row read failed: %v rows=%v", err, rows)
	}

	// Compact converts it in place; reads still return the original.
	n, err := st.CompressRawBodies()
	if err != nil || n != 1 {
		t.Fatalf("CompressRawBodies = %d, %v; want 1, nil", n, err)
	}
	var stored []byte
	if err := st.DB.QueryRow(`SELECT raw_body FROM ingest_log WHERE message_uid='legacy'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(stored, []byte{0x1f, 0x8b}) {
		t.Fatal("compact did not gzip the legacy row")
	}
	rows, _ = st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if len(rows) != 1 || string(rows[0].RawBody) != plain {
		t.Fatal("post-compact read did not round-trip")
	}
	// Second run is a no-op.
	if n, err := st.CompressRawBodies(); err != nil || n != 0 {
		t.Fatalf("second compact = %d, %v; want 0, nil", n, err)
	}
}

func TestCorruptGzipRowDoesNotStallBatch(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	// One good row via the public API, one corrupt-gzip row planted directly.
	good := []byte("legit body")
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "good", FromAddr: "a@b.c", Subject: "s", ParseStatus: "unparsed",
		RawBody: good, ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	corrupt := []byte{0x1f, 0x8b, 0xde, 0xad, 0xbe, 0xef} // gzip magic, garbage stream
	if _, err := st.DB.Exec(
		`INSERT INTO ingest_log (message_uid, from_addr, subject, parse_status, raw_body, created_at)
		 VALUES ('corrupt', 'a@b.c', 's', 'unparsed', ?, '2026-01-01T00:00:00Z')`, corrupt); err != nil {
		t.Fatal(err)
	}

	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("a corrupt row must not fail the whole select: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("both rows must come back, got %d", len(rows))
	}
	for _, r := range rows {
		if r.ID != 0 && bytes.Equal(r.RawBody, good) {
			return // good row round-tripped despite the corrupt neighbor
		}
	}
	t.Fatal("good row's body did not round-trip")
}
