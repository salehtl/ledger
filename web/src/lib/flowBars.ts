/**
 * Geometry and labels for the money-in-vs-out chart, over `bigint` minor units.
 *
 * The money is `bigint` because every point is a monthly SUM out of the
 * projection, which stores amounts as TEXT precisely because a JS `number`
 * cannot hold an `int64`. The only `number`s below are *geometry* — the net
 * lane's −100..100 position and the bar values the canvas lays out with — and
 * both are ratios, derived by dividing in `bigint` first. {@link flowRows} says
 * where that boundary is and why crossing it is safe.
 */
import type { TrendMonth } from "../v2/sources/insights";

export type NetSign = "pos" | "neg" | "zero";

/** Geometry for one month-column of the in-vs-out chart. */
export interface FlowColumn {
  period: string;
  label: string;
  income: bigint;
  spent: bigint;
  /** income − spent, in minor units. */
  net: bigint;
  netSign: NetSign;
  /**
   * Net as a signed −100..100 share of the *largest absolute net* across the
   * series — its own amplified scale, not the gross one. This drives the net lane
   * so the balance trajectory swings legibly even when net is small next to gross
   * flows (the common case).
   */
  netLanePct: number;
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Project trend points onto chart columns. The net lane uses its own scale
 * (see `netLanePct`); the bars themselves are laid out by the dither
 * `BarChart` from `flowRows` below, on its own shared scale.
 */
export function flowColumns(points: readonly TrendMonth[]): FlowColumn[] {
  const nets = points.map((p) => p.income - p.spent);
  const maxAbsNet = nets.reduce((m, n) => (abs(n) > m ? abs(n) : m), 0n);
  return points.map((p, i) => {
    const net = nets[i];
    const netSign: NetSign = net > 0n ? "pos" : net < 0n ? "neg" : "zero";
    // Scaled in bigint to four decimal places, so a net past 2^53 still lands
    // on the right pixel; only the bounded −10000..10000 quotient is a double.
    const netLanePct = maxAbsNet <= 0n ? 0 : Number((net * 1_000_000n) / maxAbsNet) / 10_000;
    return { period: p.period, label: p.label, income: p.income, spent: p.spent, net, netSign, netLanePct };
  });
}

/**
 * A type alias, not an interface, and deliberately: dither-kit's `computeBands`
 * takes a `Record<string, number|string>`, and only an anonymous object type
 * gets TypeScript's implicit index signature.
 */
export type FlowRow = {
  period: string;
  label: string;
  income: number;
  spent: number;
};

/**
 * Chart rows for the dithered bars. Spending is negated so a `stacked` bar
 * chart splits it below the zero axis — d3's stack layout puts negative values
 * under the baseline, which is exactly the in-above / out-below shape this
 * chart has always had.
 *
 * **This is the one place money becomes a `number`, and it is geometry, not
 * money.** d3 lays bars out by proportion and paints at pixel resolution, so
 * the only thing at risk in the `Number()` below is sub-pixel placement: past
 * 2^53 the relative error is 2^-53, which is some 12 orders of magnitude finer
 * than a phone screen can show. What must NOT be done is *rendering* one of
 * these — {@link flowExact} maps a value back to its exact `bigint`, and that
 * is what the tooltip formats.
 */
export function flowRows(cols: readonly FlowColumn[]): FlowRow[] {
  return cols.map((c) => ({
    period: c.period,
    label: c.label,
    income: Number(c.income),
    // `|| 0` keeps a zero month off negative zero.
    spent: -Number(c.spent) || 0,
  }));
}

/**
 * Scaled chart value → the exact `bigint` it stands for, so the canvas tooltip
 * prints real money rather than reading it back off the geometry.
 *
 * Two cells that scale to the same `number` share an entry. That can only
 * happen when their ratios round identically, which for the values this chart
 * plots means the two amounts agree to within one part in a million — and the
 * common case, two months with the same total, is exactly right.
 */
export function flowExact(cols: readonly FlowColumn[]): Map<number, bigint> {
  const rows = flowRows(cols);
  const out = new Map<number, bigint>();
  rows.forEach((r, i) => {
    if (!out.has(r.income)) out.set(r.income, cols[i].income);
    if (!out.has(r.spent)) out.set(r.spent, cols[i].spent);
  });
  return out;
}

/** One decimal, trailing ".0" dropped. Input is tenths, as an integer. */
function trim(tenths: bigint): string {
  const whole = tenths / 10n;
  const frac = tenths % 10n;
  return frac === 0n ? whole.toString(10) : `${whole.toString(10)}.${frac.toString(10)}`;
}

/**
 * Signed compact major units for the small net labels: "+820", "−140", "+1.2k",
 * "+1.5m". Zero renders unsigned. Input is `bigint` minor units (major × 100).
 * Uses a true minus sign (−) to match the chart's typography.
 *
 * Rounds half-up in integer arithmetic — no `Math.round`, so a figure past 2^53
 * compacts to the same string a smaller one of the same shape would.
 */
export function compactMinor(minor: bigint): string {
  const sign = minor > 0n ? "+" : minor < 0n ? "−" : "";
  const a = abs(minor);
  let body: string;
  if (a < 100_000n) body = ((a + 50n) / 100n).toString(10);
  else if (a < 100_000_000n) body = `${trim((a + 5_000n) / 10_000n)}k`;
  else body = `${trim((a + 5_000_000n) / 10_000_000n)}m`;
  return sign + body;
}
