import { useMemo } from "react";
import type { TrendPoint } from "../../lib/insights";
import { flowColumns, compactFils, type NetSign } from "../../lib/flowBars";
import { formatFils } from "../../lib/money";

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
  const n = cols.length;
  if (n === 0) return null;

  // Column centers and net-lane height share one 0–100 coordinate box, so the
  // SVG line and the HTML dots line up exactly.
  const cx = (i: number) => ((i + 0.5) / n) * 100;
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

      <div className="relative h-36" role="img" aria-label={`Money in vs out over ${n} months. ${summary}`}>
        {/* Bars: each column splits into equal top (income) and bottom (spending) halves. */}
        <div className="absolute inset-0 flex gap-1.5">
          {cols.map((c) => {
            const active = c.period === activePeriod;
            return (
              <div key={c.period} className={`flex min-w-0 flex-1 flex-col ${active ? "rounded-lg bg-surface-2/40" : ""}`}>
                <div className="relative flex-1">
                  <div
                    data-testid={`flow-in-${c.period}`}
                    className="absolute inset-x-1 bottom-0 rounded-t motion-safe:transition-[height] motion-safe:duration-500"
                    style={{ height: `${c.inPct}%`, background: "var(--color-good)", opacity: active ? 1 : 0.9 }}
                  />
                </div>
                <div className="relative flex-1">
                  <div
                    data-testid={`flow-out-${c.period}`}
                    className="absolute inset-x-1 top-0 rounded-b motion-safe:transition-[height] motion-safe:duration-500"
                    style={{ height: `${c.outPct}%`, background: "var(--color-fg)", opacity: active ? 0.55 : 0.4 }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Zero axis. */}
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" aria-hidden />
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

      {/* Labels: signed net figure + month. */}
      <div className="mt-1.5 flex gap-1.5">
        {cols.map((c) => {
          const active = c.period === activePeriod;
          return (
            <div key={c.period} className="min-w-0 flex-1 text-center">
              <div className={`truncate text-[10px] tnum ${NET_TEXT[c.netSign]}`}>{compactFils(c.net)}</div>
              <div className={`truncate text-[11px] ${active ? "font-medium text-fg" : "text-muted"}`}>{c.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
