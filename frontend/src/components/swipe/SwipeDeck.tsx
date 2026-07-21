import { useState, useCallback, useRef, type CSSProperties } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle, Heart, type LucideIcon } from 'lucide-react'
import { postJSON, del, getProjects, assignTxnProject } from '../../api/client'
import { fire } from '../../lib/feedback'
import { useToast } from '../Toast'
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
import { LinkRefundSheet } from '../transactions/LinkRefundSheet'

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
        className={`flex items-center justify-center gap-1.5 rounded-lg font-semibold transition-[transform,background-color,color,box-shadow] duration-200 ${vertical ? 'flex-col px-2 py-3 w-12' : 'px-4 py-2'}`}
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

/** The last committed sort, kept for one-shot undo. `seq` guards against a
 *  stale toast undoing after a newer commit already moved the deck on. */
interface Commit {
  seq: number
  index: number
  txn: Txn
  kind: 'categorize' | 'transfer'
  categoryName?: string
  ruleID?: number
  projectID?: number | null
}

export function SwipeDeck({ transactions, categories, config = DEFAULT_SWIPE_CONFIG }: SwipeDeckProps) {
  const qc = useQueryClient()
  const toast = useToast()
  const commitRef = useRef<Commit | null>(null)
  const seqRef = useRef(0)

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingDirection: null,
    flyDirection: null,
    makeRule: true,
    previewDir: null,
    previewProgress: 0,
  })
  const [linkOpen, setLinkOpen] = useState(false)

  // Active projects for the panel's assign-on-sort chips (same cache key as
  // the list view's CategorizeSheet).
  const projects = useQuery({ queryKey: ['projects', 'active'], queryFn: () => getProjects(false) })

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

  // Bring a committed card back to the front of the deck (undo / failed save).
  const restoreCard = useCallback((commit: Commit) => {
    setState(s => ({ ...s, flyDirection: null, pendingDirection: null, index: commit.index }))
  }, [])

  const failCommit = useCallback((commit: Commit) => {
    // Only roll the deck back if this is still the latest commit; a stale
    // failure must not yank the user away from the card they're sorting now.
    if (commitRef.current?.seq === commit.seq) {
      commitRef.current = null
      restoreCard(commit)
    }
    toast.show({ message: "Couldn't save — the card is back in the deck", tone: 'error' })
  }, [restoreCard, toast])

  const undoCommit = useCallback((seq: number) => {
    const commit = commitRef.current
    if (!commit || commit.seq !== seq) {
      toast.show({ message: 'Too late to undo — fix it from Transactions' })
      return
    }
    fire('selection')
    commitRef.current = null
    const reverse = commit.kind === 'transfer'
      ? postJSON(`/api/transactions/${commit.txn.ID}/status`, { status: 'needs_review' })
      : Promise.all([
          postJSON(`/api/transactions/${commit.txn.ID}/categorize`, { category_id: null }),
          commit.ruleID != null ? del(`/api/rules/${commit.ruleID}`) : Promise.resolve(),
          commit.projectID != null ? assignTxnProject(commit.txn.ID, null) : Promise.resolve(),
        ])
    reverse
      .then(() => {
        invalidate()
        restoreCard(commit)
      })
      .catch(() => toast.show({ message: "Couldn't undo — fix it from Transactions", tone: 'error' }))
  }, [invalidate, restoreCard, toast])

  const handleDirectionCommit = useCallback((dir: SwipeDirection) => {
    const action = config[dir]
    if (!action) return
    fire('success') // fire synchronously in the gesture, before any await
    if (action.statusOverride === 'transfer') {
      if (current) {
        const commit: Commit = { seq: ++seqRef.current, index: state.index, txn: current, kind: 'transfer' }
        commitRef.current = commit
        postJSON(`/api/transactions/${current.ID}/status`, { status: 'transfer' })
          .then(() => {
            invalidate()
            toast.show({
              message: 'Marked as transfer',
              action: { label: 'Undo', onAction: () => undoCommit(commit.seq) },
            })
          })
          .catch(() => failCommit(commit))
      }
      setState(s => ({ ...s, flyDirection: dir }))
    } else {
      setState(s => ({ ...s, pendingDirection: dir }))
    }
  }, [config, current, state.index, invalidate, toast, undoCommit, failCommit])

  const handleCategorySelect = useCallback(async (categoryId: number, projectId: number | null) => {
    if (!current) return
    fire('selection') // synchronous, before the network await
    const dir = state.pendingDirection
    const categoryName = categories.find(c => c.ID === categoryId)?.Name ?? 'category'
    const commit: Commit = {
      seq: ++seqRef.current, index: state.index, txn: current, kind: 'categorize', categoryName,
    }
    commitRef.current = commit
    // Close panel and start card exit animation
    setState(s => ({ ...s, pendingDirection: null, flyDirection: dir }))
    try {
      const resp = await postJSON<{ ok: boolean; rule_id?: number }>(
        `/api/transactions/${current.ID}/categorize`,
        {
          category_id: categoryId,
          merchant_raw: current.MerchantRaw,
          make_rule: state.makeRule,
        },
      )
      commit.ruleID = resp?.rule_id
      if (projectId != null) {
        await assignTxnProject(current.ID, projectId)
        commit.projectID = projectId
      }
      invalidate()
      const projectName = projectId != null
        ? projects.data?.find(p => p.id === projectId)?.name
        : undefined
      toast.show({
        message: projectName
          ? `Sorted into ${categoryName} · ${projectName}`
          : `Sorted into ${categoryName}`,
        action: { label: 'Undo', onAction: () => undoCommit(commit.seq) },
      })
    } catch {
      failCommit(commit)
    }
  }, [current, categories, projects.data, state.pendingDirection, state.makeRule, state.index, invalidate, toast, undoCommit, failCommit])

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

  // Bumped on panel cancel so the card springs back from its commit offset.
  const [resetToken, setResetToken] = useState(0)
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingDirection: null, previewDir: null, previewProgress: 0 }))
    setResetToken(t => t + 1)
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
              className="absolute inset-0 bg-surface rounded-[12px] shadow-lg"
              style={{ transform: 'scale(0.94) translateY(14px)', zIndex: 0 }}
            />
          )}
          {current && (
            <div key={current.ID} className="relative swipe-card-in" style={{ zIndex: 1 }}>
              <SwipeCard
                txn={current}
                config={config}
                flying={state.flyDirection}
                resetToken={resetToken}
                onDirectionCommit={handleDirectionCommit}
                onTripleTap={handleTripleTap}
                onExitComplete={handleExitComplete}
                onPreview={handlePreview}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-center gap-1 mt-3">
        <p className="text-xs text-muted">Swipe a card to sort ·</p>
        <button
          className="text-xs font-medium text-muted underline underline-offset-2 press min-h-11 px-2"
          onClick={handleTripleTap}
        >
          Skip for now
        </button>
      </div>

      {current && current.Direction === 'credit' && (
        <button
          className="mx-auto mt-2 text-sm font-medium text-accent"
          onClick={() => setLinkOpen(true)}
        >
          This is a refund — link the purchase
        </button>
      )}

      {/* SubcategoryPanel rendered outside card stack to avoid clipping */}
      {pendingAction && pendingAction.bucket && current && (
        <SubcategoryPanel
          action={pendingAction}
          txn={current}
          categories={categories}
          projects={projects.data ?? []}
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
