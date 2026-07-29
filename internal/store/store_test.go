package store

import (
	"fmt"
	"sort"
	"sync"
	"testing"
)

// Concurrent API writes share one SQLite file; without a busy timeout the
// second writer fails immediately with SQLITE_BUSY and the API 500s (seen
// live when the review deck's undo fires two reversal writes at once).
func TestConcurrentWritesDoNotBusyError(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	const writers = 8
	var wg sync.WaitGroup
	errs := make(chan error, writers*10)
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < 10; i++ {
				if _, err := st.InsertRule(RuleRow{
					MatchType:  "contains",
					Pattern:    fmt.Sprintf("MERCHANT-%d-%d", w, i),
					CategoryID: 1,
					Priority:   100,
					Source:     "manual",
				}); err != nil {
					errs <- err
				}
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent write failed: %v", err)
	}
}

func TestOpenCreatesDatabaseFile(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open error: %v", err)
	}
	defer st.Close()

	if err := st.Ping(); err != nil {
		t.Errorf("Ping error: %v", err)
	}
}

func TestOpenAppliesFullSchema(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open error: %v", err)
	}
	defer st.Close()

	rows, err := st.DB.Query(
		"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
	if err != nil {
		t.Fatalf("query tables: %v", err)
	}
	defer rows.Close()

	var got []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		got = append(got, name)
	}
	sort.Strings(got)

	want := []string{
		"account_balances", "accounts", "ai_suggestions", "ai_usage", "app_settings", "budget_config",
		"categories", "category_targets", "envelope_assignments", "fx_rates", "import_log",
		"ingest_log", "projects", "push_subscriptions", "rules", "scheduled_transactions",
		"transaction_splits", "transactions",
	}
	if len(got) != len(want) {
		t.Fatalf("tables = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("table[%d] = %q, want %q (full: %v)", i, got[i], want[i], got)
		}
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	st1, err := Open(dir)
	if err != nil {
		t.Fatalf("first Open error: %v", err)
	}
	st1.Close()

	// Re-opening the same directory must re-apply the schema without error.
	st2, err := Open(dir)
	if err != nil {
		t.Fatalf("second Open error: %v", err)
	}
	defer st2.Close()
	if _, err := st2.DB.Exec("INSERT INTO accounts (name, bank) VALUES ('test', 'enbd')"); err != nil {
		t.Errorf("insert after reopen: %v", err)
	}
}

func TestOpenSeedsDefaultCategories(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer st.Close()

	cats, err := st.SelectCategories()
	if err != nil {
		t.Fatalf("SelectCategories: %v", err)
	}
	if len(cats) == 0 {
		t.Error("Open must seed default categories")
	}
}

func TestMigrateAddsRuleIsActive(t *testing.T) {
	st := openTestStore(t)
	var c int
	if err := st.DB.QueryRow(`SELECT count(*) FROM pragma_table_info('rules') WHERE name='is_active'`).Scan(&c); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if c != 1 {
		t.Fatalf("rules.is_active missing")
	}
}

func TestMigrateAddsRuleIsActiveAndSettings(t *testing.T) {
	st := openTestStore(t) // Open already runs schema + migrate
	// rules.is_active must exist and default to 1
	var dflt int
	if err := st.DB.QueryRow(`SELECT count(*) FROM pragma_table_info('rules') WHERE name='is_active'`).Scan(&dflt); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if dflt != 1 {
		t.Fatalf("rules.is_active column missing")
	}
	// app_settings singleton must be ensurable
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("EnsureAppSettings: %v", err)
	}
	var n int
	if err := st.DB.QueryRow(`SELECT count(*) FROM app_settings WHERE id=1`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("app_settings singleton not present, got %d", n)
	}
}

func TestMigrateAddsRefundOfID(t *testing.T) {
	st := openTestStore(t)
	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM pragma_table_info('transactions') WHERE name='refund_of_id'`,
	).Scan(&n); err != nil {
		t.Fatalf("pragma: %v", err)
	}
	if n != 1 {
		t.Fatal("transactions.refund_of_id column missing")
	}
}
