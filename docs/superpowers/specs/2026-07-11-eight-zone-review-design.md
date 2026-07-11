# Eight-Zone Review Categorizer — Design

**Date:** 2026-07-11
**Status:** Approved design, pre-implementation
**Area:** Frontend review page (`SwipeDeck`), swipe config, settings

## Problem

The review page (`screens/Review.tsx` → `components/swipe/SwipeDeck.tsx`) categorizes
`needs_review` transactions with a 4-direction swipe deck. Each swipe picks a *bucket*
(right=Need, left=Want, down=Save) and then opens the `SubcategoryPanel` bottom sheet to
choose the specific category — a mandatory two-step for every spending transaction. The up
swipe is a `transfer` status override.

We want to cut the common case to a single gesture by exposing **specific categories** as
swipe targets, while keeping the bottom sheet only as an overflow fallback (the user
prefers swipe over bottom-sheet-everything).

## Goal

Turn each card's 4 edges into **8 category zones** (2 per edge) plus a slim **"Other"**
sliver per edge. One angled swipe assigns a specific category and advances; a straight
swipe into an edge's sliver opens the existing bottom sheet filtered to that edge's group.

## Layout

Each edge = one category group, split into two full-size category slots plus a thin
central "Other" sliver:

```
                       up edge  (Income / Excluded)
              ┌───────────────────────────────┐
              │   Salary    │   Reimburse      │   ← slot A / slot B
              │ · · · · · Other · · · · ·      │   ← slim sliver → sheet
    ┌─────────┼───────────────────────────────┼─────────┐
  W │ Dining  │                               │ Groceries│ N
  A │─────────│          STARBUCKS            │──────────│ E
  N │ Shopping│          −24.00 AED           │ Transport│ E
  T │ ··Ot··  │                               │  ··Ot··  │ D
    └─────────┼───────────────────────────────┼─────────┘
              │ · · · · · Other · · · · ·      │
              │   Savings   │   Invest         │
              └───────────────────────────────┘
                     down edge  (Save)
```

Edge → group mapping (fixed, preserves color/muscle memory):

| Edge  | Group           | Bucket color token | Slot A default | Slot B default |
|-------|-----------------|--------------------|----------------|----------------|
| right | Need            | blue `#2563eb`     | top Need cat   | 2nd Need cat   |
| left  | Want            | violet `#7c3aed`   | top Want cat   | 2nd Want cat   |
| down  | Save            | green `#059669`    | top Save cat   | 2nd Save cat   |
| up    | Income/Excluded | slate `#64748b`    | Transfers      | Reimbursement  |

"Top category" defaults are seeded from the seed order of each bucket (usage-based
ranking is out of scope this round); the user can override every slot in settings.

## Interaction / gesture geometry

Extend the pure geometry in `lib/swipe.ts`. On drag release with magnitude ≥
`SWIPE_THRESHOLD` (80px, unchanged):

1. `angle = atan2(dy, dx)` in degrees (screen coords: +dy is down).
2. **Edge** = nearest cardinal within ±45°:
   - right: −45°..45°, down: 45°..135°, left: 135°..180° ∪ −180°..−135°, up: −135°..−45°.
3. Within the edge's 90° arc:
   - **|offset from the cardinal axis| ≤ `SLIVER_HALF_ANGLE` (default 8°)** → the edge's
     **Other** sliver (opens the sheet).
   - Otherwise the half nearer one adjacent edge → **slot A**, the other half → **slot B**.
     Convention documented and unit-tested: for each edge, the counter-clockwise half
     (toward the "earlier" adjacent edge) is slot A.

A new pure resolver `resolveZone(dx, dy, config, threshold?)` returns a discriminated
result: `{ kind: 'category', edge, slot, categoryId }` | `{ kind: 'other', edge, group }`
| `null`. `previewZone(dx, dy, config)` mirrors it at the lower 20px preview threshold for
live edge/slot highlighting. The old `detectDirection`/`previewDirection` are removed once
callers migrate (they are internal to the swipe package).

## Config model & migration

`SwipeConfig` is versioned and restructured:

```ts
export type EdgeKey = 'up' | 'down' | 'left' | 'right'
export type EdgeGroup = 'need' | 'want' | 'saving' | 'other' // 'other' = income+excluded

export interface EdgeConfig {
  group: EdgeGroup       // fixed per edge (right=need, left=want, down=saving, up=other)
  slotA: number          // category ID
  slotB: number          // category ID
}

export interface SwipeConfig {
  version: 2
  edges: Record<EdgeKey, EdgeConfig>
}
```

- `buildDefaultConfig(categories)` seeds slot A/B per edge from the group's active
  categories (spending buckets for need/want/saving; income+excluded for `other`),
  falling back gracefully when a bucket has < 2 categories (slot B repeats slot A or the
  slot is treated as empty and only the Other sliver shows).
- `loadSwipeConfig(categories)` reads `localStorage['ledger-swipe-config']`. If the stored
  blob lacks `version: 2` (the old 4-`SwipeAction` shape), it is **discarded** and rebuilt
  from defaults — there were no per-slot customizations to preserve. Corrupt data also
  falls back to defaults.
- `saveSwipeConfig` unchanged (same key, new shape).
- Colors derive from `group` via the existing `BUCKET_COLOR` map (add an `other`/slate
  entry). A slot's label comes from its category name.

## Component changes

- **`SwipeCard.tsx`** — each `EdgeRail` renders **3 segments** (slot A, slot B, thin
  Other) with the group color and per-slot labels. Live drag highlights the specific
  segment via `previewZone`. The confirming badge shows the resolved category (or "Other").
  Existing drag translate/rotate/fly-out, reduced-motion, and ghost-card depth are reused.
- **`SwipeDeck.tsx`** — `handleDirectionCommit` becomes `handleZoneCommit(zone)`:
  - `kind: 'category'` → `POST /api/transactions/:id/categorize { category_id, merchant_raw, make_rule }`, fly out, advance (same as today's `handleCategorySelect`).
  - `kind: 'other'` → open `SubcategoryPanel` filtered to the edge's group (spending bucket, or income+excluded for the `other` edge), preserving the "always use this category for this merchant" checkbox.
  - The dedicated `transfer` status path is **removed**; "Transfers" is now a normal
    (excluded) category on the up edge, assigned via `/categorize`. Excluded/income
    categories have `bucket = NULL` so they stay out of the 50/30/20 jars exactly as a
    transfer did — no budget regression.
  - Triple-tap skip, refund detection / `LinkRefundSheet` unchanged.
- **`SubcategoryPanel.tsx`** — accepts a `group` (bucket **or** income/excluded) rather
  than only a spending bucket, so the up-edge Other sliver can list income+excluded
  categories. Filter widens accordingly.
- **`settings/SwipePage.tsx`** — replace the 4-direction bucket editor with a per-slot
  category picker: for each edge (Need/Want/Save/Income-Excluded) two dropdowns (slot A,
  slot B) populated with that group's active categories. Persists via `saveSwipeConfig`.

## Backend

No changes. All 8 zones and the 4 slivers use existing endpoints
(`POST /api/transactions/:id/categorize`). The transfer-status endpoint
(`POST /api/transactions/:id/status`) is simply no longer called from the deck; it remains
for any other callers.

## Testing

- **`lib/swipe.test.ts`** — angle sweep across the full circle mapping to the correct
  edge/slot/Other; sliver boundary at ±`SLIVER_HALF_ANGLE`; slot A/B convention per edge;
  sub-threshold → null; `buildDefaultConfig` seeding incl. < 2-category buckets;
  `loadSwipeConfig` migration (v1 blob → defaults) and corrupt-data fallback.
- **`SwipeDeck` tests** — category zone commit posts the right `category_id`; Other sliver
  opens the panel with the correct group filter; existing refund test still passes.
- **`SubcategoryPanel.test.tsx`** — income/excluded group filter.
- **`SwipePage`** — slot edits persist and reload.
- `bun run test` (single non-parallel fork) green; rebuild embedded `dist` before finish.

## Out of scope

- Usage-based "top category" ranking (defaults use seed order this round).
- Reordering which edge maps to which bucket (edge→group stays fixed).
- Any backend / data-model change.
