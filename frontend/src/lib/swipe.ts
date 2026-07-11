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

/** Brightened bucket colors for the graphite sorting console (glow), keyed by edge group. */
export const CONSOLE_COLOR: Record<EdgeGroup, string> = {
  need: '#3B82F6',
  want: '#8B5CF6',
  saving: '#10B981',
  other: '#94A3B8',
}

export const OTHER_MIN = 30      // below → cancel (spring back)
export const CATEGORY_MIN = 150  // below → Other, at/above → specific category
export const CAT_FULL = 90       // px past CATEGORY_MIN to reach full brightness

const STORAGE_KEY = 'ledger-swipe-config'

interface SeedCat {
  ID: number
  Kind: string
  Bucket: string
  IsActive: boolean
}

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
