// frontend/src/components/transactions/TransactionRow.tsx
import type { Txn } from "../../api/types";
import { flowAmount, aedFils, nativeAmountTag } from "../../lib/money";
import { Pill } from "../ui/Pill";
import { statusLabel, statusTone, shortDate } from "../../lib/format";
import { bucketColor } from "../../lib/insights";
import { projectColor } from "../../lib/paletteColor";

/**
 * One calm transaction line: merchant + amount on top, category · date beneath.
 * Foreign-currency and rate-missing notes sit by the amount (they annotate it),
 * and a status pill shows only when a row still wants attention (review) or is
 * put away (archived) — confirmed rows stay quiet. The whole row is the tap
 * target that opens the detail sheet; quick actions live on swipe.
 */
export function TransactionRow({ txn, onOpen, projectsById }: {
  txn: Txn;
  onOpen: (t: Txn) => void;
  /** Optional: active project lookup for the subtle row chip. Callers that
   *  don't pass it (drill-downs, search, project screens) simply show no chip. */
  projectsById?: Record<number, { name: string; color: string }>;
}) {
  const aed = aedFils(txn);
  const native = nativeAmountTag(txn);
  const noRate = aed === null;
  const project = txn.ProjectID != null ? projectsById?.[txn.ProjectID] : undefined;
  const amount = flowAmount(txn.Direction, aed ?? txn.AmountFils);
  const showStatus = txn.Status === "needs_review" || txn.Status === "archived";
  const meta = [txn.CategoryName || "Uncategorized", shortDate(txn.PostedAt), txn.RefundOfID ? "refund" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={() => onOpen(txn)}
      aria-label={`Open ${txn.MerchantRaw || "transaction"}`}
      className="w-full text-left flex items-center gap-3 py-3 press"
    >
      <span
        aria-hidden
        className="w-1 self-stretch rounded-[var(--radius)] shrink-0"
        style={{ background: txn.Bucket ? bucketColor(txn.Bucket) : "var(--color-border)" }}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm font-medium tracking-[-0.01em]">{txn.MerchantRaw || "—"}</p>
          <span
            className="tnum font-medium shrink-0"
            style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
            title={amount.flow === "in" ? "Money in" : "Money out"}
          >
            {amount.text}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 min-w-0">
            <p className="font-mono text-[10px] tracking-[0.04em] text-muted truncate">{meta}</p>
            {project && (
              <span className="inline-flex items-center gap-1 text-xs text-muted shrink-0">
                {/* A ring, not a fill: this row also carries a solid bucket dot, and the
                    two share a palette. Form keeps them apart at identical hue. */}
                <span aria-hidden className="w-1.5 h-1.5 rounded-[var(--radius)] shrink-0 border" style={{ borderColor: projectColor(project.color) }} />
                <span className="truncate max-w-24">{project.name}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {native && <span className="tnum text-xs text-muted">{native}</span>}
            {noRate && <Pill>no AED rate</Pill>}
            {showStatus && <Pill tone={statusTone(txn.Status)}>{statusLabel(txn.Status)}</Pill>}
          </div>
        </div>
      </div>
    </button>
  );
}
