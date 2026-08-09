# Budget Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make simple monthly budgets the default — the budget persists, spending against it resets each month, and nothing carries in either direction — while keeping the envelope-budgeting logic intact behind a disabled mode.

**Architecture:** One setting, one branch point. In `simple` mode `EnvelopeMonthSummary` skips the prior-month era-fold and returns `CarryoverFils = 0` and `OverspendDebtFils = 0`; every downstream number (`available`, `overspent`, Ready to Assign, auto-assign, threshold notifications) is derived from those two fields and therefore corrects itself with no further edits.

**Tech Stack:** Go 1.22+ (stdlib `net/http` routing, `modernc.org/sqlite`, no cgo). No frontend change.

Spec: `docs/superpowers/specs/2026-08-08-budget-mode-simple-default-design.md`

## Global Constraints

- Money is always `int64` minor units (AED fils). Never floats.
- Months are always the string `'YYYY-MM'`.
- **Do not modify `envelopeEraFold` or any carryover/overspend-debt logic.** It is verified correct against production data and is being *sunset, not removed*. It must stay byte-identical and fully tested. If a change seems necessary, stop and report instead.
- Mode values are exactly `'simple'` and `'envelope'`. An empty or unrecognised stored value behaves as `'simple'` — never an error.
- `app_settings` is a singleton row (`id = 1`). New columns are added with `addColumnIfMissing` in `internal/store/store.go`'s `migrate`. **Do not put an index or constraint referencing a new column in `schema.sql`** — `schema.sql` runs BEFORE `migrate`, so it would execute against the old table shape and crash the service on every existing database. (This exact mistake was caught in a previous review.)
- Go tests live beside the code as `*_test.go`.
- Run `gofmt -w` on every Go file you touch. Two files are already gofmt-dirty on `main` and are unrelated: `internal/server/rates_test.go`, `internal/ingest/ingest.go`. Do not touch them.
- **Work in `/root/Coding/ledger/.claude/worktrees/budget-mode` on branch `worktree-budget-mode`.** Your shell may start in the main checkout `/root/Coding/ledger` — `cd` to the worktree first. Confirm with `pwd && git branch --show-current`; if the branch is `main` you are in the wrong tree.
- **Before your first edit run `git status` and confirm the tree is clean.** A previous branch was bitten twice by a stray diff sitting in the index. If anything unexpected is present, STOP and report rather than committing over it. Stage by explicit path; never `git add -A` or `git add .`.
- Do NOT deploy, do NOT restart the `ledger` service, and do NOT read or write `/var/lib/ledger/ledger.db`.

---

### Task 1: The setting

**Files:**
- Modify: `internal/store/settings.go` (the `AppSettings` struct and `SelectAppSettings`)
- Modify: `internal/store/store.go` (one `addColumnIfMissing` call inside `migrate`)
- Test: `internal/store/settings_test.go` (append)

**Interfaces:**
- Produces: `store.BudgetModeSimple = "simple"` and `store.BudgetModeEnvelope = "envelope"` constants; `AppSettings.BudgetMode string`; `func (s *Store) UpdateBudgetMode(mode string) error`; and `func NormalizeBudgetMode(m string) string`, which maps anything that is not exactly `"envelope"` to `"simple"`.

- [ ] **Step 1: Write the failing tests**

Append to `internal/store/settings_test.go`:

```go
func TestBudgetMode_DefaultsToSimple(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	a, err := st.SelectAppSettings()
	if err != nil {
		t.Fatal(err)
	}
	if a.BudgetMode != BudgetModeSimple {
		t.Errorf("BudgetMode = %q, want %q", a.BudgetMode, BudgetModeSimple)
	}
}

func TestUpdateBudgetMode_RoundTrips(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{BudgetModeEnvelope, BudgetModeSimple} {
		if err := st.UpdateBudgetMode(want); err != nil {
			t.Fatalf("UpdateBudgetMode(%q): %v", want, err)
		}
		a, err := st.SelectAppSettings()
		if err != nil {
			t.Fatal(err)
		}
		if a.BudgetMode != want {
			t.Errorf("BudgetMode = %q, want %q", a.BudgetMode, want)
		}
	}
}

// An unrecognised or empty stored value must behave as simple, never error —
// a bad settings row must not be able to take the Plan screen down.
func TestNormalizeBudgetMode(t *testing.T) {
	for in, want := range map[string]string{
		"":         BudgetModeSimple,
		"simple":   BudgetModeSimple,
		"envelope": BudgetModeEnvelope,
		"ENVELOPE": BudgetModeSimple, // exact match only
		"nonsense": BudgetModeSimple,
	} {
		if got := NormalizeBudgetMode(in); got != want {
			t.Errorf("NormalizeBudgetMode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUpdateBudgetMode_RejectsUnknown(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	if err := st.UpdateBudgetMode("nonsense"); err == nil {
		t.Error("UpdateBudgetMode accepted an unknown mode")
	}
}

// A row written before this column existed reads back as simple, not "".
func TestBudgetMode_LegacyRowReadsAsSimple(t *testing.T) {
	st := newTestStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB.Exec(`UPDATE app_settings SET budget_mode='' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	a, err := st.SelectAppSettings()
	if err != nil {
		t.Fatal(err)
	}
	if a.BudgetMode != BudgetModeSimple {
		t.Errorf("BudgetMode = %q, want %q", a.BudgetMode, BudgetModeSimple)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger/.claude/worktrees/budget-mode && go test ./internal/store/ -run 'BudgetMode' 2>&1 | tail -20`
Expected: FAIL, build errors about `BudgetModeSimple`, `UpdateBudgetMode`, `NormalizeBudgetMode`, `AppSettings.BudgetMode`.

- [ ] **Step 3: Add the column**

In `internal/store/store.go`, inside `migrate`, next to the other `addColumnIfMissing` calls:

```go
	// Budgeting method. 'simple' (default) is monthly budgets: the assignment
	// persists, spending resets each month, nothing carries. 'envelope' is the
	// original carryover + overspend-debt model, kept reachable but off by
	// default — sunset, not removed.
	if err := addColumnIfMissing(db, "app_settings", "budget_mode", "TEXT NOT NULL DEFAULT 'simple'"); err != nil {
		return err
	}
```

- [ ] **Step 4: Add the constants, struct field, reader and writer**

In `internal/store/settings.go`:

```go
// Budgeting methods. 'simple' is monthly budgets — the assignment persists
// month to month (see SeedEnvelopeAssignmentsFromPreviousMonth) while spending
// against it resets, and nothing carries in either direction. 'envelope' is the
// original model where underspend carries forward and overspend is charged to
// the next month; it is sunset behind this setting rather than deleted, so the
// logic stays available if it is ever surfaced again.
const (
	BudgetModeSimple   = "simple"
	BudgetModeEnvelope = "envelope"
)

// NormalizeBudgetMode maps anything that is not exactly BudgetModeEnvelope to
// BudgetModeSimple. A settings row written before this column existed, or
// corrupted to an unknown value, must fall back to the default rather than
// error — a bad settings read should never take the Plan screen down.
func NormalizeBudgetMode(m string) string {
	if m == BudgetModeEnvelope {
		return BudgetModeEnvelope
	}
	return BudgetModeSimple
}

// UpdateBudgetMode switches the budgeting method. Rejects unknown values so a
// typo cannot silently land the user in the default.
func (s *Store) UpdateBudgetMode(mode string) error {
	if mode != BudgetModeSimple && mode != BudgetModeEnvelope {
		return fmt.Errorf("invalid budget_mode %q (want %q or %q)", mode, BudgetModeSimple, BudgetModeEnvelope)
	}
	_, err := s.DB.Exec(`UPDATE app_settings SET budget_mode=? WHERE id=1`, mode)
	return err
}
```

Add `BudgetMode string` to the `AppSettings` struct, and read it in
`SelectAppSettings` — select `COALESCE(budget_mode,'')` into a local and assign
`out.BudgetMode = NormalizeBudgetMode(local)`. Read the existing
`SelectAppSettings` body and follow its exact scanning style; add the column to
its SELECT list in the same position as the struct field.

If `fmt` is not already imported in `settings.go`, add it.

- [ ] **Step 5: Run the tests**

Run: `cd /root/Coding/ledger/.claude/worktrees/budget-mode && gofmt -w internal/store/ && go test ./internal/store/ 2>&1 | tail -10`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger/.claude/worktrees/budget-mode
git add internal/store/settings.go internal/store/store.go internal/store/settings_test.go
git commit -m "feat(store): budget_mode setting, defaulting to simple

Sunsets envelope budgeting behind a setting rather than removing it. An
unrecognised stored value falls back to simple so a bad settings row
cannot take the Plan screen down.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Honour the mode, and expose the hidden switch

**Files:**
- Modify: `internal/store/envelopes.go` (`EnvelopeMonthSummary` — signature and one early branch)
- Modify: `internal/server/envelopes.go` (the `EnvelopeStore` interface and `computeEnvelopeSummary`)
- Modify: `internal/server/settings.go` (GET/PUT wire shape)
- Test: `internal/store/envelopes_mode_test.go` (create), `internal/server/settings_test.go` (append)

**Interfaces:**
- Consumes: `store.BudgetModeSimple`, `store.BudgetModeEnvelope`, `store.NormalizeBudgetMode`, `store.AppSettings.BudgetMode`, `(*store.Store).UpdateBudgetMode` from Task 1.
- Produces: `EnvelopeMonthSummary(month string, mode string) ([]EnvelopeMonthRow, error)`; `budget_mode` in the `GET`/`PUT /api/settings` JSON.

- [ ] **Step 1: Write the failing tests**

Create `internal/store/envelopes_mode_test.go`:

```go
package store

import "testing"

// buildCarryoverFixture creates a category whose PRIOR month underspends (so
// envelope mode carries money forward) and whose month-before-that overspends
// (so envelope mode charges debt). Returns the category id and the month to
// query. The fixture must produce non-zero carryover AND non-zero debt under
// envelope mode, otherwise the simple-mode assertions below would pass
// vacuously — the envelope-mode test at the end is what proves it does.
func buildCarryoverFixture(t *testing.T, st *Store) (int64, string) {
	t.Helper()
	cat := seedCat(t, st, "Groceries")
	// Two months back: assign 100, spend 300 -> 200 overspent, charged forward.
	if err := st.UpsertEnvelopeAssignment("2026-01", cat, 10000); err != nil {
		t.Fatal(err)
	}
	seedTxn(t, st, "2026-01-15", cat, 30000)
	// One month back: assign 500, spend 100 -> 400 left, carried forward.
	if err := st.UpsertEnvelopeAssignment("2026-02", cat, 50000); err != nil {
		t.Fatal(err)
	}
	seedTxn(t, st, "2026-02-15", cat, 10000)
	// The month under test.
	if err := st.UpsertEnvelopeAssignment("2026-03", cat, 20000); err != nil {
		t.Fatal(err)
	}
	seedTxn(t, st, "2026-03-15", cat, 5000)
	return cat, "2026-03"
}

func rowFor(t *testing.T, rows []EnvelopeMonthRow, categoryID int64) EnvelopeMonthRow {
	t.Helper()
	for _, r := range rows {
		if r.CategoryID == categoryID {
			return r
		}
	}
	t.Fatalf("category %d not in summary", categoryID)
	return EnvelopeMonthRow{}
}

// Envelope mode must keep working — it is sunset, not deleted. This test is
// also what proves the simple-mode tests are not vacuous: it asserts the
// fixture genuinely produces non-zero carryover and debt.
func TestEnvelopeMonthSummary_EnvelopeModeStillCarries(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	rows, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	r := rowFor(t, rows, cat)
	if r.CarryoverFils == 0 {
		t.Error("envelope mode produced zero carryover — fixture is not exercising the fold")
	}
	if r.OverspendDebtFils == 0 {
		t.Error("envelope mode produced zero overspend debt — fixture is not exercising the fold")
	}
}

// Simple mode: the budget persists, spending resets, nothing carries.
func TestEnvelopeMonthSummary_SimpleModeCarriesNothing(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	rows, err := st.EnvelopeMonthSummary(month, BudgetModeSimple)
	if err != nil {
		t.Fatal(err)
	}
	r := rowFor(t, rows, cat)
	if r.CarryoverFils != 0 {
		t.Errorf("CarryoverFils = %d, want 0 in simple mode", r.CarryoverFils)
	}
	if r.OverspendDebtFils != 0 {
		t.Errorf("OverspendDebtFils = %d, want 0 in simple mode", r.OverspendDebtFils)
	}
	if r.AssignedFils != 20000 {
		t.Errorf("AssignedFils = %d, want 20000 — the budget itself must be untouched", r.AssignedFils)
	}
	if r.ActivityFils != 5000 {
		t.Errorf("ActivityFils = %d, want 5000 — this month's spending only", r.ActivityFils)
	}
}

// An unknown mode must behave as simple, not error and not carry.
func TestEnvelopeMonthSummary_UnknownModeIsSimple(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	rows, err := st.EnvelopeMonthSummary(month, "nonsense")
	if err != nil {
		t.Fatal(err)
	}
	r := rowFor(t, rows, cat)
	if r.CarryoverFils != 0 || r.OverspendDebtFils != 0 {
		t.Errorf("unknown mode carried: carryover=%d debt=%d", r.CarryoverFils, r.OverspendDebtFils)
	}
}

// Flipping back must reproduce the original figures exactly — that is what
// makes the sunset reversible rather than a one-way door.
func TestEnvelopeMonthSummary_ModeIsReversible(t *testing.T) {
	st := newTestStore(t)
	cat, month := buildCarryoverFixture(t, st)

	before, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.EnvelopeMonthSummary(month, BudgetModeSimple); err != nil {
		t.Fatal(err)
	}
	after, err := st.EnvelopeMonthSummary(month, BudgetModeEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	b, a := rowFor(t, before, cat), rowFor(t, after, cat)
	if b != a {
		t.Errorf("envelope figures changed after a simple-mode read:\n before=%+v\n after =%+v", b, a)
	}
}
```

You need a `seedTxn` helper that inserts a confirmed debit transaction for a
category on a date. One may already exist in the store package's tests — search
for it first (`grep -rn "func seedTxn\|func insertTxn" internal/store/*_test.go`)
and reuse it. If none exists, write one modelled on how existing envelope tests
create transactions, and make sure the transaction is `status='confirmed'` and
`direction='debit'`, since `envelopeActivity` only counts those.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/Coding/ledger/.claude/worktrees/budget-mode && go test ./internal/store/ -run 'EnvelopeMonthSummary_' 2>&1 | tail -20`
Expected: FAIL — `EnvelopeMonthSummary` takes one argument.

- [ ] **Step 3: Add the mode parameter and the branch**

In `internal/store/envelopes.go`, change the signature to
`func (s *Store) EnvelopeMonthSummary(month string, mode string) ([]EnvelopeMonthRow, error)`
and add, at the point where the prior-month fold work begins:

```go
	// Simple mode is monthly budgets: the assignment persists but nothing
	// carries in either direction, so the whole prior-month era-fold is skipped
	// — both because its result would be discarded and because it is the
	// expensive part of this query. The fold itself is untouched and still
	// reachable via BudgetModeEnvelope; it is sunset, not removed.
	if NormalizeBudgetMode(mode) == BudgetModeSimple {
		// leave CarryoverFils and OverspendDebtFils at their zero values
	}
```

Read the function first and place the branch so that in simple mode the
prior-month scan does not run at all and both fields stay zero, while
everything else about the row (assigned, activity, category metadata, row
order) is identical between modes. Do not restructure the envelope path.

- [ ] **Step 4: Thread the mode through the server**

In `internal/server/envelopes.go`:

- change the `EnvelopeStore` interface member to
  `EnvelopeMonthSummary(month string, mode string) ([]store.EnvelopeMonthRow, error)`
  and add `SelectAppSettings() (store.AppSettings, error)` to the same interface;
- in `computeEnvelopeSummary`, read the settings and pass the mode:

```go
	set, err := s.envelopeStore.SelectAppSettings()
	if err != nil {
		return budget.EnvelopeSummary{}, cfg, err
	}
	rows, err := s.envelopeStore.EnvelopeMonthSummary(month, set.BudgetMode)
```

Place the settings read next to the existing `SelectBudgetConfig` read.

- [ ] **Step 5: Expose the hidden switch on the settings API**

In `internal/server/settings.go`, add `BudgetMode string \`json:"budget_mode"\`` to
the GET response shape and populate it from `AppSettings.BudgetMode`. Add an
optional `BudgetMode *string \`json:"budget_mode"\`` to the PUT request shape; when
non-nil, call `UpdateBudgetMode` and map its error to 400.

Read the existing handler to match how other optional PUT fields are handled
(there is already a `*int64` optional field for the AI spend cap — follow that
pattern exactly). Add `UpdateBudgetMode(mode string) error` to whichever store
interface the settings handler uses.

There is deliberately **no UI** for this. It is a hidden switch.

- [ ] **Step 6: Add the API round-trip test**

Append to `internal/server/settings_test.go`:

```go
func TestSettings_BudgetModeRoundTrip(t *testing.T) {
	st := newTestServerStore(t)
	if err := st.EnsureAppSettings(); err != nil {
		t.Fatal(err)
	}
	srv := newTestServerWithStore(t, st)
	srv.SetSettingsStore(st)

	get := func() string {
		r := httptest.NewRequest("GET", "/api/settings", nil)
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("GET /api/settings = %d; body: %s", w.Code, w.Body)
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		s, _ := out["budget_mode"].(string)
		return s
	}

	if got := get(); got != store.BudgetModeSimple {
		t.Errorf("default budget_mode = %q, want %q", got, store.BudgetModeSimple)
	}

	body, _ := json.Marshal(map[string]any{"budget_mode": store.BudgetModeEnvelope})
	r := httptest.NewRequest("PUT", "/api/settings", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT budget_mode = %d; body: %s", w.Code, w.Body)
	}
	if got := get(); got != store.BudgetModeEnvelope {
		t.Errorf("after PUT, budget_mode = %q, want %q", got, store.BudgetModeEnvelope)
	}

	bad, _ := json.Marshal(map[string]any{"budget_mode": "nonsense"})
	r = httptest.NewRequest("PUT", "/api/settings", bytes.NewReader(bad))
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("PUT invalid budget_mode = %d, want 400", w.Code)
	}
}
```

Match the file's existing imports and its helper for wiring the settings store —
read the file before appending; `SetSettingsStore` may be named differently.

- [ ] **Step 7: Fix remaining call sites and fakes**

Run: `go build ./... && go vet ./... 2>&1 | head -20`
Any other caller of `EnvelopeMonthSummary`, and any test fake implementing
`EnvelopeStore` or the settings store interface, needs updating. Give a fake a
sensible default (`store.BudgetModeSimple`) unless the test is about modes. Do
not delete a test to make the build pass.

- [ ] **Step 8: Run everything**

Run: `cd /root/Coding/ledger/.claude/worktrees/budget-mode && gofmt -w internal/ && go test ./... 2>&1 | grep -v "^ok\|no test files" | head` then `go test -race ./internal/server/ ./internal/store/ 2>&1 | tail -5`
Expected: no failures, no races.

- [ ] **Step 9: Commit**

```bash
cd /root/Coding/ledger/.claude/worktrees/budget-mode
git add internal/store/envelopes.go internal/store/envelopes_mode_test.go internal/server/envelopes.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat(plan): simple monthly budgets by default, envelope mode sunset

In simple mode the prior-month era-fold is skipped and carryover and
overspend debt are zero, so available becomes assigned minus activity and
Ready to Assign becomes income minus assigned. The envelope path is
untouched and still reachable via budget_mode=envelope.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification (orchestrator, after all tasks)

Not a subagent task.

1. `go test ./...` and `go test -race ./internal/server/ ./internal/store/`
2. Frontend is unchanged — confirm `git diff --stat main..HEAD -- frontend/ internal/web/` is empty. Rebuild the combined dist before deploying anyway, per CLAUDE.md's parallel-sessions rule.
3. Restore a scratch copy of production, run the new binary on a scratch port (never `:8080`, never `/var/lib/ledger`):
   - default mode is `simple`: `GET /api/envelopes?month=2026-08` reports every envelope with `carryover_fils = 0` and `overspend_debt_fils = 0`, and `ready_to_assign_fils == income_fils - assigned_fils` exactly.
   - `PUT /api/settings {"budget_mode":"envelope"}`, re-request: Investments 800000, Utilities 224272, Entertainment 64050 are back, and RTA returns to its old value.
   - flip back to `simple` and confirm the simple figures return — the sunset is reversible.
4. Deploy: back up production first, then verify the running binary by exe link and re-check the live figures.
