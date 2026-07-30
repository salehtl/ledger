// frontend/src/components/swipe/SwipeCard.tsx
import { forwardRef, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { m, useMotionValue, useMotionValueEvent, useTransform } from 'motion/react'
import { Heart, Home, PiggyBank, ArrowLeftRight, type PixelIconType } from '../ui/PixelIcon'
import { formatFils, aedFils, nativeAmountTag } from '../../lib/money'
import { accountLabel, reviewReason } from '../../lib/reviewMeta'
import { FADE, SPRING_SNAP } from '../../lib/motion'
import type { Txn } from '../../api/types'
import {
  onActionColor,
  type SwipeConfig,
  type SwipeDirection,
  DEFAULT_SWIPE_CONFIG,
  commitDirection,
  quantizePreview,
  overlayProgress,
  previewDirection,
  actionColor,
} from '../../lib/swipe'
import { Pressable } from '../ui/Pressable'

export const SWIPE_ICONS: Record<string, PixelIconType> = { Heart, Home, PiggyBank, ArrowLeftRight }

// Where a committed card leaves toward. `rotate` only on the horizontal
// exits: an up/down card that also spun would read as a discard, and up/down
// are Save and Transfer.
const EXIT: Record<SwipeDirection, { x: number; y: number; rotate: number }> = {
  left:  { x: -600, y: 0,    rotate: -20 },
  right: { x:  600, y: 0,    rotate:  20 },
  up:    { x: 0,    y: -800, rotate:   0 },
  down:  { x: 0,    y:  800, rotate:   0 },
}

// Where the confirming badge sits, per direction. `center` is the half-size
// nudge that centres it on its edge — expressed as Framer `x`/`y` percentages,
// NOT a hand-written `transform`. Once this element became an `m.div` with an
// animated `scale`, Framer owns its transform string and rebuilds it every
// frame from its tracked values; a manual `transform` in `style` would be
// overwritten on the next frame and the badge would jump half its size off the
// edge. (Same failure mode Task 2 hit on EdgeRail's armed scale.)
const BADGE_POS: Record<SwipeDirection, { style: CSSProperties; center: { x?: string; y?: string } }> = {
  left:  { style: { left: 16, top: '50%' },    center: { y: '-50%' } },
  right: { style: { right: 16, top: '50%' },   center: { y: '-50%' } },
  up:    { style: { top: 16, left: '50%' },    center: { x: '-50%' } },
  down:  { style: { bottom: 16, left: '50%' }, center: { x: '-50%' } },
}

/** Resting elevation. Constant, so it is never recomputed mid-drag. */
const CARD_SHADOW = '0 18px 40px -16px rgba(20,23,31,0.35)'

/** Taps this close together (ms) count as part of one multi-tap. */
const TAP_WINDOW_MS = 500

interface SwipeCardProps {
  txn: Txn
  config?: SwipeConfig
  /** When set, the card exits toward this bucket. AnimatePresence plays it. */
  flying?: SwipeDirection | null
  onDirectionCommit: (dir: SwipeDirection) => void
  onTripleTap: () => void
  /** Live drag feedback so the deck can light the matching edge. */
  onPreview?: (dir: SwipeDirection | null, progress: number) => void
  onOpenEmail?: () => void
}

/**
 * The card at the front of the deck: drag it toward a bucket to sort it.
 *
 * Forwards its ref because the deck wraps it in `AnimatePresence mode="popLayout"`,
 * which takes the exiting card out of layout flow and therefore has to reach its
 * DOM node. Without the ref Framer warns and silently falls back to `sync` mode —
 * the outgoing card would keep its slot and shove the incoming one down.
 */
export const SwipeCard = forwardRef<HTMLDivElement, SwipeCardProps>(function SwipeCard({
  txn,
  config = DEFAULT_SWIPE_CONFIG,
  flying = null,
  onDirectionCommit,
  onTripleTap,
  onPreview,
  onOpenEmail,
}, ref) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)

  // The card leans into the drag. 0.04°/px, so a 100px pull is a 4° tilt —
  // enough to read as physical, not enough to look like a slot machine.
  //
  // Deliberately a plain motion value written from the drag handler below, not
  // a `useTransform(x, …)`. A transform-derived value is re-`set()` from its
  // input on every input change, so it would fight the exit animation for
  // ownership of `rotate` and EXIT's rotation would be dead code that still
  // looked plausible. One writer at a time: the drag owns it while dragging,
  // the exit owns it while flying.
  const rotate = useMotionValue(0)

  // Which edge the card is leaning toward. This IS React state, but it only
  // ever holds one of five values (four directions or null), so it re-renders
  // on a direction *change* — not on every pointer frame the way the old
  // useSwipeGesture state did.
  const [dir, setDir] = useState<SwipeDirection | null>(null)

  // Strength of the lean, 0..1, as a motion value. It changes every frame, so
  // the badge — the thing that has to track the hand exactly — reads it
  // straight off the value and re-renders nothing.
  //
  // The deck needs the same number for its edge wash, and that path does go
  // through React state (SwipeDeck's `previewProgress`). It cannot read a
  // motion value without one, so instead the number crossing that boundary is
  // quantised: see `reportPreview`.
  const progress = useMotionValue(0)

  const reportPreview = useCallback(() => {
    // While the card is flying out its x/y are being animated to the exit
    // target, and those changes are not a preview: reporting them would leave
    // the deck's edge wash lit on a card that has already left.
    if (flying) return
    const dx = x.get(), dy = y.get()
    const d = previewDirection(dx, dy)
    const p = overlayProgress(dx, dy)
    rotate.set(dx * 0.04)
    progress.set(p)                           // exact — the badge reads this
    setDir(prev => (prev === d ? prev : d))   // bail out when unchanged
    // Quantised on the way out: the deck writes this into React state, so an
    // exact float re-rendered the whole deck once per pointer frame. See
    // quantizePreview — the reasoning and the render-collapsing property both
    // live there, with the test.
    onPreview?.(d, quantizePreview(p))
  }, [x, y, rotate, progress, flying, onPreview])

  useMotionValueEvent(x, 'change', reportPreview)
  useMotionValueEvent(y, 'change', reportPreview)

  // A commit fixes the badge at the bucket it committed to, at full strength —
  // including a rail tap, where no drag ever moved the card.
  useEffect(() => {
    if (!flying) return
    setDir(flying)
    progress.set(1)
  }, [flying, progress])

  // The badge's own animation, straight off the motion value.
  const badgeOpacity = useTransform(progress, [0, 0.85], [0, 1], { clamp: true })
  const badgeScale = useTransform(progress, [0, 1], [0.85, 1], { clamp: true })

  // Triple-tap skips the card. Framer's tap gesture fires on release whether
  // or not a drag happened, so a swipe that ends over the card would otherwise
  // count as a tap; `dragged` gates that out. (onDragStart fires from
  // PanSession once movement crosses ~3px, so a genuine tap never sets it.)
  //
  // The flag is cleared at the START of the next gesture, not at the end of
  // this one. Clearing it in `onDragEnd` looks equivalent and is not: drag and
  // press each register their window `pointerup` listener from their own
  // pointerdown handler, so which one runs first is decided by Framer's
  // feature mount order, and drag mounts before press — `onDragEnd` clears the
  // flag before `onTap` ever reads it, and every drag banks a tap. Resetting
  // on pointerdown is ordering-independent and also clears the stale flag left
  // by a drag that ended in `onTapCancel` (pointercancel, or a release off the
  // element), which used to eat the next genuine tap. Capture phase, because
  // the "View source email" button inside the card stops pointerdown.
  const dragged = useRef(false)
  const taps = useRef(0)
  const tapTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(tapTimer.current), [])
  const handleTap = useCallback(() => {
    if (dragged.current) return
    clearTimeout(tapTimer.current)
    taps.current += 1
    tapTimer.current = setTimeout(() => { taps.current = 0 }, TAP_WINDOW_MS)
    if (taps.current >= 3) {
      taps.current = 0
      onTripleTap()
    }
  }, [onTripleTap])

  const action = dir ? config[dir] : null
  const color = action ? actionColor(action) : null
  const Icon: PixelIconType | null = action ? (SWIPE_ICONS[action.icon] ?? Heart) : null

  const date = new Date(txn.PostedAt).toLocaleDateString('en-AE', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const credit = txn.Direction === 'credit'

  return (
    <m.div
      ref={ref}
      // zIndex keeps the live card above the deck's ghost card, which is
      // absolutely positioned behind it at z-index 0.
      style={{ x, y, rotate, boxShadow: CARD_SHADOW, zIndex: 1 }}
      drag
      dragSnapToOrigin
      // No `dragElastic`: it only ever applies beyond a `dragConstraints`
      // boundary (resolveConstraints() leaves constraints === false when none
      // are set, and the elasticity branch never runs), and this card has no
      // boundary — all four directions are live buckets it should track 1:1
      // all the way to the commit threshold. Adding constraints purely to make
      // an elasticity claim true would add resistance the deck never wanted.
      dragMomentum={false}
      // dragSnapToOrigin routes the release through the same inertia animation
      // with `{min: 0, max: 0}` spread AFTER `...dragTransition`, so these
      // bounce values really are the snap-back spring rather than dead props.
      // (Without them the fallback is Framer's own 200/40 spring — `getProps()`
      // defaults dragElastic to 0.35, which is truthy, so the overdamped
      // 1e6-stiffness branch never applies here. These give the snap the same
      // hand as every other spring in the app.)
      dragTransition={{ bounceStiffness: SPRING_SNAP.stiffness, bounceDamping: SPRING_SNAP.damping }}
      onPointerDownCapture={() => { dragged.current = false }}
      onDragStart={() => { dragged.current = true }}
      onDragEnd={(_, info) => {
        const d = commitDirection(info.offset.x, info.offset.y, info.velocity.x, info.velocity.y)
        if (d) onDirectionCommit(d)
      }}
      onTap={handleTap}
      // `onTap` makes Framer set tabIndex=0 (use-props.mjs) when tabIndex is
      // undefined, which would turn the card into a keyboard stop with no
      // role, no accessible name and no keyboard activation — a dead stop
      // ahead of the four rails, which are the real keyboard path.
      tabIndex={-1}
      // The deck overlaps cards, so entry and exit are AnimatePresence's job.
      // Under the app's global reducedMotion policy Framer hands every
      // positional key (x, y, rotate, scale) a `{type: false}` transition —
      // set instantly, never animated — and animates only the opacity, so the
      // card is never seen travelling. That is the whole reason the old
      // hand-rolled `flying ? … : reduceMotion ? …` ternary is gone: `flying`
      // short-circuited before reduceMotion was consulted, so the biggest
      // movement in the app ignored the preference entirely. Verified in
      // harness/gestures.mjs, which samples the leaving card every frame and
      // asserts it is never caught mid-flight under the preference.
      initial={{ opacity: 0, scale: 0.92, y: 16 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={flying ? { ...EXIT[flying], opacity: 0 } : { opacity: 0 }}
      transition={FADE}
      data-testid="swipe-card"
      // Downward card drags are a commit gesture — PTR must never claim them.
      data-ptr-exempt=""
      className="relative w-full bg-surface border border-border rounded-[var(--radius)] cursor-grab active:cursor-grabbing overflow-hidden"
    >
      {/* Card body */}
      <div className="px-7 pt-9 pb-8 flex flex-col items-center gap-5">
        {/* Merchant monogram — keeps a stable color per merchant */}
        {/* Merchant initial. Deliberately not colour-coded: you only ever see
            one card, so a per-merchant hue encoded nothing you could compare
            against — it was the loudest thing on a card whose hero is the
            amount. A ruled plate with a mono initial keeps the anchor and
            gives the amount the room back. */}
        <div className="w-[72px] h-[72px] rounded-[var(--radius)] border border-border flex items-center justify-center">
          <span className="tnum text-3xl font-medium text-muted">
            {(txn.MerchantRaw || '?').charAt(0).toUpperCase()}
          </span>
        </div>

        <div className="text-center">
          <h2 className="text-xl font-semibold text-fg leading-tight px-2 line-clamp-2 break-words">
            {txn.MerchantRaw || '—'}
          </h2>
          <p className="tnum text-xs text-muted mt-1">{date}</p>
          {/* Where the money moved and why this card needs a human look */}
          <div className="flex items-center justify-center gap-1.5 flex-wrap text-xs text-muted mt-1.5 px-2">
            {accountLabel(txn) && (
              <span className="tnum px-2 py-0.5 rounded-[var(--radius)] bg-surface-2 text-[11px] text-fg/80">
                {accountLabel(txn)}
              </span>
            )}
            <span>{reviewReason(txn)}</span>
          </div>
          {txn.Source === 'email' && onOpenEmail && (
            <Pressable
              className="mt-2 min-h-11 px-3 text-xs font-medium text-fg underline underline-offset-2"
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onOpenEmail() }}
            >
              View source email
            </Pressable>
          )}
        </div>

        {/* Amount — the hero, in the rounded display face */}
        <div className="flex flex-col items-center -mt-0.5">
          {/* Name the currency the figure is actually in. With no FX rate the
              hero fell back to the native amount while the label still said
              AED, so a GBP 45.00 charge read as AED 45.00 at 48px. */}
          <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted mb-1">
            {credit ? 'Received' : 'Spent'} · {aedFils(txn) === null ? txn.Currency : 'AED'}
          </span>
          {/* clamp, not a hard 3rem: the card is ~261px wide and clips its
              overflow, so a five-figure amount lost a digit off each end. */}
          <span
            className="tnum font-bold leading-none max-w-full"
            style={{ fontSize: 'clamp(1.75rem, 9vw, 3rem)', color: credit ? 'var(--color-good)' : 'var(--color-fg)' }}
          >
            {credit ? '+' : '−'}{formatFils(aedFils(txn) ?? txn.AmountFils)}
          </span>
          {nativeAmountTag(txn) && (
            <p className="tnum text-xs text-muted">{nativeAmountTag(txn)}{aedFils(txn) === null ? " · no AED rate" : ""}</p>
          )}
        </div>
      </div>

      {/* Confirming badge — appears at the committed/leaning edge. It carries
          the action-coloured glow that used to be a ring on the card itself,
          where it was a boxShadow string rebuilt from the drag offset on every
          pointer frame — on the one element in the app being transformed at
          60fps. */}
      {action && color && dir && (
        <m.div
          className="absolute flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] font-semibold pointer-events-none"
          style={{
            ...BADGE_POS[dir].style,
            ...BADGE_POS[dir].center,
            opacity: badgeOpacity,
            scale: badgeScale,
            backgroundColor: color,
            // text-bg was paper-on-near-black in dark: ~1:1. Pick per fill.
            color: onActionColor(color),
            boxShadow: `0 10px 30px -8px ${color}`,
          }}
        >
          {Icon && <Icon size={18} className="shrink-0" />}
          <span className="text-sm tracking-wide">{action.label}</span>
        </m.div>
      )}
    </m.div>
  )
})
