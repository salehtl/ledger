import { useState, useCallback, useMemo, type CSSProperties } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle, Heart, type LucideIcon } from 'lucide-react'
import { postJSON } from '../../api/client'
import { fire } from '../../lib/feedback'
import type { Txn, Category } from '../../api/types'
import {
  type SwipeConfig,
  type EdgeKey,
  type EdgeGroup,
  type Zone,
  DEFAULT_SWIPE_CONFIG,
  GROUP_COLOR,
  GROUP_ICON,
} from '../../lib/swipe'
import { SwipeCard, SWIPE_ICONS } from './SwipeCard'
import { SubcategoryPanel } from './SubcategoryPanel'
import { LinkRefundSheet } from '../transactions/LinkRefundSheet'

interface SwipeDeckProps {
  transactions: Txn[]
  categories: Category[]
  config?: SwipeConfig
}

interface DeckState {
  index: number
  skippedIds: Set<number>
  pendingGroup: EdgeGroup | null
  flyEdge: EdgeKey | null
  makeRule: boolean
  previewEdge: EdgeKey | null
  previewProgress: number
}

// Edge placement for each rail (position + orientation).
const RAIL_POS: Record<EdgeKey, { style: CSSProperties; vertical: boolean }> = {
  up:    { style: { top: 0, left: '50%', transform: 'translateX(-50%)' }, vertical: false },
  down:  { style: { bottom: 0, left: '50%', transform: 'translateX(-50%)' }, vertical: false },
  left:  { style: { left: 0, top: '50%', transform: 'translateY(-50%)' }, vertical: true },
  right: { style: { right: 0, top: '50%', transform: 'translateY(-50%)' }, vertical: true },
}

// Color wash bleeding inward from the active edge.
const WASH: Record<EdgeKey, (c: string) => string> = {
  left:  c => `linear-gradient(90deg, ${c}59 0%, ${c}00 55%)`,
  right: c => `linear-gradient(270deg, ${c}59 0%, ${c}00 55%)`,
  up:    c => `linear-gradient(180deg, ${c}59 0%, ${c}00 55%)`,
  down:  c => `linear-gradient(0deg, ${c}59 0%, ${c}00 55%)`,
}

/** One rail per edge: slot A, slot B, and a slim "Other" segment. */
function EdgeRail({
  edge,
  config,
  catName,
  active,
}: {
  edge: EdgeKey
  config: SwipeConfig
  catName: (id: number) => string
  active: boolean
}) {
  const ec = config.edges[edge]
  const color = GROUP_COLOR[ec.group]
  const Icon: LucideIcon = SWIPE_ICONS[GROUP_ICON[ec.group]] ?? Heart
  const { style, vertical } = RAIL_POS[edge]

  const segStyle = (on: boolean, slim: boolean): CSSProperties => ({
    backgroundColor: on ? color : `${color}1f`,
    color: on ? '#ffffff' : color,
    padding: slim ? '2px 6px' : vertical ? '6px 8px' : '6px 10px',
    fontSize: slim ? '9px' : '11px',
  })

  const slotA = ec.slotA ? catName(ec.slotA) : ''
  const slotB = ec.slotB ? catName(ec.slotB) : ''

  return (
    <div className="absolute z-10 pointer-events-none" style={style}>
      <div
        className={`flex items-stretch rounded-lg overflow-hidden font-semibold transition-all duration-200 ${vertical ? 'flex-col w-14' : 'flex-row'}`}
        style={{ transform: `scale(${active ? 1.06 : 1})`, boxShadow: active ? `0 10px 24px -8px ${color}` : 'none' }}
      >
        <div className="flex items-center justify-center gap-1 leading-none" style={segStyle(false, false)}>
          <Icon size={13} className="shrink-0" />
          <span className="tracking-wide truncate max-w-[72px]">{slotA || '—'}</span>
        </div>
        <div className="flex items-center justify-center leading-none" style={segStyle(false, false)}>
          <span className="tracking-wide truncate max-w-[72px]">{slotB || '—'}</span>
        </div>
        <div className="flex items-center justify-center leading-none opacity-80" style={segStyle(false, true)}>
          <span className="tracking-wide">Other</span>
        </div>
      </div>
    </div>
  )
}

export function SwipeDeck({ transactions, categories, config = DEFAULT_SWIPE_CONFIG }: SwipeDeckProps) {
  const qc = useQueryClient()

  const catName = useMemo(() => {
    const m = new Map(categories.map(c => [c.ID, c.Name]))
    return (id: number) => m.get(id) ?? ''
  }, [categories])

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingGroup: null,
    flyEdge: null,
    makeRule: true,
    previewEdge: null,
    previewProgress: 0,
  })
  const [linkOpen, setLinkOpen] = useState(false)

  const [frozenTxns] = useState(() => transactions)
  const queue = frozenTxns.filter(t => !state.skippedIds.has(t.ID))
  const current = queue[state.index] ?? null
  const next = queue[state.index + 1] ?? null

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['review'] })
    qc.invalidateQueries({ queryKey: ['transactions'] })
    qc.invalidateQueries({ queryKey: ['summary'] })
  }, [qc])

  const categorize = useCallback((categoryId: number, edge: EdgeKey) => {
    if (!current) return
    // Caller fires the feedback cue (success for a direct swipe, selection for
    // a panel pick) so a single action never double-fires.
    setState(s => ({ ...s, pendingGroup: null, flyEdge: edge }))
    postJSON(`/api/transactions/${current.ID}/categorize`, {
      category_id: categoryId,
      merchant_raw: current.MerchantRaw,
      make_rule: state.makeRule,
    }).then(invalidate).catch(() => { /* fixable from list view */ })
  }, [current, state.makeRule, invalidate])

  const handleZoneCommit = useCallback((zone: Zone) => {
    if (zone.kind === 'category') {
      fire('success')
      categorize(zone.categoryId, zone.edge)
    } else {
      // Slim "Other" sliver → open the sheet filtered to this edge's group.
      setState(s => ({ ...s, pendingGroup: zone.group }))
    }
  }, [categorize])

  const handleCategorySelect = useCallback((categoryId: number) => {
    // The panel that opened from an Other sliver — fly toward that edge.
    const edge = (['up', 'down', 'left', 'right'] as const).find(
      e => config.edges[e].group === state.pendingGroup,
    ) ?? 'down'
    fire('selection')
    categorize(categoryId, edge)
  }, [config, state.pendingGroup, categorize])

  const handleExitComplete = useCallback(() => {
    setState(s => ({ ...s, flyEdge: null, index: s.index + 1, previewEdge: null, previewProgress: 0 }))
  }, [])

  const handleTripleTap = useCallback(() => {
    if (!current) return
    setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }))
  }, [current])

  const handlePreview = useCallback((zone: Zone | null, progress: number) => {
    const edge = zone?.edge ?? null
    setState(s => (s.previewEdge === edge && s.previewProgress === progress
      ? s
      : { ...s, previewEdge: edge, previewProgress: progress }))
  }, [])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingGroup: null }))
  }, [])

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

  const activeEdge = state.flyEdge ?? state.previewEdge
  const activeColor = activeEdge ? GROUP_COLOR[config.edges[activeEdge].group] : null
  const washOpacity = activeEdge ? (state.flyEdge ? 1 : Math.min(state.previewProgress, 1)) : 0

  return (
    <div className="flex-1 flex flex-col w-full max-w-sm mx-auto px-4">
      <div className="flex items-end justify-between mb-3 px-1">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted mb-0.5">Remaining</p>
          <p className="font-rounded font-bold text-fg leading-none" style={{ fontSize: '2rem' }}>{remaining}</p>
        </div>
        <p className="text-sm text-muted mb-1 tabular-nums">{state.index} of {total} sorted</p>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden mb-4">
        <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="relative flex-1 flex items-center justify-center">
        {activeEdge && activeColor && (
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none rounded-[28px] transition-opacity duration-150"
            style={{ opacity: washOpacity, background: WASH[activeEdge](activeColor) }}
          />
        )}

        {(['up', 'down', 'left', 'right'] as const).map(edge => (
          <EdgeRail key={edge} edge={edge} config={config} catName={catName} active={activeEdge === edge} />
        ))}

        <div className="relative w-[80%] max-w-[320px]">
          {next && (
            <div
              aria-hidden
              className="absolute inset-0 bg-surface rounded-[12px] shadow-lg"
              style={{ transform: 'scale(0.94) translateY(14px)', zIndex: 0 }}
            />
          )}
          {current && (
            <div key={current.ID} className="relative swipe-card-in" style={{ zIndex: 1 }}>
              <SwipeCard
                txn={current}
                config={config}
                catName={catName}
                flying={state.flyEdge}
                onZoneCommit={handleZoneCommit}
                onTripleTap={handleTripleTap}
                onExitComplete={handleExitComplete}
                onPreview={handlePreview}
              />
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-muted mt-4">Swipe toward a category · triple-tap to skip</p>

      {current && current.Direction === 'credit' && (
        <button className="mx-auto mt-2 text-sm font-medium text-accent" onClick={() => setLinkOpen(true)}>
          This is a refund — link the purchase
        </button>
      )}

      {state.pendingGroup && (
        <SubcategoryPanel
          group={state.pendingGroup}
          categories={categories}
          makeRule={state.makeRule}
          onMakeRuleChange={v => setState(s => ({ ...s, makeRule: v }))}
          onSelect={handleCategorySelect}
          onCancel={handleCancel}
        />
      )}

      {linkOpen && current && (
        <LinkRefundSheet
          txn={current}
          onLinked={() => {
            setLinkOpen(false)
            invalidate()
            setState(s => ({ ...s, skippedIds: new Set([...s.skippedIds, current.ID]) }))
          }}
          onClose={() => setLinkOpen(false)}
        />
      )}
    </div>
  )
}
