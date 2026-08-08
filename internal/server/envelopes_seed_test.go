package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ledger/internal/store"
)

// seedMonth offsets the current calendar month by n. It normalises year/month
// arithmetic directly rather than using time.AddDate, which normalises DAY
// overflow (Jan 31 + 1 month → Mar 3) and would silently shift these months by
// one whenever the suite runs on the 29th–31st.
func seedMonth(n int) string {
	now := time.Now().UTC()
	y, m := now.Year(), int(now.Month())+n
	for m < 1 {
		y, m = y-1, m+12
	}
	y, m = y+(m-1)/12, (m-1)%12+1
	return fmt.Sprintf("%04d-%02d", y, m)
}

// getEnvelopes fetches the summary for a month and returns assigned_fils by
// category name.
func getEnvelopes(t *testing.T, srv *Server, month string) map[string]int64 {
	t.Helper()
	r := httptest.NewRequest("GET", "/api/envelopes?month="+month, nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/envelopes?month=%s = %d; body: %s", month, w.Code, w.Body)
	}
	var resp struct {
		Envelopes []struct {
			CategoryName string `json:"category_name"`
			AssignedFils int64  `json:"assigned_fils"`
		} `json:"envelopes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	for _, e := range resp.Envelopes {
		out[e.CategoryName] = e.AssignedFils
	}
	return out
}

// Opening an unplanned month must show last month's plan already in place.
func TestGetEnvelopes_SeedsUnplannedMonth(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if err := st.UpsertEnvelopeAssignment(seedMonth(0), cat, 150000); err != nil {
		t.Fatal(err)
	}

	got := getEnvelopes(t, srv, seedMonth(1))
	if got["Groceries"] != 150000 {
		t.Errorf("Groceries assigned = %d, want 150000 carried forward", got["Groceries"])
	}
}

// A month the user has touched must come back exactly as they left it.
func TestGetEnvelopes_DoesNotSeedTouchedMonth(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if err := st.UpsertEnvelopeAssignment(seedMonth(0), cat, 150000); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertEnvelopeAssignment(seedMonth(1), cat, 0); err != nil {
		t.Fatal(err)
	}

	got := getEnvelopes(t, srv, seedMonth(1))
	if got["Groceries"] != 0 {
		t.Errorf("Groceries assigned = %d, want 0 — a deliberate zero was overwritten", got["Groceries"])
	}
}

// Reading a past month must never plan it.
func TestGetEnvelopes_DoesNotSeedPastMonth(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")

	if err := st.UpsertEnvelopeAssignment(seedMonth(-2), cat, 150000); err != nil {
		t.Fatal(err)
	}
	past := seedMonth(-1)
	getEnvelopes(t, srv, past)

	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, past).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("past month gained %d assignment rows from a read", n)
	}
}

// syncBuffer is a bytes.Buffer safe for concurrent writes: the default logger
// is process-global, so goroutines from other tests may write to it while this
// one reads.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// failingSeedStore is a real store whose seeding always fails, to exercise the
// degraded path. Everything else is the genuine implementation.
type failingSeedStore struct{ *store.Store }

var errSeedBoom = errors.New("disk on fire")

func (failingSeedStore) SeedEnvelopeAssignmentsFromPreviousMonth(string) (int, error) {
	return 0, errSeedBoom
}

// A seeding failure must degrade, not blank the screen: still 200 with the
// unseeded summary — but it must be LOGGED. Swallowed, a month that quietly
// stops inheriting its plan is indistinguishable from one the user emptied on
// purpose, and there is no signal anywhere that seeding broke.
func TestGetEnvelopes_LogsSeedFailureAndStillServes(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(failingSeedStore{st})
	seedServerCategory(t, st, "Groceries")

	// Capture the default logger, restoring the REAL previous writer on
	// cleanup: log.SetOutput(nil) leaves a nil writer that panics any goroutine
	// still logging from another test. The buffer is mutex-guarded for the same
	// reason — background senders may log concurrently with this test.
	logs := &syncBuffer{}
	prevOut := log.Writer()
	log.SetOutput(logs)
	t.Cleanup(func() { log.SetOutput(prevOut) })

	month := seedMonth(1)
	r := httptest.NewRequest("GET", "/api/envelopes?month="+month, nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 — a seeding failure must not blank the screen", w.Code)
	}
	got := logs.String()
	if !strings.Contains(got, errSeedBoom.Error()) || !strings.Contains(got, month) {
		t.Errorf("seed failure was not logged with the month and cause; log was %q", got)
	}
}

// Two simultaneous page loads must not double-seed.
func TestGetEnvelopes_ConcurrentReadsSeedOnce(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureBudgetConfig(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetEnvelopeStore(st)
	cat := seedServerCategory(t, st, "Groceries")
	if err := st.UpsertEnvelopeAssignment(seedMonth(0), cat, 150000); err != nil {
		t.Fatal(err)
	}
	target := seedMonth(1)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := httptest.NewRequest("GET", "/api/envelopes?month="+target, nil)
			srv.ServeHTTP(httptest.NewRecorder(), r)
		}()
	}
	wg.Wait()

	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, target).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("rows = %d after 8 concurrent reads, want 1", n)
	}
}
