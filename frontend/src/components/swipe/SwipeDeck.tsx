import { useState, useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { AnimatePresence, m } from 'motion/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle, Heart, type PixelIconType } from '../ui/PixelIcon'
import { Pressable } from '../ui/Pressable'
import { DUR, EASE_OUT } from '../../lib/motion'
import { postJSON, del, getProjects, assignTxnProject } from '../../api/client'
import { fire } from '../../lib/feedback'
import { useToast } from '../Toast'
import { useDitherTheme } from '../../hooks/useDitherTheme'
import type { Txn, Category } from '../../api/types'
import {
  type SwipeConfig,
  type SwipeDirection,
  type SwipeAction,
  DEFAULT_SWIPE_CONFIG,
  actionColor,
  onActionColor,
} from '../../lib/swipe'
import { SwipeCard, SWIPE_ICONS } from './SwipeCard'
import { SubcategoryPanel } from './SubcategoryPanel'
import { LinkRefundSheet } from '../transactions/LinkRefundSheet'
import { EmailPreviewSheet } from '../transactions/EmailPreviewSheet'

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

/** The four bucket rails around the card.
 *
 *  These are real buttons, not decoration. They render as filled, labelled
 *  pills that look exactly like controls, and while they were
 *  `pointer-events-none` tapping one did nothing — leaving swipe as the only
 *  way to categorize anything, which is unusable with a keyboard, a switch
 *  control, or a screen reader, and merely baffling with a thumb. */
function EdgeRail({
  dir, action, active, onCommit, disabled,
}: {
  dir: SwipeDirection
  action: SwipeAction
  active: boolean
  onCommit: (dir: SwipeDirection) => void
  disabled?: boolean
}) {
  const color = actionColor(action)
  const Icon: PixelIconType = SWIPE_ICONS[action.icon] ?? Heart
  const { style, vertical } = RAIL_POS[dir]
  return (
    <div className="absolute z-10" style={style}>
      <Pressable
        disabled={disabled}
        onClick={() => onCommit(dir)}
        aria-label={`${action.label} — sort this transaction`}
        className={`flex items-center justify-center gap-1.5 rounded-[var(--radius)] font-semibold disabled:opacity-50 ${vertical ? 'flex-col px-2 py-3 w-12 min-h-11' : 'px-4 py-2 min-h-11'}`}
        // Everything that changes when the rail arms goes through Framer's own
        // `animate`, not a hand-written style + a Tailwind `transition-[…]`
        // class. Two reasons. (1) Once `whileTap` engages `scale` as a tracked
        // motion value on this element, Framer's render pass computes
        // style.transform purely from its tracked values and overwrites any
        // manually-set transform on the next frame. (2) Framer writes
        // background-color/color/box-shadow as inline styles too, and an
        // inline style has nothing to transition *from* under a CSS
        // `transition-[…]` rule when it is replaced wholesale each render —
        // the fill popped instead of ramping. Under `animate` they genuinely
        // interpolate over DUR.base.
        //
        // The transition is nested inside the animate target (not passed as a
        // sibling `transition` prop) so it scopes to these values only —
        // Pressable's own top-level `transition={PRESS_TRANSITION}` prop
        // would otherwise be shadowed by a sibling prop here, retuning the
        // 140ms whileTap feel to this 200ms armed duration too.
        animate={{
          scale: active ? 1.08 : 1,
          backgroundColor: active ? color : `${color}1f`,
          // Ink or paper, whichever reads on this fill — white was fine on the
          // darker seeds and ~3:1 on the lighter ones.
          color: active ? onActionColor(color) : color,
          // A zero-spread transparent shadow, not `none`: `none` is not a
          // shadow value Framer can interpolate from, so the lift would pop.
          boxShadow: active ? `0 10px 24px -8px ${color}` : '0 0 0 0 rgba(0,0,0,0)',
          transition: { duration: DUR.base, ease: EASE_OUT },
        }}
      >
        <Icon size={16} className="shrink-0" aria-hidden />
        <span className="text-[11px] tracking-wide leading-none">{action.label}</span>
      </Pressable>
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
  // Bucket colours resolve against the active theme at call time, so the deck
  // has to re-render when the OS flips or the rails keep the old theme's hues.
  useDitherTheme()
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
  const [emailOpen, setEmailOpen] = useState(false)

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
      ? Promise.all([
          postJSON(`/api/transactions/${commit.txn.ID}/categorize`, { category_id: null }),
          postJSON(`/api/transactions/${commit.txn.ID}/status`, { status: 'needs_review' }),
        ])
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
    setState(s => ({ ...s, pendingDirection: dir }))
  }, [config])

  const handleCategorySelect = useCallback(async (categoryId: number, projectId: number | null) => {
    if (!current) return
    fire('selection') // synchronous, before the network await
    const dir = state.pendingDirection
    const action = dir ? config[dir] : null
    const chosen = categories.find(c => c.ID === categoryId)
    // A transfer swipe only excludes when an excluded category is picked; a
    // credit sorted into Salary/Freelance from the same panel is confirmed
    // income and must not carry transfer status.
    const isTransfer = action?.statusOverride === 'transfer' && chosen?.Kind !== 'income'
    const categoryName = chosen?.Name ?? 'category'
    const commit: Commit = {
      seq: ++seqRef.current, index: state.index, txn: current, kind: isTransfer ? 'transfer' : 'categorize', categoryName,
    }
    commitRef.current = commit
    // Close the panel and mark the card as flying. Do NOT advance the index
    // here — see the effect below for why the two must land in separate
    // renders.
    setState(s => ({ ...s, pendingDirection: null, flyDirection: dir }))
    try {
      const resp = await postJSON<{ ok: boolean; rule_id?: number }>(
        `/api/transactions/${current.ID}/categorize`,
        {
          category_id: categoryId,
          merchant_raw: current.MerchantRaw,
          make_rule: !isTransfer && state.makeRule,
        },
      )
      commit.ruleID = resp?.rule_id
      if (isTransfer) {
        await postJSON(`/api/transactions/${current.ID}/status`, { status: 'transfer' })
      }
      if (projectId != null) {
        await assignTxnProject(current.ID, projectId)
        commit.projectID = projectId
      }
      invalidate()
      const projectName = projectId != null
        ? projects.data?.find(p => p.id === projectId)?.name
        : undefined
      toast.show({
        message: isTransfer
          ? `Excluded as ${categoryName}`
          : projectName
          ? `Sorted into ${categoryName} · ${projectName}`
          : `Sorted into ${categoryName}`,
        action: { label: 'Undo', onAction: () => undoCommit(commit.seq) },
      })
    } catch {
      failCommit(commit)
    }
  }, [current, categories, projects.data, config, state.pendingDirection, state.makeRule, state.index, invalidate, toast, undoCommit, failCommit])

  // One render after the card is marked flying, swap in the next one.
  // AnimatePresence holds the outgoing card mounted for its exit — with the
  // props it had when `flying` was set — while the incoming card enters over
  // it. That overlap is what removes the old 300ms exit + 320ms enter serial
  // cost; on a 40-card sitting it is ~25s of dead time.
  //
  // The two MUST land in separate renders. AnimatePresence animates out the
  // element as it was *last rendered*: batch `flyDirection` and `index` into
  // one setState and the outgoing card's final render is the one where
  // `flying` was still null, so it fades straight down instead of flying to
  // its bucket and the whole directional exit becomes dead code that still
  // looks plausible.
  useEffect(() => {
    if (!state.flyDirection) return
    setState(s => ({
      ...s,
      flyDirection: null,
      index: s.index + 1,
      previewDir: null,
      previewProgress: 0,
    }))
  }, [state.flyDirection])

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

  // No reset token any more: `dragSnapToOrigin` already returned the card to
  // centre the instant the pointer lifted, so by the time the panel is
  // cancelled there is no offset left to undo.
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingDirection: null, previewDir: null, previewProgress: 0 }))
  }, [])

  const pendingAction = state.pendingDirection ? config[state.pendingDirection] : null
  const done = state.index >= queue.length

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-5 text-center px-8">
        <CheckCircle size={72} className="text-fg" />
        <h2 className="text-2xl font-semibold text-fg">All caught up</h2>
        <p className="text-muted">
          <span className="tnum">{state.index}</span> transaction{state.index !== 1 ? 's' : ''} sorted this session
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
      {/* Header. The count, the total and the bar used to be three separate
          tellings of one fact — a big "28", a "12 of 40 sorted" sentence, and
          the fill below. The sentence is gone and the total rides on the count
          as a denominator, so the number states the work left, the denominator
          states the size of the job, and the bar is the only thing showing
          proportion. Mono throughout: these are figures, not prose. */}
      <div className="mb-3 px-1">
        <p className="tnum text-[11px] uppercase tracking-[0.18em] text-muted mb-0.5">Remaining</p>
        <p className="tnum leading-none text-fg" style={{ fontSize: '2rem', fontWeight: 500 }}>
          {remaining}
          <span className="text-muted" style={{ fontSize: '1rem' }}> / {total}</span>
        </p>
      </div>
      {/* `scaleX` on a full-width fill, not an animated `width` under
          `transition-all`: width is a layout property, and `transition-all`
          also swept in every other property that ever changes here. Unlike
          ProgressBar this bar carries no dither texture for a scale to
          distort, so the cheap transform is the right one. */}
      <div className="h-1.5 bg-border rounded-[var(--radius)] overflow-hidden mb-4">
        <m.div
          className="h-full origin-left bg-accent rounded-[var(--radius)]"
          style={{ width: '100%' }}
          animate={{ scaleX: progress }}
          transition={{ duration: DUR.sheet, ease: EASE_OUT }}
        />
      </div>

      {/* Card arena — rails hug the edges, card sits in the middle */}
      <div className="relative flex-1 flex items-center justify-center">
        {/* Edge color wash from the active direction */}
        {activeDir && activeColor && (
          <m.div
            aria-hidden
            className="absolute inset-0 pointer-events-none rounded-[var(--radius)]"
            style={{ background: WASH[activeDir](activeColor) }}
            initial={false}
            animate={{ opacity: washOpacity }}
            transition={{ duration: DUR.fast, ease: EASE_OUT }}
          />
        )}

        {/* Four bucket rails — tappable, so the deck can be worked without a
            swipe gesture at all. */}
        {(['up', 'down', 'left', 'right'] as const).map(dir => (
          <EdgeRail
            key={dir}
            dir={dir}
            action={config[dir]}
            active={activeDir === dir}
            disabled={!current}
            onCommit={handleDirectionCommit}
          />
        ))}

        {/* Sizing box keeps the ghost the same size as the front card. The
            vertical margin is the up/down rails' band: they sit at the arena's
            top and bottom edges, and the card is tall enough to reach both, so
            without it Transfer and Save render on top of the card. It only
            became visible when the rails stopped being a 12%-ink wash. */}
        {/* The horizontal inset is the left/right rails' band, exactly as the
            vertical margin is the up/down band. The rails are 48px wide and
            sit at the arena's edges, so an 80% card left only ~36px of gutter
            and Want/Need rendered on top of the card's own edges. */}
        <div className="relative w-[calc(100%-7rem)] max-w-[320px] my-11">
          {/* Ghost card behind gives depth */}
          {next && (
            <div
              aria-hidden
              className="absolute inset-0 bg-surface border border-border rounded-[var(--radius)] shadow-lg"
              style={{ transform: 'scale(0.94) translateY(14px)', zIndex: 0 }}
            />
          )}
          {/* `mode="popLayout"` takes the exiting card out of layout flow so
              the incoming card takes its place immediately rather than being
              pushed down by the one still leaving. `initial={false}` so the
              very first card of a session is already there rather than
              sliding in on top of the tab transition. */}
          <AnimatePresence initial={false} mode="popLayout">
            {current && (
              <SwipeCard
                key={current.ID}
                txn={current}
                config={config}
                flying={state.flyDirection}
                onDirectionCommit={handleDirectionCommit}
                onTripleTap={handleTripleTap}
                onPreview={handlePreview}
                onOpenEmail={() => setEmailOpen(true)}
              />
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="flex items-center justify-center gap-1 mt-3">
        <p className="text-xs text-muted">Swipe a card to sort ·</p>
        <Pressable
          className="text-xs font-medium text-muted underline underline-offset-2 min-h-11 px-2"
          onClick={handleTripleTap}
        >
          Skip for now
        </Pressable>
      </div>

      {current && current.Direction === 'credit' && (
        <button
          className="mx-auto mt-2 text-sm font-medium text-fg"
          onClick={() => setLinkOpen(true)}
        >
          This is a refund — link the purchase
        </button>
      )}

      {/* SubcategoryPanel rendered outside card stack to avoid clipping */}
      {pendingAction && current && (
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

      {emailOpen && current && (
        <EmailPreviewSheet txn={current} onClose={() => setEmailOpen(false)} />
      )}
    </div>
  )
}
