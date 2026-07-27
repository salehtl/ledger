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

- **`palette.ts` is forked.** Upstream's seven seeds are dark-surface arcade
  hues; ours carry the app's design tokens in separate light and dark tables,
  plus `mix`, `isDarkTheme` and `subscribeDitherTheme`. See the header comment
  in that file.
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
- **`bar-canvas.tsx`**: the bloom copy (`bloomCtx.clearRect` + `drawImage`)
  moved from the top of the RAF loop to *below* the `if (!needsFill) return`
  guard. Upstream re-copied the main canvas into the bloom layer on every frame
  regardless of whether anything repainted, so a settled chart kept dirtying a
  blurred `plus-lighter` layer 60×/s forever — permanent compositor work and
  battery draw on an always-open mobile PWA. It also now copies the frame it
  belongs to instead of the previous one.
- **`tooltip.tsx`**: `motion` (framer-motion) replaced with CSS transitions.
  `motion` was imported by this one file and accounted for 128KB of a 602KB
  bundle, precached by the service worker. A `present` state, cleared by a
  `setTimeout(FADE_MS)`, stands in for `<AnimatePresence>`: the card mounts on
  hover, stays mounted through the exit fade, then unmounts (`return null`)
  — staying mounted permanently would leave a copy of every hovered label
  sitting in the DOM. While mounted it fades via `opacity` and glides via
  `left`/`top` transitions on the app's `--ease-out` token; the position is
  frozen while hidden (so the exit is a pure fade), and an `armed` flag, set
  one painted frame after mount via a double `requestAnimationFrame`, gates
  the transition so the entrance doesn't glide in from wherever the previous
  hover left the card. Reduced-motion opt-out is the `.dither-tooltip` rule in
  `src/styles/app.css` — inline styles can't carry a media query. **If this
  file is ever re-pulled from upstream, `motion` comes back as a
  dependency.**

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
  which is built on this package's painting primitives.
- The chrome components (`tooltip.tsx`, `x-axis.tsx`, `grid.tsx`) reference
  shadcn token names (`bg-popover`, `text-muted-foreground`, `stroke-border`).
  Those are aliased onto our palette in `src/styles/app.css`.
- `components.json`'s `aliases.utils` points at `@/components/dither-kit/lib`,
  not `@/lib/utils` — there is no `src/lib/utils.ts` in this app, and `cn`
  lives in this directory's `lib.ts`. shadcn rewrites a registry component's
  `@/lib/utils` import to that alias on install, so a future `add` resolves.
- Unused vendored files (area, polar, dot, …) are kept on purpose: the registry
  installs `core` as a unit, and pruning would break the `--diff` baseline.
