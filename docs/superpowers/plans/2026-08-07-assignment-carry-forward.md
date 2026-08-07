# Assignment Carry-Forward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user opens a month they have never planned, it arrives carrying the previous month's assignments, so a stable budget does not have to be re-entered every month.

**Architecture:** Lazy seeding. A new store method copies the most recent planned month's non-zero assignments into the requested month, guarded so it fires at most once per month and never rewrites history. It is called from the envelope summary path behind the existing `envelopeMu` mutex.

**Tech Stack:** Go 1.22+ (stdlib `net/http` routing, `modernc.org/sqlite`, no cgo). No frontend change.

Spec: `docs/superpowers/specs/2026-08-07-assignment-carry-forward-design.md`

## Global Constraints

- Money is always `int64` minor units (AED fils). Never floats.
- Months are always the string `'YYYY-MM'`. `store.validMonth` (`internal/store/envelopes.go:25`) is the validator — reuse it, do not write another. An exported `store.ValidMonth` wrapper also exists.
- `envelope_assignments` is keyed `(month, category_id)` with a unique index; `assigned_fils` may be negative (move-money can over-draw a source envelope — see the comment on `AddToEnvelopeAssignment`).
- **"Touched" means the month has ANY row in `envelope_assignments`, including rows whose `assigned_fils` is 0.** Zeroing a month writes rows, so this is what makes a deliberately-emptied month stay empty. Do not substitute "has no non-zero rows" — that is a different, wrong rule.
- Seeding must never write to a month earlier than the current calendar month.
- Go tests live beside the code as `*_test.go`.
- Run `gofmt -w` on every Go file you touch. Two files are already gofmt-dirty on `main` and are unrelated: `internal/server/rates_test.go`, `internal/ingest/ingest.go`. Do not touch them.
- **Work in `/root/Coding/ledger/.claude/worktrees/assignment-carry-forward` on branch `worktree-assignment-carry-forward`.** Your shell may start in the main checkout `/root/Coding/ledger` — `cd` to the worktree first. Confirm with `pwd && git branch --show-current`; if the branch is `main` you are in the wrong tree.
- Do NOT deploy, do NOT restart the `ledger` service, and do NOT read or write `/var/lib/ledger/ledger.db`. Tests use temp dirs.

---

### Task 1: Store method — seed a month from the previous plan

**Files:**
- Modify: `internal/store/envelopes.go` (add one method near the other assignment writers, after `ApplyEnvelopeDeltas`)
- Test: `internal/store/envelopes_seed_test.go` (create)

**Interfaces:**
- Consumes: `validMonth(string) bool`; the `envelope_assignments` table `(id, month, category_id, assigned_fils, updated_at)` with unique index on `(month, category_id)`; `isoNow(s)`.
- Produces: `func (s *Store) SeedEnvelopeAssignmentsFromPreviousMonth(month string) (int, error)` — returns the number of rows written, 0 when any guard declines. Returns `ErrEnvelopeInvalid`-wrapped error on a malformed month.

- [ ] **Step 1: Write the failing tests**

Create `internal/store/envelopes_seed_test.go`:

```go
package store

import (
	"errors"
	"testing"
	"time"
)

// thisMonth is the current calendar month; seeding refuses to touch anything
// earlier, so tests that must succeed have to use it or later.
func thisMonth() string { return time.Now().UTC().Format("2006-01") }

func monthsFromNow(n int) string {
	return time.Now().UTC().AddDate(0, n, 0).Format("2006-01")
}

func assign(t *testing.T, st *Store, month string, categoryID, fils int64) {
	t.Helper()
	if err := st.UpsertEnvelopeAssignment(month, categoryID, fils); err != nil {
		t.Fatalf("assign %s cat=%d: %v", month, categoryID, err)
	}
}

func assignedIn(t *testing.T, st *Store, month string) map[int64]int64 {
	t.Helper()
	rows, err := st.SelectEnvelopeAssignments(month)
	if err != nil {
		t.Fatal(err)
	}
	out := map[int64]int64{}
	for _, r := range rows {
		out[r.CategoryID] = r.AssignedFils
	}
	return out
}

func rowCount(t *testing.T, st *Store, month string) int {
	t.Helper()
	var n int
	if err := st.DB.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, month).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// The feature: an untouched month inherits the previous month's plan.
func TestSeedAssignments_CarriesPreviousMonthForward(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Transport")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, prev, b, 50000)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("seeded %d rows, want 2", n)
	}
	got := assignedIn(t, st, next)
	if got[a] != 150000 || got[b] != 50000 {
		t.Errorf("seeded assignments = %v, want {%d:150000, %d:50000}", got, a, b)
	}
}

// Zeroing a month writes rows. Those rows are the record that the user touched
// it, so it must stay empty rather than refilling itself.
func TestSeedAssignments_LeavesDeliberatelyZeroedMonthAlone(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, next, a, 0) // user zeroed it on purpose

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows into a touched month, want 0", n)
	}
	if got := assignedIn(t, st, next); got[a] != 0 {
		t.Errorf("assignment = %d, want 0 — seeding overwrote a deliberate zero", got[a])
	}
}

// A month with a real plan must never be overwritten.
func TestSeedAssignments_LeavesPlannedMonthAlone(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, next, a, 999)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows, want 0", n)
	}
	if got := assignedIn(t, st, next); got[a] != 999 {
		t.Errorf("assignment = %d, want 999 (untouched)", got[a])
	}
}

// Browsing history must never rewrite it.
func TestSeedAssignments_RefusesMonthsBeforeThisOne(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	assign(t, st, monthsFromNow(-2), a, 150000)
	past := monthsFromNow(-1)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(past)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows into a past month, want 0", n)
	}
	if rowCount(t, st, past) != 0 {
		t.Error("a past month gained assignment rows")
	}
}

// Gaps: jumping ahead inherits the most recent PLANNED month, not the empty
// one immediately before.
func TestSeedAssignments_SkipsEmptyMonths(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	assign(t, st, thisMonth(), a, 150000)
	far := monthsFromNow(3)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(far)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("seeded %d rows, want 1", n)
	}
	if got := assignedIn(t, st, far); got[a] != 150000 {
		t.Errorf("assignment = %d, want 150000 inherited across the gap", got[a])
	}
}

// An all-zero month is not a plan; it must not be propagated as one.
func TestSeedAssignments_IgnoresAllZeroSourceMonth(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	assign(t, st, thisMonth(), a, 0)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(monthsFromNow(1))
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows from an all-zero month, want 0", n)
	}
}

// Only non-zero assignments are worth copying.
func TestSeedAssignments_CopiesOnlyNonZero(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	b := seedCat(t, st, "Transport")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	assign(t, st, prev, b, 0)

	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("seeded %d rows, want 1", n)
	}
	got := assignedIn(t, st, next)
	if _, present := got[b]; present {
		t.Errorf("a zero assignment was copied: %v", got)
	}
}

// Negative assignments are legal (move-money over-draws a source envelope) and
// are part of the plan, so they carry too.
func TestSeedAssignments_CarriesNegativeAssignments(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Healthcare")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)
	if _, err := st.AddToEnvelopeAssignment(prev, a, -400000); err != nil {
		t.Fatal(err)
	}

	if _, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next); err != nil {
		t.Fatal(err)
	}
	if got := assignedIn(t, st, next); got[a] != -250000 {
		t.Errorf("assignment = %d, want -250000 carried", got[a])
	}
}

// Called twice (two page loads), the second call must be a no-op.
func TestSeedAssignments_IsIdempotent(t *testing.T) {
	st := newTestStore(t)
	a := seedCat(t, st, "Groceries")
	prev, next := thisMonth(), monthsFromNow(1)
	assign(t, st, prev, a, 150000)

	first, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil || first != 1 {
		t.Fatalf("first call: n=%d err=%v", first, err)
	}
	second, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(next)
	if err != nil {
		t.Fatal(err)
	}
	if second != 0 {
		t.Errorf("second call seeded %d rows, want 0", second)
	}
	if rowCount(t, st, next) != 1 {
		t.Errorf("rows = %d after two calls, want 1", rowCount(t, st, next))
	}
}

func TestSeedAssignments_RejectsBadMonth(t *testing.T) {
	st := newTestStore(t)
	for _, m := range []string{"", "2026", "2026-13", "26-08"} {
		if _, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(m); !errors.Is(err, ErrEnvelopeInvalid) {
			t.Errorf("month %q: err = %v, want ErrEnvelopeInvalid", m, err)
		}
	}
}

func TestSeedAssignments_NoPriorPlanIsANoOp(t *testing.T) {
	st := newTestStore(t)
	n, err := st.SeedEnvelopeAssignmentsFromPreviousMonth(monthsFromNow(1))
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("seeded %d rows with no prior plan, want 0", n)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger/.claude/worktrees/assignment-carry-forward && go test ./internal/store/ -run TestSeedAssignments 2>&1 | tail -20`
Expected: FAIL, build error `undefined: SeedEnvelopeAssignmentsFromPreviousMonth`.

- [ ] **Step 3: Implement the method**

Add to `internal/store/envelopes.go`, after `ApplyEnvelopeDeltas`:

```go
// SeedEnvelopeAssignmentsFromPreviousMonth copies the most recent planned
// month's non-zero assignments into month, so a stable budget does not have to
// be re-entered every month. Returns how many rows it wrote; 0 when it
// declines. Idempotent.
//
// It declines unless all three hold:
//
//   - month has NO rows at all. Zeroing a month through the assign sheet
//     WRITES rows, so "has rows" is the faithful record of "the user has
//     touched this month" — a month deliberately emptied stays empty instead
//     of refilling itself. Do not weaken this to "has no non-zero rows".
//   - some earlier month has a non-zero assignment. The greatest such month
//     wins, so jumping ahead over empty months inherits the last real plan
//     rather than an empty one.
//   - month is the current calendar month or later. Browsing back through
//     history must never rewrite it.
//
// Negative assignments carry: move-money may over-draw a source envelope, and
// that is part of the plan, not a corruption of it.
func (s *Store) SeedEnvelopeAssignmentsFromPreviousMonth(month string) (int, error) {
	if !validMonth(month) {
		return 0, fmt.Errorf("%w: month %q (want YYYY-MM)", ErrEnvelopeInvalid, month)
	}
	if month < time.Now().UTC().Format("2006-01") {
		return 0, nil
	}

	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Re-check inside the transaction: the caller's mutex serialises the HTTP
	// handlers, but nothing stops another writer.
	var existing int
	if err := tx.QueryRow(
		`SELECT count(*) FROM envelope_assignments WHERE month=?`, month).Scan(&existing); err != nil {
		return 0, err
	}
	if existing > 0 {
		return 0, nil
	}

	var source string
	err = tx.QueryRow(
		`SELECT MAX(month) FROM envelope_assignments WHERE month < ? AND assigned_fils != 0`,
		month).Scan(&source)
	if errors.Is(err, sql.ErrNoRows) || source == "" {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}

	res, err := tx.Exec(
		`INSERT INTO envelope_assignments (month, category_id, assigned_fils, updated_at)
		 SELECT ?, category_id, assigned_fils, ?
		   FROM envelope_assignments
		  WHERE month = ? AND assigned_fils != 0`,
		month, isoNow(s), source)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int(n), nil
}
```

Note: `MAX(month)` over an empty set returns SQL NULL, which scans into a
`string` as an error on some drivers. If `Scan` errors on NULL, change `source`
to `sql.NullString` and treat `!source.Valid` as "no prior plan". Do whichever
the driver actually requires — verify by running the `NoPriorPlan` test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/Coding/ledger/.claude/worktrees/assignment-carry-forward && gofmt -w internal/store/ && go test ./internal/store/ -run TestSeedAssignments -v 2>&1 | tail -30`
Expected: all PASS.

- [ ] **Step 5: Run the whole store package**

Run: `go test ./internal/store/ 2>&1 | tail -10`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger/.claude/worktrees/assignment-carry-forward
git add internal/store/envelopes.go internal/store/envelopes_seed_test.go
git commit -m "feat(store): carry a month's assignments forward into an unplanned month

A stable budget should not have to be re-entered every month. An
untouched current-or-future month inherits the most recent planned
month's non-zero assignments; a month the user zeroed keeps its rows and
so stays empty.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Seed from the envelope summary path

**Files:**
- Modify: `internal/server/envelopes.go` (the `EnvelopeStore` interface at ~line 17, and `handleGetEnvelopes` at ~line 90)
- Test: `internal/server/envelopes_seed_test.go` (create)

**Interfaces:**
- Consumes: `(*store.Store).SeedEnvelopeAssignmentsFromPreviousMonth(month string) (int, error)` from Task 1; the existing `s.envelopeMu` mutex (`internal/server/server.go:128`).
- Produces: no new routes. `GET /api/envelopes?month=M` now seeds `M` before computing the summary.

- [ ] **Step 1: Write the failing test**

Create `internal/server/envelopes_seed_test.go`:

```go
package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func seedMonth(n int) string {
	return time.Now().UTC().AddDate(0, n, 0).Format("2006-01")
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

// Two simultaneous page loads must not double-seed.
func TestGetEnvelopes_ConcurrentReadsSeedOnce(t *testing.T) {
	st := newTestServerStore(t)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger/.claude/worktrees/assignment-carry-forward && go test ./internal/server/ -run TestGetEnvelopes_ 2>&1 | tail -20`
Expected: FAIL — `Groceries assigned = 0, want 150000 carried forward`.

- [ ] **Step 3: Add the method to the store interface**

In `internal/server/envelopes.go`, add to `EnvelopeStore`:

```go
	SeedEnvelopeAssignmentsFromPreviousMonth(month string) (int, error)
```

- [ ] **Step 4: Seed in the handler**

Replace `handleGetEnvelopes` with:

```go
func (s *Server) handleGetEnvelopes(w http.ResponseWriter, r *http.Request) {
	if s.envelopeStore == nil {
		errJSON(w, http.StatusServiceUnavailable, "envelopes unavailable")
		return
	}
	month, ok := envelopeMonth(w, r)
	if !ok {
		return
	}
	// Opening a month the user has never planned carries the previous month's
	// assignments into it, so a stable budget survives the month boundary
	// without being re-typed. This is a write on a GET — a real smell, kept
	// because the alternative (a month-rollover job) can only ever seed the
	// CURRENT month, so planning ahead would still land on an empty screen.
	// The store guards it to fire at most once per month and never on history;
	// envelopeMu is the same lock the mutation handlers take, so two
	// simultaneous page loads cannot double-seed.
	//
	// A seeding failure must not blank the screen: log nothing, fall through,
	// and serve the (unseeded) summary rather than 500.
	s.envelopeMu.Lock()
	_, _ = s.envelopeStore.SeedEnvelopeAssignmentsFromPreviousMonth(month)
	s.envelopeMu.Unlock()

	s.writeEnvelopeSummary(w, month)
}
```

- [ ] **Step 5: Fix other implementers of `EnvelopeStore`**

Run: `go build ./... && go vet ./... 2>&1 | head -20`
Any test fake implementing `EnvelopeStore` must gain the new method. Give a fake a no-op returning `(0, nil)` unless the test is about seeding.

- [ ] **Step 6: Run the tests**

Run: `cd /root/Coding/ledger/.claude/worktrees/assignment-carry-forward && gofmt -w internal/server/ && go test ./internal/server/ 2>&1 | tail -10`
Expected: `ok`.

- [ ] **Step 7: Run everything, with the race detector**

Run: `go test ./... 2>&1 | grep -v "^ok\|no test files" | head` then `go test -race ./internal/server/ ./internal/store/ 2>&1 | tail -5`
Expected: no failures, no race reports.

- [ ] **Step 8: Commit**

```bash
cd /root/Coding/ledger/.claude/worktrees/assignment-carry-forward
git add internal/server/
git commit -m "feat(plan): carry assignments into a month the first time it is opened

Seeding runs in the envelope summary path behind envelopeMu, so two
simultaneous page loads cannot double-seed, and a seeding failure serves
the unseeded summary rather than blanking the screen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification (orchestrator, after all tasks)

Not a subagent task.

1. `go test ./...` and `go test -race ./internal/server/ ./internal/store/`
2. Frontend is unchanged, so no dist rebuild is needed — confirm `git diff --stat main..HEAD` touches no `frontend/` or `internal/web/dist/` file. If it does, rebuild dist before building the binary.
3. Restore a scratch copy of production into a scratch dir, run the new binary on a scratch port (never `:8080`, never `/var/lib/ledger`):
   - `GET /api/envelopes?month=2026-08` — August has 18 rows and must be returned **unchanged**: assigned 45,459.82, RTA −4,551.16.
   - `GET /api/envelopes?month=2026-09` — must arrive carrying August's non-zero assignments; confirm the row count in `envelope_assignments` for 2026-09 equals the number of non-zero August rows.
   - Re-request September; row count must not grow.
   - `GET /api/envelopes?month=2026-06` — a past month must gain no rows.
4. Carryover must not regress: 2026-08 still reports Investments 800000, Utilities 224272, Entertainment 64050.
5. Back up production, deploy, verify the running binary by exe link, and re-check the same figures live.
