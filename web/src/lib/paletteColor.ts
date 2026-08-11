import type { DitherColor } from "../components/dither-kit/palette";

/**
 * The categorical palette, as CSS-consumer names.
 *
 * Same twenty-four hues as `palette.ts`'s `DitherColor`, which the canvas needs
 * as raw RGB. The pair of assertions below keeps the two from drifting apart in
 * either direction — adding a hue to one list without the other is a type
 * error. One assertion alone would only catch one of the two directions; see
 * the note there.
 *
 * ORDER IS LOAD-BEARING, in two ways:
 *
 *  1. All twelve base names first, then all twelve `-deep` steps. v1's category
 *     colour backfill seeded from `PALETTE_NAMES[(id * 7) % 24]` and needed
 *     bases and deeps to form one even ring, but that backfill left with the
 *     repo split (see the note below) and constrains nothing here now.
 *
 *     Be precise about what still depends on the halves, because it is less
 *     than it used to be: no v2 code renders them as halves. The one surviving
 *     picker (`screens/projects/ProjectForm.tsx`) maps THIS array into a
 *     `flex flex-wrap` container, so order decides only the sequence swatches
 *     appear in, not any row structure. What the halves feed is
 *     `PALETTE_DISPLAY_ORDER`, whose base/deep pairing is derived from them and
 *     asserted in `paletteColor.test.ts` — and that array is itself currently
 *     unrendered (see its own note). So: keep the shape, but keep it for the
 *     reason in point 2, not because a grid depends on it.
 *  2. The first six of each half are the original palette, in their original
 *     positions. Nothing stores an index — projects and categories store the
 *     *name* — but keeping them put means a diff of this array reads as "six
 *     added" rather than "everything moved".
 *
 * Hue-wheel order would make a nicer swatch grid than append order does; that
 * is the picker's problem to solve at render time, not a reason to renumber
 * this array.
 *
 * THIS PALETTE IS TS-AUTHORITATIVE, AND NOTHING CROSS-CHECKS IT — and this note
 * governs every mention of Go, of a backfill, or of a server-side colour check
 * anywhere above. The guard that read `internal/store/categories.go` and held
 * that Go list against this one died with the repo split (2026-08-11): that
 * list, and the backfill and reject-unknown-colour API guard it served, are
 * v1's. v2 has no cross-language palette contract to replace it — the client
 * fold accepts any non-empty string as a category colour
 * (`applyCategoryDefined` in `client/src/replay/replay.ts`), so an unrecognised
 * name is not refused anywhere; it reaches `categoryColor` and renders as the
 * neutral. Adding a hue therefore means adding it here, to `palette.ts` and to
 * `app.css`, with `tokens.test.ts` the only thing checking the last two.
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
 * NOTHING RENDERS THIS ARRAY TODAY. Its only consumer was `CategoryManager`,
 * which mapped it at line 367 and was deleted on 2026-08-10 (`cca2da8`, the
 * removal of the v1 Settings cluster that `V2Settings` superseded). It survives
 * in v1's tree, where that screen still lives. Outside its own declaration and
 * `paletteColor.test.ts` it now has no reader in `web/src` — verified by grep,
 * and worth re-checking before trusting any sentence below.
 *
 * It is kept rather than deleted because the ordering problem it solves is real
 * and will recur the moment v2 grows a category-colour picker. `PALETTE_NAMES`
 * is append order: the six hues added later all land in a block after the
 * original six, so azure sits beside amber and a grid of it reads as two
 * unrelated batches rather than a spectrum. This array is the sorted copy —
 * hues running rose (15°) → orchid (337°) with the neutral last, bases first
 * and then the deep steps in the same order. Rendered six-per-row, which is
 * what a 320px viewport fits, that puts each row on a contiguous arc and stacks
 * each base directly above its own deep step.
 *
 * That last property is a claim about a grid nobody currently draws. The
 * surviving picker, `screens/projects/ProjectForm.tsx`, maps `PALETTE_NAMES`
 * into a `flex flex-wrap` container instead, so it shows neither the hue-wheel
 * order nor the base-above-deep pairing. A future picker wanting either should
 * render THIS array in a six-wide grid.
 *
 * Kept honest by `paletteColor.test.ts`, which asserts this is a permutation of
 * `PALETTE_NAMES` — adding a hue to one without the other fails there rather
 * than silently dropping a colour a picker could never offer.
 */
export const PALETTE_DISPLAY_ORDER = [
  "rose", "ochre", "amber", "moss", "sage", "teal",
  "sky", "azure", "indigo", "lilac", "orchid", "slate",
  "rose-deep", "ochre-deep", "amber-deep", "moss-deep", "sage-deep", "teal-deep",
  "sky-deep", "azure-deep", "indigo-deep", "lilac-deep", "orchid-deep", "slate-deep",
] as const satisfies readonly PaletteName[];

// Compile-time assertion that the CSS names and the canvas seeds are the same
// set. It takes TWO checks, because assignability is one-directional and each
// catches the opposite drift:
//
//  1. A name here that `DitherColor` lacks fails the assignment below (TS2322).
//  2. A `DitherColor` member that is missing here is NOT caught by that — a
//     narrower array is still assignable to a wider element type, so it
//     compiles clean. The `Exclude` line is what closes it.
//
// (2) is the direction that actually bites: `palette.ts` is vendored registry
// source, and re-forking it against `shadcn add --diff` is exactly the
// operation that adds a hue on the canvas side alone. Such a hue reaches
// `hueVar`, which interpolates it into `var(--color-newname)` — valid CSS that
// resolves to nothing, so the mark silently disappears. Every loop in
// `tokens.test.ts` iterates `PALETTE_NAMES` and is structurally blind to it.
const _sameAsCanvas: readonly DitherColor[] = PALETTE_NAMES;
void _sameAsCanvas;
const _noExtraCanvasHues: [Exclude<DitherColor, PaletteName>] extends [never] ? true : never = true;
void _noExtraCanvasHues;

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
 * No fallback branch, unlike `projectColor`, and the reason is narrower than it
 * looks. What makes a bare interpolation safe here is specifically the
 * `Exclude<DitherColor, PaletteName>` assertion above: it is the one that rules
 * out a `DitherColor` this file has never heard of. The other assertion runs
 * the opposite way (every `PALETTE_NAMES` entry is a `DitherColor`) and would
 * happily let a canvas-only hue through this function as
 * `var(--color-newname)`. With both in place, a `DitherColor` is always a name
 * `tokens.test.ts` has checked has a `--color-…` var in the light and dark
 * tables both.
 *
 * Anything painted in the DOM rather than on canvas should come through here,
 * so an OS theme flip is handled by the cascade instead of a `useDitherTheme()`
 * subscription and a repaint.
 */
export function hueVar(color: DitherColor): string {
  return `var(--color-${color})`;
}
