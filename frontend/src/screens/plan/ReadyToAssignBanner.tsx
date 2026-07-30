import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { RollingNumber } from "../../components/RollingNumber";
import { formatFils } from "../../lib/money";
import { rtaDisplay, rtaMessage, type EnvelopeSummary } from "../../lib/envelope";

/**
 * The Plan screen's one live number: what's left to assign this month.
 * Red is rationed — the figure goes `text-bad` only when negative
 * (over-assigned); at zero and above it prints in plain ink.
 */
export function ReadyToAssignBanner({ summary, onAutoAssign, autoAssignPending = false }: {
  summary: EnvelopeSummary;
  onAutoAssign: () => void;
  autoAssignPending?: boolean;
}) {
  const rta = summary.ready_to_assign_fils;
  const negative = rta < 0;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {/* The month itself lives in the TopBar's scope stepper — repeating
              it here wrapped the eyebrow to two lines for no new information. */}
          <SectionLabel>Ready to assign</SectionLabel>
          <p
            data-rta={negative ? "negative" : rta === 0 ? "zero" : "positive"}
            className={`mt-1.5 text-2xl leading-none font-semibold tracking-[-0.02em] tnum ${negative ? "text-bad" : ""}`}
          >
            <RollingNumber value={rtaDisplay(rta)} />
          </p>
          <p className="mt-2 font-mono text-[10px] tracking-[0.04em] text-muted tnum">
            income {rtaDisplay(summary.income_fils)} · assigned {rtaDisplay(summary.assigned_fils)}
            {summary.overspend_debt_fils > 0 && <> · overspend {formatFils(summary.overspend_debt_fils)}</>}
          </p>
        </div>
        {rta > 0 && (
          <Button variant="primary" className="shrink-0" onClick={onAutoAssign} disabled={autoAssignPending}>
            {autoAssignPending ? "Assigning…" : "Auto-assign"}
          </Button>
        )}
      </div>
      <p className={`mt-2 text-xs ${negative ? "text-bad" : "text-muted"}`}>{rtaMessage(summary)}</p>
    </Card>
  );
}
