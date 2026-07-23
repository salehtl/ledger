package store

import "testing"

func TestConnectionPragmasApplyToEveryConnection(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var syncMode int
	if err := st.DB.QueryRow(`PRAGMA synchronous`).Scan(&syncMode); err != nil {
		t.Fatal(err)
	}
	if syncMode != 1 { // 1 = NORMAL
		t.Fatalf("synchronous = %d, want 1 (NORMAL)", syncMode)
	}

	// FK enforcement must hold on pooled connections (DSN, not one-shot Exec):
	// inserting a suggestion pointing at a nonexistent category must fail.
	_, err = st.DB.Exec(
		`INSERT INTO ai_suggestions (merchant_norm, category_id, confidence, created_at)
		 VALUES ('fk-probe', 999999, 0.5, '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Fatal("expected foreign-key violation, insert succeeded")
	}
}

func TestPerfIndexesExist(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, idx := range []string{"idx_ingest_created", "idx_tx_ingest"} {
		var n int
		if err := st.DB.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?`, idx,
		).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("index %s missing", idx)
		}
	}
}
