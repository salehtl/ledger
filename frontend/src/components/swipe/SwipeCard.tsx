// frontend/src/components/swipe/SwipeCard.tsx
import { useEffect } from 'react'
import { Heart, Home, PiggyBank, ArrowLeftRight, type LucideIcon } from 'lucide-react'
import { Money } from '../Money'
import type { Txn } from '../../api/types'
import {
  type SwipeConfig,
  type SwipeDirection,
  DEFAULT_SWIPE_CONFIG,
  overlayProgress,
  previewDirection,
} from '../../lib/swipe'
import { useSwipeGesture } from '../../hooks/useSwipeGesture'

const ICONS: Record<string, LucideIcon> = { Heart, Home, PiggyBank, ArrowLeftRight }

// Pixel values the card animates to on exit
const EXIT: Record<SwipeDirection, { x: number; y: number; rot: number }> = {
  left:  { x: -600, y: 0,    rot: -20 },
  right: { x:  600, y: 0,    rot:  20 },
  up:    { x: 0,    y: -800, rot:   0 },
  down:  { x: 0,    y:  800, rot:   0 },
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
}

export function SwipeCard({
  txn,
  config = DEFAULT_SWIPE_CONFIG,
  flying = null,
  onDirectionCommit,
  onTripleTap,
  onExitComplete,
}: SwipeCardProps) {
  const { state, onPointerDown, onPointerMove, onPointerUp, reset } =
    useSwipeGesture(onDirectionCommit, onTripleTap)

  // Reset gesture state when the card's transaction changes
  useEffect(() => { reset() }, [txn.ID, reset])

  const { dx, dy, dragging } = state

  // Which direction hint to show: flying direction first, then live preview
  const dir = flying ?? previewDirection(dx, dy)
  const action = dir ? config[dir] : null
  const progress = action ? overlayProgress(dx, dy) : 0

  // Position during drag or fly-out
  const exit = flying ? EXIT[flying] : null
  const tx = exit ? exit.x : dx
  const ty = exit ? exit.y : dy
  const rot = exit ? exit.rot : dx * 0.04

  const Icon: LucideIcon | null = action ? (ICONS[action.icon] ?? Heart) : null

  const date = new Date(txn.PostedAt).toLocaleDateString('en-AE', {
    month: 'short',
    day: 'numeric',
  })

  return (
    <div
      style={{
        transform: `translateX(${tx}px) translateY(${ty}px) rotate(${rot}deg)`,
        transition: flying
          ? 'transform 0.35s ease-in, opacity 0.35s ease-in'
          : dragging
          ? 'none'
          : 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        opacity: flying ? 0 : 1,
        touchAction: 'none',
        userSelect: 'none',
        willChange: 'transform',
      }}
      className="relative w-full bg-white rounded-3xl shadow-2xl cursor-grab active:cursor-grabbing overflow-hidden"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onTransitionEnd={flying ? onExitComplete : undefined}
    >
      {/* Directional color overlay */}
      {action && (
        <div
          className={`absolute inset-0 ${action.colorClass} flex flex-col items-center justify-center gap-3 pointer-events-none`}
          style={{ opacity: flying ? progress * 0.9 : progress * 0.9 }}
        >
          {Icon && <Icon size={52} className="text-white drop-shadow" />}
          <span className="text-white text-3xl font-bold tracking-wide drop-shadow">
            {action.label}
          </span>
        </div>
      )}

      {/* Card body */}
      <div className="p-6 flex flex-col items-center gap-5">
        {/* Merchant avatar */}
        <div className="w-20 h-20 rounded-2xl bg-slate-100 flex items-center justify-center">
          <span className="text-3xl font-bold text-slate-400">
            {(txn.MerchantRaw || '?').charAt(0).toUpperCase()}
          </span>
        </div>

        <div className="text-center">
          <h2 className="text-xl font-semibold text-[--fg] truncate max-w-64">{txn.MerchantRaw || '—'}</h2>
          <p className="text-sm text-[--muted] mt-0.5">{date}</p>
        </div>

        {/* Money doesn't accept className; wrap in a styled span */}
        <span className="text-4xl font-bold tabular-nums">
          <Money fils={txn.AmountFils} />
        </span>

        {/* Direction hint strip */}
        <div className="w-full grid grid-cols-3 gap-2 text-center text-xs text-[--muted] mt-1">
          <div className="flex flex-col items-center gap-1">
            <span className="text-lg">←</span>
            <span>{config.left.label}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-lg">↓</span>
            <span>{config.down.label}</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-lg">→</span>
            <span>{config.right.label}</span>
          </div>
        </div>
        <p className="text-xs text-[--muted]">↑ {config.up.label} · tap ×3 to skip</p>
      </div>
    </div>
  )
}
