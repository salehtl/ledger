import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MotionProvider } from '../../app/MotionProvider'
import { SubcategoryPanel } from './SubcategoryPanel'
import { DEFAULT_SWIPE_CONFIG } from '../../lib/swipe'
import type { Category, Project, Txn } from '../../api/types'

const CATS: Category[] = [
  { ID: 1, Name: 'Dining',        Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 2, Name: 'Entertainment', Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 3, Name: 'Groceries',     Kind: 'spending', Bucket: 'need',   IsActive: true },
  { ID: 4, Name: 'Savings',       Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 5, Name: 'Archived',      Kind: 'spending', Bucket: 'want',   IsActive: false },
  { ID: 6, Name: 'Salary',        Kind: 'income',   Bucket: '',       IsActive: true },
  { ID: 7, Name: 'Freelance',     Kind: 'income',   Bucket: '',       IsActive: true },
]

function txn(p: Partial<Txn> = {}): Txn {
  return {
    ID: 1, PostedAt: '2026-07-03T10:00:00Z', AmountFils: 5000, AmountAedFils: 5000, Currency: 'AED',
    Direction: 'debit', MerchantRaw: 'Carrefour', Status: 'needs_review', Confidence: 0.97, Source: 'email',
    CategoryID: null, CategoryName: '', Bucket: '', Kind: '', BucketSnapshot: '', RefundOfID: null,
    ...p,
  }
}

function project(p: Partial<Project>): Project {
  return {
    id: 1, name: 'Trip', budget_fils: null, color: '#8b5cf6',
    starts_on: '', ends_on: '', status: 'active', count_in_monthly: true,
    completed_at: '', net_spent_fils: 0, pending_fils: 0, txn_count: 0,
    ...p,
  }
}

const GEORGIA = project({ id: 21, name: 'Georgia trip', starts_on: '2026-07-01', ends_on: '2026-07-20' })
const KITCHEN = project({ id: 22, name: 'Kitchen reno', starts_on: '2026-01-01', ends_on: '2026-03-01' })

function renderPanel(over: {
  txnOverrides?: Partial<Txn>
  projects?: Project[]
  onSelect?: (categoryId: number, projectId: number | null) => void
  onMakeRuleChange?: (v: boolean) => void
  onCancel?: () => void
  makeRule?: boolean
} = {}) {
  // MotionProvider, because the panel is a Dialog: without a LazyMotion
  // ancestor its exit never runs and the backdrop-cancel test below would
  // pass against a sheet that closes instantly instead of animating out.
  render(
    <MotionProvider>
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.left}
        txn={txn(over.txnOverrides)}
        categories={CATS}
        projects={over.projects ?? []}
        makeRule={over.makeRule ?? false}
        onMakeRuleChange={over.onMakeRuleChange ?? vi.fn()}
        onSelect={over.onSelect ?? vi.fn()}
        onCancel={over.onCancel ?? vi.fn()}
      />
    </MotionProvider>,
  )
}

describe('SubcategoryPanel', () => {
  it('shows only active categories matching the action bucket', () => {
    renderPanel()
    expect(screen.getByText('Dining')).toBeInTheDocument()
    expect(screen.getByText('Entertainment')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).toBeNull()
    expect(screen.queryByText('Archived')).toBeNull()
  })

  it('calls onSelect with category ID and no project when tapped', () => {
    const onSelect = vi.fn()
    renderPanel({ onSelect })
    fireEvent.click(screen.getByText('Dining'))
    expect(onSelect).toHaveBeenCalledWith(1, null)
  })

  it('calls onCancel when backdrop is clicked', async () => {
    const onCancel = vi.fn()
    renderPanel({ onCancel })
    fireEvent.click(screen.getByTestId('dialog-scrim'))
    await waitFor(() => expect(onCancel).toHaveBeenCalled())
  })

  it('renders the Make Rule checkbox and toggles it', () => {
    const onMakeRuleChange = vi.fn()
    renderPanel({ makeRule: true, onMakeRuleChange })
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    expect(onMakeRuleChange).toHaveBeenCalledWith(false)
  })
})

describe('SubcategoryPanel projects', () => {
  it('hides the project row when there are no active projects', () => {
    renderPanel({ projects: [project({ id: 9, status: 'completed' })] })
    expect(screen.queryByText(/add to project/i)).toBeNull()
  })

  it('lists active projects with the date-window match first and marked suggested', () => {
    renderPanel({ projects: [KITCHEN, GEORGIA] })
    const chips = screen.getAllByRole('button', { name: /georgia trip|kitchen reno/i })
    expect(chips[0]).toHaveTextContent('Georgia trip')
    expect(chips[0]).toHaveAttribute('data-suggested', 'true')
    expect(chips[1]).toHaveTextContent('Kitchen reno')
    expect(chips[1]).toHaveAttribute('data-suggested', 'false')
  })

  it('passes the toggled-on project with the chosen category', () => {
    const onSelect = vi.fn()
    renderPanel({ projects: [KITCHEN, GEORGIA], onSelect })
    fireEvent.click(screen.getByRole('button', { name: /georgia trip/i }))
    fireEvent.click(screen.getByText('Dining'))
    expect(onSelect).toHaveBeenCalledWith(1, 21)
  })

  it('tapping a selected project again deselects it', () => {
    const onSelect = vi.fn()
    renderPanel({ projects: [GEORGIA], onSelect })
    const chip = screen.getByRole('button', { name: /georgia trip/i })
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByText('Dining'))
    expect(onSelect).toHaveBeenCalledWith(1, null)
  })
})

describe('SubcategoryPanel income for credits', () => {
  it('offers income categories when the card is a credit', () => {
    const onSelect = vi.fn()
    renderPanel({ txnOverrides: { Direction: 'credit' }, onSelect })
    const income = screen.getByTestId('income-group')
    expect(within(income).getByText('Salary')).toBeInTheDocument()
    fireEvent.click(within(income).getByText('Salary'))
    expect(onSelect).toHaveBeenCalledWith(6, null)
  })

  it('hides income categories for debits', () => {
    renderPanel()
    expect(screen.queryByText('Salary')).toBeNull()
    expect(screen.queryByTestId('income-group')).toBeNull()
  })
})

describe('SubcategoryPanel transfers', () => {
  function renderTransferPanel(txnOverrides: Partial<Txn> = {}, onSelect = vi.fn()) {
    render(
      <SubcategoryPanel
        action={DEFAULT_SWIPE_CONFIG.up}
        txn={txn(txnOverrides)}
        categories={[...CATS, { ID: 8, Name: 'Transfers', Kind: 'excluded', Bucket: '', IsActive: true }]}
        makeRule={false}
        onMakeRuleChange={() => {}}
        onSelect={onSelect}
        onCancel={() => {}}
      />,
    )
    return onSelect
  }

  it('offers excluded categories for the transfer action', () => {
    const onSelect = renderTransferPanel()
    fireEvent.click(within(screen.getByTestId('excluded-group')).getByText('Transfers'))
    expect(onSelect).toHaveBeenCalledWith(8, null)
  })

  it('offers income categories on a transfer swipe when the card is a credit', () => {
    const onSelect = renderTransferPanel({ Direction: 'credit' })
    const income = screen.getByTestId('income-group')
    fireEvent.click(within(income).getByText('Salary'))
    expect(onSelect).toHaveBeenCalledWith(6, null)
    // Excluded picks still there alongside
    expect(within(screen.getByTestId('excluded-group')).getByText('Transfers')).toBeInTheDocument()
  })

  it('hides income categories on a transfer swipe for debits', () => {
    renderTransferPanel()
    expect(screen.queryByTestId('income-group')).toBeNull()
    expect(screen.queryByText('Salary')).toBeNull()
  })
})
