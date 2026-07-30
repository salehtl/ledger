import { Money } from "../../components/Money";
import { Card } from "../../components/ui/Card";
import { Skeleton } from "../../components/Skeleton";
import { nextUpcoming, nextUpcomingLabel } from "../../lib/envelope";
import { deltaSummary, isFlatZero } from "../../lib/reports";
import { formatFils } from "../../lib/money";
import { useEnvelopes, useNetWorth, useUpcoming } from "../../api/hooks";

/**
 * Home's widget-equivalent pocket surface: three glanceable rows — Ready to
 * Assign (→ Plan), the most pressing upcoming bill (→ Recurring), and net
 * worth with its month delta (→ Reports). Always three rows on the current
 * month so nothing shifts as queries land; absent data states its absence.
 */
export function PocketStrip({ onOpenPlan, onOpenRecurring, onOpenReports, month }: {
  month: string;
  onOpenPlan?: () => void;
  onOpenRecurring?: () => void;
  onOpenReports?: () => void;
}) {
  const envelopes = useEnvelopes(month);
  const upcoming = useUpcoming();
  const networth = useNetWorth(2);

  // isPending, not isLoading: the persisted-cache restore window leaves
  // queries pending-but-not-fetching where isLoading lies.
  if (envelopes.isPending || upcoming.isPending || networth.isPending) {
    return (
      <Card className="!p-0 px-4 py-1.5">
        <Skeleton rows={3} />
      </Card>
    );
  }

  const rta = envelopes.data?.ready_to_assign_fils;
  const bill = nextUpcoming(upcoming.data?.items ?? []);
  const series = networth.data?.months ?? [];
  const worth = isFlatZero(series) ? null : deltaSummary(series.map((m) => m.networth_fils));

  const row = "w-full min-h-11 py-2 flex items-center justify-between gap-3 text-left press";
  const label = "text-sm font-medium shrink-0";
  // No `shrink-0` here: the bill row puts a merchant label through this style,
  // and a real one ("DEWA utility bill — Dubai Electricity & Water Authority")
  // is far wider than the row. Left unshrinkable it pushed straight off the
  // card and out of the viewport, cut mid-word. Values that must never shrink
  // (the money figures) say so at the point of use instead.
  const meta = "font-mono text-[10px] tracking-[0.04em] text-muted tnum";

  return (
    <Card className="!p-0 px-4">
      <div className="divide-y divide-border">
        <button type="button" className={row} onClick={onOpenPlan} aria-label="Open Plan">
          <span className={label}>Ready to assign</span>
          {rta === undefined ? (
            <span className={`${meta} shrink-0`}>unavailable</span>
          ) : (
            <span className="tnum font-medium shrink-0"><Money fils={rta} /></span>
          )}
        </button>
        <button type="button" className={row} onClick={onOpenRecurring} aria-label="Open Recurring">
          <span className={label}>Next bill</span>
          {bill === null ? (
            <span className={`${meta} shrink-0`}>none due in {upcoming.data?.days ?? 14}d</span>
          ) : (
            <span className={`${meta} !text-fg min-w-0 truncate`} data-missed={bill.missed || undefined}>
              {nextUpcomingLabel(bill)} · {formatFils(bill.amount_fils)}
            </span>
          )}
        </button>
        <button type="button" className={row} onClick={onOpenReports} aria-label="Open Reports">
          <span className={label}>Net worth</span>
          {worth === null ? (
            <span className={`${meta} shrink-0`}>check in to track</span>
          ) : (
            <span className="flex items-baseline gap-2 min-w-0">
              <span className={`${meta} min-w-0 truncate`}>
                {worth.delta === 0 ? "flat" : `${worth.delta > 0 ? "+" : "−"}${formatFils(Math.abs(worth.delta))}`} this month
              </span>
              <span className="tnum font-medium shrink-0"><Money fils={worth.latest} /></span>
            </span>
          )}
        </button>
      </div>
    </Card>
  );
}
