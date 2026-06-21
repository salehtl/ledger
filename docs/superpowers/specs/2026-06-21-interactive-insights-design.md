# Interactive Insights — Design

**Date:** 2026-06-21
**Status:** Approved (brainstorming) — ready for implementation plan
**Topic:** Make the Insights page interactive: drill into buckets/categories/merchants to see the transactions behind them, plus a search-and-filter sheet.

## Problem

The Insights page is entirely read-only: a this-month-vs-last summary, top movers, a "where the money went" donut, a category comparison list, and a 6-month trend. You can see *that* a bucket or category totals some amount, but you cannot tap it to see *which transactions* make it up, nor break spending down by merchant, nor search/filter your transactions to answer ad-hoc questions. This spec adds drill-down, a merchant breakdown, and a search/filter sheet — all within the focused month.

## Decisions (from brainstorming)

- **Evolve Insights in place** — keep the `insights` route and its existing sections; add interactivity. No separate tab, no replacement.
- **Drill-down via bottom sheet** — tapping a bucket, category, donut slice, or merchant opens a sliding bottom sheet layered over Insights (matches the app's existing sheet pattern). Nested: tapping a category inside a bucket sheet narrows to that category's transactions, with a back affordance.
- **Capabilities in scope:** (1) bucket/category drill-down, (2) merchant breakdown, (3) search + combinable filters. **Out of scope (YAGNI):** recurring/subscription detection, time-of-day/day-of-week patterns, custom date ranges, cross-period/all-time search.
- **Time scope:** the **focused month only** (the existing scope selector). All drill-down, breakdown, and search operate within that month.
- **Architecture: Approach A** — one enriched month fetch, derive everything client-side in pure `lib/` functions.

## Architecture (Approach A)

The focused month's transactions are fetched once; all analysis is derived client-side and re-derived instantly on interaction (no per-interaction round-trips). This fits the codebase's pure-`lib/` convention and keeps filtering/search snappy.

### Data source

A new react-query fetch on the Insights screen:

```
GET /api/transactions?from=<monthStart>&to=<nextMonthStart>
```

- **No `status` param** → the endpoint excludes only `archived` rows, returning `confirmed` + `needs_review` + `transfer` + `ignored` for the month. Search needs this broader set (to find refunds/transfers/ignored), while spending breakdowns filter it down to the spending set client-side.
- `from`/`to` are computed by a `monthBounds(period)` helper. **Boundary detail:** `SelectTransactions` compares `posted_at <= to` as a string, and `posted_at` values carry a time component (e.g. `2026-06-30T15:00:00Z`). Passing `to` as the **next month's start date** (`2026-07-01`) makes the string comparison include all of the last day (`...T..Z` < `2026-07-01`) while excluding July, matching `SelectCategorySpend`'s `posted_at < end` semantics. Passing the last day (`2026-06-30`) would wrongly drop that day's timestamped rows — `monthBounds` must return the next-month start as `to`. This is covered by a unit test.

### Backend change (minimal)

`ReviewItem` (`internal/store/categories.go`) and its `SelectTransactions` query gain two fields so the client can mirror the headline spending rule:

- `Kind string` ← `c.kind` (e.g. `spending` | `income` | `transfer`), `COALESCE(c.kind,'')`.
- `BucketSnapshot string` ← `t.bucket_snapshot`, `COALESCE(t.bucket_snapshot,'')`.

`handleGetTransactions` encodes `ReviewItem` directly, so these surface in JSON automatically as `Kind` and `BucketSnapshot`. The frontend `ReviewItem`/transaction type (`api/types.ts`) adds the matching fields. No new endpoints; no change to existing filters or callers.

### Reconciliation with the headline numbers

The month's headline category spend is computed server-side by `SelectCategorySpend` as:

```
status='confirmed' AND category.kind='spending' AND direction='debit',
  posted_at in [monthStart, nextMonthStart),
  bucket = freeze_history ? COALESCE(bucket_snapshot, category.bucket) : category.bucket
```

The client `spendingTxns()` helper applies this **exact** predicate, so every drill-down total reconciles with the headline by construction. A unit test asserts the per-category totals from `spendingTxns()` equal the `/api/insights/categories` figures for a shared fixture. `freeze_history` is read from budget settings (already available via `/api/budget` / settings; the type carries `freeze_history`).

## Components & modules

### Pure logic — `lib/analysis.ts` (+ co-located `analysis.test.ts`)

Framework-free, unit-tested helpers (following the `lib/insights.ts` convention):

- `monthBounds(period: string): { from: string; to: string }` — `from` = `period-01`, `to` = next month's start date. Handles year rollover (Dec → Jan).
- `spendingTxns(txns: Txn[], frozen: boolean): SpendingTxn[]` — filters `status==='confirmed' && direction==='debit' && kind==='spending'`; resolves `bucket = frozen ? (bucketSnapshot || bucket) : bucket`. Mirrors `SelectCategorySpend`.
- `bucketBreakdown(spending: SpendingTxn[]): BucketBreakdown[]` — `{ bucket, spent, share, categories: { categoryId, name, spent, share, count }[] }[]`, sorted by spent desc. `share` is per-total fraction.
- `merchantBreakdown(spending: SpendingTxn[], topN?: number): MerchantRow[]` — `{ merchant, spent, count, share }[]` grouped by `merchantRaw`, sorted by spent desc, optionally truncated to `topN` with the remainder folded into an "Other" row when truncated.
- `filterTxns(txns: Txn[], f: AnalysisFilter): Txn[]` — applies any combination of `{ q?: string (merchant substring, case-insensitive), bucket?, categoryId?, merchant?, minAmountFils?, direction? }`. Empty filter returns the input (default scope: confirmed; the sheet decides whether to include non-confirmed).

Types (`q`, `merchant` text, ids) are defined here and consumed by the components below.

### Components (`components/insights/` and `components/transactions/`)

- **`DrillDownSheet`** — props: `target` (`{ type: 'bucket'; bucket } | { type: 'category'; categoryId; name } | { type: 'merchant'; merchant }`), the month's `txns`, and `frozen`. Renders: a header (name, total, share-of-month), and:
  - For `bucket`: its category sub-rows (each tappable → swaps the sheet to that category's `category` view, with a back control), followed by the bucket's spending transactions.
  - For `category` / `merchant`: the matching transactions directly.
  - Transaction rows reuse `TransactionRow`.
- **`MerchantBreakdown`** — a new Insights card listing top merchants (`merchantBreakdown`, e.g. top 8 + "Other"); each row tappable → opens `DrillDownSheet` in `merchant` mode.
- **`SearchSheet`** — a full-height sheet opened from a search icon in the TopBar (shown only on the Insights tab). Contains a text input (`q`), reused `FilterChips` for `bucket` / `category` / `direction` / a min-amount toggle, and a live-updating results list (`TransactionRow`) driven by `filterTxns`. Operating set: the focused month's transactions.

### Wiring into existing summary components

The existing bucket rows, `CategoryComparisonList` rows, and `DonutChart` slices gain an `onSelect(target)` callback that opens `DrillDownSheet`. Their internal rendering is otherwise unchanged. The Insights screen owns the sheet open/close state and the month-transactions query.

### Targeted DRY improvement — `ui/Sheet`

`PeriodSheet`, `CategorizeSheet`, and `AddTransactionSheet` each re-implement sheet chrome (backdrop, grab handle, `--radius-sheet`, open/close transition, dismiss-on-backdrop). Extract that chrome into a small `ui/Sheet` primitive and have all sheets — the three existing ones plus the new `DrillDownSheet` and `SearchSheet` — use it. This keeps the new sheets consistent and removes duplication. Scope this to the chrome only; do not alter the existing sheets' content/behavior.

## Data flow summary

1. Insights screen fetches the focused month's transactions once (`/api/transactions?from&to`) alongside its existing summary queries.
2. Pure `lib/analysis` functions derive bucket/category/merchant breakdowns and power search/filter — all client-side, re-derived on interaction.
3. Tapping a bucket/category/slice/merchant opens `DrillDownSheet`; the search icon opens `SearchSheet`. Both read from the same month transaction set.
4. The existing read-only summary, donut, and trend continue to use their current endpoints; only interactivity and the new card/sheets are added.

## Error & edge handling

- **Loading:** the month-transactions query uses the existing `Skeleton` while loading; failure shows the existing `EmptyState` ("Couldn't load…") consistent with the current Insights error path. Summary sections render independently of the transactions query where possible.
- **Empty month / empty bucket / no search results:** each surface shows an `EmptyState` ("No spending this month", "No transactions match", etc.).
- **Uncategorized transactions:** excluded from spending breakdowns (no `kind==='spending'`), but still findable via search.
- **Month boundary:** handled by `monthBounds` returning the next-month start as `to` (see Architecture). Unit-tested, including December→January rollover.
- **Freeze history:** when `freeze_history` is on, `spendingTxns` uses `bucketSnapshot || bucket` so reclassified past months reconcile with the frozen headline.

## Testing

- **`lib/analysis.test.ts`** (pure): `monthBounds` (normal + year rollover + boundary), `spendingTxns` predicate, `bucketBreakdown` totals/shares, `merchantBreakdown` grouping + "Other" fold, `filterTxns` for each filter and combinations, and the **reconciliation** assertion (per-category totals match the category-spend figures for a fixture).
- **Component tests** (vitest/jsdom, following existing patterns): `DrillDownSheet` renders header + breakdown + transactions and performs nested bucket→category narrowing and back; `MerchantBreakdown` renders top merchants and opens the sheet on tap; `SearchSheet` filters the list live as query/chips change.
- **Go store test:** extend `SelectTransactions` coverage to assert the new `Kind` and `BucketSnapshot` fields are populated.
- Frontend vitest remains single-fork (per repo config); Go tests via `go test ./...`.

## Out of scope

Recurring/subscription detection, time-of-day or day-of-week patterns, custom/arbitrary date ranges, cross-period or all-time search, and any new persisted analytics. All analysis is read-only and bounded to the focused month.
