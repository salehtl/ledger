import type { TrendPoint } from "./insights";

export type NetSign = "pos" | "neg" | "zero";

/** Geometry for one month-column of the in-vs-out chart. */
export interface FlowColumn {
  period: string;
  label: string;
  income: number;
  spent: number;
  /** income − spent, in fils. */
  net: number;
  netSign: NetSign;
  /**
   * Net as a signed −100..100 share of the *largest absolute net* across the
   * series — its own amplified scale, not the gross one. This drives the net lane
   * so the balance trajectory swings legibly even when net is small next to gross
   * flows (the common case).
   */
  netLanePct: number;
}

/**
 * Project trend points onto chart columns. The net lane uses its own scale
 * (see `netLanePct`); the bars themselves are laid out by the dither
 * `BarChart` from `flowRows` below, on its own shared scale.
 */
export function flowColumns(points: TrendPoint[]): FlowColumn[] {
  const nets = points.map((p) => p.income - p.spent);
  const maxAbsNet = Math.max(0, ...nets.map(Math.abs));
  return points.map((p, i) => {
    const net = nets[i];
    const netSign: NetSign = net > 0 ? "pos" : net < 0 ? "neg" : "zero";
    const netLanePct = maxAbsNet <= 0 ? 0 : Math.max(-100, Math.min(100, (net / maxAbsNet) * 100));
    return {
      period: p.period,
      label: p.label,
      income: p.income,
      spent: p.spent,
      net,
      netSign,
      netLanePct,
    };
  });
}

/**
 * Chart rows for the dithered bars. Spending is negated so a `stacked` bar
 * chart splits it below the zero axis — d3's stack layout puts negative values
 * under the baseline, which is exactly the in-above / out-below shape this
 * chart has always had. `|| 0` keeps a zero month off negative zero.
 */
export function flowRows(cols: FlowColumn[]): { period: string; label: string; income: number; spent: number }[] {
  return cols.map((c) => ({
    period: c.period,
    label: c.label,
    income: c.income,
    spent: -c.spent || 0,
  }));
}

/** One decimal, trailing ".0" dropped. */
function trim(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * Signed compact AED for the small net labels: "+820", "−140", "+1.2k", "+1.5m".
 * Zero renders unsigned. Input is int64 fils (AED × 100). Uses a true minus sign
 * (−) to match the chart's typography.
 */
export function compactFils(fils: number): string {
  const aed = fils / 100;
  const sign = aed > 0 ? "+" : aed < 0 ? "−" : "";
  const n = Math.abs(aed);
  let body: string;
  if (n < 1000) body = String(Math.round(n));
  else if (n < 1_000_000) body = `${trim(n / 1000)}k`;
  else body = `${trim(n / 1_000_000)}m`;
  return sign + body;
}
