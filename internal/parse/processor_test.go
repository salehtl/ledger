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
	var ps, perr string
	st.DB.QueryRow("SELECT parse_status, COALESCE(parse_error,'') FROM ingest_log WHERE message_uid='u2'").Scan(&ps, &perr)
	if ps != "unparsed" {
		t.Errorf("parse_status = %q, want unparsed", ps)
	}
	if perr == "" {
		t.Error("parse_error empty; want the cascade's tier failures recorded")
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
	if _, err := st.InsertRule(store.RuleRow{
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

// ruleCategorizer builds a rules-only Categorizer over the seeded categories
// with one contains rule pattern→catName, and returns it plus the category ID.
func ruleCategorizer(t *testing.T, st *store.Store, pattern, catName string) (*categorize.Categorizer, int64) {
	t.Helper()
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatal(err)
	}
	var catID int64
	for _, c := range cats {
		if c.Name == catName {
			catID = c.ID
			break
		}
	}
	if catID == 0 {
		t.Fatalf("category %q not found in seeded categories", catName)
	}
	if _, err := st.InsertRule(store.RuleRow{
		MatchType: "contains", Pattern: pattern, CategoryID: catID, Priority: 100, Source: "manual",
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectActiveRules()
	if err != nil {
		t.Fatal(err)
	}
	rules := make([]categorize.Rule, len(rows))
	for i, r := range rows {
		rules[i] = categorize.Rule{MatchType: r.MatchType, Pattern: r.Pattern, CategoryID: r.CategoryID, Priority: r.Priority}
	}
	domainCats := make([]categorize.Category, len(cats))
	for i, c := range cats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	return categorize.New(rules, domainCats, categorize.DisabledAI{}, 0.85, false), catID
}

// A parser-flagged transfer whose merchant matches a rule must STAY status=transfer;
// auto-categorization must not flip it to confirmed (it would leak into the budget).
func TestProcessorTransferStatusSurvivesRuleMatch(t *testing.T) {
	st := procTestStore(t)
	cz, _ := ruleCategorizer(t, st, "internal transfer", "Shopping")

	cascade := &Cascade{Parsers: []BankParser{stubTransferParser{}}, Heuristic: HeuristicParser{}, AI: DisabledExtractor{}}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "xfer-rule", FromAddr: "stub@bank.com", Subject: "transfer",
		ParseStatus: "unparsed", RawBody: []byte("From: stub@bank.com\r\nSubject: transfer\r\n\r\ntransfer"),
		CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, cascade)
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) { return cz, true })
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := st.DB.QueryRow(`SELECT status FROM transactions LIMIT 1`).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "transfer" {
		t.Errorf("status = %q, want transfer (rule match must not overwrite transfer status)", status)
	}
}

// A heuristic-tier extraction is a guess (fixed 0.4 confidence); a rule match may
// attach the category but must not auto-confirm the transaction.
func TestProcessorHeuristicTierNeverAutoConfirms(t *testing.T) {
	st := procTestStore(t)
	cz, shoppingID := ruleCategorizer(t, st, "starbucks", "Shopping")

	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "heur-1", FromAddr: "alerts@unknownbank.com", Subject: "alert",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: alerts@unknownbank.com\r\nSubject: alert\r\n\r\nPayment to STARBUCKS AED 50.00 on 19-08-2025"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, dibCascade())
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) { return cz, true })
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}
	var status string
	var catID *int64
	if err := st.DB.QueryRow(`SELECT status, category_id FROM transactions LIMIT 1`).Scan(&status, &catID); err != nil {
		t.Fatal(err)
	}
	if status != "needs_review" {
		t.Errorf("status = %q, want needs_review (heuristic extraction must not auto-confirm)", status)
	}
	if catID == nil || *catID != shoppingID {
		t.Errorf("category_id = %v, want %d (category should still be attached)", catID, shoppingID)
	}
}

// An AI-tier extraction must always land in review, even when its merchant
// matches an existing rule (CLAUDE.md: AI extractions are never auto-trusted).
func TestProcessorAITierNeverAutoConfirms(t *testing.T) {
	st := procTestStore(t)
	cz, shoppingID := ruleCategorizer(t, st, "starbucks", "Shopping")

	cascade := &Cascade{
		Parsers:   []BankParser{DIBParser{}},
		Heuristic: HeuristicParser{},
		AI: stubExtractor{p: ParsedTxn{
			PostedAt: time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC), AmountFils: 5000,
			Currency: "AED", Direction: "debit", MerchantRaw: "STARBUCKS", Confidence: 0.6,
		}},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "ai-1", FromAddr: "alerts@unknownbank.com", Subject: "alert",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: alerts@unknownbank.com\r\nSubject: alert\r\n\r\nno numbers here"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, cascade)
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) { return cz, true })
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}
	var status string
	var catID *int64
	if err := st.DB.QueryRow(`SELECT status, category_id FROM transactions LIMIT 1`).Scan(&status, &catID); err != nil {
		t.Fatal(err)
	}
	if status != "needs_review" {
		t.Errorf("status = %q, want needs_review (AI extraction must never auto-confirm)", status)
	}
	if catID == nil || *catID != shoppingID {
		t.Errorf("category_id = %v, want %d (category should still be attached)", catID, shoppingID)
	}
}

// countingAICat records categorization calls and always answers confidently.
type countingAICat struct{ calls *int }

func (c countingAICat) Categorize(context.Context, string, []categorize.Category) (string, float64, error) {
	*c.calls++
	return "Shopping", 0.99, nil
}

// stubEmptyMerchantParser extracts a valid transaction with no merchant text.
type stubEmptyMerchantParser struct{}

func (stubEmptyMerchantParser) Bank() string                { return "stub" }
func (stubEmptyMerchantParser) Matches(from, _ string) bool { return from == "stub@bank.com" }
func (stubEmptyMerchantParser) Parse(_ string) (ParsedTxn, error) {
	return ParsedTxn{
		PostedAt: time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC), AmountFils: 10000,
		Currency: "AED", Direction: "debit", MerchantRaw: "", Confidence: 0.97,
	}, nil
}

// A transaction with no merchant text must skip categorization entirely: no AI
// call (nothing meaningful to classify) and, above all, no write-back rule.
func TestProcessorSkipsCategorizationForEmptyMerchant(t *testing.T) {
	st := procTestStore(t)
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatal(err)
	}
	domainCats := make([]categorize.Category, len(cats))
	for i, c := range cats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	calls := 0
	cz := categorize.New(nil, domainCats, countingAICat{calls: &calls}, 0.85, true)

	cascade := &Cascade{Parsers: []BankParser{stubEmptyMerchantParser{}}, Heuristic: HeuristicParser{}, AI: DisabledExtractor{}}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "empty-merchant", FromAddr: "stub@bank.com", Subject: "txn",
		ParseStatus: "unparsed", RawBody: []byte("From: stub@bank.com\r\nSubject: txn\r\n\r\nbody"),
		CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, cascade)
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) { return cz, true })
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	if calls != 0 {
		t.Errorf("AI categorizer called %d times for empty merchant, want 0", calls)
	}
	var ruleCnt int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM rules`).Scan(&ruleCnt); err != nil {
		t.Fatal(err)
	}
	if ruleCnt != 0 {
		t.Errorf("rules written = %d, want 0 (an empty pattern would match everything)", ruleCnt)
	}
	var status string
	var catID *int64
	if err := st.DB.QueryRow(`SELECT status, category_id FROM transactions LIMIT 1`).Scan(&status, &catID); err != nil {
		t.Fatal(err)
	}
	if status != "needs_review" || catID != nil {
		t.Errorf("status/category = %q/%v, want needs_review/nil", status, catID)
	}
}

// The same new merchant appearing twice in one batch must cost one AI call and
// write one rule — the categorizer's rule snapshot predates the write-back, so
// without a batch cache the second row re-asks the AI and duplicates the rule.
func TestProcessorCategorizesRepeatedMerchantOncePerBatch(t *testing.T) {
	st := procTestStore(t)
	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatal(err)
	}
	domainCats := make([]categorize.Category, len(cats))
	for i, c := range cats {
		domainCats[i] = categorize.Category{ID: c.ID, Name: c.Name, Kind: c.Kind, Bucket: c.Bucket}
	}
	calls := 0
	cz := categorize.New(nil, domainCats, countingAICat{calls: &calls}, 0.85, true)

	html := func(amount string) string {
		return "<p>إشعار مشتريات</p><p>إشعار مشتريات بتاريخ 19-08-2025 16:18</p>" +
			"<p>المبلغ</p><p>AED " + amount + "</p><p>الدفع الى</p><p>STARBUCKS</p>"
	}
	for i, amount := range []string{"10.00", "20.00"} {
		if _, err := st.InsertIngest(store.IngestRecord{
			MessageUID: "batch-" + string(rune('a'+i)), FromAddr: "DIB.notification@dib.ae",
			Subject: "DIB Notification", ParseStatus: "unparsed",
			RawBody: dibEmail(html(amount)), CreatedAt: time.Now(),
		}); err != nil {
			t.Fatal(err)
		}
	}
	p := NewProcessor(st, dibCascade())
	p.SetCategorizerProvider(func(ctx context.Context) (*categorize.Categorizer, bool) { return cz, true })
	if _, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}

	if calls != 1 {
		t.Errorf("AI calls = %d, want 1 (second row must hit the batch cache)", calls)
	}
	var ruleCnt int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM rules`).Scan(&ruleCnt); err != nil {
		t.Fatal(err)
	}
	if ruleCnt != 1 {
		t.Errorf("rules = %d, want 1 (no duplicate write-back)", ruleCnt)
	}
	var uncat int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE category_id IS NULL`).Scan(&uncat); err != nil {
		t.Fatal(err)
	}
	if uncat != 0 {
		t.Errorf("%d transactions left uncategorized; the cached result must still apply", uncat)
	}
}

// ProcessPending's return value is "rows that produced a transaction" — a
// duplicate-fingerprint row (same email delivered twice) must not count.
func TestProcessPendingCountExcludesDuplicates(t *testing.T) {
	st := procTestStore(t)
	html := "<p>إشعار مشتريات</p><p>إشعار مشتريات بتاريخ 19-08-2025 16:18</p>" +
		"<p>المبلغ</p><p>AED 215.00</p><p>الدفع الى</p><p>DAPPER DAN GENTS SAL</p>"
	for _, uid := range []string{"dup-1", "dup-2"} {
		if _, err := st.InsertIngest(store.IngestRecord{MessageUID: uid, FromAddr: "DIB.notification@dib.ae",
			Subject: "DIB Notification", ParseStatus: "unparsed", RawBody: dibEmail(html), CreatedAt: time.Now()}); err != nil {
			t.Fatal(err)
		}
	}
	p := NewProcessor(st, dibCascade())
	n, err := p.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("n = %d, want 1 (identical second email dedups by fingerprint)", n)
	}
}

// Reprocessing a low_confidence row must not create a second transaction when
// the re-run extracts slightly different fields (e.g. AI wording drift or a new
// template producing a different merchant string → different fingerprint).
func TestProcessorReprocessDoesNotDuplicateTransaction(t *testing.T) {
	st := procTestStore(t)
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID: "repro-1", FromAddr: "alerts@unknownbank.com", Subject: "alert",
		ParseStatus: "unparsed",
		RawBody:     []byte("From: alerts@unknownbank.com\r\nSubject: alert\r\n\r\nno numbers here"),
		CreatedAt:   time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	extract := func(merchant string) *Cascade {
		return &Cascade{Parsers: []BankParser{DIBParser{}}, Heuristic: HeuristicParser{},
			AI: stubExtractor{p: ParsedTxn{
				PostedAt: time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC), AmountFils: 5000,
				Currency: "AED", Direction: "debit", MerchantRaw: merchant, Confidence: 0.6,
			}}}
	}

	// First pass: AI tier extracts "Amazon AE" → low_confidence + one transaction.
	p1 := NewProcessor(st, extract("Amazon AE"))
	if _, err := p1.ProcessPending(context.Background(), store.SelectForParseOpts{OnlyUnparsed: true}); err != nil {
		t.Fatal(err)
	}
	// Reprocess: the same email now extracts "AMAZON.AE" (different fingerprint).
	p2 := NewProcessor(st, extract("AMAZON.AE"))
	if _, err := p2.Reprocess(context.Background(), ""); err != nil {
		t.Fatal(err)
	}

	var cnt int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions`).Scan(&cnt); err != nil {
		t.Fatal(err)
	}
	if cnt != 1 {
		t.Errorf("transaction count = %d, want 1 (one email must never yield two transactions)", cnt)
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
	items, err := st.SelectTransactions("needs_review", "", "", "")
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

// fwdEmail builds a base64 text/html email whose envelope is the iCloud
// forwarder but whose body inline-forwards a DIB notification.
func fwdEmail() []byte {
	html := "<html><body>" +
		"<div>Sent from my iPhone</div>" +
		"<div><br>Begin forwarded message:<br><br></div>" +
		"<blockquote><div>" +
		"<b>From:</b> DIB Notification &lt;DIB.notification@dib.ae&gt;<br>" +
		"<b>Date:</b> 18 June 2026 at 7:33:38 PM GST<br>" +
		"<b>To:</b> salehtl@icloud.com<br>" +
		"<b>Subject:</b> <b>DIB Notification</b><br><br>" +
		"</div></blockquote>" +
		"<blockquote><div>" +
		"معاملة بطاقة ائتمان<br>" +
		"إشعار مشتريات بتاريخ 18-06-2026 18:03<br>" +
		"رقم البطاقة<br>462467XXXXXX7502<br>" +
		"المبلغ<br>AED 124.00<br>" +
		"الدفع الى<br>NOIRO CAFE<br>" +
		"</div></blockquote></body></html>"
	enc := base64.StdEncoding.EncodeToString([]byte(html))
	return []byte("From: Saleh Lootah <salehtl@icloud.com>\r\nSubject: Fwd: DIB Notification\r\n" +
		"MIME-Version: 1.0\r\nContent-Type: text/html; charset=\"utf-8\"\r\n" +
		"Content-Transfer-Encoding: base64\r\n\r\n" + enc)
}

func TestProcessorParsesForwardedDIBViaTemplate(t *testing.T) {
	st := procTestStore(t)
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: "fwd1", FromAddr: "Saleh Lootah <salehtl@icloud.com>",
		Subject: "Fwd: DIB Notification", ParseStatus: "unparsed", RawBody: fwdEmail(), CreatedAt: time.Now()}); err != nil {
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
	// Correct merchant + amount, NOT the forwarder ("salehtl").
	var cnt int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions WHERE merchant_raw='NOIRO CAFE' AND amount=12400 AND direction='debit'").Scan(&cnt)
	if cnt != 1 {
		t.Errorf("expected 1 NOIRO CAFE/12400 transaction, got %d", cnt)
	}
	// Must be the high-confidence template tier, and ingest marked parsed.
	var ps, tier string
	st.DB.QueryRow("SELECT parse_status, COALESCE(parse_tier,'') FROM ingest_log WHERE message_uid='fwd1'").Scan(&ps, &tier)
	if ps != "parsed" || tier != "template" {
		t.Errorf("ingest status/tier = %q/%q, want parsed/template", ps, tier)
	}
	// Guard against the original bug.
	var bad int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions WHERE merchant_raw='salehtl'").Scan(&bad)
	if bad != 0 {
		t.Errorf("found %d transactions with forwarder as merchant; preamble not stripped", bad)
	}
}

// TestProcessorIsTransferLegArrivingSecondNetsCounterpart covers the arrival
// order the old guard missed: the credit leg is already in the DB as
// needs_review, then the parser-flagged (IsTransfer) debit leg arrives. Both
// must end up status=transfer.
func TestProcessorIsTransferLegArrivingSecondNetsCounterpart(t *testing.T) {
	st := procTestStore(t)

	// Pre-existing credit leg (e.g. the receiving account's email parsed first).
	// stubTransferParser emits: 2025-08-19 00:00 UTC, 10000 fils, AED, debit.
	if _, created, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 0, 30, 0, 0, time.UTC),
		AmountFils:  10000,
		Currency:    "AED",
		Direction:   "credit",
		MerchantRaw: "Incoming Transfer",
		Status:      "needs_review",
	}); err != nil || !created {
		t.Fatalf("seed credit leg: created=%v err=%v", created, err)
	}

	// Now the IsTransfer debit email arrives.
	cascade := &Cascade{
		Parsers:   []BankParser{stubTransferParser{}},
		Heuristic: HeuristicParser{},
		AI:        DisabledExtractor{},
	}
	if _, err := st.InsertIngest(store.IngestRecord{
		MessageUID:  "istransfer-second",
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

	var count int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status='transfer'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Errorf("transfer-status count = %d, want 2 (IsTransfer leg arriving second must net its counterpart)", count)
	}
}
