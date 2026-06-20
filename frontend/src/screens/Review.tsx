import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
          <Loader2 size={36} className="animate-spin text-muted" />
        </div>
      )}

      {!loading && empty && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
          <p className="text-5xl">✅</p>
          <h2 className="text-xl font-bold text-fg">All caught up here</h2>
          <p className="text-muted">Everything in {scopeLabel(scope)} is categorized.</p>
        </div>
      )}

      {!loading && !empty && (
        <SwipeDeck key={deckKey} transactions={txns.data!} categories={cats.data!} config={config} />
      )}
    </div>
  );
}
