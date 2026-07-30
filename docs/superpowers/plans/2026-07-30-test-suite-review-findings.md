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
## Task 3 — Go order/race/flake
## Task 4 — Frontend order-independence & mock hygiene
## Task 5 — Time & timezone dependence
## Task 6 — Assertion quality
## Task 7 — Coverage map
## Task 8 — Harness & Storybook seams
## Task 9 — Synthesis
