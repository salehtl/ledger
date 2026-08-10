# Finding-dispatch report — budget projection gate (Task 21) and transaction window recovery (Task 18)

Date: 2026-08-05. Branch `v2-wip-2026-08-05`, worktree `/root/Coding/ledger/.claude/worktrees/v2`.
Commit: `e7878bd08bade5ce750c335efb1e76f10f1ffea7` (parent `7f8b2e318fb41b14136f4a6866c11c105794fcad`).

## Status: both findings fixed, mutation-tested, wired-and-proven at the screen level. Gate green.

A note on process first, since it happened mid-task: every `Edit`/`Write` call was refused for a
while with *"This subagent's parent bg session hasn't isolated yet"*. I stopped rather than route
around it via Bash file writes, reported the blocker plainly, and did no file changes until the
controller confirmed Bash-authored writes were the sanctioned path for this dispatch (two other
concurrent agents on this wave were already doing the same) and that the guard was fixed at the
session level. All work below was done through Bash (`Edit`/`Write` came back later and were used
for some of it) with `python3` string-replace or quoted heredocs, verified by re-reading and
`tsc --noEmit` after each file, per the controller's explicit caution about mangled heredocs.

---

## Finding 1 (Task 21) — budget summed a stale/incomplete projection and reported it as fact

### The fix

`app/src/screens/budget/source.ts`:
- `BudgetSnapshot` gained `usable: boolean`, the same field name and meaning as
  `currencies/source.ts`'s `CurrencyView.usable`.
- `sqlBudgetSource` now calls `ensureProjection(db)` at construction (mirroring
  `sqlCurrencySource`) and, on every `read()`, checks `readMeta(db)` and
  `projectionIsUsable(db)` **before** touching `txn`/`txn_split`. When either fails, it returns a
  safe all-zero/empty snapshot with `usable: false` and the last known `homeCurrency` (never
  `null` just because the projection is stale) — it never runs the aggregate query.

`app/src/screens/budget/BudgetScreen.tsx`:
- When `!data.usable`, the screen renders one line — *"Your budget is rebuilding after an update.
  Nothing was lost — it will be back once the local sync finishes."* (`testID="budget-rebuilding"`)
  — and nothing else: no bucket cards, no income line, no exclusion counters. The real content only
  renders when `data.usable` is true.

### What the user now sees over an unusable projection

Before: three bucket cards reading `0.00`, an income line reading `0.00`, and every "not counted
yet" counter (missing-rate, unresolved-duplicate, unparsed) also at `0` — a complete, confident-
looking 50/30/20 that was actually computed over nothing. After: a single sentence saying the
budget is rebuilding, with no numbers on screen at all to be misread as real.

### The render path that proves it is wired (not just a helper unit test)

`app/src/screens/budget/BudgetScreen.rn-test.tsx` (new) renders the real `BudgetScreen` component
through `@testing-library/react-native` with a fake `BudgetSource` and asserts, per the two states:
- `usable: true` → `budget-rebuilding` is absent, `"Needs · 50%"` is present.
- `usable: false` (the exact W7/W8 shape from the recritic — buckets zeroed, excluded counters
  zeroed) → `budget-rebuilding` is present, and neither `"Needs · 50%"` nor `/Income context/`
  render.

Mutation proof (production line broken, test observed to fail, line restored):
- `BudgetScreen.tsx`: `{!data.usable ? (` → `{false ? (` — the "unusable" rn-test case failed
  (`budget-rebuilding` never found). Restored, re-verified green.
- `source.ts`: the `if (meta === null || !projectionIsUsable(db)) return unusable(...)` gate
  replaced with `if (false) ...` — 3 of the new `source.test.ts` cases died, one of them via a
  genuine `TypeError: null is not an object (evaluating 'meta.homeCurrency')` (the gate is what
  makes dereferencing `meta` safe in the first place). Restored, re-verified green.

I also caught and fixed a defect-in-waiting: `source.test.ts`'s `setup()` hardcoded
`version=1` in the seeded `projection_meta` row rather than the live `PROJECTION_VERSION`. Once the
gate exists, every one of that file's *other* tests would have silently exercised the "unusable"
path regardless of whether the gate logic was right — a stale-literal instance of the "true by
construction" trap. Fixed to interpolate `PROJECTION_VERSION`, and this is exactly what the new
`refuses to read a stale-version projection` / `refuses to read an incomplete projection` /
`unusable projection with no meta row` tests exist to check independently of that fixture.

### The v3→v4 migration pin

`client/src/replay/projection.test.ts` gained *"a pre-v4 database is migrated by ensureProjection,
and project() backfills exact split home amounts on the repair pass"*: it hand-creates a
`txn_split` table **without** the `amount_home_minor` column at all (not merely `NULL` — the column
does not exist, matching a real device's schema at `PROJECTION_VERSION` 3), and a `projection_meta`
row at version 3, complete. It then asserts `ensureProjection` adds the column (old row's value is
`NULL`, `projectionIsUsable` stays `false` because the version is still stale), and that a
subsequent real `project()` run backfills the column **exactly** (split parts sum to the parent's
frozen home amount) and drops the pre-migration row.

Mutation proof: deleting `projection.ts`'s
`if (!splitColumns.includes("amount_home_minor")) db.exec("ALTER TABLE ...")` line — the exact
mutation the recritic reported as P5, surviving 18/18 — now fails this one new test while the other
18 stay green, reproducing precisely what the recritic measured and closing the gap.

### Exact-money path — untouched

`CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total` and the `exact()` decoder (throws on anything
that isn't `^-?[0-9]+$` text) are byte-for-byte unchanged. The new gate sits *before* that query
runs; it does not touch how the query or its decode work. All eight pre-existing exactness tests in
`source.test.ts` (`2^53`, signed `int64` max, split remainders, etc.) still pass unmodified.

---

## Finding 2 (Task 18) — head-eviction on a forward-only cursor lost scrolled-past rows for good

### The fix

`app/src/lib/transactions.ts`:
- `TxnPageOptions` gained `direction?: "older" | "newer"` (default `"older"`, unchanged behavior).
  `"newer"` flips the keyset comparison (`>` instead of `<`, same `(posted_at, id)` tiebreak) and
  the SQL order (`ASC` instead of `DESC`); it throws if `after` is `null` — a "newer" page recovers
  above a known boundary, it does not start a fresh list.
- `listTransactions` reverses a `"newer"` page back to the list's one true newest-first order before
  returning it, and computes `next` as the cursor of the row **farthest** from the original boundary
  (the newest of the batch) — the correct edge to continue paging upward from, not the nearest edge
  (which would just refetch the same rows forever).
- `prependTxnWindow(previous, newer)` — the evict-**tail** mirror of the existing evict-**head**
  `retainTxnWindow`: `[...newer, ...previous].slice(0, MAX_RETAINED_TXNS)`. The 150-row bound is
  unchanged; only which end pays for it changes with the direction of travel.

`app/src/screens/transactions/TransactionsScreen.tsx`:
- `load()` gained a `"prepend"` mode that calls `source.list(..., { direction: "newer" })` and
  merges via `prependTxnWindow` instead of `retainTxnWindow`.
- `FlatList` gained `onStartReachedThreshold={0.5}` / `onStartReached`, which recomputes the
  recovery cursor as `cursorOf(rows[0])` **fresh on every call** (not a separately-tracked "top
  cursor" state) — self-correcting whether zero rows were ever evicted (the fetch just returns
  none, a safe no-op) or many pages were.

### How scroll-back now recovers evicted rows while the memory bound survives

Nothing about the bound changed: `MAX_RETAINED_TXNS` (150) is still the hard cap, `retainTxnWindow`
still evicts from the head when paging down, and the Phase-0 freeze this bound exists to prevent is
not reintroduced anywhere — `prependTxnWindow` enforces the *same* cap, just trimming the opposite
end. What changed is that eviction is no longer a dead end: scrolling back toward the top triggers
`onStartReached`, which asks SQLite for exactly the rows above the current top of the retained
window (a real, bounded, `LIMIT`-ed query — never the whole table) and prepends them, evicting an
equal-sized page from the tail (the end the user just scrolled away from). Repeated calls walk the
window back up page by page until the original newest row is recovered, then become no-ops.

### The render path that proves it is wired

`app/src/screens/transactions/TransactionsScreen.rn-test.tsx` (new) renders the real
`TransactionsScreen` with a hand-rolled in-memory `TxnSource` (jest-expo has no `bun:sqlite`, so
this is a plain mirror of the keyset semantics `transactions.test.ts` already proves against the
real SQL — its job is only to prove the screen calls it right). There is no `UNSAFE_getByType` in
this project's `@testing-library/react-native` (its `TestInstance` only exposes host elements by
design), but `getByTestId("txn-list")` resolves to the element `FlatList`/`VirtualizedList` spread
*all* of their incoming props onto — `onEndReached`, `onStartReached`, `data`, etc. are present on
`.props` verbatim, confirmed by probing the prop list directly before relying on it. The test
re-queries the element after every interaction (a stale reference would call an old closure
forever, over the initial `cursor`).

Two tests:
1. Scrolls down past `MAX_RETAINED_ROWS` (evicting the newest row from `FlatList`'s own `data`
   prop — not the DOM, which is separately windowed by `FlatList`'s own virtualization and does not
   track eviction/recovery at all), confirms the retained set is exactly
   `all.slice(-MAX_RETAINED_ROWS)`, scrolls back up, and confirms the retained set is exactly
   `all.slice(0, MAX_RETAINED_ROWS)` again — full recovery, not "some rows came back".
2. Confirms `onStartReached` is a safe no-op on a small, never-evicted list.

Mutation proof: replaced the real `onStartReached` handler in `TransactionsScreen.tsx` with
`() => {}` — the recovery test failed (newest row never returned), the no-op test still passed
(nothing to recover there, correctly distinguishing the two). Restored, re-verified green.

### Mutation score, `lib/transactions.ts` and `lib/transactions.window.test.ts`: 6/6 killed

Each applied to production, suite run, production restored:

| # | mutation | result |
|---|---|---|
| M1 | drop the `rows.reverse()` for `"newer"` | 2 tests failed |
| M2 | `next` boundary always `rows[rows.length-1]` regardless of direction | 1 test failed (a test added specifically because the first attempt at this mutation survived — see below) |
| M3 | comparison operator not flipped for `"newer"` | 3 tests failed |
| M4 | `ORDER BY` not flipped for `"newer"` | 3 tests failed |
| M5 | `prependTxnWindow` evicts head (`slice(-MAX)`) instead of tail | 1 test failed |
| M6 | `prependTxnWindow` appends instead of prepends | 2 tests failed |

M2 is reported honestly as a near-miss: my first round-trip test recomputes the recovery cursor
from `rows[0]` on every call (exactly what the screen does), so it never actually consumes
`listTransactions`'s `next` field for the `"newer"` direction, and the mutation survived at 36/36.
Per the dispatch's instruction to check the test rather than lower the bar, I added a direct,
independent assertion — *"the `next` cursor of a `"newer"` page points at the NEWEST row returned,
not the one nearest the original boundary"* — which measures the relationship
`page.next === cursorOf(page.rows[0])` on its own terms. That killed M2 cleanly. Left in place:
even though the screen doesn't consume this field today (by design — recomputing from `rows[0]` is
self-correcting and can't desync from actual eviction), the field is part of the public `TxnPage`
contract and a future caller could reasonably rely on it, so it stays measured rather than merely
written.

### Exact-money path

Not touched by this finding — no money field appears in the pagination/window logic. The
`transactions.ts` window code operates on whole `Txn` rows.

---

## Gate

Ran at commit `e7878bd08bade5ce750c335efb1e76f10f1ffea7`:

```
go clean -testcache && bash scripts/v2-check.sh > /tmp/fd-gate2.log 2>&1; echo "GATE_EXIT=$?"
GATE_EXIT=0
```

Captured the script's own exit code directly (not through a pipe). Log tail: `v2-check: OK
(go + client + app + conformance)`. All Go packages `ok` (including `internal/v2/ingest`,
`internal/v2/origin`, `internal/v2/tmpl` — the other concurrent agent's areas, green at the time
this ran), client `bun test`: 2351 pass / 0 fail across 35 files, app `bun test src`: 591 pass / 0
fail across 40 files, jest (`*.rn-test.tsx`): 18 suites / 92 tests, all pass. `fx.test.ts` did not
trip its 5s limit on this run.

An earlier attempt at this gate was launched in the background and the turn ended before it
finished, so no completion notification arrived; per the controller's instruction I re-ran it
fresh in the foreground (`timeout: 600000`) rather than trust the orphaned run, and that is the run
reported above.

### A real, in-scope regression the gate caught and I fixed

`app/src/app/RuntimeNavigation.rn-test.tsx` (not one of my three declared paths, but broken by my
own `BudgetSnapshot.usable` addition) hand-builds a fake `AppRuntime` cast `as unknown as
AppRuntime`, which bypasses TypeScript checking of the object literal. Its `budget.read()` stub
never set `usable`, so it evaluated as `undefined` — falsy — and the new gate rendered the
"rebuilding" notice instead of the fixture's intended warming state, failing the integration test's
`getByTestId("budget-warming")` assertion at the point it navigates to Budget. This is a direct,
mechanical consequence of changing a shared interface, not a merge collision with a concurrent
agent's edits (I grepped for every other hand-rolled `BudgetSnapshot`-shaped fixture in `app/src`;
this was the only one). Fixed by adding `usable: true` to that one stub line. Re-ran that test file
alone, then the full jest suite (18/18, 92/92) before including it in the gate run above.

## Files touched

- `app/src/screens/budget/source.ts` — usable gate.
- `app/src/screens/budget/BudgetScreen.tsx` — rebuilding disclosure.
- `app/src/screens/budget/source.test.ts` — `PROJECTION_VERSION` fixture fix + 4 new tests.
- `app/src/screens/budget/BudgetScreen.rn-test.tsx` (new) — render-path proof.
- `app/src/screens/transactions/TransactionsScreen.tsx` — `onStartReached` wiring.
- `app/src/screens/transactions/TransactionsScreen.rn-test.tsx` (new) — render-path proof.
- `app/src/lib/transactions.ts` — `"newer"` direction, `prependTxnWindow`.
- `app/src/lib/transactions.test.ts` — recovery/round-trip tests against real SQL.
- `app/src/lib/transactions.window.test.ts` — `prependTxnWindow` unit tests.
- `client/src/replay/projection.test.ts` — v3→v4 migration pin.
- `app/src/app/RuntimeNavigation.rn-test.tsx` — one-line fixture fix (see above).
