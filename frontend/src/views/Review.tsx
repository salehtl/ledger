import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { Money } from "../components/Money";
import { CategorizeDialog } from "../components/CategorizeDialog";

export function Review() {
  const qc = useQueryClient();
  const [active, setActive] = useState<Txn | null>(null);
  const items = useQuery({ queryKey: ["review"], queryFn: () => getJSON<Txn[]>("/api/review") });
  const cats = useQuery({ queryKey: ["categories"], queryFn: () => getJSON<Category[]>("/api/categories") });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["review"] });
    qc.invalidateQueries({ queryKey: ["summary"] });
  };
  const setStatus = async (id: number, status: string) => {
    await postJSON(`/api/transactions/${id}/status`, { status });
    invalidate();
  };
  const categorize = async (id: number, body: { category_id: number; make_rule: boolean }) => {
    await postJSON(`/api/transactions/${id}/categorize`, body);
    setActive(null);
    invalidate();
  };

  if (items.isLoading) return <p>Loading…</p>;
  const rows = items.data ?? [];
  if (rows.length === 0) return <p>Nothing to review. 🎉</p>;
  return (
    <div>
      {rows.map((t) => (
        <div key={t.ID} className="window" style={{ marginBottom: 8 }}>
          <div className="window-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button style={{ flex: 1, textAlign: "left" }} onClick={() => setActive(t)}>
              {t.MerchantRaw || "—"} · <Money fils={-t.AmountFils} />
            </button>
            <button onClick={() => setStatus(t.ID, "transfer")} title="Transfer">⇄</button>
            <button onClick={() => setStatus(t.ID, "ignored")} title="Ignore">✕</button>
          </div>
        </div>
      ))}
      {active && cats.data && (
        <CategorizeDialog
          txn={active}
          categories={cats.data}
          onSubmit={(body) => categorize(active.ID, body)}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
