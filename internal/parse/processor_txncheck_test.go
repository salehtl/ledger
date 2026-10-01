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
