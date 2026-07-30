import type { Category } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Money } from "../../components/Money";
import { cadenceLabel, provenanceLine, scheduleName } from "../../lib/recurring";
import { shortDate } from "../../lib/format";
import type { Schedule } from "./api";

/**
 * Detector proposals as confirm/dismiss triage cards — the Review deck's
 * spirit at list pace. Each card carries its evidence: the provenance line
 * ("seen 6× every ~30 days at 39.00") is the tap target that opens the mined
 * transactions, so a confirm is never a leap of faith (P8).
 *
 * Red stays rationed: Confirm is a tonal secondary — the screen has one
 * primary action (the Fab) and a stack of cards must not become a stack of
 * vermilion plates.
 */
export function DetectedCards({ proposals, categories, onConfirm, onDismiss, onShowMatches, busyId }: {
  proposals: Schedule[];
  categories: Category[];
  onConfirm: (s: Schedule) => void;
  onDismiss: (s: Schedule) => void;
  onShowMatches: (s: Schedule) => void;
  /** Schedule id with an in-flight action; its buttons disable. */
  busyId?: number | null;
}) {
  const categoryName = (id: number | null) =>
    id == null ? null : categories.find((c) => c.ID === id)?.Name ?? null;

  return (
    <div className="space-y-3">
      {proposals.map((s) => {
        const meta = [
          s.direction === "credit" ? "income" : null,
          categoryName(s.category_id),
          cadenceLabel(s.interval_days),
          `next ${shortDate(s.next_due)}`,
        ].filter(Boolean).join(" · ");
        const busy = busyId === s.id;
        return (
          <Card key={s.id} className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium tracking-[-0.01em] truncate">{scheduleName(s)}</p>
              <span className="tnum text-sm font-medium shrink-0"><Money fils={s.amount_fils} /></span>
            </div>
            <p className="font-mono text-[10px] tracking-[0.04em] text-muted">{meta}</p>
            {s.provenance && (
              <button
                type="button"
                onClick={() => onShowMatches(s)}
                className="press w-full min-h-11 -my-1 flex items-center justify-between gap-2 text-left"
              >
                <span className="font-mono text-[11px] tracking-[0.04em] text-fg tnum">
                  {provenanceLine(s.provenance, s.amount_fils)}
                  {s.provenance.price_stepped ? " · price stepped" : ""}
                </span>
                <span aria-hidden className="text-muted">›</span>
              </button>
            )}
            <div className="flex gap-2 pt-1">
              <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => onConfirm(s)}>
                Track this bill
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => onDismiss(s)}>
                Dismiss
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
