# Insights: inflow / outflow visualization

## Problem

The Insights page shows spending from many angles (comparative summary, lens
breakdown, top movers, a 6-month **spending-only** trend) but never shows money
*coming in* against money *going out*. The trend endpoint already returns income
per month (`/api/insights/trend` → `{period, spent, income}`); `TrendPoint`
carries `income` but `TrendBars` draws only `spent`, so the inflow data is fetched
and discarded.

## Goal

Add a "Money in vs out" chart to Insights that shows, per month over the trailing
6 months, income (inflow) against spending (outflow) and the resulting net — so
the user can read the rhythm of their finances and which months ran positive.

## Decisions (from brainstorming)

- **Framing:** monthly in-vs-out across the trailing 6 months (not a single-month
  Sankey or waterfall).
- **Replaces** the existing spending-only "6-month spending trend" card *in
  Insights only*. Home also uses `TrendBars` and is left untouched — so this is a
  **new component**, not a mutation of `TrendBars`.
- **No backend change.** Reuses the `trend` query (`trendSeries` → `TrendPoint[]`)
  already on the Insights page.

## Design

### The chart

Six month-columns around a central zero axis (a hairline). Income rises above the
axis, spending drops below it. The asymmetry is the message: taller inflow than
outflow = a net-positive month, readable at a glance.

```
Money in vs out · 6 months          ● In  ● Out

        ▃         ▅         ▂         ▆         ▃         ▇
 ─────────────────────────────────────────────────────────── zero
        ▓▓        ▓▓        ▓▓        ▓▓        ▓▓        ▓▓
      ·—————————·—————————·—————————·—————————·—————————·      net thread
       +820      −140      +1.2k     +300      +90      +2.1k
        Feb       Mar       Apr       May       Jun      Jul
```

Both directions share one value scale: the tallest bar (max of all income and
spending values across the six months) is full height, so inflow and outflow
heights are directly comparable.

### Palette (existing tokens, one bold hue)

- **Inflow (income):** emerald `--color-good`.
- **Outflow (spending):** a sober ink derived from `--color-fg` (reduced opacity) —
  deliberately **not** red; spending is not a failure.
- **Net figure / thread:** positive uses `--color-good`, negative uses
  `--color-bad`.

Bucket colors (need-blue / want-purple / save-green) are intentionally avoided so
this flow chart never reads as a bucket breakdown.

### Signature: the net thread

A thin line connecting each month's net (income − spending), with a dot per month
and a small signed compact figure below the bars (`+820`, `−140`, `+1.2k`). This is
the one bold element; the bars stay quiet so the net line carries the eye. The net
value is the whole point of an in/out view, so it gets the emphasis.

The net thread rides its own vertical placement between the inflow tops and outflow
bottoms; it is a visual through-line, not a third axis. (Implementation: place each
net dot proportional to net on the shared scale, clamped within the column band.)

### Interaction & quality floor

- Non-interactive, matching the current Insights `TrendBars` (which only takes
  `activePeriod`). The focus month is highlighted — bolder label + a faint column
  tint. Tap-to-refocus is intentionally out of scope: focus derives from the global
  `scope` prop, and lifting that for a chart tap is disproportionate to this feature.
- Height transitions on mount; `prefers-reduced-motion` drops movement
  (`motion-safe:` utilities).
- `role="img"` with a spoken summary; each column also exposes an accessible label
  (month, in, out, net). Keyboard-focusable if columns are interactive.
- Responsive: six columns flex down cleanly to a phone width; the card matches the
  existing chart card.

### Copy

- Title: **Money in vs out**; caption uses the same "· 6 months" idiom as siblings.
- Legend: **In** / **Out**.
- Net label: signed compact AED (e.g. `+1.2k`, `−140`).
- Error: reuse the existing "Trend unavailable" fallback. Months with no activity
  render as zero (flat), matching `trendSeries` gap-filling.

## Structure

- `frontend/src/components/charts/FlowBars.tsx` — presentational; props
  `{ points: TrendPoint[]; activePeriod?: string; onSelectPeriod?: (p: string) => void }`.
- `frontend/src/lib/flowBars.ts` — pure geometry + formatting, co-located test:
  - `flowBarGeom(points): FlowColumn[]` — per period `{ period, label, inPct, outPct,
    net, netSign, netPct }` on a shared scale (mirrors `barHeightPct`).
  - `compactFils(fils): string` — signed compact AED for the net labels
    (`+1.2k`, `−140`, `0`).
- `frontend/src/screens/Insights.tsx` — swap `TrendBars` for `FlowBars` in the trend
  card; wire `onSelectPeriod` to the existing focus-month mechanism. Card title
  changes from "6-month spending trend" to "Money in vs out".

`TrendBars`, `lib/trendBars.ts`, and `Home.tsx` are unchanged.

## Testing

- `lib/flowBars.test.ts`: shared-scale heights (income vs spending), net + sign,
  zero/empty months, `compactFils` rounding and sign (incl. exactly zero, sub-1k,
  ≥1k, negative).
- `FlowBars.test.tsx`: renders six columns, active-period emphasis, calls
  `onSelectPeriod` on tap, and exposes accessible per-column labels.
- Update `Insights` rendering expectations if any test asserts the old trend title.
- Manual: `bun run build` + rebuild embedded dist (parallel-agents rule).

## Out of scope

Backend/endpoint changes, changing Home's trend, a single-month flow/Sankey view,
and any currency handling beyond the AED-normalized totals the endpoint already
returns.
