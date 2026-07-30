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
## Task 4 — Frontend order-independence & mock hygiene
## Task 5 — Time & timezone dependence
## Task 6 — Assertion quality
## Task 7 — Coverage map
## Task 8 — Harness & Storybook seams
## Task 9 — Synthesis
