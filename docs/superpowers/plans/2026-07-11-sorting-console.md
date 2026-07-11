# Review "Sorting Console" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rebuild the review deck as a full-bleed immersive "sorting console" — a floating card inside four glowing mitered bucket facets, where swipe *depth* chooses between a bucket's Other picker (short push) and a specific category (long push).

**Architecture:** Two pure, unit-tested `lib/` helpers do the hard work — `swipe.ts` (depth-based gesture resolution + facet lighting state) and `facets.ts` (SVG polygon geometry). Thin components render them: `SwipeConsole` (the SVG facet layer), `SwipeCard` (the draggable card), `SwipeDeck` (composition + commit routing), and app-chrome changes for immersive graphite + fullscreen. The swipe **config model is unchanged**; only geometry and presentation change. Backend untouched.

**Design reference:** `docs/superpowers/reference/sorting-console-prototype.html` is a working interactive prototype. Its `resolveEdge`, depth thresholds, facet-half polygons, mitered Other-slice math, facet-lighting, card ring/tilt/fly, and the Other picker sheet all port directly — consult it for exact geometry and visual values. **Note:** the prototype sizes its console to the card + a uniform border for previewing; in the real app the console simply fills the screen area and the card is a modest centered rect (this yields the intended v3 corner-to-corner look automatically). Use the real arena size; ignore the prototype's console-sizing.

**Tech Stack:** React 18 + TypeScript + Vite, TanStack Query, Tailwind v4, lucide-react, vitest/jsdom, bun.

## Global Constraints

- Money untouched; UI/gesture only.
- Frontend vitest runs a single non-parallel fork (`vite.config.ts`) — don't change it.
- One test file: `cd frontend && bunx vitest run src/path/File.test.tsx`.
- `lib/` files omit semicolons, 2-space indent. Components use semicolons where the existing file does (match each file).
- `internal/web/dist/` is a committed artifact — rebuild once at the end (Task 7), not per task.
- Bucket colors on the graphite console (brightened from the app tokens for glow): Need `#3B82F6`, Want `#8B5CF6`, Save `#10B981`, Other/Income `#94A3B8`. Console base `#0E1116`, facet floor `#151A21`, card `#F7F8FA` (ink `#14171F`).
- Depth thresholds (px, drag distance from card center): `OTHER_MIN = 30`, `CATEGORY_MIN = 150`, `CAT_FULL = 90`.
- Config model (4 edges × 2 category slots, versioned localStorage) is unchanged. Settings (`settings/SwipePage.tsx`) is unchanged.
- The Other picker reuses `components/swipe/SubcategoryPanel.tsx` unchanged (it already filters by `EdgeGroup`).

---

## File Structure

- `frontend/src/lib/swipe.ts` — **modify**: replace angle-sliver resolution with depth-based `resolveZone`; add `previewState`; new depth constants; remove `SLIVER_HALF_ANGLE`/`SWIPE_THRESHOLD`/`previewZone`/`overlayProgress`/`deviation`/`zoneAt`. Keep config types & functions, `resolveEdge`, `GROUP_COLOR`, `GROUP_ICON`.
- `frontend/src/lib/swipe.test.ts` — **modify**: depth-based tests.
- `frontend/src/hooks/useSwipeGesture.ts` — **modify**: gate commit on `OTHER_MIN`.
- `frontend/src/lib/facets.ts` — **create**: pure SVG facet geometry + tests.
- `frontend/src/lib/facets.test.ts` — **create**.
- `frontend/src/components/swipe/SwipeConsole.tsx` — **create**: SVG facet layer, lit by `previewState`.
- `frontend/src/components/swipe/SwipeCard.tsx` — **modify**: depth feedback (ring/tilt/fly), reports `previewState`.
- `frontend/src/components/swipe/SwipeDeck.tsx` — **modify**: full-bleed composition, arena measure, commit routing.
- `frontend/src/screens/Review.tsx` — **modify**: full-bleed immersive-graphite container; expose `immersive`/`onExit`.
- `frontend/src/app/AppShell.tsx` — **modify**: hide TopBar/BottomNav and render Review full-bleed while sorting.
- Reuse unchanged: `SubcategoryPanel.tsx`, `settings/SwipePage.tsx`, `LinkRefundSheet.tsx`.

---

## Task 1: Depth-based gesture (`lib/swipe.ts` + gesture hook)

**Files:**
- Modify: `frontend/src/lib/swipe.ts`
- Modify (rewrite): `frontend/src/lib/swipe.test.ts`
- Modify: `frontend/src/hooks/useSwipeGesture.ts`

**Interfaces — Produces:**
- `const OTHER_MIN: number`, `CATEGORY_MIN: number`, `CAT_FULL: number`
- `function resolveZone(dx, dy, config): Zone | null` (depth-based; no threshold param)
- `type PreviewState` and `function previewState(dx, dy, config): PreviewState | null`
- unchanged: `EdgeKey/EdgeGroup/SlotKey/EdgeConfig/SwipeConfig/Zone`, `resolveEdge`, `GROUP_COLOR`, `GROUP_ICON`, `buildDefaultConfig`, `loadSwipeConfig`, `saveSwipeConfig`, `DEFAULT_SWIPE_CONFIG`.

- [ ] **Step 1: Rewrite the tests** — replace `frontend/src/lib/swipe.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveEdge, resolveZone, previewState, buildDefaultConfig, loadSwipeConfig,
  saveSwipeConfig, OTHER_MIN, CATEGORY_MIN,
} from './swipe'

type Cat = { ID: number; Kind: string; Bucket: string; IsActive: boolean }
const CATS: Cat[] = [
  { ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true },
  { ID: 2, Kind: 'spending', Bucket: 'need', IsActive: true },
  { ID: 3, Kind: 'spending', Bucket: 'want', IsActive: true },
  { ID: 4, Kind: 'spending', Bucket: 'want', IsActive: true },
  { ID: 5, Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 6, Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 7, Kind: 'excluded', Bucket: '', IsActive: true },
  { ID: 8, Kind: 'income', Bucket: '', IsActive: true },
]
// unit vector at angle (deg, +y down) scaled to a distance
function at(angleDeg: number, dist: number): [number, number] {
  const r = (angleDeg * Math.PI) / 180
  return [Math.cos(r) * dist, Math.sin(r) * dist]
}
const cfg = buildDefaultConfig(CATS)

describe('resolveEdge', () => {
  it('maps angles to edges', () => {
    expect(resolveEdge(...at(0, 100))).toBe('right')
    expect(resolveEdge(...at(90, 100))).toBe('down')
    expect(resolveEdge(...at(180, 100))).toBe('left')
    expect(resolveEdge(...at(-90, 100))).toBe('up')
  })
})

describe('resolveZone (depth)', () => {
  it('cancels below OTHER_MIN', () => {
    expect(resolveZone(...at(0, OTHER_MIN - 5), cfg)).toBeNull()
  })
  it('a short push (below CATEGORY_MIN) is Other for the aimed bucket, any angle', () => {
    const mid = (OTHER_MIN + CATEGORY_MIN) / 2
    expect(resolveZone(...at(-20, mid), cfg)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
    expect(resolveZone(...at(20, mid), cfg)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
    expect(resolveZone(...at(90, mid), cfg)).toEqual({ kind: 'other', edge: 'down', group: 'saving' })
  })
  it('a long push commits the angle-selected slot', () => {
    const far = CATEGORY_MIN + 20
    expect(resolveZone(...at(-20, far), cfg)).toEqual({ kind: 'category', edge: 'right', slot: 'A', categoryId: 1 })
    expect(resolveZone(...at(20, far), cfg)).toEqual({ kind: 'category', edge: 'right', slot: 'B', categoryId: 2 })
    expect(resolveZone(...at(120, far), cfg)).toMatchObject({ edge: 'down', slot: 'A', categoryId: 5 })
  })
  it('a long push into an empty slot falls back to Other', () => {
    const sparse = buildDefaultConfig([{ ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true }])
    expect(resolveZone(...at(20, CATEGORY_MIN + 20), sparse)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
  })
})

describe('previewState', () => {
  it('reports the Other band with a 0..1 fill', () => {
    const s = previewState(...at(0, OTHER_MIN + 1), cfg)
    expect(s).toMatchObject({ edge: 'right', kind: 'other', group: 'need' })
    expect(s!.fill).toBeGreaterThanOrEqual(0)
    expect(s!.fill).toBeLessThan(0.2)
  })
  it('reports the category slot once past CATEGORY_MIN', () => {
    const s = previewState(...at(-20, CATEGORY_MIN + CAT_FULL_HALF()), cfg)
    expect(s).toMatchObject({ edge: 'right', kind: 'category', slot: 'A', categoryId: 1 })
    expect(s!.fill).toBeGreaterThan(0.3)
  })
  it('is null below OTHER_MIN', () => {
    expect(previewState(2, 2, cfg)).toBeNull()
  })
})
function CAT_FULL_HALF() { return 45 }

describe('config load/save (unchanged behavior)', () => {
  beforeEach(() => localStorage.clear())
  it('seeds slots from categories', () => {
    expect(cfg.edges.right).toEqual({ group: 'need', slotA: 1, slotB: 2 })
    expect(cfg.edges.up).toEqual({ group: 'other', slotA: 7, slotB: 8 })
  })
  it('round-trips a saved v2 config', () => {
    const c = buildDefaultConfig(CATS); c.edges.right.slotA = 2
    saveSwipeConfig(c)
    expect(loadSwipeConfig(CATS).edges.right.slotA).toBe(2)
  })
  it('discards a v1 blob', () => {
    localStorage.setItem('ledger-swipe-config', JSON.stringify({ left: { bucket: 'want' } }))
    expect(loadSwipeConfig(CATS).version).toBe(2)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail** — `cd frontend && bunx vitest run src/lib/swipe.test.ts` → FAIL (`previewState`/`OTHER_MIN`/`CATEGORY_MIN` not exported; `resolveZone` still angle-sliver).

- [ ] **Step 3: Edit `lib/swipe.ts`.** Keep lines 1–41 (types, `GROUP_COLOR`, `GROUP_ICON`). Replace the block from `export const SWIPE_THRESHOLD = 80` (line 43) through the end of `overlayProgress` (line 105) with:

```ts
export const OTHER_MIN = 30      // below → cancel (spring back)
export const CATEGORY_MIN = 150  // below → Other, at/above → specific category
export const CAT_FULL = 90       // px past CATEGORY_MIN to reach full brightness

const STORAGE_KEY = 'ledger-swipe-config'

interface SeedCat { ID: number; Kind: string; Bucket: string; IsActive: boolean }

/** Nearest edge for a drag angle (±45° arc per cardinal; +dy is down). */
export function resolveEdge(dx: number, dy: number): EdgeKey {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle >= -45 && angle < 45) return 'right'
  if (angle >= 45 && angle < 135) return 'down'
  if (angle >= -135 && angle < -45) return 'up'
  return 'left'
}

function slotFor(edge: EdgeKey, dx: number, dy: number): SlotKey {
  const vertical = edge === 'left' || edge === 'right'
  return vertical ? (dy < 0 ? 'A' : 'B') : (dx < 0 ? 'A' : 'B')
}

/**
 * Depth-based resolution. Angle picks the bucket (and, when deep, the slot);
 * distance picks intent: short push → the bucket's Other, long push → the
 * specific category. An empty slot falls back to Other.
 */
export function resolveZone(dx: number, dy: number, config: SwipeConfig): Zone | null {
  const dist = Math.hypot(dx, dy)
  if (dist < OTHER_MIN) return null
  const edge = resolveEdge(dx, dy)
  const ec = config.edges[edge]
  if (dist < CATEGORY_MIN) return { kind: 'other', edge, group: ec.group }
  const slot = slotFor(edge, dx, dy)
  const categoryId = slot === 'A' ? ec.slotA : ec.slotB
  if (!categoryId) return { kind: 'other', edge, group: ec.group }
  return { kind: 'category', edge, slot, categoryId }
}

/** Live feedback for facet lighting: which region is aimed and how filled (0..1). */
export type PreviewState =
  | { edge: EdgeKey; group: EdgeGroup; kind: 'other'; fill: number }
  | { edge: EdgeKey; group: EdgeGroup; kind: 'category'; slot: SlotKey; categoryId: number; fill: number }

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

export function previewState(dx: number, dy: number, config: SwipeConfig): PreviewState | null {
  const dist = Math.hypot(dx, dy)
  if (dist < OTHER_MIN) return null
  const edge = resolveEdge(dx, dy)
  const ec = config.edges[edge]
  if (dist < CATEGORY_MIN) {
    return { edge, group: ec.group, kind: 'other', fill: clamp01((dist - OTHER_MIN) / (CATEGORY_MIN - OTHER_MIN)) }
  }
  const slot = slotFor(edge, dx, dy)
  const categoryId = slot === 'A' ? ec.slotA : ec.slotB
  if (!categoryId) return { edge, group: ec.group, kind: 'other', fill: 1 }
  return { edge, group: ec.group, kind: 'category', slot, categoryId, fill: clamp01((dist - CATEGORY_MIN) / CAT_FULL) }
}
```

Leave the rest of the file (`candidates`, `buildDefaultConfig`, `DEFAULT_SWIPE_CONFIG`, `loadSwipeConfig`, `saveSwipeConfig`) unchanged — but delete the now-unused `SeedCat` interface that was declared earlier (line 50–55) since it is re-declared above; keep exactly one `interface SeedCat`. (If simpler, keep the original `SeedCat` at line 50 and don't re-add it above.)

- [ ] **Step 4: Update the gesture hook.** In `frontend/src/hooks/useSwipeGesture.ts`, change the import `import { SWIPE_THRESHOLD } from '../lib/swipe'` to `import { OTHER_MIN } from '../lib/swipe'`, and change the commit gate `if (Math.hypot(dx, dy) >= SWIPE_THRESHOLD)` to `if (Math.hypot(dx, dy) >= OTHER_MIN)`.

- [ ] **Step 5: Run tests + typecheck the two files** — `cd frontend && bunx vitest run src/lib/swipe.test.ts` → PASS. `bunx tsc --noEmit 2>&1 | grep -E "swipe.ts|useSwipeGesture"` → no errors in those two (errors remain in SwipeCard/SwipeDeck — later tasks).

- [ ] **Step 6: Commit** — `git add frontend/src/lib/swipe.ts frontend/src/lib/swipe.test.ts frontend/src/hooks/useSwipeGesture.ts && git commit -m "feat(swipe): depth-based zone resolution + previewState for the sorting console"`

---

## Task 2: Facet geometry (`lib/facets.ts`)

**Files:**
- Create: `frontend/src/lib/facets.ts`
- Create: `frontend/src/lib/facets.test.ts`

**Interfaces — Produces:**
- `interface CardRect { x0; y0; x1; y1 }`
- `function centeredCard(w, h, cw, ch): CardRect`
- `interface FacetHalf { edge: EdgeKey; slot: SlotKey; points: string; lx: number; ly: number; rot: number }`
- `interface OtherSlice { edge: EdgeKey; points: string; lx: number; ly: number; rot: number }`
- `interface Facets { halves: FacetHalf[]; others: OtherSlice[] }`
- `function computeFacets(w, h, card: CardRect, band: number): Facets`

- [ ] **Step 1: Write the tests** — create `frontend/src/lib/facets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { centeredCard, computeFacets } from './facets'

describe('centeredCard', () => {
  it('centers the card in the arena', () => {
    expect(centeredCard(400, 600, 160, 240)).toEqual({ x0: 120, y0: 180, x1: 280, y1: 420 })
  })
})

describe('computeFacets', () => {
  const card = centeredCard(400, 600, 160, 240) // margins: x 120, y 180
  const f = computeFacets(400, 600, card, 40)

  it('produces 8 category halves and 4 Other slices', () => {
    expect(f.halves).toHaveLength(8)
    expect(f.others).toHaveLength(4)
    const keys = f.halves.map(h => `${h.edge}-${h.slot}`).sort()
    expect(keys).toEqual(['down-A', 'down-B', 'left-A', 'left-B', 'right-A', 'right-B', 'up-A', 'up-B'])
  })
  it('each half reaches a screen corner (corner-to-corner facets)', () => {
    // up-A spans from screen corner (0,0) to the card
    const upA = f.halves.find(h => h.edge === 'up' && h.slot === 'A')!
    expect(upA.points.startsWith('0.0,0.0')).toBe(true)
  })
  it('the up Other slice is a shallow band above the card (depth = band)', () => {
    const up = f.others.find(o => o.edge === 'up')!
    const ys = up.points.split(' ').map(p => Number(p.split(',')[1]))
    // inner edge at card top (y=180), outer edge at y0-band (140)
    expect(Math.max(...ys)).toBeCloseTo(180, 0)
    expect(Math.min(...ys)).toBeCloseTo(140, 0)
  })
  it('legend anchors sit inside the arena', () => {
    for (const h of [...f.halves, ...f.others]) {
      expect(h.lx).toBeGreaterThanOrEqual(0); expect(h.lx).toBeLessThanOrEqual(400)
      expect(h.ly).toBeGreaterThanOrEqual(0); expect(h.ly).toBeLessThanOrEqual(600)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `cd frontend && bunx vitest run src/lib/facets.test.ts` → FAIL (module missing).

- [ ] **Step 3: Create `lib/facets.ts`** (port of the prototype's `build()` geometry):

```ts
// frontend/src/lib/facets.ts
import type { EdgeKey, SlotKey } from './swipe'

export interface CardRect { x0: number; y0: number; x1: number; y1: number }
export interface FacetHalf { edge: EdgeKey; slot: SlotKey; points: string; lx: number; ly: number; rot: number }
export interface OtherSlice { edge: EdgeKey; points: string; lx: number; ly: number; rot: number }
export interface Facets { halves: FacetHalf[]; others: OtherSlice[] }

type Pt = [number, number]
const poly = (pts: Pt[]) => pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
const cen = (pts: Pt[]): Pt => {
  let sx = 0, sy = 0
  for (const p of pts) { sx += p[0]; sy += p[1] }
  return [sx / pts.length, sy / pts.length]
}

export function centeredCard(w: number, h: number, cw: number, ch: number): CardRect {
  const x0 = (w - cw) / 2, y0 = (h - ch) / 2
  return { x0, y0, x1: x0 + cw, y1: y0 + ch }
}

/**
 * Corner-to-corner mitered facets. Each edge is a trapezoid from the card edge
 * out to the arena corners, split down its cardinal centerline into two
 * category halves. The Other slice is a shallow trapezoid hugging the card whose
 * outer edge follows the same miter slant (depth = band).
 */
export function computeFacets(w: number, h: number, card: CardRect, band: number): Facets {
  const { x0, y0, x1, y1 } = card
  const cx = w / 2, cy = h / 2
  const A: Pt = [0, 0], B: Pt = [w, 0], C: Pt = [w, h], Dc: Pt = [0, h]
  const cTL: Pt = [x0, y0], cTR: Pt = [x1, y0], cBR: Pt = [x1, y1], cBL: Pt = [x0, y1]

  const halfPts: Record<string, Pt[]> = {
    'up-A': [A, [cx, 0], [cx, y0], cTL],       'up-B': [[cx, 0], B, cTR, [cx, y0]],
    'right-A': [B, [w, cy], [x1, cy], cTR],     'right-B': [[w, cy], C, cBR, [x1, cy]],
    'down-A': [Dc, [cx, h], [cx, y1], cBL],     'down-B': [[cx, h], C, cBR, [cx, y1]],
    'left-A': [A, [0, cy], [x0, cy], cTL],       'left-B': [[0, cy], Dc, cBL, [x0, cy]],
  }
  // Legend anchor + rotation per half (left/right rotate to run along the wall).
  const halfLabel: Record<string, { at: Pt; rot: number }> = {
    'up-A': { at: cen(halfPts['up-A']), rot: 0 },    'up-B': { at: cen(halfPts['up-B']), rot: 0 },
    'down-A': { at: cen(halfPts['down-A']), rot: 0 }, 'down-B': { at: cen(halfPts['down-B']), rot: 0 },
    'right-A': { at: [(w + x1) / 2, (y0 + cy) / 2], rot: 90 }, 'right-B': { at: [(w + x1) / 2, (cy + y1) / 2], rot: 90 },
    'left-A': { at: [x0 / 2, (y0 + cy) / 2], rot: -90 },        'left-B': { at: [x0 / 2, (cy + y1) / 2], rot: -90 },
  }
  const halves: FacetHalf[] = (Object.keys(halfPts) as string[]).map(k => {
    const [edge, slot] = k.split('-') as [EdgeKey, SlotKey]
    const { at, rot } = halfLabel[k]
    return { edge, slot, points: poly(halfPts[k]), lx: at[0], ly: at[1], rot }
  })

  const sT = band / y0, sB = band / (h - y1), sL = band / x0, sR = band / (w - x1)
  const otherPts: Record<EdgeKey, Pt[]> = {
    up: [[x0, y0], [x1, y0], [x1 + (w - x1) * sT, y0 - band], [x0 - x0 * sT, y0 - band]],
    down: [[x0, y1], [x1, y1], [x1 + (w - x1) * sB, y1 + band], [x0 - x0 * sB, y1 + band]],
    left: [[x0, y0], [x0, y1], [x0 - band, y1 + (h - y1) * sL], [x0 - band, y0 - y0 * sL]],
    right: [[x1, y0], [x1, y1], [x1 + band, y1 + (h - y1) * sR], [x1 + band, y0 - y0 * sR]],
  }
  const otherLabel: Record<EdgeKey, { at: Pt; rot: number }> = {
    up: { at: [cx, y0 - band / 2], rot: 0 },
    down: { at: [cx, y1 + band / 2], rot: 0 },
    left: { at: [x0 - band / 2, cy], rot: -90 },
    right: { at: [x1 + band / 2, cy], rot: 90 },
  }
  const others: OtherSlice[] = (['up', 'down', 'left', 'right'] as EdgeKey[]).map(edge => ({
    edge, points: poly(otherPts[edge]), lx: otherLabel[edge].at[0], ly: otherLabel[edge].at[1], rot: otherLabel[edge].rot,
  }))

  return { halves, others }
}
```

- [ ] **Step 4: Run tests to verify they pass** — `cd frontend && bunx vitest run src/lib/facets.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add frontend/src/lib/facets.ts frontend/src/lib/facets.test.ts && git commit -m "feat(swipe): pure facet polygon geometry for the sorting console"`

---

## Task 3: `SwipeConsole` — the SVG facet layer

**Files:** Create `frontend/src/components/swipe/SwipeConsole.tsx`

**Interfaces — Consumes:** `Facets`/`computeFacets` (Task 2), `PreviewState`, `SwipeConfig`, `GROUP_COLOR` (Task 1). **Produces:** `SwipeConsole` component.

The console renders the graphite floor, the 8 half polygons, the 4 Other slices, and their legends, all lit from the `preview` prop. It is presentational and pure (no gestures).

- [ ] **Step 1: Create the component.**

```tsx
// frontend/src/components/swipe/SwipeConsole.tsx
import { useMemo } from 'react'
import { GROUP_COLOR, type SwipeConfig, type PreviewState, type EdgeKey } from '../../lib/swipe'
import { computeFacets, type CardRect } from '../../lib/facets'

interface Props {
  w: number
  h: number
  card: CardRect
  band: number
  config: SwipeConfig
  catName: (id: number) => string
  preview: PreviewState | null
}

const BASE_FACET = 0.06
const BASE_OTHER = 0.12

export function SwipeConsole({ w, h, card, band, config, catName, preview }: Props) {
  const facets = useMemo(() => computeFacets(w, h, card, band), [w, h, card, band])

  const halfOpacity = (edge: EdgeKey, slot: string) => {
    if (preview?.kind === 'category' && preview.edge === edge && preview.slot === slot) return 0.14 + 0.52 * preview.fill
    return BASE_FACET
  }
  const otherOpacity = (edge: EdgeKey) => {
    if (preview?.edge === edge && preview.kind === 'other') return 0.18 + 0.44 * preview.fill
    if (preview?.edge === edge && preview.kind === 'category') return 0.2 // path travelled through
    return BASE_OTHER
  }
  const slotLabel = (edge: EdgeKey, slot: 'A' | 'B') => {
    const id = slot === 'A' ? config.edges[edge].slotA : config.edges[edge].slotB
    return id ? catName(id) : '—'
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="absolute inset-0 pointer-events-none" aria-hidden>
      <rect x={0} y={0} width={w} height={h} fill="#151A21" />
      {facets.halves.map(half => {
        const color = GROUP_COLOR[config.edges[half.edge].group === 'other' ? 'other' : config.edges[half.edge].group]
        const lit = preview?.kind === 'category' && preview.edge === half.edge && preview.slot === half.slot
        return (
          <g key={`${half.edge}-${half.slot}`}>
            <polygon points={half.points} fill={FACET_COLOR(config, half.edge)} fillOpacity={halfOpacity(half.edge, half.slot)}
              style={{ transition: 'fill-opacity 90ms linear' }} />
            <text x={half.lx} y={half.ly} transform={half.rot ? `rotate(${half.rot} ${half.lx} ${half.ly})` : undefined}
              textAnchor="middle" dominantBaseline="middle"
              fill={FACET_COLOR(config, half.edge)} fillOpacity={lit ? 1 : 0.62}
              style={{ fontSize: lit ? 13 : 10.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', transition: 'font-size 120ms, fill-opacity 90ms' }}>
              {slotLabel(half.edge, half.slot)}
            </text>
          </g>
        )
      })}
      {facets.others.map(o => (
        <g key={o.edge}>
          <polygon points={o.points} fill={FACET_COLOR(config, o.edge)} fillOpacity={otherOpacity(o.edge)}
            style={{ transition: 'fill-opacity 90ms linear' }} />
          <text x={o.lx} y={o.ly} transform={o.rot ? `rotate(${o.rot} ${o.lx} ${o.ly})` : undefined}
            textAnchor="middle" dominantBaseline="middle"
            fill={FACET_COLOR(config, o.edge)} fillOpacity={preview?.edge === o.edge && preview.kind === 'other' ? 0.95 : 0.45}
            style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
            Other…
          </text>
        </g>
      ))}
    </svg>
  )
}

/** Brightened bucket colors for the graphite console (glow), keyed by edge group. */
function FACET_COLOR(config: SwipeConfig, edge: EdgeKey): string {
  const CONSOLE: Record<string, string> = { need: '#3B82F6', want: '#8B5CF6', saving: '#10B981', other: '#94A3B8' }
  return CONSOLE[config.edges[edge].group]
}
```
(The unused `color`/`GROUP_COLOR` import may be removed; the console uses the brightened `FACET_COLOR`. Keep the file free of unused symbols so `tsc --noEmit` with `noUnusedLocals` passes.)

- [ ] **Step 2: Typecheck** — `cd frontend && bunx tsc --noEmit 2>&1 | grep SwipeConsole` → no errors in this file (SwipeDeck/SwipeCard errors are expected until their tasks).

- [ ] **Step 3: Commit** — `git add frontend/src/components/swipe/SwipeConsole.tsx && git commit -m "feat(swipe): SwipeConsole SVG facet layer lit by previewState"`

---

## Task 4: `SwipeCard` — depth feedback

**Files:** Modify `frontend/src/components/swipe/SwipeCard.tsx`

**Interfaces:** Consumes `previewState`, `resolveZone`, `GROUP_COLOR`, `EdgeKey`, `Zone`, `PreviewState`, `SwipeConfig`. Produces `SwipeCard` with props `{ txn; config; catName; flying?: EdgeKey | null; onZoneCommit: (zone: Zone) => void; onTripleTap; onExitComplete; onPreview?: (s: PreviewState | null) => void }`.

Rewrite so the card computes `previewState(dx,dy,config)` on drag, reports it via `onPreview`, and renders its own ring/tilt/badge from it. On commit, `resolveZone(dx,dy,config)` → `onZoneCommit`. Fly toward the committed edge on `flying`.

- [ ] **Step 1: Rewrite the file.** Keep the existing structure (`useSwipeGesture`, `usePrefersReducedMotion`, `EXIT`/`BADGE_POS` per edge, monogram/amount rendering, `SWIPE_ICONS` export) but drive feedback from `previewState`:
  - `const handleCommit = (dx, dy) => { const z = resolveZone(dx, dy, config); if (z) onZoneCommit(z) }`
  - `const pv = previewState(dx, dy, config)`; `const edge = flying ?? pv?.edge ?? null`.
  - ring color `= pv ? FACET color : null`; ring strength `= pv?.fill ?? 0` (use the brightened console colors — import a shared `FACET_COLOR` or inline the same map used in `SwipeConsole`; to avoid duplication, export `CONSOLE_COLOR: Record<EdgeGroup,string>` from `lib/swipe.ts` and use it in both `SwipeConsole` and here).
  - badge label: `pv?.kind === 'category' ? catName(pv.categoryId) : 'Other…'`.
  - `useEffect(() => { if (!flying) onPreview?.(pv) }, [pv, flying, onPreview])`.
  - fly-out uses `EXIT[flying]` as today.

  **Refactor note (do this first):** add to `lib/swipe.ts` an exported map `export const CONSOLE_COLOR: Record<EdgeGroup, string> = { need: '#3B82F6', want: '#8B5CF6', saving: '#10B981', other: '#94A3B8' }`, and use it in `SwipeConsole` (`FACET_COLOR`) and `SwipeCard` instead of duplicating the literal map. Commit that one-line export as part of this task.

- [ ] **Step 2: Typecheck** — `cd frontend && bunx tsc --noEmit 2>&1 | grep SwipeCard` → errors only about `SwipeDeck` passing old props (Task 5), not SwipeCard-internal.

- [ ] **Step 3: Commit** — `git add frontend/src/components/swipe/SwipeCard.tsx frontend/src/lib/swipe.ts && git commit -m "feat(swipe): depth-driven card ring/badge from previewState"`

---

## Task 5: `SwipeDeck` — full-bleed composition + commit routing

**Files:** Modify `frontend/src/components/swipe/SwipeDeck.tsx`

**Interfaces:** Consumes `SwipeConsole` (Task 3), `SwipeCard` (Task 4), `SubcategoryPanel` (group prop), `centeredCard`, `previewState`/`resolveZone` types, `CONSOLE_COLOR`. Produces `SwipeDeck` with props `{ transactions; categories; config?; onExit?: () => void }`.

The deck fills its container (graphite), measures the arena, positions a modest centered card over `SwipeConsole`, holds the current `PreviewState`, and routes commits.

- [ ] **Step 1: Rewrite the file.** Key structure:
  - Root: `<div ref={arenaRef} className="absolute inset-0 bg-[#0E1116] overflow-hidden">`.
  - Measure arena with a `ResizeObserver` on `arenaRef` into `const [size, setSize] = useState({ w: 0, h: 0 })` (set from `getBoundingClientRect` on mount + observe). Render nothing facet-related until `size.w > 0`.
  - `const cw = Math.min(200, Math.round(size.w * 0.46))`, `const ch = Math.round(cw * 1.5)`, `const card = centeredCard(size.w, size.h, cw, ch)`.
  - `const band = Math.max(24, Math.round(Math.min((size.w - cw) / 2, (size.h - ch) / 2) * 0.42))`.
  - `catName` memoized `Map` (as in the current deck).
  - State: `index`, `skippedIds`, `pendingGroup: EdgeGroup | null`, `flyEdge: EdgeKey | null`, `makeRule`, `preview: PreviewState | null`.
  - Render order: `<SwipeConsole w={size.w} h={size.h} card={card} band={band} config={config} catName={catName} preview={preview} />`, then the card absolutely centered (`style={{ position:'absolute', left: card.x0, top: card.y0, width: cw, height: ch }}`) wrapping `<SwipeCard ... onPreview={setPreview} />`, then `<SubcategoryPanel>` when `pendingGroup`.
  - `categorize(categoryId, edge)`: POST `/api/transactions/:id/categorize`, set `flyEdge`, advance on exit (same as current deck; **fire exactly one feedback cue per action** — `fire('success')` in the direct-category branch of `handleZoneCommit`, `fire('selection')` in the panel-select handler; do NOT fire inside `categorize`).
  - `handleZoneCommit(zone)`: `category` → `fire('success')` + `categorize(zone.categoryId, zone.edge)`; `other` → `setState pendingGroup = zone.group`.
  - `handleCategorySelect(categoryId)`: resolve the edge from `pendingGroup` (the 1:1 group→edge map), `fire('selection')`, `categorize(id, edge)`.
  - Keep triple-tap skip and the credit-card refund button + `LinkRefundSheet`.
  - Header ("Remaining N") and hint styled for graphite (light text); include a small top-left exit control calling `onExit?.()` (a `<button>` with a chevron, `aria-label="Close review"`).
  - "All caught up" done-state as today (on graphite).

- [ ] **Step 2: Keep the refund test green** — `cd frontend && bunx vitest run src/components/swipe/SwipeDeck.refund.test.tsx` → PASS (the deck still renders the refund button for credits with `categories={[]}`; the test may need the arena to have a size — if it renders null with `size.w===0` in jsdom, give the arena a deterministic fallback size when `getBoundingClientRect` returns 0, e.g. `w: rect.width || 380, h: rect.height || 640`, so the deck renders in tests). Adjust the test only if a prop signature changed; do not weaken its assertions.

- [ ] **Step 3: Typecheck** — `cd frontend && bunx tsc --noEmit 2>&1 | grep -E "SwipeDeck|SwipeConsole|SwipeCard"` → clean (remaining errors, if any, only in `Review.tsx`/`AppShell.tsx` — Task 6).

- [ ] **Step 4: Commit** — `git add frontend/src/components/swipe/SwipeDeck.tsx frontend/src/components/swipe/SwipeDeck.refund.test.tsx && git commit -m "feat(swipe): full-bleed sorting-console deck with depth commit routing"`

---

## Task 6: Immersive graphite + fullscreen chrome (`Review.tsx`, `AppShell.tsx`, deck polish)

**Files:** Modify `frontend/src/screens/Review.tsx`, `frontend/src/app/AppShell.tsx`, `frontend/src/components/swipe/SwipeDeck.tsx`

**Deck polish (carried over from Task 5 review):**
- In `SwipeDeck.tsx`, gate ALL non-facet chrome (the exit button, the "Remaining" header, the hint text, the refund button) on `size.w > 0`, so nothing renders over an unmeasured arena on the first frame. Only the graphite root shows until the arena is measured.
- Restore the header copy to **"Remaining"** with the count (matching the app's prior deck), e.g. an eyebrow "Remaining" over the number `N`.

- [ ] **Step 1: `Review.tsx`** — accept `{ scope; immersive?: boolean; onExit?: () => void }`. When rendering the deck (not loading/empty), render it full-bleed: `<div className="absolute inset-0"><SwipeDeck ... config={config} onExit={onExit} /></div>`. Keep the existing loading spinner and "All caught up here" empty state (these render in the normal, non-immersive shell). Pass `onExit` through to the deck.

- [ ] **Step 2: `AppShell.tsx`** — derive `const immersive = tab === 'review' && reviewCount > 0`. When `immersive`, render a fullscreen graphite layer instead of the normal chrome+wrapper for the review content:

```tsx
if (immersive) {
  return (
    <div className="fixed inset-0 z-50 bg-[#0E1116]">
      <PwaUpdatePrompt />
      <Review scope={scope} immersive onExit={() => setTab('home')} />
    </div>
  )
}
```
Place this `return` after the queries are set up (so `reviewCount` is known), before the normal `return`. The normal shell (TopBar + BottomNav + `max-w-screen-sm` wrapper) is unchanged and handles every other tab and the review empty-state (when `reviewCount === 0`). When the last card is categorized, `reviewCount` → 0, `immersive` flips false, and the normal shell shows "All caught up here" with nav restored.

- [ ] **Step 3: Typecheck + full suite** — `cd frontend && bunx tsc --noEmit && bun run test` → 0 type errors; all suites green.

- [ ] **Step 4: Commit** — `git add frontend/src/screens/Review.tsx frontend/src/app/AppShell.tsx && git commit -m "feat(review): immersive graphite fullscreen while sorting"`

---

## Task 7: Cleanup, dead-code sweep, dist rebuild, verify

- [ ] **Step 1: Dead-symbol sweep** — `cd frontend && grep -rn "SLIVER_HALF_ANGLE\|SWIPE_THRESHOLD\|previewZone\|overlayProgress\|deviation\|zoneAt" src/` → no hits (all removed with Task 1). Fix any straggler imports.
- [ ] **Step 2: Full typecheck + tests** — `cd frontend && bunx tsc --noEmit && bun run test` → clean + green.
- [ ] **Step 3: Rebuild embedded bundle** — `cd frontend && bun run build`, then from repo root `CGO_ENABLED=0 go build -o /tmp/ledger-sc ./cmd/ledger && echo built`.
- [ ] **Step 4: Commit** — `git add frontend/src internal/web/dist && git commit -m "chore(web): rebuild embedded dist (sorting console)"`
- [ ] **Step 5: Manual verify** — launch the binary against a scratch DB (scratch data_dir + free port, NOT prod), confirm it serves the SPA and `/api/categories`/`/api/transactions?status=needs_review`. Full swipe interaction is device-only; rely on the `lib` unit tests for geometry/gesture. Report what was checked.

## Self-Review Notes
- Spec coverage: depth gesture (T1), facet geometry (T2), console render (T3), card feedback (T4), full-bleed deck + commit routing + Other picker reuse (T5), immersive graphite + fullscreen chrome (T6), verify (T7). Config model + settings unchanged (no task) as specified.
- Type consistency: `PreviewState`/`resolveZone`/`previewState`/`OTHER_MIN`/`CATEGORY_MIN`/`CAT_FULL`/`CONSOLE_COLOR` (T1) consumed by T3/T4/T5; `Facets`/`computeFacets`/`centeredCard`/`CardRect` (T2) by T3/T5; `SwipeCard` props (`onZoneCommit`/`catName`/`onPreview: PreviewState`) consistent T4↔T5; `SubcategoryPanel` `group` prop reused unchanged.
- One feedback cue per action is restated in T5 (guards against re-introducing the double-fire fixed in the 8-zone feature).
