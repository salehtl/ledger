// frontend/src/lib/swipe.ts

export type SwipeDirection = 'left' | 'right' | 'up' | 'down'

export interface SwipeAction {
  /** Spending bucket to filter subcategories by. Null means no subcategory panel (transfer). */
  bucket: 'want' | 'need' | 'saving' | null
  /** When set, skip SubcategoryPanel and POST this status directly. */
  statusOverride?: 'transfer'
  label: string
  /** Tailwind background class for the directional overlay. */
  colorClass: string
  /** Tailwind text class for panel headers. */
  textClass: string
  /** lucide-react icon component name. */
  icon: string
}

export interface SwipeConfig {
  left: SwipeAction
  right: SwipeAction
  up: SwipeAction
  down: SwipeAction
}

export const SWIPE_THRESHOLD = 80

export const DEFAULT_SWIPE_CONFIG: SwipeConfig = {
  left:  { bucket: 'want',   label: 'Want',     colorClass: 'bg-purple-500', textClass: 'text-purple-700', icon: 'Heart' },
  right: { bucket: 'need',   label: 'Need',     colorClass: 'bg-blue-500',   textClass: 'text-blue-700',   icon: 'Home' },
  down:  { bucket: 'saving', label: 'Save',     colorClass: 'bg-green-500',  textClass: 'text-green-700',  icon: 'PiggyBank' },
  up:    { bucket: null, statusOverride: 'transfer', label: 'Transfer', colorClass: 'bg-amber-500', textClass: 'text-amber-700', icon: 'ArrowLeftRight' },
}

const STORAGE_KEY = 'ledger-swipe-config'

/**
 * Returns the dominant swipe direction if drag distance exceeds threshold.
 * The axis with larger absolute displacement wins.
 */
export function detectDirection(dx: number, dy: number, threshold = SWIPE_THRESHOLD): SwipeDirection | null {
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)
  if (absDx < threshold && absDy < threshold) return null
  if (absDx >= absDy) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}

/**
 * 0–1 progress for overlay opacity based on drag magnitude.
 * Reaches 1 at SWIPE_THRESHOLD.
 */
export function overlayProgress(dx: number, dy: number): number {
  const dist = Math.max(Math.abs(dx), Math.abs(dy))
  return Math.min(1, dist / SWIPE_THRESHOLD)
}

/**
 * Like detectDirection but uses a lower threshold (20px) for live preview feedback.
 */
export function previewDirection(dx: number, dy: number): SwipeDirection | null {
  return detectDirection(dx, dy, 20)
}

export function loadSwipeConfig(): SwipeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SwipeConfig>
      return { ...DEFAULT_SWIPE_CONFIG, ...parsed }
    }
  } catch { /* ignore corrupt data */ }
  return DEFAULT_SWIPE_CONFIG
}

export function saveSwipeConfig(config: SwipeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
