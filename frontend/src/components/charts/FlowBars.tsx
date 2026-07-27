import { useMemo } from "react";
import type { TrendPoint } from "../../lib/insights";
import { flowColumns, flowRows, compactFils, type NetSign } from "../../lib/flowBars";
import { bandCenters, activeIndex } from "../../lib/trendBars";
import { formatFils } from "../../lib/money";
import { BarChart } from "../dither-kit/bar-chart";
import { Bar } from "../dither-kit/bar";
import { Tooltip } from "../dither-kit/tooltip";
import { useDitherTheme } from "../../hooks/useDitherTheme";

const NET_TEXT: Record<NetSign, string> = {
  pos: "text-[var(--color-good)]",
  neg: "text-[var(--color-bad)]",
  zero: "text-[var(--color-muted)]",
};
const NET_DOT: Record<NetSign, string> = {
  pos: "var(--color-good)",
  neg: "var(--color-bad)",
  zero: "var(--color-muted)",
};

/**
 * Money in vs out over the trailing months. Income rises above a central zero
 * axis, spending drops below it, both on one shared scale so the asymmetry reads
 * as the month's net. A thin net thread (dots + connecting line) traces the
 * running balance — the one emphasized element; the bars stay quiet.
 */
export function FlowBars({ points, activePeriod }: { points: TrendPoint[]; activePeriod?: string }) {
  const cols = useMemo(() => flowColumns(points), [points]);
  const dark = useDitherTheme();
  const rows = useMemo(() => flowRows(cols), [cols]);
  const n = cols.length;
  if (n === 0) return null;

  // Column centers come from the same d3 band scale the BarChart lays its
  // bars out on (lib/trendBars.ts's bandCenters), not evenly-spaced
  // fractions — otherwise the net dots and thread drift off the bars they
  // describe, worst at the first/last month. The net-lane height keeps its
  // own 0–100 coordinate box; only the x axis is shared with the bars.
  const centers = bandCenters(n);
  const cx = (i: number) => centers[i].center * 100;
  // FlowColumn is structurally a TrendPoint (period/label/income/spent) plus
  // net fields, so lib/trendBars.ts's own activeIndex works unchanged —
  // reused rather than re-implementing the lookup, matching TrendBars's
  // markerIndex wiring so the active month gets the same bar-level emphasis.
  const marker = activeIndex(cols, activePeriod);
  const cy = (netLanePct: number) => 50 - netLanePct / 2; // −100..100 → y 100..0
  const threadPts = cols.map((c, i) => `${cx(i)},${cy(c.netLanePct)}`).join(" ");

  const summary = cols
    .map((c) => `${c.label}: in ${formatFils(c.income)}, out ${formatFils(c.spent)}, net ${compactFils(c.net)}`)
    .join("; ");

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-good)" }} aria-hidden /> In
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: "var(--color-fg)", opacity: 0.4 }} aria-hidden /> Out
        </span>
      </div>

      <div
        className="relative h-36"
        role="img"
        aria-label={`Money in vs out over ${n} months. ${summary}`}
      >
        {/* `key` on the theme forces a canvas repaint when the OS theme flips.
            `aria-hidden`: dither-kit hardcodes its own role="img" on the inner
            SVG; without this the wrapper's labelled role="img" above resolves
            to two elements instead of one. */}
        <div className="absolute inset-0" key={dark ? "dark" : "light"} aria-hidden>
          <BarChart
            data={rows}
            stackType="stacked"
            config={{
              income: { label: "In", color: "green" },
              spent: { label: "Out", color: "grey" },
            }}
            bloom="aura"
            markerIndex={marker}
            margins={{ left: 0, right: 0, top: 4, bottom: 4 }}
          >
            <Bar dataKey="income" variant="gradient" />
            <Bar dataKey="spent" variant="gradient" />
            <Tooltip labelKey="label" valueFormatter={(v) => formatFils(Math.abs(v))} />
          </BarChart>
        </div>
      </div>

      {/* Net lane — the signature. Its own amplified scale, so the balance
          trajectory swings even when net is small next to gross flows. The
          dashed midline is break-even: dots above it are surplus, below deficit. */}
      <div className="relative mt-2 h-9" aria-hidden>
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-border" />
        <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points={threadPts} fill="none" stroke="var(--color-fg)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" opacity={0.35} />
        </svg>
        {cols.map((c, i) => (
          <span
            key={c.period}
            data-testid={`net-dot-${c.period}`}
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[var(--color-surface)]"
            style={{ left: `${cx(i)}%`, top: `${cy(c.netLanePct)}%`, background: NET_DOT[c.netSign] }}
          />
        ))}
      </div>

      {/* Labels: signed net figure + month. Absolutely positioned at the bars'
          fractional band centers (bandCenters) rather than an equal-width
          flex row — an equal-width flex row doesn't line up with d3's
          padded band scale. */}
      <div className="relative mt-1.5 h-8">
        {cols.map((c, i) => {
          const active = c.period === activePeriod;
          return (
            <div
              key={c.period}
              style={{ left: `${centers[i].center * 100}%`, width: `${centers[i].width * 100}%` }}
              className="absolute top-0 -translate-x-1/2 text-center"
            >
              <div className={`truncate text-[10px] tnum ${NET_TEXT[c.netSign]}`}>{compactFils(c.net)}</div>
              <div className={`truncate text-[11px] ${active ? "font-medium text-fg" : "text-muted"}`}>{c.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
