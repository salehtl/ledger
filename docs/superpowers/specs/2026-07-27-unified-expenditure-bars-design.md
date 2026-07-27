# Unified expenditure bars

**Date:** 2026-07-27
**Status:** approved, pending implementation

## Problem

The app draws "how much was spent" as a horizontal bar in two places, and the two
are built on different machinery and look different:

- **Home** — `components/ui/ProgressBar.tsx`. A `bg-fg` block under the
  `.dither-mask` CSS class: a `radial-gradient` dot grid at a uniform 2px pitch.
  Monochrome. At or over budget the mask drops and the fill goes solid.
- **Insights** — `components/charts/DitherFill.tsx`. A `<canvas>` painting a 4×4
  Bayer matrix in the bucket's hue, density ramped bottom-up and biased per
  bucket (need dense, want medium, saving sparse), solid when over budget.

Two textures for one concept, and colour on only one of the two screens.

## Decision

**One texture, from Home. Colour on both.**

`.dither-mask` becomes the single definition of "dotted" for expenditure bars.
`DitherFill` stops painting canvas and renders masked DOM instead. `ProgressBar`
gains a hue so Home's bucket bars are coloured.

This is lossless on colour: `app.css`'s hue vars are an exact mirror of the
canvas palette (`--color-amber: #b5771e` is the same ink as
`amber: light([181, 119, 30])`), in both the light and dark tables.

### Why this direction

The codebase has already made this call once. `lib/paletteColor.ts` exists
because project colours must follow the theme, and its reasoning generalises:

> A name becomes a `var(--color-…)` that the cascade re-resolves per theme, so no
> consumer needs `useDitherTheme()`. Only the canvas ever needs literals.

An expenditure bar is a flat rectangle of one hue. It never needed a canvas. Off
canvas, it loses the `ResizeObserver`, the repaint effect, the theme
subscription, and the dead `bloom` layer, and it inherits theme handling for
free.

### Rejected: push canvas onto Home

The inverse — give Home colour by moving it to `DitherFill` — was rejected. It
picks the wrong winner (Insights' Bayer texture, not Home's dots, which is
backwards from the goal), and it puts a canvas and a `ResizeObserver` behind
every bar on the app's busiest screen. `LensBreakdown` alone renders ~20.

## The density channel

Insights currently encodes bucket identity twice: hue *and* dot density.
`ditherColor.ts` documents this as deliberate redundancy for colour-vision
deficiency. Under this design, density as an *identity* channel goes away —
every bar uses the one 2px pitch.

This is a smaller loss than those comments imply, and the codebase is already
inconsistent about it:

- Density was only ever set for the three **bucket** rows. The category-lens
  rows (`categoryDither` by spend rank, five hues) have always run on hue alone —
  see `lib/lens.ts`, which sets `ditherColor` but no `density` for category and
  merchant rows.
- Every bucket bar sits directly beside its own text label ("Needs", "Wants",
  "Savings") on both screens.

So this makes buckets consistent with what categories already do, rather than
removing the app's only fallback. The comments in `ditherColor.ts` and
`DitherFill.tsx` that describe the double encoding must be rewritten, not left
in place describing behaviour that no longer exists.

**Density survives as a state channel, not an identity one.** Solid still means
at-or-over budget, on both screens, exactly as `ProgressBar` already reads it.

## Architecture

Two components stay two components. They have different jobs and different
accessibility contracts; only the texture is shared.

| | measures | semantics | change |
|---|---|---|---|
| `ProgressBar` (Home) | spend vs. **target** | `role="progressbar"`, pace marker | gains `color` |
| `DitherFill` (Insights) | magnitude vs. **max** | `aria-hidden`, multi-segment | canvas → DOM |

### `styles/app.css`

`.dither-mask` is unchanged. It is promoted, by use, to the app's one dotted
texture.

### `lib/paletteColor.ts`

Add one export:

```ts
export function hueVar(color: DitherColor): string {
  return `var(--color-${color})`;
}
```

No fallback branch, unlike `projectColor`: the file already asserts at compile
time that `PALETTE_NAMES` and `DitherColor` are the same set, so a `DitherColor`
is always a valid var name.

### `components/ui/ProgressBar.tsx`

The fill's `bg-fg` becomes an optional hue.

- New optional prop `color?: DitherColor`. Absent → today's `bg-fg` /
  `bg-hero-fg` behaviour, unchanged.
- Home's three bucket bars pass their bucket's hue, so each bar matches the
  swatch dot already rendered beside its label.
- Solid-at-over-budget, the `tone` override, the `pace` marker, the track, and
  all ARIA are untouched.

**The hero bar stays monochrome.** It totals all three buckets, so no single
bucket hue is honest for it, and amber/lilac/sage on the branded accent surface
is a contrast problem. It keeps `hero-fg` and passes no `color`.

### `components/charts/DitherFill.tsx`

Rewritten as DOM. Public shape is preserved except for two removals.

- **Kept:** `segments`, `max`, `height`, `className`, `aria-hidden`, the
  `bg-surface-2` track, and left-to-right fill with the remainder of `max` left
  as track.
- **Removed:** `bloom` (already defaulted off and documented as invisible at
  these heights — the 15px blur is clipped by the component's own
  `overflow-hidden`), and per-bucket `density` as identity.
- **Renders:** a flex row of one `<div>` per segment, each with
  `background: hueVar(seg.color)`, a percentage width, and the `dither-mask`
  class — omitted when the segment is solid.

Dropped imports: `BAYER`, `OFF_TIER`, `backingSize`, `bloomLayerStyle` from
`dither-paint`, `rgb` / `seedOfColor` from `palette`, and `useDitherTheme`.
`useDitherTheme` itself stays — `TrendBars`, `FlowBars`, and `SwipeDeck` still
use it. `dither-paint` is vendored source; its now-unreferenced exports stay put
rather than being pruned out of a vendored file.

### `lib/ditherFill.ts`

`segmentBounds` survives unchanged, called with `cols = 100` to yield integer
percentages. Its cumulative-rounding property still matters: it pins the last
boundary to full width when segments sum to `max`, so a full bar shows no sliver
of leftover track. Its test file is untouched.

### `Density`, in `DitherFill.tsx` and `lib/ditherColor.ts`

`Density` is declared in `DitherFill.tsx` and consumed by `ditherColor.ts`; that
direction stays.

In `DitherFill.tsx`:

- `Density` narrows from `"dense" | "medium" | "sparse" | "solid"` to
  `"dotted" | "solid"`.
- `DENSITY_BIAS` is deleted along with the Bayer thresholding it fed.

In `lib/ditherColor.ts`:

- `bucketDensity(bucket, isOverBudget)` collapses to an over-budget predicate;
  the bucket argument no longer affects the result.
- The double-encoding doc comments are rewritten to describe hue-as-identity and
  solid-as-over-budget.

## Out of scope

`components/charts/TrendBars.tsx` and `FlowBars.tsx`. Those are dither-kit's
vertical charts — a separate rendering system with its own gradient fill,
per-column outline, and feather row — not expenditure magnitude bars. They keep
their canvas and their `useDitherTheme` subscription.

## Testing

- `DitherFill.test.tsx` — rewritten. Canvas pixel probing becomes DOM
  assertions: segment count, width percentages, `dither-mask` present for dotted
  and absent for solid, and the right `var(--color-…)` per segment.
- `lib/ditherFill.test.ts` — unchanged; `segmentBounds` keeps its contract.
- `ProgressBar.test.tsx` — add cases for `color` applied, `color` absent falling
  back to `bg-fg`, and `onAccent` staying monochrome.
- `LensBreakdown`, `ComparativeSummary`, `Home`, `Insights` tests — run and fix
  fallout from the `density` signature change.
- `components/README.md` — updated in the same commit, per CLAUDE.md's catalog
  rule, since two shared components change.
- Manual verification via the `verify` skill. This is a purely visual change;
  tests confirm structure but cannot say whether coloured dots at a 10px bar
  height actually read on device. Check both screens, light and dark.

## Risks

- **Dot visibility at colour.** The mask was tuned against `bg-fg`, near-maximum
  contrast. Mid-chroma hues on `bg-surface-2` are a weaker figure/ground pair, so
  the dots may read as flat colour or as mud at 10px. This is the main thing
  manual verification has to answer; if it fails, the fix is a mask tweak, not a
  change of direction.
- **Stacked segments in `ComparativeSummary`.** Three hues meeting edge-to-edge
  in one 12px bar, each dotted, is the densest case. The palette triple was
  validated for adjacency (worst adjacent ΔE 18.2 deuteranopic) but on solid
  fills, not through a mask that drops ~50% of each segment's pixels to track.
