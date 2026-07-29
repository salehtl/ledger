package store

import (
	"errors"
	"testing"
	"time"
)

// insertMerchantTxn seeds a confirmed manual transaction with a specific
// merchant string (insertTxn hardcodes one).
func insertMerchantTxn(t *testing.T, st *Store, catID int64, merchant, postedAt string) int64 {
	t.Helper()
	posted, err := time.Parse("2006-01-02", postedAt)
	if err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertManualTransaction(ManualTxn{
		PostedAt: posted, AmountFils: 10_000, Direction: "debit",
		MerchantRaw: merchant, CategoryID: catID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func findItem(t *testing.T, items []ReviewItem, id int64) ReviewItem {
	t.Helper()
	for _, it := range items {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("transaction %d missing from list", id)
	return ReviewItem{}
}

func TestTransactionNoteReadWrite(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "NoteCat", "spending", "need")
	txID := insertMerchantTxn(t, st, cat, "CARREFOUR", "2026-07-01")

	if err := st.UpdateTransactionNote(9999, "x"); !errors.Is(err, ErrTxNotFound) {
		t.Fatalf("missing tx: want ErrTxNotFound, got %v", err)
	}
	if err := st.UpdateTransactionNote(txID, "split with flatmate"); err != nil {
		t.Fatal(err)
	}
	items, err := st.SelectTransactions("", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := findItem(t, items, txID); got.Note != "split with flatmate" {
		t.Fatalf("note=%q", got.Note)
	}
	// The shared scanner feeds SelectRecent too — note must ride along there.
	recent, err := st.SelectRecent(10)
	if err != nil {
		t.Fatal(err)
	}
	if got := findItem(t, recent, txID); got.Note != "split with flatmate" {
		t.Fatalf("SelectRecent note=%q", got.Note)
	}
	// Clearing stores NULL, reads back "".
	if err := st.UpdateTransactionNote(txID, ""); err != nil {
		t.Fatal(err)
	}
	items, _ = st.SelectTransactions("", "", "", "")
	if got := findItem(t, items, txID); got.Note != "" {
		t.Fatalf("cleared note=%q", got.Note)
	}
}

func TestDisplayNameResolution(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "CleanCat", "spending", "want")
	txTalabat := insertMerchantTxn(t, st, cat, "TALABAT GENERAL TRADING LLC DUBAI ARE", "2026-07-01")
	txOther := insertMerchantTxn(t, st, cat, "SOME OTHER SHOP", "2026-07-02")

	// contains rule matches case-insensitively and cleans the listing.
	ruleID, err := st.InsertRule(RuleRow{
		MatchType: "contains", Pattern: "talabat", CategoryID: cat,
		Priority: 100, Source: "manual", DisplayName: "Talabat",
	})
	if err != nil {
		t.Fatal(err)
	}
	items, err := st.SelectTransactions("", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := findItem(t, items, txTalabat); got.DisplayName != "Talabat" {
		t.Fatalf("display=%q want Talabat", got.DisplayName)
	}
	if got := findItem(t, items, txOther); got.DisplayName != "" {
		t.Fatalf("unmatched merchant display=%q want empty", got.DisplayName)
	}

	// Lower priority number wins when several rules match.
	if _, err := st.InsertRule(RuleRow{
		MatchType: "exact", Pattern: "TALABAT GENERAL TRADING LLC DUBAI ARE", CategoryID: cat,
		Priority: 10, Source: "manual", DisplayName: "Talabat (exact)",
	}); err != nil {
		t.Fatal(err)
	}
	items, _ = st.SelectTransactions("", "", "", "")
	if got := findItem(t, items, txTalabat); got.DisplayName != "Talabat (exact)" {
		t.Fatalf("priority resolution: display=%q", got.DisplayName)
	}

	// Inactive rules and cleared display names stop resolving.
	if err := st.SetRuleActive(ruleID, false); err != nil {
		t.Fatal(err)
	}
	rules, err := st.SelectRules()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rules {
		if r.ID == ruleID && r.DisplayName != "Talabat" {
			t.Fatalf("rule row display=%q", r.DisplayName)
		}
		if r.Priority == 10 {
			if err := st.SetRuleDisplayName(r.ID, ""); err != nil {
				t.Fatal(err)
			}
		}
	}
	items, _ = st.SelectTransactions("", "", "", "")
	if got := findItem(t, items, txTalabat); got.DisplayName != "" {
		t.Fatalf("after deactivate/clear, display=%q want empty", got.DisplayName)
	}
	// SetRuleDisplayName can also set a fresh clean-name.
	if err := st.SetRuleDisplayName(ruleID, "Talabat Food"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetRuleActive(ruleID, true); err != nil {
		t.Fatal(err)
	}
	items, _ = st.SelectTransactions("", "", "", "")
	if got := findItem(t, items, txTalabat); got.DisplayName != "Talabat Food" {
		t.Fatalf("display=%q want Talabat Food", got.DisplayName)
	}
}

func TestNotifySettings(t *testing.T) {
	st := newTestStore(t)
	a, err := st.SelectAppSettings()
	if err != nil {
		t.Fatal(err)
	}
	// Migration defaults: thresholds on, 3 days ahead.
	if !a.NotifyThresholds || a.NotifyUpcomingDays != 3 {
		t.Fatalf("defaults: %+v", a)
	}
	if err := st.UpdateNotifySettings(false, 0); err != nil {
		t.Fatal(err)
	}
	a, _ = st.SelectAppSettings()
	if a.NotifyThresholds || a.NotifyUpcomingDays != 0 {
		t.Fatalf("after update: %+v", a)
	}
	// Negative days clamp to 0 (off).
	if err := st.UpdateNotifySettings(true, -5); err != nil {
		t.Fatal(err)
	}
	a, _ = st.SelectAppSettings()
	if !a.NotifyThresholds || a.NotifyUpcomingDays != 0 {
		t.Fatalf("after clamp: %+v", a)
	}
	// The categorization settings PUT must never clobber notify fields.
	if err := st.UpdateNotifySettings(true, 14); err != nil {
		t.Fatal(err)
	}
	a, _ = st.SelectAppSettings()
	a.AIThreshold = 0.9
	if err := st.UpdateAppSettings(a); err != nil {
		t.Fatal(err)
	}
	a, _ = st.SelectAppSettings()
	if !a.NotifyThresholds || a.NotifyUpcomingDays != 14 {
		t.Fatalf("UpdateAppSettings clobbered notify fields: %+v", a)
	}
}

// TestV3MigrationIdempotent proves the additive migrations open an existing DB
// cleanly: the same data dir is opened twice (schema + addColumn re-run).
func TestV3MigrationIdempotent(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	id, err := st.InsertAccount("A", "B", "1111")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer st2.Close()
	if a, ok, err := st2.SelectAccount(id); err != nil || !ok || a.Kind != "budget" {
		t.Fatalf("after reopen: %+v ok=%v err=%v", a, ok, err)
	}
}
