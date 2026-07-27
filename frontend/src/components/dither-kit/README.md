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
