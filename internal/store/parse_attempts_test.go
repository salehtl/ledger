// internal/store/parse_attempts_test.go
package store

import (
	"testing"
	"time"
)

func TestSelectForParseSkipsExhaustedRows(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	rec := IngestRecord{
		MessageUID: "uid-1", FromAddr: "noreply@bank.example", Subject: "alert",
		ParseStatus: "unparsed", RawBody: []byte("body"),
		ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}
	if _, err := st.InsertIngest(rec); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("fresh row should be selected, got %d rows", len(rows))
	}
	id := rows[0].ID

	// Three failed parses exhaust the automatic-retry budget.
	for i := 0; i < 3; i++ {
		if err := st.MarkParsed(id, "unparsed", "", "no tier matched"); err != nil {
			t.Fatal(err)
		}
	}
	rows, err = st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true, MaxAttempts: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 0 {
		t.Fatalf("exhausted row must be skipped by the capped select, got %d rows", len(rows))
	}

	// The uncapped (manual reprocess) select still sees it.
	rows, err = st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("uncapped select must still return the row, got %d rows", len(rows))
	}
}

func TestMarkParsedSuccessDoesNotIncrementAttempts(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "uid-2", FromAddr: "noreply@bank.example", Subject: "alert",
		ParseStatus: "unparsed", RawBody: []byte("b"),
		ReceivedAt: time.Now(), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	rows, _ := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	id := rows[0].ID
	if err := st.MarkParsed(id, "parsed", "template", ""); err != nil {
		t.Fatal(err)
	}
	var attempts int
	if err := st.DB.QueryRow(`SELECT parse_attempts FROM ingest_log WHERE id=?`, id).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != 0 {
		t.Fatalf("successful parse must not consume the retry budget, attempts=%d", attempts)
	}
}
