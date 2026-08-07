import { ChevronRight } from "../ui/PixelIcon";
import { share, type BreakdownRow } from "../../lib/lens";
import { Card } from "../ui/Card";
import { EmptyState } from "../EmptyState";
import { DeltaBadge } from "./DeltaBadge";
import { DitherFill } from "../charts/DitherFill";
import { formatMinor } from "../../lib/minorMoney";

/** Geometry resolution for the bars: `DitherFill` lays out in percent. */
const BAR_UNITS = 10_000;

/**
 * A ranked, drillable bar list for the selected analysis lens. Each row is a
 * magnitude bar (scaled to the largest row) plus its amount, share, and any
 * month-over-month change; tapping a row opens the transactions behind it.
 *
 * Money is `bigint` throughout. The only `number`s that reach `DitherFill` are
 * the bar's *geometry* — a row's spend as a share of the largest row, computed
 * by dividing in `bigint` and scaling the bounded quotient. `DitherFill` is
 * `aria-hidden` and lays out in percent, so no amount is ever read from it.
 */
export function LensBreakdown({ rows, onDrill, emptyLabel = "No spending this month" }: {
  rows: BreakdownRow[];
  onDrill: (row: BreakdownRow) => void;
  emptyLabel?: string;
}) {
  if (rows.length === 0) return <Card><EmptyState title={emptyLabel} /></Card>;
  const max = rows.reduce((m, r) => (r.spent > m ? r.spent : m), 1n);

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
                  <span className="tnum font-medium">{formatMinor(r.spent)}</span>
                  <ChevronRight size={16} className="text-muted shrink-0" aria-hidden />
                </span>
              </div>
              <div className="mt-1.5">
                <DitherFill
                  segments={[{ value: share(r.spent, max) * BAR_UNITS, color: r.ditherColor, density: r.density }]}
                  max={BAR_UNITS}
                  height={10}
                />
              </div>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted px-4 py-2.5">Tap a row to see its transactions.</p>
    </Card>
  );
}
