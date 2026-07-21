import { useState } from 'react'
import type { Category, Project, Txn } from '../../api/types'
import { type SwipeAction, actionColor } from '../../lib/swipe'
import { orderProjectsForReview } from '../../lib/projectMath'
import { Dialog } from '../ui/Dialog'

interface SubcategoryPanelProps {
  action: SwipeAction
  txn: Txn
  categories: Category[]
  /** Active projects for the optional assign-on-sort chips; [] hides the row. */
  projects?: Project[]
  makeRule: boolean
  onMakeRuleChange: (v: boolean) => void
  onSelect: (categoryId: number, projectId: number | null) => void
  onCancel: () => void
}

/** Bottom sheet for picking the category after an edge swipe. Built on the
 *  shared Dialog (focus trap, Escape, drag-to-dismiss); the bucket dot and
 *  tinted title tie the sheet to the direction just swiped. Projects whose
 *  date window covers the transaction surface first as suggestions, and
 *  credits additionally offer income categories (a salary isn't a Want). */
export function SubcategoryPanel({
  action,
  txn,
  categories,
  projects = [],
  makeRule,
  onMakeRuleChange,
  onSelect,
  onCancel,
}: SubcategoryPanelProps) {
  const color = actionColor(action)
  const [projectID, setProjectID] = useState<number | null>(null)

  const visible = categories.filter(
    c => c.Kind === 'spending' && c.Bucket === action.bucket && c.IsActive,
  )
  const income = txn.Direction === 'credit'
    ? categories.filter(c => c.Kind === 'income' && c.IsActive)
    : []
  const ranked = orderProjectsForReview(projects, txn.PostedAt)

  const categoryButton = (cat: Category) => (
    <button
      key={cat.ID}
      onClick={() => onSelect(cat.ID, projectID)}
      className="min-h-14 py-3 px-4 rounded-lg border border-border text-base font-medium text-fg hover:bg-surface-2 press text-left"
    >
      {cat.Name}
    </button>
  )

  return (
    <Dialog
      title={action.label}
      titleAdornment={<span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
      titleStyle={{ color }}
      onClose={onCancel}
    >
      {ranked.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted mb-2">
            Add to project
          </p>
          <div className="flex flex-wrap gap-2">
            {ranked.map(p => {
              const selected = projectID === p.id
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={selected}
                  data-suggested={p.suggested}
                  onClick={() => setProjectID(selected ? null : p.id)}
                  className="min-h-11 px-3.5 rounded-full text-sm font-medium inline-flex items-center gap-2 press border transition-colors"
                  style={selected
                    ? { backgroundColor: p.color, borderColor: p.color, color: '#fff' }
                    : { borderColor: p.suggested ? p.color : 'var(--color-border)', color: 'var(--color-fg)' }}
                >
                  <span aria-hidden className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: selected ? 'currentColor' : p.color }} />
                  {p.name}
                  {p.suggested && !selected && <span className="text-xs text-muted">these dates</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {income.length > 0 && (
        <div className="mb-4" data-testid="income-group">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted mb-2">
            Or is this income?
          </p>
          <div className="grid grid-cols-2 gap-2">
            {income.map(categoryButton)}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mb-4">
        {visible.map(categoryButton)}
      </div>

      <label className="flex items-center gap-3 py-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={makeRule}
          onChange={e => onMakeRuleChange(e.target.checked)}
          className="w-5 h-5 accent-accent"
        />
        <span className="text-sm text-muted">
          Always use this category for this merchant
        </span>
      </label>
    </Dialog>
  )
}
