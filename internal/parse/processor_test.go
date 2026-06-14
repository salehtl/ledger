package parse

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"ledger/internal/store"
)

func procTestStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

// build a base64 text/html DIB email around the given HTML body.
func dibEmail(htmlBody string) []byte {
	enc := base64.StdEncoding.EncodeToString([]byte(htmlBody))
	return []byte("From: DIB.notification@dib.ae\r\nSubject: DIB Notification\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\n" + enc)
}

func dibCascade() *Cascade {
	return &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{}, AI: DisabledExtractor{}}
}

func TestProcessorParsesUnparsedDIB(t *testing.T) {
	st := procTestStore(t)
	html := "<p>إشعار مشتريات</p><p>إشعار مشتريات بتاريخ 19-08-2025 16:18</p>" +
		"<p>المبلغ</p><p>AED 215.00</p><p>الدفع الى</p><p>DAPPER DAN GENTS SAL</p>"
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
		Subject: "DIB Notification", ParseStatus: "unparsed", RawBody: dibEmail(html), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, dibCascade())
	n, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("process: %v", err)
	}
	if n != 1 {
		t.Fatalf("processed = %d, want 1", n)
	}
	var cnt int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions WHERE merchant_raw='DAPPER DAN GENTS SAL' AND amount=21500").Scan(&cnt)
	if cnt != 1 {
		t.Errorf("expected 1 matching transaction, got %d", cnt)
	}
	var ps string
	st.DB.QueryRow("SELECT parse_status FROM ingest_log WHERE message_uid='u1'").Scan(&ps)
	if ps != "parsed" {
		t.Errorf("ingest parse_status = %q, want parsed", ps)
	}
}

func TestProcessorMarksUnparsedWhenNothingExtracts(t *testing.T) {
	st := procTestStore(t)
	html := "<p>hello, this is not a transaction email</p>"
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: "u2", FromAddr: "newsletter@spam.com",
		Subject: "hi", ParseStatus: "unparsed", RawBody: dibEmail(html), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, dibCascade())
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}
	var ps string
	st.DB.QueryRow("SELECT parse_status FROM ingest_log WHERE message_uid='u2'").Scan(&ps)
	if ps != "unparsed" {
		t.Errorf("parse_status = %q, want unparsed", ps)
	}
}
