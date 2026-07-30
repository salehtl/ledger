# Test Suite Review — Findings (2026-07-30)

Baseline at bfa6fc204918fc5bfe186de379cabf3ce201e3c9:
- Go: 14 packages, all ok except internal/config TestAIConfigEnabledRequiresAPIKey (env leakage — see Task 2 finding)
- Frontend: 163 test files / 1292 tests, all green
- Inventory: Go test files per package recorded below; frontend 163 test files (38 storybook portable-story files); harness drives 21 screens.

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
## Task 6 — Assertion quality
## Task 7 — Coverage map
## Task 8 — Harness & Storybook seams
## Task 9 — Synthesis
