// frontend/src/views/Review.tsx
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getJSON, postJSON } from "../api/client";
import type { Category, Txn } from "../api/types";
import { Money } from "../components/Money";
import { Icon } from "../components/Icon";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { CategorizeDialog } from "../components/CategorizeDialog";
import { useToast } from "../components/Toast";

export function Review() {
  const qc = useQueryClient();
  const { show } = useToast();
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
  const act = async (txn: Txn, status: string, verb: string) => {
    const name = txn.MerchantRaw || "transaction";
    try {
      await setStatus(txn.ID, status);
      show({
        message: `${verb} ${name}`,
        action: { label: "Undo", onAction: () => { void setStatus(txn.ID, "needs_review"); } },
      });
    } catch {
      show({ message: `Couldn't update ${name}`, tone: "error" });
    }
  };
  const categorize = async (txn: Txn, body: { category_id: number; make_rule: boolean }) => {
    const name = txn.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${txn.ID}/categorize`, { ...body, merchant_raw: txn.MerchantRaw });
      setActive(null);
      invalidate();
      show({ message: `Categorized ${txn.MerchantRaw || "transaction"}`, tone: "success" });
    } catch {
      show({ message: `Couldn't categorize ${name}`, tone: "error" });
    }
  };

  if (items.isLoading) return <Skeleton rows={4} />;
  if (items.isError) return <EmptyState icon="alert" title="Couldn't load review" hint="Check your connection and try again." />;
  const rows = items.data ?? [];
  if (rows.length === 0) {
    return <EmptyState icon="tick" title="All caught up" hint="No transactions need review right now." />;
  }
  return (
    <div className="list">
      {rows.map((t) => (
        <div key={t.ID} className="card review-card">
          <button className="card-main" onClick={() => setActive(t)}>
            <span className="card-merchant">{t.MerchantRaw || "—"}</span>
            <span className="card-sub">{t.PostedAt.slice(0, 10)} · tap to categorize</span>
          </button>
          <Money fils={-t.AmountFils} />
          <div className="card-actions">
            <button className="action" onClick={() => act(t, "transfer", "Marked transfer")}>
              <Icon name="transfer" alt="" /> Transfer
            </button>
            <button className="action" onClick={() => act(t, "ignored", "Ignored")}>
              <Icon name="cross" alt="" /> Ignore
            </button>
          </div>
        </div>
      ))}
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
