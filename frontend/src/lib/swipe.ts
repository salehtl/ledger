// frontend/src/lib/swipe.ts
import { seedOfColor, type Rgb } from '../components/dither-kit/palette'
import { bucketDither } from './ditherColor'
import { flicked, FLICK_MIN_PX } from './gesture'

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

/** Travel past which a release commits, on either axis. */
export const COMMIT_PX = 100
/** px/s past which a release commits regardless of distance. */
export const COMMIT_VELOCITY = 520
/**
 * A flick still needs enough travel on its axis to read as intentional. This
 * is the app-wide floor from `lib/gesture.ts`, aliased so the deck's own
 * threshold block reads as one list; the guard it names is now shared with the
 * toast, sheet, edge-back and row predicates.
 */
export const FLICK_MIN_DISTANCE = FLICK_MIN_PX

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
 *
 * Reaches 1 at COMMIT_PX — the distance at which a release actually commits —
 * so a fully-lit badge and edge wash mean "let go now", not "20px more". It
 * used to saturate at SWIPE_THRESHOLD, which was the commit distance too until
 * commitDirection replaced the old detect/flick pair; leaving it there would
 * have made the strongest possible feedback appear on a drag that still
 * springs back.
 */
export function overlayProgress(dx: number, dy: number): number {
  const dist = Math.max(Math.abs(dx), Math.abs(dy))
  return Math.min(1, dist / COMMIT_PX)
}

/**
 * Like detectDirection but uses a lower threshold (20px) for live preview feedback.
 */
export function previewDirection(dx: number, dy: number): SwipeDirection | null {
  return detectDirection(dx, dy, 20)
}

/** How many discrete levels a preview strength is reported to the deck in. */
export const PREVIEW_STEPS = 10

/**
 * Round a 0..1 preview strength to PREVIEW_STEPS levels before it crosses out
 * of the card.
 *
 * The card tracks its own lean at full per-frame resolution — the badge reads
 * the motion value directly and renders nothing. But the deck needs the same
 * number for its edge wash, and the only way into a React tree is React state,
 * so the exact float re-rendered SwipeDeck (four EdgeRails, the wash, the
 * progress bar and the card, none of them memoized) once per pointer frame:
 * ~60 renders a second for the length of every drag.
 *
 * Ten steps is the resolution the wash can actually express — it is a
 * translucent gradient nobody reads to better than a tenth — so this costs
 * nothing visible and turns those ~60 renders/s into at most eleven over the
 * whole drag, because SwipeDeck's handlePreview already bails when the value
 * it is handed has not changed.
 */
export function quantizePreview(p: number): number {
  return Math.round(p * PREVIEW_STEPS) / PREVIEW_STEPS
}

/**
 * Which bucket, if any, a released card swipe commits to.
 *
 * The dominant axis wins — a diagonal drag that clears both thresholds goes
 * wherever the hand travelled further, which is what the eye expects. Was
 * previously spread across useSwipeGesture's pointer handlers with a
 * time-based speed estimate; Framer reports real px/s.
 *
 * The velocity clause's guards — direction agreement and the FLICK_MIN_DISTANCE
 * floor — now live in `lib/gesture.ts`'s `flicked`, which is where the full
 * rationale is written down. This deck is where the missing floor was first
 * found (a twitch sorted a card the user never meant to touch, on the
 * highest-frequency surface in the app, costing an undo each time); the other
 * four drag surfaces were carrying the same hole and now share the fix.
 *
 * The floor is measured per axis rather than on the overall travel, so 30px of
 * downward drag cannot license a sideways velocity commit.
 */
export function commitDirection(
  offsetX: number,
  offsetY: number,
  velocityX: number,
  velocityY: number,
): SwipeDirection | null {
  const flick = (offset: number, velocity: number) =>
    flicked(offset, velocity, FLICK_MIN_DISTANCE, COMMIT_VELOCITY)
  const horizontal = Math.abs(offsetX) >= COMMIT_PX || flick(offsetX, velocityX)
  const vertical = Math.abs(offsetY) >= COMMIT_PX || flick(offsetY, velocityY)
  if (!horizontal && !vertical) return null
  const preferHorizontal = horizontal && (!vertical || Math.abs(offsetX) >= Math.abs(offsetY))
  if (preferHorizontal) return offsetX > 0 ? 'right' : 'left'
  return offsetY > 0 ? 'down' : 'up'
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
