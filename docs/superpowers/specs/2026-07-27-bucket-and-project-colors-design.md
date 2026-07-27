# Bucket and project colours

**Date:** 2026-07-27
**Status:** Approved (design decisions made interactively; see Decisions)
**Trigger:** User request — "Needs, wants, transfers and savings need their
colors. i wanna allow users to select a color for their projects also."

## Problem

The two-color press overhaul retired `--color-need` / `--color-want` /
`--color-save`, flattening all three to ink. Since then the app has grown
**three different colour systems for the same concepts**:

| Surface | What it uses today |
|---|---|
| Charts, swipe deck | The validated five-hue palette in `components/dither-kit/palette.ts` |
| Everything else | `bucketColor()` → `var(--color-need\|want\|save)` → all ink `#16161a` |
| Projects | `COLOR_PRESETS` in `ProjectForm.tsx` — the pre-overhaul Material hues |

`bucketColor()` feeds six components: `TransactionRow` (the bucket dot on every
row), `FilterBar` (twice), `CategorizeSheet`, `TransactionDetailSheet`, and the
`Home` and `ComparativeSummary` legends. All of them currently paint ink, so a
bucket dot carries no information.

The second half of the request is already built: `ProjectForm.tsx` has a
six-swatch picker, `POST/PUT /api/projects` accept `color`, the store persists
it, and `ProjectCard` renders the dot. What is wrong with it is the *values* —
`#1373d9`, `#7b35b8`, `#2e7d52`, `#b45309`, `#dc2626`, `#0891b2` are the exact
tokens the overhaul retired, and `#dc2626` sits close enough to the vermilion
accent `#c93d26` to compete with the rationed spot ink.

## Decisions

1. **Bucket colours are fixed**, from the already-validated palette — not
   user-selectable. Buckets are a closed vocabulary of four, and the
   need/want/save triple was validated *as a triple* (worst adjacent ΔE 18.2
   under deuteranopia) because `ComparativeSummary` stacks them touching. An
   arbitrary user pick silently destroys that guarantee.
2. **Projects reuse the same palette and are told apart by form**, not by hue:
   a project dot is a ring, a bucket dot is a solid fill. `TransactionRow`
   renders both on one line, so hue alone cannot carry the distinction. This
   also avoids validating a second, disjoint set of hues in a design that is
   deliberately two-ink.
3. **Transfer takes the neutral slate**, matching the swipe deck. It is not real
   spending, so the neutral is the honest encoding rather than a fifth hue.

## Design

### 1. One set of palette vars; buckets alias them

`src/styles/app.css` gains the six palette hues as tokens, in both the light
`@theme` block and the `prefers-color-scheme: dark` block. These are exactly the
values `palette.ts` already carries, which is what the charts and swipe deck
paint:

| Token | Light | Dark |
|---|---|---|
| `--color-azure` | `#1660a0` | `#2c72b3` |
| `--color-amber` | `#b5771e` | `#c58632` |
| `--color-lilac` | `#7556a5` | `#8365b5` |
| `--color-sage` | `#409457` | `#53a768` |
| `--color-rose` | `#c5646e` | `#cc6a74` |
| `--color-slate` | `#76767e` | `#7f7f87` |

The retired bucket tokens then come back as **aliases**, so a bucket hue is
never a second copy of a value:

```css
--color-need:     var(--color-amber);
--color-want:     var(--color-lilac);
--color-save:     var(--color-sage);
--color-transfer: var(--color-slate);
```

Aliasing rather than repeating the hex matters for the same reason the whole
spec exists: a bucket and a project painted "amber" must be the same amber, and
the only way to guarantee that is for one of them not to hold a value.

**`bucketColor()` needs no change.** It already returns `var(--color-need)` and
friends, so all six consumers light up with no edits, and an OS theme flip is
handled natively by the cascade — no `useDitherTheme()` subscription anywhere.
This is why buckets go through CSS rather than `seedOfColor()`: only the canvas,
which paints raw RGB and cannot read a custom property, needs the literals.

`bucketColor()` gains a `transfer` case returning `var(--color-transfer)`; its
default stays `var(--color-muted)` for genuinely unknown buckets.

This reverses the overhaul's deletion of these tokens deliberately. It
implements the ruling already recorded in that overhaul's own ledger: buckets
are double-encoded by hue **and** density, because redundancy is an
accessibility win.

### 2. Keeping the two definitions honest

`app.css` and `palette.ts` will hold the same twelve values with nothing
preventing drift. A test reads the six palette declarations out of `app.css`
(both blocks) and asserts each equals the corresponding `PALETTE_LIGHT` /
`PALETTE_DARK` seed. Whoever edits one is told about the other.

A second test asserts all four bucket tokens clear 3:1 against their own
ground — the check that would have caught the rails being invisible in dark.

### 3. Projects: store the token name, not a hex

A stored literal hex cannot follow the theme, and measured against the dark
ground the light-mode presets fail:

| Preset | Light hex on `#141416` |
|---|---|
| azure `#1660a0` | **2.82:1 — under the 3:1 floor** |
| lilac `#7556a5` | 3.18:1 — marginal |
| amber, sage, rose, slate | 4.09–4.93:1 |

So `projects.color` stores a **palette token name** (`"azure"`) rather than
`"#1660a0"`. The column is already `TEXT`, and both ends of the API are ours.

A single pure helper does the resolution:

```ts
// lib/paletteColor.ts
/** CSS colour for a stored project colour. Names become palette vars, which
 *  the cascade re-resolves on a theme flip; legacy literals pass through. */
export function projectColor(stored: string | null | undefined): string
```

It returns `var(--color-azure)` for a known name, the value unchanged for
anything starting with `#`, and `var(--color-slate)` for null or an unknown
string. Because it yields a CSS var rather than a hex, a theme flip is handled
by the cascade — no consumer needs `useDitherTheme()`, matching how buckets
work. The canvas is the only thing that ever needs literals, and no project
colour is painted on canvas.

**Backward compatibility:** the `#` passthrough means the existing row and any
hand-written value keep rendering. No read path can throw on unexpected data.

`COLOR_PRESETS` becomes the six palette names. The picker keeps its current
shape (swatch buttons, `aria-pressed`, 8px targets) — only the values change,
and each swatch renders its resolved hue for the active theme.

### 4. Bucket dot solid, project dot ring

`TransactionRow` shows a bucket dot and a project chip dot on one line. The
project dot becomes a 1px ring with a transparent centre; bucket dots stay solid
fills. At identical hue the two remain unambiguous, which is what lets projects
reuse the bucket palette at all.

This applies wherever a project colour renders as a mark: `TransactionRow`,
`ProjectCard`, `SubcategoryPanel`'s project chips, and the projects screens.

### 5. Migration

Production holds exactly one project, coloured `#1373d9` (the retired Material
blue). A single `UPDATE` maps it to `azure` at deploy so no stale hex survives.
The legacy-literal path above means this is belt-and-braces rather than
load-bearing.

### 6. Testing

- `lib/insights.ts` — `bucketColor` returns the right var per bucket, including
  the new `transfer` case and the unknown-bucket default.
- Token agreement: `app.css`'s six palette declarations match `palette.ts` in
  both themes.
- `lib/paletteColor.ts` — a known name yields its var, a `#hex` passes through,
  null and unknown strings fall back to the neutral.
- Contrast: all four bucket tokens ≥ 3:1 on their own ground.
- Project colour resolution: a token name resolves per theme; a legacy `#hex`
  passes through unchanged; an unknown value falls back to the neutral.
- `ProjectForm` — picking a preset stores the name, not a hex.

## Risks

- **Reversing a documented decision.** The overhaul's spec explicitly deleted
  these tokens. Restoring them is sanctioned by the later owner ruling on
  double-encoding, but `components/README.md` and the overhaul spec both say
  buckets are told apart by density alone. Both need correcting in the same
  commit or the docs contradict the code.
- **Six components change appearance at once** without any of them being
  edited. That is the point, but it means the blast radius of a wrong value is
  the whole app rather than one screen.
