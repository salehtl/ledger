import { useState, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle } from 'lucide-react'
import { postJSON } from '../../api/client'
import type { Txn, Category } from '../../api/types'
import { type SwipeConfig, type SwipeDirection, DEFAULT_SWIPE_CONFIG } from '../../lib/swipe'
import { SwipeCard } from './SwipeCard'
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
}

export function SwipeDeck({ transactions, categories, config = DEFAULT_SWIPE_CONFIG }: SwipeDeckProps) {
  const qc = useQueryClient()

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingDirection: null,
    flyDirection: null,
    makeRule: true,
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
    setState(s => ({ ...s, flyDirection: null, index: s.index + 1 }))
  }, [])

  const handleTripleTap = useCallback(() => {
    if (!current) return
    setState(s => ({
      ...s,
      skippedIds: new Set([...s.skippedIds, current.ID]),
    }))
  }, [current])

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

  return (
    <div className="flex-1 flex flex-col w-full max-w-sm mx-auto px-4">
      {/* Progress bar */}
      <div className="mb-6">
        <p className="text-sm text-center text-muted mb-2">
          {state.index + 1} of {total}
        </p>
        <div className="h-1.5 bg-border rounded-full overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-300"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* Card stack — ghost card behind gives depth */}
      <div className="relative flex-1 flex items-center justify-center">
        {next && (
          <div
            aria-hidden
            className="absolute inset-0 bg-surface rounded-3xl shadow-lg"
            style={{ transform: 'scale(0.94) translateY(14px)', zIndex: 0 }}
          />
        )}
        {current && (
          <div className="relative w-full" style={{ zIndex: 1 }}>
            <SwipeCard
              txn={current}
              config={config}
              flying={state.flyDirection}
              onDirectionCommit={handleDirectionCommit}
              onTripleTap={handleTripleTap}
              onExitComplete={handleExitComplete}
            />
          </div>
        )}
      </div>

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
