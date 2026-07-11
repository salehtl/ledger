// frontend/src/components/swipe/SwipeCard.tsx
import { useEffect, useRef, type CSSProperties } from 'react'
import { Heart, Home, PiggyBank, ArrowLeftRight, type LucideIcon } from 'lucide-react'
import { formatFils, aedFils, nativeAmountTag } from '../../lib/money'
import type { Txn } from '../../api/types'
import {
  type SwipeConfig,
  type EdgeKey,
  type Zone,
  type PreviewState,
  previewState,
  resolveZone,
  CONSOLE_COLOR,
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
  /** Live drag feedback so the deck/console can light the matching facet. */
  onPreview?: (state: PreviewState | null) => void
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

  const pv = previewState(dx, dy, config)
  const edge: EdgeKey | null = flying ?? pv?.edge ?? null

  // Report live drag preview up to the deck/console (skip while flying out).
  useEffect(() => {
    if (!flying) onPreview?.(pv)
  }, [pv, flying, onPreview])

  const exit = flying ? EXIT[flying] : null
  const tx = exit ? exit.x : dx
  const ty = exit ? exit.y : dy
  const rot = reduceMotion ? 0 : exit ? exit.rot : dx * 0.04

  const color = pv ? CONSOLE_COLOR[pv.group] : null
  const ring = pv?.fill ?? 0
  const Icon: LucideIcon | null = edge
    ? SWIPE_ICONS[GROUP_ICON[config.edges[edge].group]] ?? Heart
    : null
  const badgeLabel = pv ? (pv.kind === 'category' ? catName(pv.categoryId) : 'Other…') : ''

  const date = new Date(txn.PostedAt).toLocaleDateString('en-AE', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const credit = txn.Direction === 'credit'
  const hue = hueFor(txn.MerchantRaw || '?')

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
        boxShadow: color && ring > 0
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
            opacity: flying ? 1 : Math.min(ring * 1.2, 1),
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
