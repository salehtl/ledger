import type { Category } from '../../api/types'
import { type EdgeGroup, GROUP_COLOR } from '../../lib/swipe'
import { Dialog } from '../ui/Dialog'

const GROUP_LABEL: Record<EdgeGroup, string> = {
  need: 'Need',
  want: 'Want',
  saving: 'Save',
  other: 'Transfer / Income',
}

interface SubcategoryPanelProps {
  group: EdgeGroup
  categories: Category[]
  makeRule: boolean
  onMakeRuleChange: (v: boolean) => void
  onSelect: (categoryId: number) => void
  onCancel: () => void
}

/** Bottom sheet for picking a category from an edge's "Other" sliver. Filters
 *  to the edge's group: a spending bucket, or income+excluded for "other". */
export function SubcategoryPanel({
  group,
  categories,
  makeRule,
  onMakeRuleChange,
  onSelect,
  onCancel,
}: SubcategoryPanelProps) {
  const color = GROUP_COLOR[group]
  const visible = categories.filter(c => {
    if (!c.IsActive) return false
    if (group === 'other') return c.Kind === 'income' || c.Kind === 'excluded'
    return c.Kind === 'spending' && c.Bucket === group
  })

  return (
    <Dialog
      title={GROUP_LABEL[group]}
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
        <span className="text-sm text-muted">Always use this category for this merchant</span>
      </label>
    </Dialog>
  )
}
