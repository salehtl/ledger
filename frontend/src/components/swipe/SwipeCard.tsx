// frontend/src/components/swipe/SwipeCard.tsx
import { useEffect, useRef, type CSSProperties } from 'react'
import { Heart, Home, PiggyBank, ArrowLeftRight, type PixelIconType } from '../ui/PixelIcon'
import { formatFils, aedFils, nativeAmountTag } from '../../lib/money'
import { accountLabel, reviewReason } from '../../lib/reviewMeta'
import type { Txn } from '../../api/types'
import {
  onActionColor,
  type SwipeConfig,
  type SwipeDirection,
  DEFAULT_SWIPE_CONFIG,
  overlayProgress,
  previewDirection,
  actionColor,
} from '../../lib/swipe'
import { useSwipeGesture } from '../../hooks/useSwipeGesture'
import { Pressable } from '../ui/Pressable'
import { useReducedMotion } from "motion/react";
const usePrefersReducedMotion = () => useReducedMotion() ?? false;

export const SWIPE_ICONS: Record<string, PixelIconType> = { Heart, Home, PiggyBank, ArrowLeftRight }

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

interface SwipeCardProps {
  txn: Txn
  config?: SwipeConfig
  /**
   * When set, card plays fly-out animation toward this direction.
   * Call onExitComplete after animating.
   */
  flying?: SwipeDirection | null
  /** Bump to snap the card back to center (e.g. the category panel was
   *  cancelled after a commit left the card at its dragged offset). */
  resetToken?: number
  onDirectionCommit: (dir: SwipeDirection) => void
  onTripleTap: () => void
  onExitComplete: () => void
  /** Live drag feedback so the deck can light the matching edge. */
  onPreview?: (dir: SwipeDirection | null, progress: number) => void
  onOpenEmail?: () => void
}

export function SwipeCard({
  txn,
  config = DEFAULT_SWIPE_CONFIG,
  flying = null,
  resetToken = 0,
  onDirectionCommit,
  onTripleTap,
  onExitComplete,
  onPreview,
  onOpenEmail,
}: SwipeCardProps) {
  const { state, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, reset } =
    useSwipeGesture(onDirectionCommit, onTripleTap)
  const reduceMotion = usePrefersReducedMotion()

  const exitedRef = useRef(false)

  // Reset gesture state when the card's transaction changes or the deck asks
  // for a snap-back (panel cancelled with the card still at its drag offset).
  useEffect(() => {
    reset()
    exitedRef.current = false
  }, [txn.ID, resetToken, reset])

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
  const Icon: PixelIconType | null = action ? (SWIPE_ICONS[action.icon] ?? Heart) : null

  const date = new Date(txn.PostedAt).toLocaleDateString('en-AE', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const credit = txn.Direction === 'credit'

  // Ring strength tracks the drag; capped so it stays tasteful.
  const ring = color ? Math.min(progress, 1) : 0

  return (
    <div
      style={{
        transform: `translateX(${tx}px) translateY(${ty}px) rotate(${rot}deg)`,
        // Fly-out keeps moving from the release velocity — ease-out, not
        // ease-in, so the card never hesitates at the moment of commitment.
        transition: flying
          ? 'transform 0.3s cubic-bezier(0.23, 1, 0.32, 1), opacity 0.3s cubic-bezier(0.23, 1, 0.32, 1)'
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
      data-testid="swipe-card"
      // Downward card drags are a commit gesture — PTR must never claim them.
      data-ptr-exempt=""
      className="relative w-full bg-surface border border-border rounded-[var(--radius)] cursor-grab active:cursor-grabbing overflow-hidden"
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

      {/* Confirming badge — appears at the committed/leaning edge */}
      {action && color && dir && (dragging || flying) && (
        <div
          className="absolute flex items-center gap-2 px-4 py-2 rounded-[var(--radius)] font-semibold shadow-lg pointer-events-none"
          style={{
            ...BADGE_POS[dir].style,
            backgroundColor: color,
            // text-bg was paper-on-near-black in dark: ~1:1. Pick per fill.
            color: onActionColor(color),
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
