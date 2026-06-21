import { useQueryClient } from "@tanstack/react-query";
import { postJSON } from "../api/client";
import type { Txn } from "../api/types";
import { useToast } from "../components/Toast";

/** Shared transaction mutations (status, archive, restore, categorize) with
 *  toasts, undo, and query invalidation. Used by the Transactions screen and
 *  the Insights drill-down/search sheets. */
export function useTxnActions() {
  const qc = useQueryClient();
  const { show } = useToast();

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

  const archiveTxn = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/archive`, {});
      invalidate();
      show({ message: `Archived ${name}`, action: { label: "Undo", onAction: () => { void postJSON(`/api/transactions/${t.ID}/restore`, {}).then(invalidate).catch(() => show({ message: `Couldn't undo`, tone: "error" })); } } });
    } catch { show({ message: `Couldn't archive ${name}`, tone: "error" }); }
  };

  const restoreTxn = async (t: Txn) => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/restore`, {});
      invalidate();
      show({ message: `Restored ${name}` });
    } catch { show({ message: `Couldn't restore ${name}`, tone: "error" }); }
  };

  const categorize = async (t: Txn, body: { category_id: number; make_rule: boolean }): Promise<boolean> => {
    const name = t.MerchantRaw || "transaction";
    try {
      await postJSON(`/api/transactions/${t.ID}/categorize`, { ...body, merchant_raw: t.MerchantRaw });
      invalidate();
      show({ message: `Categorized ${name}`, tone: "success" });
      return true;
    } catch { show({ message: `Couldn't categorize ${name}`, tone: "error" }); return false; }
  };

  return { invalidate, setStatus, archiveTxn, restoreTxn, categorize };
}
