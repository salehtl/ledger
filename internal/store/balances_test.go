package store

import (
	"errors"
	"testing"
)

func TestInsertAccountBalanceValidation(t *testing.T) {
	st := newTestStore(t)
	acct, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name string
		row  AccountBalanceRow
	}{
		{"missing account", AccountBalanceRow{BalanceFils: 100}},
		{"bad source", AccountBalanceRow{AccountID: acct, BalanceFils: 100, Source: "guess"}},
		{"bad as_of", AccountBalanceRow{AccountID: acct, BalanceFils: 100, AsOf: "yesterday"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := st.InsertAccountBalance(tc.row); !errors.Is(err, ErrBalanceInvalid) {
				t.Fatalf("want ErrBalanceInvalid, got %v", err)
			}
		})
	}
	// Unknown account id trips the foreign key, not silence.
	if _, err := st.InsertAccountBalance(AccountBalanceRow{AccountID: 9999, BalanceFils: 100}); err == nil {
		t.Fatal("balance for nonexistent account should fail (foreign_keys=ON)")
	}
}

// TestInsertAccountBalanceNormalizesAsOf: a client as_of with a UTC offset
// must be stored as UTC — every downstream window compare (activity since
// anchor, net-worth month ends) is lexical against UTC-stored timestamps, so
// one verbatim-stored "+04:00" anchor would silently corrupt all subsequent
// reconciliation math for the account.
func TestInsertAccountBalanceNormalizesAsOf(t *testing.T) {
	st := newTestStore(t)
	acct, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertAccountBalance(AccountBalanceRow{
		AccountID: acct, BalanceFils: 100_000, AsOf: "2026-07-29T20:00:00+04:00",
	})
	if err != nil {
		t.Fatal(err)
	}
	rows, err := st.SelectAccountBalances(acct, 0)
	if err != nil || len(rows) != 1 || rows[0].ID != id {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	if rows[0].AsOf != "2026-07-29T16:00:00Z" {
		t.Fatalf("as_of stored %q, want normalized UTC %q", rows[0].AsOf, "2026-07-29T16:00:00Z")
	}
}

// TestAccountBalanceCount backs the DELETE /api/accounts guard.
func TestAccountBalanceCount(t *testing.T) {
	st := newTestStore(t)
	acct, err := st.InsertAccount("Main", "DIB", "1234")
	if err != nil {
		t.Fatal(err)
	}
	if n, err := st.AccountBalanceCount(acct); err != nil || n != 0 {
		t.Fatalf("fresh count=%d err=%v, want 0", n, err)
	}
	for i := 0; i < 2; i++ {
		if _, err := st.InsertAccountBalance(AccountBalanceRow{AccountID: acct, BalanceFils: int64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := st.AccountBalanceCount(acct); err != nil || n != 2 {
		t.Fatalf("count=%d err=%v, want 2", n, err)
	}
}

func TestBalanceHistoryAndLatest(t *testing.T) {
	st := newTestStore(t)
	st.SetNow(func() int64 { return 1_753_000_000 })
	main, _ := st.InsertAccount("Main", "DIB", "1234")
	savings, _ := st.InsertAccount("Savings", "ENBD", "5678")

	// No check-ins yet.
	if _, ok, err := st.LatestAccountBalance(main); err != nil || ok {
		t.Fatalf("expected no balance, ok=%v err=%v", ok, err)
	}

	ins := func(acct int64, asOf string, fils int64, source string) int64 {
		id, err := st.InsertAccountBalance(AccountBalanceRow{
			AccountID: acct, AsOf: asOf, BalanceFils: fils, Source: source,
		})
		if err != nil {
			t.Fatalf("insert balance: %v", err)
		}
		return id
	}
	ins(main, "2026-07-01T10:00:00Z", 1_000_000, "")
	ins(main, "2026-07-15T10:00:00Z", 900_000, "checkin")
	latestMain := ins(main, "2026-07-29T10:00:00Z", -50_000, "adjustment") // negative allowed
	ins(savings, "2026-07-10T10:00:00Z", 5_000_000, "checkin")

	// History newest first; limit honored.
	hist, err := st.SelectAccountBalances(main, 0)
	if err != nil || len(hist) != 3 {
		t.Fatalf("history n=%d err=%v", len(hist), err)
	}
	if hist[0].ID != latestMain || hist[0].BalanceFils != -50_000 || hist[0].Source != "adjustment" {
		t.Fatalf("hist[0]=%+v", hist[0])
	}
	if hist[2].BalanceFils != 1_000_000 {
		t.Fatalf("hist[2]=%+v", hist[2])
	}
	limited, err := st.SelectAccountBalances(main, 2)
	if err != nil || len(limited) != 2 {
		t.Fatalf("limited n=%d err=%v", len(limited), err)
	}

	// Latest per single account; empty source defaulted to checkin.
	lb, ok, err := st.LatestAccountBalance(main)
	if err != nil || !ok || lb.ID != latestMain {
		t.Fatalf("latest main=%+v ok=%v err=%v", lb, ok, err)
	}
	if hist[2].Source != "checkin" {
		t.Fatalf("default source: %+v", hist[2])
	}

	// Latest per account across the board.
	all, err := st.LatestBalances()
	if err != nil {
		t.Fatal(err)
	}
	if all[main].BalanceFils != -50_000 || all[savings].BalanceFils != 5_000_000 {
		t.Fatalf("latest balances=%v", all)
	}

	// Same as_of tie breaks to the higher (newer) row id.
	tieA := ins(savings, "2026-07-20T10:00:00Z", 1, "checkin")
	tieB := ins(savings, "2026-07-20T10:00:00Z", 2, "checkin")
	_ = tieA
	if lb, _, _ := st.LatestAccountBalance(savings); lb.ID != tieB {
		t.Fatalf("tie should pick newest id: got %+v want id=%d", lb, tieB)
	}
}

func TestAccountKind(t *testing.T) {
	st := newTestStore(t)
	id, err := st.InsertAccount("Brokerage", "IBKR", "9876")
	if err != nil {
		t.Fatal(err)
	}
	// New accounts default to budget.
	a, ok, err := st.SelectAccount(id)
	if err != nil || !ok || a.Kind != "budget" {
		t.Fatalf("account=%+v ok=%v err=%v", a, ok, err)
	}
	if err := st.UpdateAccountKind(id, "tracking"); err != nil {
		t.Fatal(err)
	}
	if a, _, _ := st.SelectAccount(id); a.Kind != "tracking" {
		t.Fatalf("kind=%q want tracking", a.Kind)
	}
	if err := st.UpdateAccountKind(id, "offshore"); err == nil {
		t.Fatal("invalid kind should be rejected")
	}
	// SelectAccounts carries kind too.
	accs, err := st.SelectAccounts()
	if err != nil || len(accs) != 1 || accs[0].Kind != "tracking" {
		t.Fatalf("accs=%+v err=%v", accs, err)
	}
	// Missing account: ok=false, no error.
	if _, ok, err := st.SelectAccount(9999); err != nil || ok {
		t.Fatalf("missing account ok=%v err=%v", ok, err)
	}
}
