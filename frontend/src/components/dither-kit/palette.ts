// ─────────────────────────────────────────────────────────────────────────────
// FORKED FROM UPSTREAM dither-kit 0.1.0.
// Upstream ships seven hardcoded RGB seeds tuned for dark surfaces. This app has
// its own token palette and both a light and a dark theme, so the seed *values*
// carry our tokens while the seven `DitherColor` keys and the `Seed` shape are
// kept intact — every dither-kit consumer keeps working unchanged.
// A future `shadcn add --diff` will show this file as divergent. That is
// intentional; re-apply the fork rather than accepting upstream.
// ─────────────────────────────────────────────────────────────────────────────

export type Rgb = [number, number, number];

export type DitherColor =
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "orange"
  | "red"
  | "grey";

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
// which works on its dark canvas. On our warm off-white surface a lighter line
// washes out, so the light table tints toward black instead. Same relationship,
// mirrored for the background it sits on.
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

/** Light theme — values are the `@theme` tokens in styles/app.css. */
export const PALETTE_LIGHT: Record<DitherColor, Seed> = {
  blue: light([22, 22, 26]),      // --color-need   ink
  purple: light([22, 22, 26]),    // --color-want   ink
  green: light([22, 22, 26]),     // --color-save   ink
  red: light([184, 51, 29]),      // --color-bad    #b8331d
  orange: light([94, 94, 99]),    // --color-warn   #5e5e63
  pink: light([201, 61, 38]),     // --color-accent #c93d26
  grey: light([94, 94, 99]),      // --color-muted  #5e5e63
};

/** Dark theme — values are the prefers-color-scheme: dark overrides. */
export const PALETTE_DARK: Record<DitherColor, Seed> = {
  blue: dark([236, 235, 232]),    // --color-need   ink
  purple: dark([236, 235, 232]),  // --color-want   ink
  green: dark([236, 235, 232]),   // --color-save   ink
  red: dark([240, 134, 111]),     // --color-bad    #f0866f  (unchanged)
  orange: dark([139, 139, 143]),  // --color-warn   #8b8b8f
  pink: dark([201, 61, 38]),      // --color-accent #c93d26
  grey: dark([139, 139, 143]),    // --color-muted  #8b8b8f
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
