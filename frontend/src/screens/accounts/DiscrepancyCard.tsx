import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Money } from "../../components/Money";
import { shortDate } from "../../lib/format";
import {
  adjustLabel,
  cashHint,
  checkinMeta,
  discrepancyCauses,
  fxHint,
  verdictTitle,
  type CheckinResult,
} from "../../lib/reconcile";

/**
 * The mismatch report after a check-in: the delta, then candidate causes in
 * concreteness order — retained emails that produced no transaction (nothing
 * is ever silently dropped, so a gap can point at its receipts), foreign rows
 * awaiting an FX rate, and the cash/ATM gap. One tap writes the delta off as
 * an adjustment transaction; one opens manual entry prefilled with the
 * account when the user knows what the missing transaction was; "Keep for
 * now" leaves it — the stated balance is already the new anchor either way.
 */
export function DiscrepancyCard({ result, onAdjust, adjustPending = false, onAddTransaction, onKeep }: {
  result: CheckinResult;
  onAdjust: () => void;
  adjustPending?: boolean;
  /** Third route: open manual entry attributed to this account. */
  onAddTransaction?: () => void;
  onKeep: () => void;
}) {
  const causes = discrepancyCauses(result);
  return (
    <div className="space-y-4" data-discrepancy={result.delta_fils < 0 ? "less" : "more"}>
      <div>
        <p className="text-base font-semibold">{verdictTitle(result)}</p>
        <p className="mt-1.5 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{checkinMeta(result)}</p>
        <p className="mt-2 text-xl leading-none font-semibold tracking-[-0.02em] tnum">
          <Money fils={result.delta_fils} />
        </p>
      </div>

      <div>
        <SectionLabel as="h3">Likely causes</SectionLabel>
        <Card className="!p-0 mt-2">
          <ul className="divide-y divide-border">
            {causes.map((c) => {
              if (c.kind === "unparsed") {
                return c.emails.map((e) => (
                  <li key={`u-${e.id}`} data-cause="unparsed" className="px-4 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate text-sm font-medium leading-5">{e.subject || "(no subject)"}</p>
                      <span className="shrink-0 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
                        {shortDate(e.received_at)}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] tracking-[0.04em] text-muted truncate">
                      email arrived, no transaction · {e.from_addr}
                      {e.parse_error ? ` · ${e.parse_error}` : ""}
                    </p>
                  </li>
                ));
              }
              if (c.kind === "fx") {
                return (
                  <li key="fx" data-cause="fx" className="px-4 py-3">
                    <p className="text-sm font-medium leading-5">Foreign transactions without a rate</p>
                    <p className="mt-1 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{fxHint(c.count)}</p>
                  </li>
                );
              }
              return (
                <li key="cash" data-cause="cash" className="px-4 py-3">
                  <p className="text-sm font-medium leading-5">Cash or ATM movement</p>
                  <p className="mt-1 font-mono text-[10px] tracking-[0.04em] text-muted tnum">{cashHint(result)}</p>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <div className="space-y-2">
        <Button variant="primary" className="w-full" onClick={onAdjust} disabled={adjustPending}>
          {adjustPending ? "Writing…" : adjustLabel(result.delta_fils)}
        </Button>
        {onAddTransaction && (
          <Button variant="ghost" className="w-full" onClick={onAddTransaction}>
            Add the transaction instead
          </Button>
        )}
        <Button variant="ghost" className="w-full" onClick={onKeep}>
          Keep for now
        </Button>
        <p className="text-xs text-muted">
          Your stated balance is saved whichever you pick. An adjustment or an added transaction
          records the gap so reports stay honest; keeping it leaves the gap unexplained.
        </p>
      </div>
    </div>
  );
}
