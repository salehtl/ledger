package store

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

// reconInsertTxn seeds one email-style transaction with a last4 and status.
func reconInsertTxn(t *testing.T, st *Store, last4, direction string, amountFils int64, postedAt, status, merchant string) int64 {
	t.Helper()
	posted, err := time.Parse(time.RFC3339, postedAt)
	if err != nil {
		t.Fatalf("parse postedAt: %v", err)
	}
	id, inserted, err := st.InsertTransaction(TransactionRow{
		PostedAt: posted, AmountFils: amountFils, Direction: direction,
		MerchantRaw: merchant, Last4: last4, Status: status, Confidence: 1,
	})
	if err != nil || !inserted {
		t.Fatalf("InsertTransaction(%s): inserted=%v err=%v", merchant, inserted, err)
	}
	return id
}

func TestAccountActivitySince(t *testing.T) {
	st := openTestStore(t)
	acctID, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	otherID, err := st.InsertAccount("NoLast4", "ENBD", "")
	if err != nil {
		t.Fatal(err)
	}

	// Mix of statuses and accounts around the since boundary.
	reconInsertTxn(t, st, "1234", "debit", 10_00, "2026-07-01T10:00:00Z", "confirmed", "before-window")
	reconInsertTxn(t, st, "1234", "debit", 20_00, "2026-07-10T10:00:00Z", "confirmed", "spend")
	reconInsertTxn(t, st, "1234", "credit", 50_00, "2026-07-11T10:00:00Z", "needs_review", "refundish")
	reconInsertTxn(t, st, "1234", "debit", 7_00, "2026-07-12T10:00:00Z", "transfer", "transfer-out")
	reconInsertTxn(t, st, "1234", "debit", 99_00, "2026-07-13T10:00:00Z", "ignored", "noise")
	reconInsertTxn(t, st, "9999", "debit", 88_00, "2026-07-13T11:00:00Z", "confirmed", "other-account")

	tests := []struct {
		name      string
		accountID int64
		since     string
		wantNet   int64
		wantCount int
	}{
		{"window excludes pre-since and ignored", acctID, "2026-07-05T00:00:00Z", -20_00 + 50_00 - 7_00, 3},
		{"all history", acctID, "", -10_00 - 20_00 + 50_00 - 7_00, 4},
		{"no last4 means no attribution", otherID, "", 0, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			net, count, unconverted, err := st.AccountActivitySince(tc.accountID, tc.since)
			if err != nil {
				t.Fatalf("AccountActivitySince: %v", err)
			}
			if net != tc.wantNet || count != tc.wantCount {
				t.Errorf("got net=%d count=%d, want net=%d count=%d", net, count, tc.wantNet, tc.wantCount)
			}
			if unconverted != 0 {
				t.Errorf("unconverted = %d, want 0 (all AED rows)", unconverted)
			}
		})
	}

	if _, _, _, err := st.AccountActivitySince(9999, ""); !errors.Is(err, ErrBalanceInvalid) {
		t.Errorf("unknown account: err=%v, want ErrBalanceInvalid", err)
	}
}

// TestAccountActivitySinceAEDConvention pins the expected-balance currency
// rule: a foreign-currency transaction with NO configured FX rate contributes
// NOTHING to the AED activity sum (never its raw foreign minor units — a
// GBP 50.00 charge must not count as AED 50.00), still counts in txn_count,
// and is reported via the unconverted counter so the check-in can explain the
// delta. Once a rate exists, ConvertUnconverted backfills and the row counts.
func TestAccountActivitySinceAEDConvention(t *testing.T) {
	st := openTestStore(t)
	acctID, err := st.InsertAccount("Main", "DIB", "5555")
	if err != nil {
		t.Fatal(err)
	}
	reconInsertTxn(t, st, "5555", "debit", 100_00, "2026-07-10T00:00:00Z", "confirmed", "aed spend")
	// Foreign row, no THB rate configured.
	posted, _ := time.Parse(time.RFC3339, "2026-07-11T00:00:00Z")
	if _, created, err := st.InsertTransaction(TransactionRow{
		PostedAt: posted, AmountFils: 100_00, Currency: "THB", Direction: "debit",
		MerchantRaw: "bangkok cafe", Last4: "5555", Status: "confirmed", Confidence: 1,
	}); err != nil || !created {
		t.Fatalf("insert THB txn: created=%v err=%v", created, err)
	}

	net, count, unconverted, err := st.AccountActivitySince(acctID, "")
	if err != nil {
		t.Fatal(err)
	}
	if net != -100_00 {
		t.Errorf("net = %d, want -10000: the no-rate THB row must contribute nothing", net)
	}
	if count != 2 || unconverted != 1 {
		t.Errorf("count/unconverted = %d/%d, want 2/1", count, unconverted)
	}

	// Add the rate and backfill: the row now counts in AED, no longer flagged.
	if err := st.UpsertFXRate("THB", 110_000); err != nil { // 1 THB = 0.11 AED
		t.Fatal(err)
	}
	if _, err := st.ConvertUnconverted(); err != nil {
		t.Fatal(err)
	}
	net, count, unconverted, err = st.AccountActivitySince(acctID, "")
	if err != nil {
		t.Fatal(err)
	}
	if net != -100_00-11_00 || count != 2 || unconverted != 0 {
		t.Errorf("after rate: net=%d count=%d unconverted=%d, want -11100/2/0", net, count, unconverted)
	}
}

// TestAccountActivitySinceDayGranular pins the check-in window semantics:
// bank-parsed posted_at is a bare date (midnight UTC) while a check-in anchor
// is a wall-clock instant, so the window must compare calendar DAYS. An
// instant compare produced wrong money both ways: (a) a spend dated today but
// entered after a 16:37 check-in fell permanently outside every future window
// (computed balance frozen, next check-in blames phantom causes); (b) a
// transaction dated after the anchor's date was counted by two consecutive
// check-ins (double-counted expected balance).
func TestAccountActivitySinceDayGranular(t *testing.T) {
	st := openTestStore(t)
	acctID, err := st.InsertAccount("Main", "DIB", "7777")
	if err != nil {
		t.Fatal(err)
	}
	// Bank-style rows: midnight-dated.
	reconInsertTxn(t, st, "7777", "debit", 50_00, "2026-07-29T00:00:00Z", "confirmed", "same-day spend")
	reconInsertTxn(t, st, "7777", "debit", 30_00, "2026-07-30T00:00:00Z", "confirmed", "next-day spend")

	// Anchor at 16:37 on the 29th: the same-day (midnight-dated) spend counts
	// as already inside the stated balance; only later DAYS count.
	net, count, _, err := st.AccountActivitySince(acctID, "2026-07-29T16:37:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if net != -30_00 || count != 1 {
		t.Errorf("since 29th 16:37 = (%d,%d), want (-3000,1): same-day excluded, next day counted", net, count)
	}
	// Anchor on the 30th (any time of day): the 30th's spend is no longer
	// counted — it can never be double-counted across consecutive check-ins.
	net, count, _, err = st.AccountActivitySince(acctID, "2026-07-30T09:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if net != 0 || count != 0 {
		t.Errorf("since 30th = (%d,%d), want (0,0): anchor covers its whole day", net, count)
	}
}

func TestUnparsedIngestSince(t *testing.T) {
	st := openTestStore(t)
	mustIngest := func(uid, status string, received time.Time) {
		t.Helper()
		if _, err := st.InsertIngest(IngestRecord{
			MessageUID: uid, ReceivedAt: received, FromAddr: "bank@dib.ae",
			Subject: "Transaction Alert " + uid, ParseStatus: status, RawBody: []byte("x"),
		}); err != nil {
			t.Fatalf("InsertIngest(%s): %v", uid, err)
		}
	}
	old := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	recent := time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC)
	mustIngest("u1", "unparsed", old)
	mustIngest("u2", "unparsed", recent)
	mustIngest("u3", "parsed", recent)
	mustIngest("u4", "ignored", recent)

	rows, err := st.UnparsedIngestSince("2026-07-10T00:00:00Z", 0)
	if err != nil {
		t.Fatalf("UnparsedIngestSince: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want 1 (only the recent unparsed): %+v", len(rows), rows)
	}
	if rows[0].Subject != "Transaction Alert u2" || rows[0].FromAddr != "bank@dib.ae" {
		t.Errorf("unexpected row: %+v", rows[0])
	}

	all, err := st.UnparsedIngestSince("", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("all history: got %d rows, want 2", len(all))
	}
	if all[0].ID < all[1].ID {
		t.Errorf("expected newest first, got ids %d, %d", all[0].ID, all[1].ID)
	}
}

func TestInsertAdjustmentTransaction(t *testing.T) {
	st := openTestStore(t)
	acctID, err := st.InsertAccount("Main", "DIB", "4321")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := st.InsertAdjustmentTransaction(acctID, 0, ""); !errors.Is(err, ErrBalanceInvalid) {
		t.Fatalf("zero delta: err=%v, want ErrBalanceInvalid", err)
	}
	if _, err := st.InsertAdjustmentTransaction(9999, -100, ""); !errors.Is(err, ErrBalanceInvalid) {
		t.Fatalf("unknown account: err=%v, want ErrBalanceInvalid", err)
	}

	// Anchor first, then adjust: the adjustment must land BEFORE the anchor so
	// computed balance (anchor + activity since) is unchanged by it.
	if _, err := st.InsertAccountBalance(AccountBalanceRow{
		AccountID: acctID, AsOf: "2026-07-20T12:00:00Z", BalanceFils: 500_00,
	}); err != nil {
		t.Fatal(err)
	}
	txID, err := st.InsertAdjustmentTransaction(acctID, -75_50, "cash spend")
	if err != nil {
		t.Fatalf("InsertAdjustmentTransaction: %v", err)
	}

	var amount int64
	var direction, status, postedAt, last4, note string
	err = st.DB.QueryRow(
		`SELECT amount, direction, status, posted_at, COALESCE(last4,''), COALESCE(note,'')
		   FROM transactions WHERE id=?`, txID).
		Scan(&amount, &direction, &status, &postedAt, &last4, &note)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if amount != 75_50 || direction != "debit" || status != "confirmed" || last4 != "4321" || note != "cash spend" {
		t.Errorf("row = amount %d %s status %s last4 %s note %q", amount, direction, status, last4, note)
	}
	if postedAt >= "2026-07-20T12:00:00Z" {
		t.Errorf("posted_at %s not before anchor", postedAt)
	}

	// Activity since the anchor must NOT include the adjustment.
	net, count, _, err := st.AccountActivitySince(acctID, "2026-07-20T12:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	if net != 0 || count != 0 {
		t.Errorf("activity since anchor = %d/%d, want 0/0 (adjustment backdated)", net, count)
	}

	// Positive delta writes a credit.
	txID2, err := st.InsertAdjustmentTransaction(acctID, 10_00, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.DB.QueryRow(`SELECT direction FROM transactions WHERE id=?`, txID2).Scan(&direction); err != nil {
		t.Fatal(err)
	}
	if direction != "credit" {
		t.Errorf("positive delta direction = %s, want credit", direction)
	}
}

// TestManualTransactionAttributedToAccount: a manual entry created with an
// AccountID carries the account's last4, so the reconcile discrepancy card's
// "open manual entry" path actually converges the expected-balance delta.
func TestManualTransactionAttributedToAccount(t *testing.T) {
	st := openTestStore(t)
	acctID, err := st.InsertAccount("Cash Main", "DIB", "4321")
	if err != nil {
		t.Fatal(err)
	}

	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt: time.Date(2026, 7, 10, 9, 0, 0, 0, time.UTC), AmountFils: 15_000,
		Direction: "debit", MerchantRaw: "ATM cash", AccountID: acctID,
	})
	if err != nil {
		t.Fatalf("insert with account: %v", err)
	}
	var last4 string
	if err := st.DB.QueryRow(`SELECT COALESCE(last4,'') FROM transactions WHERE id=?`, id).Scan(&last4); err != nil {
		t.Fatal(err)
	}
	if last4 != "4321" {
		t.Fatalf("last4 = %q, want 4321", last4)
	}

	// The manual entry participates in expected-balance math.
	net, count, _, err := st.AccountActivitySince(acctID, "")
	if err != nil {
		t.Fatal(err)
	}
	if net != -15_000 || count != 1 {
		t.Fatalf("activity = (%d, %d), want (-15000, 1)", net, count)
	}

	// Unknown accounts are refused, not silently dropped.
	if _, err := st.InsertManualTransaction(ManualTxn{
		PostedAt: time.Now().UTC(), AmountFils: 100, Direction: "debit",
		MerchantRaw: "x", AccountID: 999_999,
	}); !errors.Is(err, ErrBalanceInvalid) {
		t.Fatalf("unknown account: want ErrBalanceInvalid, got %v", err)
	}

	// AccountID 0 stays unattributed (last4 NULL) — existing behavior.
	plain, err := st.InsertManualTransaction(ManualTxn{
		PostedAt: time.Now().UTC(), AmountFils: 100, Direction: "debit", MerchantRaw: "y",
	})
	if err != nil {
		t.Fatal(err)
	}
	var l4 sql.NullString
	if err := st.DB.QueryRow(`SELECT last4 FROM transactions WHERE id=?`, plain).Scan(&l4); err != nil {
		t.Fatal(err)
	}
	if l4.Valid {
		t.Fatalf("unattributed manual entry got last4 %q", l4.String)
	}
}
