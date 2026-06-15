import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SubcategoryPanel } from './SubcategoryPanel'
import { DEFAULT_SWIPE_CONFIG } from '../../lib/swipe'
import type { Category } from '../../api/types'

const CATS: Category[] = [
  { ID: 1, Name: 'Dining',        Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 2, Name: 'Entertainment', Kind: 'spending', Bucket: 'want',   IsActive: true },
  { ID: 3, Name: 'Groceries',     Kind: 'spending', Bucket: 'need',   IsActive: true },
  { ID: 4, Name: 'Savings',       Kind: 'spending', Bucket: 'saving', IsActive: true },
  { ID: 5, Name: 'Archived',      Kind: 'spending', Bucket: 'want',   IsActive: false },
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
