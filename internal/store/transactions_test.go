package store

import (
	"testing"
	"time"
)

func mustParseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func txnRow() TransactionRow {
	return TransactionRow{
		PostedAt:    time.Date(2025, 8, 19, 0, 0, 0, 0, time.UTC),
		AmountFils:  21500,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "DAPPER DAN GENTS SAL",
		Last4:       "1502",
		Status:      "needs_review",
		Confidence:  0.97,
		IngestID:    1,
	}
}

func TestTransactionIDByIngest(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "byingest", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	if err := st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='byingest'").Scan(&ingestID); err != nil {
		t.Fatal(err)
	}

	if _, found, err := st.TransactionIDByIngest(ingestID); err != nil || found {
		t.Fatalf("before insert: found=%v err=%v, want false/nil", found, err)
	}

	row := txnRow()
	row.IngestID = ingestID
	txID, created, err := st.InsertTransaction(row)
	if err != nil || !created {
		t.Fatalf("insert: created=%v err=%v", created, err)
	}

	got, found, err := st.TransactionIDByIngest(ingestID)
	if err != nil || !found {
		t.Fatalf("after insert: found=%v err=%v, want true/nil", found, err)
	}
	if got != txID {
		t.Errorf("id = %d, want %d", got, txID)
	}
}

func TestInsertTransactionAndFingerprintDedup(t *testing.T) {
	st := newTestStore(t)
	// Seed a real ingest_log row so transactions.ingest_id satisfies the FK.
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "seed", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	if err := st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='seed'").Scan(&ingestID); err != nil {
		t.Fatal(err)
	}
	row := txnRow()
	row.IngestID = ingestID

	_, ins1, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatalf("insert1: %v", err)
	}
	if !ins1 {
		t.Error("first insert should be new")
	}
	_, ins2, err := st.InsertTransaction(row) // identical → same fingerprint
	if err != nil {
		t.Fatalf("insert2: %v", err)
	}
	if ins2 {
		t.Error("duplicate (same fingerprint) must not insert again")
	}
	var n int
	st.DB.QueryRow("SELECT COUNT(*) FROM transactions").Scan(&n)
	if n != 1 {
		t.Errorf("transactions count = %d, want 1", n)
	}
	// Linkage is persisted.
	var linked int64
	st.DB.QueryRow("SELECT ingest_id FROM transactions LIMIT 1").Scan(&linked)
	if linked != ingestID {
		t.Errorf("ingest_id = %d, want %d", linked, ingestID)
	}
}

func seedConfirmedTxn(t *testing.T, st *Store) int64 {
	t.Helper()
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "arch-seed", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var ingestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='arch-seed'").Scan(&ingestID)
	row := txnRow()
	row.IngestID = ingestID
	row.PostedAt = time.Date(2026, 6, 10, 0, 0, 0, 0, time.UTC)
	id, _, err := st.InsertTransaction(row)
	if err != nil {
		t.Fatal(err)
	}
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Shopping" {
			catID = c.ID
		}
	}
	if err := st.UpdateTransactionCategory(id, catID, "confirmed"); err != nil {
		t.Fatal(err)
	}
	return id
}

func statusOf(t *testing.T, st *Store, id int64) string {
	t.Helper()
	var s string
	if err := st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestArchiveAndRestoreRoundTrip(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if got := statusOf(t, st, id); got != "archived" {
		t.Fatalf("status after archive = %q, want archived", got)
	}

	if err := st.RestoreTransaction(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := statusOf(t, st, id); got != "confirmed" {
		t.Fatalf("status after restore = %q, want confirmed (prior status preserved)", got)
	}
}

func TestArchiveHidesFromBudget(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	before, _ := st.SelectMonthSpend("2026-06", false)
	if len(before) != 1 {
		t.Fatalf("pre-archive month spend rows = %d, want 1", len(before))
	}
	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatal(err)
	}
	after, _ := st.SelectMonthSpend("2026-06", false)
	if len(after) != 0 {
		t.Fatalf("archived txn still counted in budget: %d rows", len(after))
	}
}

func TestRestoreNonArchivedIsNoOp(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)
	if err := st.RestoreTransaction(id); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if got := statusOf(t, st, id); got != "confirmed" {
		t.Fatalf("status = %q, want unchanged confirmed", got)
	}
}

func TestSelectForParseAndMarkParsed(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u1", FromAddr: "DIB.notification@dib.ae",
		Subject: "n", ParseStatus: "unparsed", RawBody: []byte("raw1"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "u2", FromAddr: "x@y.com",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw2"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if len(rows) != 1 || rows[0].FromAddr != "DIB.notification@dib.ae" {
		t.Fatalf("got %d rows: %+v", len(rows), rows)
	}
	if err := st.MarkParsed(rows[0].ID, "parsed", "template", ""); err != nil {
		t.Fatalf("mark: %v", err)
	}
	rows2, _ := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if len(rows2) != 0 {
		t.Errorf("expected 0 unparsed after mark, got %d", len(rows2))
	}
}

func TestSelectTransactionsExcludesArchivedByDefault(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)
	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatal(err)
	}

	all, err := st.SelectTransactions("", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 0 {
		t.Fatalf("default list returned archived row: %d items", len(all))
	}

	arch, err := st.SelectTransactions("archived", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(arch) != 1 {
		t.Fatalf("status=archived returned %d items, want 1", len(arch))
	}
}

func TestInsertManualTransactionConfirmedWithCategory(t *testing.T) {
	st := newTestStore(t)
	cats, _ := st.SelectCategories()
	var catID int64
	for _, c := range cats {
		if c.Name == "Groceries" {
			catID = c.ID
		}
	}
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC),
		AmountFils:  4250,
		Direction:   "debit",
		MerchantRaw: "Corner Shop",
		CategoryID:  catID,
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	var status, source, currency string
	st.DB.QueryRow("SELECT status, source, currency FROM transactions WHERE id=?", id).
		Scan(&status, &source, &currency)
	if status != "confirmed" {
		t.Errorf("status = %q, want confirmed", status)
	}
	if source != "manual" {
		t.Errorf("source = %q, want manual", source)
	}
	if currency != "AED" {
		t.Errorf("currency = %q, want default AED", currency)
	}
}

func TestInsertManualTransactionUncategorizedGoesToReview(t *testing.T) {
	st := newTestStore(t)
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt:    time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC),
		AmountFils:  1000,
		Direction:   "debit",
		MerchantRaw: "Mystery",
	})
	if err != nil {
		t.Fatal(err)
	}
	var status string
	st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&status)
	if status != "needs_review" {
		t.Errorf("status = %q, want needs_review", status)
	}
}

func TestInsertManualTransactionAllowsDuplicateFingerprint(t *testing.T) {
	st := newTestStore(t)
	m := ManualTxn{
		PostedAt:    time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC),
		AmountFils:  1500,
		Direction:   "debit",
		MerchantRaw: "Coffee",
	}
	if _, err := st.InsertManualTransaction(m); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if _, err := st.InsertManualTransaction(m); err != nil {
		t.Fatalf("second identical manual insert should not collide: %v", err)
	}
	rows, _ := st.SelectTransactions("", "", "", "")
	if len(rows) != 2 {
		t.Fatalf("want 2 manual rows, got %d", len(rows))
	}
}

// TestClearAllCategorizationLeavesArchived verifies that ClearAllCategorization
// never touches archived rows — an archived transaction must remain archived.
func TestClearAllCategorizationLeavesArchived(t *testing.T) {
	st := newTestStore(t)
	id := seedConfirmedTxn(t, st)

	if err := st.ArchiveTransaction(id); err != nil {
		t.Fatalf("archive: %v", err)
	}
	if got := statusOf(t, st, id); got != "archived" {
		t.Fatalf("pre-clear status = %q, want archived", got)
	}

	if _, err := st.ClearAllCategorization(); err != nil {
		t.Fatalf("ClearAllCategorization: %v", err)
	}

	if got := statusOf(t, st, id); got != "archived" {
		t.Errorf("post-clear status = %q, want archived (archived rows must not be touched)", got)
	}
}

// TestFindTransferMatchSkipsArchived verifies that FindTransferMatch never
// returns an archived row as a candidate — an archived row must not be
// silently promoted to a transfer leg.
func TestFindTransferMatchSkipsArchived(t *testing.T) {
	st := newTestStore(t)

	// Seed two ingest rows: one for the candidate (to be archived), one for
	// the calling transaction so the FK is satisfied.
	if _, err := st.InsertIngest(IngestRecord{MessageUID: "transfer-cand", FromAddr: "bank@test.com",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var candIngestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='transfer-cand'").Scan(&candIngestID)

	if _, err := st.InsertIngest(IngestRecord{MessageUID: "transfer-caller", FromAddr: "bank@test.com",
		Subject: "n", ParseStatus: "parsed", RawBody: []byte("raw"), CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var callerIngestID int64
	st.DB.QueryRow("SELECT id FROM ingest_log WHERE message_uid='transfer-caller'").Scan(&callerIngestID)

	base := time.Date(2026, 6, 10, 12, 0, 0, 0, time.UTC)
	amount := int64(50000) // 500.00 AED in fils

	// Insert the candidate: credit 500 AED — would match a debit caller.
	candRow := TransactionRow{
		PostedAt:    base,
		AmountFils:  amount,
		Currency:    "AED",
		Direction:   "credit",
		MerchantRaw: "BANK TRANSFER",
		Last4:       "9999",
		Status:      "confirmed",
		Confidence:  1.0,
		Source:      "email",
		IngestID:    candIngestID,
	}
	candID, _, err := st.InsertTransaction(candRow)
	if err != nil {
		t.Fatalf("insert candidate: %v", err)
	}

	// Archive the candidate — it must now be invisible to FindTransferMatch.
	if err := st.ArchiveTransaction(candID); err != nil {
		t.Fatalf("archive candidate: %v", err)
	}

	// Insert the calling transaction: debit 500 AED within window.
	callerRow := TransactionRow{
		PostedAt:    base.Add(10 * time.Minute),
		AmountFils:  amount,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "BANK TRANSFER",
		Last4:       "8888",
		Status:      "confirmed",
		Confidence:  1.0,
		Source:      "email",
		IngestID:    callerIngestID,
	}
	callerID, _, err := st.InsertTransaction(callerRow)
	if err != nil {
		t.Fatalf("insert caller: %v", err)
	}

	matchID, found, err := st.FindTransferMatch(TransferLeg{
		TxID: callerID, AmountFils: amount, Currency: "AED", Direction: "debit",
		Last4: "8888", PostedAt: base.Add(10 * time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatalf("FindTransferMatch: %v", err)
	}
	if found {
		t.Errorf("FindTransferMatch returned archived row %d as match — archived rows must be skipped", matchID)
	}
}

// TestInsertTransactionPersistsLast4 verifies the account last-4 captured at
// parse time survives into the transactions row (transfer matching reads it).
func TestInsertTransactionPersistsLast4(t *testing.T) {
	st := newTestStore(t)
	id, created, err := st.InsertTransaction(TransactionRow{
		PostedAt:    time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC),
		AmountFils:  12345,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: "LAST4 TEST",
		Last4:       "1234",
		Status:      "needs_review",
	})
	if err != nil || !created {
		t.Fatalf("insert: created=%v err=%v", created, err)
	}
	var got string
	if err := st.DB.QueryRow(`SELECT COALESCE(last4,'') FROM transactions WHERE id=?`, id).Scan(&got); err != nil {
		t.Fatalf("select last4: %v", err)
	}
	if got != "1234" {
		t.Errorf("last4 = %q, want %q", got, "1234")
	}
}

// seedTransferTxn inserts a minimal transaction for transfer-matching tests and
// returns its id.
func seedTransferTxn(t *testing.T, st *Store, amount int64, currency, direction, last4, status string, at time.Time) int64 {
	t.Helper()
	id, created, err := st.InsertTransaction(TransactionRow{
		PostedAt:    at,
		AmountFils:  amount,
		Currency:    currency,
		Direction:   direction,
		MerchantRaw: "SEED " + direction + " " + last4 + " " + at.Format(time.RFC3339),
		Last4:       last4,
		Status:      status,
	})
	if err != nil || !created {
		t.Fatalf("seedTxn: created=%v err=%v", created, err)
	}
	return id
}

func TestFindTransferMatchRequiresSameCurrency(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	seedTransferTxn(t, st, 10000, "USD", "credit", "", "needs_review", base)
	debitID := seedTransferTxn(t, st, 10000, "AED", "debit", "", "needs_review", base.Add(5*time.Minute))

	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 10000, Currency: "AED", Direction: "debit",
		PostedAt: base.Add(5 * time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("matched across currencies: AED debit must not pair with USD credit")
	}
}

func TestFindTransferMatchRejectsSameLast4(t *testing.T) {
	// Same account, opposite directions = refund/reversal, never a transfer.
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	seedTransferTxn(t, st, 25000, "AED", "credit", "1234", "needs_review", base)
	debitID := seedTransferTxn(t, st, 25000, "AED", "debit", "1234", "needs_review", base.Add(10*time.Minute))

	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 25000, Currency: "AED", Direction: "debit",
		Last4: "1234", PostedAt: base.Add(10 * time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("same-last4 opposite pair matched — refund shape must be rejected")
	}
}

func TestFindTransferMatchOwnAccountGating(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)

	// Registry configured with two own accounts.
	if _, err := st.InsertAccount("A", "DIB", "1111"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.InsertAccount("B", "ENBD", "2222"); err != nil {
		t.Fatal(err)
	}

	// Counterpart credit on a NON-registered account: must not match.
	seedTransferTxn(t, st, 50000, "AED", "credit", "9999", "needs_review", base)
	d1 := seedTransferTxn(t, st, 50000, "AED", "debit", "1111", "needs_review", base.Add(time.Minute))
	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: d1, AmountFils: 50000, Currency: "AED", Direction: "debit",
		Last4: "1111", PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("matched a leg on an unregistered account while registry is configured")
	}

	// Counterpart on the other registered account: must match.
	c2 := seedTransferTxn(t, st, 70000, "AED", "credit", "2222", "needs_review", base)
	d2 := seedTransferTxn(t, st, 70000, "AED", "debit", "1111", "needs_review", base.Add(time.Minute))
	matchID, found, err := st.FindTransferMatch(TransferLeg{
		TxID: d2, AmountFils: 70000, Currency: "AED", Direction: "debit",
		Last4: "1111", PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !found || matchID != c2 {
		t.Errorf("match = (%d,%v), want (%d,true)", matchID, found, c2)
	}
}

func TestFindTransferMatchAllowsMissingLast4(t *testing.T) {
	// Old rows and CSV imports have no last4; they must still be matchable.
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	credID := seedTransferTxn(t, st, 30000, "AED", "credit", "", "needs_review", base)
	debitID := seedTransferTxn(t, st, 30000, "AED", "debit", "1234", "needs_review", base.Add(time.Minute))

	matchID, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 30000, Currency: "AED", Direction: "debit",
		Last4: "1234", PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !found || matchID != credID {
		t.Errorf("match = (%d,%v), want (%d,true)", matchID, found, credID)
	}
}

func TestFindTransferMatchSkipsIgnored(t *testing.T) {
	// A row the user explicitly ignored must not be silently rewritten.
	st := newTestStore(t)
	base := time.Date(2026, 7, 1, 12, 0, 0, 0, time.UTC)
	seedTransferTxn(t, st, 40000, "AED", "credit", "", "ignored", base)
	debitID := seedTransferTxn(t, st, 40000, "AED", "debit", "", "needs_review", base.Add(time.Minute))

	_, found, err := st.FindTransferMatch(TransferLeg{
		TxID: debitID, AmountFils: 40000, Currency: "AED", Direction: "debit",
		PostedAt: base.Add(time.Minute),
	}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if found {
		t.Error("ignored row was offered as a transfer leg")
	}
}

func TestNetTransferPairs(t *testing.T) {
	st := newTestStore(t)
	base := time.Date(2026, 6, 15, 9, 0, 0, 0, time.UTC)

	// A genuine pair, already confirmed (historical pollution).
	d1 := seedTransferTxn(t, st, 150000, "AED", "debit", "1111", "confirmed", base)
	c1 := seedTransferTxn(t, st, 150000, "AED", "credit", "2222", "confirmed", base.Add(20*time.Minute))
	// A refund shape: same account both sides — must NOT be netted.
	r1 := seedTransferTxn(t, st, 8000, "AED", "debit", "3333", "confirmed", base)
	r2 := seedTransferTxn(t, st, 8000, "AED", "credit", "3333", "confirmed", base.Add(10*time.Minute))
	// A lone debit with no counterpart — must stay untouched.
	lone := seedTransferTxn(t, st, 999999, "AED", "debit", "1111", "confirmed", base)

	marked, err := st.NetTransferPairs(2 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if marked != 2 {
		t.Errorf("marked = %d, want 2", marked)
	}
	status := func(id int64) string {
		var s string
		if err := st.DB.QueryRow(`SELECT status FROM transactions WHERE id=?`, id).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if status(d1) != "transfer" || status(c1) != "transfer" {
		t.Errorf("pair statuses = %s/%s, want transfer/transfer", status(d1), status(c1))
	}
	if status(r1) != "confirmed" || status(r2) != "confirmed" {
		t.Errorf("refund pair rewritten: %s/%s, want confirmed/confirmed", status(r1), status(r2))
	}
	if status(lone) != "confirmed" {
		t.Errorf("lone debit rewritten to %s", status(lone))
	}
}

func TestNetTransferPairsEachLegUsedOnce(t *testing.T) {
	// Two debits, one credit at the same amount: only one debit pairs.
	st := newTestStore(t)
	base := time.Date(2026, 6, 15, 9, 0, 0, 0, time.UTC)
	seedTransferTxn(t, st, 50000, "AED", "debit", "", "needs_review", base)
	seedTransferTxn(t, st, 50000, "AED", "debit", "", "needs_review", base.Add(5*time.Minute))
	seedTransferTxn(t, st, 50000, "AED", "credit", "", "needs_review", base.Add(2*time.Minute))

	marked, err := st.NetTransferPairs(2 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if marked != 2 {
		t.Errorf("marked = %d, want 2 (one pair, credit used once)", marked)
	}
	var transfers int
	st.DB.QueryRow(`SELECT COUNT(*) FROM transactions WHERE status='transfer'`).Scan(&transfers)
	if transfers != 2 {
		t.Errorf("transfer rows = %d, want 2", transfers)
	}
}

func TestSelectForParseReturnsReceivedAt(t *testing.T) {
	st := newTestStore(t)
	recv := time.Date(2026, 7, 24, 13, 51, 40, 0, time.UTC)
	if _, err := st.InsertIngest(IngestRecord{
		MessageUID: "recv1", FromAddr: "a@b.c", Subject: "s",
		ReceivedAt: recv, ParseStatus: "unparsed", RawBody: []byte("x"), CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectForParse(SelectForParseOpts{OnlyUnparsed: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows", len(rows))
	}
	if !rows[0].ReceivedAt.Equal(recv) {
		t.Errorf("ReceivedAt = %v, want %v", rows[0].ReceivedAt, recv)
	}
}
