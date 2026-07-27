import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "../components/ui/PixelIcon";
import { PixelSpinner } from "../components/ui/PixelSpinner";
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
  const empty = !loading && (txns.data?.length ?? 0) === 0;
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

      {!loading && empty && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
          <CheckCircle2 size={48} className="text-fg" />
          {/* Same words the deck uses when you finish sorting — one state, one
              name, whether you cleared it just now or arrived to nothing. */}
          <h2 className="text-xl font-semibold text-fg">All caught up</h2>
          <p className="text-muted">Nothing in {scopeLabel(scope)} needs a look.</p>
        </div>
      )}

      {!loading && !empty && (
        <SwipeDeck key={deckKey} transactions={txns.data!} categories={cats.data!} config={config} />
      )}
    </div>
  );
}
