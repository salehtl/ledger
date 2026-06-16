# Scoped, Controllable Categorization Runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synchronous whole-backlog `/api/recategorize` with an asynchronous, in-memory categorization job that can be **run**, **stopped**, and **scoped to a date range**, with live progress shown in Settings.

**Architecture:** A single in-memory job on the `Server` (one run at a time, single-user app) processes *Needs review* transactions in a chosen `[from,to]` range, dedupes by merchant, categorizes via the existing `recatFn`, checks a context between items so Stop halts gracefully, and broadcasts throttled progress over the existing SSE `Hub`. The frontend Settings card drives it with a period control (reusing `PeriodSheet`), Run/Stop, and a live progress line.

**Tech Stack:** Go (stdlib `net/http`, `context`, `sync`), SQLite via `store`; React + TypeScript, TanStack Query, the existing `Scope`/`PeriodSheet`/SSE plumbing.

**Base:** branch `feat/scoped-categorization` (off `main`, with the 429-retry + per-merchant-dedup work already merged in). Pause and Stop are the same action (no resume) per the spec.

---

## File structure

- **Create** `internal/server/categorize_job.go` — the job state machine (`categorizeJob` type, `startCategorize`/`runCategorize`/`stopCategorize`/`categorizeStatus`) and the three HTTP handlers.
- **Create** `internal/server/categorize_job_test.go` — job + endpoint tests.
- **Modify** `internal/server/server.go` — add the `catJob` field; register the 3 routes; remove the `/api/recategorize` route.
- **Modify** `internal/server/transactions.go` — remove `handleRecategorize` (superseded by the job).
- **Modify** `internal/server/transactions_test.go` — remove the 3 `/api/recategorize` tests + now-unused imports.
- **Modify** `frontend/src/api/types.ts` — add `CategorizeStatus`.
- **Modify** `frontend/src/hooks/useLiveEvents.ts` — refresh `["categorize-status"]` on live events.
- **Modify** `frontend/src/app/AppShell.tsx` — pass `scope` to `<Settings>`.
- **Modify** `frontend/src/screens/Settings.tsx` — replace the "Run categorization now" button with the scoped Run/Stop + progress control.
- **Modify** `frontend/src/screens/Settings.categorization.test.tsx` — swap the recategorize assertions for the new run/stop/status flow.

Reference facts (verified in the base):
- `Server` has `catStore CategoryStore`, `recatFn CategorizeFunc`, `hub *Hub`; `BroadcastEvent(type, data)` is a no-op when `hub` is nil.
- `CategorizeFunc = func(ctx context.Context, merchantRaw string) (categoryID int64, status string, ok bool)`.
- `catStore.SelectTransactions(status, from, to string) ([]store.ReviewItem, error)`; `catStore.UpdateTransactionCategory(txID, categoryID int64, status string) error`.
- `store.ReviewItem` has `ID int64` and `MerchantRaw string`.
- `NewHub() *Hub`; `hub.Subscribe() (chan []byte, func())`.
- Frontend has `lib/scope.ts` (`Scope`, `scopeBounds`, `scopeLabel`, `DEFAULT_SCOPE`) and `components/ui/PeriodSheet.tsx` (`<PeriodSheet scope onApply onClose />`).

---

## Task 1: Categorization job (state machine + processing)

**Files:**
- Create: `internal/server/categorize_job.go`
- Create: `internal/server/categorize_job_test.go`
- Modify: `internal/server/server.go` (add `catJob` field)

- [ ] **Step 1: Add the job field to the Server struct** — in `internal/server/server.go`, inside the `type Server struct { ... }` block, add a field after `recatFn CategorizeFunc`:

```go
	catJob          categorizeJob
```

- [ ] **Step 2: Write the failing test** — create `internal/server/categorize_job_test.go`:

```go
package server

import (
	"context"
	"encoding/json"
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
	// At least one "categorize" event was broadcast (the final idle event always fires).
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
	<-entered          // first item is in flight
	srv.stopCategorize() // cancel before it finishes
	close(release)     // let the first item complete
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

var _ = json.Marshal // keep encoding/json imported for endpoint tests added later
```

- [ ] **Step 3: Run the test to verify it fails** — `go test ./internal/server/ -run TestCategorizeJob -v`
Expected: FAIL — `srv.categorizeStatus`, `srv.startCategorize`, `srv.stopCategorize` undefined.

- [ ] **Step 4: Implement the job** — create `internal/server/categorize_job.go`:

```go
package server

import (
	"context"
	"sync"
	"time"

	"ledger/internal/store"
)

// categorizeJob is the single in-memory background categorization run. One run
// at a time; each transaction is committed as it's categorized, so a restart
// mid-run just leaves the rest in needs_review.
type categorizeJob struct {
	mu        sync.Mutex
	running   bool
	cancel    context.CancelFunc
	processed int
	total     int
}

type recatOutcome struct {
	catID  int64
	status string
	ok     bool
}

// startCategorize launches a run over needs_review transactions in [from,to]
// (empty bounds = all time). Returns false if a run is already in progress or
// categorization isn't wired.
func (s *Server) startCategorize(from, to string) (bool, error) {
	if s.catStore == nil || s.recatFn == nil {
		return false, nil
	}
	j := &s.catJob
	j.mu.Lock()
	if j.running {
		j.mu.Unlock()
		return false, nil
	}
	items, err := s.catStore.SelectTransactions("needs_review", from, to)
	if err != nil {
		j.mu.Unlock()
		return false, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	j.running = true
	j.cancel = cancel
	j.processed = 0
	j.total = len(items)
	j.mu.Unlock()

	go s.runCategorize(ctx, items)
	return true, nil
}

func (s *Server) runCategorize(ctx context.Context, items []store.ReviewItem) {
	j := &s.catJob
	defer func() {
		j.mu.Lock()
		j.running = false
		j.cancel = nil
		processed, total := j.processed, j.total
		j.mu.Unlock()
		s.BroadcastEvent("categorize", map[string]any{"status": "idle", "processed": processed, "total": total})
	}()

	// Dedupe by merchant: categorizing a given merchant is deterministic, so
	// call recatFn once per distinct merchant and apply to all matching rows.
	cache := make(map[string]recatOutcome)
	var lastBroadcast time.Time
	for _, item := range items {
		select {
		case <-ctx.Done():
			return
		default:
		}
		res, cached := cache[item.MerchantRaw]
		if !cached {
			catID, status, ok := s.recatFn(ctx, item.MerchantRaw)
			res = recatOutcome{catID: catID, status: status, ok: ok}
			cache[item.MerchantRaw] = res
		}
		if res.ok {
			_ = s.catStore.UpdateTransactionCategory(item.ID, res.catID, res.status)
		}
		j.mu.Lock()
		j.processed++
		processed, total := j.processed, j.total
		j.mu.Unlock()
		// Throttle progress to ~3/sec so the SSE stream isn't chatty.
		if time.Since(lastBroadcast) > 300*time.Millisecond {
			lastBroadcast = time.Now()
			s.BroadcastEvent("categorize", map[string]any{"status": "running", "processed": processed, "total": total})
		}
	}
}

// stopCategorize cancels the running job (this is both "pause" and "stop").
func (s *Server) stopCategorize() {
	j := &s.catJob
	j.mu.Lock()
	if j.cancel != nil {
		j.cancel()
	}
	j.mu.Unlock()
}

// categorizeStatus returns the current run state.
func (s *Server) categorizeStatus() (status string, processed, total int) {
	j := &s.catJob
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.running {
		return "running", j.processed, j.total
	}
	return "idle", j.processed, j.total
}
```

- [ ] **Step 5: Run the tests to verify they pass** — `go test ./internal/server/ -run TestCategorizeJob`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add internal/server/categorize_job.go internal/server/categorize_job_test.go internal/server/server.go
git commit -m "feat(server): in-memory categorization job (run/stop/status, dedup, progress)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: HTTP endpoints + remove `/api/recategorize`

**Files:**
- Modify: `internal/server/categorize_job.go` (add handlers)
- Modify: `internal/server/server.go` (routes)
- Modify: `internal/server/transactions.go` (remove `handleRecategorize`)
- Modify: `internal/server/transactions_test.go` (remove its 3 tests + unused imports)
- Modify: `internal/server/categorize_job_test.go` (add endpoint tests)

- [ ] **Step 1: Write the failing endpoint tests** — in `internal/server/categorize_job_test.go`, add (and you can drop the `var _ = json.Marshal` line now that json is used here):

```go
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
	// A second run while one is in progress → 409.
	w2 := httptest.NewRecorder()
	srv.ServeHTTP(w2, httptest.NewRequest("POST", "/api/categorize/run", strings.NewReader(`{}`)))
	if w2.Code != http.StatusConflict {
		t.Errorf("second run status=%d, want 409", w2.Code)
	}
	// Stop endpoint returns 200.
	w3 := httptest.NewRecorder()
	srv.ServeHTTP(w3, httptest.NewRequest("POST", "/api/categorize/stop", nil))
	if w3.Code != http.StatusOK {
		t.Errorf("stop status=%d, want 200", w3.Code)
	}
	close(release)
	waitCategorizeIdle(t, srv)
}
```

Add the imports this test needs to the file's import block: `"net/http"` and `"net/http/httptest"` (alongside the existing `context`, `encoding/json`, `strings`, `sync/atomic`, `testing`, `time`, `ledger/internal/store`).

- [ ] **Step 2: Run, verify it fails** — `go test ./internal/server/ -run TestHandleCategorize -v`
Expected: FAIL — routes `/api/categorize/*` not registered (404), so status codes won't match.

- [ ] **Step 3: Add the handlers** — append to `internal/server/categorize_job.go`:

```go
type categorizeRunReq struct {
	From string `json:"from"`
	To   string `json:"to"`
}

func (s *Server) handleCategorizeRun(w http.ResponseWriter, r *http.Request) {
	if s.catStore == nil || s.recatFn == nil {
		http.Error(w, `{"error":"categorize unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req categorizeRunReq
	_ = json.NewDecoder(r.Body).Decode(&req) // empty/absent body = all time
	started, err := s.startCategorize(req.From, req.To)
	if err != nil {
		http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
		return
	}
	if !started {
		http.Error(w, `{"error":"already running"}`, http.StatusConflict)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"started": true})
}

func (s *Server) handleCategorizeStop(w http.ResponseWriter, r *http.Request) {
	s.stopCategorize()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"stopped": true})
}

func (s *Server) handleCategorizeStatus(w http.ResponseWriter, r *http.Request) {
	status, processed, total := s.categorizeStatus()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"status": status, "processed": processed, "total": total})
}
```

Add `"encoding/json"` and `"net/http"` to the imports of `categorize_job.go` (it currently imports `context`, `sync`, `time`, `ledger/internal/store`).

- [ ] **Step 4: Register routes / remove the old one** — in `internal/server/server.go` `routes(...)`, replace the line:

```go
	s.mux.HandleFunc("POST /api/recategorize", s.handleRecategorize)
```

with:

```go
	s.mux.HandleFunc("POST /api/categorize/run", s.handleCategorizeRun)
	s.mux.HandleFunc("POST /api/categorize/stop", s.handleCategorizeStop)
	s.mux.HandleFunc("GET /api/categorize/status", s.handleCategorizeStatus)
```

- [ ] **Step 5: Remove the dead handler** — in `internal/server/transactions.go`, delete the entire `func (s *Server) handleRecategorize(...)` function (the block that selects needs_review and loops with the merchant dedupe). Leave `handleCategorize`, `handleGetTransactions`, `handleClearCategorization`, and `handleSetStatus` intact.

- [ ] **Step 6: Remove the old tests + unused imports** — in `internal/server/transactions_test.go`, delete `TestPostRecategorize_NoFn`, `TestPostRecategorize_WithFn`, and `TestPostRecategorize_DedupesByMerchant`. Then remove any imports left unused by that deletion: `"time"` and `"ledger/internal/store"` (the dedupe test was their only user; `database/sql` is still used by `TestClearCategorization`, keep it). Run `go vet ./internal/server/` to confirm no unused imports remain.

- [ ] **Step 7: Run the suite** — `go test ./internal/server/`
Expected: PASS (job tests, new endpoint tests, and the remaining transaction tests).

- [ ] **Step 8: Commit**

```bash
git add internal/server/categorize_job.go internal/server/categorize_job_test.go internal/server/server.go internal/server/transactions.go internal/server/transactions_test.go
git commit -m "feat(server): /api/categorize run|stop|status endpoints; drop /api/recategorize

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Frontend types + live status refresh

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/hooks/useLiveEvents.ts`

- [ ] **Step 1: Add the status type** — in `frontend/src/api/types.ts`, add:

```ts
export interface CategorizeStatus { status: "idle" | "running"; processed: number; total: number; }
```

- [ ] **Step 2: Refresh the status query on live events** — in `frontend/src/hooks/useLiveEvents.ts`, add `["categorize-status"]` to the `LIVE_INVALIDATE_KEYS` array so progress (and the views) refresh as rows are categorized:

```ts
export const LIVE_INVALIDATE_KEYS = [["summary"], ["transactions"], ["review"], ["insights-categories"], ["insights-trend"], ["categorize-status"]] as const;
```

- [ ] **Step 3: Type-check** — `cd frontend && bun run build`
Expected: compiles with no TS errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/hooks/useLiveEvents.ts
git commit -m "feat(frontend): CategorizeStatus type + live categorize-status refresh

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Don't commit the regenerated `internal/web/dist/` here — Task 5 rebuilds it.)

---

## Task 4: Settings UI — scoped Run/Stop + progress

**Files:**
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/screens/Settings.tsx`
- Modify: `frontend/src/screens/Settings.categorization.test.tsx`

- [ ] **Step 1: Pass the scope to Settings** — in `frontend/src/app/AppShell.tsx`, change the Settings render line:

```tsx
          {tab === "settings" && <Settings />}
```

to:

```tsx
          {tab === "settings" && <Settings scope={scope} />}
```

(`Scope` is already imported in AppShell.)

- [ ] **Step 2: Rewrite the Settings categorization run control.** In `frontend/src/screens/Settings.tsx`:

(a) Add imports near the existing ones:

```ts
import { PeriodSheet } from "../components/ui/PeriodSheet";
import { type Scope, scopeBounds, scopeLabel, DEFAULT_SCOPE } from "../lib/scope";
import type { AppSettings, BudgetConfig, Category, Rule, CategorizeStatus } from "../api/types";
```

(merge `CategorizeStatus` into the existing `../api/types` import rather than duplicating it.)

(b) Change the function signature:

```tsx
export function Settings({ scope }: { scope?: Scope }) {
```

(c) Add a status query next to the other `useQuery` calls:

```tsx
  const catStatus = useQuery({ queryKey: ["categorize-status"], queryFn: () => getJSON<CategorizeStatus>("/api/categorize/status") });
```

(d) Delete the `runCategorization` function and the `const [recatBusy, setRecatBusy] = useState(false);` line. Add new state + handlers (place the state near the other `useState` calls, the handlers near `saveSettings`):

```tsx
  const [runScope, setRunScope] = useState<Scope>(() => scope ?? DEFAULT_SCOPE);
  const [periodOpen, setPeriodOpen] = useState(false);
  const running = catStatus.data?.status === "running";

  const runCategorization = async () => {
    const b = scopeBounds(runScope);
    try {
      await postJSON("/api/categorize/run", { from: b.from ?? "", to: b.to ?? "" });
      qc.invalidateQueries({ queryKey: ["categorize-status"] });
    } catch { show({ message: "Couldn't start categorization", tone: "error" }); }
  };

  const stopCategorization = async () => {
    try {
      await postJSON("/api/categorize/stop", {});
      qc.invalidateQueries({ queryKey: ["categorize-status"] });
    } catch { show({ message: "Couldn't stop categorization", tone: "error" }); }
  };
```

(e) Replace the run-button block (the `<div className="mt-4"> … Run categorization now … </div>`) with:

```tsx
          <div className="mt-4">
            {running ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm tnum">{catStatus.data!.processed} of {catStatus.data!.total} categorized</span>
                <Button variant="secondary" onClick={stopCategorization}>Stop</Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => setPeriodOpen(true)}>{scopeLabel(runScope)}</Button>
                <Button variant="primary" onClick={runCategorization}>Run</Button>
              </div>
            )}
            <p className="text-xs text-muted mt-1.5">
              Categorizes Needs review for {scopeLabel(runScope)} ({settings.data.ai_enabled ? "rules + AI" : "rules"}).
            </p>
          </div>
          {periodOpen && (
            <PeriodSheet
              scope={runScope}
              onApply={(s) => { setRunScope(s); setPeriodOpen(false); }}
              onClose={() => setPeriodOpen(false)}
            />
          )}
```

Leave the "Anthropic API key" status block above it unchanged.

- [ ] **Step 3: Update the categorization test** — in `frontend/src/screens/Settings.categorization.test.tsx`:

(a) In the `fetch` stub, remove the `/api/recategorize` branch and add categorize-status/run/stop branches. Add these inside the stub (before the final fallthrough):

```ts
    if (url === "/api/categorize/status") {
      return new Response(JSON.stringify({ status: "idle", processed: 0, total: 0 }));
    }
    if (url === "/api/categorize/run" && init?.method === "POST") {
      calls.push({ url, method: "POST", body: init.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ started: true }));
    }
    if (url === "/api/categorize/stop" && init?.method === "POST") {
      calls.push({ url, method: "POST", body: null });
      return new Response(JSON.stringify({ stopped: true }));
    }
```

(b) Replace the old "runs a categorization pass on demand" test with one for the scoped run. The default `Scope` (no scope prop) is the current month, so `scopeBounds` yields `YYYY-MM-01`/`YYYY-MM-32`:

```ts
  it("starts a scoped categorization run", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /^run$/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/categorize/run" && c.method === "POST");
      expect(call).toBeDefined();
      const body = call!.body as { from: string; to: string };
      expect(body.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(body.to).toMatch(/^\d{4}-\d{2}-32$/);
    });
  });
```

(c) Keep the "shows the AI key status" test. Ensure the `wrap()` helper renders `<Settings />` (no scope prop) — that's fine; the default month scope is used.

- [ ] **Step 4: Run the Settings tests + build** — `cd frontend && bunx vitest run src/screens/Settings.categorization.test.tsx` then `bun run build`.
Expected: tests PASS; build compiles (no unused `recatBusy`, all imports used).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/AppShell.tsx frontend/src/screens/Settings.tsx frontend/src/screens/Settings.categorization.test.tsx
git commit -m "feat(frontend): scoped Run/Stop categorization control with live progress

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification + rebuild embedded bundle

**Files:**
- Modify: `internal/web/dist/**` (regenerated artifact)

- [ ] **Step 1: Full Go suite** — `cd /root/Coding/ledger && go test ./...`
Expected: PASS.

- [ ] **Step 2: Full frontend suite** — `cd frontend && bun run test`
Expected: PASS.

- [ ] **Step 3: Rebuild the embedded bundle** — `cd /root/Coding/ledger/frontend && bun install && bun run build`. If a stray empty `node_modules/` appears at the repo root afterward, remove it (`rm -rf /root/Coding/ledger/node_modules`).

- [ ] **Step 4: Build the binary** — `cd /root/Coding/ledger && CGO_ENABLED=0 go build -o ledger ./cmd/ledger`
Expected: builds, no errors.

- [ ] **Step 5: Commit the bundle**

```bash
git add internal/web/dist
git commit -m "chore(web): rebuild embedded bundle for scoped categorization runs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review checklist (run after building)

- **Spec coverage:** Run/Stop/status job (Task 1) + endpoints (Task 2); date-range scope via `scopeBounds` → `from`/`to` (Tasks 2, 4); needs_review only (`startCategorize` selects `"needs_review"`); Pause==Stop, no resume (single `stopCategorize` cancel; Run re-selects remaining); live progress over SSE (Task 1 broadcast + Task 3 invalidation); Settings placement with `PeriodSheet` (Task 4); removed `/api/recategorize` (Task 2).
- **Type consistency:** `categorizeStatus()` returns `(string, int, int)`; the status endpoint emits `{status, processed, total}`; `CategorizeStatus` matches. `recatOutcome{catID,status,ok}` used in `runCategorize`. `categorizeRunReq{From,To}` maps `{from,to}`. Frontend posts `{from,to}` from `scopeBounds`.
- **No placeholders:** every step has concrete code/commands.
- **Concurrency:** all `catJob` field access is under `j.mu`; the goroutine's `defer` always clears `running` and emits a final event (even on panic).
