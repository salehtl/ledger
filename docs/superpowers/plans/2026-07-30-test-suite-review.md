# Test Suite Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit the entire test surface (Go tests, frontend vitest, Storybook regression net, browser harness) for hermeticity, order-independence, time-dependence, assertion quality, coverage gaps, and seam gaps — fixing clear-cut defects as they are confirmed and recording everything else in a prioritized findings report.

**Architecture:** Nine sequential audit passes, each with a concrete measurement method (a command whose output proves or refutes a defect), a fix step for confirmed clear-cut defects, and a findings-report append for judgment calls. Infrastructure hazards (env leakage, order dependence) are audited first because they invalidate later measurements. Every fix follows the red→green discipline: a defect must be *demonstrated* (failing run, surviving mutation, failing shuffle seed) before code changes.

**Tech Stack:** Go 1.22+ (`go test`, `-race`, `-shuffle`, `-coverprofile`), Bun + vitest 2.1.9 (jsdom, single-fork), Storybook portable stories, Playwright harness (`frontend/harness/`).

## Global Constraints

- **Working directory:** ALL work happens in the worktree `/root/Coding/ledger/.claude/worktrees/category-delete-persistence` on branch `worktree-category-delete-persistence`. Subagents spawn in `/root/Coding/ledger` (the main checkout) — every subagent MUST `cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence` as its first action and verify `git branch --show-current` prints `worktree-category-delete-persistence` before touching anything. If the branch differs, STOP and report.
- **Never touch production.** The service on `:8080` and `/var/lib/ledger` are live. The harness uses scratch ports `:8099`/`:5199` and `/tmp/ledger-ui-harness` only. Never run `./ledger` with a default/empty config (it binds `:8080` and opens `/var/lib/ledger`).
- **vitest stays single-fork.** `vite.config.ts` pins `fileParallelism: false` + `singleFork` because the sandbox blocks vitest's worker spawning (parallel mode silently runs only the first file). Never re-enable parallelism.
- **Known environment quirk:** `LEDGER_AI_API_KEY` is exported in this sandbox. Until Task 2 lands, `internal/config TestAIConfigEnabledRequiresAPIKey` fails for that reason alone — it is the *subject* of Task 2, not background noise.
- **Money is `int64` fils.** Never introduce floats into money assertions.
- **Frontend commands run from `frontend/`** with Bun: `bun install`, `bun run test`, `bunx vitest run …`. Go commands run from the worktree root.
- **Each task commits its own changes** (code + its findings-report section) before the task is considered done.
- **Dist rebuilds:** test-only changes do NOT require rebuilding `internal/web/dist`. Only if a task changes non-test frontend source (`frontend/src/**` excluding `*.test.*`/`*.stories.*`) must the final task rebuild the embedded dist (`cd frontend && bun run build`) and commit it.
- **No speculative fixes.** A defect needs a demonstrated failure (red run, surviving mutation, failing seed) before code changes. Anything not clear-cut goes in the findings report instead.
- **Findings report:** `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` — created in Task 1, appended by every task under its own `##` section, finalized in Task 9. Findings entries use this shape:

```markdown
### [SEVERITY: high|medium|low] Short title
- **Where:** file:line (or package/dir)
- **What:** one-paragraph statement of the defect or gap
- **Evidence:** the command run and the output that demonstrates it
- **Disposition:** FIXED in <commit> | DEFERRED (reason)
```

---

### Task 1: Baseline runs and findings scaffold

**Files:**
- Create: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: the findings file all later tasks append to; a recorded green/red baseline later tasks compare against.

- [ ] **Step 1: Enter the worktree and verify the branch**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
git branch --show-current   # MUST print: worktree-category-delete-persistence
git log --oneline -3        # sanity: recent commits mention category delete / target guard
```

- [ ] **Step 2: Install frontend deps (fresh worktrees have no node_modules)**

```bash
cd frontend && bun install
```

- [ ] **Step 3: Run the Go baseline and capture it**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
go test ./... 2>&1 | tail -30
```

Expected: every package `ok` EXCEPT `internal/config` failing `TestAIConfigEnabledRequiresAPIKey` (the sandbox exports `LEDGER_AI_API_KEY`; Task 2 fixes this). Any OTHER failure is a pre-existing red — record it in the findings file and STOP the task for triage; do not proceed on a broken baseline.

- [ ] **Step 4: Run the frontend baseline and capture it**

```bash
cd frontend && bun run test 2>&1 | tail -6
```

Expected: `163 passed` test files (count may have drifted slightly; record the actual numbers). Any failure: same rule as Step 3.

- [ ] **Step 5: Create the findings scaffold**

Write `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md`:

```markdown
# Test Suite Review — Findings (2026-07-30)

Baseline at <HEAD sha>:
- Go: <N> packages, all ok except internal/config TestAIConfigEnabledRequiresAPIKey (env leakage — see Task 2 finding)
- Frontend: <N> files / <N> tests, all green
- Inventory: Go test files per package recorded below; frontend 163 test files (38 storybook portable-story files); harness drives 21 screens.

## Task 2 — Go hermeticity
## Task 3 — Go order/race/flake
## Task 4 — Frontend order-independence & mock hygiene
## Task 5 — Time & timezone dependence
## Task 6 — Assertion quality
## Task 7 — Coverage map
## Task 8 — Harness & Storybook seams
## Task 9 — Synthesis
```

Fill in the real numbers from Steps 3–4 and this per-package inventory (regenerate, don't trust this snapshot):

```bash
for d in $(go list ./... | sed 's|^ledger/||'); do
  src=$(ls $d/*.go 2>/dev/null | grep -v _test | wc -l); tst=$(ls $d/*_test.go 2>/dev/null | wc -l)
  echo "$d: $src src, $tst test"
done
```

Note in the inventory: `cmd/ledger` (1 src, 0 tests) and `internal/web` (embed shim, 0 tests) are the only test-free packages.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "docs(review): test-suite review baseline and findings scaffold"
```

---

### Task 2: Go hermeticity — env leakage and silent skips

**Files:**
- Modify: `internal/config/config_test.go`
- Modify: `internal/store/insights_test.go:66`
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 2 section)

**Interfaces:**
- Consumes: findings file from Task 1.
- Produces: a hermetic `go test ./internal/config/` that passes regardless of the shell's env; later tasks (3, 5, 9) rely on a fully green `go test ./...` with no known false-failures.

**Background for the implementer:** `internal/config.Load` applies env overrides after TOML parsing. The pattern at `internal/config/config.go:139` is `if v := os.Getenv("LEDGER_AI_API_KEY"); v != "" { cfg.AI.APIKey = v }` — an empty string means "unset". The same pattern exists for `LEDGER_IMAP_APP_PASSWORD` (line ~137) and the VAPID keys. Validation at line ~176 rejects `ai.enabled` without a key. The sandbox exports `LEDGER_AI_API_KEY`, so `TestAIConfigEnabledRequiresAPIKey` inherits a key and false-fails.

- [ ] **Step 1: Demonstrate the failure (red)**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
go test ./internal/config/ -run TestAIConfigEnabledRequiresAPIKey
```

Expected: FAIL with `expected error when AI enabled but no API key`. Also demonstrate the inverse works:

```bash
LEDGER_AI_API_KEY= go test ./internal/config/ -run TestAIConfigEnabledRequiresAPIKey
```

Expected: PASS. This pair is the evidence for the findings entry.

- [ ] **Step 2: Audit the whole file for the same class**

Read `internal/config/config_test.go` end to end. List every test that calls `Load` (or otherwise reaches the env-override block). Each of those inherits ALL of: `LEDGER_LISTEN`, `LEDGER_DATA_DIR`, `LEDGER_IMAP_*`, `LEDGER_AI_API_KEY`, `LEDGER_VAPID_*` — check `config.go`'s override block for the authoritative list of variable names.

- [ ] **Step 3: Write the fix — a shared env-neutralizing helper**

Add to `internal/config/config_test.go` (adjust the variable list to exactly match the override block you read in Step 2):

```go
// clearLedgerEnv neutralizes every env override Load consults, so tests
// assert on the TOML they wrote rather than on whatever the invoking shell
// happens to export (the dev sandbox exports LEDGER_AI_API_KEY, which made
// TestAIConfigEnabledRequiresAPIKey fail on some machines and pass on others).
// t.Setenv also registers cleanup, restoring the caller's env afterwards.
func clearLedgerEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		// keep in lockstep with the os.Getenv calls in config.go
		"LEDGER_LISTEN", "LEDGER_DATA_DIR",
		"LEDGER_IMAP_HOST", "LEDGER_IMAP_USER", "LEDGER_IMAP_APP_PASSWORD",
		"LEDGER_AI_API_KEY",
		"LEDGER_VAPID_PRIVATE", "LEDGER_VAPID_PUBLIC",
	} {
		t.Setenv(k, "")
	}
}
```

Call `clearLedgerEnv(t)` as the first line of every test identified in Step 2. Tests that deliberately test env overrides (if any exist) call `clearLedgerEnv(t)` first and then `t.Setenv` the specific variable they exercise.

- [ ] **Step 4: Verify green under both environments**

```bash
go test ./internal/config/
LEDGER_AI_API_KEY=sk-fake-123 LEDGER_LISTEN=1.2.3.4:9 go test ./internal/config/
```

Expected: PASS both times. The second invocation proves hermeticity against hostile env, not just absent env.

- [ ] **Step 5: Fix the silent-skip hazard in insights_test.go**

`internal/store/insights_test.go:66` reads:

```go
if sid == 0 {
    t.Skip("no Salary income category in seed; adjust to an income category name present in seedCategories")
}
```

`Salary` IS in `seedCategories` (`internal/store/categories.go`, Kind `income`), so today the skip never fires — but if seed drift ever removed it, the test would silently vanish instead of failing. Demonstrate the hazard: temporarily rename `"Salary"` to `"SalaryX"` in the test's lookup loop, run `go test ./internal/store/ -run <that test's name> -v`, observe `SKIP` (a silently passing suite). Revert. Then replace the skip with a failure:

```go
if sid == 0 {
    t.Fatal("seed no longer contains a Salary income category — update this test's fixture lookup")
}
```

Re-run the same `-v` invocation on the unmodified code: PASS (not SKIP).

- [ ] **Step 6: Audit remaining skips and env-gates**

`grep -rn "t.Skip" --include=*_test.go internal/ cmd/` — expect `internal/ingest/imap_integration_test.go:22` (gated on `LEDGER_TEST_IMAP_*`, a live-network integration test: legitimate, record as intentional in findings) and nothing else after Step 5. Any other conditional skip: apply the Step 5 treatment or record why it's legitimate.

- [ ] **Step 7: Full Go run — the suite must now be green with zero exceptions**

```bash
go test ./... 2>&1 | grep -v "^ok" ; echo "exit=$?"
```

Expected: only `no test files` lines for cmd/ledger and internal/web.

- [ ] **Step 8: Write findings entries and commit**

Findings entries: (1) env leakage in config tests [FIXED], (2) silent-skip hazard [FIXED], (3) imap integration skip [intentional, no action].

```bash
git add internal/config/config_test.go internal/store/insights_test.go docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "test(go): make config tests env-hermetic; fail loudly on seed drift instead of skipping"
```

---

### Task 3: Go order-independence, races, and flake probes

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 3 section)
- Modify: only files where a demonstrated failure requires it (see steps)

**Interfaces:**
- Consumes: green baseline from Task 2.
- Produces: recorded proof the Go suite is race-free, order-independent, and that its two sleep-based tests hold up under repetition; fixes for anything demonstrated otherwise.

- [ ] **Step 1: Race detector over everything**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
go test ./... -race -count=1 2>&1 | tail -20
```

Expected: all ok (slower — allow up to 10 minutes; use a 600000ms timeout). Any `WARNING: DATA RACE` is a high-severity finding: capture the full race report into the findings file, then fix the race at its source (usually a missing mutex or an unsynchronized test double), re-run the failing package with `-race -count=5` to confirm.

- [ ] **Step 2: Shuffle test order, two seeds**

```bash
go test ./... -shuffle=on 2>&1 | tail -5
go test ./... -shuffle=1234 2>&1 | tail -5
```

Expected: all ok. On failure the output prints the seed (`-test.shuffle 1234`); record it in findings, reproduce with `go test ./<package>/ -shuffle=<seed> -v`, identify the leaked state (package-level var, shared temp dir, seeded DB reuse), fix at the source, verify the exact failing seed now passes plus one fresh `-shuffle=on` run.

- [ ] **Step 3: Flake-probe the two sleep-based tests**

The suite has exactly two `time.Sleep` calls in tests: `internal/ingest/ingest_test.go:228` (30ms) and `internal/server/categorize_job_test.go:41` (5ms in what is likely a poll loop). Find the enclosing test names:

```bash
awk 'NR<=228 && /^func Test/ {name=$2} END {}' internal/ingest/ingest_test.go
grep -n "^func Test" internal/ingest/ingest_test.go | awk -F: '$1 < 228' | tail -1
grep -n "^func Test" internal/server/categorize_job_test.go | awk -F: '$1 < 41' | tail -1
```

Then hammer each:

```bash
go test ./internal/ingest/ -run '<TestName>' -count=20
go test ./internal/server/ -run '<TestName>' -count=20 -race
```

Expected: PASS 20/20. If either flakes: the fix is condition-based waiting, not a longer sleep — replace the fixed sleep with a poll loop that checks the actual condition with a deadline, e.g.:

```go
deadline := time.Now().Add(2 * time.Second)
for !condition() {
    if time.Now().After(deadline) {
        t.Fatal("condition not reached within 2s")
    }
    time.Sleep(5 * time.Millisecond)
}
```

Re-run `-count=20` to confirm. If it passes 20/20 as-is, record both probes in findings as verified-stable [no action], and note the sleeps as acceptable (a 30ms settle after an async kick is a poll, not a race guess) — do NOT rewrite passing tests.

- [ ] **Step 4: Findings and commit**

```bash
git add -A docs/ internal/ 2>/dev/null
git commit -m "test(go): race/shuffle/flake audit findings (+ fixes if any were demonstrated)"
```

(If nothing needed fixing, the commit contains only the findings section — that's the expected outcome.)

---

### Task 4: Frontend order-independence and mock hygiene

**Files:**
- Modify: `frontend/vite.config.ts` (likely: add `restoreMocks: true`)
- Modify: individual test files only where a demonstrated failure requires it
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 4 section)

**Interfaces:**
- Consumes: green baseline from Task 1.
- Produces: a suite proven order-independent under shuffled seeds; systemic mock restoration in vitest config so file order can never decide correctness again.

**Background for the implementer:** All 163 files share one process (`singleFork`). `unstubGlobals: true` was added recently after ~20 files' `vi.stubGlobal("fetch", …)` leaked across files and a suite *reordering alone* broke four unrelated ProjectsFlow tests. That covered `stubGlobal` — but `vi.spyOn` (23 files) and `vi.useFakeTimers` (6 files: `Toast.test.tsx`, `lib/pausableTimeout.test.ts`, `hooks/useLiveEvents.test.ts`, `ui/Dialog.test.tsx`, `lib/liveInvalidation.test.ts`, `recurring/RecurringScreen.test.tsx`) are separate leak channels with only per-file, inconsistently-applied cleanup. It has been verified that **no test file combines `beforeAll` with `spyOn`**, so vitest's `restoreMocks: true` (which restores spies after each test) is safe to apply globally.

- [ ] **Step 1: Measure — shuffled runs, three seeds**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence/frontend
bunx vitest run --sequence.shuffle --sequence.seed=1 2>&1 | tail -5
bunx vitest run --sequence.shuffle --sequence.seed=42 2>&1 | tail -5
bunx vitest run --sequence.shuffle --sequence.seed=2026 2>&1 | tail -5
```

Record pass/fail per seed in findings. Every failure is a real defect *somewhere* (the failing test is the victim, rarely the culprit): note which file failed and which files ran before it in that seed's order (the reporter prints files as they run).

- [ ] **Step 2: Audit fake-timer cleanup**

For each of the 6 `useFakeTimers` files, check for `vi.useRealTimers()` in an `afterEach`/cleanup path:

```bash
for f in src/components/Toast.test.tsx src/lib/pausableTimeout.test.ts src/hooks/useLiveEvents.test.ts src/components/ui/Dialog.test.tsx src/lib/liveInvalidation.test.ts src/screens/recurring/RecurringScreen.test.tsx; do
  echo "== $f"; grep -n "useFakeTimers\|useRealTimers" "$f"
done
```

Any file that enables fake timers without restoring them leaks frozen time into every later file — `waitFor` in a later file then times out mysteriously. For each offender add:

```typescript
afterEach(() => { vi.useRealTimers(); });
```

(Or fold into an existing afterEach.) This is a clear-cut mechanical fix even without a caught seed — the leak is deterministic; note in findings which files were missing it.

- [ ] **Step 3: Apply systemic spy restoration**

In `frontend/vite.config.ts`, extend the block that already carries `unstubGlobals` (keep its comment, append to it):

```typescript
    unstubGlobals: true,
    // Same reasoning for spies: 23 files vi.spyOn(api, …) and only some
    // restore. No file spies in beforeAll (verified), so per-test restoration
    // is safe. mocks created with vi.fn() in module scope are untouched.
    restoreMocks: true,
```

- [ ] **Step 4: Full verification — straight and shuffled**

```bash
bun run test 2>&1 | tail -4
bunx vitest run --sequence.shuffle --sequence.seed=1 2>&1 | tail -4
bunx vitest run --sequence.shuffle --sequence.seed=42 2>&1 | tail -4
bunx vitest run --sequence.shuffle --sequence.seed=2026 2>&1 | tail -4
```

Expected: all green, including any seed that failed in Step 1. If `restoreMocks` itself breaks a test (a test depending on a spy installed by an *earlier test in the same file* — itself a defect), fix that test to install its own spy; record it.

If a Step 1 seed failure persists after Steps 2–3, root-cause it individually: re-run that seed, bisect the file order (run the failing file preceded by suspected polluters: `bunx vitest run <polluter> <victim>`), fix the leak at its source. Do not mark this task done with any known-failing seed.

- [ ] **Step 5: Findings and commit**

```bash
git add frontend/vite.config.ts frontend/src docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "test(frontend): systemic mock/timer restoration; prove order-independence under shuffled seeds"
```

---

### Task 5: Time and timezone dependence

**Files:**
- Modify: individual test files only where a demonstrated failure requires it
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 5 section)

**Interfaces:**
- Consumes: hermetic, order-independent suites from Tasks 2–4.
- Produces: proof both suites pass at extreme UTC offsets; a documented list of tests whose expectations derive from the wall clock without clock injection (date-passage hazards).

**Background for the implementer:** 44 Go test files and 56 frontend test files hardcode `2026-…` dates. That's fine when the code under test receives an injected clock (`store.SetNow` exists and is used by 6 Go test files; frontend has `vi.setSystemTime`). It's a time bomb when a test compares a hardcoded date against `time.Now()`/`new Date()` — it passes today and fails when the real date crosses the fixture. TZ shifts surface the same class cheaply: a UTC+14 vs UTC−9 run moves "today" by a calendar day for part of every day.

- [ ] **Step 1: Both suites at UTC+14 and UTC−9**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
TZ=Pacific/Kiritimati go test ./... 2>&1 | grep -v "^ok" | head -20
TZ=America/Anchorage  go test ./... 2>&1 | grep -v "^ok" | head -20
cd frontend
TZ=Pacific/Kiritimati bun run test 2>&1 | tail -4
TZ=America/Anchorage  bun run test 2>&1 | tail -4
```

Record all four outcomes. Each failure: reproduce, identify whether the test or the production code is TZ-sensitive (a production bug found here is a HIGH finding — money attributed to the wrong month is exactly the class this app cannot afford), fix the test via clock injection (`SetNow` in Go — see `internal/store/targets_test.go` for the established pattern; `vi.useFakeTimers({ now: new Date("2026-07-15T12:00:00Z") })` + `vi.useRealTimers()` cleanup in vitest), or file the production bug as a finding with a red test committed as skipped-with-reason ONLY if the fix is too large for this pass.

- [ ] **Step 2: Date-passage audit of wall-clock modules**

The modules whose production code reads the wall clock AND whose tests hardcode dates are the hazard surface. For Go, the priority list: `internal/budget` (month progress), `internal/server/envelopes.go` + `internal/store/targets.go` (current-month math), `internal/recur` + `internal/server/scheduled.go` (next_due / missed), `internal/store/insights.go` (rolling windows). For each package: read its tests and answer one question — *"does any assertion's expected value depend on what today's date is?"* Tests using `SetNow`/fixture-relative dates: safe, note as such. Tests where a hardcoded `next_due: "2026-08-02"` meets production `time.Now()` (e.g., "due in N days" computed from the real today): date-passage hazard.

For the frontend, same question over the test files of: `lib/envelope.ts`, `lib/recurring.ts`, `lib/reports.ts`, `lib/insights.ts`, `lib/projectMath.ts` and the screens that render "upcoming"/"due" copy (`recurring/`, `plan/`).

- [ ] **Step 3: Fix demonstrated hazards, list the rest**

For each hazard where you can demonstrate failure by simulating a future date (Go: the package must accept an injected clock — if it has `SetNow`, write the red test at a simulated date, watch it fail, fix the test to derive expectations from the injected date; frontend: `vi.setSystemTime(new Date("2026-12-15"))`, watch it fail, fix): fix it. Hazards in code with *no* injection seam are findings [DEFERRED: needs a clock seam], not drive-by refactors — record the exact file:line and what seam is missing.

- [ ] **Step 4: Verify, findings, commit**

Re-run all four Step 1 invocations green, plus the default-TZ suites.

```bash
git add -A frontend/src internal/ docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "test: timezone-proof both suites; audit and fix date-passage hazards"
```

---

### Task 6: Assertion quality — can these tests fail?

**Files:**
- Modify: test files where a surviving mutation demands a new/strengthened test
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 6 section)

**Interfaces:**
- Consumes: stable suites from Tasks 2–5.
- Produces: a list of assertion-free and mock-only tests; mutation-sampling results over the core money/logic modules with new tests for every surviving mutation.

- [ ] **Step 1: Find assertion-free frontend tests**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence/frontend
grep -rn "it(\|test(" src --include="*.test.ts" --include="*.test.tsx" -A 30 \
  | awk '/it\(|test\(/{name=$0; count=0} /expect\(/{count++} /^--$/{if(count==0 && name) print name; name=""}' | head -40
```

(The awk is a heuristic — verify each hit by reading the test before recording it. `src/test/storybook.test.tsx` asserts only `firstChild !== null` by DESIGN — it's a does-it-render regression net, not an assertion gap; note it as intentional.) Every confirmed assertion-free test: strengthen it with a real behavioral assertion, or if the render alone is genuinely the contract, add an explicit comment saying so; record in findings.

- [ ] **Step 2: Find mock-only tests**

```bash
grep -rln "toHaveBeenCalled" src --include="*.test.*" | while read f; do
  calls=$(grep -c "toHaveBeenCalled" "$f"); others=$(grep -c "expect(" "$f")
  echo "$f: $calls mock-asserts of $others total expects"
done | sort -t: -k2 -rn | head -15
```

For files where mock-asserts dominate, read them and ask: does anything assert *observable behavior* (rendered output, returned value, stored state) rather than that a function was invoked? A test that only proves "the mock was called" tests the wiring, not the behavior — legitimate for pure dispatch glue, a gap for logic. Record each verdict; strengthen the clear gaps (assert on what the user/API would observe).

- [ ] **Step 3: Mutation-sample the core logic (bounded)**

Target modules and three hand-picked mutations each. Protocol per mutation: apply the edit to production source → run ONLY that module's tests → expect ≥1 failure → revert the edit (`git checkout -- <file>`) → confirm tests pass again. A mutation NO test catches is a coverage gap: write the missing test (it must fail against the mutant, pass against real code — re-apply the mutant to prove it, then revert).

| Module | Tests to run | Mutations (pick 3 per module of this kind) |
|---|---|---|
| `internal/budget` | `go test ./internal/budget/` | flip a `>=` to `>` in a bucket threshold; swap need/want percentage application; make month-progress return 0 |
| `internal/categorize` | `go test ./internal/categorize/` | invert the priority comparison in rule ordering; make `contains` matching case-sensitive; skip the confidence-threshold check |
| `frontend/src/lib/money.ts` | `bunx vitest run src/lib/money.test.ts` | drop the /100 fils→AED conversion in one formatter; flip a sign; break thousands separation |
| `frontend/src/lib/scope.ts` | `bunx vitest run src/lib/scope.test.ts` | invert one date-range boundary (inclusive→exclusive); swap month start/end |
| `frontend/src/lib/envelope.ts` | `bunx vitest run src/lib/envelope.test.ts` | flip the sign of one balance contribution; treat a zero assignment as blocking/nonblocking wrongly; break the RTA sum |
| `frontend/src/lib/transactions.ts` | `bunx vitest run src/lib/transactions.test.ts` | invert one filter predicate; drop the direction check in a sum |

(If a listed test file doesn't exist under exactly that name, `ls src/lib/*.test.ts` and use the co-located test for that module — the lib convention guarantees one. If a module truly has no test file, that itself is a HIGH finding.)

**Budget:** cap at ~5 minutes per mutation. Record every mutation in findings as CAUGHT or SURVIVED; every SURVIVED gets a new test in the same step. A module surviving >2 of its 3 mutations is a HIGH finding on its own.

- [ ] **Step 4: Verify the full suites are still green**

```bash
go test ./... 2>&1 | grep -v "^ok" | grep -v "no test files"; cd frontend && bun run test 2>&1 | tail -3
```

CRITICAL: also `git diff --stat` and confirm NO production source file is modified — mutations must all be reverted; only test files and the findings doc may show changes.

- [ ] **Step 5: Findings and commit**

```bash
git add frontend/src internal/ docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "test: assertion-quality audit — strengthen weak tests caught by mutation sampling"
```

---

### Task 7: Coverage map

**Files:**
- Modify: `frontend/package.json` (+ lockfile) — add `@vitest/coverage-v8`
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 7 section)

**Interfaces:**
- Consumes: stable suites.
- Produces: per-package Go coverage, per-directory frontend coverage, and a top-10 uncovered-risk list in the findings doc. Numbers are for *finding gaps*, not for chasing — no test is written in this task.

- [ ] **Step 1: Go coverage**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
go test ./... -coverprofile=/tmp/claude-0/-root-Coding-ledger/6c0ff7e5-cdce-4509-9684-430f3ddff7cc/scratchpad/cover.out -covermode=atomic 2>&1 | grep -E "coverage|FAIL"
go tool cover -func=/tmp/claude-0/-root-Coding-ledger/6c0ff7e5-cdce-4509-9684-430f3ddff7cc/scratchpad/cover.out | grep -v "100.0%" | sort -t: -k3 | head -40
```

Record per-package percentages. Then extract the 0%-covered exported functions in the risk-bearing packages (`parse`, `store`, `server`, `importer`, `budget`):

```bash
go tool cover -func=/tmp/claude-0/-root-Coding-ledger/6c0ff7e5-cdce-4509-9684-430f3ddff7cc/scratchpad/cover.out | awk '$3=="0.0%" {print}' | grep -E "parse|store|server|importer|budget"
```

- [ ] **Step 2: Frontend coverage**

```bash
cd frontend
bun add -d @vitest/coverage-v8@2.1.9    # must match installed vitest 2.1.9 exactly
bunx vitest run --coverage.enabled --coverage.reporter=text-summary --coverage.reporter=text 2>&1 | tail -60
```

Record the summary plus the per-directory table for `src/lib`, `src/screens`, `src/components`, `src/hooks`, `src/api`. Note: this dev-dependency lives only in this worktree's `node_modules` until the branch merges and the main checkout re-runs `bun install` (known parallel-worktree trap — put this in the findings and the eventual PR description).

- [ ] **Step 3: Interpret into a top-10 risk list**

For the findings doc, rank uncovered areas by (money-correctness impact × change frequency), not by raw percentage. Known structural gaps to check against the data: `cmd/ledger` CLI dispatch (0 tests — is `os.Args[1]` routing to import/vapid-keys covered anywhere?), `internal/parse/reprocess.go` paths, SSE hub (`server/events`), push. For the frontend: hooks and gesture-heavy components rely on the harness — flag anything below ~50% that is NOT harness-covered (cross-reference Task 8's map when both exist; if Task 8 hasn't run yet, mark "harness coverage TBD").

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/bun.lock* docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "test: coverage map for both suites; add @vitest/coverage-v8 dev dep"
```

---

### Task 8: Harness and Storybook seams

**Files:**
- Modify: `frontend/harness/nav.mjs` (add entries for reachable-but-unmapped screens)
- Create: missing `*.stories.test.tsx` colocated files
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (Task 8 section)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent audit).
- Produces: a screen→harness coverage map; nav entries for every reachable unmapped screen, verified by an actual `shoot.mjs` run; a complete 1:1 stories↔stories-test net.

- [ ] **Step 1: Build the screen→harness map**

`frontend/harness/nav.mjs` declares 21 screens as literal tap sequences; `frontend/src/screens/` holds 54 non-test component files (many are sub-components, not destinations). Enumerate real destinations: read `src/app/AppShell.tsx` (tab set), `nav.mjs` itself, and the settings hub rows (`screens/settings/`). Produce a table in the findings doc: destination | harness id (or NONE) | how a user reaches it. Sheets are separate: `harness/sheets.mjs` / `probe.mjs` — list every Dialog/sheet component (`grep -rln "Dialog" src/screens src/components --include="*.tsx" | grep -v test | grep -v stories`) against what those scripts open.

- [ ] **Step 2: Add nav entries for reachable unmapped destinations**

For each destination reachable by taps but absent from `nav.mjs`: add an entry following the existing patterns (`gotoSettingsPage("…")` for settings children; explicit tap sequences elsewhere — read the existing `SCREENS` array first and copy its idioms). Do NOT invent entries for states that need special data (e.g., an empty-DB-only screen) — record those as findings instead.

- [ ] **Step 3: Verify the new entries against the live harness**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence/frontend
harness/stack.sh up          # scratch DB :8099 + vite :5199 — NEVER :8080
ls -l /proc/$(pgrep -f vite | head -1)/cwd   # MUST point into THIS worktree
node harness/shoot.mjs --screens <new-id-1>,<new-id-2>
harness/stack.sh down
```

Expected: each new screen shoots with 0 audit issues (or with issues that are *real findings* about that screen — record them; this harness exists to find exactly that). A nav entry that can't reach its screen is wrong — fix the tap sequence, don't delete the entry.

- [ ] **Step 4: Close the stories↔test net**

The convention (CLAUDE.md): every `X.stories.tsx` has a colocated `X.stories.test.tsx`. Find violations:

```bash
cd frontend/src
for s in $(find . -name "*.stories.tsx"); do t="${s%.stories.tsx}.stories.test.tsx"; [ -f "$t" ] || echo "MISSING: $t"; done
```

For each missing file, create it from the established boilerplate — read one existing example first (e.g., `components/ui/Switch.stories.test.tsx`) and mirror it exactly; the shape is:

```tsx
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import * as stories from "./X.stories";

const composed = composeStories(stories);

describe("X stories", () => {
  for (const [name, Story] of Object.entries(composed)) {
    it(`renders ${name}`, () => {
      const { container } = render(<Story />);
      expect(container.firstChild).not.toBeNull();
    });
  }
});
```

Run each new file. Separately, diff `components/README.md`'s catalog against components that have any stories at all — catalog entries with zero stories are findings [DEFERRED: needs design work], not files to scaffold blindly.

- [ ] **Step 5: Full frontend suite, findings, commit**

```bash
cd frontend && bun run test 2>&1 | tail -3
git add harness/nav.mjs src docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "test(frontend): close harness nav and storybook-net gaps found by the seam audit"
```

---

### Task 9: Synthesis and final verification

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-test-suite-review-findings.md` (executive summary + final state)

**Interfaces:**
- Consumes: every task's findings section and commits.
- Produces: the finished review report and a proven-green final state.

- [ ] **Step 1: Write the executive summary**

At the top of the findings doc, after the baseline block: a summary table (finding | severity | disposition | commit), counts of fixed vs deferred, and a short "what this review means" paragraph: the three biggest residual risks and the recommended next investments (likely candidates based on this plan: clock-injection seams, harness coverage of data-dependent states, cmd/ledger dispatch tests — but write what the actual findings support, not this guess).

- [ ] **Step 2: Final verification battery**

```bash
cd /root/Coding/ledger/.claude/worktrees/category-delete-persistence
go test ./... -race -shuffle=on 2>&1 | tail -5
TZ=Pacific/Kiritimati go test ./... 2>&1 | grep -cv "^ok"
cd frontend
bun run test 2>&1 | tail -3
bunx vitest run --sequence.shuffle --sequence.seed=7 2>&1 | tail -3
TZ=Pacific/Kiritimati bun run test 2>&1 | tail -3
bunx tsc --noEmit && echo "tsc clean"
cd .. && gofmt -l internal/ cmd/ | grep -v "ingest.go\|rates_test.go"; echo "gofmt checked"
```

Every line green (the two grep-excluded files carry pre-existing gofmt drift not owned by this review — leave them; they're a recorded finding). Any red: this task does not complete until it's resolved or explicitly recorded as a deferred finding with a reason.

- [ ] **Step 3: Dist check**

`git log --oneline --name-only <baseline-sha>..HEAD | grep "^frontend/src" | grep -v test | grep -v stories` — if ANY non-test frontend source changed during the review, rebuild and commit the embedded dist:

```bash
cd frontend && bun run build && cd .. && git add -A internal/web/dist && git commit -m "build(ui): rebuild embedded dist after test-suite review fixes"
```

If only test files changed (the expected case), skip — and say so in the summary.

- [ ] **Step 4: Commit the finished report**

```bash
git add docs/superpowers/plans/2026-07-30-test-suite-review-findings.md
git commit -m "docs(review): test-suite review — executive summary and final verification"
```

---

## Self-Review (completed at plan time)

- **Coverage:** hermeticity (T2), isolation/order (T3–T4), time (T5), assertion strength (T6), quantity gaps (T7), cross-layer seams (T8) — the six review dimensions the spec ("full review, everything, report + fix clear defects") implies are each owned by a task; synthesis in T9.
- **Placeholders:** none — every step carries its exact command, code, or a bounded decision rule; the two "find the name first" steps (T3 sleep tests, T6 test filenames) include the command that finds the name.
- **Consistency:** the findings filename, worktree path, branch name, scratch ports, and entry format are identical across all nine tasks; T7↔T8 cross-reference is guarded for either execution order.
