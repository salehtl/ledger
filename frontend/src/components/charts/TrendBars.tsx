import type { TrendPoint } from "../../lib/insights";
import { trendRows, activeIndex } from "../../lib/trendBars";
import { formatFils } from "../../lib/money";
import { BarChart } from "../dither-kit/bar-chart";
import { Bar } from "../dither-kit/bar";
import { Tooltip } from "../dither-kit/tooltip";
import { useDitherTheme } from "../../hooks/useDitherTheme";

/**
 * Monthly spending, as dithered bars. dither-kit colors per *series*, not per
 * *bar*, so the active month is marked with the chart's crosshair
 * (`markerIndex`) and a bolded label rather than a differently-colored bar.
 */
export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  const dark = useDitherTheme();
  const rows = trendRows(points);
  if (rows.length === 0) return null;

  const summary = rows.map((r) => `${r.label}: ${formatFils(r.spent)}`).join("; ");

  return (
    <div role="img" aria-label={`Monthly spending trend. ${summary}`}>
      {/* `key` on the theme forces a canvas repaint when the OS theme flips —
          the dither is painted in raw RGB and can't inherit a CSS var. */}
      <div className="h-32" key={dark ? "dark" : "light"}>
        <BarChart
          data={rows}
          config={{ spent: { label: "Spent", color: "grey" } }}
          bloom="aura"
          markerIndex={activeIndex(points, activePeriod)}
          margins={{ left: 8, right: 8, bottom: 4, top: 8 }}
        >
          <Bar dataKey="spent" variant="gradient" />
          <Tooltip labelKey="label" valueFormatter={(v) => formatFils(v)} />
        </BarChart>
      </div>

      {/* Month labels stay our own markup: dither-kit's <XAxis> can't carry the
          active-month emphasis, and this keeps the type scale consistent. */}
      <div className="mt-1 flex gap-1.5">
        {rows.map((r) => (
          <div
            key={r.period}
            className={`min-w-0 flex-1 truncate text-center text-[11px] ${
              r.period === activePeriod ? "font-medium text-fg" : "text-muted"
            }`}
          >
            {r.label}
          </div>
        ))}
      </div>
    </div>
  );
}
