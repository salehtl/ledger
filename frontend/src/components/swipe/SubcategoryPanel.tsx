import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import type { Category } from '../../api/types'
import { type SwipeAction, actionColor } from '../../lib/swipe'

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

  const color = actionColor(action)
  const visible = categories.filter(
    c => c.Kind === 'spending' && c.Bucket === action.bucket && c.IsActive,
  )

  // Slide up on mount
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    el.style.transform = 'translateY(100%)'
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transform = 'translateY(0)'
      })
    })
  }, [])

  return (
    <div
      className="fixed inset-x-0 top-0 h-[100dvh] z-50 flex items-end"
      onClick={onCancel}
      data-testid="subcategory-scrim"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative w-full bg-surface rounded-t-3xl px-4 pt-4 pb-[max(2rem,env(safe-area-inset-bottom))] max-h-[85dvh] overflow-y-auto overscroll-contain"
        style={{ transition: 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Drag handle */}
        <div className="w-10 h-1.5 rounded-full bg-border mx-auto mb-5" />

        {/* Header — bucket dot ties the sheet to the direction just swiped */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
            <h3 className="text-lg font-semibold" style={{ color }}>{action.label}</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-surface-2 text-muted"
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
              className="py-4 px-4 rounded-2xl border border-border text-sm font-medium text-fg hover:bg-surface-2 active:scale-95 transition-transform text-left"
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
          <span className="text-sm text-muted">
            Always use this category for this merchant
          </span>
        </label>
      </div>
    </div>
  )
}
