# UI overhaul: two-color press

**Date:** 2026-07-27
**Status:** design approved, not yet planned
**Scope:** frontend styling only — tokens, typography, surfaces, app chrome. No
component API changes, no IA changes, no backend work.

## Why

The app is functional and clear but reads as Android Material, because it was
built from Material's vocabulary. That is visible in the tokens themselves:
`app.css` annotates its roles `onSurface`, `onSurfaceVariant`, `outlineVariant`,
names `--color-want` *"tertiary purple"*, sets `--radius-card: 8px /* Material
"large", sharpened */`, and pairs Inter with Roboto Mono — Roboto being the
Material typeface. On top of that sit `shadow-1` elevation, a three-step tonal
surface ladder, and a circular FAB.

The goal is a polished, mature, opinionated aesthetic that keeps the current
legibility and clarity. Legibility is the constraint that governs every choice
below; where the direction and legibility conflict, legibility wins.

## Direction

**Two-color press.** Black plus one spot ink on paper, the way a bank advice
slip prints. The app is called *ledger*, it is fed by bank advice emails, and
dither-kit's ordered dithering is the same visual family as dot-matrix and
newsprint halftone. The identity is drawn from that world — it is not a costume
of it. No receipt borders, no perforations, no retro filter.

The boldness is spent in one place: **texture**. Everything around it stays
quiet.

## Tokens

### Light

| Role | Value |
| --- | --- |
| `--color-paper` | `#f2f1ef` |
| `--color-ink` | `#16161a` |
| `--color-ink-muted` | `#5e5e63` |
| `--color-rule` | `#d6d5d1` |
| `--color-track` | `#e3e2de` |
| `--color-spot` | `#d8452c` |
| `--color-spot-fg` | `#ffffff` |

### Dark

| Role | Value |
| --- | --- |
| `--color-paper` | `#141416` |
| `--color-ink` | `#ecebe8` |
| `--color-ink-muted` | `#8b8b8f` |
| `--color-rule` | `#2b2b2f` |
| `--color-track` | `#232326` |
| `--color-spot` | `#d8452c` |
| `--color-spot-fg` | `#ffffff` |

**Rule: in dark, vermilion is a fill only — never text.** `#d8452c` on `#141416`
is roughly 4.1:1, under AA for body text. It is legal as a background behind
white, and as a 2px marker. Any red *label* in dark is a bug.

**Rule: red is rationed.** Vermilion appears on the primary action, the create
plate, the active-tab marker, and the review badge. It does not appear on chips,
pills, rows, or category marks. If red is on screen more than three times at
once, something has gone wrong.

The `need` / `want` / `save` hues are **deleted**, not remapped — see Signature.
Semantic `good` / `warn` / `bad` are also deleted; over-budget is expressed as
texture, and success and warning states resolve to ink and ink-muted.

Two components depend on those deleted hues and need an explicit resolution:

- **`ProgressBar`** currently picks tone automatically (green <80%, amber <100%,
  red ≥100%). Tone becomes density: dotted under budget, solid ink at or over.
  The pace marker stays, as a 1px rule.
- **`Pill`** currently carries five semantic tones. They collapse to three:
  ink (default), ink-muted (low emphasis), and spot (needs attention). Status
  meaning that can no longer be carried by colour moves into the label text.

### Token naming

**Keep the existing token names wherever the role survives** — `--color-bg`,
`--color-fg`, `--color-muted`, `--color-border`, `--color-accent`,
`--color-accent-fg` all keep their names and take new values. Renaming them to
`paper`/`ink`/`rule` would churn every `bg-bg`, `text-fg` and `border-border`
class in the app for no functional gain. The names above describe roles, not the
final variable names.

Only these actually change shape: `--color-surface` and `--color-surface-2`
collapse into `--color-bg` (retire both, or keep `--color-surface` as an alias
for the Dialog surface); `--color-need` / `--color-want` / `--color-save` and
`--color-good` / `--color-warn` / `--color-bad` are retired; `--color-hero` and
`--color-hero-fg` fold into `--color-accent` / `--color-accent-fg`.

## Typography

Swap `@fontsource-variable/inter` and `@fontsource-variable/roboto-mono` for
`@fontsource-variable/geist` and `@fontsource-variable/geist-mono` (both 5.3.0).
Retire `--font-rounded` entirely — the SF Pro Rounded swipe-deck amount is a soft
flourish that fights this register.

**The division of labour is the point:** Geist Sans takes prose, merchant names,
and titles. Geist Mono takes *everything else* — every figure, date, category
label, count, eyebrow, chart axis, and nav label. Geist alone is a neutral
grotesk and will read as Inter by another name; pushing Mono well past a
"figures" role is what produces the technical, ledger-like register.

| Role | Face | Size | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Hero amount | Mono | 32px | 500 | -0.02em |
| Screen title | Sans | 16px | 600 | -0.015em |
| Row primary | Sans | 14px | 500 | -0.01em |
| Row meta | Mono | 10px | 400 | 0.04em |
| Eyebrow / label | Mono | 10px | 500 | 0.14em, uppercase |
| Nav label | Mono | 8px | 500 | 0.10em, uppercase |
| Button | Sans | 13px | 500 | normal |

## Surfaces

- **`shadow-1` is removed.** Separation comes from 1px `--color-rule` hairlines.
- **The tonal ladder collapses.** `bg` / `surface` / `surface-2` become one
  paper. Cards are paper bounded by rules, not tinted planes.
- **One shadow token survives, for `Dialog` only** — a sheet must read as above
  the page. Its value is chosen during implementation; the requirement is that it
  is the *only* shadow in the app, and that no other surface uses it.
- **Radius:** `--radius-card` 8px → **3px**, applied to cards, controls and the
  plate. `--radius-sheet` stays **12px** so drag-to-dismiss still reads as iOS.

## Chrome

- **FAB → squared plate.** Square, shadowless, vermilion, flush to the 16px
  content margin rather than floating free. It must not grow a tint or shadow on
  scroll; if it needs separation from content beneath it, that is a layout
  problem, not an elevation problem.
- **BottomNav keeps all five tabs.** Hairline top rule, no elevation, no tint
  step. The active tab is marked by a 2px vermilion tick at the top edge, not by
  a filled pill. Labels are Geist Mono micro-caps.
- **TopBar** keeps its title and period stepper; its actions become Geist Mono
  micro-caps.

## Signature: density, not hue

**The 50/30/20 buckets are encoded by dither density rather than colour.** Needs
densest, wants medium, saving sparsest. This is the one memorable element and
the reason the palette can collapse to two inks — texture takes over the job
colour was doing.

**Overspend is a texture change, not a colour change.** A bucket under budget is
dotted; a bucket at or over budget fills to flat solid ink. This reads as *full*,
needs no second red, and reuses the density system rather than adding a rule to
it.

Constraints on the signature:

- Density is never the sole encoding. Bucket names stay visible next to every
  bar, and amounts stay in text.
- `DitherFill` is `aria-hidden` today because callers state the value in text.
  That stays true.

## Implementation notes

- `components/charts/DitherFill.tsx` already paints the same Bayer matrix
  horizontally, so budget bars need no new rendering path. But it keys each
  segment on a `DitherColor` (`segments: { value, color }[]`), so **density
  encoding requires extending `dither-paint.ts` and `palette.ts`** to accept a
  density or pattern per segment. This is the largest single piece of work.
- `palette.ts` is a deliberate fork carrying light and dark tables. It is the
  right place for the new tokens; see `components/dither-kit/README.md` before
  running `shadcn add --diff` against it.
- `app.css` aliases shadcn token names (`--color-foreground`,
  `--color-muted-foreground`, `--color-popover`, `--color-popover-foreground`)
  for dither-kit's vendored chrome. These must be remapped onto the new tokens,
  not deleted.
- `components/README.md` is the UI catalog and must be updated in the same work:
  its Conventions section names tokens, elevation and radius directly.
- Colocated `*.test.tsx` files are the behavioural spec. Expect churn wherever a
  test asserts a colour class or a token name.

## Explicitly unchanged

`.press` feedback, 44px touch targets (and the sanctioned 36px exceptions), 16px
inputs, haptics via `lib/feedback`, `.tnum` tabular figures, Dialog-only
overlays, the swipe gesture geometry, and all component APIs.

## Out of scope

- **Base UI.** Deferred deliberately. It ships behaviour, not appearance, and
  cannot affect this work. Revisit when a Popover, Menu, or Combobox is actually
  needed, on its own branch, after `1.0.0` drops the `-rc`.
- **A shadcn registry for this project.** Explored and dropped.
- Any change to layout, information architecture, or navigation structure.

## Risks to verify on a real device

1. **Moiré.** Dither at bucket-bar and pill sizes on a high-DPI phone can
   shimmer. Verify before committing to the density encoding at small sizes.
2. **Overspend legibility.** Solid-fill-means-over is untested against habit.
   It must read as "over" at a glance, without a legend.
3. **Night legibility.** D1 is the high-contrast dark ground. Confirm it is not
   harsh in a dark room; the fallback is lifting `--color-paper` toward a warmer
   graphite.
