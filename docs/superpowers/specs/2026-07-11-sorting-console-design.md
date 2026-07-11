# Review "Sorting Console" — Design

**Date:** 2026-07-11
**Status:** Approved design (v3 of the interactive prototype), pre-implementation
**Area:** Frontend review screen — full-bleed redesign of the swipe deck

## Problem

The review deck (`screens/Review.tsx` → `components/swipe/SwipeDeck.tsx`) is a small
`max-w-sm` centered card with four thin edge "rails". It underuses the screen and the
bucket zones are barely visible. We want a full-bleed, immersive sorting surface where the
four buckets are large, glowing facets around a floating card, and the *depth* of a swipe —
not a center-vs-angle sliver — decides between a quick top category and the bucket's full
category list.

This supersedes the angle-sliver "Other" mechanic shipped in
`2026-07-11-eight-zone-review-design.md`. The **config model is unchanged** (4 edges × 2
category slots, versioned localStorage); only the *gesture geometry* and the *presentation*
change.

## The interaction — depth = commit strength

A single drag of the centered card:

- **Angle → which bucket** (unchanged ±45° arcs) and, when deep, **which of its 2 category
  slots** (cardinal-axis split: for left/right edges `dy<0`=slot A else B; for up/down
  edges `dx<0`=slot A else B). No center sliver.
- **Distance → intent:**
  - `< OTHER_MIN` (~30px) → cancel, spring back.
  - `OTHER_MIN ≤ dist < CATEGORY_MIN` (~30–150px) → that bucket's **Other**: release opens
    the existing `SubcategoryPanel` filtered to the bucket's group, listing *all* its
    categories to choose from.
  - `≥ CATEGORY_MIN` (~150px) → commit the specific **category** in the aimed slot. An
    empty slot (id 0) falls back to Other.

Edge→group is fixed: right=Need, left=Want, down=Save, up=Income/Excluded.

## The surface — immersive graphite console

Full-bleed. While sorting, the review screen is a dark **graphite** environment regardless
of the app's light/dark theme (a deliberate, focused "cockpit" distinct from the calm
lists elsewhere), so the four bucket hues glow.

**Geometry (v3 of the prototype):** a modest card floats dead-center. The space around it
is four **corner-to-corner mitered trapezoids** — each facet spans from the card's edge out
to the console edge, its slanted sides running along the diagonals from card corners to
console corners. (Top/bottom facets are naturally deeper than left/right; that is accepted —
it is the v3 look the user approved. Depth uniformity is explicitly **not** a goal.)

Each facet:
- is filled with its **bucket color**, faint at rest, brightening as the gesture aims at it;
- is split down its cardinal centerline into **two category halves** (slot A / slot B), each
  labeled with its category name (uppercase, tracked, small — control-panel legends);
- carries a shallow **Other slice** hugging the card — a trapezoid parallel to the card edge
  whose outer edge follows the same miter slant (not a plain rectangle), labeled "Other…".

**Palette (graphite console, facets glow):**
| token | value | use |
|-------|-------|-----|
| console | `#0E1116` | base ground |
| floor | `#151A21` | facet floor fill |
| card | `#F7F8FA` | the floating card (dark ink `#14171F`) |
| Need | `#3B82F6` | right facet |
| Want | `#8B5CF6` | left facet |
| Save | `#10B981` | down facet |
| Income/Other | `#94A3B8` | up facet (slate, brightened for legibility on graphite) |

**Type:** amount uses the app's existing rounded face (`font-rounded`), oversized — the one
warm voice. Merchant: medium sans. Legends: uppercase, `letter-spacing: 0.14em`, ~10px.

**Motion / signature.** The aimed facet ignites: on a shallow aim the Other slice glows; as
the drag deepens the light travels out to the specific category half and its legend swells.
The card rings in the target color and tilts toward the facet; release commits with a single
feedback cue and the card flies toward that facet. Reduced-motion → opacity only, no tilt.

**Chrome.** While a card is live (queue non-empty), the app title bar and bottom nav fade
out for a true-fullscreen sort; they fade back when the queue is empty (or on tap of the
card). The immersive graphite applies only to the review screen.

## Architecture

Keep components thin; put the two hard, pure pieces in unit-tested `lib/` helpers (repo
convention).

- **`lib/swipe.ts`** — replace the angle-sliver `resolveZone` with **depth-based**
  resolution and add a richer `previewState` for facet lighting. Constants: `OTHER_MIN`,
  `CATEGORY_MIN`, `CAT_FULL` (remove `SLIVER_HALF_ANGLE`). Config types/`buildDefaultConfig`/
  `loadSwipeConfig`/`saveSwipeConfig` are unchanged.
- **`lib/facets.ts`** (new) — pure geometry. Given arena `{w,h}` and the centered card size,
  compute the 8 category-half polygons, the 4 Other-slice trapezoids (mitered), and legend
  anchor points. Framework-free, fully unit-tested.
- **`components/swipe/SwipeConsole.tsx`** (new) — renders the graphite console, the SVG
  facets + legends from `facets.ts`, and lights regions from `previewState`. Owns the SVG.
- **`components/swipe/SwipeCard.tsx`** — depth-based feedback: report raw `dx,dy`, ring/tilt
  by depth, fly toward the committed edge.
- **`components/swipe/SwipeDeck.tsx`** — full-bleed; composes `SwipeConsole` + card; routes
  commit (`category` → `POST /categorize`; `other` → open `SubcategoryPanel` for the group);
  drives the fullscreen-chrome signal.
- **`components/swipe/SubcategoryPanel.tsx`** — reused unchanged (already filters by group,
  incl. income/excluded).
- **App chrome** — `Review.tsx` wraps the deck in the immersive-graphite container and
  signals "sorting active" to `AppShell.tsx`, which hides title/nav while active.
- **Settings** — unchanged. The config shape (2 category slots per edge) is identical; the
  existing `settings/SwipePage.tsx` still applies.

## Backend

None. All commits use the existing `POST /api/transactions/:id/categorize`.

## Out of scope

- Uniform-depth walls (explicitly rejected — v3's corner-to-corner facets are the design).
- Changing the swipe config model or settings UI.
- Any backend / data-model change.
