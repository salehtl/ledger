package store

import (
	"errors"
	"testing"
)

func TestReplaceTransactionSplitsValidation(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "SplitVal", "spending", "need")
	txID := insertTxn(t, st, cat, "debit", 100_000, "2026-07-01", "confirmed")

	cases := []struct {
		name   string
		splits []TransactionSplitRow
		want   error
	}{
		{"sum under", []TransactionSplitRow{{CategoryID: cat, AmountFils: 99_999}}, ErrSplitInvalid},
		{"sum over", []TransactionSplitRow{
			{CategoryID: cat, AmountFils: 60_000}, {CategoryID: cat, AmountFils: 40_001},
		}, ErrSplitInvalid},
		{"zero line", []TransactionSplitRow{
			{CategoryID: cat, AmountFils: 100_000}, {CategoryID: cat, AmountFils: 0},
		}, ErrSplitInvalid},
		{"negative line", []TransactionSplitRow{
			{CategoryID: cat, AmountFils: 150_000}, {CategoryID: cat, AmountFils: -50_000},
		}, ErrSplitInvalid},
		{"missing category", []TransactionSplitRow{{AmountFils: 100_000}}, ErrSplitInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := st.ReplaceTransactionSplits(txID, tc.splits); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}
	if err := st.ReplaceTransactionSplits(9999, []TransactionSplitRow{{CategoryID: cat, AmountFils: 1}}); !errors.Is(err, ErrSplitTxNotFound) {
		t.Fatalf("missing parent: want ErrSplitTxNotFound, got %v", err)
	}
}

func TestReplaceTransactionSplitsLifecycle(t *testing.T) {
	st := newTestStore(t)
	grocery := insertCategory(t, st, "SplitG", "spending", "need")
	dining := insertCategory(t, st, "SplitD", "spending", "want")
	txID := insertTxn(t, st, grocery, "debit", 100_000, "2026-07-01", "confirmed")

	// Split 70/30: parent loses its category, split lines carry them.
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: grocery, AmountFils: 70_000, Note: "food"},
		{CategoryID: dining, AmountFils: 30_000},
	}); err != nil {
		t.Fatal(err)
	}
	splits, err := st.SelectTransactionSplits(txID)
	if err != nil || len(splits) != 2 {
		t.Fatalf("splits n=%d err=%v", len(splits), err)
	}
	if splits[0].CategoryID != grocery || splits[0].AmountFils != 70_000 || splits[0].Note != "food" {
		t.Fatalf("splits[0]=%+v", splits[0])
	}
	var parentCat any
	var status string
	if err := st.DB.QueryRow(`SELECT category_id, status FROM transactions WHERE id=?`, txID).Scan(&parentCat, &status); err != nil {
		t.Fatal(err)
	}
	if parentCat != nil {
		t.Fatalf("parent category should be NULL while split, got %v", parentCat)
	}
	if status != "confirmed" {
		t.Fatalf("split must not disturb status, got %q", status)
	}

	// A failed replace never clobbers the existing set (single SQL transaction).
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: grocery, AmountFils: 1},
	}); !errors.Is(err, ErrSplitInvalid) {
		t.Fatalf("want ErrSplitInvalid, got %v", err)
	}
	if splits, _ := st.SelectTransactionSplits(txID); len(splits) != 2 {
		t.Fatalf("failed replace must keep prior splits, n=%d", len(splits))
	}

	// Replace with a different set.
	if err := st.ReplaceTransactionSplits(txID, []TransactionSplitRow{
		{CategoryID: dining, AmountFils: 100_000},
	}); err != nil {
		t.Fatal(err)
	}
	splits, _ = st.SelectTransactionSplits(txID)
	if len(splits) != 1 || splits[0].CategoryID != dining {
		t.Fatalf("replaced splits=%+v", splits)
	}

	// Empty set un-splits: the categoryless parent must return to the review
	// queue (needs_review, matching ClearTransactionCategory) — a confirmed
	// transaction with no category and no lines would count in NO aggregate,
	// silently dropped from every money surface.
	if err := st.ReplaceTransactionSplits(txID, nil); err != nil {
		t.Fatal(err)
	}
	if splits, _ := st.SelectTransactionSplits(txID); len(splits) != 0 {
		t.Fatalf("unsplit should remove all lines, n=%d", len(splits))
	}
	if err := st.DB.QueryRow(`SELECT category_id, status FROM transactions WHERE id=?`, txID).Scan(&parentCat, &status); err != nil {
		t.Fatal(err)
	}
	if parentCat != nil || status != "needs_review" {
		t.Fatalf("un-split parent = (cat %v, status %q), want (NULL, needs_review)", parentCat, status)
	}

	// An empty replace on a transaction that was never split is a no-op: it
	// must NOT shove a categorized, confirmed transaction back into review.
	plain := insertTxn(t, st, grocery, "debit", 5_000, "2026-07-02", "confirmed")
	if err := st.ReplaceTransactionSplits(plain, nil); err != nil {
		t.Fatal(err)
	}
	var plainCat int64
	if err := st.DB.QueryRow(`SELECT category_id, status FROM transactions WHERE id=?`, plain).Scan(&plainCat, &status); err != nil {
		t.Fatal(err)
	}
	if plainCat != grocery || status != "confirmed" {
		t.Fatalf("no-op empty replace changed the row: (cat %d, status %q)", plainCat, status)
	}
}

// TestReplaceTransactionSplitsCategoryKinds: split lines feed the money
// aggregates under their own categories, and those aggregates only count
// active spending categories on debits (spending or income on credits) — so
// the store refuses any line whose fils would silently vanish, exactly like
// envelopeCategoryOK refuses non-envelope assignment targets.
func TestReplaceTransactionSplitsCategoryKinds(t *testing.T) {
	st := newTestStore(t)
	spend := insertCategory(t, st, "KindSpend", "spending", "need")
	spend2 := insertCategory(t, st, "KindSpend2", "spending", "want")
	income := insertCategory(t, st, "KindIncome", "income", "")
	excluded := insertCategory(t, st, "KindExcl", "excluded", "")
	inactive := insertCategory(t, st, "KindGone", "spending", "need")
	if _, err := st.DB.Exec(`UPDATE categories SET is_active=0 WHERE id=?`, inactive); err != nil {
		t.Fatal(err)
	}
	debit := insertTxn(t, st, spend, "debit", 10_000, "2026-07-01", "confirmed")
	credit := insertTxn(t, st, income, "credit", 10_000, "2026-07-02", "confirmed")

	cases := []struct {
		name   string
		parent int64
		splits []TransactionSplitRow
		wantOK bool
	}{
		{"debit: spending lines ok", debit, []TransactionSplitRow{
			{CategoryID: spend, AmountFils: 6_000}, {CategoryID: spend2, AmountFils: 4_000},
		}, true},
		{"debit: income line vanishes from every surface", debit, []TransactionSplitRow{
			{CategoryID: spend, AmountFils: 6_000}, {CategoryID: income, AmountFils: 4_000},
		}, false},
		{"debit: excluded line", debit, []TransactionSplitRow{
			{CategoryID: spend, AmountFils: 6_000}, {CategoryID: excluded, AmountFils: 4_000},
		}, false},
		{"debit: inactive category line", debit, []TransactionSplitRow{
			{CategoryID: spend, AmountFils: 6_000}, {CategoryID: inactive, AmountFils: 4_000},
		}, false},
		{"debit: unknown category line", debit, []TransactionSplitRow{
			{CategoryID: spend, AmountFils: 6_000}, {CategoryID: 99_999, AmountFils: 4_000},
		}, false},
		{"credit: income + spending (refund) lines ok", credit, []TransactionSplitRow{
			{CategoryID: income, AmountFils: 7_000}, {CategoryID: spend, AmountFils: 3_000},
		}, true},
		{"credit: excluded line", credit, []TransactionSplitRow{
			{CategoryID: income, AmountFils: 7_000}, {CategoryID: excluded, AmountFils: 3_000},
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := st.ReplaceTransactionSplits(tc.parent, tc.splits)
			if tc.wantOK {
				if err != nil {
					t.Fatalf("want ok, got %v", err)
				}
				return
			}
			if !errors.Is(err, ErrSplitInvalid) {
				t.Fatalf("want ErrSplitInvalid, got %v", err)
			}
		})
	}

	// The jars must account for every fil of the accepted splits: 10_000 of
	// debit spend minus the credit parent's 3_000 spending-refund line.
	rows, err := st.SelectMonthSpend("2026-07", false)
	if err != nil {
		t.Fatal(err)
	}
	var net int64
	for _, r := range rows {
		if r.Direction == "credit" {
			net -= r.AmountFils
		} else {
			net += r.AmountFils
		}
	}
	if net != 7_000 {
		t.Fatalf("month net spend = %d, want 7000 — accepted split lines must all be countable", net)
	}
}

func TestSelectSplitsForTransactions(t *testing.T) {
	st := newTestStore(t)
	cat := insertCategory(t, st, "SplitBulk", "spending", "need")
	other := insertCategory(t, st, "SplitBulk2", "spending", "want")
	tx1 := insertTxn(t, st, cat, "debit", 10_000, "2026-07-01", "confirmed")
	tx2 := insertTxn(t, st, cat, "debit", 20_000, "2026-07-02", "confirmed")
	tx3 := insertTxn(t, st, cat, "debit", 30_000, "2026-07-03", "confirmed")

	if err := st.ReplaceTransactionSplits(tx1, []TransactionSplitRow{
		{CategoryID: cat, AmountFils: 4_000}, {CategoryID: other, AmountFils: 6_000},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.ReplaceTransactionSplits(tx2, []TransactionSplitRow{
		{CategoryID: other, AmountFils: 20_000},
	}); err != nil {
		t.Fatal(err)
	}

	m, err := st.SelectSplitsForTransactions([]int64{tx1, tx2, tx3})
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 2 || len(m[tx1]) != 2 || len(m[tx2]) != 1 {
		t.Fatalf("map=%v", m)
	}
	if _, ok := m[tx3]; ok {
		t.Fatal("unsplit transaction must be absent from the map")
	}
	if empty, err := st.SelectSplitsForTransactions(nil); err != nil || len(empty) != 0 {
		t.Fatalf("empty input: %v err=%v", empty, err)
	}
}
