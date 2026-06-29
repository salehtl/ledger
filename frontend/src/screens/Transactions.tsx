// frontend/src/screens/Transactions.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { Card } from "../components/ui/Card";
import { Skeleton } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { TransactionRow } from "../components/transactions/TransactionRow";
import { CategorizeSheet } from "../components/transactions/CategorizeSheet";
import { AddTransactionSheet } from "../components/transactions/AddTransactionSheet";
import { Fab } from "../components/ui/Fab";
import { FilterChips } from "../components/transactions/FilterChips";
import { useToast } from "../components/Toast";
import { txnTotals, applyTxnFilters, EMPTY_FILTERS, type TxnFilters, type ManualTxnPayload } from "../lib/transactions";
import { searchTxns } from "../lib/analysis";
import { formatFils } from "../lib/money";
import { AlertTriangle, ListOrdered, Search, Plus } from "lucide-react";
import { useTxnActions } from "../hooks/useTxnActions";
import { useFirstMount } from "../hooks/useFirstMount";

type Filter = "all" | "needs_review" | "confirmed" | "archived";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Needs review" },
  { value: "confirmed" as const, label: "Confirmed" },
  { value: "archived" as const, label: "Archived" },
];

export function Transactions({ from, to }: { from?: string; to?: string }) {
  const { show } = useToast();
  const firstMount = useFirstMount();
  const { invalidate, setStatus, archiveTxn, restoreTxn, categorize } = useTxnActions();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TxnFilters>(EMPTY_FILTERS);
  const [active, setActive] = useState<Txn | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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
    const filtered = applyTxnFilters(q.data ?? [], filters);
    return searchTxns(filtered, search);
  }, [q.data, search, filters]);
  const totals = useMemo(() => txnTotals(rows), [rows]);

  const createTxn = async (payload: ManualTxnPayload) => {
    try {
      await postJSON("/api/transactions", payload);
      setAddOpen(false);
      invalidate();
      show({ message: "Transaction added", tone: "success" });
    } catch { show({ message: "Couldn't add transaction", tone: "error" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
      </div>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" aria-hidden />
        <input
          type="search"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-md border border-border bg-surface text-sm"
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
                <li key={t.ID} className={firstMount ? "stagger-item" : undefined}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} onArchive={archiveTxn} onRestore={restoreTxn} /></li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {active && cats.data && (
        <CategorizeSheet
          txn={active}
          categories={cats.data}
          onSubmit={async (body) => { if (await categorize(active, body)) setActive(null); }}
          onClose={() => setActive(null)}
        />
      )}

      <Fab icon={Plus} label="Add transaction" onClick={() => setAddOpen(true)} />

      {addOpen && (
        <AddTransactionSheet categories={cats.data ?? []} onSubmit={createTxn} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}
