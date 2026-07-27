import type { TrendPoint } from "../../lib/insights";
import { trendRows, activeIndex, bandCenters } from "../../lib/trendBars";
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
  const centers = bandCenters(rows.length);

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
          // Left/right stay zero so the plot area equals this container's
          // full width — buildBandScale's own paddingOuter already gives
          // the bars edge breathing room. The label row below (with no
          // margins of its own) reads the exact same band-center fractions
          // via lib/trendBars.ts's bandCenters(), so labels can't drift out
          // from under their bars the way non-zero margins would cause.
          margins={{ left: 0, right: 0, bottom: 4, top: 8 }}
        >
          <Bar dataKey="spent" variant="gradient" />
          <Tooltip labelKey="label" valueFormatter={(v) => formatFils(v)} />
        </BarChart>
      </div>

      {/* Month labels stay our own markup: dither-kit's <XAxis> can't carry
          the active-month emphasis, and this keeps the type scale consistent
          with the rest of the app. Absolutely positioned at the bars'
          fractional band centers (bandCenters) rather than a flex row — an
          equal-width flex row doesn't line up with d3's padded band scale. */}
      <div className="relative mt-1 h-4">
        {rows.map((r, i) => (
          <div
            key={r.period}
            data-testid={`trend-label-${r.period}`}
            style={{ left: `${centers[i].center * 100}%`, width: `${centers[i].width * 100}%` }}
            className={`absolute top-0 -translate-x-1/2 truncate text-center text-[11px] ${
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
