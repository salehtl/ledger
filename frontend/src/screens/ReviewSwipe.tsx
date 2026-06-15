import { useState } from 'react'
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
  const [config] = useState(loadSwipeConfig)

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
      <header className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-[--border]">
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
