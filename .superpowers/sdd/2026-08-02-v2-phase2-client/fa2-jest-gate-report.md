# Jest gate coverage report

## Summary

Closed the second ungated test category in `scripts/v2-check.sh`: the 13 React Native mounted-component tests (`*.rn-test.tsx` files) that run under jest were landing with zero build gate coverage, despite already being in the suite and executed locally during development.

## The coverage hole

- **File:** `scripts/v2-check.sh`, line 114 (formerly)
- **What was running:** `(cd app && bun run typecheck && bun test)` — only the bun test suite
- **What was NOT running:** `*.rn-test.tsx` files (13 tests, 73 total with jest), which require jest not bun
- **Failure mode:** Code shipping with nothing to catch it, identical shape to the first hole (commit `2483918`)

## The fix

Changed line 114 to:
```bash
(cd app && bun run typecheck && bun run test:all)
```

This uses the existing `test:all` script in `app/package.json` (`"test:all": "bun test src && jest"`), keeping the package.json as the single source of truth for "all app tests."

Added a comment block (lines 111-116) explaining why jest coverage matters:
- Names `RuntimeNavigation.rn-test.tsx` as the test that verifies the app wires into itself
- Explains the difference between `bun test` (covers `*.test.ts`) and jest (covers `*.rn-test.tsx`)
- Records that this is a second hole of the same shape

## Proof the gate has teeth

Deliberately broke an assertion in `RuntimeNavigation.rn-test.tsx` (changed `"Transactions"` to `"WrongText"`):
- **With broken test:** gate exited 1, jest suite reported `1 failed, 72 passed, 73 total`
- **With fixed test:** gate exited 0, all suites passed

Tree state verified at fix: only `scripts/v2-check.sh` was modified.

## Test coverage found by the new step

- **13 test suites passed** (when green): HaltBanner, Theme, RuntimeNavigation, QuarantineScreen, OnboardingShell, SettingsScreen, RewardBanner, useReviewQueue, and others
- **73 total jest tests** run by `test:all` after the bun suite completes
- **Typical jest runtime:** 14s for the full mounted-render suite

## Final gate performance

With jest included: `go clean -testcache && bash scripts/v2-check.sh` exits 0 (all suites pass).

The combined gate (Go + client + app/bun + app/jest + conformance) runs to completion and reports green.
