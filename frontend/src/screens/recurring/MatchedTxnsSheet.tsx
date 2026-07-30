import type { Txn } from "../../api/types";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { PixelSpinner } from "../../components/ui/PixelSpinner";
import { Inbox } from "../../components/ui/PixelIcon";
import { shortDate } from "../../lib/format";
import { aedFils, flowAmount } from "../../lib/money";

/**
 * Evidence sheet: the transactions behind a schedule — a detected proposal's
 * mined occurrences, or the single transaction that paid a bill. Read-only on
 * purpose: this is provenance (P8), not an action surface; acting on a
 * transaction stays on the Transactions screen.
 */
export function MatchedTxnsSheet({ title, txnIds, txnsById, loading = false, onClose }: {
  title: string;
  txnIds: number[];
  txnsById: Map<number, Txn> | undefined;
  loading?: boolean;
  onClose: () => void;
}) {
  const rows = txnsById ? txnIds.map((id) => txnsById.get(id)).filter((t): t is Txn => t != null) : [];
  const missing = txnsById ? txnIds.length - rows.length : 0;

  return (
    <Dialog title={title} onClose={onClose}>
      {loading && !txnsById ? (
        <div className="flex justify-center py-8">
          <PixelSpinner role="status" aria-label="Loading matched transactions" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Inbox} title="No matched transactions" hint="The linked transactions are no longer in the register." />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((t) => {
            const amount = flowAmount(t.Direction, aedFils(t) ?? t.AmountFils);
            return (
              <li key={t.ID} className="py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{t.MerchantRaw || "—"}</p>
                  <p className="font-mono text-[10px] tracking-[0.04em] text-muted mt-0.5">
                    {[t.CategoryName || "Uncategorized", shortDate(t.PostedAt)].join(" · ")}
                  </p>
                </div>
                <span
                  className="tnum text-sm font-medium shrink-0"
                  style={amount.flow === "in" ? { color: "var(--color-good)" } : undefined}
                >
                  {amount.text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {missing > 0 && rows.length > 0 && (
        <p className="font-mono text-[10px] tracking-[0.04em] text-muted pt-2">
          {missing} more no longer in the register
        </p>
      )}
    </Dialog>
  );
}
