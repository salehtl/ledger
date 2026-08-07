import { useMemo } from "react";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../EmptyState";
import { Skeleton } from "../Skeleton";
import { AlertTriangle } from "../ui/PixelIcon";
import { ProjectionTxnRow } from "../transactions/ProjectionTxnRow";
import { formatMinor } from "../../lib/minorMoney";
import { monthRange } from "../../lib/transactions";
import type { DrillTarget } from "../../lib/lens";
import type { CategoryDelta } from "../../v2/sources/insights";
import { EMPTY_FILTERS, type TxnFilters, type TxnSource } from "../../v2/sources/transactions";
import { useTxnList } from "../../v2/queries";

const DRILL_LIMIT = 100;

/**
 * The transactions behind one breakdown row, read from the local projection.
 *
 * # Why this is a second sheet and not a widened `DrillDownSheet`
 *
 * v1's is typed on `api/types`' `Txn` — every amount a `number` of fils — and
 * carries edit controls that post to `/api/transactions/:id`. Both are wrong
 * here: mapping a projection `Txn` into that type means a `Number()` on money,
 * and `ledgerd` serves no such route. This one is read-only and reuses
 * `sqlTxnSource`'s own filters rather than re-deriving a query, so a bucket
 * drilled from Insights and the same bucket filtered on the Transactions tab
 * return the same rows by construction.
 *
 * The count and total below come from the page it actually rendered, capped at
 * {@link DRILL_LIMIT} — and the header says so when the cap bites, rather than
 * printing a subtotal that looks like the row's own figure and is not.
 */
export function ProjectionDrillSheet({ target, period, categories, source, onClose }: {
  target: DrillTarget;
  /** `YYYY-MM` — the month the breakdown was computed over. */
  period: string;
  /** The month's categories, used to expand a bucket into the categories in it. */
  categories: readonly CategoryDelta[];
  source: TxnSource | null;
  onClose: () => void;
}) {
  const filters = useMemo<TxnFilters>(() => {
    const { from, to } = monthRange(period);
    const base = { ...EMPTY_FILTERS, from, to, directions: ["debit"] as const };
    if (target.type === "merchant") return { ...base, query: target.merchant };
    if (target.type === "category") return { ...base, categories: [target.category] };
    return { ...base, categories: categories.filter((c) => c.bucket === target.bucket).map((c) => c.category) };
  }, [target, period, categories]);

  const page = useTxnList(source, filters, DRILL_LIMIT);
  const rows = page.data?.rows ?? [];
  const title = target.type === "merchant" ? target.merchant || "—" : target.name;
  const shown = rows.reduce((s, t) => s + (t.amount_home_minor ?? 0n), 0n);

  return (
    <Dialog title={title} onClose={onClose}>
      {source === null ? (
        <EmptyState
          icon={AlertTriangle}
          title="Your local ledger isn't open"
          hint="This list reads the copy of your ledger on this device."
        />
      ) : page.isPending ? (
        <Skeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing here this month" />
      ) : (
        <>
          <p className="text-xs text-muted">
            {rows.length === DRILL_LIMIT
              ? `First ${DRILL_LIMIT} · ${formatMinor(shown)} of them`
              : `${rows.length} transaction${rows.length === 1 ? "" : "s"} · ${formatMinor(shown)}`}
          </p>
          <ul className="divide-y divide-border">
            {rows.map((t) => (
              <li key={t.id}>
                <ProjectionTxnRow txn={t} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
