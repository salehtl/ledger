package server

import (
	"testing"

	"ledger/internal/store"
)

func newTestServerStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	// main.go always calls this at boot (see cmd/ledger/main.go), and
	// computeEnvelopeSummary now reads AppSettings.BudgetMode on every
	// envelope request — without the singleton row, that read 500s in tests
	// that never call EnsureAppSettings themselves.
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatalf("EnsureAppSettings: %v", err)
	}
	return st
}

func newTestServerWithStore(t *testing.T, st *store.Store) *Server {
	t.Helper()
	srv := New(st, testFS())
	srv.SetCategoryStore(st)
	return srv
}
