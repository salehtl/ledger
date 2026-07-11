import type { Category } from '../../api/types'
import { type SwipeAction, actionColor } from '../../lib/swipe'
import { Dialog } from '../ui/Dialog'

interface SubcategoryPanelProps {
  action: SwipeAction
  categories: Category[]
  makeRule: boolean
  onMakeRuleChange: (v: boolean) => void
  onSelect: (categoryId: number) => void
  onCancel: () => void
}

/** Bottom sheet for picking the category after an edge swipe. Built on the
 *  shared Dialog (focus trap, Escape, drag-to-dismiss); the bucket dot and
 *  tinted title tie the sheet to the direction just swiped. */
export function SubcategoryPanel({
  action,
  categories,
  makeRule,
  onMakeRuleChange,
  onSelect,
  onCancel,
}: SubcategoryPanelProps) {
  const color = actionColor(action)
  const visible = categories.filter(
    c => c.Kind === 'spending' && c.Bucket === action.bucket && c.IsActive,
  )

  return (
    <Dialog
      title={action.label}
      titleAdornment={<span aria-hidden className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />}
      titleStyle={{ color }}
      onClose={onCancel}
    >
      <div className="grid grid-cols-2 gap-2 mb-4">
        {visible.map(cat => (
          <button
            key={cat.ID}
            onClick={() => onSelect(cat.ID)}
            className="min-h-14 py-3 px-4 rounded-lg border border-border text-base font-medium text-fg hover:bg-surface-2 press text-left"
          >
            {cat.Name}
          </button>
        ))}
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
