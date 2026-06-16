// frontend/src/components/swipe/SwipeCard.tsx
import { useEffect, useRef, type CSSProperties } from 'react'
import { Heart, Home, PiggyBank, ArrowLeftRight, type LucideIcon } from 'lucide-react'
import { formatFils } from '../../lib/money'
import type { Txn } from '../../api/types'
import {
  type SwipeConfig,
  type SwipeDirection,
  DEFAULT_SWIPE_CONFIG,
  overlayProgress,
  previewDirection,
  actionColor,
} from '../../lib/swipe'
import { useSwipeGesture } from '../../hooks/useSwipeGesture'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'

export const SWIPE_ICONS: Record<string, LucideIcon> = { Heart, Home, PiggyBank, ArrowLeftRight }

// Pixel values the card animates to on exit
const EXIT: Record<SwipeDirection, { x: number; y: number; rot: number }> = {
  left:  { x: -600, y: 0,    rot: -20 },
  right: { x:  600, y: 0,    rot:  20 },
  up:    { x: 0,    y: -800, rot:   0 },
  down:  { x: 0,    y:  800, rot:   0 },
}

// Where the confirming badge sits, per direction (position + centering base).
const BADGE_POS: Record<SwipeDirection, { style: CSSProperties; center: string }> = {
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

interface SwipeCardProps {
  txn: Txn
  config?: SwipeConfig
  /**
   * When set, card plays fly-out animation toward this direction.
   * Call onExitComplete after animating.
   */
  flying?: SwipeDirection | null
  onDirectionCommit: (dir: SwipeDirection) => void
  onTripleTap: () => void
  onExitComplete: () => void
  /** Live drag feedback so the deck can light the matching edge. */
  onPreview?: (dir: SwipeDirection | null, progress: number) => void
}

export function SwipeCard({
  txn,
  config = DEFAULT_SWIPE_CONFIG,
  flying = null,
  onDirectionCommit,
  onTripleTap,
  onExitComplete,
  onPreview,
}: SwipeCardProps) {
  const { state, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, reset } =
    useSwipeGesture(onDirectionCommit, onTripleTap)
  const reduceMotion = usePrefersReducedMotion()

  const exitedRef = useRef(false)

  // Reset gesture state when the card's transaction changes
  useEffect(() => {
    reset()
    exitedRef.current = false
  }, [txn.ID, reset])

  const { dx, dy, dragging } = state

  // Which direction hint to show: flying direction first, then live preview
  const dir = flying ?? previewDirection(dx, dy)
  const action = dir ? config[dir] : null
  const progress = action ? overlayProgress(dx, dy) : 0

  // Report live drag direction/strength up to the deck (skip while flying out).
  useEffect(() => {
    if (!flying) onPreview?.(dir, progress)
  }, [dir, progress, flying, onPreview])

  // Position during drag or fly-out
  const exit = flying ? EXIT[flying] : null
  const tx = exit ? exit.x : dx
  const ty = exit ? exit.y : dy
  const rot = exit ? exit.rot : dx * 0.04

  const color = action ? actionColor(action) : null
  const Icon: LucideIcon | null = action ? (SWIPE_ICONS[action.icon] ?? Heart) : null

  const date = new Date(txn.PostedAt).toLocaleDateString('en-AE', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const credit = txn.Direction === 'credit'
  const hue = hueFor(txn.MerchantRaw || '?')

  // Ring strength tracks the drag; capped so it stays tasteful.
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
      className="relative w-full bg-surface rounded-[28px] cursor-grab active:cursor-grabbing overflow-hidden"
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
      {/* Card body */}
      <div className="px-7 pt-9 pb-8 flex flex-col items-center gap-5">
        {/* Merchant monogram — keeps a stable color per merchant */}
        <div
          className="w-[72px] h-[72px] rounded-2xl flex items-center justify-center"
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

        {/* Amount — the hero, in the rounded display face */}
        <div className="flex flex-col items-center -mt-0.5">
          <span className="text-xs font-medium uppercase tracking-[0.18em] text-muted mb-1">
            {credit ? 'Received' : 'Spent'} · AED
          </span>
          <span
            className="font-rounded font-bold tabular-nums leading-none"
            style={{ fontSize: '3rem', color: credit ? 'var(--color-good)' : 'var(--color-fg)' }}
          >
            {credit ? '+' : '−'}{formatFils(txn.AmountFils)}
          </span>
        </div>
      </div>

      {/* Confirming badge — appears at the committed/leaning edge */}
      {action && color && dir && (dragging || flying) && (
        <div
          className="absolute flex items-center gap-2 px-4 py-2 rounded-full text-white font-semibold shadow-lg pointer-events-none"
          style={{
            ...BADGE_POS[dir].style,
            backgroundColor: color,
            opacity: flying ? 1 : Math.min(progress * 1.2, 1),
            transform: `${BADGE_POS[dir].center} scale(${0.85 + ring * 0.15})`,
          }}
        >
          {Icon && <Icon size={18} className="shrink-0" />}
          <span className="text-sm tracking-wide">{action.label}</span>
        </div>
      )}
    </div>
  )
}
