# Transaction Filter Chips — Design

**Date:** 2026-06-17
**Status:** Approved

## Goal

Add dropdown filter chips to the Transactions screen so the single user can
narrow the list by **bucket**, **category**, **direction**, and **source** — all
four dimensions handled through one consistent, intuitive control.

## Background

`frontend/src/screens/Transactions.tsx` today has:

- a status `SegmentedControl` (All / Needs review / Confirmed) that drives the
  server query (`?status=`), and
- a merchant search box that filters the already-loaded rows **client-side**.

The `GET /api/transactions` endpoint returns the **full** period with no
pagination, so the loaded array already holds every row — the same place the
search filter operates. New chip filters therefore also run client-side, instant
and consistent with search.

## Decisions

- **Layout:** dropdown chips. One chip per dimension (`Bucket ▾`, `Category ▾`,
  `Direction ▾`, `Source ▾`). Tapping a chip opens a multi-select checklist.
- **Picker surface:** the existing `ui/Dialog` (bottom-sheet on mobile, centered
  on desktop, with focus-trap + Escape already built in) — same pattern as
  `PeriodSheet`/`CategorizeSheet`. No new anchored-popover/portal machinery.
- **Selection semantics:** multi-select = **OR within a dimension**; **AND across
  dimensions**. A dimension with an empty selection is skipped. Chip filters
  compose with the existing search term (also AND).
- **Status stays as-is.** The `SegmentedControl` remains a primary, server-side
  view toggle above the search box. Chips sit on a row below the search box.
- **Clear:** a "Clear" chip appears at the end of the row only when any filter is
  active and resets everything; each picker also has its own per-dimension Clear.

## Option sources

| Dimension | Values | Labels |
|-----------|--------|--------|
| Bucket    | `need`, `want`, `saving` (fixed) | `BUCKET_LABEL` from `lib/insights.ts` → Needs / Wants / Savings |
| Direction | `debit`, `credit` (fixed) | Spending / Income |
| Category  | active categories from the loaded `categories` query (value = `ID`) | category name |
| Source    | **distinct** `Source` values derived from the loaded rows (dynamic: `email`, `import`, `ai`, `heuristic`, …) | `sourceLabel()` — known map + prettified fallback |

## Components & data flow

- **`lib/transactions.ts`** (extend): add the `TxnFilters` type, `EMPTY_FILTERS`,
  pure `applyTxnFilters(rows, filters)`, `filtersActive(filters)`, and
  `sourceLabel(source)`. Keeping the filter logic as pure functions here makes it
  unit-testable independent of React.
- **`components/transactions/FilterChips.tsx`** (new): renders the chip row,
  owns only the local "which picker is open" state, and renders the `Dialog`
  checklist for the open dimension. Selected values are owned by the parent and
  passed in via `filters` / `onChange`.
- **`screens/Transactions.tsx`** (modify): hold `filters` state
  (`EMPTY_FILTERS`), render `<FilterChips>` below the search input, and fold
  `applyTxnFilters` into the existing `rows` `useMemo` (before the search
  filter). `txnTotals` and the result count already derive from `rows`, so they
  update for free.

## Testing

- `lib/transactions.test.ts`: `applyTxnFilters` — OR within a dimension, AND
  across dimensions, empty filters pass-through, null-category handling;
  `sourceLabel` known + fallback.
- `components/transactions/FilterChips.test.tsx`: opening a picker, toggling a
  value calls `onChange`, active-count badge, per-dimension and global clear.
- `screens/Transactions.test.tsx` (extend): a bucket filter narrows the list;
  bucket + direction is AND; Clear restores.

## Out of scope (YAGNI)

- No URL/localStorage persistence of filter state.
- No server-side filter params (data is already fully loaded).
- No folding status into the chip row.
