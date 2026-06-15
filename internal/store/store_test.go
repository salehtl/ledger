package store

import (
	"sort"
	"testing"
)

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
		"accounts", "app_settings", "budget_config", "categories", "import_log",
		"ingest_log", "push_subscriptions", "rules", "transactions",
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
