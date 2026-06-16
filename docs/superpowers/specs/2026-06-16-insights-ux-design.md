# Insights Page UX Redesign — Design

**Date:** 2026-06-16
**Status:** Approved (design)

## Problem & motivation

The Insights page is purely descriptive: a donut ("where the money went"), a fixed trailing-6-month trend, and a flat category list (name · bucket Pill · amount). It doesn't tell the user whether a month was good or bad, what changed, or how categories compare. It also silently collapses any multi-month or "all-time" global scope to a single month with no indication.

This redesign makes Insights **evaluative and comparative** — "what changed" — while keeping it clearly distinct from the Home screen.

## Key constraint: differentiation from Home

Home already owns the "am I on track right now" story: a spent-vs-budget hero with projection and verdict, a **per-bucket pace card** (need/want/saving ProgressBars with pace marker + "On track / Over pace / Over budget"), the 6-month trend, and a recent-transactions stream.

Therefore Insights must **not** duplicate Home's pace bars. Its evaluative angle is **comparison** (vs last month), not pace-vs-target:

- **Home** = *Am I on track?* (totals, pace bars, projection, recent) — forward-looking.
- **Insights** = *Where did it go and what changed?* (category depth, MoM comparison, top movers, savings rate, donut) — comparative/retrospective.

## Scope

**In scope (this iteration):**
1. Comparative summary header: net + savings rate for the focus month, and a **compact need/want/saving strip showing each bucket's spend vs last month** (the comparative lens, not Home's pace bars). (No net-vs-last-month arrow — previous-month income isn't fetched; MoM comparison is carried by the bucket strip, category deltas, and top movers.)
2. "Biggest changes" (top movers) block — the signature element.
3. Per-category **% share** and **MoM delta** in the category list.
4. Savings rate / net for the focus month.
5. **Scope coherence:** honest month-anchoring with a qualifier label for range/"all".
6. Tighter empty/loading/error states and chart/label accessibility.

**Explicitly out of scope (future milestone):**
- Drill-down from a category into its transactions.
- Sorting / bucket filtering of the category list.
- Any backend change (no new endpoints, no aggregation, no `category_id` transaction filter).
- Adding income overlay to the trend chart (savings rate is shown in the header instead).

## Layout (approved: "What changed" first)

Top to bottom, all using the existing `Card` system:

1. **Comparative summary** — focus-month label (+ qualifier note), net, savings rate, compact ●need / ●want / ●save strip with per-bucket deltas.
2. **Biggest changes** — top 3 movers with directional delta (signature block).
3. **Where it went** — existing `DonutChart`, spent in center.
4. **By category** — comparison list: name · bucket Pill · amount · % share · Δ badge.
5. **6-month trend** — existing `TrendBars`, focus month highlighted.

## Focus month & scope coherence

`scopeAnchor(scope)` already collapses any scope to a single month (month → its period; range → latest month `scope.to`; "all" → current month). The redesign keeps that but makes it explicit:

- New helper `insightsFocus(scope): { period: string; note: string }`:
  - `month` → `{ period, note: "" }`
  - `range` → `{ period: scope.to, note: "latest in range" }`
  - `all`   → `{ period: currentPeriod(), note: "current month" }`
- The summary header renders the month label and, when `note` is non-empty, a small muted qualifier so the collapse is never silent.
- `prevMonth = addMonth(focusMonth, -1)` drives all MoM comparison.

## Data sources (all existing endpoints, no backend change)

| Query key | Endpoint | Use |
|---|---|---|
| `["insights-categories", focusMonth]` | `GET /api/insights/categories?period=<focus>` | category spend for the focus month |
| `["insights-categories", prevMonth]` | `GET /api/insights/categories?period=<prev>` | previous month, powers all MoM deltas (category + bucket level) |
| `["summary", focusMonth]` | `GET /api/summary?period=<focus>` | `income` only (net + savings rate); **shared cache key with Home** |
| `["insights-trend"]` | `GET /api/insights/trend?months=6` | trend context (unchanged) |

Bucket-level totals and deltas are derived by summing the two `CategorySpend[]` results by `bucket` — no extra call. `CategorySpend = { category_id, name, bucket, spent }`.

## New lib logic (`frontend/src/lib/insights.ts`)

All pure functions, unit-tested. Money stays `int64` fils throughout; never floats for money (percentages are ratios, which are fine as numbers).

- `interface CategoryDelta { category_id: number; name: string; bucket: string; spent: number; prevSpent: number; delta: number; deltaPct: number | null; isNew: boolean; }`
- `categoryDeltas(cur: CategorySpend[], prev: CategorySpend[]): CategoryDelta[]`
  - `delta = spent − prevSpent`.
  - `deltaPct = prevSpent > 0 ? delta / prevSpent : null`.
  - `isNew = prevSpent === 0 && spent > 0`.
  - Includes categories present in either month. A category in `prev` but not `cur` appears with `spent = 0` (a "gone" decrease).
- `withShare<T extends { spent: number }>(rows: T[], total: number): (T & { pct: number })[]` — `pct = total > 0 ? spent / total : 0`.
- `bucketComparison(cur, prev): { bucket: string; spent: number; prevSpent: number; delta: number }[]` for `need | want | saving` (fixed order), summing each side by bucket.
- `topMovers(deltas: CategoryDelta[], n = 3): CategoryDelta[]` — exclude `delta === 0`, sort by **absolute fils `delta`** descending, take `n`. (Absolute fils, not %, so a tiny category's large % doesn't dominate.)
- `savingsRate(income: number, spent: number): { net: number; rate: number | null }` — `net = income − spent`; `rate = income > 0 ? net / income : null`.

## Delta display & tone (deliberate, budgeting-framed)

- `isNew` → label "new" (no %).
- `spent === 0 && prevSpent > 0` → ▼ "gone".
- `delta === 0` (or both 0) → "—".
- Otherwise show the arrow + `deltaPct` (e.g. "▲ 32%") when `deltaPct != null`, else the fils `delta`.
- **Tone:** spending **up** (`delta > 0`) → `warn`; **down** (`delta < 0`) → `good`; flat → `muted`. Uses existing semantic tokens only — no new colors.

## Components (`frontend/src/`)

Small, single-responsibility units; follow existing `Card`/`Pill`/`Money`/`EmptyState`/`Skeleton` patterns.

- `screens/Insights.tsx` — orchestrator: resolve focus via `insightsFocus`, fire the four queries, compose the cards, own loading/error gates.
- `components/insights/ComparativeSummary.tsx` — props: focus label + note, `net`, `savingsRate` result, and `bucketComparison` rows. Renders the month label (+ qualifier), net, savings rate, and the compact ●need/●want/●save strip with per-bucket deltas.
- `components/insights/TopMovers.tsx` — props: `CategoryDelta[]` (already reduced to top movers). Renders up to 3 rows; when there is no prior-month data (every `prevSpent === 0`, i.e. first month) renders a quiet "No prior month to compare." instead.
- `components/insights/CategoryComparisonList.tsx` — props: `(CategoryDelta & { pct: number })[]`. Rows: name · bucket `Pill` · `Money` · % share · Δ badge. Sorted by `spent` descending.
- Reused unchanged: `components/charts/DonutChart.tsx` (spent in center), `components/charts/TrendBars.tsx` (focus month highlighted via existing `activePeriod`).

(Placement under `components/insights/` mirrors the existing `components/transactions/`, `components/swipe/` grouping. If the repo convention is flat, place alongside other components — follow what exists.)

## States & accessibility

- **Loading:** `Skeleton` while the focus-categories or summary query is pending.
- **Error:** `EmptyState` with `AlertTriangle`, "Couldn't load insights", retry hint.
- **Empty (no spending in focus month):** per-card empty states; donut shows "No spending this month"; category list shows "Nothing to break down yet"; Top Movers hidden / "No prior month to compare." on the first month.
- **Accessibility:** bucket labels read "Needs / Wants / Savings" (not the raw "need"); Δ badges carry an aria-label such as "up 32% vs last month"; the donut has an accessible summary label; the comparative strip dots are decorative (`aria-hidden`) with text labels.

## Testing

**lib (`lib/insights.test.ts`, vitest):**
- `categoryDeltas`: matched categories, `isNew`, "gone" (present in prev only), zero-delta, `deltaPct` null when `prevSpent === 0`.
- `topMovers`: ordering by absolute fils delta, exclusion of zero deltas, `n` cap.
- `savingsRate`: normal, income 0 → `rate: null`, negative net (overspend).
- `withShare`: total 0 → `pct: 0`; normal ratios.
- `bucketComparison`: sums by bucket, fixed need/want/saving order, deltas.
- `insightsFocus`: month / range / all → correct period + note.

**components (vitest + @testing-library/react, project harness: `vi.stubGlobal("fetch", …)`, `QueryClientProvider`):**
- `ComparativeSummary`: renders net, savings rate, and the three bucket deltas with correct tone.
- `TopMovers`: shows top 3 sorted; renders the "no prior month" message when all `prevSpent === 0`.
- `CategoryComparisonList`: renders %, Δ badge, "new" and "gone" cases.
- `Insights`: focus-note qualifier appears for range/all scopes; empty-state path; loading path.

## Risks / notes

- Two `["insights-categories", …]` queries (focus + prev) double the category fetch for the page; acceptable for a single-user PWA and both are cached/shared.
- For a focus month with no preceding data (the very first month of history), all MoM comparison degrades gracefully to "new"/hidden movers — covered by tests.
