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
import { useToast } from "../components/Toast";
import { AlertTriangle, ListOrdered } from "lucide-react";

type Filter = "all" | "needs_review" | "confirmed";
const FILTERS = [
  { value: "all" as const, label: "All" },
  { value: "needs_review" as const, label: "Needs review" },
  { value: "confirmed" as const, label: "Confirmed" },
];

export function Transactions() {
  const qc = useQueryClient();
  const { show } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState<Txn | null>(null);

  const status = filter === "all" ? "" : filter;
  const q = useQuery({
    queryKey: ["transactions", status],
    queryFn: () => getJSON<Txn[]>(status ? `/api/transactions?status=${status}` : "/api/transactions"),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const rows = useMemo(() => {
    const data = q.data ?? [];
    const term = search.trim().toLowerCase();
    return term ? data.filter((t) => (t.MerchantRaw || "").toLowerCase().includes(term)) : data;
  }, [q.data, search]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
    qc.invalidateQueries({ queryKey: ["review"] });
  };

  const setStatus = async (t: Txn, newStatus: string) => {
    const name = t.MerchantRaw || "transaction";
    const verb = newStatus === "ignored" ? "Ignored" : newStatus === "transfer" ? "Marked transfer" : "Updated";
    try {
      await postJSON(`/api/transactions/${t.ID}/status`, { status: newStatus });
      invalidate();
      show({ message: `${verb} ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/status`, { status: "needs_review" }).then(invalidate); } } });
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
      <h1 className="text-xl font-semibold">Transactions</h1>
      <div className="flex flex-col gap-2">
        <SegmentedControl value={filter} onChange={setFilter} options={FILTERS} />
        <input
          type="search"
          placeholder="Search merchant…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm"
        />
      </div>

      {q.isError ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load transactions" hint="Check your connection and try again." />
      ) : q.isLoading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={ListOrdered} title="No transactions" hint="Try a different filter or search." />
      ) : (
        <Card className="!p-0">
          <p className="text-xs text-muted px-4 pt-3">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
          <ul className="divide-y divide-border px-4">
            {rows.map((t) => (
              <li key={t.ID}><TransactionRow txn={t} onOpen={setActive} onStatus={setStatus} /></li>
            ))}
          </ul>
        </Card>
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
