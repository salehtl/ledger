import type { DitherColor } from "../components/dither-kit/palette";

/**
 * The categorical palette, as CSS-consumer names.
 *
 * Same six hues as `palette.ts`'s `DitherColor`, which the canvas needs as raw
 * RGB. The type alias keeps the two from drifting apart in name: adding a hue
 * to the palette without adding it here is a type error.
 */
export const PALETTE_NAMES = [
  "azure", "amber", "lilac", "sage", "rose", "slate",
  "azure-deep", "amber-deep", "lilac-deep", "sage-deep", "rose-deep", "slate-deep",
] as const;

export type PaletteName = (typeof PALETTE_NAMES)[number];

// Compile-time assertion that the CSS names and the canvas seeds are the same
// set. If `DitherColor` gains or loses a member, this stops building.
const _sameAsCanvas: readonly DitherColor[] = PALETTE_NAMES;
void _sameAsCanvas;

export function isPaletteName(v: string | null | undefined): v is PaletteName {
  return !!v && (PALETTE_NAMES as readonly string[]).includes(v);
}

/**
 * CSS colour for a stored project colour.
 *
 * Projects store a palette *name* rather than a hex, because a stored hex
 * cannot follow the theme — the light-mode azure lands at 2.82:1 on the dark
 * ground, under the floor. A name becomes a `var(--color-…)` that the cascade
 * re-resolves per theme, so no consumer needs `useDitherTheme()`. Only the
 * canvas ever needs literals, and no project colour is painted on canvas.
 *
 * Values written before that change are literal hex and pass through unchanged,
 * so existing rows keep rendering. Anything else — null, empty, or a name we
 * don't know — falls back to the neutral rather than being interpolated into a
 * `var()`: `var(--color-chartreuse)` is valid CSS that resolves to nothing, and
 * the mark would silently disappear instead of degrading.
 */
export function projectColor(stored: string | null | undefined): string {
  if (isPaletteName(stored)) return `var(--color-${stored})`;
  if (stored?.startsWith("#")) return stored;
  return "var(--color-slate)";
}
