import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJSON } from "../api/client";
import type { Txn } from "../api/types";
import { Money } from "../components/Money";

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
  const [filters, setFilters] = useState<TxnFilters>({ status: "", from: "", to: "" });
  const q = useQuery({
    queryKey: ["transactions", filters],
    queryFn: () => getJSON<Txn[]>(buildTxnQuery(filters)),
  });
  const set = (patch: Partial<TxnFilters>) => setFilters((f) => ({ ...f, ...patch }));
  return (
    <div>
      <div className="field-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="confirmed">Confirmed</option>
          <option value="needs_review">Needs review</option>
          <option value="transfer">Transfer</option>
          <option value="ignored">Ignored</option>
        </select>
        <input type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
        <input type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
      </div>
      {q.isLoading ? <p>Loading…</p> : (
        <table className="ledger-table" style={{ width: "100%" }}>
          <thead><tr><th>Date</th><th>Merchant</th><th>Status</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {(q.data ?? []).map((t) => (
              <tr key={t.ID}>
                <td>{t.PostedAt.slice(0, 10)}</td>
                <td>{t.MerchantRaw || "—"}</td>
                <td>{t.Status}</td>
                <td style={{ textAlign: "right" }}><Money fils={t.Direction === "credit" ? t.AmountFils : -t.AmountFils} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
