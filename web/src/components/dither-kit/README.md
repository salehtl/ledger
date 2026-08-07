# dither-kit (vendored)

Ordered-dither canvas charts, vendored from the [dither-kit](https://www.tripwire.sh/dither-kit)
shadcn registry. **Not an npm dependency** — these files are source we own.

- Version: `0.1.0`
- Installed: `bunx --bun shadcn@latest add https://tripwire.sh/r/bar-chart.json`
  (pulls `https://tripwire.sh/r/core.json` transitively)
- Only `core` + `bar-chart` are installed. Area, line, pie, radar, sparkline,
  `dither-avatar` and `dither-button` are deliberately not vendored — nothing
  uses them.

## Local changes

- **`palette.ts` is forked, values *and* keys.** Upstream's seven seeds are
  dark-surface arcade hues named green/blue/purple/pink/orange/red/grey. Ours
  are a validated five-hue chart palette plus a neutral, in separate light and
  dark tables, and the keys are **renamed** to match what they hold:
  `azure | amber | lilac | sage | rose | slate`. The rename is deliberate —
  after the values were retuned the upstream names lied (`pink` held a navy at
  one point) and a reviewer nearly "corrected" the mapping back to the wrong
  hues. Also adds `mix`, `isDarkTheme` and `subscribeDitherTheme`. See the
  header comment in that file, and `lib/ditherColor.ts` for the assignments and
  the measured separations behind them. A `--diff` here will look large; do not
  accept upstream over it.
- **`scales.ts`**: `computeBands` now passes d3's `stackOffsetDiverging` for
  `stackType === "stacked"`. Upstream left `.offset()` undefined, which d3
  resolves to `stackOffsetNone` — plain cumulative stacking, which piles a
  negative series on top of the positive one instead of splitting it below
  zero, and never drives `min` below 0 (it reads `point[0]`). `FlowBars` is a
  diverging in-vs-out chart, so under the upstream behaviour "Out" painted on
  top of "In" and a deficit month's bar fell outside the canvas. Upstream's own
  doc comment claimed the diverging behaviour, so this makes the code match it.
  Guarded by `scales.test.ts` (also ours — upstream ships no test here).
- **`bar.tsx`**: upstream's dev-only prop-validation warning gated on
  `process.env.NODE_ENV !== "production"`. This app's Vite build never
  defines a `process` global (no Node-compat shim, no `define` entry), so the
  check throws `ReferenceError: process is not defined` on every render.
  Swapped for Vite's own `import.meta.env.DEV`, which is statically replaced
  at build time and behaves identically.
- **`cartesian-root.tsx`, touch axis lock.** Upstream scrubs on the first
  `pointermove`, which is right for a mouse and wrong for a finger: a chart
  lives inside a vertically scrolling page, so any drag that merely *starts*
  over one was stolen from the page. Touch pointers are now excluded from the
  pointer handlers and go through a non-passive `touchmove` listener that waits
  out a slop zone, then commits for the rest of the touch — clearly horizontal
  scrubs and calls `preventDefault()`, clearly vertical is dropped so the page
  scrolls and pull-to-refresh still works. The decision lives in
  `lib/chartScrub.ts` as `scrubIntent`, the mirror of `pullIntent`; a test pins
  that the two can never claim the same gesture. Mouse and pen keep upstream's
  immediate hover. Note this is why the charts must **not** declare a
  `touch-action` — see `components/charts/scrubSurface.ts`.
- **`cartesian-root.tsx`**: added an `onPointerCancel` handler, sharing the
  `endHover` teardown with `onPointerLeave` and the new touch end/cancel. Upstream handles leave only, which
  is enough for a mouse but not for touch — when the browser decides a
  finger-drag is a page scroll it cancels the pointer stream *without* firing
  leave, so the scrub index (and the tooltip) stayed stuck on screen while the
  page moved underneath. This half only cleans up after a gesture the browser
  takes anyway; the charts also declare `user-select: none` (and deliberately
  no `touch-action`) via `components/charts/scrubSurface.ts`.
- **`bar-canvas.tsx`**: the bloom copy (`bloomCtx.clearRect` + `drawImage`)
  moved from the top of the RAF loop to *below* the `if (!needsFill) return`
  guard. Upstream re-copied the main canvas into the bloom layer on every frame
  regardless of whether anything repainted, so a settled chart kept dirtying a
  blurred `plus-lighter` layer 60×/s forever — permanent compositor work and
  battery draw on an always-open mobile PWA. It also now copies the frame it
  belongs to instead of the previous one.
- **`tooltip.tsx`**: still forked, but no longer to remove `motion` —
  `AnimatePresence` and `m.div` are back, driving the same fade (`opacity`,
  `DUR.fast`) and glide (`left`/`top`, 0.19s) this file always had. The fork
  now is that it uses the app's `m` primitives and `lib/motion` tokens
  (`DUR`, `EASE_OUT`) rather than upstream's bare `motion` import and its own
  local constants, so it inherits the app-wide `MotionProvider` (`LazyMotion`
  code-splitting, `MotionConfig reducedMotion="user"`) instead of carrying its
  own reduced-motion opt-out — the old `.dither-tooltip` CSS rule is gone.
  If this file is ever re-pulled from upstream, re-apply the `m`/token swap.

Everything else is upstream-verbatim. `package.json` has a `shadcn` script
(`bun run shadcn ...`) that wraps `bunx --bun shadcn@latest ...` — use it to
check for upstream changes:

```bash
cd frontend
bun run shadcn add https://tripwire.sh/r/bar-chart.json --dry-run
bun run shadcn add https://tripwire.sh/r/bar-chart.json --diff <file>
```

Never `--overwrite` without re-applying the `palette.ts` fork.

## Notes

- Bars are **vertical only**. Horizontal bars use `components/charts/DitherFill.tsx`,
  which no longer consumes this package's painting primitives — it renders
  CSS-masked DOM and imports only the `DitherColor` type, so a dither-kit
  re-sync does not affect it.
- The chrome components (`tooltip.tsx`, `x-axis.tsx`, `grid.tsx`) reference
  shadcn token names (`bg-popover`, `text-muted-foreground`, `stroke-border`).
  Those are aliased onto our palette in `src/styles/app.css`.
- `components.json`'s `aliases.utils` points at `@/components/dither-kit/lib`,
  not `@/lib/utils` — there is no `src/lib/utils.ts` in this app, and `cn`
  lives in this directory's `lib.ts`. shadcn rewrites a registry component's
  `@/lib/utils` import to that alias on install, so a future `add` resolves.
- Unused vendored files (area, polar, dot, …) are kept on purpose: the registry
  installs `core` as a unit, and pruning would break the `--diff` baseline.
