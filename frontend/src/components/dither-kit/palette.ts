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
 * The chart palette. Eleven categorical hues plus a neutral.
 *
 * Ordering matters: adjacent entries in a chart must alternate between the two
 * groups that collapse under red-green colour blindness — cool (azure, sky,
 * indigo, lilac) and warm (ochre, amber, moss, sage, rose, orchid) — and differ
 * in lightness. `ditherColor.ts` owns the assignments and documents the
 * validated ΔE for each.
 *
 * The first six names are the original palette and their values are unchanged:
 * they are stored on real project rows, so moving one would silently repaint
 * data the user already chose. The six after them were added when categories
 * gained their own colours and 21 active categories needed more than 12 slots;
 * they fill the widest gaps on the existing hue wheel rather than adding a
 * third lightness step.
 */
export type DitherColor =
  | "azure"
  | "amber"
  | "lilac"
  | "sage"
  | "rose"
  | "slate"
  | "ochre"
  | "moss"
  | "teal"
  | "sky"
  | "indigo"
  | "orchid"
  // A second, deeper step per hue. Separated from its base on *lightness*,
  // which is the axis that survives red-green colour blindness — a second
  // chroma step would collapse. Twenty-four marks covers the 21 active
  // categories without inventing hues a two-ink design can't carry.
  | "azure-deep"
  | "amber-deep"
  | "lilac-deep"
  | "sage-deep"
  | "rose-deep"
  | "slate-deep"
  | "ochre-deep"
  | "moss-deep"
  | "teal-deep"
  | "sky-deep"
  | "indigo-deep"
  | "orchid-deep";

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
 *
 * That 3:1 claim used to be prose. `styles/tokens.test.ts` now asserts it over
 * every entry in both tables, so a new hue is chosen by proposing values and
 * letting the test rule on them.
 *
 * Two regularities the six new hues were derived from, read off the original
 * six rather than invented:
 *   - `-deep` here is its base minus L .130, uniformly.
 *   - Chroma is .124, *except* where sRGB cannot carry it at that lightness.
 *     `azure-deep` (.100) and `amber-deep` (.104) were already in that boat.
 *     Cyan is the worst case: at h 183/217 sRGB tops out near C .10 below
 *     L .68, so teal and sky record the chroma they actually achieve. Pushing
 *     L up to reach .124 would wash them out on paper and cost contrast.
 * Base lightness per new hue is interpolated between its two hue-wheel
 * neighbours, which is what makes the stagger continue rather than restart.
 */
export const PALETTE_LIGHT: Record<DitherColor, Seed> = {
  azure: light([22, 96, 160]),   // #1660a0  OKLCH L .48 C .124 h 250
  amber: light([181, 119, 30]),  // #b5771e  OKLCH L .62 C .124 h 70
  lilac: light([117, 86, 165]),  // #7556a5  OKLCH L .52 C .124 h 300
  sage: light([64, 148, 87]),    // #409457  OKLCH L .60 C .124 h 150
  rose: light([197, 100, 110]),  // #c5646e  OKLCH L .62 C .124 h 15
  slate: light([118, 118, 126]), // #76767e  the neutral — "everything else"
  ochre: light([195, 106, 71]),  // #c36a47  OKLCH L .62 C .124 h 42
  moss: light([136, 137, 28]),   // #88891c  OKLCH L .61 C .124 h 110
  teal: light([0, 135, 122]),    // #00877a  OKLCH L .56 C .100 h 183  (sRGB ceiling)
  sky: light([0, 118, 140]),     // #00768c  OKLCH L .52 C .095 h 217  (sRGB ceiling)
  indigo: light([80, 91, 169]),  // #505ba9  OKLCH L .50 C .124 h 275
  orchid: light([164, 88, 146]), // #a45892  OKLCH L .57 C .124 h 337
  "azure-deep": light([0, 60, 108]),   // #003c6c  OKLCH L .35 C .100 h 250
  "amber-deep": light([133, 84, 5]),   // #855405  OKLCH L .49 C .104 h 70
  "lilac-deep": light([81, 49, 124]),  // #51317c  OKLCH L .39 C .124 h 300
  "sage-deep": light([13, 109, 50]),   // #0d6d32  OKLCH L .47 C .124 h 150
  "rose-deep": light([154, 61, 73]),   // #9a3d49  OKLCH L .49 C .124 h 15
  "slate-deep": light([81, 81, 89]),   // #515159  the neutral, one step down
  "ochre-deep": light([152, 68, 31]),  // #98441f  OKLCH L .49 C .124 h 42
  "moss-deep": light([98, 98, 0]),     // #626200  OKLCH L .48 C .106 h 110  (sRGB ceiling)
  "teal-deep": light([0, 93, 84]),     // #005d54  OKLCH L .43 C .078 h 183  (sRGB ceiling)
  "sky-deep": light([0, 78, 94]),      // #004e5e  OKLCH L .39 C .072 h 217  (sRGB ceiling)
  "indigo-deep": light([47, 53, 128]), // #2f3580  OKLCH L .37 C .124 h 275
  "orchid-deep": light([123, 51, 107]),// #7b336b  OKLCH L .44 C .124 h 337
};

/**
 * Dark theme, on #141416. Same hues, re-stepped for the dark surface: each base
 * sits ~L .05 lighter than its light-table twin, and `-deep` is base *plus*
 * L .110 uniformly (see the note below).
 */
export const PALETTE_DARK: Record<DitherColor, Seed> = {
  azure: dark([44, 114, 179]),   // #2c72b3  OKLCH L .54 C .124 h 250
  amber: dark([197, 134, 50]),   // #c58632  OKLCH L .67 C .124 h 70
  lilac: dark([131, 101, 181]),  // #8365b5  OKLCH L .57 C .124 h 300
  sage: dark([83, 167, 104]),    // #53a768  OKLCH L .66 C .124 h 150
  rose: dark([204, 106, 116]),   // #cc6a74  OKLCH L .64 C .124 h 15
  slate: dark([127, 127, 135]),  // #7f7f87  the neutral
  ochre: dark([205, 115, 80]),   // #cd7350  OKLCH L .65 C .124 h 42
  moss: dark([151, 152, 49]),    // #979831  OKLCH L .66 C .124 h 110
  teal: dark([0, 156, 140]),     // #009c8c  OKLCH L .62 C .111 h 183  (sRGB ceiling)
  sky: dark([0, 137, 163]),      // #0089a3  OKLCH L .58 C .104 h 217  (sRGB ceiling)
  indigo: dark([96, 108, 188]),  // #606cbc  OKLCH L .56 C .124 h 275
  orchid: dark([174, 97, 155]),  // #ae619b  OKLCH L .60 C .124 h 337
  // On near-black the base is already the dark end, so the second step goes
  // *lighter* rather than deeper — a deeper one would collapse into the ground.
  // The deep steps reach C .124 where their light-table twins could not: the
  // sRGB cyan ceiling rises with lightness, so teal-deep and sky-deep are the
  // only fully-saturated members of those two hues in the whole palette.
  "azure-deep": dark([79, 148, 215]),   // #4f94d7  OKLCH L .65 C .124 h 250
  "amber-deep": dark([234, 168, 88]),   // #eaa858  OKLCH L .78 C .124 h 70
  "lilac-deep": dark([164, 134, 217]),  // #a486d9  OKLCH L .68 C .124 h 300
  "sage-deep": dark([118, 202, 137]),   // #76ca89  OKLCH L .77 C .124 h 150
  "rose-deep": dark([242, 140, 149]),   // #f28c95  OKLCH L .75 C .124 h 15
  "slate-deep": dark([160, 160, 169]),  // #a0a0a9  the neutral, one step up
  "ochre-deep": dark([243, 149, 113]),  // #f39571  OKLCH L .76 C .124 h 42
  "moss-deep": dark([185, 187, 86]),    // #b9bb56  OKLCH L .77 C .124 h 110
  "teal-deep": dark([35, 193, 175]),    // #23c1af  OKLCH L .73 C .124 h 183
  "sky-deep": dark([0, 173, 205]),      // #00adcd  OKLCH L .69 C .124 h 217
  "indigo-deep": dark([127, 142, 225]), // #7f8ee1  OKLCH L .67 C .124 h 275
  "orchid-deep": dark([210, 130, 190]), // #d282be  OKLCH L .71 C .124 h 337
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
