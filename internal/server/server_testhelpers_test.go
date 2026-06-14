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
	return st
}

func newTestServerWithStore(t *testing.T, st *store.Store) *Server {
	t.Helper()
	srv := New(st, testFS())
	srv.SetCategoryStore(st)
	return srv
}
