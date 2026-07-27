import { useMemo } from "react";
import type { TrendPoint } from "../../lib/insights";
import { trendRows, activeIndex, bandCenters } from "../../lib/trendBars";
import { formatFils } from "../../lib/money";
import { BarChart } from "../dither-kit/bar-chart";
import { Bar } from "../dither-kit/bar";
import { Tooltip } from "../dither-kit/tooltip";
import type { ChartConfig } from "../dither-kit/chart-context";
import { useDitherTheme } from "../../hooks/useDitherTheme";
import { ActiveBandHighlight } from "./ActiveBandHighlight";
import { SCRUB_SURFACE } from "./scrubSurface";

// Module constant: a fresh object literal here would give the chart a new
// `config` identity every render, busting configKeys → bands → the whole
// context value and re-playing the 900ms entrance wave on unrelated updates.
const TREND_CONFIG: ChartConfig = { spent: { label: "Spent", color: "grey" } };

/**
 * Monthly spending, as dithered bars. dither-kit colors per *series*, not per
 * *bar*, so the active month is marked with our own band highlight (see
 * ActiveBandHighlight — dither-kit's `markerIndex` is inert in 0.1.0, see its
 * doc comment) and a bolded label rather than a differently-colored bar.
 */
export function TrendBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  const dark = useDitherTheme();
  // Memoized: `rows` is the chart's `data`, and dither-kit bumps its revision
  // (which restarts the entrance animation) on a `data` *identity* change.
  const rows = useMemo(() => trendRows(points), [points]);
  if (rows.length === 0) return null;

  const summary = rows.map((r) => `${r.label}: ${formatFils(r.spent)}`).join("; ");
  const centers = bandCenters(rows.length);
  const marker = activeIndex(points, activePeriod);

  return (
    // SCRUB_SURFACE: a finger-drag scrubs the detail box instead of starting a
    // text selection. On the outer wrapper so the labels below are covered too.
    <div role="img" aria-label={`Monthly spending trend. ${summary}`} style={SCRUB_SURFACE}>
      {/* `key` on the theme forces a canvas repaint when the OS theme flips —
          the dither is painted in raw RGB and can't inherit a CSS var.
          `relative`: the highlight below is positioned against this box. */}
      <div className="relative h-32" key={dark ? "dark" : "light"}>
        {/* Rendered first — not on a z-index — so DOM order keeps it behind
            the canvas painted by BarChart right after it. */}
        <ActiveBandHighlight n={rows.length} index={marker} />
        {/* `aria-hidden`: dither-kit hardcodes its own role="img" on the inner
            SVG; without this the wrapper's labelled role="img" above resolves
            to two elements instead of one. */}
        <div className="absolute inset-0" aria-hidden>
          <BarChart
            data={rows}
            config={TREND_CONFIG}
            bloom="aura"
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
