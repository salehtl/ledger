import { Money } from "../../components/Money";
import { formatFils } from "../../lib/money";
import { monthColumn, pctLabel, type YoYRow, type YoYSummary } from "../../lib/reports";

function monthYear(period: string): string {
  const c = monthColumn(period);
  return `${c.mon} ${c.yr}`;
}

/**
 * Year-over-year spending compare: the trailing 12 months, each paired with
 * the same calendar month a year earlier. Two horizontal dithered bars per
 * month — this year in ink, the year before in low-emphasis ink — separated
 * on lightness (the axis that survives colour-blindness), on one shared scale
 * so magnitude comparison is pure length. Months whose prior year predates
 * the data show "no record" honestly rather than a fake zero bar.
 *
 * Every row drills to that month's transactions. Comparison math lives in
 * lib/reports.ts (yoyRows/yoySummary).
 */
export function TrendCompare({ rows, summary, onDrillMonth }: {
  rows: YoYRow[];
  summary: YoYSummary;
  onDrillMonth: (period: string) => void;
}) {
  const max = Math.max(...rows.flatMap((r) => [r.cur, r.prev ?? 0]), 1);
  const w = (v: number) => `${Math.max((v / max) * 100, v > 0 ? 1.5 : 0)}%`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-base font-semibold">
          <Money fils={summary.curTotal} />
        </span>
        <span className="font-mono text-[10px] tracking-[0.04em] text-muted tnum shrink-0">
          {summary.comparableMonths > 0
            ? `${pctLabel(summary.pct)} vs year before`
            : "no prior year on record"}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-muted">
        spent, last 12 months
        {summary.comparableMonths > 0 && summary.comparableMonths < 12 &&
          ` · ${summary.comparableMonths} of 12 months comparable`}
      </p>

      <div className="mt-3 flex items-center gap-4 font-mono text-[10px] tracking-[0.04em] text-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-[var(--radius)] dither-mask bg-fg" /> this year
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-[var(--radius)] dither-mask bg-muted" /> year before
        </span>
      </div>

      <ul className="mt-2 divide-y divide-border">
        {rows.map((r) => (
          <li key={r.period}>
            <button
              type="button"
              onClick={() => onDrillMonth(r.period)}
              aria-label={`${monthYear(r.period)}: spent ${formatFils(r.cur)}, year before ${r.prev === null ? "no record" : formatFils(r.prev)}`}
              className="flex min-h-11 w-full items-center gap-3 py-1.5 press"
            >
              <span className="w-14 shrink-0 text-left font-mono text-[10px] tracking-[0.04em] text-muted tnum">
                {monthYear(r.period)}
              </span>
              <span className="flex-1 space-y-0.5" aria-hidden>
                <span className="block h-[5px] overflow-hidden rounded-[var(--radius)] bg-surface-2">
                  <span className="block h-full dither-mask bg-fg" style={{ width: w(r.cur) }} />
                </span>
                <span className="block h-[5px] overflow-hidden rounded-[var(--radius)] bg-surface-2">
                  {r.prev !== null && (
                    <span className="block h-full dither-mask bg-muted" style={{ width: w(r.prev) }} />
                  )}
                </span>
              </span>
              <span className="w-20 shrink-0 text-right">
                <span className="block tnum text-xs">
                  <Money fils={r.cur} />
                </span>
                <span className="block font-mono text-[10px] tracking-[0.04em] text-muted tnum">
                  {r.prev === null ? "no record" : pctLabel(r.pct)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
