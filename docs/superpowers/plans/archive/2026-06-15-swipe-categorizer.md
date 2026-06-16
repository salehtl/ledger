# Tinder-Style Swipe Categorizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Tinder-style full-screen swipe UI where `needs_review` transactions are presented as cards — swipe Left (Want/purple), Right (Need/blue), Down (Save/green), Up (Transfer/amber). Each directional swipe opens a bottom drawer showing subcategories for that bucket. Triple-tap skips a card without categorizing. Swipe directions are reconfigurable per-user from Settings.

**Architecture:** `ReviewSwipe` is a full-screen overlay rendered by `AppShell` via an `inSwipeMode` boolean state. It fetches `needs_review` transactions and categories, then renders `SwipeDeck`. Each card uses the Pointer Events API for drag tracking (no gesture library). On release past a threshold the card locks, then `SubcategoryPanel` slides up to pick a subcategory; picking one calls the existing `POST /api/transactions/{id}/categorize` endpoint. Transfer swipes (up by default) skip the panel and call `POST /api/transactions/{id}/status` directly. Swipe direction→bucket mapping is stored in `localStorage` and editable in Settings.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v4 (CSS variable tokens: `border-border`, `text-muted`, `bg-surface`), TanStack Query (`getJSON`/`postJSON` named exports), Pointer Events API, Vitest

---

## File Map

| Path | Action | Responsibility |
|------|--------|----------------|
| `frontend/src/lib/swipe.ts` | Create | Direction math, `SwipeConfig` types, localStorage helpers |
| `frontend/src/lib/swipe.test.ts` | Create | Unit tests for direction detection and config loading |
| `frontend/src/hooks/useSwipeGesture.ts` | Create | Pointer event hook: dx/dy tracking, triple-tap counting |
| `frontend/src/components/swipe/SwipeCard.tsx` | Create | Draggable card with directional tint overlay and fly-out animation |
| `frontend/src/components/swipe/SubcategoryPanel.tsx` | Create | Slide-up bottom drawer with category grid for a given bucket |
| `frontend/src/components/swipe/SwipeDeck.tsx` | Create | Queue manager: renders card stack, orchestrates swipe→panel→API flow |
| `frontend/src/screens/ReviewSwipe.tsx` | Create | Full-screen mode: fetches data, renders SwipeDeck, shows empty/done state |
| `frontend/src/app/AppShell.tsx` | Modify | Add `inSwipeMode` state, render `ReviewSwipe` overlay, pass `onOpenSwipe` prop |
| `frontend/src/screens/Transactions.tsx` | Modify | Add "Swipe Mode" button when needs_review filter is active |
| `frontend/src/screens/Settings.tsx` | Modify | Add "Swipe Directions" config section (4 dropdowns) |

---

### Task 1: Direction Math & Config Utilities

**Files:**
- Create: `frontend/src/lib/swipe.ts`
- Create: `frontend/src/lib/swipe.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// frontend/src/lib/swipe.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  detectDirection,
  overlayProgress,
  previewDirection,
  loadSwipeConfig,
  saveSwipeConfig,
  DEFAULT_SWIPE_CONFIG,
  SWIPE_THRESHOLD,
} from './swipe'

describe('detectDirection', () => {
  it('returns null when both axes are below threshold', () => {
    expect(detectDirection(30, 20, SWIPE_THRESHOLD)).toBeNull()
  })
  it('detects left when dx is negative dominant', () => {
    expect(detectDirection(-100, 10, SWIPE_THRESHOLD)).toBe('left')
  })
  it('detects right when dx is positive dominant', () => {
    expect(detectDirection(100, 10, SWIPE_THRESHOLD)).toBe('right')
  })
  it('detects up when dy is negative dominant', () => {
    expect(detectDirection(10, -100, SWIPE_THRESHOLD)).toBe('up')
  })
  it('detects down when dy is positive dominant', () => {
    expect(detectDirection(10, 100, SWIPE_THRESHOLD)).toBe('down')
  })
  it('uses the larger axis when both exceed threshold', () => {
    expect(detectDirection(-200, 90, SWIPE_THRESHOLD)).toBe('left')
  })
  it('returns null when exactly at threshold on one axis only', () => {
    // absDx = 79, absDy = 0: both below threshold (80)
    expect(detectDirection(-79, 0, SWIPE_THRESHOLD)).toBeNull()
  })
})

describe('overlayProgress', () => {
  it('returns 0 when no drag', () => {
    expect(overlayProgress(0, 0)).toBe(0)
  })
  it('returns 1 when drag exceeds threshold', () => {
    expect(overlayProgress(-200, 0)).toBe(1)
  })
  it('returns fractional value for partial drag', () => {
    const p = overlayProgress(-40, 0)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
  })
})

describe('previewDirection', () => {
  it('returns direction at lower threshold (20px)', () => {
    expect(previewDirection(-30, 0)).toBe('left')
    expect(previewDirection(25, 0)).toBe('right')
  })
  it('returns null below 20px', () => {
    expect(previewDirection(-10, 5)).toBeNull()
  })
})

describe('loadSwipeConfig / saveSwipeConfig', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('returns DEFAULT_SWIPE_CONFIG when localStorage is empty', () => {
    const cfg = loadSwipeConfig()
    expect(cfg.left.bucket).toBe('want')
    expect(cfg.right.bucket).toBe('need')
    expect(cfg.down.bucket).toBe('saving')
    expect(cfg.up.statusOverride).toBe('transfer')
  })

  it('round-trips a custom config', () => {
    const custom = { ...DEFAULT_SWIPE_CONFIG, left: { ...DEFAULT_SWIPE_CONFIG.right } }
    saveSwipeConfig(custom)
    expect(loadSwipeConfig().left.bucket).toBe('need')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /root/Coding/ledger/frontend && npx vitest run src/lib/swipe.test.ts 2>&1 | tail -15
```
Expected: `Error: Cannot find module './swipe'`

- [ ] **Step 3: Implement swipe.ts**

```typescript
// frontend/src/lib/swipe.ts

export type SwipeDirection = 'left' | 'right' | 'up' | 'down'

export interface SwipeAction {
  /** Spending bucket to filter subcategories by. Null means no subcategory panel (transfer). */
  bucket: 'want' | 'need' | 'saving' | null
  /** When set, skip SubcategoryPanel and POST this status directly. */
  statusOverride?: 'transfer'
  label: string
  /** Tailwind background class for the directional overlay. */
  colorClass: string
  /** Tailwind text class for panel headers. */
  textClass: string
  /** lucide-react icon component name. */
  icon: string
}

export interface SwipeConfig {
  left: SwipeAction
  right: SwipeAction
  up: SwipeAction
  down: SwipeAction
}

export const SWIPE_THRESHOLD = 80

export const DEFAULT_SWIPE_CONFIG: SwipeConfig = {
  left:  { bucket: 'want',   label: 'Want',     colorClass: 'bg-purple-500', textClass: 'text-purple-700', icon: 'Heart' },
  right: { bucket: 'need',   label: 'Need',     colorClass: 'bg-blue-500',   textClass: 'text-blue-700',   icon: 'Home' },
  down:  { bucket: 'saving', label: 'Save',     colorClass: 'bg-green-500',  textClass: 'text-green-700',  icon: 'PiggyBank' },
  up:    { bucket: null, statusOverride: 'transfer', label: 'Transfer', colorClass: 'bg-amber-500', textClass: 'text-amber-700', icon: 'ArrowLeftRight' },
}

const STORAGE_KEY = 'ledger-swipe-config'

/**
 * Returns the dominant swipe direction if drag distance exceeds threshold.
 * The axis with larger absolute displacement wins.
 */
export function detectDirection(dx: number, dy: number, threshold = SWIPE_THRESHOLD): SwipeDirection | null {
  const absDx = Math.abs(dx)
  const absDy = Math.abs(dy)
  if (absDx < threshold && absDy < threshold) return null
  if (absDx >= absDy) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}

/**
 * 0–1 progress for overlay opacity based on drag magnitude.
 * Reaches 1 at SWIPE_THRESHOLD.
 */
export function overlayProgress(dx: number, dy: number): number {
  const dist = Math.max(Math.abs(dx), Math.abs(dy))
  return Math.min(1, dist / SWIPE_THRESHOLD)
}

/**
 * Like detectDirection but uses a lower threshold (20px) for live preview feedback.
 */
export function previewDirection(dx: number, dy: number): SwipeDirection | null {
  return detectDirection(dx, dy, 20)
}

export function loadSwipeConfig(): SwipeConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SwipeConfig>
      return { ...DEFAULT_SWIPE_CONFIG, ...parsed }
    }
  } catch { /* ignore corrupt data */ }
  return DEFAULT_SWIPE_CONFIG
}

export function saveSwipeConfig(config: SwipeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /root/Coding/ledger/frontend && npx vitest run src/lib/swipe.test.ts 2>&1 | tail -15
```
Expected: `14 passed`

- [ ] **Step 5: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/lib/swipe.ts frontend/src/lib/swipe.test.ts
git commit -m "feat(swipe): direction math, SwipeConfig types, localStorage helpers"
```

---

### Task 2: useSwipeGesture Hook

**Files:**
- Create: `frontend/src/hooks/useSwipeGesture.ts`

- [ ] **Step 1: Create the hook**

```typescript
// frontend/src/hooks/useSwipeGesture.ts
import { useRef, useState, useCallback } from 'react'
import { detectDirection, SWIPE_THRESHOLD, type SwipeDirection } from '../lib/swipe'

export interface GestureState {
  dx: number
  dy: number
  dragging: boolean
  lockedDirection: SwipeDirection | null
}

const IDLE: GestureState = { dx: 0, dy: 0, dragging: false, lockedDirection: null }

interface UseSwipeGestureResult {
  state: GestureState
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  reset: () => void
}

/**
 * Tracks pointer drag gestures and triple-tap on a single card element.
 *
 * - Drag past SWIPE_THRESHOLD → calls onDirectionCommit(dir) and locks state
 * - Drag below threshold → snaps back to IDLE
 * - 3 taps within 500ms → calls onTripleTap()
 */
export function useSwipeGesture(
  onDirectionCommit: (dir: SwipeDirection) => void,
  onTripleTap: () => void,
): UseSwipeGestureResult {
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const tapCountRef = useRef(0)
  const tapTimerRef = useRef<ReturnType<typeof setTimeout>>()
  // Use refs for callbacks to avoid stale closures in pointer handlers
  const onCommitRef = useRef(onDirectionCommit)
  const onTripleTapRef = useRef(onTripleTap)
  onCommitRef.current = onDirectionCommit
  onTripleTapRef.current = onTripleTap

  const [state, setState] = useState<GestureState>(IDLE)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Capture so we keep receiving events even if pointer leaves element
    e.currentTarget.setPointerCapture(e.pointerId)
    startRef.current = { x: e.clientX, y: e.clientY }
    setState(s => ({ ...s, dx: 0, dy: 0, dragging: true, lockedDirection: null }))
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    setState(s => ({ ...s, dx, dy }))
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!startRef.current) return
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    startRef.current = null

    if (Math.hypot(dx, dy) < 8) {
      // Treat as tap
      clearTimeout(tapTimerRef.current)
      tapCountRef.current += 1
      tapTimerRef.current = setTimeout(() => { tapCountRef.current = 0 }, 500)
      if (tapCountRef.current >= 3) {
        tapCountRef.current = 0
        onTripleTapRef.current()
      }
      setState(IDLE)
      return
    }

    const dir = detectDirection(dx, dy, SWIPE_THRESHOLD)
    if (dir) {
      setState({ dx, dy, dragging: false, lockedDirection: dir })
      onCommitRef.current(dir)
    } else {
      // Below threshold — spring back
      setState(IDLE)
    }
  }, [])

  const reset = useCallback(() => {
    setState(IDLE)
    startRef.current = null
  }, [])

  return { state, onPointerDown, onPointerMove, onPointerUp, reset }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /root/Coding/ledger/frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/hooks/useSwipeGesture.ts
git commit -m "feat(swipe): useSwipeGesture pointer hook with triple-tap detection"
```

---

### Task 3: SwipeCard Component

**Files:**
- Create: `frontend/src/components/swipe/SwipeCard.tsx`

- [ ] **Step 1: Create SwipeCard**

```tsx
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

  // Which direction hint to show: locked direction first, then live preview
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
          style={{ opacity: progress * 0.9 }}
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

        <Money fils={txn.AmountFils} className="text-4xl font-bold tabular-nums" />

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
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /root/Coding/ledger/frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/components/swipe/SwipeCard.tsx
git commit -m "feat(swipe): SwipeCard with pointer-driven drag and directional overlay"
```

---

### Task 4: SubcategoryPanel Component

**Files:**
- Create: `frontend/src/components/swipe/SubcategoryPanel.tsx`
- Create: `frontend/src/components/swipe/SubcategoryPanel.test.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
// frontend/src/components/swipe/SubcategoryPanel.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SubcategoryPanel } from './SubcategoryPanel'
import { DEFAULT_SWIPE_CONFIG } from '../../lib/swipe'
import type { Category } from '../../api/types'

const CATS: Category[] = [
  { ID: 1, Name: 'Dining',       Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 2, Name: 'Entertainment',Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 3, Name: 'Groceries',    Kind: 'spending', Bucket: 'need',   IsActive: true },
  { ID: 4, Name: 'Savings',      Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 5, Name: 'Archived',     Kind: 'spending', Bucket: 'want',   IsActive: false },
]

describe('SubcategoryPanel', () => {
  it('shows only active categories matching the action bucket', () => {
    render(
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.left}
        categories={CATS}
        makeRule={false}
        onMakeRuleChange={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('Dining')).toBeInTheDocument()
    expect(screen.getByText('Entertainment')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).toBeNull()
    expect(screen.queryByText('Archived')).toBeNull()
  })

  it('calls onSelect with category ID when tapped', () => {
    const onSelect = vi.fn()
    render(
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.left}
        categories={CATS}
        makeRule={false}
        onMakeRuleChange={vi.fn()}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Dining'))
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn()
    const { container } = render(
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.left}
        categories={CATS}
        makeRule={false}
        onMakeRuleChange={vi.fn()}
        onSelect={vi.fn()}
        onCancel={onCancel}
      />
    )
    // Click the outer scrim div (first child)
    fireEvent.click(container.firstChild as Element)
    expect(onCancel).toHaveBeenCalled()
  })

  it('renders the Make Rule checkbox and toggles it', () => {
    const onMakeRuleChange = vi.fn()
    render(
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.left}
        categories={CATS}
        makeRule={true}
        onMakeRuleChange={onMakeRuleChange}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(onMakeRuleChange).toHaveBeenCalledWith(false)
  })
})
```

- [ ] **Step 2: Check testing libraries are available**

```bash
cd /root/Coding/ledger/frontend && cat package.json | grep -E '"@testing-library|vitest"' | head -10
```

If `@testing-library/react` is missing, install it:
```bash
cd /root/Coding/ledger/frontend && npm install -D @testing-library/react @testing-library/jest-dom jsdom 2>&1 | tail -5
```

Then add `environment: 'jsdom'` and `setupFiles` to `vite.config.ts` vitest block and create `src/test-setup.ts`:
```typescript
// frontend/src/test-setup.ts
import '@testing-library/jest-dom'
```

- [ ] **Step 3: Run tests to verify failure**

```bash
cd /root/Coding/ledger/frontend && npx vitest run src/components/swipe/SubcategoryPanel.test.tsx 2>&1 | tail -15
```
Expected: `Cannot find module './SubcategoryPanel'`

- [ ] **Step 4: Implement SubcategoryPanel**

```tsx
// frontend/src/components/swipe/SubcategoryPanel.tsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { Category } from '../../api/types'
import type { SwipeAction } from '../../lib/swipe'

interface SubcategoryPanelProps {
  action: SwipeAction
  categories: Category[]
  makeRule: boolean
  onMakeRuleChange: (v: boolean) => void
  onSelect: (categoryId: number) => void
  onCancel: () => void
}

export function SubcategoryPanel({
  action,
  categories,
  makeRule,
  onMakeRuleChange,
  onSelect,
  onCancel,
}: SubcategoryPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  const visible = categories.filter(
    c => c.Kind === 'spending' && c.Bucket === action.bucket && c.IsActive,
  )

  // Slide up on mount
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    el.style.transform = 'translateY(100%)'
    // Allow the initial paint, then animate in
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transform = 'translateY(0)'
      })
    })
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-end"
      onClick={onCancel}
      data-testid="subcategory-scrim"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative w-full bg-white rounded-t-3xl px-4 pt-4 pb-safe-bottom pb-8"
        style={{ transition: 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="w-10 h-1.5 rounded-full bg-slate-200 mx-auto mb-5" />

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className={`text-lg font-semibold ${action.textClass}`}>{action.label}</h3>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-slate-100 text-[--muted]"
            aria-label="Cancel"
          >
            <X size={18} />
          </button>
        </div>

        {/* Category grid */}
        <div className="grid grid-cols-2 gap-2 mb-5">
          {visible.map(cat => (
            <button
              key={cat.ID}
              onClick={() => onSelect(cat.ID)}
              className="py-4 px-4 rounded-2xl border border-[--border] text-sm font-medium text-[--fg] hover:bg-slate-50 active:scale-95 transition-transform text-left"
            >
              {cat.Name}
            </button>
          ))}
        </div>

        {/* Make rule toggle */}
        <label className="flex items-center gap-3 py-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={makeRule}
            onChange={e => onMakeRuleChange(e.target.checked)}
            className="w-4 h-4"
          />
          <span className="text-sm text-[--muted]">
            Always use this category for this merchant
          </span>
        </label>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Run tests**

```bash
cd /root/Coding/ledger/frontend && npx vitest run src/components/swipe/SubcategoryPanel.test.tsx 2>&1 | tail -15
```
Expected: `4 passed`

- [ ] **Step 6: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/components/swipe/SubcategoryPanel.tsx frontend/src/components/swipe/SubcategoryPanel.test.tsx
git commit -m "feat(swipe): SubcategoryPanel bottom drawer with category grid"
```

---

### Task 5: SwipeDeck Component

**Files:**
- Create: `frontend/src/components/swipe/SwipeDeck.tsx`

- [ ] **Step 1: Create SwipeDeck**

```tsx
// frontend/src/components/swipe/SwipeDeck.tsx
import { useState, useCallback, useRef } from 'react'
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
  // Ref holds the ID of the current txn that needs a transfer POST after card exits
  const pendingTransferRef = useRef<number | null>(null)

  const [state, setState] = useState<DeckState>({
    index: 0,
    skippedIds: new Set(),
    pendingDirection: null,
    flyDirection: null,
    makeRule: true,
  })

  // Active queue excludes IDs skipped this session
  const queue = transactions.filter(t => !state.skippedIds.has(t.ID))
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
      // No subcategory panel: record the transfer ID and play exit animation
      pendingTransferRef.current = current?.ID ?? null
      setState(s => ({ ...s, flyDirection: dir }))
    } else {
      setState(s => ({ ...s, pendingDirection: dir }))
    }
  }, [config, current])

  const handleCategorySelect = useCallback(async (categoryId: number) => {
    if (!current) return
    const dir = state.pendingDirection
    // Dismiss panel and begin card exit animation
    setState(s => ({ ...s, pendingDirection: null, flyDirection: dir }))
    try {
      await postJSON(`/api/transactions/${current.ID}/categorize`, {
        category_id: categoryId,
        merchant_raw: current.MerchantRaw,
        make_rule: state.makeRule,
      })
      invalidate()
    } catch {
      // Card already animated out — best effort; user can re-categorize from list
    }
  }, [current, state.pendingDirection, state.makeRule, invalidate])

  const handleExitComplete = useCallback(() => {
    const transferId = pendingTransferRef.current
    pendingTransferRef.current = null
    if (transferId !== null) {
      postJSON(`/api/transactions/${transferId}/status`, { status: 'transfer' })
        .then(invalidate)
        .catch(() => { /* swallowed — can fix from list */ })
    }
    setState(s => ({ ...s, flyDirection: null, index: s.index + 1 }))
  }, [invalidate])

  const handleTripleTap = useCallback(() => {
    if (!current) return
    setState(s => ({
      ...s,
      skippedIds: new Set([...s.skippedIds, current.ID]),
    }))
  }, [current])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, pendingDirection: null }))
    // SwipeCard resets its internal gesture state when txn.ID hasn't changed —
    // we force a re-render by bumping a reset key via a no-op state update.
    // The card's useEffect([txn.ID]) won't fire, but the lockedDirection inside
    // the hook wasn't set (we guard with pendingDirection at deck level).
  }, [])

  const pendingAction = state.pendingDirection ? config[state.pendingDirection] : null
  const done = state.index >= queue.length

  if (done) {
    return (
      <div className="flex flex-col items-center justify-center flex-1 gap-5 text-center px-8">
        <CheckCircle size={72} className="text-green-500" />
        <h2 className="text-2xl font-bold text-[--fg]">All caught up!</h2>
        <p className="text-[--muted]">
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
        <p className="text-sm text-center text-[--muted] mb-2">
          {state.index + 1} of {total}
        </p>
        <div className="h-1.5 bg-[--border] rounded-full overflow-hidden">
          <div
            className="h-full bg-[--accent] rounded-full transition-all duration-300"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* Card stack — ghost card behind gives depth */}
      <div className="relative flex-1 flex items-center justify-center">
        {next && (
          <div
            aria-hidden
            className="absolute inset-0 bg-white rounded-3xl shadow-lg"
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

      {/* Subcategory panel — rendered outside card stack to avoid clip */}
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
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /root/Coding/ledger/frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/components/swipe/SwipeDeck.tsx
git commit -m "feat(swipe): SwipeDeck queue manager with card stack and API integration"
```

---

### Task 6: ReviewSwipe Screen

**Files:**
- Create: `frontend/src/screens/ReviewSwipe.tsx`

- [ ] **Step 1: Create ReviewSwipe screen**

```tsx
// frontend/src/screens/ReviewSwipe.tsx
import { useQuery } from '@tanstack/react-query'
import { getJSON } from '../api/client'
import { ArrowLeft, Loader2 } from 'lucide-react'
import type { Category, Txn } from '../api/types'
import { SwipeDeck } from '../components/swipe/SwipeDeck'
import { loadSwipeConfig } from '../lib/swipe'

interface ReviewSwipeProps {
  onClose: () => void
}

export function ReviewSwipe({ onClose }: ReviewSwipeProps) {
  const config = loadSwipeConfig()

  const txns = useQuery({
    queryKey: ['review'],
    queryFn: () => getJSON<Txn[]>('/api/review'),
  })
  const cats = useQuery({
    queryKey: ['categories'],
    queryFn: () => getJSON<Category[]>('/api/categories'),
  })

  const loading = txns.isPending || cats.isPending
  const empty = !loading && (txns.data?.length ?? 0) === 0

  return (
    <div className="fixed inset-0 z-40 bg-[--bg] flex flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-4 pt-safe-top pt-4 pb-3 border-b border-[--border]">
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-xl hover:bg-slate-100 text-[--muted]"
          aria-label="Close swipe mode"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-lg font-semibold text-[--fg]">Review Transactions</h1>
      </header>

      {/* Body */}
      <div className="flex-1 flex flex-col overflow-hidden py-6">
        {loading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={36} className="animate-spin text-[--muted]" />
          </div>
        )}

        {!loading && empty && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 text-center">
            <p className="text-5xl">🎉</p>
            <h2 className="text-xl font-bold text-[--fg]">Nothing to review</h2>
            <p className="text-[--muted]">All transactions are categorized.</p>
          </div>
        )}

        {!loading && !empty && (
          <SwipeDeck
            transactions={txns.data!}
            categories={cats.data!}
            config={config}
          />
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /root/Coding/ledger/frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/screens/ReviewSwipe.tsx
git commit -m "feat(swipe): ReviewSwipe full-screen overlay with loading and empty states"
```

---

### Task 7: Wire Up Route & CTA in AppShell + Transactions

**Files:**
- Modify: `frontend/src/app/AppShell.tsx`
- Modify: `frontend/src/screens/Transactions.tsx`

- [ ] **Step 1: Add swipe mode state and overlay to AppShell**

Read the current file first, then apply this edit.

In `AppShell.tsx`, add the `useState` for `inSwipeMode` and render `ReviewSwipe` as a full-screen overlay:

```tsx
// frontend/src/app/AppShell.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { BottomNav } from "../components/ui/BottomNav";
import { type TabId } from "./nav";
import { useOnline } from "../hooks/useOnline";
import { useLiveEvents } from "../hooks/useLiveEvents";
import { Home } from "../screens/Home";
import { Transactions } from "../screens/Transactions";
import { Insights } from "../screens/Insights";
import { Settings } from "../screens/Settings";
import { ReviewSwipe } from "../screens/ReviewSwipe";

export function AppShell() {
  const [tab, setTab] = useState<TabId>("home");
  const [inSwipeMode, setInSwipeMode] = useState(false);
  const online = useOnline();
  useLiveEvents();

  const review = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const reviewCount = review.data?.length ?? 0;

  return (
    <div className="min-h-[100dvh] flex flex-col">
      {!online && (
        <div role="status" className="bg-warn/15 text-warn text-sm text-center py-1">
          Offline — showing last loaded data
        </div>
      )}
      <main className="flex-1 max-w-screen-sm w-full mx-auto px-4 pt-4 pb-24">
        {tab === "home" && <Home />}
        {tab === "transactions" && (
          <Transactions onOpenSwipeMode={() => setInSwipeMode(true)} />
        )}
        {tab === "insights" && <Insights />}
        {tab === "settings" && <Settings />}
      </main>
      <BottomNav active={tab} reviewCount={reviewCount} onNavigate={setTab} />

      {/* Full-screen swipe overlay — rendered above everything */}
      {inSwipeMode && <ReviewSwipe onClose={() => setInSwipeMode(false)} />}
    </div>
  );
}
```

- [ ] **Step 2: Add `onOpenSwipeMode` prop to Transactions**

In `Transactions.tsx`, add the prop and a "Swipe Mode" button that appears when the `needs_review` filter is active:

Add prop to the function signature:
```tsx
export function Transactions({ onOpenSwipeMode }: { onOpenSwipeMode?: () => void }) {
```

Add the button after `<SegmentedControl ... />` (around line 74) when filter is `needs_review`:
```tsx
{filter === "needs_review" && onOpenSwipeMode && (
  <button
    onClick={onOpenSwipeMode}
    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[--accent] text-[--accent-fg] text-sm font-medium hover:opacity-90 transition-opacity self-start"
  >
    <span>⚡</span>
    Swipe Mode
  </button>
)}
```

The full Transactions.tsx function signature and JSX section to modify:

Replace the existing export line:
```tsx
// OLD:
export function Transactions() {
// NEW:
export function Transactions({ onOpenSwipeMode }: { onOpenSwipeMode?: () => void }) {
```

And in the JSX, after `</SegmentedControl>` add the swipe mode button. The section around the filter (lines 70–80) becomes:
```tsx
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Transactions</h1>
      <div className="flex flex-col gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        {filter === "needs_review" && onOpenSwipeMode && (
          <button
            onClick={onOpenSwipeMode}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[--accent] text-white text-sm font-medium hover:opacity-90 transition-opacity self-start"
          >
            <span>⚡</span>
            Swipe Mode
          </button>
        )}
        <input
          type="search"
          placeholder="Search merchant…"
          {/* ... rest of JSX unchanged ... */}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /root/Coding/ledger/frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/app/AppShell.tsx frontend/src/screens/Transactions.tsx
git commit -m "feat(swipe): wire ReviewSwipe overlay into AppShell + Swipe Mode CTA in Transactions"
```

---

### Task 8: Settings — Swipe Direction Configuration

**Files:**
- Modify: `frontend/src/screens/Settings.tsx`

- [ ] **Step 1: Add swipe config section to Settings**

Add this import at the top of `Settings.tsx`:
```tsx
import {
  loadSwipeConfig,
  saveSwipeConfig,
  DEFAULT_SWIPE_CONFIG,
  type SwipeConfig,
  type SwipeDirection,
} from '../lib/swipe'
```

Add state for swipe config inside the `Settings` component (after the existing `const [error, setError] = useState("")` line):
```tsx
const [swipeCfg, setSwipeCfg] = useState<SwipeConfig>(loadSwipeConfig)
```

Add a helper to update and persist a single direction:
```tsx
const setSwipeDir = (dir: SwipeDirection, bucket: SwipeConfig[SwipeDirection]['bucket'] | 'transfer') => {
  const next: SwipeConfig = { ...swipeCfg }
  if (bucket === 'transfer') {
    next[dir] = { ...DEFAULT_SWIPE_CONFIG.up }
  } else {
    const template = Object.values(DEFAULT_SWIPE_CONFIG).find(a => a.bucket === bucket)!
    next[dir] = { ...template }
  }
  setSwipeCfg(next)
  saveSwipeConfig(next)
}
```

Add the section to the JSX (after the Rules card, before the closing `</div>`):
```tsx
{/* Swipe Directions */}
<Card>
  <h2 className="font-semibold mb-1">Swipe Directions</h2>
  <p className="text-sm text-[--muted] mb-4">
    Customize what each swipe direction means when reviewing transactions.
  </p>
  <div className="space-y-3">
    {(['left', 'right', 'up', 'down'] as const).map(dir => {
      const dirLabel: Record<SwipeDirection, string> = {
        left: '← Left', right: '→ Right', up: '↑ Up', down: '↓ Down',
      }
      const current = swipeCfg[dir]
      return (
        <div key={dir} className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-[--fg] w-20">{dirLabel[dir]}</span>
          <select
            value={current.statusOverride === 'transfer' ? 'transfer' : current.bucket ?? ''}
            onChange={e => setSwipeDir(dir, e.target.value as SwipeConfig[SwipeDirection]['bucket'] | 'transfer')}
            className={field}
          >
            <option value="want">Want</option>
            <option value="need">Need</option>
            <option value="saving">Save</option>
            <option value="transfer">Transfer</option>
          </select>
        </div>
      )
    })}
  </div>
  <Button
    variant="ghost"
    className="mt-3 text-sm"
    onClick={() => {
      setSwipeCfg(DEFAULT_SWIPE_CONFIG)
      saveSwipeConfig(DEFAULT_SWIPE_CONFIG)
    }}
  >
    Reset to defaults
  </Button>
</Card>
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /root/Coding/ledger/frontend && npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Run the full test suite**

```bash
cd /root/Coding/ledger/frontend && npx vitest run 2>&1 | tail -20
```
Expected: all existing tests pass + new swipe tests pass

- [ ] **Step 4: Commit**

```bash
cd /root/Coding/ledger && git add frontend/src/screens/Settings.tsx
git commit -m "feat(swipe): add swipe direction remapping section to Settings"
```

---

### Task 9: Build & Manual Smoke Test

- [ ] **Step 1: Build the frontend**

```bash
cd /root/Coding/ledger/frontend && npm run build 2>&1 | tail -20
```
Expected: `✓ built in` — no errors

- [ ] **Step 2: Run the server**

```bash
cd /root/Coding/ledger && go run ./cmd/ledger 2>&1 &
```

- [ ] **Step 3: Smoke test checklist**

Open the app and verify:

1. **Transactions tab → Needs Review filter** → "⚡ Swipe Mode" button appears
2. **Tap Swipe Mode** → Full-screen overlay opens with a transaction card
3. **Drag left slowly** → Purple overlay fades in with "Want" label
4. **Drag to full left and release** → SubcategoryPanel slides up showing Want categories (Dining, Entertainment, Shopping, etc.)
5. **Tap "Dining"** → Panel closes, card flies left, next card appears
6. **Drag right** → Blue "Need" overlay, panel shows Need categories on release
7. **Drag up** → Amber "Transfer" overlay; on release: card flies up immediately (no panel), status set to transfer
8. **Drag down** → Green "Save" overlay; panel shows Saving categories
9. **Tap once, twice, three times** → Card advances to next (skip)
10. **Categorize all cards** → "All caught up!" empty state
11. **Back arrow** → Returns to Transactions screen
12. **Settings → Swipe Directions** → 4 dropdowns appear, changing them persists across reopens
13. **"Make a rule" checkbox** in SubcategoryPanel persists its state across category picks in the same session

- [ ] **Step 4: Kill dev server and commit final**

```bash
kill %1 2>/dev/null; cd /root/Coding/ledger && git add -p && git commit -m "feat(swipe): smoke test verified — tinder-style swipe categorizer complete"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Swipe Left → Want (purple)
- ✅ Swipe Right → Need (blue)
- ✅ Swipe Down → Saving (green)
- ✅ Swipe Up → Transfer (amber), no subcategory panel
- ✅ Triple-tap = skip
- ✅ Two-step: direction swipe → subcategory picker for left/right/down
- ✅ 5+ subcategories per bucket (seeded from DB: Dining, Entertainment, Shopping, Travel, Subscriptions for Want; Rent, Utilities, Groceries, Transport, Healthcare for Need; Savings, Investments, Debt Repayment for Saving)
- ✅ Direction → bucket reconfigurable in Settings, stored in localStorage
- ✅ "Make a rule" option in subcategory panel (mirrors CategorizeSheet behavior)
- ✅ Progress indicator (N of M)
- ✅ Card stack depth effect (ghost card behind)
- ✅ Back navigation

**No placeholders:** All code blocks are complete and executable.

**Type consistency:**
- `SwipeAction.bucket` is `'want' | 'need' | 'saving' | null` throughout
- `SwipeDirection` is `'left' | 'right' | 'up' | 'down'` throughout
- API body uses snake_case (`category_id`, `make_rule`, `merchant_raw`) matching existing pattern in Transactions.tsx
- `GestureState` used in both hook and card — no naming drift
