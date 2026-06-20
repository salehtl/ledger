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

	p := NewProcessor(st, dibCascade())
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		return cat, true
	})
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

func TestProcessorSetsTransferStatusFromIsTransfer(t *testing.T) {
	st := procTestStore(t)

	cascade := &Cascade{
		Parsers:   []BankParser{stubTransferParser{}},
		Heuristic: HeuristicParser{},
		AI:        DisabledExtractor{},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "xfer-1",
		FromAddr:    "stub@bank.com",
		Subject:     "transfer",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: stub@bank.com\r\nSubject: transfer\r\n\r\ntransfer"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	p := NewProcessor(st, cascade)
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	var status string
	if err := st.DB.QueryRow(`SELECT status FROM transactions LIMIT 1`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "transfer" {
		t.Errorf("status = %q, want transfer (IsTransfer=true should set status=transfer)", status)
	}
}

// stubTransferParser is a BankParser that always returns IsTransfer=true.
type stubTransferParser struct{}

func (stubTransferParser) Bank() string { return "stub" }
func (stubTransferParser) Matches(from, subject string) bool {
	return from == "stub@bank.com"
}
func (stubTransferParser) Parse(_ string) (ParsedTxn, error) {
	return ParsedTxn{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  10000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "Internal Transfer",
		IsTransfer:  true,
		Confidence:  1.0,
	}, nil
}

func TestProcessorCategorizerProvider(t *testing.T) {
	// A processor with NO static categorizer but a provider that returns (nil,false)
	// must not categorize: transactions stay needs_review, uncategorized.
	st := procTestStore(t)
	cascade := dibCascade()
	p := NewProcessor(st, cascade)

	calls := 0
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) {
		calls++
		return nil, false // auto-categorize OFF
	})

	// Seed one parseable DIB ingest row.
	html := "<p>إشعار مشتريات</p><p>إشعار مشتريات بتاريخ 19-08-2025 16:18</p>" +
		"<p>المبلغ</p><p>AED 50.00</p><p>الدفع الى</p><p>STARBUCKS</p>"
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "prov-test-1", FromAddr: "DIB.notification@dib.ae",
		Subject: "DIB Notification", ParseStatus: "unparsed",
		RawBody: dibEmail(html), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatalf("process: %v", err)
	}
	if calls != 1 {
		t.Fatalf("provider should be resolved once per batch, called %d times", calls)
	}
	items, err := st.SelectTransactions("needs_review", "", "")
	if err != nil {
		t.Fatalf("SelectTransactions needs_review: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("expected an uncategorized needs_review transaction")
	}
	for _, it := range items {
		if it.CategoryID != nil {
			t.Fatalf("auto_categorize OFF must leave category unset, got %v", it.CategoryID)
		}
	}
}

func TestProcessorCrossMatchTransfer(t *testing.T) {
	st := procTestStore(t)

	// Insert a credit "leg" transaction directly as needs_review.
	_, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 12, 0, 0, 0, time.UTC),
		AmountFils:  50000,
		Currency:    "AED",
		Direction:   "credit",
		MerchantRaw: "DIB Transfer",
		Status:      "needs_review",
		Source:      "email",
	})
	if err != nil {
		t.Fatal(err)
	}

	// Process the debit leg via the processor — it should cross-match the credit.
	cascade := &Cascade{
		Parsers:   []BankParser{stubDebitLegParser{}},
		Heuristic: HeuristicParser{},
		AI:        DisabledExtractor{},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "debit-leg",
		FromAddr:    "debit@bank.com",
		Subject:     "transfer",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: debit@bank.com\r\nSubject: transfer\r\n\r\nbody"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	p := NewProcessor(st, cascade)
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	// Both the credit leg and the new debit should be status=transfer.
	var count int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status = 'transfer'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("transfer-status count = %d, want 2 (both legs auto-matched)", count)
	}
}

// stubDebitLegParser returns a debit transaction matching the credit leg above (same amount, within 2h).
type stubDebitLegParser struct{}

func (stubDebitLegParser) Bank() string { return "debit" }
func (stubDebitLegParser) Matches(from, _ string) bool {
	return from == "debit@bank.com"
}
func (stubDebitLegParser) Parse(_ string) (ParsedTxn, error) {
	return ParsedTxn{
		PostedAt:    time.Date(2025, 8, 19, 12, 30, 0, 0, time.UTC), // 30 min after credit
		AmountFils:  50000,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DIB Transfer",
		Confidence:  1.0,
	}, nil
}
