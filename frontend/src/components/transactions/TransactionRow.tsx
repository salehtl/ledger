// frontend/src/components/transactions/TransactionRow.tsx
import type { Txn } from "../../api/types";
import { Money } from "../Money";
import { Pill } from "../ui/Pill";
import { statusLabel, statusTone } from "../../lib/format";
import { ArrowLeftRight, X, Tag } from "lucide-react";

export function TransactionRow({ txn, onOpen, onStatus }: {
  txn: Txn;
  onOpen: (t: Txn) => void;
  onStatus: (t: Txn, status: string) => void;
}) {
  const needsReview = txn.Status === "needs_review";
  const subtitle = [txn.PostedAt.slice(0, 10), txn.CategoryName].filter(Boolean).join(" · ");
  return (
    <div className="py-2.5 flex items-center gap-3">
      <button className="flex-1 min-w-0 text-left" aria-label={`Open ${txn.MerchantRaw || "transaction"}`} onClick={() => onOpen(txn)}>
        <p className="truncate font-medium">{txn.MerchantRaw || "—"}</p>
        <p className="text-xs text-muted truncate">{subtitle || "Uncategorized"}</p>
      </button>
      <div className="flex flex-col items-end gap-1">
        <span className="tnum font-medium"><Money fils={txn.Direction === "credit" ? txn.AmountFils : -txn.AmountFils} /></span>
        <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>
      </div>
      {needsReview && (
        <div className="flex flex-col gap-1">
          <button aria-label="Categorize" className="p-1.5 rounded-lg hover:bg-bg text-accent" onClick={() => onOpen(txn)}><Tag size={16} /></button>
          <button aria-label="Transfer" className="p-1.5 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "transfer")}><ArrowLeftRight size={16} /></button>
          <button aria-label="Ignore" className="p-1.5 rounded-lg hover:bg-bg text-muted" onClick={() => onStatus(txn, "ignored")}><X size={16} /></button>
        </div>
      )}
    </div>
  );
}
