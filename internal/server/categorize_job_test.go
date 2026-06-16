package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ledger/internal/store"
)

// seedNeedsReview inserts a needs_review transaction with the given merchant and
// a unique amount so fingerprints differ. Returns the new row ID.
func seedNeedsReview(t *testing.T, st *store.Store, merchant string, amt int64) int64 {
	t.Helper()
	id, _, err := st.InsertTransaction(store.TransactionRow{
		PostedAt:    time.Date(2026, 6, 1, 0, 0, int(amt), 0, time.UTC),
		AmountFils:  amt,
		Currency:    "AED",
		Direction:   "debit",
		MerchantRaw: merchant,
		Status:      "needs_review",
		Tier:        "template",
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func waitCategorizeIdle(t *testing.T, srv *Server) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if status, _, _ := srv.categorizeStatus(); status == "idle" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("categorization did not become idle in time")
}

func shoppingID(t *testing.T, st *store.Store) int64 {
	t.Helper()
	cats, _ := st.SelectCategories()
	for _, c := range cats {
		if c.Name == "Shopping" {
			return c.ID
		}
	}
	t.Fatal("Shopping category not found")
	return 0
}

func TestCategorizeJob_StatusIdleInitially(t *testing.T) {
	srv := newTestServerWithStore(t, newTestServerStore(t))
	status, processed, total := srv.categorizeStatus()
	if status != "idle" || processed != 0 || total != 0 {
		t.Fatalf("got %q %d %d, want idle 0 0", status, processed, total)
	}
}

func TestCategorizeJob_ProcessesAllAndBroadcasts(t *testing.T) {
	st := newTestServerStore(t)
	a := seedNeedsReview(t, st, "ACME", 1000)
	b := seedNeedsReview(t, st, "BETA", 2000)
	catID := shoppingID(t, st)
	srv := newTestServerWithStore(t, st)
	srv.SetRecategorizeFn(func(context.Context, string) (int64, string, bool) { return catID, "confirmed", true })
	hub := NewHub()
	srv.SetHub(hub)
	ch, unsub := hub.Subscribe()
	defer unsub()

	started, err := srv.startCategorize("", "")
	if err != nil || !started {
		t.Fatalf("startCategorize: started=%v err=%v", started, err)
	}
	waitCategorizeIdle(t, srv)

	_, processed, total := srv.categorizeStatus()
	if processed != 2 || total != 2 {
		t.Fatalf("processed=%d total=%d, want 2 2", processed, total)
	}
	for _, id := range []int64{a, b} {
		var status string
		st.DB.QueryRow("SELECT status FROM transactions WHERE id=?", id).Scan(&status)
		if status != "confirmed" {
			t.Errorf("tx %d status=%q, want confirmed", id, status)
		}
	}
	sawCategorize := false
	for drained := false; !drained; {
		select {
		case msg := <-ch:
			if strings.Contains(string(msg), `"categorize"`) {
				sawCategorize = true
			}
		default:
			drained = true
		}
	}
	if !sawCategorize {
		t.Error("expected a categorize SSE event")
	}
}

func TestCategorizeJob_DedupesByMerchant(t *testing.T) {
	st := newTestServerStore(t)
	seedNeedsReview(t, st, "ACME", 1000)
	seedNeedsReview(t, st, "ACME", 2000)
	seedNeedsReview(t, st, "ACME", 3000)
	catID := shoppingID(t, st)
	srv := newTestServerWithStore(t, st)
	var calls int32
	srv.SetRecategorizeFn(func(context.Context, string) (int64, string, bool) {
		atomic.AddInt32(&calls, 1)
		return catID, "confirmed", true
	})
	if started, err := srv.startCategorize("", ""); err != nil || !started {
		t.Fatalf("start: %v %v", started, err)
	}
	waitCategorizeIdle(t, srv)
	if _, processed, _ := srv.categorizeStatus(); processed != 3 {
		t.Errorf("processed=%d, want 3", processed)
	}
	if c := atomic.LoadInt32(&calls); c != 1 {
		t.Errorf("recatFn called %d times, want 1 (deduped)", c)
	}
}

func TestCategorizeJob_StopHalts(t *testing.T) {
	st := newTestServerStore(t)
	seedNeedsReview(t, st, "A", 1000)
	seedNeedsReview(t, st, "B", 2000)
	seedNeedsReview(t, st, "C", 3000)
	catID := shoppingID(t, st)
	srv := newTestServerWithStore(t, st)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var calls int32
	srv.SetRecategorizeFn(func(context.Context, string) (int64, string, bool) {
		if atomic.AddInt32(&calls, 1) == 1 {
			entered <- struct{}{}
			<-release
		}
		return catID, "confirmed", true
	})
	if started, _ := srv.startCategorize("", ""); !started {
		t.Fatal("expected start")
	}
	<-entered
	srv.stopCategorize()
	close(release)
	waitCategorizeIdle(t, srv)

	_, processed, _ := srv.categorizeStatus()
	if processed != 1 {
		t.Errorf("processed=%d, want 1 (stopped after first item)", processed)
	}
	if c := atomic.LoadInt32(&calls); c != 1 {
		t.Errorf("calls=%d, want 1", c)
	}
}

func TestCategorizeJob_RejectsConcurrentRun(t *testing.T) {
	st := newTestServerStore(t)
	seedNeedsReview(t, st, "A", 1000)
	catID := shoppingID(t, st)
	srv := newTestServerWithStore(t, st)
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	var once int32
	srv.SetRecategorizeFn(func(context.Context, string) (int64, string, bool) {
		if atomic.AddInt32(&once, 1) == 1 {
			entered <- struct{}{}
			<-release
		}
		return catID, "confirmed", true
	})
	if started, _ := srv.startCategorize("", ""); !started {
		t.Fatal("first start should succeed")
	}
	<-entered
	if started, _ := srv.startCategorize("", ""); started {
		t.Error("second start should be rejected while running")
	}
	close(release)
	waitCategorizeIdle(t, srv)
}


func TestHandleCategorizeStatus(t *testing.T) {
	srv := newTestServerWithStore(t, newTestServerStore(t))
	r := httptest.NewRequest("GET", "/api/categorize/status", nil)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	var resp map[string]any
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["status"] != "idle" {
		t.Errorf("status=%v, want idle", resp["status"])
	}
}

func TestHandleCategorizeRunAndConflict(t *testing.T) {
	st := newTestServerStore(t)
	seedNeedsReview(t, st, "A", 1000)
	catID := shoppingID(t, st)
	srv := newTestServerWithStore(t, st)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	var once int32
	srv.SetRecategorizeFn(func(context.Context, string) (int64, string, bool) {
		if atomic.AddInt32(&once, 1) == 1 {
			entered <- struct{}{}
			<-release
		}
		return catID, "confirmed", true
	})

	w := httptest.NewRecorder()
	srv.ServeHTTP(w, httptest.NewRequest("POST", "/api/categorize/run", strings.NewReader(`{}`)))
	if w.Code != http.StatusOK {
		t.Fatalf("run status=%d body=%s", w.Code, w.Body)
	}
	<-entered
	w2 := httptest.NewRecorder()
	srv.ServeHTTP(w2, httptest.NewRequest("POST", "/api/categorize/run", strings.NewReader(`{}`)))
	if w2.Code != http.StatusConflict {
		t.Errorf("second run status=%d, want 409", w2.Code)
	}
	w3 := httptest.NewRecorder()
	srv.ServeHTTP(w3, httptest.NewRequest("POST", "/api/categorize/stop", nil))
	if w3.Code != http.StatusOK {
		t.Errorf("stop status=%d, want 200", w3.Code)
	}
	close(release)
	waitCategorizeIdle(t, srv)
}
