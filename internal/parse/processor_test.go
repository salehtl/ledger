package parse

import (
	"context"
	"encoding/base64"
	"testing"
	"time"

	"ledger/internal/categorize"
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

func TestProcessorCategorizes(t *testing.T) {
	st := procTestStore(t)
	// Seed a rule: "DAPPER DAN" → Shopping
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatal(err)
	}
	var shoppingID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			shoppingID = c.ID
			break
		}
	}
	if shoppingID == 0 {
		t.Fatal("Shopping category not found in seeded categories")
	}
	if err := st.InsertRule(store.RuleRow{
		MatchType:  "contains",
		Pattern:    "DAPPER",
		CategoryID: shoppingID,
		Priority:   100,
		Source:     "manual",
	}); err != nil {
		t.Fatal(err)
	}

	// Build categorizer from store data
	rules, _ := st.SelectRules()
	domainRules := make([]categorize.Rule, len(rules))
	for i, r := range rules {
		domainRules[i] = categorize.Rule{
			MatchType:  r.MatchType,
			Pattern:    r.Pattern,
			CategoryID: r.CategoryID,
			Priority:   r.Priority,
		}
	}
	domainCats := make([]categorize.Category, len(cats))
	for i, c := range cats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	cat := categorize.New(domainRules, domainCats, categorize.DisabledAI{}, 0.85, false)

	// Ingest a DIB card purchase with merchant "DAPPER DAN GENTS SAL"
	html := "<p>إشعار مشتريات</p><p>إشعار مشتريات بتاريخ 19-08-2025 16:18</p>" +
		"<p>المبلغ</p><p>AED 215.00</p><p>الدفع الى</p><p>DAPPER DAN GENTS SAL</p>"
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
		Subject: "DIB Notification", ParseStatus: "unparsed",
		RawBody: dibEmail(html), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	p := NewProcessorWithCategorizer(st, dibCascade(), cat)
	n, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("ProcessPending: %v", err)
	}
	if n != 1 {
		t.Fatalf("n = %d, want 1", n)
	}

	// Verify transaction was categorized as confirmed with Shopping category
	var status string
	var catIDGot *int64
	if err := st.DB.QueryRow("SELECT status, category_id FROM transactions LIMIT 1").Scan(&status, &catIDGot); err != nil {
		t.Fatalf("query tx: %v", err)
	}
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}
	if catIDGot == nil || *catIDGot != shoppingID {
		t.Errorf("category_id = %v, want %d", catIDGot, shoppingID)
	}
}
