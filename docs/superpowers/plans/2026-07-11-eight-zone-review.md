# Eight-Zone Review Categorizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the review swipe deck's 4 directional buckets into 8 category zones (2 per edge) plus a slim "Other" sliver per edge that opens the existing bottom sheet.

**Architecture:** All logic hangs off pure geometry in `frontend/src/lib/swipe.ts`. The gesture hook is reworked to emit raw `(dx, dy)` so the card can resolve which of the 8 zones (or 4 slivers) a drag angle lands in. Edge→group is fixed (right=Need, left=Want, down=Save, up=Income/Excluded); the two category slots per edge are user-configurable and persisted (versioned localStorage). No backend changes — every zone uses `POST /api/transactions/:id/categorize`.

**Tech Stack:** React 18 + TypeScript + Vite, TanStack Query, Tailwind v4, lucide-react, vitest/jsdom, bun.

## Global Constraints

- Money is never touched here; this is UI/gesture only.
- Frontend vitest runs single non-parallel fork (`vite.config.ts`) — do not change that.
- Run one test file with: `cd frontend && bunx vitest run src/path/File.test.tsx`.
- Mobile conventions: 44px min touch targets, `.press` feedback, Dialog-only overlays (see `frontend/src/components/README.md`).
- `internal/web/dist/` is a committed artifact — rebuild it (`cd frontend && bun run build`) before finishing the branch, not per task.
- Match existing code style: no semicolons in `lib/`/`components/swipe` files (they omit them), 2-space indent, existing import ordering.

---

## File Structure

- `frontend/src/lib/swipe.ts` — **rewritten**: v2 config types, edge→group map, group colors, `resolveEdge`, `resolveZone`, `previewZone`, `buildDefaultConfig`, `loadSwipeConfig`, `saveSwipeConfig`. Pure, framework-free.
- `frontend/src/lib/swipe.test.ts` — **rewritten**: geometry + config unit tests.
- `frontend/src/hooks/useSwipeGesture.ts` — **modified**: commit raw `(dx, dy)` instead of a `SwipeDirection`.
- `frontend/src/components/swipe/SwipeCard.tsx` — **modified**: resolve zones via config, badge shows the resolved category name, preview reports a `Zone`.
- `frontend/src/components/swipe/SwipeDeck.tsx` — **modified**: 3-segment edge rails, `handleZoneCommit`, "Other" opens panel with a group, transfer-status path removed.
- `frontend/src/components/swipe/SubcategoryPanel.tsx` — **modified**: filter by an `EdgeGroup` (bucket or income+excluded) instead of `SwipeAction.bucket`.
- `frontend/src/screens/settings/SwipePage.tsx` — **rewritten**: per-slot category dropdowns.
- `frontend/src/screens/Review.tsx` — **modified**: build the config from loaded categories.
- Tests touched: `SubcategoryPanel.test.tsx`, `SwipeDeck.refund.test.tsx` (kept green), plus new geometry tests.

---

## Task 1: Geometry & config core (`lib/swipe.ts`)

**Files:**
- Modify (rewrite): `frontend/src/lib/swipe.ts`
- Test (rewrite): `frontend/src/lib/swipe.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type EdgeKey = 'up' | 'down' | 'left' | 'right'`
  - `type EdgeGroup = 'need' | 'want' | 'saving' | 'other'`
  - `type SlotKey = 'A' | 'B'`
  - `interface EdgeConfig { group: EdgeGroup; slotA: number; slotB: number }`
  - `interface SwipeConfig { version: 2; edges: Record<EdgeKey, EdgeConfig> }`
  - `type Zone = { kind: 'category'; edge: EdgeKey; slot: SlotKey; categoryId: number } | { kind: 'other'; edge: EdgeKey; group: EdgeGroup }`
  - `const EDGE_GROUP: Record<EdgeKey, EdgeGroup>`
  - `const GROUP_COLOR: Record<EdgeGroup, string>`
  - `const SWIPE_THRESHOLD: number`, `const SLIVER_HALF_ANGLE: number`
  - `function resolveEdge(dx: number, dy: number): EdgeKey`
  - `function resolveZone(dx: number, dy: number, config: SwipeConfig, threshold?: number): Zone | null`
  - `function previewZone(dx: number, dy: number, config: SwipeConfig): Zone | null`
  - `function overlayProgress(dx: number, dy: number): number` (unchanged behavior)
  - `function buildDefaultConfig(categories: { ID: number; Kind: string; Bucket: string; IsActive: boolean }[]): SwipeConfig`
  - `function loadSwipeConfig(categories: Parameters<typeof buildDefaultConfig>[0]): SwipeConfig`
  - `function saveSwipeConfig(config: SwipeConfig): void`
  - `const DEFAULT_SWIPE_CONFIG: SwipeConfig` (= `buildDefaultConfig([])`, empty-slot fallback for tests/props)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `frontend/src/lib/swipe.test.ts` with:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  resolveEdge,
  resolveZone,
  previewZone,
  buildDefaultConfig,
  loadSwipeConfig,
  saveSwipeConfig,
  SWIPE_THRESHOLD,
  SLIVER_HALF_ANGLE,
  type SwipeConfig,
} from './swipe'

type Cat = { ID: number; Kind: string; Bucket: string; IsActive: boolean }

const CATS: Cat[] = [
  { ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true },   // Groceries
  { ID: 2, Kind: 'spending', Bucket: 'need', IsActive: true },   // Transport
  { ID: 3, Kind: 'spending', Bucket: 'want', IsActive: true },   // Dining
  { ID: 4, Kind: 'spending', Bucket: 'want', IsActive: true },   // Shopping
  { ID: 5, Kind: 'spending', Bucket: 'saving', IsActive: true }, // Savings
  { ID: 6, Kind: 'spending', Bucket: 'saving', IsActive: true }, // Invest
  { ID: 7, Kind: 'excluded', Bucket: '', IsActive: true },       // Transfers
  { ID: 8, Kind: 'income', Bucket: '', IsActive: true },         // Salary
  { ID: 9, Kind: 'spending', Bucket: 'need', IsActive: false },  // inactive, ignored
]

// A drag vector of the given angle (degrees, +y down) at fixed magnitude.
function vec(angleDeg: number, mag = 120): [number, number] {
  const r = (angleDeg * Math.PI) / 180
  return [Math.cos(r) * mag, Math.sin(r) * mag]
}

describe('resolveEdge', () => {
  it('maps cardinal-ish angles to edges', () => {
    expect(resolveEdge(...vec(0))).toBe('right')
    expect(resolveEdge(...vec(90))).toBe('down')
    expect(resolveEdge(...vec(180))).toBe('left')
    expect(resolveEdge(...vec(-90))).toBe('up')
  })
})

describe('resolveZone', () => {
  const cfg = buildDefaultConfig(CATS)

  it('returns null below threshold', () => {
    expect(resolveZone(10, 10, cfg)).toBeNull()
  })

  it('right edge, angled up = slot A (top Need cat)', () => {
    const z = resolveZone(...vec(-30), cfg)
    expect(z).toEqual({ kind: 'category', edge: 'right', slot: 'A', categoryId: 1 })
  })

  it('right edge, angled down = slot B (2nd Need cat)', () => {
    const z = resolveZone(...vec(30), cfg)
    expect(z).toEqual({ kind: 'category', edge: 'right', slot: 'B', categoryId: 2 })
  })

  it('straight into an edge (within sliver) = other', () => {
    const z = resolveZone(...vec(0), cfg)
    expect(z).toEqual({ kind: 'other', edge: 'right', group: 'need' })
  })

  it('sliver boundary is inclusive of dev <= SLIVER_HALF_ANGLE', () => {
    expect(resolveZone(...vec(SLIVER_HALF_ANGLE - 1), cfg)?.kind).toBe('other')
    expect(resolveZone(...vec(SLIVER_HALF_ANGLE + 1), cfg)?.kind).toBe('category')
  })

  it('down edge, angled left = slot A; right = slot B', () => {
    expect(resolveZone(...vec(120), cfg)).toMatchObject({ edge: 'down', slot: 'A', categoryId: 5 })
    expect(resolveZone(...vec(60), cfg)).toMatchObject({ edge: 'down', slot: 'B', categoryId: 6 })
  })

  it('up edge maps to income/excluded slots', () => {
    expect(resolveZone(...vec(-120), cfg)).toMatchObject({ edge: 'up', slot: 'A' })
    expect(resolveZone(...vec(-60), cfg)).toMatchObject({ edge: 'up', slot: 'B' })
  })

  it('falls back to other when the slot has no category', () => {
    const sparse = buildDefaultConfig([{ ID: 1, Kind: 'spending', Bucket: 'need', IsActive: true }])
    // Need slot B is empty → an angled-down right swipe becomes other
    expect(resolveZone(...vec(30), sparse)).toEqual({ kind: 'other', edge: 'right', group: 'need' })
  })
})

describe('previewZone', () => {
  const cfg = buildDefaultConfig(CATS)
  it('uses a lower (20px) threshold', () => {
    expect(previewZone(...vec(-30, 30), cfg)?.kind).toBe('category')
    expect(previewZone(...vec(-30, 10), cfg)).toBeNull()
  })
})

describe('buildDefaultConfig', () => {
  it('seeds slots from each group in ID order', () => {
    const cfg = buildDefaultConfig(CATS)
    expect(cfg.edges.right).toEqual({ group: 'need', slotA: 1, slotB: 2 })
    expect(cfg.edges.left).toEqual({ group: 'want', slotA: 3, slotB: 4 })
    expect(cfg.edges.down).toEqual({ group: 'saving', slotA: 5, slotB: 6 })
    expect(cfg.edges.up).toEqual({ group: 'other', slotA: 7, slotB: 8 })
  })

  it('ignores inactive categories', () => {
    const cfg = buildDefaultConfig(CATS)
    expect(cfg.edges.right.slotB).toBe(2) // not 9 (inactive)
  })

  it('leaves slot B empty when a group has one category, 0/0 when none', () => {
    const cfg = buildDefaultConfig([{ ID: 5, Kind: 'spending', Bucket: 'saving', IsActive: true }])
    expect(cfg.edges.down).toEqual({ group: 'saving', slotA: 5, slotB: 0 })
    expect(cfg.edges.right).toEqual({ group: 'need', slotA: 0, slotB: 0 })
  })
})

describe('loadSwipeConfig migration', () => {
  beforeEach(() => localStorage.clear())

  it('discards a v1 blob and rebuilds defaults', () => {
    localStorage.setItem('ledger-swipe-config', JSON.stringify({ left: { bucket: 'want' } }))
    const cfg = loadSwipeConfig(CATS)
    expect(cfg.version).toBe(2)
    expect(cfg.edges.right.slotA).toBe(1)
  })

  it('round-trips a saved v2 config', () => {
    const cfg = buildDefaultConfig(CATS)
    cfg.edges.right.slotA = 2
    saveSwipeConfig(cfg)
    expect(loadSwipeConfig(CATS).edges.right.slotA).toBe(2)
  })

  it('falls back to defaults on corrupt data', () => {
    localStorage.setItem('ledger-swipe-config', '{ not json')
    expect(loadSwipeConfig(CATS).version).toBe(2)
  })
})

describe('constants', () => {
  it('keeps the 80px commit threshold', () => {
    expect(SWIPE_THRESHOLD).toBe(80)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && bunx vitest run src/lib/swipe.test.ts`
Expected: FAIL — `resolveEdge`/`resolveZone`/`buildDefaultConfig` not exported (module still has old v1 API).

- [ ] **Step 3: Rewrite `lib/swipe.ts`**

Replace the entire contents of `frontend/src/lib/swipe.ts` with:

```ts
// frontend/src/lib/swipe.ts

export type EdgeKey = 'up' | 'down' | 'left' | 'right'
export type EdgeGroup = 'need' | 'want' | 'saving' | 'other'
export type SlotKey = 'A' | 'B'

export interface EdgeConfig {
  group: EdgeGroup
  slotA: number // category ID (0 = empty)
  slotB: number // category ID (0 = empty)
}

export interface SwipeConfig {
  version: 2
  edges: Record<EdgeKey, EdgeConfig>
}

/** A resolved swipe target: a specific category slot, or the "Other" sliver. */
export type Zone =
  | { kind: 'category'; edge: EdgeKey; slot: SlotKey; categoryId: number }
  | { kind: 'other'; edge: EdgeKey; group: EdgeGroup }

/** Fixed edge→group mapping — preserves color and muscle memory. */
export const EDGE_GROUP: Record<EdgeKey, EdgeGroup> = {
  right: 'need',
  left: 'want',
  down: 'saving',
  up: 'other',
}

/**
 * Group colors, matching the app's bucket tokens (need=blue, save=green),
 * a distinct violet for Want and a neutral slate for Other (income/excluded,
 * which isn't 50/30/20 spending).
 */
export const GROUP_COLOR: Record<EdgeGroup, string> = {
  need: '#2563eb',
  want: '#7c3aed',
  saving: '#059669',
  other: '#64748b',
}

/** lucide-react icon name per group, for rails/badges. */
export const GROUP_ICON: Record<EdgeGroup, string> = {
  need: 'Home',
  want: 'Heart',
  saving: 'PiggyBank',
  other: 'ArrowLeftRight',
}

export const SWIPE_THRESHOLD = 80
/** Half-width (deg) of the central "Other" sliver on each edge's cardinal axis. */
export const SLIVER_HALF_ANGLE = 8
const PREVIEW_THRESHOLD = 20

const STORAGE_KEY = 'ledger-swipe-config'

interface SeedCat {
  ID: number
  Kind: string
  Bucket: string
  IsActive: boolean
}

/** Nearest edge for a drag angle (±45° arc per cardinal; +dy is down). */
export function resolveEdge(dx: number, dy: number): EdgeKey {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI // (-180, 180]
  if (angle >= -45 && angle < 45) return 'right'
  if (angle >= 45 && angle < 135) return 'down'
  if (angle >= -135 && angle < -45) return 'up'
  return 'left'
}

/** Angular deviation (deg, 0..90) from the edge's cardinal axis. */
function deviation(edge: EdgeKey, dx: number, dy: number): number {
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  switch (edge) {
    case 'right': return Math.abs(angle)
    case 'down': return Math.abs(angle - 90)
    case 'up': return Math.abs(angle + 90)
    case 'left': return 180 - Math.abs(angle)
  }
}

function zoneAt(dx: number, dy: number, config: SwipeConfig, threshold: number): Zone | null {
  if (Math.hypot(dx, dy) < threshold) return null
  const edge = resolveEdge(dx, dy)
  const ec = config.edges[edge]
  if (deviation(edge, dx, dy) <= SLIVER_HALF_ANGLE) {
    return { kind: 'other', edge, group: ec.group }
  }
  // Vertical edges (left/right) split by dy; horizontal (up/down) by dx.
  const vertical = edge === 'left' || edge === 'right'
  const slot: SlotKey = vertical ? (dy < 0 ? 'A' : 'B') : (dx < 0 ? 'A' : 'B')
  const categoryId = slot === 'A' ? ec.slotA : ec.slotB
  if (!categoryId) return { kind: 'other', edge, group: ec.group }
  return { kind: 'category', edge, slot, categoryId }
}

/** Resolve a committed drag (≥ threshold) to a zone, or null if too short. */
export function resolveZone(dx: number, dy: number, config: SwipeConfig, threshold = SWIPE_THRESHOLD): Zone | null {
  return zoneAt(dx, dy, config, threshold)
}

/** Like resolveZone but at the lower live-preview threshold. */
export function previewZone(dx: number, dy: number, config: SwipeConfig): Zone | null {
  return zoneAt(dx, dy, config, PREVIEW_THRESHOLD)
}

/** 0–1 progress for overlay opacity based on drag magnitude. */
export function overlayProgress(dx: number, dy: number): number {
  return Math.min(1, Math.hypot(dx, dy) / SWIPE_THRESHOLD)
}

function candidates(group: EdgeGroup, categories: SeedCat[]): number[] {
  const match = (c: SeedCat) =>
    group === 'other'
      ? c.Kind === 'income' || c.Kind === 'excluded'
      : c.Kind === 'spending' && c.Bucket === group
  return categories
    .filter(c => c.IsActive && match(c))
    .sort((a, b) => a.ID - b.ID)
    .map(c => c.ID)
}

/** Build a fresh config, seeding each edge's two slots from its group's categories. */
export function buildDefaultConfig(categories: SeedCat[]): SwipeConfig {
  const edge = (group: EdgeGroup): EdgeConfig => {
    const ids = candidates(group, categories)
    const slotA = ids[0] ?? 0
    const slotB = ids[1] ?? 0
    return { group, slotA, slotB }
  }
  return {
    version: 2,
    edges: {
      right: edge('need'),
      left: edge('want'),
      down: edge('saving'),
      up: edge('other'),
    },
  }
}

/** Empty-slot fallback used as a default prop / in tests that never swipe. */
export const DEFAULT_SWIPE_CONFIG: SwipeConfig = buildDefaultConfig([])

export function loadSwipeConfig(categories: SeedCat[]): SwipeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SwipeConfig>
      if (parsed && parsed.version === 2 && parsed.edges) {
        return parsed as SwipeConfig
      }
    }
  } catch {
    /* ignore corrupt data */
  }
  return buildDefaultConfig(categories)
}

export function saveSwipeConfig(config: SwipeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && bunx vitest run src/lib/swipe.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/swipe.ts frontend/src/lib/swipe.test.ts
git commit -m "feat(swipe): 8-zone geometry and versioned config core"
```

---

## Task 2: Gesture hook emits raw `(dx, dy)`

**Files:**
- Modify: `frontend/src/hooks/useSwipeGesture.ts`

**Interfaces:**
- Consumes: `SWIPE_THRESHOLD` from `lib/swipe`.
- Produces: `useSwipeGesture(onCommit: (dx: number, dy: number) => void, onTripleTap: () => void): UseSwipeGestureResult` where `GestureState = { dx: number; dy: number; dragging: boolean }` (drop `lockedDirection`).

- [ ] **Step 1: Update the hook**

In `frontend/src/hooks/useSwipeGesture.ts`:

Change the import line from:
```ts
import { detectDirection, SWIPE_THRESHOLD, type SwipeDirection } from '../lib/swipe'
```
to:
```ts
import { SWIPE_THRESHOLD } from '../lib/swipe'
```

Replace the `GestureState` interface and `IDLE` with:
```ts
export interface GestureState {
  dx: number
  dy: number
  dragging: boolean
}

const IDLE: GestureState = { dx: 0, dy: 0, dragging: false }
```

Change the signature/param name from `onDirectionCommit: (dir: SwipeDirection) => void` to `onCommit: (dx: number, dy: number) => void`, and update the ref:
```ts
export function useSwipeGesture(
  onCommit: (dx: number, dy: number) => void,
  onTripleTap: () => void,
): UseSwipeGestureResult {
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const onCommitRef = useRef(onCommit)
  const onTripleTapRef = useRef(onTripleTap)
  onCommitRef.current = onCommit
  onTripleTapRef.current = onTripleTap
```

In `onPointerDown`, drop `lockedDirection`:
```ts
    setState(s => ({ ...s, dx: 0, dy: 0, dragging: true }))
```

Replace the tail of `onPointerUp` (the `detectDirection` block) with a magnitude gate that commits raw deltas:
```ts
    if (Math.hypot(dx, dy) >= SWIPE_THRESHOLD) {
      setState({ dx, dy, dragging: false })
      onCommitRef.current(dx, dy)
    } else {
      // Below threshold — spring back
      setState(IDLE)
    }
```

- [ ] **Step 2: Typecheck / find broken callers**

Run: `cd frontend && bunx tsc --noEmit`
Expected: errors only in `SwipeCard.tsx` (still passes an old-style handler) — confirms the hook compiles and pinpoints the next task. If a `useSwipeGesture.test.ts(x)` exists, update its `onCommit` expectation to receive `(dx, dy)`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useSwipeGesture.ts
git commit -m "refactor(swipe): gesture hook commits raw dx/dy for zone resolution"
```

---

## Task 3: `SwipeCard` resolves zones

**Files:**
- Modify: `frontend/src/components/swipe/SwipeCard.tsx`

**Interfaces:**
- Consumes: `SwipeConfig`, `EdgeKey`, `Zone`, `previewZone`, `overlayProgress`, `GROUP_COLOR`, `GROUP_ICON` from `lib/swipe`; `GestureState` (no `lockedDirection`).
- Produces:
  - `SWIPE_ICONS: Record<string, LucideIcon>` (unchanged export).
  - `SwipeCard` props: `{ txn: Txn; config: SwipeConfig; catName: (id: number) => string; flying?: EdgeKey | null; onZoneCommit: (zone: Zone) => void; onTripleTap: () => void; onExitComplete: () => void; onPreview?: (zone: Zone | null, progress: number) => void }`.

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `frontend/src/components/swipe/SwipeCard.tsx` with:

```tsx
// frontend/src/components/swipe/SwipeCard.tsx
import { useEffect, useRef, type CSSProperties } from 'react'
import { Heart, Home, PiggyBank, ArrowLeftRight, type LucideIcon } from 'lucide-react'
import { formatFils, aedFils, nativeAmountTag } from '../../lib/money'
import type { Txn } from '../../api/types'
import {
  type SwipeConfig,
  type EdgeKey,
  type Zone,
  overlayProgress,
  previewZone,
  resolveZone,
  GROUP_COLOR,
  GROUP_ICON,
} from '../../lib/swipe'
import { useSwipeGesture } from '../../hooks/useSwipeGesture'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

export const SWIPE_ICONS: Record<string, LucideIcon> = { Heart, Home, PiggyBank, ArrowLeftRight }

// Pixel values the card animates to on exit, per edge.
const EXIT: Record<EdgeKey, { x: number; y: number; rot: number }> = {
  left:  { x: -600, y: 0,    rot: -20 },
  right: { x:  600, y: 0,    rot:  20 },
  up:    { x: 0,    y: -800, rot:   0 },
  down:  { x: 0,    y:  800, rot:   0 },
}

// Where the confirming badge sits, per edge (position + centering base).
const BADGE_POS: Record<EdgeKey, { style: CSSProperties; center: string }> = {
  left:  { style: { left: 16, top: '50%' },    center: 'translateY(-50%)' },
  right: { style: { right: 16, top: '50%' },   center: 'translateY(-50%)' },
  up:    { style: { top: 16, left: '50%' },    center: 'translateX(-50%)' },
  down:  { style: { bottom: 16, left: '50%' }, center: 'translateX(-50%)' },
}

/** Stable hue from a merchant string, so each merchant keeps its own color. */
function hueFor(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

/** Human label for a resolved zone. */
function zoneLabel(zone: Zone, catName: (id: number) => string): string {
  return zone.kind === 'category' ? catName(zone.categoryId) : 'Other…'
}

interface SwipeCardProps {
  txn: Txn
  config: SwipeConfig
  /** Resolve a category ID to its display name (for the confirming badge). */
  catName: (id: number) => string
  /** When set, card plays fly-out toward this edge; call onExitComplete after. */
  flying?: EdgeKey | null
  onZoneCommit: (zone: Zone) => void
  onTripleTap: () => void
  onExitComplete: () => void
  /** Live drag feedback so the deck can light the matching zone. */
  onPreview?: (zone: Zone | null, progress: number) => void
}

export function SwipeCard({
  txn,
  config,
  catName,
  flying = null,
  onZoneCommit,
  onTripleTap,
  onExitComplete,
  onPreview,
}: SwipeCardProps) {
  const handleCommit = (dx: number, dy: number) => {
    const zone = resolveZone(dx, dy, config)
    if (zone) onZoneCommit(zone)
  }
  const { state, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, reset } =
    useSwipeGesture(handleCommit, onTripleTap)
  const reduceMotion = usePrefersReducedMotion()

  const exitedRef = useRef(false)

  useEffect(() => {
    reset()
    exitedRef.current = false
  }, [txn.ID, reset])

  const { dx, dy, dragging } = state

  const preview = previewZone(dx, dy, config)
  const edge: EdgeKey | null = flying ?? preview?.edge ?? null
  const progress = edge ? overlayProgress(dx, dy) : 0

  // Report live drag zone/strength up to the deck (skip while flying out).
  useEffect(() => {
    if (!flying) onPreview?.(preview, progress)
  }, [preview, progress, flying, onPreview])

  const exit = flying ? EXIT[flying] : null
  const tx = exit ? exit.x : dx
  const ty = exit ? exit.y : dy
  const rot = exit ? exit.rot : dx * 0.04

  const color = edge ? GROUP_COLOR[config.edges[edge].group] : null
  const Icon: LucideIcon | null = edge
    ? SWIPE_ICONS[GROUP_ICON[config.edges[edge].group]] ?? Heart
    : null
  const badgeLabel = preview ? zoneLabel(preview, catName) : ''

  const date = new Date(txn.PostedAt).toLocaleDateString('en-AE', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const credit = txn.Direction === 'credit'
  const hue = hueFor(txn.MerchantRaw || '?')
  const ring = color ? Math.min(progress, 1) : 0

  return (
    <div
      style={{
        transform: `translateX(${tx}px) translateY(${ty}px) rotate(${rot}deg)`,
        transition: flying
          ? 'transform 0.35s ease-in, opacity 0.35s ease-in'
          : dragging
          ? 'none'
          : reduceMotion
          ? 'transform 0.15s ease-out'
          : 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        opacity: flying ? 0 : 1,
        boxShadow: ring > 0
          ? `0 0 0 ${2 + ring * 2}px ${color}, 0 18px 40px -12px ${color}99`
          : '0 18px 40px -16px rgba(20,23,31,0.35)',
        touchAction: 'none',
        userSelect: 'none',
        willChange: 'transform',
      }}
      className="relative w-full bg-surface rounded-[12px] cursor-grab active:cursor-grabbing overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onTransitionEnd={flying ? (e) => {
        if (e.propertyName === 'opacity' && e.target === e.currentTarget && !exitedRef.current) {
          exitedRef.current = true
          onExitComplete()
        }
      } : undefined}
    >
      <div className="px-7 pt-9 pb-8 flex flex-col items-center gap-5">
        <div
          className="w-[72px] h-[72px] rounded-xl flex items-center justify-center"
          style={{ backgroundColor: `hsl(${hue} 72% 93%)`, color: `hsl(${hue} 58% 38%)` }}
        >
          <span className="text-3xl font-bold">
            {(txn.MerchantRaw || '?').charAt(0).toUpperCase()}
          </span>
        </div>

        <div className="text-center">
          <h2 className="text-xl font-semibold text-fg leading-tight px-2 line-clamp-2 break-words">
            {txn.MerchantRaw || '—'}
          </h2>
          <p className="text-sm text-muted mt-1">{date}</p>
        </div>

        <div className="flex flex-col items-center -mt-0.5">
          <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted mb-1">
            {credit ? 'Received' : 'Spent'} · AED
          </span>
          <span
            className="font-rounded font-bold tabular-nums leading-none"
            style={{ fontSize: '3rem', color: credit ? 'var(--color-good)' : 'var(--color-fg)' }}
          >
            {credit ? '+' : '−'}{formatFils(aedFils(txn) ?? txn.AmountFils)}
          </span>
          {nativeAmountTag(txn) && (
            <p className="text-xs text-muted">{nativeAmountTag(txn)}{aedFils(txn) === null ? " · no AED rate" : ""}</p>
          )}
        </div>
      </div>

      {/* Confirming badge — appears at the leaning/committed edge */}
      {edge && color && (dragging || flying) && (
        <div
          className="absolute flex items-center gap-2 px-4 py-2 rounded-full text-bg font-semibold shadow-lg pointer-events-none"
          style={{
            ...BADGE_POS[edge].style,
            backgroundColor: color,
            opacity: flying ? 1 : Math.min(progress * 1.2, 1),
            transform: `${BADGE_POS[edge].center} scale(${0.85 + ring * 0.15})`,
          }}
        >
          {Icon && <Icon size={18} className="shrink-0" />}
          <span className="text-sm tracking-wide">{badgeLabel}</span>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && bunx tsc --noEmit`
Expected: errors only in `SwipeDeck.tsx` (still uses `onDirectionCommit`/`config[dir]`) — next task.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/swipe/SwipeCard.tsx
git commit -m "feat(swipe): SwipeCard resolves 8 zones and labels the badge by category"
```

---

## Task 4: `SwipeDeck` — 3-segment rails, zone commit, Other→panel

**Files:**
- Modify: `frontend/src/components/swipe/SwipeDeck.tsx`
- Test: `frontend/src/components/swipe/SwipeDeck.refund.test.tsx` (must stay green)

**Interfaces:**
- Consumes: `SwipeCard` (`onZoneCommit`, `catName`, `config`), `SubcategoryPanel` (new `group` prop from Task 5), `Zone`, `EdgeKey`, `EdgeGroup`, `GROUP_COLOR`, `GROUP_ICON`, `DEFAULT_SWIPE_CONFIG`.
- Produces: `SwipeDeck` public props unchanged (`{ transactions; categories; config? }`).

- [ ] **Step 1: Rewrite the file**

Replace the entire contents of `frontend/src/components/swipe/SwipeDeck.tsx` with:

```tsx
import { useState, useCallback, useMemo, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle, Heart, type LucideIcon } from 'lucide-react'
import { postJSON } from '../../api/client'
import { fire } from '../../lib/feedback'
import type { Txn, Category } from '../../api/types'
import {
  type SwipeConfig,
  type EdgeKey,
  type EdgeGroup,
  type Zone,
  DEFAULT_SWIPE_CONFIG,
  GROUP_COLOR,
  GROUP_ICON,
} from '../../lib/swipe'
import { SwipeCard, SWIPE_ICONS } from './SwipeCard'
import { SubcategoryPanel } from './SubcategoryPanel'
import { LinkRefundSheet } from '../transactions/LinkRefundSheet'

interface SwipeDeckProps {
  transactions: Txn[]
  categories: Category[]
  config?: SwipeConfig
}

interface DeckState {
  index: number
  skippedIds: Set<number>
  pendingGroup: EdgeGroup | null
  flyEdge: EdgeKey | null
  makeRule: boolean
  previewEdge: EdgeKey | null
  previewProgress: number
}

// Edge placement for each rail (position + orientation).
const RAIL_POS: Record<EdgeKey, { style: CSSProperties; vertical: boolean }> = {
  up:    { style: { top: 0, left: '50%', transform: 'translateX(-50%)' }, vertical: false },
  down:  { style: { bottom: 0, left: '50%', transform: 'translateX(-50%)' }, vertical: false },
  left:  { style: { left: 0, top: '50%', transform: 'translateY(-50%)' }, vertical: true },
  right: { style: { right: 0, top: '50%', transform: 'translateY(-50%)' }, vertical: true },
}

// Color wash bleeding inward from the active edge.
const WASH: Record<EdgeKey, (c: string) => string> = {
  left:  c => `linear-gradient(90deg, ${c}59 0%, ${c}00 55%)`,
  right: c => `linear-gradient(270deg, ${c}59 0%, ${c}00 55%)`,
  up:    c => `linear-gradient(180deg, ${c}59 0%, ${c}00 55%)`,
  down:  c => `linear-gradient(0deg, ${c}59 0%, ${c}00 55%)`,
}

/** One rail per edge: slot A, slot B, and a slim "Other" segment. */
function EdgeRail({
  edge,
  config,
  catName,
  active,
}: {
  edge: EdgeKey
  config: SwipeConfig
  catName: (id: number) => string
  active: boolean
}) {
  const ec = config.edges[edge]
  const color = GROUP_COLOR[ec.group]
  const Icon: LucideIcon = SWIPE_ICONS[GROUP_ICON[ec.group]] ?? Heart
  const { style, vertical } = RAIL_POS[edge]

  const segStyle = (on: boolean, slim: boolean): CSSProperties => ({
    backgroundColor: on ? color : `${color}1f`,
    color: on ? '#ffffff' : color,
    padding: slim ? '2px 6px' : vertical ? '6px 8px' : '6px 10px',
    fontSize: slim ? '9px' : '11px',
  })

  const slotA = ec.slotA ? catName(ec.slotA) : ''
  const slotB = ec.slotB ? catName(ec.slotB) : ''

  return (
    <div className="absolute z-10 pointer-events-none" style={style}>
      <div
        className={`flex items-stretch rounded-lg overflow-hidden font-semibold transition-all duration-200 ${vertical ? 'flex-col w-14' : 'flex-row'}`}
        style={{ transform: `scale(${active ? 1.06 : 1})`, boxShadow: active ? `0 10px 24px -8px ${color}` : 'none' }}
      >
        <div className="flex items-center justify-center gap-1 leading-none" style={segStyle(false, false)}>
          <Icon size={13} className="shrink-0" />
          <span className="tracking-wide truncate max-w-[72px]">{slotA || '—'}</span>
        </div>
        <div className="flex items-center justify-center leading-none" style={segStyle(false, false)}>
          <span className="tracking-wide truncate max-w-[72px]">{slotB || '—'}</span>
        </div>
        <div className="flex items-center justify-center leading-none opacity-80" style={segStyle(false, true)}>
          <span className="tracking-wide">Other</span>
        </div>
      </div>
    </div>
  )
}

export function SwipeDeck({ transactions, categories, config = DEFAULT_SWIPE_CONFIG }: SwipeDeckProps) {
  const qc = useQueryClient()

  const catName = useMemo(() => {
    const m = new Map(categories.map(c => [c.ID, c.Name]))
    return (id: number) => m.get(id) ?? ''
  }, [categories])

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingGroup: null,
    flyEdge: null,
    makeRule: true,
    previewEdge: null,
    previewProgress: 0,
  })
  const [linkOpen, setLinkOpen] = useState(false)

  const [frozenTxns] = useState(() => transactions)
  const queue = frozenTxns.filter(t => !state.skippedIds.has(t.ID))
  const current = queue[state.index] ?? null
  const next = queue[state.index + 1] ?? null

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['review'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['summary'] })
  }, [qc])

  const categorize = useCallback((categoryId: number, edge: EdgeKey) => {
    if (!current) return
    // Caller fires the feedback cue (success for a direct swipe, selection for
    // a panel pick) so a single action never double-fires.
    setState(s => ({ ...s, pendingGroup: null, flyEdge: edge }))
    postJSON(`/api/transactions/${current.ID}/categorize`, {
      category_id: categoryId,
      merchant_raw: current.MerchantRaw,
      make_rule: state.makeRule,
    }).then(invalidate).catch(() => { /* fixable from list view */ })
  }, [current, state.makeRule, invalidate])

  const handleZoneCommit = useCallback((zone: Zone) => {
    if (zone.kind === 'category') {
      fire('success')
      categorize(zone.categoryId, zone.edge)
    } else {
      // Slim "Other" sliver → open the sheet filtered to this edge's group.
      setState(s => ({ ...s, pendingGroup: zone.group }))
    }
  }, [categorize])

  const handleCategorySelect = useCallback((categoryId: number) => {
    // The panel that opened from an Other sliver — fly toward that edge.
    const edge = (['up', 'down', 'left', 'right'] as const).find(
      e => config.edges[e].group === state.pendingGroup,
    ) ?? 'down'
    fire('selection')
    categorize(categoryId, edge)
  }, [config, state.pendingGroup, categorize])

  const handleExitComplete = useCallback(() => {
    setState(s => ({ ...s, flyEdge: null, index: s.index + 1, previewEdge: null, previewProgress: 0 }))
  }, [])

  const handleTripleTap = useCallback(() => {
    if (!current) return
    setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }))
  }, [current])

  const handlePreview = useCallback((zone: Zone | null, progress: number) => {
    const edge = zone?.edge ?? null
    setState(s => (s.previewEdge === edge && s.previewProgress === progress
      ? s
      : { ...s, previewEdge: edge, previewProgress: progress }))
  }, [])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingGroup: null }))
  }, [])

  const done = state.index >= queue.length

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-5 text-center px-8">
        <CheckCircle size={72} className="text-good" />
        <h2 className="text-2xl font-bold text-fg">All caught up!</h2>
        <p className="text-muted">
          {state.index} transaction{state.index !== 1 ? 's' : ''} categorized this session
        </p>
      </div>
    )
  }

  const total = queue.length
  const progress = state.index / total
  const remaining = total - state.index

  const activeEdge = state.flyEdge ?? state.previewEdge
  const activeColor = activeEdge ? GROUP_COLOR[config.edges[activeEdge].group] : null
  const washOpacity = activeEdge ? (state.flyEdge ? 1 : Math.min(state.previewProgress, 1)) : 0

  return (
    <div className="flex-1 flex flex-col w-full max-w-sm mx-auto px-4">
      <div className="flex items-end justify-between mb-3 px-1">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted mb-0.5">Remaining</p>
          <p className="font-rounded font-bold text-fg leading-none" style={{ fontSize: '2rem' }}>{remaining}</p>
        </div>
        <p className="text-sm text-muted mb-1 tabular-nums">{state.index} of {total} sorted</p>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden mb-4">
        <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="relative flex-1 flex items-center justify-center">
        {activeEdge && activeColor && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none rounded-[28px] transition-opacity duration-150"
            style={{ opacity: washOpacity, background: WASH[activeEdge](activeColor) }}
          />
        )}

        {(['up', 'down', 'left', 'right'] as const).map(edge => (
          <EdgeRail key={edge} edge={edge} config={config} catName={catName} active={activeEdge === edge} />
        ))}

        <div className="relative w-[80%] max-w-[320px]">
          {next && (
            <div
              aria-hidden
              className="absolute inset-0 bg-surface rounded-[12px] shadow-lg"
              style={{ transform: 'scale(0.94) translateY(14px)', zIndex: 0 }}
            />
          )}
          {current && (
            <div key={current.ID} className="relative swipe-card-in" style={{ zIndex: 1 }}>
              <SwipeCard
                txn={current}
                config={config}
                catName={catName}
                flying={state.flyEdge}
                onZoneCommit={handleZoneCommit}
                onTripleTap={handleTripleTap}
                onExitComplete={handleExitComplete}
                onPreview={handlePreview}
              />
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted mt-4">Swipe toward a category · triple-tap to skip</p>

      {current && current.Direction === 'credit' && (
        <button className="mx-auto mt-2 text-sm font-medium text-accent" onClick={() => setLinkOpen(true)}>
          This is a refund — link the purchase
        </button>
      )}

      {state.pendingGroup && (
        <SubcategoryPanel
          group={state.pendingGroup}
          categories={categories}
          makeRule={state.makeRule}
          onMakeRuleChange={v => setState(s => ({ ...s, makeRule: v }))}
          onSelect={handleCategorySelect}
          onCancel={handleCancel}
        />
      )}

      {linkOpen && current && (
        <LinkRefundSheet
          txn={current}
          onLinked={() => {
            setLinkOpen(false)
            invalidate()
            setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }))
          }}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run the refund test to verify it still passes**

Run: `cd frontend && bunx vitest run src/components/swipe/SwipeDeck.refund.test.tsx`
Expected: PASS (both cases — the refund button path is untouched; deck renders with `categories={[]}`).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/swipe/SwipeDeck.tsx
git commit -m "feat(swipe): 3-segment edge rails, zone commit, Other opens group sheet"
```

---

## Task 5: `SubcategoryPanel` filters by group

**Files:**
- Modify: `frontend/src/components/swipe/SubcategoryPanel.tsx`
- Test: `frontend/src/components/swipe/SubcategoryPanel.test.tsx`

**Interfaces:**
- Consumes: `EdgeGroup`, `GROUP_COLOR` from `lib/swipe`.
- Produces: `SubcategoryPanel` props `{ group: EdgeGroup; categories: Category[]; makeRule: boolean; onMakeRuleChange: (v: boolean) => void; onSelect: (categoryId: number) => void; onCancel: () => void }`.

- [ ] **Step 1: Read the existing test**

Read `frontend/src/components/swipe/SubcategoryPanel.test.tsx` to see how it renders the panel; note the prop shape it passes (it currently passes an `action`).

- [ ] **Step 2: Update the test to the group API**

In `frontend/src/components/swipe/SubcategoryPanel.test.tsx`, change every render of `<SubcategoryPanel action={...} />` to pass `group={...}` instead. For a spending case use `group="need"`; the title becomes the group label. Add one case for the income/excluded group:

```tsx
it('lists income and excluded categories for the "other" group', () => {
  const categories = [
    { ID: 1, Name: 'Salary', Kind: 'income', Bucket: '', IsActive: true },
    { ID: 2, Name: 'Transfers', Kind: 'excluded', Bucket: '', IsActive: true },
    { ID: 3, Name: 'Groceries', Kind: 'spending', Bucket: 'need', IsActive: true },
  ]
  render(
    <SubcategoryPanel
      group="other"
      categories={categories}
      makeRule={false}
      onMakeRuleChange={() => {}}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  )
  expect(screen.getByText('Salary')).toBeInTheDocument()
  expect(screen.getByText('Transfers')).toBeInTheDocument()
  expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
})
```

(Keep the existing spending-bucket assertions, adapting them to `group="need"`.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && bunx vitest run src/components/swipe/SubcategoryPanel.test.tsx`
Expected: FAIL — `SubcategoryPanel` still expects an `action` prop / filters by `action.bucket`.

- [ ] **Step 4: Rewrite the component**

Replace the entire contents of `frontend/src/components/swipe/SubcategoryPanel.tsx` with:

```tsx
import type { Category } from '../../api/types'
import { type EdgeGroup, GROUP_COLOR } from '../../lib/swipe'
import { Dialog } from '../ui/Dialog'

const GROUP_LABEL: Record<EdgeGroup, string> = {
  need: 'Need',
  want: 'Want',
  saving: 'Save',
  other: 'Transfer / Income',
}

interface SubcategoryPanelProps {
  group: EdgeGroup
  categories: Category[]
  makeRule: boolean
  onMakeRuleChange: (v: boolean) => void
  onSelect: (categoryId: number) => void
  onCancel: () => void
}

/** Bottom sheet for picking a category from an edge's "Other" sliver. Filters
 *  to the edge's group: a spending bucket, or income+excluded for "other". */
export function SubcategoryPanel({
  group,
  categories,
  makeRule,
  onMakeRuleChange,
  onSelect,
  onCancel,
}: SubcategoryPanelProps) {
  const color = GROUP_COLOR[group]
  const visible = categories.filter(c => {
    if (!c.IsActive) return false
    if (group === 'other') return c.Kind === 'income' || c.Kind === 'excluded'
    return c.Kind === 'spending' && c.Bucket === group
  })

  return (
    <Dialog
      title={GROUP_LABEL[group]}
      titleAdornment={<span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
      titleStyle={{ color }}
      onClose={onCancel}
    >
      <div className="grid grid-cols-2 gap-2 mb-4">
        {visible.map(cat => (
          <button
            key={cat.ID}
            onClick={() => onSelect(cat.ID)}
            className="min-h-14 py-3 px-4 rounded-lg border border-border text-base font-medium text-fg hover:bg-surface-2 press text-left"
          >
            {cat.Name}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-3 py-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={makeRule}
          onChange={e => onMakeRuleChange(e.target.checked)}
          className="w-5 h-5 accent-accent"
        />
        <span className="text-sm text-muted">Always use this category for this merchant</span>
      </label>
    </Dialog>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && bunx vitest run src/components/swipe/SubcategoryPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/swipe/SubcategoryPanel.tsx frontend/src/components/swipe/SubcategoryPanel.test.tsx
git commit -m "feat(swipe): SubcategoryPanel filters by edge group incl. income/excluded"
```

---

## Task 6: Settings — per-slot category pickers + hub summary

**Files:**
- Modify: `frontend/src/lib/settingsSummary.ts` (rewrite `swipeSummary`)
- Modify: `frontend/src/lib/settingsSummary.test.ts` (update the `swipeSummary` test)
- Modify (rewrite): `frontend/src/screens/settings/SwipePage.tsx`
- Modify: `frontend/src/screens/settings/SettingsHub.tsx` (stop calling the removed `loadSwipeConfig()` shape)

**Interfaces:**
- Consumes: `loadSwipeConfig`, `saveSwipeConfig`, `buildDefaultConfig`, `EdgeKey`, `EdgeGroup`, `SwipeConfig`, `SlotKey`; `Category`, `getJSON`.
- Produces: `swipeSummary(): string` (no longer takes a `SwipeConfig` — edge→group is fixed, so the summary is constant).

**Context:** `swipeSummary` currently reads `cfg.left.label`/`cfg.right.label` from the old 4-action config, and `SettingsHub` calls `loadSwipeConfig()` with no args (v2 requires a categories array). Both break under the v2 API. Since edge→group is fixed (left=Want, right=Need), the hub preview is now a constant string; make `swipeSummary` take no argument, and drop the swipe-config load from the hub entirely.

- [ ] **Step 1: Update the `swipeSummary` test (TDD RED)**

In `frontend/src/lib/settingsSummary.test.ts`: remove the `DEFAULT_SWIPE_CONFIG` import (line 10) and change the `swipeSummary` describe block to call it with no argument:

```ts
describe("swipeSummary", () => {
  it("shows the fixed horizontal directions", () => {
    expect(swipeSummary()).toBe("← Want · → Need");
  });
});
```

Run: `cd frontend && bunx vitest run src/lib/settingsSummary.test.ts`
Expected: FAIL — `swipeSummary` still expects a `SwipeConfig` argument / references `cfg.left`.

- [ ] **Step 2: Rewrite `swipeSummary` (TDD GREEN)**

In `frontend/src/lib/settingsSummary.ts`: remove the `import type { SwipeConfig } from "./swipe";` line, and replace the `swipeSummary` function with:

```ts
/** "← Want · → Need" — the fixed horizontal swipe groups, the ones users hit most. */
export function swipeSummary(): string {
  return "← Want · → Need";
}
```

Run: `cd frontend && bunx vitest run src/lib/settingsSummary.test.ts`
Expected: PASS (all cases in the file).

- [ ] **Step 3: Update `SettingsHub.tsx`**

In `frontend/src/screens/settings/SettingsHub.tsx`:
- Delete the import `import { loadSwipeConfig } from "../../lib/swipe";` (line 9).
- Delete the line `const swipe = loadSwipeConfig();` (line 110).
- Change the Swipe actions row from `value={swipeSummary(swipe)}` to `value={swipeSummary()}` (line 132).

- [ ] **Step 4: Rewrite the page**

Replace the entire contents of `frontend/src/screens/settings/SwipePage.tsx` with:

```tsx
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../../api/client";
import type { Category } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Field";
import { SettingsPage } from "./SettingsPage";
import { SavedFlash, useSavedFlash } from "./SavedFlash";
import {
  loadSwipeConfig,
  saveSwipeConfig,
  buildDefaultConfig,
  type SwipeConfig,
  type EdgeKey,
  type EdgeGroup,
  type SlotKey,
} from "../../lib/swipe";

// Rows are shown edge-first; each edge is one fixed group.
const EDGE_ROWS: { edge: EdgeKey; arrow: string; label: string; group: EdgeGroup }[] = [
  { edge: "right", arrow: "→", label: "Need", group: "need" },
  { edge: "left", arrow: "←", label: "Want", group: "want" },
  { edge: "down", arrow: "↓", label: "Save", group: "saving" },
  { edge: "up", arrow: "↑", label: "Transfer / Income", group: "other" },
];

function groupCategories(categories: Category[], group: EdgeGroup): Category[] {
  return categories.filter((c) =>
    c.IsActive &&
    (group === "other"
      ? c.Kind === "income" || c.Kind === "excluded"
      : c.Kind === "spending" && c.Bucket === group),
  );
}

export function SwipePage({ onClose }: { onClose: () => void }) {
  const { saved, flash } = useSavedFlash();
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const categories = cats.data ?? [];
  // Seed once categories have loaded, so a fresh install (no saved config) gets
  // real default slots instead of empty "—". loadSwipeConfig still honors any
  // saved v2 config regardless of the categories passed.
  const [swipeCfg, setSwipeCfg] = useState<SwipeConfig | null>(null);
  useEffect(() => {
    if (swipeCfg === null && !cats.isPending) setSwipeCfg(loadSwipeConfig(cats.data ?? []));
  }, [swipeCfg, cats.isPending, cats.data]);

  const commit = (next: SwipeConfig) => {
    setSwipeCfg(next);
    saveSwipeConfig(next);
    flash();
  };

  const setSlot = (edge: EdgeKey, slot: SlotKey, id: number) => {
    if (!swipeCfg) return;
    const next: SwipeConfig = {
      ...swipeCfg,
      edges: {
        ...swipeCfg.edges,
        [edge]: { ...swipeCfg.edges[edge], [slot === "A" ? "slotA" : "slotB"]: id },
      },
    };
    commit(next);
  };

  return (
    <SettingsPage title="Swipe actions" onClose={onClose} headerRight={<SavedFlash saved={saved} />}>
      <div>
        <p className="text-xs text-muted mb-3">
          Two categories per edge, plus an “Other” swipe that opens the full list for that group.
        </p>
        {!swipeCfg ? (
          <p className="text-sm text-muted py-4">Loading…</p>
        ) : (
          <>
            <div className="space-y-3">
              {EDGE_ROWS.map(({ edge, arrow, label, group }) => {
                const opts = groupCategories(categories, group);
                const ec = swipeCfg.edges[edge];
                return (
                  <div key={edge} className="flex items-center gap-2">
                    <span className="w-9 h-9 grid place-items-center rounded-lg bg-surface-2 text-sm shrink-0" aria-hidden>{arrow}</span>
                    <span className="text-sm w-16 shrink-0">{label}</span>
                    <Select value={String(ec.slotA)} aria-label={`${label} slot A`} onChange={(e) => setSlot(edge, "A", Number(e.target.value))} className="flex-1 min-w-0">
                      <option value="0">—</option>
                      {opts.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
                    </Select>
                    <Select value={String(ec.slotB)} aria-label={`${label} slot B`} onChange={(e) => setSlot(edge, "B", Number(e.target.value))} className="flex-1 min-w-0">
                      <option value="0">—</option>
                      {opts.map((c) => <option key={c.ID} value={c.ID}>{c.Name}</option>)}
                    </Select>
                  </div>
                );
              })}
            </div>
            <Button variant="ghost" className="mt-3 text-sm" onClick={() => commit(buildDefaultConfig(categories))}>
              Reset to defaults
            </Button>
          </>
        )}
      </div>
    </SettingsPage>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && bunx tsc --noEmit`
Expected: the only remaining errors are in `Review.tsx` (Task 7). `settingsSummary.ts`, `SettingsHub.tsx`, and `SwipePage.tsx` are now clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/settingsSummary.ts frontend/src/lib/settingsSummary.test.ts frontend/src/screens/settings/SwipePage.tsx frontend/src/screens/settings/SettingsHub.tsx
git commit -m "feat(settings): per-slot category pickers + fixed-group hub summary for 8-zone deck"
```

---

## Task 7: `Review.tsx` builds config from loaded categories

**Files:**
- Modify: `frontend/src/screens/Review.tsx`

**Interfaces:**
- Consumes: `loadSwipeConfig(categories)`.
- Produces: no new exports.

- [ ] **Step 1: Wire categories into config**

In `frontend/src/screens/Review.tsx`:

Remove the `useState`-at-mount config (which no longer has categories) — delete:
```ts
  const [config] = useState(loadSwipeConfig);
```
and drop `useState` from the React import if it becomes unused.

After the `cats` query is defined, derive the config once categories are present (place above the `loading` line):
```ts
  const config = useMemo(
    () => (cats.data ? loadSwipeConfig(cats.data) : undefined),
    [cats.data],
  );
```
Add `useMemo` to the `react` import.

Then guard the deck render on `config` being ready (the deck already only renders when not loading, and `loading` includes `cats.isPending`, so `config` is defined there — but pass it directly):
```tsx
      {!loading && !empty && config && (
        <SwipeDeck key={deckKey} transactions={txns.data!} categories={cats.data!} config={config} />
      )}
```

- [ ] **Step 2: Typecheck + full frontend test run**

Run: `cd frontend && bunx tsc --noEmit && bun run test`
Expected: PASS — no type errors; all vitest files green (swipe geometry, SubcategoryPanel, SwipeDeck refund, Review, plus untouched suites).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/screens/Review.tsx
git commit -m "feat(review): build swipe config from loaded categories"
```

---

## Task 8: Cleanup, dead-code sweep, embedded dist rebuild

**Files:**
- Verify across `frontend/src/` for stale references.
- Rebuild `internal/web/dist/`.

- [ ] **Step 1: Grep for retired symbols**

Run:
```bash
cd frontend && grep -rn "detectDirection\|previewDirection\|SwipeDirection\|SwipeAction\|statusOverride\|actionColor\|bucketKey\|DEFAULT_SWIPE_CONFIG.up" src/
```
Expected: no hits except intentional ones. If `detectDirection`/`previewDirection`/`SwipeAction`/`SwipeDirection`/`bucketKey`/`actionColor` are unreferenced, they were already removed in Task 1's rewrite — confirm none linger in other files (e.g. an old import). Fix any stragglers by migrating them to `EdgeKey`/`Zone`/`GROUP_COLOR`.

- [ ] **Step 2: Full typecheck + tests + Go build sanity**

Run:
```bash
cd frontend && bunx tsc --noEmit && bun run test
```
Expected: PASS.

- [ ] **Step 3: Rebuild the embedded PWA bundle**

Run:
```bash
cd frontend && bun run build
```
Expected: writes `internal/web/dist/`. Then from repo root:
```bash
CGO_ENABLED=0 go build -o /tmp/ledger-build ./cmd/ledger && echo "go build ok"
```
Expected: `go build ok` (embed picks up the new dist).

- [ ] **Step 4: Commit the rebuilt bundle**

```bash
git add internal/web/dist frontend/src
git commit -m "chore(web): rebuild embedded dist (8-zone review categorizer)"
```

- [ ] **Step 5: Manual verification (real app)**

Use the `verify`/`run` skill to launch the binary against a scratch DB (not prod — see memory), open the Review tab, and confirm: swiping right-up categorizes to Need slot A, right-down to Need slot B, straight-right opens the Need "Other" sheet, up edge assigns income/excluded, triple-tap skips, and the refund button still opens the link sheet. Confirm Settings › Swipe actions shows two dropdowns per edge and persists a change across reload.

---

## Self-Review Notes

- **Spec coverage:** layout (Task 4 rails + Task 3 badge), geometry/sliver (Task 1), config+migration (Task 1), settings (Task 6), Other→sheet with group incl. income/excluded (Tasks 4–5), transfer retired via excluded category (Task 4 removes the status path), backend untouched (no backend task), tests (Tasks 1,5 + refund kept green in Task 4), dist rebuild (Task 8). All spec sections map to a task.
- **Placeholders:** none — every code step is complete file content or an exact edit.
- **Type consistency:** `EdgeKey`/`EdgeGroup`/`Zone`/`SwipeConfig`/`SlotKey`/`GROUP_COLOR`/`GROUP_ICON`/`resolveZone`/`previewZone`/`buildDefaultConfig`/`loadSwipeConfig(categories)` are defined in Task 1 and consumed with matching signatures in Tasks 2–7. `catName: (id:number)=>string` and `onZoneCommit: (zone: Zone)=>void` are consistent between SwipeCard (Task 3) and SwipeDeck (Task 4). `SubcategoryPanel` `group` prop consistent between Tasks 4 and 5.
```
