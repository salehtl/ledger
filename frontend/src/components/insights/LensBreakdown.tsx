import { ChevronRight } from "lucide-react";
import type { BreakdownRow } from "../../lib/lens";
import { Card } from "../ui/Card";
import { Money } from "../Money";
import { EmptyState } from "../EmptyState";
import { DeltaBadge } from "./DeltaBadge";

// A ranked, drillable bar list for the selected analysis lens. Each row is a
// magnitude bar (scaled to the largest row) plus its amount, share, and any
// month-over-month change; tapping a row opens the transactions behind it.
export function LensBreakdown({ rows, onDrill, emptyLabel = "No spending this month" }: {
  rows: BreakdownRow[];
  onDrill: (row: BreakdownRow) => void;
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <Card><EmptyState title={emptyLabel} /></Card>;
  const max = Math.max(...rows.map((r) => r.spent), 1);

  return (
    <Card className="!p-0">
      <ul className="divide-y divide-border px-4">
        {rows.map((r) => (
          <li key={r.key}>
            <button
              aria-label={`See transactions for ${r.name}`}
              className="w-full py-3 text-left"
              onClick={() => onDrill(r)}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{r.name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {r.delta !== undefined && (
                    <DeltaBadge delta={r.delta} deltaPct={r.deltaPct ?? null} isNew={r.isNew} isGone={r.isGone} />
                  )}
                  <span className="text-xs text-muted tnum">{Math.round(r.share * 100)}%</span>
                  <span className="tnum font-medium"><Money fils={r.spent} /></span>
                  <ChevronRight size={16} className="text-muted shrink-0" aria-hidden />
                </span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-surface-2 overflow-hidden" aria-hidden>
                <div className="h-full rounded-full" style={{ width: `${(r.spent / max) * 100}%`, background: r.color }} />
              </div>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted px-4 py-2.5">Tap a row to see its transactions.</p>
    </Card>
  );
}
