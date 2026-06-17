// frontend/src/screens/Transactions.tsx
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { TransactionRow } from "../components/transactions/TransactionRow";
import { CategorizeSheet } from "../components/transactions/CategorizeSheet";
import { FilterChips } from "../components/transactions/FilterChips";
import { useToast } from "../components/Toast";
import { txnTotals, applyTxnFilters, EMPTY_FILTERS, type TxnFilters } from "../lib/transactions";
import { formatFils } from "../lib/money";
import { AlertTriangle, ListOrdered, Search, Zap } from "lucide-react";

type Filter = "all" | "needs_review" | "confirmed";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Needs review" },
  { value: "confirmed" as const, label: "Confirmed" },
];

export function Transactions({ from, to, onOpenSwipeMode }: { from?: string; to?: string; onOpenSwipeMode?: () => void }) {
  const qc = useQueryClient();
  const { show } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
  const [active, setActive] = useState<Txn | null>(null);

  const status = filter === "all" ? "" : filter;
  const q = useQuery({
    queryKey: ["transactions", status, from ?? "", to ?? ""],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return getJSON<Txn[]>(qs ? `/api/transactions?${qs}` : "/api/transactions");
    },
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const rows = useMemo(() => {
    let data = applyTxnFilters(q.data ?? [], filters);
    const term = search.trim().toLowerCase();
    if (term) data = data.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(term));
    return data;
  }, [q.data, search, filters]);
  const totals = useMemo(() => txnTotals(rows), [rows]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    qc.invalidateQueries({ queryKey: ["review"] });
    qc.invalidateQueries({ queryKey: ["insights-categories"] });
    qc.invalidateQueries({ queryKey: ["insights-trend"] });
  };

  const setStatus = async (t: Txn, newStatus: string) => {
    const name = t.MerchantRaw || "transaction";
    const verb = newStatus === "ignored" ? "Ignored" : newStatus === "transfer" ? "Marked transfer" : "Updated";
    try {
      await postJSON(`/api/transactions/${t.ID}/status`, { status: newStatus });
      invalidate();
      show({ message: `${verb} ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/status`, { status: "needs_review" }).then(invalidate).catch(() => show({ message: `Couldn't undo`, tone: "error" })); } } });
    } catch { show({ message: `Couldn't update ${name}`, tone: "error" }); }
  };

  const categorize = async (t: Txn, body: { category_id: number; make_rule: boolean }) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/categorize`, { ...body, merchant_raw: t.MerchantRaw });
      setActive(null);
      invalidate();
      show({ message: `Categorized ${name}`, tone: "success" });
    } catch { show({ message: `Couldn't categorize ${name}`, tone: "error" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        {filter === "needs_review" && onOpenSwipeMode && (
          <button
            onClick={onOpenSwipeMode}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-accent-fg text-sm font-medium hover:opacity-90 transition-opacity whitespace-nowrap"
          >
            <Zap size={16} /> Swipe
          </button>
        )}
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input
          type="search"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-sm"
        />
      </div>

      <FilterChips filters={filters} categories={cats.data ?? []} txns={q.data ?? []} onChange={setFilters} />

      {q.isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load transactions" hint="Check your connection and try again." />
      ) : q.isLoading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListOrdered} title="No transactions" hint="Try a different period, filter, or search." />
      ) : (
        <>
          <div className="flex items-center justify-between px-1">
            <p className="text-sm text-muted">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
            {totals.spentFils > 0 && (
              <p className="text-sm text-muted tnum">{formatFils(totals.spentFils)} spent</p>
            )}
          </div>
          <Card className="!p-0">
            <ul className="divide-y divide-border px-4">
              {rows.map((t) => (
                <li key={t.ID}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} /></li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {active && cats.data && (
        <CategorizeSheet
          txn={active}
          categories={cats.data}
          onSubmit={(body) => categorize(active, body)}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
