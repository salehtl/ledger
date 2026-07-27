// ─────────────────────────────────────────────────────────────────────────────
// FORKED FROM UPSTREAM dither-kit 0.1.0.
//
// Two departures from upstream:
//
// 1. The seed *values* are this app's chart palette, in separate light and dark
//    tables, because the canvas paints raw RGB and cannot inherit a CSS var.
// 2. The `DitherColor` keys are **renamed** to describe the hues they actually
//    carry (azure/amber/lilac/sage/rose/slate). Upstream's names were
//    green/blue/purple/pink/orange/red/grey; once the values were retuned those
//    names lied — at one point `pink` held a navy — and a reviewer nearly
//    "fixed" the mapping back. Names now match values.
//
// A future `shadcn add --diff` shows this file as divergent. That is intended;
// re-apply the fork rather than accepting upstream. `DitherColor` is referenced
// as a type by several vendored files, but only ever as a key of `config`, so
// the rename is contained to our own chart code.
//
// Palette derivation lives in docs/superpowers/specs — the short version: the
// two-color press theme puts everything on paper (#f2f1ef) or near-black
// (#141416) with one vermilion accent (#c93d26, OKLCH L .56 / C .18). Chart
// hues sit at C ≈ .12 — around two thirds the accent's chroma — so they read as
// muted next to it and never compete with the one spot colour. Every set below
// was checked with the dataviz validator (OKLCH lightness band, chroma floor,
// protan/deutan separation, normal-vision floor, contrast) rather than picked
// by eye; see `ditherColor.ts` for which sets are the ones that actually touch.
// ─────────────────────────────────────────────────────────────────────────────

export type Rgb = [number, number, number];

/**
 * The chart palette. Five categorical hues plus a neutral.
 *
 * Ordering matters: adjacent entries in a chart must alternate between the two
 * groups that collapse under red-green colour blindness — cool (azure, lilac)
 * and warm (amber, sage, rose) — and differ in lightness. `ditherColor.ts` owns
 * the assignments and documents the validated ΔE for each.
 */
export type DitherColor =
  | "azure"
  | "amber"
  | "lilac"
  | "sage"
  | "rose"
  | "slate";

export type Seed = { fill: Rgb; line: Rgb; star: Rgb };

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** Linear per-channel blend, rounded. `t` is how far from `a` toward `b`. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Upstream derives `line` and `star` as successively lighter tints of `fill`,
// which works on its dark canvas. On paper a lighter line washes out, so the
// light table tints toward black instead. Same relationship, mirrored for the
// background it sits on.
const light = (fill: Rgb): Seed => ({
  fill,
  line: mix(fill, BLACK, 0.25),
  star: mix(fill, BLACK, 0.4),
});
const dark = (fill: Rgb): Seed => ({
  fill,
  line: mix(fill, WHITE, 0.45),
  star: mix(fill, WHITE, 0.7),
});

/**
 * Light theme, on paper (#f2f1ef). Lightness is staggered deliberately — under
 * red-green colour blindness hue alone collapses, so neighbouring series lean
 * on the lightness difference to stay apart. Every entry clears 3:1 on paper as
 * a solid; the ordered dither then lifts the rendered bar lighter than the
 * swatch, which is what keeps these reading soft rather than heavy.
 */
export const PALETTE_LIGHT: Record<DitherColor, Seed> = {
  azure: light([22, 96, 160]),   // #1660a0  OKLCH L .48 C .124 h 250
  amber: light([181, 119, 30]),  // #b5771e  OKLCH L .62 C .124 h 70
  lilac: light([117, 86, 165]),  // #7556a5  OKLCH L .52 C .124 h 300
  sage: light([64, 148, 87]),    // #409457  OKLCH L .60 C .124 h 150
  rose: light([197, 100, 110]),  // #c5646e  OKLCH L .62 C .124 h 15
  slate: light([118, 118, 126]), // #76767e  the neutral — "everything else"
};

/** Dark theme, on #141416. Same hues, re-stepped for the dark surface. */
export const PALETTE_DARK: Record<DitherColor, Seed> = {
  azure: dark([44, 114, 179]),   // #2c72b3  OKLCH L .54 C .124 h 250
  amber: dark([197, 134, 50]),   // #c58632  OKLCH L .67 C .124 h 70
  lilac: dark([131, 101, 181]),  // #8365b5  OKLCH L .57 C .124 h 300
  sage: dark([83, 167, 104]),    // #53a768  OKLCH L .66 C .124 h 150
  rose: dark([204, 106, 116]),   // #cc6a74  OKLCH L .64 C .124 h 15
  slate: dark([127, 127, 135]),  // #7f7f87  the neutral
};

// Theme tracking. The canvas paints raw RGB, so it cannot inherit a CSS var —
// the active table is resolved here and consumers re-render via useDitherTheme.
const QUERY = "(prefers-color-scheme: dark)";

function mql(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY)
    : null;
}

export function isDarkTheme(): boolean {
  return mql()?.matches ?? false;
}

/** Subscribe to OS theme flips. Returns an unsubscribe function. */
export function subscribeDitherTheme(cb: () => void): () => void {
  const m = mql();
  if (!m) return () => {};
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

export const rgb = ([r, g, b]: Rgb, k = 1, a = 1) =>
  `rgba(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)},${a})`;

export const seedOfColor = (color: DitherColor): Seed =>
  (isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT)[color];

export const isDitherColor = (value: unknown): value is DitherColor =>
  typeof value === "string" && value in PALETTE_LIGHT;
