import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { Money } from "../components/Money";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { CategorizeDialog } from "../components/CategorizeDialog";
import { useToast } from "../components/Toast";
import { statusLabel, statusTone } from "../lib/format";

export interface TxnFilters { status: string; from: string; to: string; }

export function buildTxnQuery(f: TxnFilters): string {
  const params = new URLSearchParams();
  if (f.status) params.set("status", f.status);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  const qs = params.toString();
  return qs ? `/api/transactions?${qs}` : "/api/transactions";
}

export function Transactions() {
  const qc = useQueryClient();
  const { show } = useToast();
  const [filters, setFilters] = useState<TxnFilters>({ status: "", from: "", to: "" });
  const [active, setActive] = useState<Txn | null>(null);
  const q = useQuery({
    queryKey: ["transactions", filters],
    queryFn: () => getJSON<Txn[]>(buildTxnQuery(filters)),
  });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });
  const set = (patch: Partial<TxnFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const categorize = async (txn: Txn, body: { category_id: number; make_rule: boolean }) => {
    const name = txn.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${txn.ID}/categorize`, { ...body, merchant_raw: txn.MerchantRaw });
      setActive(null);
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
      qc.invalidateQueries({ queryKey: ["review"] });
      show({ message: `Categorized ${name}`, tone: "success" });
    } catch {
      show({ message: `Couldn't categorize ${name}`, tone: "error" });
    }
  };

  const rows = q.data ?? [];
  return (
    <div>
      <div className="filters">
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="needs_review">Needs review</option>
          <option value="transfer">Transfer</option>
          <option value="ignored">Ignored</option>
        </select>
        <input type="date" aria-label="From" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
        <input type="date" aria-label="To" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      </div>

      {q.isError ? (
        <EmptyState icon="alert" title="Couldn't load transactions" hint="Check your connection and try again." />
      ) : q.isLoading ? (
        <Skeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState icon="table" title="No transactions" hint="Try widening the date range or clearing filters." />
      ) : (
        <>
          <p className="result-count">{rows.length} transaction{rows.length === 1 ? "" : "s"}</p>
          <div className="list">
            {rows.map((t) => (
              <button key={t.ID} className="card txn-card" onClick={() => setActive(t)}>
                <span className="card-main">
                  <span className="card-merchant">{t.MerchantRaw || "—"}</span>
                  <span className="card-sub">{t.PostedAt.slice(0, 10)}</span>
                </span>
                <span className={`pill pill-${statusTone(t.Status)}`}>{statusLabel(t.Status)}</span>
                <Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} />
              </button>
            ))}
          </div>
        </>
      )}

      {active && cats.data && (
        <CategorizeDialog
          txn={active}
          categories={cats.data}
          onSubmit={(body) => categorize(active, body)}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
