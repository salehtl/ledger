// frontend/src/lib/swipe.ts
import { seedOfColor, type Rgb } from '../components/dither-kit/palette'
import { bucketDither } from './ditherColor'

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
 * Source of truth for swipe colours, derived from the bucket — not from the
 * action's persisted `colorClass` — so the palette applies even to configs
 * saved before a redesign, and Need/Want/Save/Transfer never collide.
 *
 * Which palette hue each bucket paints in. Resolved through the same seeds the
 * charts use, so a bucket looks the same on the deck as it does in a chart.
 *
 * This replaces a literal-hex map that had two problems. It hardcoded
 * `#16161a` while documenting itself as "mirrors --color-fg" — true in light,
 * but in dark `--color-fg` becomes `#ecebe8` and the literal stayed near-black,
 * putting every inactive rail at 1.02:1 on the dark ground. The rails, which
 * are the only thing telling you what each direction does, were invisible
 * until you dragged at one. It also collapsed need/want/saving to one ink, so
 * even in light three of the four rails were identical.
 *
 * Both are fixed by resolving through `palette.ts`, which carries a light and
 * a dark table. Buckets are told apart by hue, the same mapping the bars and
 * the swatch dots use — `bucketDither` is the single source of truth.
 */
const BUCKET_SEED: Record<BucketKey, Parameters<typeof seedOfColor>[0]> = {
  need: bucketDither('need'),
  want: bucketDither('want'),
  saving: bucketDither('saving'),
  transfer: 'azure', // its own hue — a transfer is a real destination, not an "other"
}

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

/**
 * Hex for a swipe action's bucket, in the currently active theme.
 *
 * Stays hex rather than a `var(--…)` reference because callers append an alpha
 * suffix (`${color}1f`) and interpolate it into gradients and shadows, neither
 * of which accepts a custom property. Components that render this must call
 * `useDitherTheme()` so an OS theme flip re-renders them — the value is
 * resolved at call time, not subscribed to.
 */
export function actionColor(a: SwipeAction): string {
  return toHex(seedOfColor(BUCKET_SEED[bucketKey(a)]).fill)
}

const INK = '#16161a'
const PAPER = '#ffffff'
const channel = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.substr(i, 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Label colour for text sitting *on* a filled bucket swatch — ink or paper,
 * whichever contrasts better against that fill.
 *
 * The active rail and the commit badge previously hardcoded white. White is
 * right on the darker seeds but not on the lighter ones: amber and sage in
 * dark leave a small semibold label at ~3:1, under the floor for its size.
 * Picking per fill keeps every combination legible without hand-maintaining a
 * table that would drift the next time the palette moves.
 */
export function onActionColor(fill: string): string {
  return contrast(PAPER, fill) >= contrast(INK, fill) ? PAPER : INK
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
