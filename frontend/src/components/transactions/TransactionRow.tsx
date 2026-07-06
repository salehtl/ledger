// frontend/src/components/transactions/TransactionRow.tsx
import type { Txn } from "../../api/types";
import { flowAmount, aedFils, nativeAmountTag } from "../../lib/money";
import { Pill } from "../ui/Pill";
import { statusLabel, statusTone } from "../../lib/format";
import { bucketColor } from "../../lib/insights";
import { ArrowLeftRight, X, Tag, Archive, ArchiveRestore } from "lucide-react";
import { IconButton } from "../ui/IconButton";

export function TransactionRow({ txn, onOpen, onStatus, onArchive, onRestore }: {
  txn: Txn;
  onOpen: (t: Txn) => void;
  onStatus: (t: Txn, status: string) => void;
  onArchive: (t: Txn) => void;
  onRestore: (t: Txn) => void;
}) {
  const needsReview = txn.Status === "needs_review";
  const archived = txn.Status === "archived";
  const aed = aedFils(txn);
  const native = nativeAmountTag(txn);
  const subtitle = [
    txn.PostedAt.slice(0, 10),
    txn.CategoryName,
    txn.RefundOfID ? "refund" : null,
    native,
    aed === null ? "no AED rate" : null,
  ].filter(Boolean).join(" · ");
  const amount = flowAmount(txn.Direction, aed ?? txn.AmountFils);
  return (
    <div className="py-2.5 flex items-stretch gap-3">
      <span
        aria-hidden
        className="w-1 rounded-full shrink-0"
        style={{ background: txn.Bucket ? bucketColor(txn.Bucket) : "var(--color-border)" }}
      />
      <button className="flex-1 min-w-0 text-left self-center" aria-label={`Open ${txn.MerchantRaw || "transaction"}`} onClick={() => onOpen(txn)}>
        <p className="truncate font-medium">{txn.MerchantRaw || "—"}</p>
        <p className="text-xs text-muted truncate">{subtitle || "Uncategorized"}</p>
      </button>
      <div className="flex flex-col items-end gap-1 self-center">
        <span
          className="tnum font-medium"
          style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
          title={amount.flow === "in" ? "Money in" : "Money out"}
        >
          {amount.text}
        </span>
        <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>
      </div>
      <div className="flex flex-col gap-1 self-center">
        {archived ? (
          <IconButton label="Restore" size="sm" tone="accent" onClick={() => onRestore(txn)}><ArchiveRestore size={16} /></IconButton>
        ) : (
          <>
            {needsReview && (
              <>
                <IconButton label="Categorize" size="sm" tone="accent" onClick={() => onOpen(txn)}><Tag size={16} /></IconButton>
                <IconButton label="Transfer" size="sm" onClick={() => onStatus(txn, "transfer")}><ArrowLeftRight size={16} /></IconButton>
                <IconButton label="Ignore" size="sm" onClick={() => onStatus(txn, "ignored")}><X size={16} /></IconButton>
              </>
            )}
            <IconButton label="Archive" size="sm" onClick={() => onArchive(txn)}><Archive size={16} /></IconButton>
          </>
        )}
      </div>
    </div>
  );
}
