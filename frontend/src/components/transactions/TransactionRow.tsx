// frontend/src/components/transactions/TransactionRow.tsx
import { useState } from "react";
import type { Txn } from "../../api/types";
import { flowAmount, aedFils, nativeAmountTag } from "../../lib/money";
import { Pill } from "../ui/Pill";
import { statusLabel, statusTone, shortDate } from "../../lib/format";
import { bucketColor } from "../../lib/insights";
import { ColorSwatch } from "../ui/ColorSwatch";
import { displayMerchant, isSplitTxn, splitLabel, type SplitCategoryInfo, type TxnDepth } from "../../lib/txSplit";
import { SplitLines } from "./SplitLines";
import { ChevronDown, ChevronRight } from "../ui/PixelIcon";

/**
 * One calm transaction line: merchant + amount on top, category · date beneath.
 * Foreign-currency and rate-missing notes sit by the amount (they annotate it),
 * and a status pill shows only when a row still wants attention (review) or is
 * put away (archived) — confirmed rows stay quiet. The whole row is the tap
 * target that opens the detail sheet; quick actions live on swipe.
 * Split parents print their lines' categories in the meta and carry a separate
 * expander strip that unfolds the line stack in place — the row tap still
 * opens the detail sheet.
 */
export function TransactionRow({ txn, onOpen, projectsById, splitCategories }: {
  txn: Txn;
  onOpen: (t: Txn) => void;
  /** Optional: active project lookup for the subtle row chip. Callers that
   *  don't pass it (drill-downs, search, project screens) simply show no chip. */
  projectsById?: Record<number, { name: string; color: string }>;
  /** Optional: category lookup for split-line names/dots. Callers that don't
   *  pass it still get the expandable stack, with a part count for the label. */
  splitCategories?: Record<number, SplitCategoryInfo>;
}) {
  const depth = txn as TxnDepth;
  const split = isSplitTxn(depth);
  const [expanded, setExpanded] = useState(false);
  const aed = aedFils(txn);
  const native = nativeAmountTag(txn);
  const noRate = aed === null;
  const project = txn.ProjectID != null ? projectsById?.[txn.ProjectID] : undefined;
  const amount = flowAmount(txn.Direction, aed ?? txn.AmountFils);
  const showStatus = txn.Status === "needs_review" || txn.Status === "archived";
  const merchant = displayMerchant(depth);
  const splitNames = splitCategories
    ? Object.fromEntries(Object.entries(splitCategories).map(([id, c]) => [id, c.name]))
    : undefined;
  const category = split
    ? `Split · ${splitLabel(depth.Splits!, splitNames)}`
    : txn.CategoryName || "Uncategorized";
  const meta = [category, shortDate(txn.PostedAt), txn.RefundOfID ? "refund" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen(txn)}
        aria-label={`Open ${merchant || "transaction"}`}
        className="w-full text-left flex items-center gap-3 py-3 press"
      >
        <span
          aria-hidden
          className="w-1 self-stretch rounded-[var(--radius)] shrink-0"
          style={{ background: txn.Bucket ? bucketColor(txn.Bucket) : "var(--color-border)" }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <p className="line-clamp-2 break-words text-sm font-medium leading-5 tracking-[-0.01em]" title={merchant || undefined}>{merchant || "—"}</p>
            {/* With no FX rate there is no AED figure to show. Printing the
                native amount here read as AED — a GBP 45.00 charge appeared in
                the AED column as 45.00, understating it by a factor of five.
                The native tag and the "no AED rate" pill below carry the truth. */}
            <span
              className={`tnum font-medium leading-5 shrink-0 ${noRate ? "text-muted" : ""}`}
              style={!noRate && amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
              title={noRate ? "No AED rate for this currency" : amount.flow === "in" ? "Money in" : "Money out"}
            >
              {noRate ? "—" : amount.text}
            </span>
          </div>
          {/* Wraps rather than clips. On a needs-review row at 320px — and on
              an FX row even at 390px — the pills squeezed this line until the
              date fell off the end entirely, which is the one thing on it the
              user can't reconstruct from anywhere else. */}
          <div className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <p className="font-mono text-[10px] tracking-[0.04em] text-muted truncate">{meta}</p>
              {project && (
                <span className="inline-flex items-center gap-1 text-xs text-muted shrink-0">
                  {/* Hatched, not a fill: this row also carries a solid bucket dot, and
                      the two share a palette. Form keeps them apart at identical hue. */}
                  <ColorSwatch color={project.color} size="sm" />
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

      {split && (
        <div className="pl-4 pb-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            className="min-h-9 -ml-1.5 px-1.5 inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.04em] text-muted press rounded-[var(--radius)]"
          >
            {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            {expanded
              ? "Hide parts"
              : `Show ${depth.Splits!.length} part${depth.Splits!.length === 1 ? "" : "s"}`}
          </button>
          {expanded && (
            <SplitLines splits={depth.Splits!} currency={txn.Currency} categories={splitCategories} />
          )}
        </div>
      )}
    </div>
  );
}
