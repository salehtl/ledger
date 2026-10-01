package parse

import (
	"context"
	"testing"
	"time"

	"ledger/internal/store"
)

func openStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func addIngest(t *testing.T, st *store.Store, uid, status string) int64 {
	t.Helper()
	if _, err := st.InsertIngest(store.IngestRecord{MessageUID: uid, FromAddr: "x@y.z", Subject: "s",
		ParseStatus: status, RawBody: simpleEmail("hello " + uid), ReceivedAt: time.Now(), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := st.DB.QueryRow(`SELECT id FROM ingest_log WHERE message_uid=?`, uid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func rowState(t *testing.T, st *store.Store, id int64) (status, tier, verdict string) {
	t.Helper()
	if err := st.DB.QueryRow(`SELECT parse_status, COALESCE(parse_tier,''), COALESCE(ai_verdict,'')
		FROM ingest_log WHERE id=?`, id).Scan(&status, &tier, &verdict); err != nil {
		t.Fatal(err)
	}
	return
}

var manual = store.SelectForParseOpts{OnlyUnparsed: false}

// fixedParser stands in for a template fixed after the AI check set an email
// aside: it now reads the email addIngest writes.
type fixedParser struct{}

func (fixedParser) Bank() string                      { return "fixed" }
func (fixedParser) Matches(from, subject string) bool { return from == "x@y.z" }
func (fixedParser) Parse(string, string) (ParsedTxn, error) {
	return ParsedTxn{PostedAt: time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC), AmountFils: 1000,
		Currency: "AED", Direction: DirectionDebit, MerchantRaw: "CARREFOUR", Tier: TierTemplate, Confidence: 0.9}, nil
}

func txnCount(t *testing.T, st *store.Store, ingestID int64) int {
	t.Helper()
	var n int
	if err := st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE ingest_id=?`, ingestID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// setAside runs the AI check over a fresh row and requires it set aside.
func setAside(t *testing.T, st *store.Store, check stubCheck) int64 {
	t.Helper()
	id := addIngest(t, st, "u1", "unparsed")
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95, Check: check})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, tier, _ := rowState(t, st, id); s != StatusIgnored || tier != TierAICheck {
		t.Fatalf("setup: row = %s/%s, want ignored/ai_check", s, tier)
	}
	return id
}

// A parser fixed after the set-aside reads the email on a manual reprocess,
// and the missing transaction backfills.
func TestReprocessBackfillsSetAsideRowWhenParserFixed(t *testing.T) {
	st := openStore(t)
	calls := 0
	check := stubCheck{v: TxnVerdict{VerdictNotTxn, 0.99}, calls: &calls}
	id := setAside(t, st, check)
	fixed := NewProcessor(st, &Cascade{Parsers: []BankParser{fixedParser{}}, Heuristic: HeuristicParser{},
		IgnoreAt: 0.95, Check: check})
	n, err := fixed.Reprocess(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || txnCount(t, st, id) != 1 {
		t.Errorf("created %d, %d transactions for the row; want 1 and 1", n, txnCount(t, st, id))
	}
	if s, tier, _ := rowState(t, st, id); s != StatusParsed || tier != TierTemplate {
		t.Errorf("row = %s/%s, want parsed/template", s, tier)
	}
	if calls != 1 {
		t.Errorf("provider asked %d times, want 1 (the reprocess makes no call)", calls)
	}
}

// A set-aside row that already owns a transaction never gets a second one.
func TestReprocessSetAsideRowWithTransactionGetsNoSecond(t *testing.T) {
	st := openStore(t)
	id := setAside(t, st, stubCheck{v: TxnVerdict{VerdictNotTxn, 0.99}})
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC), AmountFils: 5000, Currency: "AED",
		Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Source: "email", IngestID: id,
	}); err != nil {
		t.Fatal(err)
	}
	fixed := NewProcessor(st, &Cascade{Parsers: []BankParser{fixedParser{}}, Heuristic: HeuristicParser{}, IgnoreAt: 0.95})
	n, err := fixed.Reprocess(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 || txnCount(t, st, id) != 1 {
		t.Errorf("created %d, %d transactions for the row; want 0 and 1", n, txnCount(t, st, id))
	}
	if s, _, _ := rowState(t, st, id); s != StatusParsed {
		t.Errorf("status = %s, want parsed", s)
	}
}

// A raised threshold returns a set-aside row to unparsed on a manual
// reprocess, from the stored verdict alone.
func TestReprocessReturnsSetAsideRowUnderRaisedThreshold(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	calls := 0
	casc := &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.96}, calls: &calls}}
	p := NewProcessor(st, casc)
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, tier, _ := rowState(t, st, id); s != StatusIgnored || tier != TierAICheck {
		t.Fatalf("0.96 under a 0.95 threshold: %s/%s, want ignored/ai_check", s, tier)
	}
	casc.IgnoreAt = 0.98
	if _, err := p.Reprocess(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if s, _, v := rowState(t, st, id); s != StatusUnparsed || v != VerdictNotTxn {
		t.Errorf("0.96 under a 0.98 threshold: %s/%s, want unparsed/not_transaction", s, v)
	}
	if calls != 1 {
		t.Errorf("provider asked %d times, want 1", calls)
	}
}

func TestProcessorStoresVerdictAndIgnores(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.99}}})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, tier, v := rowState(t, st, id); s != StatusIgnored || tier != TierAICheck || v != VerdictNotTxn {
		t.Errorf("row = %s/%s/%s, want ignored/ai_check/not_transaction", s, tier, v)
	}
}

func TestProcessorReusesStoredVerdict(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	calls := 0
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictTxn, 0.9}, calls: &calls}})
	for i := 0; i < 2; i++ {
		if _, err := p.ProcessPending(context.Background(), manual); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Errorf("provider asked %d times, want 1 (the second run replays the stored verdict)", calls)
	}
	if s, _, v := rowState(t, st, id); s != StatusUnparsed || v != VerdictTxn {
		t.Errorf("row = %s/%s, want unparsed/transaction", s, v)
	}
}

func TestProcessorReappliesStoredVerdictUnderNewThreshold(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	calls := 0
	casc := &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 0.9}, calls: &calls}}
	p := NewProcessor(st, casc)
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := rowState(t, st, id); s != StatusUnparsed {
		t.Fatalf("0.90 under a 0.95 threshold: status %s, want unparsed", s)
	}
	casc.IgnoreAt = 0.85
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, tier, _ := rowState(t, st, id); s != StatusIgnored || tier != TierAICheck {
		t.Errorf("0.90 under a 0.85 threshold: %s/%s, want ignored/ai_check", s, tier)
	}
	if calls != 1 {
		t.Errorf("provider asked %d times, want 1", calls)
	}
}

func TestProcessorNeverChecksLowConfidenceRows(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "low_confidence")
	calls := 0
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}, calls: &calls}})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Errorf("checked a low_confidence row %d times, want 0", calls)
	}
	if s, _, _ := rowState(t, st, id); s == StatusIgnored {
		t.Error("a low_confidence row was set aside")
	}
}

// A row demoted to unparsed after an old AI extraction still owns a
// transaction. The AI check must never hide it.
func TestProcessorAICheckNeverHidesRowWithTransaction(t *testing.T) {
	st := openStore(t)
	id := addIngest(t, st, "u1", "unparsed")
	if _, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt: time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC), AmountFils: 5000, Currency: "AED",
		Direction: "debit", MerchantRaw: "SPINNEYS", Status: "needs_review", Source: "email", IngestID: id,
	}); err != nil {
		t.Fatal(err)
	}
	p := NewProcessor(st, &Cascade{Heuristic: HeuristicParser{}, IgnoreAt: 0.95,
		Check: stubCheck{v: TxnVerdict{VerdictNotTxn, 1}}})
	if _, err := p.ProcessPending(context.Background(), manual); err != nil {
		t.Fatal(err)
	}
	if s, _, _ := rowState(t, st, id); s == StatusIgnored {
		t.Error("a row with a transaction was set aside")
	}
}
