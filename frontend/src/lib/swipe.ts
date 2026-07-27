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
  /** PixelIcon component name (see components/ui/PixelIcon.tsx). */
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

/** Canonical bucket identity for an action, used to theme it consistently. */
export type BucketKey = 'need' | 'want' | 'saving' | 'transfer'

export function bucketKey(a: SwipeAction): BucketKey {
  if (a.statusOverride === 'transfer') return 'transfer'
  return (a.bucket as BucketKey) ?? 'transfer'
}

/**
 * Source of truth for swipe colors, derived from the bucket — not from the
 * action's persisted colorClass — so the palette applies even to configs saved
 * before a redesign, and Need/Want/Save/Transfer never collide.
 *
 * These feed inline styles (ring/box-shadow, edge-wash background, commit
 * badge) that concatenate an alpha suffix onto the hex string (e.g.
 * `${color}1f`) or interpolate it into a CSS gradient/shadow — a `var(...)`
 * reference can't be built that way, so the values must stay literal hex, not
 * CSS custom properties. Bucket hues are retired app-wide (buckets are told
 * apart by dither density and by the action's own text label, not colour —
 * see `components/README.md`'s DitherFill section), so all three real buckets
 * collapse to the same ink and Transfer (not real spending) to muted:
 *   need / want / saving -> #16161a (mirrors --color-fg)
 *   transfer             -> #5e5e63 (mirrors --color-muted)
 * Visually this makes the three buckets identical in the deck by design —
 * they're distinguished by density and by `action.label`, not by hue.
 */
export const BUCKET_COLOR: Record<BucketKey, string> = {
  need: '#16161a',
  want: '#16161a',
  saving: '#16161a',
  transfer: '#5e5e63',
}

export function actionColor(a: SwipeAction): string {
  return BUCKET_COLOR[bucketKey(a)]
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

/** Velocity (px/ms) above which a release counts as a flick. */
export const FLICK_VELOCITY = 0.11
/** A flick still needs enough travel to read as intentional. */
export const FLICK_MIN_DISTANCE = 24

/**
 * Momentum commit: a quick throw should sort the card even when it never
 * reached SWIPE_THRESHOLD. Returns the dominant direction when the release
 * velocity exceeds FLICK_VELOCITY over at least FLICK_MIN_DISTANCE, else null.
 * elapsedMs <= 0 (same-frame release) counts as maximally fast.
 */
export function flickDirection(dx: number, dy: number, elapsedMs: number): SwipeDirection | null {
  const dist = Math.max(Math.abs(dx), Math.abs(dy))
  if (dist < FLICK_MIN_DISTANCE) return null
  if (elapsedMs > 0 && dist / elapsedMs <= FLICK_VELOCITY) return null
  return detectDirection(dx, dy, FLICK_MIN_DISTANCE)
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
