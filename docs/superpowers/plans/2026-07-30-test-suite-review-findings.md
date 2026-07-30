# Test Suite Review — Findings (2026-07-30)

Baseline at bfa6fc204918fc5bfe186de379cabf3ce201e3c9:
- Go: 14 packages, all ok except internal/config TestAIConfigEnabledRequiresAPIKey (env leakage — see Task 2 finding)
- Frontend: 163 test files / 1292 tests, all green
- Inventory: Go test files per package recorded below; frontend 163 test files (38 storybook portable-story files); harness drives 21 screens.

## Executive summary

Eight review tasks (hermeticity, order/race/flake, frontend mock hygiene,
time/timezone, assertion quality, coverage mapping, harness/Storybook seams)
plus this synthesis. **8 findings fixed, 1 harness-code fix, 10 findings
recorded as deferred (tracked, no action this review), ~9 verification-only
entries closed with no defect found.** No production (non-test,
non-harness-tooling) source file changed anywhere in the review range —
confirmed below; the embedded frontend dist does not need rebuilding.

| # | Finding | Severity | Disposition | Commit |
|---|---|---|---|---|
| 1 | `internal/config` tests leaked the invoking shell's `LEDGER_*` env into `Load` assertions | high | FIXED — `clearLedgerEnv(t)` helper, called first in every test reaching `Load` | `9ddd40d` |
| 2 | `TestSelectMonthlyTotals` silently `t.Skip`'d instead of failing if seed data's `Salary` category ever disappeared | medium | FIXED — `t.Skip` → `t.Fatal` | `9ddd40d` |
| 3 | Remaining `t.Skip` audit: `imap_integration_test.go` (opt-in live IMAP), `recur_test.go` `TestScheduledProvenanceMigration` (driver-capability gate) | low | VERIFIED — both correct as-is, no action | `9ddd40d` |
| 4 | Full Go suite under `-race -count=1` | info | VERIFIED — race-clean, no action | `ab1e5ef` |
| 5 | Full Go suite under `-shuffle=on` and `-shuffle=1234` | info | VERIFIED — no order dependency | `ab1e5ef` |
| 6 | Both `time.Sleep`-based Go tests, 20 reps each incl. `-race` | info | VERIFIED-STABLE — no action (one is a settle-after-async-kick, one already condition-polls) | `ab1e5ef` |
| 7 | Frontend suite under 3 shuffle seeds, pre-fix | info | VERIFIED (measurement only) — no failing seed found, but latent `spyOn` leak channel judged real | `143b572` |
| 8 | Fake-timer cleanup across 6 flagged files | low | VERIFIED — all 6 already pair `useFakeTimers`/`useRealTimers` correctly | `143b572` |
| 9 | `vi.spyOn` restoration was only per-file, not config-enforced (23 files use `vi.spyOn`, only some restore) | medium | FIXED — `restoreMocks: true` added to `vite.config.ts`; verified no `beforeAll`-scoped spy relies on suite-lifetime mocking | `143b572` |
| 10 | Post-`restoreMocks` full verification: straight + 3 shuffle seeds | info | VERIFIED green, no test needed changing | `143b572` |
| 11 | `PlanScreen.test.tsx`: `monthProgress(month)` called with no `today` override defaults to the real wall clock, silently drops the claim-hint assertion once the real date leaves July 2026 (Hazard A) | low (test-only bug; prod correct) | FIXED — whole-file clock pin (`vi.useFakeTimers({ now: "2026-07-15T12:00:00Z" })` in `beforeEach`/`afterEach`) | `efc8c94` |
| 12 | `TargetSheet.tsx`'s `minDueDate` — a second, independent wall-clock read in the same screen family, missed by the first audit pass, would silently disable the Save button past 2026-12-01 (Hazard B) | low (test-only bug; prod correct) | FIXED — same clock pin from #11 neutralizes it; independently re-verified red→green | `c36bc93` |
| 13 | `internal/server/scheduled.go` `handleGetUpcoming` reads `time.Now()` with no injectable seam | info | DEFERRED: no clock seam — safe today only because the one test derives fixtures from the same clock; no failure demonstrated | `efc8c94` |
| 14 | `internal/store/insights.go` `SelectMonthlyTotals` reads `time.Now()` with no injectable seam (`Store.now` field exists but isn't wired here) | info | DEFERRED: no clock seam — same shape as #13 | `efc8c94` |
| 15 | `internal/categorize` `matchRule` `"contains"`: mixed-case rule *pattern* (as opposed to mixed-case merchant) was never exercised — a mutation dropping the pattern-side `ToLower` survived all existing tests | medium | FIXED — new test `TestRuleMatchContainsCaseInsensitivePattern`, proven to kill the mutant | `bad8130` |
| 16 | `LinkRefundSheet.test.tsx` empty-state test had no explicit `expect(...)`, relying only on `findByText` throwing | low | FIXED — explicit presence + candidate-list-absence assertions added | `bad8130` |
| 17 | Coverage map: Go 78.4% combined, frontend 78.25% stmts; top risk `frontend/src/hooks/useTxnActions.ts` (44.64% stmts, no dedicated test file) — the shared mutation hook behind categorize/archive/restore/unlink-refund and every toast-undo closure | info | RECORDED — no fix (quantity-gap mapping only); `@vitest/coverage-v8` dev dep added so this map can be re-run | `59f9d64` |
| 18 | Harness `nav.mjs` was missing 4 reachable full-screen destinations (`account-detail`, `project-detail`, `project-form`, `project-bulk-backfill`) | info | FIXED (harness code, not app code) — 4 screen ids + `tapLast()` helper added (a covered-DOM `.first()` selector bug the new ids exposed) | `c6b4d0a` |
| 19 | `AccountDetail` overlay doesn't mark `AccountsScreen`'s own content `inert` while open — 6 background controls stay focusable/tabbable | medium | DEFERRED (real UI bug, out of scope for a seam-mapping task) — fix shape: `inert={detailId !== null \|\| addOpen}`, matching `ProjectsFlow`'s convention | `c6b4d0a` |
| 20 | `ProjectForm`'s 12 color-swatch buttons are 32×32px — under both the 44px minimum and the 36px `data-dense-target` escape hatch | medium | DEFERRED (real UI bug, out of scope) — fix shape: grow to 44×44, or add `data-dense-target` and grow to ≥36×36 | `c6b4d0a` |
| 21 | Nested sheets (`SplitSheet`, `RenameMerchantSheet`, `LinkRefundSheet`, `EmailPreviewSheet`, `FilterChips`) opened from inside an already-open sheet are structurally invisible to `probe.mjs`'s generic crawl | info | DEFERRED — `probe.mjs` design change, out of scope | `c6b4d0a` |
| 22 | `probe.mjs` can't distinguish "opened a sheet" from "fired a mutation"; the new full-screen destinations (`project-detail`'s status toggle, `project-bulk-backfill`'s commit button) would corrupt scratch fixture data with no undo if probed | info | DEFERRED — not executed for that reason; `probe.mjs` heuristic fix out of scope | `c6b4d0a` |
| 23 | `nav.mjs`'s `interactions` field / `--state` flag are dead — no harness script reads them | info | DEFERRED — wire it up or remove the dead comment, out of scope | `c6b4d0a` |
| 24 | 23 catalog components documented in `components/README.md` have no `*.stories.tsx` at all (`TransactionRow`, `SwipeDeck`, `CategorizeSheet`, etc.) | info | DEFERRED: needs design work — most need live query data, gesture glue, or mock-heavy setups; not a blind scaffold-a-story fix | `c6b4d0a` |

**Counts:** 8 FIXED (2 Go hermeticity, 1 frontend config hardening, 2 frontend
time hazards, 1 Go assertion-strength, 1 frontend assertion-strength, 1
harness-code fix) · 10 DEFERRED (tracked, no code change this review) · 9
VERIFIED/RECORDED (ran the check, found no defect, or mapped a metric with no
fix implied) · 1 fix (#18, `nav.mjs`) is harness tooling, not application code.

**What this review means:** the suite was already in good shape — no flake, no
order dependency, no data race, and only one demonstrated timezone-class bug
(concentrated in one screen file, both hazards sharing one fix). The value
this review actually added was narrower and more surgical than "everything
was broken": closing a real env-hermeticity hole that was already failing one
test nondeterministically depending on the invoking shell, hardening a latent
(not-yet-triggered) mock-leak channel before it could cause a flake, and —
via mutation testing and harness expansion — surfacing a handful of concrete,
previously invisible defects (one categorization matching bug, two real UI
bugs, several structural harness blind spots) that no amount of running the
existing suite harder would have found.

Three biggest residual risks, in order:

1. **`frontend/src/hooks/useTxnActions.ts` has no dedicated test file** (Task
   7, finding #17) — the shared mutation hook behind every categorize/
   archive/restore/unlink-refund action and every toast "Undo" closure across
   Transactions and Insights drill-down, at 44.64% statement / 37.5% function
   coverage. It carries the highest change-frequency × money/state-correctness
   blast radius of anything this review found, and unlike the categorize
   mutation caught in Task 6, no mutation-testing pass was run against it —
   only indirect coverage via the screens that consume it.
2. **Two Go query paths read `time.Now()` with no injectable clock seam**
   (`scheduled.go handleGetUpcoming`, `store/insights.go SelectMonthlyTotals`
   — findings #13/#14). Both are safe today only because their one test each
   derives its fixture from the same real clock. Task 5 proved this exact
   pattern — a hardcoded date implicitly compared against the real clock —
   is a genuine, demonstrable bug class on the frontend (Hazards A and B);
   these two Go call sites are structurally the same shape, just not
   currently paired with a hardcoded-date test that would expose it.
3. **The harness has real, load-bearing blind spots, and two of the bugs it
   already found (findings #19/#20) are unfixed.** `probe.mjs`'s crawl can't
   see into nested sheets, can't see gesture-triggered sheets, and can't tell
   a mutating button from a sheet-opener — meaning newly added full-screen
   destinations are geometry-audited by `shoot.mjs` but not exercised by
   `probe.mjs` until that heuristic is fixed. Meanwhile `AccountDetail`'s
   inert leak (a real focus/screen-reader escape) and `ProjectForm`'s
   sub-44px swatches (a real tap-target defect) sit recorded but unfixed.

Recommended next investments, in the same order: (1) a direct
`useTxnActions.ts` test file covering the undo-closure re-POST and its error
branches, ideally with a small mutation-testing pass matching Task 6's
methodology; (2) either wire a `SetNow`-style seam into the two Go call sites
above or explicitly accept the risk in writing (no seam should be added
speculatively without a demonstrated failure, per this review's own
discipline); (3) a `probe.mjs` fix for the mutate-vs-open-sheet heuristic and
nested-sheet re-entry, paired with fixing the two already-identified UI bugs
(#19 `AccountDetail` inert, #20 `ProjectForm` swatches) since the harness
work to find them is already sunk.

## Go test inventory

| Package | Source files | Test files |
|---------|-------------|-----------|
| cmd/ledger | 1 | 0 |
| internal/anthropic | 3 | 3 |
| internal/budget | 4 | 4 |
| internal/categorize | 3 | 3 |
| internal/config | 1 | 1 |
| internal/importer | 4 | 4 |
| internal/ingest | 2 | 3 |
| internal/monitor | 1 | 1 |
| internal/parse | 12 | 13 |
| internal/push | 1 | 1 |
| internal/recur | 5 | 4 |
| internal/server | 29 | 29 |
| internal/store | 26 | 33 |
| internal/web | 1 | 0 |

Note: `cmd/ledger` (1 src, 0 tests) and `internal/web` (embed shim, 0 tests) are the only test-free packages.

## Task 2 — Go hermeticity

### [SEVERITY: high] `internal/config` tests leak the invoking shell's env into assertions
- **Where:** `internal/config/config_test.go` (all 12 tests reaching `Load`)
- **What:** Every test that calls `config.Load` inherited whatever `LEDGER_*` env vars the invoking shell exported, rather than asserting purely on the TOML/env it set up itself. The dev sandbox exports `LEDGER_AI_API_KEY`, so `TestAIConfigEnabledRequiresAPIKey` (which expects `Load` to fail validation because no API key is set) instead observed the inherited key and passed validation, failing the test. The brief's proposed helper var list (`LEDGER_IMAP_USER`, `LEDGER_VAPID_PRIVATE/PUBLIC`) didn't match `config.go`'s actual `os.Getenv` calls; the correct set, read directly from `internal/config/config.go` lines 124–141, is `LEDGER_LISTEN`, `LEDGER_DATA_DIR`, `LEDGER_IMAP_HOST`, `LEDGER_IMAP_USERNAME`, `LEDGER_IMAP_APP_PASSWORD`, `LEDGER_AI_API_KEY` — no VAPID vars are read in `config.go` at all.
- **Evidence:**
  ```
  $ go test ./internal/config/ -run TestAIConfigEnabledRequiresAPIKey -v
  === RUN   TestAIConfigEnabledRequiresAPIKey
      config_test.go:200: expected error when AI enabled but no API key
  --- FAIL: TestAIConfigEnabledRequiresAPIKey (0.00s)
  FAIL

  $ LEDGER_AI_API_KEY= go test ./internal/config/ -run TestAIConfigEnabledRequiresAPIKey -v
  === RUN   TestAIConfigEnabledRequiresAPIKey
  --- PASS: TestAIConfigEnabledRequiresAPIKey (0.00s)
  PASS
  ```
  After the fix, both a clean env and a deliberately hostile env (`LEDGER_AI_API_KEY=sk-fake-123 LEDGER_LISTEN=1.2.3.4:9 LEDGER_DATA_DIR=/hostile LEDGER_IMAP_HOST=hostile.example LEDGER_IMAP_USERNAME=hostile LEDGER_IMAP_APP_PASSWORD=hostile`) pass all 12 tests.
- **Disposition:** FIXED in this commit — added `clearLedgerEnv(t)` helper (`t.Setenv` each var to `""`, auto-restored via `t.Cleanup`) called as the first line of every test that reaches `Load`; tests that deliberately exercise one env override (`TestEnvOverridesFile`, `TestIMAPLoadsFromFileAndEnv`, `TestIMAPRejectsReadOnlyFalse`, `TestAIConfigEnvAPIKey`) call `clearLedgerEnv(t)` first, then `t.Setenv` only the variable under test.

### [SEVERITY: medium] Silent-skip hazard in `TestSelectMonthlyTotals`
- **Where:** `internal/store/insights_test.go:65-67` (pre-fix)
- **What:** The test looked up a `Salary` income category by name from `seedCategories` and, if not found, called `t.Skip(...)` instead of failing. `Salary` is present today, so the skip never fires — but if seed data ever dropped or renamed that category, the test would silently vanish from the suite (report as `SKIP`, overall package still `PASS`) instead of flagging that its fixture assumption broke, masking a real regression risk in `SelectMonthlyTotals`'s income-bucket logic.
- **Evidence:** Renamed the lookup target to `"SalaryX"` (temporary, reverted) to simulate seed drift:
  ```
  $ go test ./internal/store/ -run TestSelectMonthlyTotals -v
  === RUN   TestSelectMonthlyTotals
      insights_test.go:66: no Salary income category in seed; adjust to an income category name present in seedCategories
  --- SKIP: TestSelectMonthlyTotals (0.01s)
  PASS
  ```
  Confirms the hazard: a suite run reports overall `PASS` while this test's assertions never execute. After reverting the rename and replacing `t.Skip` with `t.Fatal`, re-ran on unmodified code:
  ```
  $ go test ./internal/store/ -run TestSelectMonthlyTotals -v
  === RUN   TestSelectMonthlyTotals
  --- PASS: TestSelectMonthlyTotals (0.01s)
  PASS
  ```
- **Disposition:** FIXED in this commit — `t.Skip` replaced with `t.Fatal("seed no longer contains a Salary income category — update this test's fixture lookup")`, so future seed drift fails loudly instead of silently dropping the test.

### [SEVERITY: low] Remaining `t.Skip` audit — two conditional skips, both legitimate
- **Where:** `internal/ingest/imap_integration_test.go:22`; `internal/store/recur_test.go:118`
- **What:** `grep -rn "t.Skip" --include=*_test.go internal/ cmd/` (post-fix) surfaces two conditional skips beyond the one fixed above:
  1. `imap_integration_test.go:22` skips unless `LEDGER_TEST_IMAP_*` env vars are set — a live-network integration test against a real IMAP server, deliberately opt-in.
  2. `recur_test.go:118` (`TestScheduledProvenanceMigration`) skips if `ALTER TABLE ... DROP COLUMN` fails, i.e. if the SQLite driver in use doesn't support `DROP COLUMN`. The project pins `modernc.org/sqlite v1.52.0` (pure-Go, CGO-free per `CLAUDE.md`), which bundles a SQLite version well past 3.35 (the version `DROP COLUMN` landed in), so this skip does not fire today — confirmed with `go test ./internal/store/ -run TestScheduledProvenanceMigration -v` → `PASS` (no skip).
  Both are environment/driver-capability gates rather than fragile-fixture hazards like the `Salary` case: neither can silently regress via ordinary seed-data edits, only via a deliberate driver swap or deliberately unset integration credentials, and in both cases the skip is the correct behavior (the test's premise — a real IMAP connection, or a driver capability to simulate pre-migration schema — genuinely isn't testable without it).
- **Disposition:** DEFERRED (intentional, no action) — both skips are correct as-is; no code change.

## Task 3 — Go order/race/flake

### [SEVERITY: info] Full suite is race-clean under `-race -count=1`
- **Where:** all 13 test-bearing packages (`go test ./...`).
- **What:** Ran the entire Go suite (14 packages, 2 test-free) under the race detector. No `WARNING: DATA RACE` anywhere; no failures.
- **Evidence:**
  ```
  $ go test ./... -race -count=1
  ?   ledger/cmd/ledger      [no test files]
  ok  ledger/internal/anthropic   1.026s
  ok  ledger/internal/budget      1.017s
  ok  ledger/internal/categorize  1.026s
  ok  ledger/internal/config      1.020s
  ok  ledger/internal/importer    2.599s
  ok  ledger/internal/ingest      3.753s
  ok  ledger/internal/monitor     1.024s
  ok  ledger/internal/parse       4.353s
  ok  ledger/internal/push        1.020s
  ok  ledger/internal/recur       3.431s
  ok  ledger/internal/server      23.459s
  ok  ledger/internal/store       33.869s
  ?   ledger/internal/web         [no test files]
  ```
- **Disposition:** VERIFIED — no action. No race source exists to fix.

### [SEVERITY: info] Order-independence holds under both required shuffle seeds
- **Where:** all 13 test-bearing packages (`go test ./... -shuffle=on` and `-shuffle=1234`).
- **What:** `-shuffle=on` (fresh random seed per invocation) and a fixed `-shuffle=1234` both ran every package clean. No package-level var leakage, shared temp dir collision, or seeded-DB-reuse ordering dependency surfaced.
- **Evidence:**
  ```
  $ go test ./... -shuffle=on
  [... all 13 packages ok ...]

  $ go test ./... -shuffle=1234
  [... all 13 packages ok, identical ok/[no test files] set as above ...]
  ```
  (Full per-package timing in task-3-report.md; both runs: `ok` for anthropic, budget, categorize, config, importer, ingest, monitor, parse, push, recur, server, store; `[no test files]` for cmd/ledger, web.)
- **Disposition:** VERIFIED — no action. Suite has no discovered order dependency.

### [SEVERITY: info] Both `time.Sleep`-based tests verified stable, 20/20
- **Where:**
  1. `internal/ingest/ingest_test.go:228` — `time.Sleep(30 * time.Millisecond)` inside `TestRunIngestsThenKeepsRunningOnError` (the only sleep call in that file/test; it's a settle window after injecting a transient fetch error and a follow-up message, immediately before `cancel()` — not a condition guess, just letting the worker's already-cancel-observing loop tick once more).
  2. `internal/server/categorize_job_test.go:41` — `time.Sleep(5 * time.Millisecond)` inside the shared helper `waitCategorizeIdle(t, srv)`, which is **already** a condition-based poll loop (`for i := 0; i < 400; i++ { if status == "idle" { return }; time.Sleep(5*ms) }`, 2s deadline via iteration cap) — not a bare fixed sleep. It is called from 7 tests: `TestCategorizeJob_ProcessesAllAndBroadcasts`, `TestCategorizeJob_DedupesByMerchant`, `TestCategorizeJob_RecordsGenuineFailures`, `TestHandleCategorizeStatus_ReportsFailure`, `TestCategorizeJob_StopHalts`, `TestCategorizeJob_RejectsConcurrentRun`, `TestHandleCategorizeRunAndConflict`.
- **What:** Hammered both per the brief's probe procedure.
- **Evidence:**
  ```
  $ go test ./internal/ingest/ -run '^TestRunIngestsThenKeepsRunningOnError$' -count=20 -v
  [20/20 --- PASS, ~0.05s each]
  ok  ledger/internal/ingest  0.965s

  $ go test ./internal/server/ -run '^(TestCategorizeJob_ProcessesAllAndBroadcasts|TestCategorizeJob_DedupesByMerchant|TestCategorizeJob_RecordsGenuineFailures|TestHandleCategorizeStatus_ReportsFailure|TestCategorizeJob_StopHalts|TestCategorizeJob_RejectsConcurrentRun|TestHandleCategorizeRunAndConflict)$' -count=20 -race -v
  140 --- PASS / 0 --- FAIL  (7 tests x 20 reps, all under -race)
  ok  ledger/internal/server  25.861s
  ```
- **Disposition:** VERIFIED-STABLE — no action, per the brief's "do NOT rewrite passing tests" rule. Both sleeps are acceptable as-is: #1 is a settle-after-async-kick, not a race guess; #2 is already condition-based (the raw `time.Sleep` line the brief flagged is only the poll-loop's tick, not the wait mechanism itself).

## Task 4 — Frontend order-independence & mock hygiene

### [SEVERITY: info] Baseline: all three required shuffle seeds already pass pre-fix
- **Where:** full frontend suite (163 files / 1292 tests, `singleFork`, `unstubGlobals: true` already in place from the prior fetch-stub-leak fix).
- **What:** Per the brief, ran the three required shuffle seeds *before* touching config, to measure whether the `vi.spyOn`/`vi.useFakeTimers` leak channels the brief calls out actually manifest as failures under these specific orderings.
- **Evidence:**
  ```
  $ bunx vitest run --sequence.shuffle --sequence.seed=1    → 163 passed (163) / 1292 passed (1292), 25.02s
  $ bunx vitest run --sequence.shuffle --sequence.seed=42   → 163 passed (163) / 1292 passed (1292), 25.43s
  $ bunx vitest run --sequence.shuffle --sequence.seed=2026 → 163 passed (163) / 1292 passed (1292), 24.43s
  ```
  No failing file in any of the three seeds. Unlike the `stubGlobal` leak (which the prior fix's brief said broke 4 ProjectsFlow tests under reordering before `unstubGlobals` was added), the `spyOn`/timer channels didn't happen to collide under seeds 1/42/2026 specifically — that is a property of these three orderings, not proof the channels are safe in general (see next finding).
- **Disposition:** VERIFIED (measurement only, no code change) — no known-failing seed exists to fix, but per the brief the systemic `restoreMocks` hardening proceeds anyway since the leak channel is real and latent (below), just not triggered by these three seeds.

### [SEVERITY: low] Fake-timer cleanup audited across all 6 flagged files — no offenders found
- **Where:** `src/components/Toast.test.tsx`, `src/lib/pausableTimeout.test.ts`, `src/hooks/useLiveEvents.test.ts`, `src/components/ui/Dialog.test.tsx`, `src/lib/liveInvalidation.test.ts`, `src/screens/recurring/RecurringScreen.test.tsx`.
- **What:** Grepped each file for `useFakeTimers`/`useRealTimers` pairing. All 6 already restore real timers: 5 files pair every `beforeEach(() => vi.useFakeTimers())` with an `afterEach(() => vi.useRealTimers())`; `RecurringScreen.test.tsx` calls `vi.useFakeTimers()` inline in 5 separate tests, each wrapped in `try { ... } finally { vi.useRealTimers(); }` (the file's own comment at line 71 explains it deliberately skips `vi.restoreAllMocks()` there because the shared setup installs `window.matchMedia` in `beforeEach` and a blanket restore would strip it — each test installs its own fresh spies instead of relying on restoration between tests in that file).
- **Evidence:** `grep -n "useFakeTimers\|useRealTimers" <file>` on all 6 files — every `useFakeTimers` call site has a matching `useRealTimers` in an `afterEach` or a `finally` block reachable on both success and failure paths.
- **Disposition:** VERIFIED — no action. The brief flagged this as a plausible leak channel to check mechanically; audit found the channel already closed in all 6 files, so no `afterEach(() => vi.useRealTimers())` insertion was needed.

### [SEVERITY: medium] Systemic `vi.spyOn` restoration was still only per-file, not config-enforced
- **Where:** `frontend/vite.config.ts` `test` block (pre-fix); 23 files use `vi.spyOn` across the shared `singleFork` process.
- **What:** Only `unstubGlobals: true` (stubbed globals, e.g. `fetch`) was enforced at the config level. `vi.spyOn` restoration relied on each file remembering its own `vi.restoreAllMocks()`/`afterEach`, same failure mode as the pre-`unstubGlobals` fetch-stub leak: a spy left mocked in one file (e.g. `vi.spyOn(client, "postJSON").mockResolvedValue(...)`) can silently satisfy or corrupt an assertion in a later file that expects the real implementation or a different mock, and whether that collision fires depends entirely on scheduling order. Independently verified the brief's precondition for the fix's safety: `grep -rl "vi.spyOn" src --include="*.test.ts*"` → 23 files; none of those 23 also contain `beforeAll` (checked individually), so no file relies on a spy installed once for a whole suite that `restoreMocks`'s automatic per-test restore would prematurely tear down.
- **Evidence:** Applied the fix (below) and re-ran full verification — straight run and all three shuffle seeds green at 163/163 files, 1292/1292 tests, no new failures, no test needed to be changed to accommodate `restoreMocks`.
- **Disposition:** FIXED in this commit — `frontend/vite.config.ts` `test` block gains:
  ```typescript
  unstubGlobals: true,
  // Same reasoning for spies: 23 files vi.spyOn(api, …) and only some
  // restore. No file spies in beforeAll (verified), so per-test restoration
  // is safe. mocks created with vi.fn() in module scope are untouched.
  restoreMocks: true,
  ```

### [SEVERITY: info] Post-fix verification: straight + all 3 shuffle seeds green
- **Where:** full frontend suite, post `restoreMocks: true`.
- **What:** Re-ran the brief's Step 4 verification matrix.
- **Evidence:**
  ```
  $ bun run test                                            → 163 passed (163) / 1292 passed (1292), 53.91s
  $ bunx vitest run --sequence.shuffle --sequence.seed=1    → 163 passed (163) / 1292 passed (1292), 43.81s
  $ bunx vitest run --sequence.shuffle --sequence.seed=42   → 163 passed (163) / 1292 passed (1292), 42.79s
  $ bunx vitest run --sequence.shuffle --sequence.seed=2026 → 163 passed (163) / 1292 passed (1292), 41.32s
  ```
  No seed regressed; no test file needed modification to tolerate `restoreMocks`. (Run times roughly doubled vs. pre-fix — consistent with `restoreMocks` doing real per-test teardown work across 23 spied files rather than a no-op.)
- **Disposition:** VERIFIED — no known-failing seed remains. `fileParallelism: false` / `singleFork` left untouched per binding constraint.

## Task 5 — Time & timezone dependence

**Step 1 — both suites at UTC+14 and UTC−9, plus default TZ (re-verification after Step 3's fix):**

```
$ TZ=Pacific/Kiritimati go test ./...                → all packages ok (no test files: cmd/ledger, internal/web)
$ TZ=America/Anchorage  go test ./...                → all packages ok
$ go test ./...                                      → all packages ok
$ cd frontend
$ TZ=Pacific/Kiritimati bun run test                 → 163 files / 1292 tests passed, 49-61s
$ TZ=America/Anchorage  bun run test                 → 163 files / 1292 tests passed, 51-53s
$ bun run test                                        → 163 files / 1292 tests passed, 51.44s
```

Both Go TZ runs were green on the *first* try — no fix needed there. The frontend's first UTC+14/UTC−9 runs were also green (163/163), because none of the frontend suite's `2026-…` fixtures happened to be exercised against the wall clock in a way the two extreme offsets alone would flip (a TZ shift moves the calendar-day boundary by hours, not months). The real hazard found in Step 2 needed a simulated *future date*, not a TZ shift, to demonstrate — see below.

**Step 2 — date-passage audit (Go priority list):**

| Package | Wall-clock read | Test clock handling | Verdict |
|---|---|---|---|
| `internal/budget` (`budget.go`, `age.go`, `envelope.go`, `thresholds.go`) | `Compute`/`MonthProgress`/`AgeOfMoney`/`ComputeEnvelopes`/`CurrentThresholdLevels` all take `now time.Time` / date strings as explicit params — **no internal `time.Now()` call anywhere in the package**. | All tests (`budget_test.go`, `age_test.go`) pass fixed `time.Date(2026, …, time.UTC)` values. | **Safe by construction** — pure, fully clock-injected. |
| `internal/server/envelopes.go` | `envelopeMonth()` defaults to `time.Now().UTC().Format("2006-01")` only when `?month=` is absent (line 35); `computeEnvelopeSummary`/`ComputeEnvelopes` take the resolved `month` string, never touch the clock again. | Every test in `envelopes_test.go` passes an explicit `?month=2026-07` — the wall-clock default path is never hit. | **Safe** — no hardcoded-date-vs-real-`Now()` comparison exists in this package's tests. |
| `internal/store/targets.go` | No `time.Now()` at all; `validateTarget` only `time.Parse`s `due_date` for format, never compares it to today. | `targets_test.go` (incl. `TestCategoryTargetCRUD`, which uses `st.SetNow(func() int64 { return 1_000_000 })`) never depends on real `Now()`. | **Safe.** |
| `internal/recur` (`detect.go`, `match.go`, `sweep.go`, `runner.go`) | Every entry point (`Detect`, `Match`, `MatchRescue`, `Sweep`, `RearmStale`, `Runner.DetectAndPropose`, `Runner.PostProcess`) takes `now time.Time` explicitly — **no internal `time.Now()` call in the package**. Production wiring (`cmd/ledger/main.go:419,452,457,588`) passes the real `time.Now()` at the call site, outside the package. | All ~40 cases across `detect_test.go`/`match_test.go`/`sweep_test.go`/`runner_test.go` use a `d(t, "2026-…")` fixed-date helper. | **Safe by construction.** |
| `internal/server/scheduled.go` | `handleGetUpcoming` reads `time.Now().UTC()` directly (line 317) to compute `due_in_days` from each row's stored `next_due`. | `TestUpcomingFeed` derives its fixture `next_due` dates from `time.Now().UTC()` too (`due := func(days int) string { return today.AddDate(0,0,days).Format(...) }`, `runner_test.go`/`scheduled_test.go:144`) — production and test read the *same* wall clock in the same process, so they move together. `TestScheduledValidationAndNotFound` uses literal `"2026-08-01"` but only for input-shape validation (400 vs not), never compared to `Now()`. | **Safe** — self-consistent, not a hardcoded-date-meets-real-clock pattern. Noted as a design fact, not a hazard: if this ever needed a `SetNow`-style seam (e.g. to unit-test `due_in_days` deterministically) it would have to be threaded through `Server`, which does not currently have a clock field — **[DEFERRED: no clock seam, but no demonstrated failure to justify adding one]**. |
| `internal/store/insights.go` | `SelectMonthlyTotals` reads `time.Now().UTC()` directly (line 95) to anchor the trailing-N-month window; no `SetNow`-style seam on this path (the `Store.now` field exists for other purposes — usage timestamps/cap windows — but is not read here). | `insights_test.go` explicitly derives its fixtures from `time.Now()` (`TestMonthlyTotalsNetSpendingCredits` line 135: `// SelectMonthlyTotals is anchored to time.Now, so seed rows in the current month`; `TestInsightsUnchangedBySplit` line 170 likewise). | **Safe** — self-consistent by explicit design (comment in the test acknowledges the coupling). **[DEFERRED: no clock seam]** for the same reason as above — `SelectMonthlyTotals`/`SelectCategorySpend` have no injected-clock path, but nothing here demonstrates a failure; adding `SetNow` wiring to this one query is a bigger change than this pass's scope (Step 3 fixes only demonstrated hazards). |

**Step 2 — date-passage audit (frontend priority list):**

| Module | Wall-clock read | Test clock handling | Verdict |
|---|---|---|---|
| `lib/envelope.ts` | `monthProgress(month, today = new Date())` — explicit injectable default. | `envelope.test.ts` always passes an explicit `today` (`new Date(2026, 6, 31)` etc.) — never relies on the default. | **Safe.** |
| `lib/recurring.ts` | None — every function (`daysUntil`, `dueLabel`, `recentlyPaid`, `splitUpcoming`, …) takes `todayISO`/`dueInDays` as an explicit parameter; no `new Date()` anywhere in the file. | N/A. | **Safe by construction.** |
| `lib/reports.ts` | None in the pure helpers; `yoyRows(trend, now: string)` takes `now` as an explicit param. | N/A. | **Safe by construction.** |
| `lib/insights.ts` | `currentPeriod()` (line 75) and one internal `new Date(Date.UTC(...))` inside `yoyRows`-adjacent code call the wall clock directly, with no injectable override. | Not tested directly (`insights.test.ts` never calls `currentPeriod()`); every screen-level caller either (a) uses it as a *default* that's self-referential in tests (`lib/scope.test.ts`, `components/ui/PeriodSheet.test.tsx` — both compare against `currentPeriod()` computed again inside the assertion, so real "today" cancels out), or (b) is one of the hazards below. | **Safe as authored**; the risk is entirely at call sites — see PlanScreen finding below (fixed) and the audit of Home/Insights/ReportsScreen (all safe — see Step 3). |
| `lib/projectMath.ts` | `todayISO()` (line 17) calls the wall clock directly, no override param. `projectPace(p, today: string)` itself is pure/injectable. | `projectMath.test.ts`'s `todayISO` test only regex-matches the format (`toMatch(/^\d{4}-\d{2}-\d{2}$/)`), never a specific value; every `projectPace`/`projectCoversDate`/`orderProjectsForReview` test passes an explicit date string. | **Safe.** |
| `screens/recurring/RecurringScreen.tsx` | Calls `todayISO()` (real wall clock) to compute `recentlyPaid(all, todayISO())`. | `RecurringScreen.test.tsx`'s "recently paid" test seeds `last_matched_at` with `new Date().toISOString()` — production and test read the same wall clock in the same process; self-consistent. `due_in_days` in every other test is server-shaped fixture data (never computed client-side), so the countdown-copy tests (`dueLabel`) never touch the clock at all. | **Safe.** |
| `screens/plan/PlanScreen.tsx` | `pace = monthProgress(month)` — called **without** the `today` override, so it silently defaults to the real wall clock; gates the pace marker AND the upcoming-bill claim hints (`claims = pace !== undefined ? claimsByCategory(...) : new Map()`) on `month === real-current-month`. | **HAZARD — demonstrated and fixed, see below.** | **Fixed.** |
| `screens/plan/TargetSheet.tsx:50-55` | A **second, independent** wall-clock read in the same screen family: `const now = new Date(); const minDueDate = "${now.getFullYear()}-...";` computes today's date directly (line 50-51, deliberately local-time not `toISOString()` per its own comment), then `dateOk = type !== "save_by_date" || (dueDate !== "" && dueDate >= minDueDate)` (line 55) rejects any `save_by_date` due-date earlier than the real "today". | `PlanScreen.test.tsx`'s "target sheet: save-by-date demands a date, then puts the target" fills the date field with the hardcoded fixture `"2026-12-01"` and asserts the PUT fires with that `due_date`. This only stays true while the real wall clock is on or before 2026-12-01 — the same class of hazard as `monthProgress` above, in the same file, missed by the first pass of this audit. | **HAZARD — same file, same clock pin covers it; see Step 3.** |

**Step 3 — demonstrated hazards, red → green:**

### Hazard A — `monthProgress` / claim hints

- **Where:** `frontend/src/screens/plan/PlanScreen.test.tsx` (test bug; production code in `frontend/src/screens/plan/PlanScreen.tsx:61-65` is correct/intentional).
- **What:** Every fixture in `PlanScreen.test.tsx` pins the envelope month to `"2026-07"` (the `JULY` scope constant), but `PlanScreen.tsx:61` calls `monthProgress(month)` with no `today` argument, so it defaults to `new Date()` — the real wall clock. `monthProgress` returns `undefined` whenever `month` isn't the calendar month `today` sits in, and `PlanScreen.tsx:65` gates the entire upcoming-bill "claim hint" feature (`Netflix due in 2d · 39.00 — short 19.00`) on `pace !== undefined`. The suite happened to be authored (and this review run) during July 2026, so it passed by coincidence; the day the real clock crossed into August 2026 the test `"shows target progress and the upcoming-bill claim hint with its shortfall"` would start failing with the claim-hint text simply absent from the DOM — a silent, calendar-triggered regression with no code change.
- **Red demonstration:** temporarily added `vi.useFakeTimers({ now: new Date("2026-12-15T12:00:00Z"), shouldAdvanceTime: true })` at the top of that one test (no other change) and ran `bunx vitest run src/screens/plan/PlanScreen.test.tsx -t "shows target progress"`:
  ```
  ❯ src/screens/plan/PlanScreen.test.tsx:178:25
      176|     expect(within(groceries).getByText(/needs 400\.00 more/)).toBeInTh…
      177|     const subs = screen.getByRole("button", { name: "Open Subscription…
      178|     expect(within(subs).getByText(/Netflix due in 2d · 39\.00 — short …
         |                         ^
   Test Files  1 failed (1)
        Tests  1 failed | 12 skipped (13)
  ```
  Confirmed RED exactly as predicted — the claim-hint text is missing from the rendered button because `pace` came back `undefined` once `month="2026-07"` no longer matched the (simulated) real current month.

### Hazard B — `TargetSheet`'s `minDueDate` (found on review; missed in the first pass of this audit)

- **Where:** `frontend/src/screens/plan/TargetSheet.tsx:50-55` (test bug; production code is correct/intentional — a save-by-date target should not be allowed to target a date in the past).
- **What:** `TargetSheet.tsx:50-51` computes `const now = new Date(); const minDueDate = "${now.getFullYear()}-${...}-${...}"` — a second, independent direct wall-clock read in the exact file/screen family as Hazard A. Line 55 then rejects any `save_by_date` due-date earlier than `minDueDate`: `dateOk = type !== "save_by_date" || (dueDate !== "" && dueDate >= minDueDate)`. The test `"target sheet: save-by-date demands a date, then puts the target"` fills the date input with the hardcoded fixture `"2026-12-01"` and asserts the resulting PUT body carries `due_date: "2026-12-01"`. That assertion only holds while the real wall clock is on or before 2026-12-01; past that date `minDueDate > "2026-12-01"`, `dateOk` goes `false`, Save stays disabled, and the PUT never fires — the reviewer caught that the original audit table listed `monthProgress` as the *sole* wall-clock hazard in the plan screens, which was incomplete: this is a distinct read, in a distinct component, gating a distinct assertion.
- **Red demonstration (self-verified, not just taking the reviewer's word):** temporarily changed the already-committed clock pin in `PlanScreen.test.tsx`'s `beforeEach` from `new Date("2026-07-15T12:00:00Z")` to `new Date("2026-12-15T12:00:00Z")` (i.e., simulating "no pin, real date is mid-December 2026") and ran the full file:
  ```
  $ bunx vitest run src/screens/plan/PlanScreen.test.tsx
   ❯ src/screens/plan/PlanScreen.test.tsx (13 tests | 2 failed) 2134ms
      × PlanScreen > shows target progress and the upcoming-bill claim hint with its shortfall 59ms
      × PlanScreen > target sheet: save-by-date demands a date, then puts the target 1143ms
   FAIL  ... shows target progress and the upcoming-bill claim hint with its shortfall
   FAIL  ... target sheet: save-by-date demands a date, then puts the target
        - Expected: { amount_fils: 160000, cadence: "monthly", due_date: "2026-12-01", target_type: "save_by_date" }
        + Received: undefined
    Test Files  1 failed (1)
         Tests  2 failed | 11 passed (13)
  ```
  Confirmed: **two** tests fail, not one — exactly Hazard A and Hazard B, both traced to the same file defaulting to the real wall clock. Then restored the pin to `new Date("2026-07-15T12:00:00Z")` and re-ran: all 13 tests pass (`git diff` on the test file was empty afterward, confirming the file was returned to its committed state before this re-verification).
- **Fix (already committed, no new code change needed):** the existing `beforeEach`/`afterEach` clock pin (see Hazard A's fix below) neutralizes Hazard B as well, because it fixes the *entire test file's* wall clock, not just the one call site it was originally written to protect. No additional test or production code change was required.
- **Disposition:** FIXED — neutralized by the same `PlanScreen.test.tsx` clock pin (verified: both tests fail without the pin at a simulated 2026-12-15, both pass with it).

### Fix applied (covers both hazards)

- Reverted the throwaway single-test patch; instead pinned the whole suite's wall clock once, in `beforeEach`/`afterEach`:
  ```ts
  beforeEach(() => {
    // ... pins to "2026-07-15T12:00:00Z" — inside the JULY fixture month
    vi.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z"), shouldAdvanceTime: true });
    summary = makeSummary();
    calls = [];
    ...
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  ```
  `shouldAdvanceTime: true` keeps RTL's `findBy*`/`waitFor` setTimeout-based polling working normally under fake timers, so no other test in the file needed to change. Re-ran the full file green (13/13), and re-ran it inside all three TZ configurations (UTC+14, UTC−9, default) as part of Step 4 — all green. The fix makes the suite's outcome independent of the real calendar date, permanently (not just past the specific December date used for the red demonstrations), and covers both `PlanScreen.tsx:61`'s `monthProgress` call and `TargetSheet.tsx:50-51`'s `minDueDate` computation, since both simply read `new Date()`/`Date.now()` transitively and both are now intercepted by the same fake-timer pin for every test in the file.
- **Disposition:** FIXED. Commit includes the diff to `PlanScreen.test.tsx` only — no production code changed (the production behavior — hiding the pace marker/claim hints on non-current months, and rejecting past save-by-date targets — is correct and intentional in both cases).

**Step 2/3 — frontend screens double-checked for the same pattern (Home, Insights, ReportsScreen) — no hazard found:**

- `screens/Home.tsx` also computes `isCurrent = scope.kind === "month" && scope.period === currentPeriod()`, but `Home.test.tsx`'s `wrap()` never passes an explicit `scope` prop for the tests that check pace-dependent UI ("surfaces pace: projection and an over-pace verdict", the bucket-bar-color tests) — the component's default scope (`DEFAULT_SCOPE` from `lib/scope.ts`) is itself `{ period: currentPeriod() }`, so `isCurrent` is tautologically `true` regardless of the real date; the mocked `/api/summary` fixture's `month_progress: 0.5` and bucket figures are fixture-relative, not real-date-relative. The one test that explicitly sets a non-"month" scope (`{ kind: "range", from: "2026-03", to: "2026-06" }`) asserts pace/projection are *absent*, which is trivially true for any range scope regardless of the real date. **No hazard.**
- `screens/Insights.tsx` computes `periods = trailingPeriods(currentPeriod(), 6)` and `yoy = yoySummary(yoyRows(trend24.data, currentPeriod()))`, both real-wall-clock-anchored, against a fixture `trend`/`trend24` array that only contains a `"2026-06"` data point. No test in `Insights.test.tsx` asserts on the specific trend-chart bars, period labels, or the YoY percentage value produced by these — the only relevant assertion is presence of the "Spending trends" tile button by role name, and `comparableMonths > 0 ? pctLabel(...) : "—"` is never checked against a specific string. **No hazard** (would need an assertion on the actual computed value to be one).
- `screens/reports/ReportsScreen.tsx` computes `yoy = yoyRows(trend.data, currentPeriod())` the same way; `ReportsScreen.test.tsx`'s only relevant assertion is text presence ("Spending trends", "spent, last 12 months"), never a specific YoY figure. **No hazard.**
- `components/projects/ProjectCard.tsx` / `screens/projects/ProjectDetail.tsx` call `projectPace(project, todayISO())` — real wall clock — but every test fixture in `ProjectCard.test.tsx`/`ProjectDetail.test.tsx` sets `starts_on: "", ends_on: ""` (open-ended), which makes `projectPace` return `null` unconditionally regardless of `today`; the date-windowed project fixtures that do exist (`SwipeDeck.undo.test.tsx`, `SubcategoryPanel.test.tsx`, `projectMath.test.ts`) are consumed only by `orderProjectsForReview(projects, txn.PostedAt)` (an explicit transaction date, not the wall clock) or by direct pure-function unit tests that pass `today` explicitly. **No hazard.**

**Summary:**

| # | Severity | Where | Disposition |
|---|---|---|---|
| 1a | HIGH-if-untested, actually LOW (test-only bug, prod correct) | `frontend/src/screens/plan/PlanScreen.test.tsx` (prod: `PlanScreen.tsx:61-65`, `monthProgress`/claim hints) | **FIXED** — clock pinned via `vi.useFakeTimers`/`vi.useRealTimers` in `beforeEach`/`afterEach`; red demonstrated and re-verified green under both TZ extremes. |
| 1b | HIGH-if-untested, actually LOW (test-only bug, prod correct) | `frontend/src/screens/plan/TargetSheet.tsx:50-55` (`minDueDate`), exercised by the same `PlanScreen.test.tsx` | **FIXED** — same clock pin as 1a neutralizes it too (verified independently: reverting the pin to a simulated 2026-12-15 fails both 1a's and 1b's tests; restoring it passes both). Found by reviewer, not the original Step-2 pass; the original audit table incorrectly presented `monthProgress` as the plan screens' sole wall-clock hazard. |
| 2 | INFO | `internal/server/scheduled.go:317` (`handleGetUpcoming`) reads `time.Now().UTC()` with no `SetNow`-style seam | **DEFERRED: no clock seam** — safe today only because the one test exercising it (`TestUpcomingFeed`) derives its own fixture dates from the same `time.Now()` call; no failure demonstrated, no seam exists to inject a simulated future/past date if one were ever needed. |
| 3 | INFO | `internal/store/insights.go:95` (`SelectMonthlyTotals`) reads `time.Now().UTC()` with no `SetNow`-style seam (the `Store.now` field exists but isn't wired to this query) | **DEFERRED: no clock seam** — same shape as #2; tests explicitly acknowledge the coupling (`insights_test.go:134`) rather than hiding it, and no failure was demonstrated. |

No production-code changes were made — every hazard found had its root cause in a test (or was safe by design). All four Step-1 TZ invocations plus the two default-TZ suites are green after the fix (see Step 1 evidence block, re-run at the top of this section).

## Task 6 — Assertion quality

**Step 1 — assertion-free frontend tests:**

The brief's `awk` heuristic (context window of 30 lines, splits on grep's `--` separator) produced one hit, `AccountsScreen.test.tsx:79`, which on inspection was a false positive: the matched line is `if (/^\/api\/accounts\/\d+\/balances\?/.test(url) ...)` inside a `beforeEach` fetch-mock stub — `.test(url)` is a regex call, not a vitest `test(`, and the line isn't inside an `it(`/`test(` block at all.

A more precise per-block scan (parse every top-level `it(`/`test(` start line, slice to the next such line or EOF, check for `expect(` anywhere in the slice) across all 165 frontend test files found exactly one genuine hit:

- `frontend/src/components/transactions/LinkRefundSheet.test.tsx:56` — `it("shows an empty state when there are no candidates", ...)` contained no literal `expect(` call, only `await screen.findByText(/No categorized purchases/)`. This is not fully assertion-free in practice — Testing Library's `findBy*` throws (failing the test) if the text never appears — but it's a weak, implicit assertion: it doesn't confirm the *candidate list* is properly absent, only that the empty-state copy is present, and it isn't obvious at a glance that the test can fail.
- **Strengthened:** added an explicit `expect(...).toBeInTheDocument()` around the `findByText` result, plus `expect(screen.queryByRole("button", { name: /Carrefour/ })).toBeNull()` to guard against the empty-state copy and the candidate list rendering simultaneously (a real bug the original test would have missed). Verified green: `bunx vitest run src/components/transactions/LinkRefundSheet.test.tsx` → 2/2 passed.

`src/test/storybook.test.tsx` (`expect(container.firstChild).not.toBeNull()` per story) was confirmed by reading it: it's the intentional does-it-render regression net described in the brief and CLAUDE.md — not treated as a gap.

**Step 2 — mock-only tests:**

Ranked `toHaveBeenCalled*`-vs-`expect(` ratio across all `*.test.*` files; reviewed every file where mock-asserts made up ≥75% of that file's total `expect(` calls (the "dominate" cases): `pausableTimeout.test.ts` (13/15), `SettingsPage.test.tsx` (4/4), `liveInvalidation.test.ts` (4/5), `useLiveEvents.test.ts` (4/5), `SwipeableRow.test.tsx` (4/5), `Button.test.tsx` (3/4). Also spot-checked `ProjectForm.test.tsx` (8/14) since its ratio was still notable.

Verdict for all seven: **legitimate, not a gap.** In every case the "mock" being asserted on *is* the externally observable behavior under test, not incidental wiring:
- `pausableTimeout`/`liveInvalidation`: the callback (`fn`/`flush`) passed in is the entire observable output of a pause/debounce timer — there's no other way to observe "did it fire, how many times, with what timing" for a pure scheduling primitive.
- `SettingsPage`/`SwipeableRow`: `onClose`/`onCommit`/`onTap` are component *props* — a gesture-driven component's contract with its parent is exactly "did it call the callback," so asserting `toHaveBeenCalledWith` on it is asserting the real contract, not the wiring.
- `useLiveEvents`: spies on `queryClient.invalidateQueries` and asserts specific `queryKey` arguments (not just "was called") — this is the only observable effect of an SSE-driven cache-invalidation hook.
- `Button`: asserts a haptics `fire("selection")` call alongside the `onClick` prop firing — both are real, distinguishable side effects of a tap.
- `ProjectForm`: asserts `toHaveBeenCalledWith(expect.objectContaining({ budget_fils: null }))` — checking the actual API payload shape (money field null vs. a value), which is exactly the form's job to get right.

No strengthening applied — flagging any of these as gaps and rewriting them would trade a correct assertion style for a less direct one.

**Step 3 — mutation sampling (17 mutations across 6 modules):**

| # | Module | Mutation | Result | Action |
|---|---|---|---|---|
| 1 | `internal/budget` | `thresholds.go`: `activity >= limit` → `activity > limit` (100%-level boundary) | CAUGHT (`TestThresholdLevel/exactly_100`, `TestCurrentThresholdLevels`) | none |
| 2 | `internal/budget` | `envelope.go` `bucketPcts`: swapped `need`/`want` pct assignment | CAUGHT (6 tests: `TestComputeBucketsAndProjection`, `TestComputeRangeAggregates`, 3× `TestAutoAssign*`, `TestCurrentThresholdLevels`) | none |
| 3 | `internal/budget` | `budget.go` `MonthProgress`: forced `return 0` | CAUGHT (`TestComputeBucketsAndProjection`) | none |
| 4 | `internal/categorize` | `categorize.go`: reversed rule-walk iteration order (last-priority-number wins instead of first) | CAUGHT (`TestRulePriorityOrder`) | none |
| 5 | `internal/categorize` | `matchRule` `"contains"` case: dropped `strings.ToLower(r.Pattern)` (pattern side only — merchant side stays lowercased) | **SURVIVED** | new test `TestRuleMatchContainsCaseInsensitivePattern` (mixed-case rule pattern vs. already-lowercase merchant) — proven to fail against the mutant, pass on real code |
| 6 | `internal/categorize` | `Categorize`: confidence-threshold check `conf >= c.threshold` replaced with `true` | CAUGHT (`TestAIFallbackBelowThreshold`) | none |
| 7 | `frontend/src/lib/money.ts` | `formatFils`: dropped `/100` fils→AED conversion | CAUGHT (2 tests) | none |
| 8 | `frontend/src/lib/money.ts` | `flowAmount`: flipped the `+`/`−` sign glyph mapping | CAUGHT (3 tests) | none |
| 9 | `frontend/src/lib/money.ts` | `formatFils`: added `useGrouping: false` (breaks thousands separator) | CAUGHT (`groups thousands and shows 2 decimals`) | none |
| 10 | `frontend/src/lib/scope.ts` | `scopeBounds` range branch: upper bound `-32` → `-31` (inclusive→exclusive, drops the 31st's late timestamps) | CAUGHT (`brackets a range from first day to last-plus-one day`) | none |
| 11 | `frontend/src/lib/scope.ts` | `scopeBounds` range branch: swapped `from`/`to` (month start/end swap) | CAUGHT (same test) | none |
| 12 | `frontend/src/lib/scope.ts` | `normalizeRange`: inverted the ternary branches (`a<=b` now returns the *unsorted* pair) | CAUGHT (`orders the two endpoints ascending`) | none |
| 13 | `frontend/src/lib/envelope.ts` | `movePreview`: flipped `from_after_fils` sign (`-amountFils` → `+amountFils`) | CAUGHT (`preview shifts available on both legs`) | none |
| 14 | `frontend/src/lib/envelope.ts` | `rtaMessage`: `ready_to_assign_fils < 0` → `<= 0` (a zero/fully-assigned RTA wrongly treated as the over-assigned/blocking case) | CAUGHT (`message per state`) | none |
| 15 | `frontend/src/lib/envelope.ts` | `allocationsTotal`: reduce `s + a.amount_fils` → `s - a.amount_fils` (breaks the RTA-adjacent allocation sum) | CAUGHT (`totals and message`) | none |
| 16 | `frontend/src/lib/transactions.ts` | `applyTxnFilters`: inverted the buckets-dimension predicate (`!f.buckets.includes` → `f.buckets.includes`) | CAUGHT (`ANDs across dimensions`) | none |
| 17 | `frontend/src/lib/transactions.ts` | `txnTotals`: dropped the `t.Direction === "debit"` guard from the spend sum | CAUGHT (2 tests) | none |

**Scoreboard: 17 mutations — 16 caught, 1 survived → 1 new test.** No module survived more than 1 of 3 (the >2-of-3 HIGH-finding trigger did not fire anywhere).

### [SEVERITY: medium] `internal/categorize` — `contains` rule matching never exercised with a mixed-case *pattern*

- **Where:** `internal/categorize/categorize.go:110-111` (`matchRule`, `"contains"` case); test gap in `internal/categorize/categorize_test.go`.
- **What:** `matchRule`'s `"contains"` branch lowercases both the merchant and the rule pattern before comparing (`strings.Contains(lowerMerchant, strings.ToLower(r.Pattern))`), so a rule authored with a mixed-case pattern (e.g. a category rule typed as `"Carrefour"` rather than `"carrefour"`) still matches. Deleting the pattern-side `strings.ToLower` survived all existing tests unchanged: `TestRuleMatchContainsCaseInsensitivePattern`'s existing sibling (`TestRuleMatchContainsCaseInsensitive`) only varies the *merchant's* case against an already-lowercase pattern, so it can't detect a broken pattern-side lowercase. Since rule patterns are free-text user input (via Settings → Rules), a rule saved with any uppercase letter would silently stop matching new transactions after this kind of regression — a real, plausible failure mode, not a contrived one.
- **Evidence:**
  ```
  # mutation: matchRule "contains" case → strings.Contains(lowerMerchant, r.Pattern)  (dropped ToLower(r.Pattern))
  $ go test ./internal/categorize/ -v
  ok   (all pre-existing tests green — mutation SURVIVED)

  # new test added, run against the same live mutant:
  $ go test ./internal/categorize/ -run TestRuleMatchContainsCaseInsensitivePattern -v
  --- FAIL: TestRuleMatchContainsCaseInsensitivePattern (0.00s)
      categorize_test.go:114: expected nil error, got ai categorizer unavailable

  # mutation reverted, same test:
  $ go test ./internal/categorize/ -run TestRuleMatchContainsCaseInsensitivePattern -v
  --- PASS: TestRuleMatchContainsCaseInsensitivePattern (0.00s)
  $ go test ./internal/categorize/
  ok
  ```
- **Disposition:** FIXED — added `TestRuleMatchContainsCaseInsensitivePattern` (mixed-case `Pattern: "Carrefour"` matched against the already-lowercase merchant string `"pos purchase - carrefour market"`), proven to fail against the mutant and pass against real code, mutation reverted, full package green.

### [SEVERITY: low] One implicit-assertion frontend test strengthened; storybook net confirmed intentional

- **Where:** `frontend/src/components/transactions/LinkRefundSheet.test.tsx` ("shows an empty state when there are no candidates").
- **What:** see Step 1 above — the test could fail (via `findByText` throwing) but asserted nothing explicit and didn't rule out the candidate list rendering alongside the empty-state copy.
- **Disposition:** FIXED — explicit `expect(...).toBeInTheDocument()` plus a `queryByRole` absence check added; verified 2/2 green.

**Verification:** `go test ./...` → all packages ok (no regressions). `cd frontend && bun run test` → 163 files / 1292 tests passed (same counts as the Task 1 baseline — no tests added or removed at the suite level; `LinkRefundSheet`'s existing test was strengthened in place, `categorize_test.go` gained one new test). `git diff --stat` shows only `internal/categorize/categorize_test.go` and `frontend/src/components/transactions/LinkRefundSheet.test.tsx` changed — zero production source files touched; every mutation was reverted via `git checkout --` immediately after recording its result.

## Task 7 — Coverage map

**No tests were written in this task.** Numbers are for finding gaps, not for chasing them; a coverage dev-dependency was added (see Step 4) so this map can be re-run in future reviews.

### Step 1 — Go coverage (`go test ./... -coverprofile -covermode=atomic`)

```
ok   ledger/internal/anthropic   72.7%
ok   ledger/internal/budget      95.4%
ok   ledger/internal/categorize  87.2%
ok   ledger/internal/config      78.4%
ok   ledger/internal/importer    68.0%
ok   ledger/internal/ingest      47.8%
ok   ledger/internal/monitor     78.3%
ok   ledger/internal/parse       88.2%
ok   ledger/internal/push        40.0%
ok   ledger/internal/recur       89.6%
ok   ledger/internal/server      73.5%
ok   ledger/internal/store       82.3%
--   ledger/cmd/ledger            0%  (no *_test.go files at all — "no such tool covdata" from `go tool cover` is the benign symptom of a package with zero tests, not a build error)
--   ledger/internal/web          0%  (no *_test.go files — expected, it's a //go:embed wrapper)
```

Combined statement total across tested packages: **78.4%** (`go tool cover -func` grand total).

**Methodology correction, recorded because it changed a finding:** the brief's Step-1 command has no `-coverpkg=./...`, so by Go's default each package's coverage profile only counts execution *within that package's own test binary* — a `store` function exercised only by an `internal/server` test (calling through the real store, not a fake) still reports 0% in `store`'s own line. Cross-checking the whole 0%-symbol table below against a second run with `-coverpkg=./...` (which merges cross-package attribution) caught one false positive worth flagging: `store.BulkUnassignProject` reports 0% per-package but **100%** under `-coverpkg=./...` — `TestBulkAssignProject` (`internal/server/projects_test.go`, despite its name) exercises both the assign *and* the bulk-unassign endpoint end-to-end against a real store. `store.ProjectRollups` similarly jumps from 0% to 85% (via `TestGetProjectsListWithRollups`). Every other symbol below was re-verified under `-coverpkg=./...` and stayed genuinely at 0% — those are real gaps, not attribution artifacts.

0%-covered exported symbols in the risk-bearing packages (`parse`, `store`, `server`, `importer`, `budget`), confirmed 0% under both plain and `-coverpkg=./...` runs:

| Package | Symbol | Note |
|---|---|---|
| `importer` | `ReadXLSX` (reader.go:54) | XLSX ingestion path for historical `ledger import`; only the CSV path is exercised by tests |
| `parse` | `DIBParser.Bank`, `ENBDParser.Bank`, `ENBDAlertParser.Bank` | trivial one-line getters (`return "dib"` etc.) — noise, not a real gap |
| `parse` | `Processor.SetOnInsert` | wiring setter for the post-insert hook; the hook's *effect* is tested elsewhere, the setter itself isn't called from a test |
| `server` | `handleVapidPublicKey` | trivial — reads one field off `pushSender` and echoes JSON |
| `server` | `SetDriftMonitor`, `SetPushSender` | wiring setters, same shape as `SetOnInsert` |
| `server` | `handleTransactionEmail` | serves the raw source email behind a transaction (the CLAUDE.md "nothing silently dropped" recoverability path) — read-only, but completely unexercised |
| `store` | `RecentAIUsage` | real SQL query is untested; `internal/server/ai_usage_test.go` only exercises the handler against a **fake** implementing the interface, so the actual query (ordering, `LIMIT`) never runs against SQLite |
| `store` | `SelectEarliestPeriod` | feeds the budget "first period available" UI affordance; no test, handler or store level |
| `store` | `Vacuum` | only caller is `ledger compact` in `cmd/ledger` (also untested) |

Not a gap (false positives caught and excluded, see methodology note above): `store.BulkUnassignProject` (100% under cross-package attribution — `TestBulkAssignProject` drives the real success path despite its name), `store.ProjectRollups` (85% — `TestGetProjectsListWithRollups`).

### Step 2 — Frontend coverage (`bunx vitest run --coverage`, v8 provider)

Added `@vitest/coverage-v8@2.1.9` as a dev dependency (exact match to installed `vitest@2.1.9`, confirmed via `node_modules/vitest/package.json` before adding). Full run: **163 files / 1292 tests passed**, 65s.

```
Statements   : 78.25% ( 12726/16263 )
Branches     : 86.11% ( 3765/4372 )
Functions    : 78.09% ( 945/1210 )
Lines        : 78.25% ( 12726/16263 )
```

The all-files figure is dragged down by `harness/*.mjs` and `scripts/*.mjs` (0% — they're Playwright/Node driver scripts, not unit-tested code, and out of scope) and `src/main.tsx` (0%, pure bootstrap). Per-directory, excluding those:

| Directory | Stmts | Branch | Funcs | Notes |
|---|---|---|---|---|
| `src/lib` | 96.53% | 95.60% | 98.89% | matches the CLAUDE.md convention of pulling logic into pure, unit-tested `lib/` functions. Weak spot: `sound.ts` 17.64% (haptic/audio feedback — no money-correctness impact). |
| `src/api` | 92.34% | 92.80% | 85.34% | `types.ts` 0% (type-only, expected). `client.ts` 73.72% — uncovered lines are exactly the "one-shot" undo helpers `moveMoneyOnce`/`assignEnvelopesOnce`/`putTargetOnce` (lines 120-130) and the `renameMerchant` "blocked" error branch (144-145). The file's own comment flags these as designed to "outlive their sheet" (toast-closure undo) — the money-moving call itself is never asserted at the unit level. |
| `src/components` | 97.63% | 85.45% | 95.83% | high; `components/dither-kit` (vendored chart library) drags branch/func numbers down in isolation (54.69%/73.43%) — several files at flat 0% (`block-legend.tsx`, `dot.tsx`, `grid.tsx`, `legend.tsx`, `polar-root.tsx`, `polar-context.tsx`, `x-axis.tsx`, `y-axis.tsx`) but these are unused-in-this-app chart primitives (only `core`+`bar-chart` are wired per `components/dither-kit/README.md`), not first-party risk. |
| `src/screens` | 89.37% | 78.30% | 66.07% | `RulesManager.tsx` lowest at 73.97%/45.45% funcs; `Transactions.tsx` 75.89%/44.44% funcs (largest, most-changed screen — see risk list). |
| `src/hooks` | 80.96% | 78.26% | 74.19% | `useTxnActions.ts` **44.64%/37.5% funcs, no dedicated test file at all** — see risk list. `useVisualViewport.ts` 51.85%, `useSheetDrag.ts` 76.36%, `useSwipeGesture.ts` 77.96% — all gesture/keyboard-geometry hooks that CLAUDE.md explicitly says are harness-covered, not vitest-covered. |

Harness coverage cross-reference: **Task 8 has not run yet** (no `task-8-report.md` in this review directory) — harness coverage for the gesture hooks and sheets above is marked **TBD**, not confirmed, until Task 8 lands. Treat the "relies on the harness" note in the risk list below as an assumption to verify then, not a settled fact.

**Known parallel-worktree trap:** `@vitest/coverage-v8@2.1.9` was installed only inside this worktree's `frontend/node_modules` (`bun add -d`). It will not exist in the main checkout or any other worktree until this branch merges to `main` and the main checkout re-runs `bun install` — re-running this coverage command elsewhere before then will fail with a missing-package error, not stale numbers. Flag this in the eventual PR description.

### Step 3 — Top-10 uncovered-risk list (ranked by money-correctness impact × change frequency, not raw %)

1. **`frontend/src/hooks/useTxnActions.ts`** (44.64% stmts, 37.5% funcs, no dedicated test file) — the shared mutation hook behind categorize/archive/restore/status-change/unlink-refund from Transactions *and* Insights drill-down, including every toast "Undo" closure. Only indirectly exercised through the screens that consume it; the undo-path re-POST and its own error branches have no direct assertion. Highest change-frequency + highest money/state-correctness blast radius of anything found.
2. **`frontend/src/api/client.ts` one-shot undo helpers** (`moveMoneyOnce`, `assignEnvelopesOnce`, `putTargetOnce`, lines 120-130, 0% covered) — money-moving envelope/target writes deliberately kept outside React Query mutation hooks so they survive component unmount inside a toast's "Undo" closure; the file's own comment calls this out as the reason they're separate. No unit test calls them.
3. **`internal/importer.ParseAmount`/`LoadMap`** (80.0%/70.6%) — the float-string→fils conversion for historical CSV/XLSX backfills (`mapping.go:109`, round-half-up `toFils`), covering only the `"sign"` `DirectionMode` branch well; the `"columns"` (separate debit/credit column) branch and various malformed-amount edges are thinner. This is hand-rolled money-precision code (`f*100 + 0.5`) on a path that runs once per historical import — exactly the kind of rarely-run, easy-to-regress arithmetic CLAUDE.md's "money is integer minor units" rule is meant to guard, and the columns-mode branch is the less-tested of the two.
4. **`internal/store.RecentAIUsage`** (0% — real SQL never runs in tests) — the handler is tested only against a hand-written fake (`internal/server/ai_usage_test.go`), so a real SQL regression (bad `ORDER BY`, off-by-one `LIMIT`) would pass CI silently.
5. **`cmd/ledger` package — 0 test files, entire `os.Args[1]` dispatch untested** — `import`/`compact`/`vapid-keys` routing, flag parsing, and `--dry-run` handling for the CSV/XLSX backfill path all run only at the `internal/importer`/`internal/store` unit level; nothing verifies the CLI wiring itself picks the right subcommand or forwards flags correctly. Changed whenever a new CLI verb is added.
6. **`internal/importer.ReadXLSX`** (0%, plus `ReadFile`'s extension dispatch at 25%) — only the CSV import path has test coverage; XLSX backfills (`docs/map.example.toml` supports both) go through an entirely unexercised code path, from the extension-sniffing dispatcher down to the parser itself.
7. **`frontend/src/screens/Transactions.tsx`** (75.89% stmts, 44.44% funcs) — the largest, highest-change-frequency screen (filters, bulk actions, swipe-to-categorize entry point) sits well below the `src/screens` average.
8. **`internal/server.handleTransactionEmail`** (0%) — read-only, but it's the surface for CLAUDE.md's "nothing is ever silently dropped" guarantee (viewing the raw source email behind a parsed transaction); a regression here would quietly break the one recovery path a user has when a transaction looks wrong.
9. **`internal/store.SelectEarliestPeriod`** (0%) — feeds the budget UI's earliest-available-period boundary; wrong data here silently mis-bounds date pickers/backfill ranges rather than erroring.
10. **`internal/push.Send`** (0%) — the actual Web Push network call (VAPID-signed POST to the push service). Understandably hard to unit test (external network, browser-side crypto), but it's the only step in the push pipeline with zero coverage — `store.InsertPushSub`/`SelectPushSubs`/`DeletePushSub` and the HTTP subscribe/unsubscribe handlers are all tested around it.

Deliberately excluded from the list as noise or false positives: `DIBParser.Bank`/`ENBDParser.Bank`/`ENBDAlertParser.Bank` (trivial one-line getters), `SetOnInsert`/`SetDriftMonitor`/`SetPushSender` (wiring setters with no logic of their own), `handleVapidPublicKey` (single field echo), vendored `dither-kit` chart primitives not wired into the app, `sound.ts`/harness/`scripts/*.mjs` (no money-correctness surface), and `store.BulkUnassignProject`/`ProjectRollups` (see methodology note in Step 1 — real coverage exists via `internal/server` tests, the per-package profile just doesn't attribute it).

### Step 4 — Commit

`frontend/package.json` (+ `@vitest/coverage-v8@2.1.9` dev dep), `frontend/bun.lock`, and this findings section committed together.

## Task 8 — Harness & Storybook seams

**Environment note:** while running this task's verification, the shared scratch
stack (`/tmp/ledger-ui-harness`, ports 8099/5199) was already in use by another
concurrent worktree session (`framer-motion-migration`, vite process cwd
confirmed pointing there). Rather than run `stack.sh up` (which kills whatever
holds those ports and would have hijacked that session), verification for this
task ran an independent instance via `LEDGER_HARNESS_DIR=/tmp/ledger-ui-harness-cdp
LEDGER_HARNESS_API_PORT=8199 LEDGER_HARNESS_UI_PORT=5299 harness/stack.sh up`,
confirmed against this worktree (`ls -l /proc/<vite-pid>/cwd` → this checkout's
`frontend`), then torn down with the same env vars at the end — production
`:8080` and the other session's `:8099`/`:5199` were never touched.

### Step 1 — destination → harness map

`frontend/harness/nav.mjs` (pre-change) declared 21 screens. Cross-referencing
`AppShell.tsx`'s tab/overlay set, `ProjectsFlow.tsx`, and every
`screens/settings/*` page against the nav map:

| Destination | Harness id | How reached |
|---|---|---|
| Home | `home` | bottom nav tab |
| Plan (envelopes) | `plan` | bottom nav tab |
| Transactions | `transactions` | bottom nav tab |
| Review (swipe deck) | `review` | bottom nav tab |
| Insights | `insights` | bottom nav tab |
| Reports | `reports` | Home → "Open Reports" (AppShell overlay) |
| Recurring bills | `recurring` | Home → "Open Recurring" (AppShell overlay) |
| Accounts (list) | `accounts` | Settings → "Accounts" row (AppShell overlay) |
| **Accounts › account detail** | **`account-detail`** (NEW) | Accounts → tap an account row (full-screen `SettingsPage`, not a sheet — `AccountDetail.tsx`) |
| Settings hub | `settings` | TopBar gear (every tab) |
| Settings › Budget & income | `settings-budget` | hub row |
| Settings › Categorization | `settings-categorization` | hub row |
| Settings › Swipe actions | `settings-swipe` | hub row |
| Settings › Email ingest | `settings-ingest` | hub row |
| Settings › AI & API usage | `settings-ai` | hub row |
| Settings › Notifications | `settings-notifications` | hub row |
| Settings › Text size | `settings-textsize` | hub row |
| Settings › Categories (`CategoryManager`) | `settings-categories` | hub row |
| Settings › Rules (`RulesManager`) | `settings-rules` | hub row |
| Settings › Currencies | `settings-currencies` | hub row |
| Settings › Transfers (`AccountsPage.tsx`, titled "Transfers" — a distinct, narrower component from the Accounts overlay above; hub row's `onClick` is `onOpen("accounts")`, a *Settings-internal* page id, not the AppShell-level Accounts overlay) | `settings-transfers` | hub row |
| Haptics / Sound toggles | — (inline switches on `settings`, no drill-in) | not a destination |
| "Clear all categorization" confirm dialog | — | hub row opens a `Dialog`; deliberately never auto-opened by `probe.mjs` (its `DESTRUCTIVE` regex matches "clear") — see finding below |
| Projects (list) | `projects` | Settings → "Projects" row (AppShell-level overlay, `ProjectsFlow`) |
| **Projects › project detail** | **`project-detail`** (NEW) | Projects list → tap "Japan Trip" card (full-screen `SettingsPage`, `ProjectDetail.tsx`; its own header comment literally says "(Task 8b)") |
| **Projects › new project form** | **`project-form`** (NEW) | Projects list → "+ New project" (full-screen `SettingsPage`, `ProjectForm.tsx`; no data dependency) |
| **Projects › bulk backfill** | **`project-bulk-backfill`** (NEW) | Project detail → "Add transactions" (full-screen `SettingsPage`, `BulkBackfill.tsx`) |

3 destinations were reachable by deterministic taps against the seeded fixture
data but absent from `nav.mjs`: **`account-detail`**, **`project-detail`**,
**`project-form`**, **`project-bulk-backfill`** (4 ids — `project-detail` and
`project-bulk-backfill` share the same seeded project). All four are
full-screen `SettingsPage` drill-ins (the app's "not a sheet, a page"
convention — see `components/README.md`'s SettingsPage entry), which is why
they need their own screen ids: `shoot.mjs`'s per-screen geometry audit can
only reach what `nav.mjs` names.

**Not added (special-data states, recorded as findings instead, per the
brief's instruction not to invent nav entries for these):**

- **`DetectedCards`** (`screens/recurring/DetectedCards.tsx`) — the "detected
  proposal" triage cards on the Recurring screen only render for schedules
  with `status === "proposed"`, which `internal/store/scheduled.go`'s
  `validateSchedule` only defaults to when `Source == "detected"` (i.e.
  produced by the recurring-detection sweep over real ingested mail).
  `harness/seed.mjs` creates its 5 scheduled rows via a plain
  `POST /api/scheduled` with no `source` field, so they default to
  `source: "manual"` → `status: "active"`, and land in the schedule list, never
  the proposals section. Reaching `DetectedCards` needs either a live
  detection run or a seed change to POST with `source: "detected"` (and no
  `status`) — out of scope for a nav-map fix. **DEFERRED.**
- **"Clear all categorization" confirm dialog** (`Settings.tsx`) — reachable
  from the `settings` hub row, but `probe.mjs`'s `DESTRUCTIVE` regex
  (`/delete|remove|clear|reset|.../i`) deliberately never opens it, so its
  geometry has no automated coverage at all (by design — protecting fixture
  data during a probe run is more valuable than auditing this one dialog).
  **DEFERRED.**

### Step 2 — nav.mjs changes and a real bug they surfaced

Adding `account-detail`/`project-detail`/`project-form`/`project-bulk-backfill`
exposed a genuine harness bug, not just a documentation gap: tapping the
seeded "Japan Trip" project card via the existing `tap()` helper
(`page.locator(selector).first()`) hung for the full 8s timeout and failed.
Root cause: `AppShell` keeps every panel on a drill-in path mounted (just
`inert`), so Home's own "Projects glance" section still renders a
"Japan Trip" `ProjectCard` — with identical text — three panels *underneath*
the Settings → Projects → (list) stack that's actually on screen. `.first()`
resolves to the covered, non-interactive Home copy (DOM-earlier), and
Playwright's actionability wait never resolves against an element another
layer is covering. Fixed by adding `tapLast(page, selector)` to `nav.mjs`
(same shape as `tap`, but `.last()` — the foreground overlay is always
mounted after its covered ancestors in JSX order) and using it for the two
"Japan Trip" taps. `account-detail`'s "Emirates NBD Current" tap didn't hit
this — Home's pocket strip doesn't repeat individual account names as
button text — so plain `tap()` was left alone there and everywhere else.
This is exactly the class of bug the harness is supposed to catch (a
selector idiom that silently breaks against the app's own "keep it mounted,
mark it inert" navigation model), just tripped by the audit's own new nav
entries rather than the app.

### Step 3 — live verification (`shoot.mjs`, all 25 screens, phone viewport)

Full run against the isolated scratch instance described above, fixture data
reset immediately before:

```
ok  home                         3 shot(s)  0 audit issue(s)
ok  plan                         3 shot(s)  0 audit issue(s)
ok  transactions                 6 shot(s)  0 audit issue(s)
ok  review                       1 shot(s)  0 audit issue(s)
ok  insights                     3 shot(s)  0 audit issue(s)
ok  reports                      3 shot(s)  0 audit issue(s)
ok  recurring                    3 shot(s)  0 audit issue(s)
ok  accounts                     3 shot(s)  0 audit issue(s)
ok  account-detail               3 shot(s)  1 audit issue(s)
ok  projects                     3 shot(s)  0 audit issue(s)
ok  project-detail               3 shot(s)  0 audit issue(s)
ok  project-form                 3 shot(s)  12 audit issue(s)
ok  project-bulk-backfill        6 shot(s)  0 audit issue(s)
ok  settings                     3 shot(s)  0 audit issue(s)
ok  settings-budget .. settings-transfers   (10 sub-pages)   0 audit issue(s) each
```

All 25 screens reach and shoot cleanly (no `error`, no console errors). Two of
the four new screens surfaced real, previously-unaudited layout findings —
exactly what this harness exists to find:

#### [SEVERITY: medium] `AccountDetail` doesn't mark its parent screen inert while open

- **Where:** `frontend/src/screens/accounts/AccountsScreen.tsx:113` (`{detail && <AccountDetail .../>}`, no `inert` wrapper on the rest of the screen).
- **What:** `audit.mjs`'s `background-layer-not-inert` check found 6 controls on the underlying `AccountsScreen` still focusable/tabbable while `AccountDetail`'s full-screen overlay sits on top — including the Accounts screen's own "Back from Accounts" button. Contrast with `ProjectsFlow.tsx`, which wraps every covered layer in `<div className="contents" inert={...}>` (0 audit issues on `project-detail`) — `AccountsScreen` is the one full-screen-drill-in host in the app that skips this pattern. Concretely: Tab from inside the open `AccountDetail` panel can currently reach the covered Accounts list's controls, and a screen-reader's cursor can wander onto them too.
- **Evidence:** `harness/shoot.mjs --screens account-detail` → `background-layer-not-inert`, count 1, detail: *"6 control(s) on the screen underneath this overlay are still focusable... (e.g. button...[aria-label="Back from Accounts"])"*.
- **Disposition:** DEFERRED (finding only — Task 8 is a harness/seam audit, not a UI-bugfix pass). Fix shape: wrap `AccountsScreen`'s own content in `inert={detailId !== null || addOpen}`, matching the existing `ProjectsFlow`/`AppShell` convention.

#### [SEVERITY: medium] `ProjectForm`'s color swatches are 32×32px, under the 44px tap-target minimum

- **Where:** `frontend/src/screens/projects/ProjectForm.tsx:117` (`className="w-8 h-8 rounded-[var(--radius)] press"`, no `data-dense-target`).
- **What:** `audit.mjs`'s `tap-target-too-small` check flagged all 12 palette buttons (`aria-label="azure"`, `"amber"`, `"lilac"`, ... `"slate-deep"`) at 32×32px — below both the documented 44px minimum and the 36px `data-dense-target` escape hatch (`components/README.md`: "Touch targets... 36px (`IconButton size="sm"`) is allowed only inside dense stacked rows"). This is the first time this screen has been reached by the geometry auditor (it had no nav entry before this task), so the gap was previously invisible to the harness.
- **Evidence:** `harness/shoot.mjs --screens project-form` → `tap-target-too-small`, count 12, each `32x32px, minimum is 44x44`. Screenshot confirms visually: the color row has no padding/gap large enough to compensate for the small hit box.
- **Disposition:** DEFERRED (finding only, same reasoning as above). Fix shape: either grow the buttons to 44×44 (adjusting the grid's `gap-2` accordingly) or add `data-dense-target` and grow to at least 36×36 if the 9-color-plus-4-"deep"-variant grid must stay compact.

### Step 4 — sheet/dialog coverage (`Dialog`-rendering components vs. what the harness opens)

`grep -rln "Dialog" src/screens src/components --include="*.tsx" | grep -v test | grep -v stories` returned **28** files (re-run to confirm: `wc -l` → 28). **4** were false positives on a comment/import mentioning "Dialog" with no actual `<Dialog` JSX rendered: `components/ui/Field.tsx`, `screens/accounts/BalanceField.tsx`, `screens/settings/SettingsPage.tsx` (the *shell* component named "SettingsPage", unrelated to the `Dialog` primitive), and `components/ui/Dialog.tsx` itself (the primitive's own definition file — it doesn't render `<Dialog>` recursively; `grep -c "<Dialog" components/ui/Dialog.tsx` → 0). That leaves **24** real ones:

| Component | Host screen | Reached by `probe.mjs`'s generic per-screen opener-crawl? |
|---|---|---|
| `AssignSheet`, `MoveMoneySheet`, `TargetSheet` | `plan` | Yes — plain button openers on the screen `probe.mjs`/`sheets.mjs` already drive (`sheets.mjs` specifically exercises the Assign→Move sheet-swap case) |
| `CategorizeSheet`, `TransactionDetailSheet` | `transactions` | Yes — row tap opens the detail sheet; category chips are inside it |
| `SplitSheet`, `RenameMerchantSheet`, `LinkRefundSheet` | `transactions`, nested *inside* `TransactionDetailSheet` | **No** — `probe.mjs` computes its opener list once from the screen's top-level DOM before its crawl loop, and only re-probes inputs after opening one overlay; it never re-crawls for openers *inside* an already-open sheet, so a sheet-behind-a-sheet is structurally invisible to the generic crawl. All three do have colocated `*.stories.tsx` + `*.stories.test.tsx` (portable-story render smoke), so they aren't wholly untested, just not harness-geometry-audited in their opened state. |
| `SubcategoryPanel` (`components/swipe/SubcategoryPanel.tsx`) | `review` (mounted inside `SwipeDeck.tsx`) | **No** — it's the swipe deck's post-swipe category/bucket picker, opened by an edge-swipe gesture crossing the commit threshold (`pendingAction`/`pendingDirection` state in `SwipeDeck.tsx`), not by clicking a button. `probe.mjs`'s opener-crawl only enumerates and clicks `button, [role='button']` elements — a gesture-triggered sheet is invisible to it by construction, the same disposition class as the nested-sheet gap above but for a different reason (no button exists to find, rather than the button existing but out of crawl scope). No story either — it's in the Step 6 zero-stories list below. |
| `DrillDownSheet`, `SearchSheet` | `insights` | Yes |
| `EmailPreviewSheet` | `transactions` (nested inside `TransactionDetailSheet`) | **No** — same nested-sheet gap as above; no story either |
| `FilterChips` | `insights` (`SearchSheet`'s dimension picker) | Nested the same way — **No** |
| `PeriodSheet` | `home`/any TopBar stepper | Yes — has its own story too |
| `AddAccountSheet`, `CheckinSheet`, `UpdateBalanceSheet` | `accounts` | Yes |
| `AddTransactionSheet` | `account-detail` (new) | Yes, now that the screen id exists — not run in this task's verification pass, see the probe-mutation-risk finding below |
| `ProjectDetail`'s delete-confirm `Dialog` | `project-detail` (new) | Not run this pass, see below |
| `MatchedTxnsSheet`, `ScheduleForm` | `recurring` | Yes |
| `ReportDrillSheet` | `reports` | Yes |
| `RulesManager`'s delete-confirm `Dialog` | `settings-rules` | Yes |
| `Settings.tsx`'s clear-all-categorization `Dialog` | `settings` | **No** — deliberately skipped, see Step 1 |

**Finding: nested sheets (a sheet opened from inside another already-open sheet) are structurally invisible to `probe.mjs`'s generic crawl.** `SplitSheet`, `RenameMerchantSheet`, `LinkRefundSheet` (all nested inside `TransactionDetailSheet`) and `EmailPreviewSheet`/`FilterChips` (nested inside `SearchSheet`) fall in this gap. They're not uncovered entirely — all but `EmailPreviewSheet` have portable-story render tests — but their *in-app* geometry (does the nested sheet fit, is its footer reachable, does closing it correctly restore the parent sheet's scroll lock) has never been driven by `probe.mjs` or `sheets.mjs`. **DEFERRED** — fixing the crawl to re-enter nested overlays is a `probe.mjs` design change, out of scope for a seam-mapping task.

**Finding: `probe.mjs` run against `project-detail`/`project-form`/`project-bulk-backfill` would silently corrupt the scratch fixture, with no undo — not executed, for that reason.** Traced from code, not observed by running it (the risk was judged too real to demonstrate against even a scratch DB casually):
- `project-detail`'s "Mark complete"/"Reopen" button (`ProjectDetail.tsx:163-165`, `toggleStatus`) fires a real `PUT` immediately on click — no dialog opens, so `probe.mjs`'s "not a sheet-opener, treat as toggled, move on" branch (`probe.mjs:329-333`) never undoes it, unlike an opened-then-closed `Dialog`. Neither "mark" nor "complete" nor "reopen" matches the `DESTRUCTIVE` regex, so `probe.mjs` would click it and permanently flip the seeded "Japan Trip" project's status.
- `project-bulk-backfill`'s "Assign N" bulk-commit button (`BulkBackfill.tsx`) is a plain button on a `SettingsPage` (not a `Dialog`), so the same "not a sheet, continue" logic applies — a probe run risks bulk-reassigning real seeded transactions with no rollback, since "assign" isn't in the `DESTRUCTIVE` regex either.
- `project-detail`'s "Edit" button navigates to the full-screen `ProjectForm`, which isn't a `Dialog` either (`inspectOverlay` finds no `[role="dialog"]`) — `probe.mjs`'s `closeOverlay` (`Escape`, then a `Dialog`-scoped Cancel/Close button) has no effect on a `SettingsPage`, so the crawl silently continues probing the wrong screen instead of returning to `project-detail`.
This is a real, pre-existing gap in `probe.mjs`'s "did a dialog open" heuristic (it doesn't distinguish "opened a sheet" from "fired a mutation"), surfaced only because this task added full-screen destinations with plain mutating buttons on them; it was already latent for e.g. `RulesManager`'s pause/resume-style toggles if any exist outside a dialog. **DEFERRED** — a `probe.mjs` fix (e.g. an explicit per-screen opener allowlist/blocklist, or detecting a same-origin `PUT`/`PATCH` fetch as a mutation signal) is out of scope here.

### Step 5 — stories ↔ stories-test net

```
$ cd frontend/src && for s in $(find . -name "*.stories.tsx"); do t="${s%.stories.tsx}.stories.test.tsx"; [ -f "$t" ] || echo "MISSING: $t"; done
(no output)
```

The net was already 1:1 — 38 `*.stories.tsx` files, 38 colocated
`*.stories.test.tsx` files, zero gaps. No new stories-test files were needed.

### Step 6 — catalog components with zero stories at all

Diffing every component named in `components/README.md` (primitives +
"Feature components" section) against the actual 38 `*.stories.tsx` files
(by basename) surfaces 23 catalog entries with no story at all — not a
1:1-net gap (nothing here is an orphaned `.stories.tsx`), but a real
coverage hole in the "Storybook is the living catalog" claim the README
opens with:

`SettingsPage`, `PeriodSheet`, `RollingNumber`, `PullToRefreshIndicator`,
`IngestHealthBanner`, `ActiveBandHighlight`, `CategoryManager`,
`RulesManager`, `TransactionRow`, `SwipeableRow`, `TransactionDetailSheet`,
`NoteField`, `CategorizeSheet`, `FilterBar`, `FilterChips`,
`SubcategoryPanel`, `SwipeDeck`, `SwipeCard`, `AddTransactionSheet`,
`LinkRefundSheet`, `TrendBars`, `FlowBars`, `LensBreakdown`,
`ComparativeSummary`.

(`PeriodSheet` above is a false alarm in one sense — `components/ui/PeriodSheet.tsx`
has no story, but the Step-4 table already lists it as harness-reachable via
the TopBar stepper across nearly every screen, so it isn't *un-audited*,
just not in Storybook.)

Per the brief, these are **DEFERRED: needs design work** — not scaffolded
blindly. Most need either live query data (`TransactionRow`, `CategoryManager`,
`RulesManager` all fetch), gesture/gesture-adjacent gluing (`SwipeableRow`,
`SwipeDeck`/`SwipeCard`, `SubcategoryPanel`), gnarly mock setups
(`TransactionDetailSheet`, `CategorizeSheet`, `AddTransactionSheet`,
`LinkRefundSheet` all pull in `useTxnActions`/react-query), or are
chart-library wrappers with imperative canvas lifecycles (`TrendBars`,
`FlowBars`, `ActiveBandHighlight`) — none of these are a `render()`-and-done
story the way `Button`/`Pill`/`Card` are, which is likely *why* they don't
have one yet, not an oversight to blindly fix by adding a thin wrapper story.

### Step 7 — other findings

- **`nav.mjs`'s `interactions` field and the `--state` flag it documents are
  dead.** The file-header comment says "the capture tool can drive them via
  `--state`" and two `SCREENS` entries (`plan.interactions.assign`,
  `transactions.interactions.search`/`.detail`) define handlers, but
  `grep -rn "interactions\|--state" harness/*.mjs` shows no script (`shoot.mjs`,
  `probe.mjs`, `sheets.mjs`) ever reads `screen.interactions` or accepts a
  `--state` flag. These extra states (Plan's Assign sheet, Transactions'
  search-filled state, Transactions' detail sheet) are currently audited only
  incidentally, via `probe.mjs`'s generic opener-crawl on those screens — never
  intentionally via the mechanism the comment describes. **DEFERRED** — wiring
  `--state` into `shoot.mjs` (or removing the dead comment/fields if the
  intended mechanism was abandoned) is a harness-infra change, out of scope here.

### Commit

`frontend/harness/nav.mjs` (4 new screen ids + `tapLast` helper),
`docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (this
section). No new `*.stories.test.tsx` files were needed (Step 5 above); no
production source changed (all findings are DEFERRED, per Task 8's scope as a
seam-mapping audit, not a bugfix pass).

## Task 9 — Synthesis and final verification

Executive summary written above, after the baseline block (Step 1).

### Step 2 — Final verification battery (all commands run from
`/root/Coding/ledger/.claude/worktrees/category-delete-persistence` on branch
`worktree-category-delete-persistence`, sequentially, per the brief):

```
$ go test ./... -race -shuffle=on
?   ledger/cmd/ledger          [no test files]
ok  ledger/internal/anthropic  1.024s
ok  ledger/internal/budget     1.019s
ok  ledger/internal/categorize 1.026s
ok  ledger/internal/config     1.027s
ok  ledger/internal/importer   2.390s
ok  ledger/internal/ingest     3.827s
ok  ledger/internal/monitor    1.023s
ok  ledger/internal/parse      4.024s
ok  ledger/internal/push       1.016s
ok  ledger/internal/recur      3.469s
ok  ledger/internal/server     23.525s
ok  ledger/internal/store      34.504s
?   ledger/internal/web        [no test files]

$ TZ=Pacific/Kiritimati go test ./... | grep -cv "^ok"
2   # the two "?  ... [no test files]" lines (cmd/ledger, internal/web) — same
    # as every other run in this review; zero actual failures

$ cd frontend
$ bun run test
 Test Files  163 passed (163)
      Tests  1292 passed (1292)
   Duration  51.61s

$ bunx vitest run --sequence.shuffle --sequence.seed=7
 Test Files  163 passed (163)
      Tests  1292 passed (1292)
   Duration  42.38s

$ TZ=Pacific/Kiritimati bun run test
 Test Files  163 passed (163)
      Tests  1292 passed (1292)
   Duration  60.27s

$ bunx tsc --noEmit && echo "tsc clean"
tsc clean

$ cd .. && gofmt -l internal/ cmd/ | grep -v "ingest.go\|rates_test.go"; echo "gofmt checked"
gofmt checked   # (no other output — nothing to report)

$ gofmt -l internal/ cmd/     # unfiltered, for the record
internal/ingest/ingest.go
internal/server/rates_test.go
```

Every line green. The two `gofmt -l` hits are exactly the two files the brief
names as pre-existing drift not owned by this review (`internal/ingest/ingest.go`,
`internal/server/rates_test.go`) — recorded here, not reformatted, per the
binding constraint.

**No red anywhere in the battery** — nothing needed investigating or
deferring as a result of this step.

### Step 3 — Dist check

```
$ git log --oneline --name-only bfa6fc2..HEAD | grep "^frontend/src" | grep -v test | grep -v stories
(no output)
```

Zero non-test frontend source files changed anywhere in the review range
(`bfa6fc2..HEAD`, 10 commits). The only `frontend/` files touched across the
whole review were: `frontend/bun.lock`, `frontend/harness/nav.mjs`,
`frontend/package.json`, `frontend/src/components/transactions/LinkRefundSheet.test.tsx`,
`frontend/src/screens/plan/PlanScreen.test.tsx`, `frontend/vite.config.ts` —
two `*.test.tsx` files, one harness driver script, one build-config file, and
dependency manifests. Per CLAUDE.md, `vite.config.ts` is build config (not
shipped source) and `package.json`/`bun.lock` are dependency manifests, not
application code — none of the six is a shipped frontend source change.

**Conclusion: the embedded dist does not need rebuilding.** Skipped per the
brief's "only test files changed" branch — `internal/web/dist/` still matches
the frontend source that produced it before this review began.

### Step 4 — Report and commit

This section plus the executive summary constitute the finished report,
committed together with this file.
