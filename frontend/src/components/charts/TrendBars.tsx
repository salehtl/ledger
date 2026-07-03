import type { TrendPoint } from "../../lib/insights";
import { barHeightPct } from "../../lib/trendBars";

export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  const max = Math.max(0, ...points.map((p) => p.spent));
  return (
    <div className="h-32 flex items-stretch gap-1.5 pt-2" role="img" aria-label="Monthly spending trend">
      {points.map((p) => (
        <div key={p.period} className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="relative flex-1">
            <div
              data-testid={`trend-bar-${p.period}`}
              className={`absolute inset-x-0 bottom-0 rounded-t ${
                p.period === activePeriod ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-2)]"
              }`}
              style={{ height: `${barHeightPct(p.spent, max)}%` }}
            />
          </div>
          <div className="truncate text-center text-[11px] text-[var(--color-muted)]">{p.label}</div>
        </div>
      ))}
    </div>
  );
}
