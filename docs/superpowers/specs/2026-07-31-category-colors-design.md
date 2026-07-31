# Per-category colours — design

**Date:** 2026-07-31
**Status:** approved, ready for an implementation plan

## Goal

Give every category its own colour, picked by the user, drawn from a palette large enough to cover the 21 active categories in the production database.

Today a category has no colour of its own. `categories` carries `kind`, `bucket`, `parent_id`, `is_active` and nothing else, so a category's colour is derived entirely from its bucket — every "need" renders the same amber. The only real colour picker in the app belongs to *projects* (`ProjectForm.tsx`, drawing from `PALETTE_NAMES`).

## Decisions

Four questions were settled during brainstorming:

1. **Per-category colours**, not merely a larger shared palette.
2. **The category colour replaces the bucket dot** in lists. Bucket grouping is already carried by section headers ("Needs", "Wants", "Savings") in `CategoryManager` and `PlanScreen`; the dot was doing double duty only because nothing else was available.
3. **The palette grows to 24** — 12 base names × light/deep — by extending the hue wheel rather than adding a third lightness step.
4. **Existing categories are auto-seeded**, spread around the wheel, at migration time.

## Non-goals

- Enforcing colour uniqueness across categories. With 24 slots and 21 categories, uniqueness would churn on every add for a property that stops mattering once the user has hand-picked the colours they care about.
- Free hex colours. Rejected deliberately and already documented in `lib/paletteColor.ts:26-40`: a stored hex cannot follow the theme — light-mode azure lands at 2.82:1 on the dark ground, under the floor. Colours are stored as *names* that resolve through `var(--color-…)` so the cascade re-resolves them per theme.
- Colouring subcategories differently from parents. There are currently zero subcategories in production.
- Changing `bucketColor` itself. It stays and keeps its remaining callers (Home's bucket rows legitimately colour *buckets*).

## 1. The palette: 12 base names, 24 total

The current 12 is really **5 chromatic hues plus a neutral**, each at OKLCH chroma 0.124, doubled by a light/deep lightness step:

| Name | Hue | Light value |
| --- | --- | --- |
| `rose` | 15° | `#c5646e` |
| `amber` | 70° | `#b5771e` |
| `sage` | 150° | `#409457` |
| `azure` | 250° | `#1660a0` |
| `lilac` | 300° | `#7556a5` |
| `slate` | — | `#76767e` (the neutral) |

Spacing is uneven; the largest gap is 150→250.

**All five existing hues stay exactly where they are.** Nothing stored migrates, and no existing project or chart changes appearance. Six new hues fill the largest gaps, on the same chroma:

| New name | Hue | Sits between |
| --- | --- | --- |
| `ochre` | ~42° | rose → amber |
| `moss` | ~110° | amber → sage |
| `teal` | ~183° | sage → azure |
| `sky` | ~217° | teal → azure |
| `indigo` | ~275° | azure → lilac |
| `orchid` | ~337° | lilac → rose |

11 chromatic + `slate` = 12 base names × light/deep = **24**. Resulting spacing lands between 25° and 40°.

Lightness is **not** constant across hues today (azure L.48, lilac L.52, sage L.60, amber L.62, rose L.62) — each is tuned so the hue clears its contrast floor on paper. New hues follow the same rule: L is chosen per hue to satisfy the contrast test in §2, not fixed to a constant.

The deep steps invert per theme, as they already do: on the light ground `-deep` is darker; on the near-black dark ground it goes *lighter*, because the base is already at the dark end (`styles/app.css` documents this).

### Honest limit

At 21 categories no palette makes every pair distinguishable at a glance. Colour here serves **recognition** ("that row is Groceries"), not **discrimination** ("tell these 21 apart"). Position and label carry identity. The lightness pairing continues to do the red-green colour-blindness work that the existing palette comments describe.

## 2. Contrast, made machine-checked

**This is new to the design and replaces hand-measurement.**

No contrast test exists today. The ratios recorded in `app.css` comments ("5.03:1 with white", "#b8331d is 5.27:1") were measured by hand and live only in prose. Adding 12 new values × 2 themes would mean 24 more manual measurements.

Instead, add a test asserting that **every** palette entry clears its floor against its own theme's ground:

- Floor is **3:1**, not 4.5:1. Palette hues are graphical objects — dots, chart fills, `DitherFill` backgrounds — never text. This is WCAG 1.4.11, and it is the same threshold `app.css` already cites when it rules that "neither the amber nor the red clears 3:1 on that ground".
- Ground is `--color-bg`: `#f2f1ef` light, `#141416` dark.
- The test reads the same source of truth `tokens.test.ts` already parses, so it cannot drift from what ships.

Adding a hue then becomes: propose values → run the test → nudge until green.

**Expect this to fail on existing colours first.** The test locks the current 12 retroactively, and some may not clear 3:1 — `slate` (`#76767e`) on paper is the likeliest. If an existing entry fails, that is a **finding to surface, not a value to silently change**: an existing hue is already stored on real project rows, and changing it alters data the user has already chosen. Report it and decide separately.

## 3. Storage

`categories` gains one column, via the existing `addColumn` helper in `internal/store` — additive, matching how the schema already evolves. There is no migration tool and none is added.

```sql
ALTER TABLE categories ADD COLUMN color TEXT;
```

Nullable. `NULL` means "never chosen" and resolves to the neutral, exactly as `projectColor` already handles an unknown value.

### Backfill

Run once, at migration, for rows where `color IS NULL`:

```
PALETTE_NAMES[(id * 7) % 24]
```

Seven is coprime to 24, so `id → index` is a bijection mod 24: ids 1–21 map to **distinct** slots, and consecutive ids land far apart on the wheel rather than adjacent to each other.

Because the value depends only on a row's own `id`, it is stable — adding, renaming or deleting a category never reshuffles anyone else's colour. Ids above 24 wrap and may collide with an existing assignment; that is acceptable given uniqueness is a non-goal.

## 4. API

`Category` gains a `Color` field (string, palette name, may be empty). It is:

- returned by the existing category list/read endpoints,
- accepted by the existing category update endpoint alongside `name`/`bucket`.

No new endpoint. The frontend already PUTs a category to rename or re-bucket it; colour rides the same request.

Invalid names are rejected at the API boundary rather than stored — the frontend can only send one of the 24, so a bad value means a bug or a hand-crafted request, and storing it would render as the silent-disappearance case `paletteColor.ts` warns about.

## 5. Frontend

### Keeping three files in sync

The palette lives in three places that must agree: `styles/app.css` (light and dark tables), `components/dither-kit/palette.ts` (RGB seeds the canvas needs), and `lib/paletteColor.ts` (the names). Two mechanisms already enforce this and both extend for free:

- `paletteColor.ts:19` holds a compile-time assertion pinning `PALETTE_NAMES` to dither-kit's `DitherColor`. Adding a name to one without the other is a build error.
- `tokens.test.ts` asserts `app.css` declares every hue in both themes and that the values mirror `palette.ts` exactly.

So the sync is machinery, not vigilance. All three grow to 24.

### New pure helper

`lib/categoryColor.ts`, with a co-located test, following the documented convention that decision logic lives in `lib/` and components stay thin:

```ts
categoryColor(color: string | null | undefined): string
```

Returns `var(--color-<name>)` for a known palette name, `var(--color-slate)` otherwise. Mirrors `projectColor`'s contract, including its no-interpolation rule: an unknown name must not become `var(--color-chartreuse)`, which is valid CSS that resolves to nothing and would make the mark silently vanish.

### Call sites

Replace `bucketColor(...)` with `categoryColor(...)` at the four places a *category* is rendered:

- `screens/CategoryManager.tsx:88` and `:148`
- `screens/Home.tsx:163`
- `screens/plan/PlanScreen.tsx:126`
- `screens/plan/AssignSheet.tsx:80`

`bucketColor` itself is unchanged and keeps its bucket-level callers.

### Picker

`CategoryManager`'s row editor gains a colour picker beside the existing bucket control, reusing the swatch grid pattern `ProjectForm.tsx` already established over `PALETTE_NAMES` and rendering through `components/ui/ColorSwatch`.

Two constraints, both learned the hard way in this codebase:

- **24 swatches must fit at 320px** without pushing anything past the viewport.
- **Every swatch needs a 44px tap target.** A sub-44px colour swatch was fixed in `1fb906f`, and a sub-44px segmented-control glyph in `8923ae9` — this is the third time, so the harness check matters more than the eyeball.

## 6. Testing

| What | Where |
| --- | --- |
| `categoryColor` contract, including the unknown-name fallback | `lib/categoryColor.test.ts` |
| Seed function: stable per id, distinct across 1–24, spread | co-located with the seed helper |
| All 24 declared in both themes, mirroring `palette.ts` | `styles/tokens.test.ts` (extend existing) |
| **Contrast ≥ 3:1 for all 24, both themes** | `styles/tokens.test.ts` (new, §2) |
| Additive column applies idempotently; backfill assigns distinct colours | Go store test |
| Invalid colour name rejected | Go server test |
| Picker grid fits 320px; every swatch ≥ 44px | `frontend/harness/` — `shoot.mjs` geometry audit and `probe.mjs` |

jsdom has no layout, so the geometry constraints are harness-only. That is the established division here and the reason the harness exists.

## 7. Risks

**A new test failing on existing values.** §2 covers the ruling: surface, don't silently change.

**Picker density.** 24 swatches at 44px each is 1056px of target width before gaps — it must wrap to a grid, and at 320px that is roughly six per row across four rows. Worth checking it does not dominate the row editor.

**Hue crowding.** 25–40° spacing is tighter than the current palette. `sky` (217°) and `azure` (250°) are the closest pair and the most likely to read as the same colour at dot size; if one has to go, `sky` is the one to drop, falling back to 11 base names × 2 = 22, which still covers 21.
