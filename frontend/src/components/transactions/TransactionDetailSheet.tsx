// frontend/src/components/transactions/TransactionDetailSheet.tsx
import type { Txn } from "../../api/types";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { flowAmount, aedFils, nativeAmountTag } from "../../lib/money";
import { statusLabel, statusTone, shortDate } from "../../lib/format";
import { sourceLabel } from "../../lib/transactions";
import { bucketColor } from "../../lib/insights";
import { Tag, ArrowLeftRight, EyeOff, Archive, ArchiveRestore, Link2, Link2Off } from "../ui/PixelIcon";

/**
 * The one place a transaction's actions live. Tapping a row opens this; swipe
 * only covers the two commonest moves, everything else is here. Actions are
 * gated by status so a row never shows a move that doesn't apply to it.
 */
export function TransactionDetailSheet({ txn, onClose, onCategorize, onStatus, onArchive, onRestore, onLinkRefund, onUnlinkRefund }: {
  txn: Txn;
  onClose: () => void;
  onCategorize: () => void;
  onStatus: (status: string) => void;
  onArchive: () => void;
  onRestore: () => void;
  onLinkRefund: () => void;
  onUnlinkRefund: () => void;
}) {
  const aed = aedFils(txn);
  const native = nativeAmountTag(txn);
  const amount = flowAmount(txn.Direction, aed ?? txn.AmountFils);
  const needsReview = txn.Status === "needs_review";
  const archived = txn.Status === "archived";
  const categorized = txn.CategoryID != null;

  return (
    <Dialog title={txn.MerchantRaw || "Transaction"} onClose={onClose}>
      <div className="flex items-center justify-between gap-3 mb-1">
        <span
          className="text-2xl font-semibold tnum"
          style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
        >
          {amount.text}
        </span>
        <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted mb-4">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="w-2 h-2 rounded-[var(--radius)]" style={{ background: txn.Bucket ? bucketColor(txn.Bucket) : "var(--color-border)" }} />
          {txn.CategoryName || "Uncategorized"}
        </span>
        <span aria-hidden>·</span>
        <span>{shortDate(txn.PostedAt)}</span>
        <span aria-hidden>·</span>
        <span>{sourceLabel(txn.Source)}</span>
        {native && <><span aria-hidden>·</span><span className="tnum">{native}</span></>}
        {aed === null && <Pill>no AED rate</Pill>}
        {txn.RefundOfID != null && <Pill tone="muted">refund</Pill>}
      </div>

      <div className="space-y-2">
        <Button variant="primary" className="w-full" onClick={onCategorize}>
          <Tag size={16} aria-hidden />
          {categorized ? "Recategorize" : "Categorize"}
        </Button>

        {needsReview && (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => onStatus("transfer")}>
              <ArrowLeftRight size={16} aria-hidden /> Transfer
            </Button>
            <Button variant="secondary" onClick={() => onStatus("ignored")}>
              <EyeOff size={16} aria-hidden /> Ignore
            </Button>
          </div>
        )}

        {txn.Direction === "credit" && txn.RefundOfID == null && (
          <Button variant="secondary" className="w-full" onClick={onLinkRefund}>
            <Link2 size={16} aria-hidden /> Link the purchase this refunds
          </Button>
        )}
        {txn.RefundOfID != null && (
          <Button variant="secondary" className="w-full" onClick={onUnlinkRefund}>
            <Link2Off size={16} aria-hidden /> Unlink refund
          </Button>
        )}

        {archived ? (
          <Button variant="secondary" className="w-full" onClick={onRestore}>
            <ArchiveRestore size={16} aria-hidden /> Restore
          </Button>
        ) : (
          <Button variant="ghost" className="w-full" onClick={onArchive}>
            <Archive size={16} aria-hidden /> Archive
          </Button>
        )}
      </div>
    </Dialog>
  );
}
