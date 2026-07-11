import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SubcategoryPanel } from './SubcategoryPanel'
import type { Category } from '../../api/types'

const CATS: Category[] = [
  { ID: 1, Name: 'Dining',        Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 2, Name: 'Entertainment', Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 3, Name: 'Groceries',     Kind: 'spending', Bucket: 'need',   IsActive: true },
  { ID: 4, Name: 'Savings',       Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 5, Name: 'Archived',      Kind: 'spending', Bucket: 'want',   IsActive: false },
]

describe('SubcategoryPanel', () => {
  it('shows only active categories matching the group bucket', () => {
    render(
      <SubcategoryPanel
        group="need"
        categories={CATS}
        makeRule={false}
        onMakeRuleChange={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByText('Groceries')).toBeInTheDocument()
    expect(screen.queryByText('Dining')).not.toBeInTheDocument()
    expect(screen.queryByText('Entertainment')).not.toBeInTheDocument()
    expect(screen.queryByText('Archived')).not.toBeInTheDocument()
  })

  it('calls onSelect with category ID when tapped', () => {
    const onSelect = vi.fn()
    render(
      <SubcategoryPanel
        group="want"
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

  it('calls onCancel when backdrop is clicked', async () => {
    const onCancel = vi.fn()
    render(
      <SubcategoryPanel
        group="want"
        categories={CATS}
        makeRule={false}
        onMakeRuleChange={vi.fn()}
        onSelect={vi.fn()}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByTestId('dialog-scrim'))
    await waitFor(() => expect(onCancel).toHaveBeenCalled())
  })

  it('renders the Make Rule checkbox and toggles it', () => {
    const onMakeRuleChange = vi.fn()
    render(
      <SubcategoryPanel
        group="want"
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

  it('lists income and excluded categories for the "other" group', () => {
    const categories = [
      { ID: 1, Name: 'Salary', Kind: 'income', Bucket: '', IsActive: true },
      { ID: 2, Name: 'Transfers', Kind: 'excluded', Bucket: '', IsActive: true },
      { ID: 3, Name: 'Groceries', Kind: 'spending', Bucket: 'need', IsActive: true },
    ]
    render(
      <SubcategoryPanel
        group="other"
        categories={categories}
        makeRule={false}
        onMakeRuleChange={() => {}}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByText('Salary')).toBeInTheDocument()
    expect(screen.getByText('Transfers')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
  })
})
