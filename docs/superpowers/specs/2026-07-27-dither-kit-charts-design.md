# Dither-kit charts

**Date:** 2026-07-27
**Status:** Approved (design decisions made interactively; see Decisions)
**Trigger:** User request — "update all charts within the app to use dither kit
(https://www.tripwire.sh/dither-kit)".

## Problem

The app's charts are hand-rolled CSS bars. `CLAUDE.md` claims recharts is a
frontend dependency; it is not — `frontend/package.json` has no charting library
at all. The four data-bearing surfaces in scope:

| Surface | Component | Today |
|---|---|---|
| Home — monthly spending trend | `components/charts/TrendBars.tsx` | absolute-positioned divs, height % |
| Insights — money in vs out | `components/charts/FlowBars.tsx` | divs + one SVG polyline (net thread) |
| Insights — lens breakdown | `components/insights/LensBreakdown.tsx` | `h-1.5` horizontal bars per row |
| Insights — need/want/save split | `components/insights/ComparativeSummary.tsx` | `h-2.5` stacked horizontal bar |

Out of scope, staying CSS: `components/ui/ProgressBar.tsx` and the 50/30/20 bar
in `screens/settings/BudgetPage.tsx`.

Dither-kit is a shadcn-registry chart pack: vendored source (no runtime npm
package), a tiny canvas engine painting ordered-dither (Bayer 4×4) fills, with a
recharts-style children-as-config API.

## Decisions

Six decisions were taken interactively. Recorded here because several have
non-obvious consequences downstream.

1. **Scope** — the two charts plus the two breakdown bars. `ProgressBar` and the
   settings split bar stay CSS.
2. **React 19** — dither-kit's source uses `use(Context)` and `<Context value=>`,
   which require React 19; the app is on 18.3.1. **Chosen: upgrade the app**,
   keeping the vendored source unpatched so `shadcn add --diff` can pull upstream
   fixes later. (Alternative considered and rejected: patching ~10 call sites to
   `useContext`/`Context.Provider`.)
3. **Palette** — dither-kit ships 7 hardcoded RGB seeds tuned for dark surfaces.
   **Chosen: retune the seeds to the app's design tokens, with separate light and
   dark sets.** Charts stay on-brand; the dither texture is the new thing, not
   the hues.
4. **FlowBars net lane** — a dither `BarChart` cannot host a line series
   (`<Bar>` is guarded to `chartType: "bar"`). **Chosen: keep the net lane, net
   thread and net labels exactly as they are**, below the dithered bars.
5. **Loudness** — **full dither-kit character**: `bloom="aura"`, entrance
   animation on, scrub tooltip on. Note the bar canvas has no sparkles (those
   live in the area/line canvas), so bloom is the loudest dial available.
6. **Horizontal bars** — dither-kit has no horizontal bar layout. **Chosen: a
   shared `DitherFill` component built on dither-kit's own vendored painting
   primitives**, so the texture matches exactly, with the bars thickened enough
   for the dither to read.

## Design

### 1. Install and vendoring

Add a hand-written `frontend/components.json`. Do **not** run `shadcn init` — it
injects shadcn's full token layer into `app.css` and collides with the existing
`@theme` block.

```jsonc
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/app.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "utils": "@/lib/utils",
    "hooks": "@/hooks"
  }
}
```

Install with the project's runner, from `frontend/`:

```bash
bunx --bun shadcn@latest add https://tripwire.sh/r/bar-chart.json
```

`bar-chart.json` declares `registryDependencies: ["https://tripwire.sh/r/core.json"]`,
so `core` comes along: **24 files total** into `src/components/dither-kit/`.
Install only `core` + `bar-chart`. Do not install area/line/pie/radar/sparkline,
`dither-avatar` or `dither-button` — nothing uses them.

Supporting changes:

- `tsconfig.json` (`compilerOptions.paths`) and `vite.config.ts`
  (`resolve.alias`) gain `@/*` → `./src/*`. Existing relative imports are left
  alone; the alias exists so the CLI's `--diff` update flow keeps working.
- New runtime deps pulled by `core`: `motion`, `d3-scale`, `d3-shape`, `clsx`,
  `tailwind-merge`. Dev deps: `@types/d3-scale`, `@types/d3-shape`.
- `src/components/dither-kit/README.md` records the registry URLs and version
  (`0.1.0`) so a future `shadcn add --diff` has a baseline.

dither-kit's internal imports are already relative (`./palette`, `./lib`), so no
import rewriting is needed beyond what the CLI does.

### 2. React 19 upgrade

`react`, `react-dom`, `@types/react`, `@types/react-dom` → `^19`.

The codebase is already clean of everything React 19 removed: no `defaultProps`
on function components, no `propTypes`, no `forwardRef`, no string refs, and
`main.tsx` already uses `createRoot`. TanStack Query v5 (+ persist-client),
`@testing-library/react` 16, `lucide-react` and `vite-plugin-pwa` all support
React 19.

This lands as its own commit and must be green on `bun run test`, `tsc -b` and
`bun run build` before any chart work begins.

### 3. Theme bridge

Two independent pieces.

**(a) Token aliases.** dither-kit's chrome components reference shadcn token
names the app does not define — `tooltip.tsx` uses `bg-popover`,
`text-popover-foreground`, `text-muted-foreground`; `x-axis.tsx` uses
`text-muted-foreground`; `grid.tsx` uses `stroke-border`. Without these the
utilities silently resolve to nothing under Tailwind v4.

Add to the `@theme` block in `src/styles/app.css`, and to the
`@media (prefers-color-scheme: dark)` block, mapped to existing values — no new
colors are invented:

| dither-kit token | maps to |
|---|---|
| `--color-popover` | value of `--color-surface` |
| `--color-popover-foreground` | value of `--color-fg` |
| `--color-muted-foreground` | value of `--color-muted` |
| `--color-foreground` | value of `--color-fg` |
| `--color-border` | already defined |

**(b) Palette retune.** Rewrite `src/components/dither-kit/palette.ts`, keeping
the seven `DitherColor` keys and the `Seed { fill, line, star }` shape so no
consumer code changes. Two seed tables, light and dark:

| key | app token |
|---|---|
| `blue` | `--color-need` |
| `purple` | `--color-want` |
| `green` | `--color-save` |
| `red` | `--color-bad` |
| `orange` | `--color-warn` |
| `pink` | `--color-accent` |
| `grey` | `--color-muted` |

`fill` is the token's RGB; `line` and `star` are progressively lighter tints of
`fill`, preserving upstream's relationship (upstream `line` and `star` are
successively lighter than `fill`). Values are hardcoded RGB triples per theme —
not read from CSS at runtime — so the module stays pure and works in jsdom.

Theme selection: a module-level `isDark` flag maintained by a
`matchMedia("(prefers-color-scheme: dark)")` subscription, read by
`seedOfColor`. A `useDitherTheme()` hook subscribes to the same query and
returns the current mode, so charts re-render (and repaint the canvas) when the
system theme flips. Charts call it and pass the result through `replayToken` or
a `key`, whichever proves sufficient in practice.

`palette.ts` is the one upstream file we deliberately fork. Note that at the top
of the file so a future `--diff` update does not silently revert it.

### 4. TrendBars

```tsx
<BarChart data={rows} config={{ spent: { label: "Spent", color: "grey" } }}
          bloom="aura" markerIndex={activeIndex} className="h-32">
  <Bar dataKey="spent" variant="gradient" />
  <XAxis dataKey="label" />
  <Tooltip valueFormatter={(v) => formatFils(v)} />
</BarChart>
```

`barHeightPct` in `lib/trendBars.ts` is no longer used for rendering (the chart
owns its y-scale), but the module stays as the home for the pure helpers the
component tests move onto.

**Deliberate design change.** dither-kit colors per *series*, not per *bar*, so
the current behaviour — the active month's bar painted in `--color-accent` —
cannot be expressed. The active period instead becomes `markerIndex`
(dither-kit's controlled crosshair) plus a bolded month label, matching how
`FlowBars` already marks its active month.

### 5. FlowBars

The diverging shape is native. `computeBands` with `stackType: "stacked"` runs
d3's stack layout, which splits negative values below zero, and `bar-canvas.tsx`
gives stacked series the full band width. So passing income positive and
spending **negated** produces exactly today's single column: income above the
zero axis, spending below.

`stackType: "default"` would place the two series side by side — wrong here.

```tsx
<BarChart data={flowRows(cols)} stackType="stacked" bloom="aura"
          config={{ income: { label: "In", color: "green" },
                    spent:  { label: "Out", color: "grey" } }}>
  <Bar dataKey="income" variant="gradient" />
  <Bar dataKey="spent"  variant="gradient" />
  <Tooltip valueFormatter={(v) => formatFils(Math.abs(v))} />
</BarChart>
```

`lib/flowBars.ts` gains `flowRows(cols)`, returning
`{ period, label, income, spent: -spent }` per column. The existing
`flowColumns` keeps producing `netLanePct`/`netSign`/`net` for the lane below.

Unchanged: the net lane (dashed break-even midline, SVG polyline thread, dots),
the per-column signed net labels, the month labels, and the custom In/Out
legend. These are the chart's signature and stay in our own markup.

Accessibility: keep the existing outer wrapper with `role="img"` and the
full-data `aria-label` summary. dither-kit hardcodes `role="img"
aria-label="Chart"` on its own inner SVG, but descendants of a `role="img"` are
presentational to assistive technology, so the outer label wins. Verify this
with a test asserting the outer label is the accessible name.

### 6. DitherFill

New `src/components/charts/DitherFill.tsx` — a horizontal segmented bar painted
on a canvas, built on dither-kit's vendored primitives so the texture is
pixel-identical to the charts: `BAYER`, `CELL`, `OFF_TIER`, `BORDER_ALPHA`,
`rgb`, `bloomLayerStyle`, `prefersReducedMotion` from `dither-paint.ts` and
`seedOfColor` from `palette.ts`.

```tsx
type DitherFillProps = {
  segments: { value: number; color: DitherColor; label?: string }[]
  max: number          // full-width value; segments sum to <= max
  height?: number      // css px, default 10
  bloom?: BloomInput   // default "aura"
  className?: string
}
```

Behaviour: fills left to right, one dithered run per segment in order, remainder
left as track. Sizes its backing store to `devicePixelRatio` and repaints on
resize (`ResizeObserver`) and on theme change (`useDitherTheme`). Renders
`aria-hidden` — every caller already states the numbers in text.

Consumers:

- `LensBreakdown` — the per-row bar becomes a single-segment `DitherFill`,
  height `6px → 10px` (`h-1.5` → `h-2.5`) so the 2px dither cell reads. Row
  layout, drill-in button, delta badge, share and amount untouched. `BreakdownRow.color`
  (an arbitrary CSS color from `lib/lens.ts`) is mapped to a `DitherColor` name;
  add that mapping in `lib/lens.ts` beside the existing color assignment so the
  two cannot drift.
- `ComparativeSummary` — the need/want/save split becomes one multi-segment
  `DitherFill`, height `10px → 12px` (`h-2.5` → `h-3`). Bucket → `DitherColor`
  mapping lives beside `bucketColor` in `lib/insights.ts`. Legend chips
  untouched.

### 7. Tests

`src/test/setup.ts` gains two stubs, following the existing `PointerEvent`
polyfill pattern:

- `ResizeObserver` — reports a fixed size (e.g. 320×144) so `ctx.ready` becomes
  true and charts render their SVG chrome. Without it jsdom leaves size at 0×0
  and dither charts render an empty div.
- `HTMLCanvasElement.prototype.getContext` — returns a no-op 2D context stub.
  jsdom has none, and the canvas engine calls `clearRect`/`fillRect`/`drawImage`
  every frame.

Assertion strategy (per `CLAUDE.md`'s `lib/` convention): geometry moves down to
the pure modules, components keep only what still renders.

- `lib/trendBars.test.ts`, `lib/flowBars.test.ts` — extended to cover what the
  component tests asserted about bar heights and column geometry, plus the new
  `flowRows` negation.
- `components/charts/TrendBars.test.tsx` — aria-label, month labels, active-month
  emphasis, empty state. Per-bar `data-testid` height assertions are removed;
  they cannot be expressed against a canvas.
- `components/charts/FlowBars.test.tsx` — the accessible name (outer `role="img"`
  label), legend, net dots (`net-dot-*` testids survive — the lane is still our
  markup), signed net labels, empty state.
- `components/charts/DitherFill.test.tsx` — new: renders a canvas, is
  `aria-hidden`, tolerates `max === 0` and empty segments without dividing by
  zero.
- `screens/Home.test.tsx`, `screens/Insights.test.tsx` — retarget any chart
  assertions the same way.

### 8. Documentation

- `CLAUDE.md` — the frontend section lists `recharts`, which was never a
  dependency. Replace with dither-kit, and note the vendored
  `components/dither-kit/` directory, the forked `palette.ts`, and the
  `shadcn add --diff` update path.
- `frontend/src/components/README.md` — catalog entries for `DitherFill` and the
  updated chart components, per the repo rule that the catalog is updated in the
  same commit as the component.
- Rebuild `internal/web/dist/` before finishing, since parallel sessions run on
  `main` and the embedded bundle must match the frontend source.

## Sequencing

Six commits, in order. Each must leave `bun run test` and `tsc -b` green.

1. React 19 upgrade.
2. Vendor dither-kit (`components.json`, `@/` alias, `shadcn add`) + theme bridge
   (token aliases + palette retune + `useDitherTheme`).
3. `TrendBars` → dither `BarChart`, with test migration.
4. `FlowBars` → dither `BarChart` + preserved net lane, with test migration.
5. `DitherFill` + `LensBreakdown` + `ComparativeSummary`.
6. Docs (`CLAUDE.md`, component catalog) + rebuilt `internal/web/dist/`.

## Risks

- **Canvas in jsdom is opaque.** No test can assert what the dither actually
  paints. Mitigated by pushing geometry into pure `lib/` modules and by a manual
  pass through the real app (the `verify` skill) before finishing.
- **Upstream is young.** dither-kit `0.1.0`, published July 2026, low download
  count. The code is vendored, so there is no runtime risk from upstream
  changing, but there will be no upstream bug fixes to rely on either.
- **`palette.ts` is forked.** A future `shadcn add --diff` will show it as
  divergent. The header comment is the mitigation.
- **Bloom on light surfaces.** `bloom="aura"` was chosen deliberately; if it
  reads as haze on the warm off-white background, the dial drops to `"low"` or
  `"off"` without any structural change.
