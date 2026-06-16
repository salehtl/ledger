import { useState, useCallback, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle, Heart, type LucideIcon } from 'lucide-react'
import { postJSON } from '../../api/client'
import type { Txn, Category } from '../../api/types'
import {
  type SwipeConfig,
  type SwipeDirection,
  type SwipeAction,
  DEFAULT_SWIPE_CONFIG,
  actionColor,
} from '../../lib/swipe'
import { SwipeCard, SWIPE_ICONS } from './SwipeCard'
import { SubcategoryPanel } from './SubcategoryPanel'

interface SwipeDeckProps {
  transactions: Txn[]
  categories: Category[]
  config?: SwipeConfig
}

interface DeckState {
  index: number
  skippedIds: Set<number>
  pendingDirection: SwipeDirection | null
  flyDirection: SwipeDirection | null
  makeRule: boolean
  previewDir: SwipeDirection | null
  previewProgress: number
}

// Edge placement for each direction's rail (position + centering transform).
const RAIL_POS: Record<SwipeDirection, { style: CSSProperties; vertical: boolean }> = {
  up:    { style: { top: 0, left: '50%', transform: 'translateX(-50%)' }, vertical: false },
  down:  { style: { bottom: 0, left: '50%', transform: 'translateX(-50%)' }, vertical: false },
  left:  { style: { left: 0, top: '50%', transform: 'translateY(-50%)' }, vertical: true },
  right: { style: { right: 0, top: '50%', transform: 'translateY(-50%)' }, vertical: true },
}

// Color wash bleeding inward from the active edge.
const WASH: Record<SwipeDirection, (c: string) => string> = {
  left:  c => `linear-gradient(90deg, ${c}59 0%, ${c}00 55%)`,
  right: c => `linear-gradient(270deg, ${c}59 0%, ${c}00 55%)`,
  up:    c => `linear-gradient(180deg, ${c}59 0%, ${c}00 55%)`,
  down:  c => `linear-gradient(0deg, ${c}59 0%, ${c}00 55%)`,
}

function EdgeRail({ dir, action, active }: { dir: SwipeDirection; action: SwipeAction; active: boolean }) {
  const color = actionColor(action)
  const Icon: LucideIcon = SWIPE_ICONS[action.icon] ?? Heart
  const { style, vertical } = RAIL_POS[dir]
  return (
    <div className="absolute z-10 pointer-events-none" style={style}>
      <div
        className={`flex items-center justify-center gap-1.5 rounded-full font-semibold transition-all duration-200 ${vertical ? 'flex-col px-2 py-3 w-12' : 'px-4 py-2'}`}
        style={{
          backgroundColor: active ? color : `${color}1f`,
          color: active ? '#ffffff' : color,
          transform: `scale(${active ? 1.08 : 1})`,
          boxShadow: active ? `0 10px 24px -8px ${color}` : 'none',
        }}
      >
        <Icon size={16} className="shrink-0" />
        <span className="text-[11px] tracking-wide leading-none">{action.label}</span>
      </div>
    </div>
  )
}

export function SwipeDeck({ transactions, categories, config = DEFAULT_SWIPE_CONFIG }: SwipeDeckProps) {
  const qc = useQueryClient()

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingDirection: null,
    flyDirection: null,
    makeRule: true,
    previewDir: null,
    previewProgress: 0,
  })

  // Freeze the transaction list at mount time. Live refetches update the
  // query cache but shouldn't shift the index mid-session.
  const [frozenTxns] = useState(() => transactions)

  // Active queue: frozen list minus IDs skipped this session
  const queue = frozenTxns.filter(t => !state.skippedIds.has(t.ID))
  const current = queue[state.index] ?? null
  const next = queue[state.index + 1] ?? null

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['review'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['summary'] })
  }, [qc])

  const handleDirectionCommit = useCallback((dir: SwipeDirection) => {
    const action = config[dir]
    if (!action) return
    if (action.statusOverride === 'transfer') {
      if (current) {
        postJSON(`/api/transactions/${current.ID}/status`, { status: 'transfer' })
          .then(invalidate)
          .catch(() => { /* user can fix from list */ })
      }
      setState(s => ({ ...s, flyDirection: dir }))
    } else {
      setState(s => ({ ...s, pendingDirection: dir }))
    }
  }, [config, current, invalidate])

  const handleCategorySelect = useCallback(async (categoryId: number) => {
    if (!current) return
    const dir = state.pendingDirection
    // Close panel and start card exit animation
    setState(s => ({ ...s, pendingDirection: null, flyDirection: dir }))
    try {
      await postJSON(`/api/transactions/${current.ID}/categorize`, {
        category_id: categoryId,
        merchant_raw: current.MerchantRaw,
        make_rule: state.makeRule,
      })
      invalidate()
    } catch {
      // Card already animated out — user can recategorize from list view
    }
  }, [current, state.pendingDirection, state.makeRule, invalidate])

  const handleExitComplete = useCallback(() => {
    setState(s => ({ ...s, flyDirection: null, index: s.index + 1, previewDir: null, previewProgress: 0 }))
  }, [])

  const handleTripleTap = useCallback(() => {
    if (!current) return
    setState(s => ({
      ...s,
      skippedIds: new Set([...s.skippedIds, current.ID]),
    }))
  }, [current])

  const handlePreview = useCallback((dir: SwipeDirection | null, progress: number) => {
    setState(s => (s.previewDir === dir && s.previewProgress === progress
      ? s
      : { ...s, previewDir: dir, previewProgress: progress }))
  }, [])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingDirection: null }))
  }, [])

  const pendingAction = state.pendingDirection ? config[state.pendingDirection] : null
  const done = state.index >= queue.length

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-5 text-center px-8">
        <CheckCircle size={72} className="text-good" />
        <h2 className="text-2xl font-bold text-fg">All caught up!</h2>
        <p className="text-muted">
          {state.index} transaction{state.index !== 1 ? 's' : ''} categorized this session
        </p>
      </div>
    )
  }

  const total = queue.length
  const progress = state.index / total
  const remaining = total - state.index

  // Which edge is lit right now: a committing fly wins over a live drag.
  const activeDir = state.flyDirection ?? state.previewDir
  const activeColor = activeDir ? actionColor(config[activeDir]) : null
  const washOpacity = activeDir ? (state.flyDirection ? 1 : Math.min(state.previewProgress, 1)) : 0

  return (
    <div className="flex-1 flex flex-col w-full max-w-sm mx-auto px-4">
      {/* Header — remaining count is the motivating number */}
      <div className="flex items-end justify-between mb-3 px-1">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted mb-0.5">Remaining</p>
          <p className="font-rounded font-bold text-fg leading-none" style={{ fontSize: '2rem' }}>{remaining}</p>
        </div>
        <p className="text-sm text-muted mb-1 tabular-nums">{state.index} of {total} sorted</p>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden mb-4">
        <div
          className="h-full bg-accent rounded-full transition-all duration-300"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Card arena — rails hug the edges, card sits in the middle */}
      <div className="relative flex-1 flex items-center justify-center">
        {/* Edge color wash from the active direction */}
        {activeDir && activeColor && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none rounded-[28px] transition-opacity duration-150"
            style={{ opacity: washOpacity, background: WASH[activeDir](activeColor) }}
          />
        )}

        {/* Four bucket rails */}
        {(['up', 'down', 'left', 'right'] as const).map(dir => (
          <EdgeRail key={dir} dir={dir} action={config[dir]} active={activeDir === dir} />
        ))}

        {/* Sizing box keeps the ghost the same size as the front card */}
        <div className="relative w-[80%] max-w-[320px]">
          {/* Ghost card behind gives depth */}
          {next && (
            <div
              aria-hidden
              className="absolute inset-0 bg-surface rounded-[28px] shadow-lg"
              style={{ transform: 'scale(0.94) translateY(14px)', zIndex: 0 }}
            />
          )}
          {current && (
            <div key={current.ID} className="relative swipe-card-in" style={{ zIndex: 1 }}>
              <SwipeCard
                txn={current}
                config={config}
                flying={state.flyDirection}
                onDirectionCommit={handleDirectionCommit}
                onTripleTap={handleTripleTap}
                onExitComplete={handleExitComplete}
                onPreview={handlePreview}
              />
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted mt-4">Swipe a card to sort · triple-tap to skip</p>

      {/* SubcategoryPanel rendered outside card stack to avoid clipping */}
      {pendingAction && pendingAction.bucket && (
        <SubcategoryPanel
          action={pendingAction}
          categories={categories}
          makeRule={state.makeRule}
          onMakeRuleChange={v => setState(s => ({ ...s, makeRule: v }))}
          onSelect={handleCategorySelect}
          onCancel={handleCancel}
        />
      )}
    </div>
  )
}
