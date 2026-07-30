import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "../components/ui/PixelIcon";
import { PixelSpinner } from "../components/ui/PixelSpinner";
import { EmptyState } from "../components/EmptyState";
import { getJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { SwipeDeck } from "../components/swipe/SwipeDeck";
import { loadSwipeConfig } from "../lib/swipe";
import { type Scope, scopeBounds, scopeLabel } from "../lib/scope";

export function Review({ scope }: { scope: Scope }) {
  const [config] = useState(loadSwipeConfig);
  const bounds = scopeBounds(scope);

  const txns = useQuery({
    queryKey: ["review", bounds.from ?? "", bounds.to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams({ status: "needs_review" });
      if (bounds.from) params.set("from", bounds.from);
      if (bounds.to) params.set("to", bounds.to);
      return getJSON<Txn[]>(`/api/transactions?${params.toString()}`);
    },
  });
  const cats = useQuery({
    queryKey: ["categories"],
    queryFn: () => getJSON<Category[]>("/api/categories"),
  });

  const loading = txns.isPending || cats.isPending;
  // A failed fetch is not an empty queue. Without this, a dropped request
  // rendered "All caught up" — telling you your review queue was clear when
  // it had simply failed to load. The deck also needs categories: it can't
  // triage into a list it doesn't have.
  const rows = txns.data;
  const categories = cats.data;
  const failed = !loading && (txns.isError || cats.isError || !rows || !categories);
  const empty = !loading && !failed && (rows?.length ?? 0) === 0;
  // Remount the deck when the scope changes: SwipeDeck freezes its transaction
  // list at mount, so a fresh scope needs a fresh mount to re-freeze.
  const deckKey = `${bounds.from ?? "all"}:${bounds.to ?? "all"}`;

  return (
    <div className="flex flex-col min-h-[60vh]">
      {loading && (
        <div className="flex-1 flex items-center justify-center py-16">
          <PixelSpinner size={36} role="status" aria-label="Loading transactions" className="text-muted" />
        </div>
      )}

      {failed && (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={AlertTriangle}
            title="Couldn't load your review queue"
            hint="Check your connection and pull down to try again."
          />
        </div>
      )}

      {!loading && empty && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
          <CheckCircle2 size={48} className="text-fg" />
          {/* Same words the deck uses when you finish sorting — one state, one
              name, whether you cleared it just now or arrived to nothing. */}
          <h2 className="text-xl font-semibold text-fg">All caught up</h2>
          <p className="text-muted">Nothing in {scopeLabel(scope)} needs a look.</p>
        </div>
      )}

      {!loading && !empty && rows && categories && (
        <SwipeDeck key={deckKey} transactions={rows} categories={categories} config={config} />
      )}
    </div>
  );
}
