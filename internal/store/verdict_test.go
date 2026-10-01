package store

import (
	"testing"
	"time"
)

func ingestRow(t *testing.T, st *Store, uid, status string) int64 {
	t.Helper()
	if _, err := st.InsertIngest(IngestRecord{MessageUID: uid, FromAddr: "a@dib.ae", Subject: "s-" + uid,
		ParseStatus: status, RawBody: []byte("body " + uid), ReceivedAt: time.Now(), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := st.DB.QueryRow(`SELECT id FROM ingest_log WHERE message_uid=?`, uid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestIngestVerdictRoundTrip(t *testing.T) {
	st := newTestStore(t)
	id := ingestRow(t, st, "u1", "unparsed")
	if err := st.SetIngestVerdict(id, "transaction", 0.93); err != nil {
		t.Fatal(err)
	}
	// MarkParsed must not clear the stored verdict.
	if err := st.MarkParsed(id, "unparsed", "", "template: no match"); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].AIVerdict != "transaction" || rows[0].AIVerdictConf != 0.93 {
		t.Fatalf("rows = %+v, want one row with verdict transaction 0.93", rows)
	}
}

func TestUnparsedVerdictCounts(t *testing.T) {
	st := newTestStore(t)
	a := ingestRow(t, st, "a", "unparsed")
	b := ingestRow(t, st, "b", "unparsed")
	ingestRow(t, st, "c", "unparsed") // unchecked
	d := ingestRow(t, st, "d", "unparsed")
	e := ingestRow(t, st, "e", "unparsed")
	ingestRow(t, st, "f", "parsed")
	_ = st.SetIngestVerdict(a, "transaction", 0.9)
	_ = st.SetIngestVerdict(b, "not_transaction", 0.8)
	_ = st.SetIngestVerdict(d, "not_transaction", 0.99)
	_ = st.MarkParsed(d, "ignored", "ai_check", "") // set aside
	_ = st.MarkParsed(e, "ignored", "template", "") // a parser's ignore, not the AI's
	got, err := st.UnparsedVerdictCounts()
	if err != nil {
		t.Fatal(err)
	}
	want := VerdictCounts{Transaction: 1, NotTransaction: 1, Unchecked: 1, SetAside: 1}
	if got != want {
		t.Errorf("counts = %+v, want %+v", got, want)
	}
}

func TestSelectTxnCheckSamples(t *testing.T) {
	st := newTestStore(t)
	for _, uid := range []string{"p1", "p2", "p3"} {
		ingestRow(t, st, uid, "parsed")
	}
	for _, uid := range []string{"i1", "i2"} {
		id := ingestRow(t, st, uid, "unparsed")
		_ = st.MarkParsed(id, "ignored", "template", "")
	}
	ai := ingestRow(t, st, "ai", "unparsed")
	_ = st.MarkParsed(ai, "ignored", "ai_check", "") // labelled by the classifier: excluded
	ingestRow(t, st, "u", "unparsed")                // no label: excluded

	got, err := st.SelectTxnCheckSamples(2)
	if err != nil {
		t.Fatal(err)
	}
	txn, not := 0, 0
	for _, s := range got {
		if s.Subject == "s-ai" || s.Subject == "s-u" {
			t.Errorf("unexpected sample %q", s.Subject)
		}
		if len(s.RawBody) == 0 {
			t.Errorf("sample %q has no body", s.Subject)
		}
		if s.IsTxn {
			txn++
		} else {
			not++
		}
	}
	if txn != 2 || not != 2 {
		t.Errorf("perClass 2: %d txn / %d not, want 2 / 2", txn, not)
	}
	all, _ := st.SelectTxnCheckSamples(10)
	if len(all) != 5 {
		t.Errorf("perClass 10: %d samples, want 5", len(all))
	}
	again, _ := st.SelectTxnCheckSamples(2)
	for i := range got {
		if got[i].Subject != again[i].Subject {
			t.Fatal("sampling must be repeatable")
		}
	}
}
