import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../EmptyState";
import { Skeleton } from "../Skeleton";
import { AlertTriangle } from "../ui/PixelIcon";
import { ProjectionTxnRow } from "../transactions/ProjectionTxnRow";
import { formatMinor } from "../../lib/minorMoney";
import type { DrillTarget, InsightsSource } from "../../v2/sources/insights";
import { useInsightsDrill } from "../../v2/queries";

/** How many rows the sheet lists. Beyond this it says so rather than pretending. */
export const DRILL_LIMIT = 100;

/**
 * The transactions behind one breakdown row, read from the local projection.
 *
 * # Why this is a second sheet and not a widened `DrillDownSheet`
 *
 * v1's is typed on `api/types`' `Txn` — every amount a `number` of fils — and
 * carries edit controls that post to `/api/transactions/:id`. Both are wrong
 * here: mapping a projection `Txn` into that type means a `Number()` on money,
 * and `ledgerd` serves no such route.
 *
 * # Why the total comes from the source and not from the rows
 *
 * Summing the listed rows was the first cut and it was **wrong twice**, in the
 * same units and directly under the figure it contradicted:
 *
 *   - a merchant drill went through `TxnFilters.query`, which is a `LIKE`, so
 *     "CARREFOUR" also listed "CARREFOUR MARKET" and the subtotal came out
 *     larger than the row that was tapped;
 *   - a listed *split* transaction contributed its whole `amount_home_minor`,
 *     though only one of its parts belongs to this category.
 *
 * `InsightsSource.drill` answers with the sum of the matching **parts**, over
 * the same CTE the breakdown totals come from, so the figure below the row is
 * the figure on the row by construction. The list can still be capped and a
 * split's own printed amount is still the whole transaction — both are stated
 * in words rather than silently folded into a number.
 */
export function ProjectionDrillSheet({ target, period, currency, source, onClose }: {
  target: DrillTarget;
  /** `YYYY-MM` — the month the breakdown was computed over. */
  period: string;
  /** The home currency the totals are in, or `""` when the log has not set one. */
  currency: string;
  source: InsightsSource | null;
  onClose: () => void;
}) {
  const page = useInsightsDrill(source, period, target, DRILL_LIMIT);
  const d = page.data;

  return (
    <Dialog title={target.name} onClose={onClose}>
      {source === null ? (
        <EmptyState
          icon={AlertTriangle}
          title="Your local ledger isn't open"
          hint="This list reads the copy of your ledger on this device."
        />
      ) : page.isPending ? (
        <Skeleton rows={4} />
      ) : page.isError || d === undefined ? (
        <EmptyState icon={AlertTriangle} title="Couldn't read your ledger" />
      ) : d.rows.length === 0 ? (
        <EmptyState title="Nothing here this month" />
      ) : (
        <>
          <p className="text-sm tnum">
            {currency ? `${currency} ` : ""}
            {formatMinor(d.total)}
          </p>
          <p className="text-xs text-muted">
            {d.truncated
              ? `${d.matches} transactions · showing the ${d.rows.length} most recent`
              : `${d.matches} transaction${d.matches === 1 ? "" : "s"}`}
          </p>
          {d.hasSplit && (
            <p className="mt-1 text-xs text-muted">
              Some of these are split. Each row shows the whole transaction; the total above counts only the parts in
              this group.
            </p>
          )}
          <ul className="mt-2 divide-y divide-border">
            {d.rows.map((t) => (
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
