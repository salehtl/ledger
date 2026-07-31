import type { DitherColor } from "../components/dither-kit/palette";

/**
 * The categorical palette, as CSS-consumer names.
 *
 * Same twelve hues as `palette.ts`'s `DitherColor`, which the canvas needs as
 * raw RGB. The type alias keeps the two from drifting apart in name: adding a
 * hue to the palette without adding it here is a type error.
 *
 * ORDER IS LOAD-BEARING, in two ways:
 *
 *  1. All twelve base names first, then all twelve `-deep` steps. The category
 *     colour backfill seeds from `PALETTE_NAMES[(id * 7) % 24]` and relies on
 *     walking bases and deeps as one even ring; interleaving them would hand
 *     consecutive ids the same hue at two lightnesses.
 *  2. The first six of each half are the original palette, in their original
 *     positions. Nothing stores an index today — projects store the *name* —
 *     but keeping them put means a diff of this array reads as "six added"
 *     rather than "everything moved".
 *
 * Hue-wheel order would make a nicer swatch grid than append order does; that
 * is the picker's problem to solve at render time, not a reason to renumber the
 * ring the backfill walks.
 */
export const PALETTE_NAMES = [
  "azure", "amber", "lilac", "sage", "rose", "slate",
  "ochre", "moss", "teal", "sky", "indigo", "orchid",
  "azure-deep", "amber-deep", "lilac-deep", "sage-deep", "rose-deep", "slate-deep",
  "ochre-deep", "moss-deep", "teal-deep", "sky-deep", "indigo-deep", "orchid-deep",
] as const;

export type PaletteName = (typeof PALETTE_NAMES)[number];

/**
 * The same twenty-four names, ordered around the hue wheel, for a swatch grid.
 *
 * `PALETTE_NAMES` is append order and has to stay that way — the category
 * colour backfill walks it as a ring (see the note above), so renumbering it
 * would re-seed every category. But append order makes a poor picker: the six
 * hues added later all land in a block after the original six, so azure sits
 * beside amber and the grid reads as two unrelated batches rather than a
 * spectrum.
 *
 * So the picker sorts a *copy*. Hues run rose (15°) → orchid (337°) with the
 * neutral last, bases first and then the deep steps in the same order. At the
 * six-per-row the 320px viewport allows, that puts each row on a contiguous
 * arc and stacks each base directly above its own deep step.
 *
 * Kept honest by `paletteColor.test.ts`, which asserts this is a permutation of
 * `PALETTE_NAMES` — adding a hue to one without the other fails there rather
 * than silently dropping a colour the user can no longer pick.
 */
export const PALETTE_DISPLAY_ORDER = [
  "rose", "ochre", "amber", "moss", "sage", "teal",
  "sky", "azure", "indigo", "lilac", "orchid", "slate",
  "rose-deep", "ochre-deep", "amber-deep", "moss-deep", "sage-deep", "teal-deep",
  "sky-deep", "azure-deep", "indigo-deep", "lilac-deep", "orchid-deep", "slate-deep",
] as const satisfies readonly PaletteName[];

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

/**
 * CSS colour for a categorical palette hue.
 *
 * No fallback branch, unlike `projectColor`: the compile-time assertion above
 * pins `PALETTE_NAMES` to `DitherColor`, so a `DitherColor` is always a name
 * with a matching `--color-…` var in both the light and dark tables.
 *
 * Anything painted in the DOM rather than on canvas should come through here,
 * so an OS theme flip is handled by the cascade instead of a `useDitherTheme()`
 * subscription and a repaint.
 */
export function hueVar(color: DitherColor): string {
  return `var(--color-${color})`;
}
