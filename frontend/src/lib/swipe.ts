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
