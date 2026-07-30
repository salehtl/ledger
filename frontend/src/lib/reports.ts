import type { MonthlyTotal, Txn } from "../api/types";
import { aedFils } from "./money";
import { monthLabel } from "./insights";

// ---------------------------------------------------------------------------
// Wire types — docs/v3/api-contract.md §5 (new v3 endpoints are snake_case).
// Piece-local until the integration piece folds them into api/types.ts.
// ---------------------------------------------------------------------------

export interface NetWorthPoint {
  month: string; // "YYYY-MM"
  budget_fils: number;
  tracking_fils: number;
  networth_fils: number;
}
export interface NetWorthResponse { months: NetWorthPoint[]; }

export interface IncomeExpenseRow {
  category_id: number;
  name: string;
  kind: "income" | "spending";
  by_month_fils: number[]; // index-aligned with months
  total_fils: number;
  avg_fils: number;
}
export interface IncomeExpenseResponse {
  months: string[];
  rows: IncomeExpenseRow[];
  net_by_month_fils: number[];
}

export interface AgeOfMoney { age_days: number; sample_size: number; }

/** Split line as it rides on `GET /api/transactions` items (Go-name keys). */
export interface TxnSplitLine {
  ID: number;
  TransactionID: number;
  CategoryID: number;
  AmountFils: number;
  Note?: string;
}
/** A list transaction possibly carrying v3 split lines. */
export type ReportTxn = Txn & { Splits?: TxnSplitLine[] };

// ---------------------------------------------------------------------------
// Line/area geometry (net-worth chart + sparklines)
// ---------------------------------------------------------------------------

export interface LinePt { x: number; y: number; }

/**
 * Normalize a series into 0–100 viewbox coordinates, y inverted (0 = top).
 * `pad` keeps the line off the box edges so the stroke never clips. A flat
 * series draws at mid-height rather than dividing by a zero range; a single
 * point sits centered.
 */
export function linePoints(values: number[], pad = 8): LinePt[] {
  const n = values.length;
  if (n === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const usable = 100 - pad * 2;
  return values.map((v, i) => ({
    x: n === 1 ? 50 : (i / (n - 1)) * 100,
    y: range === 0 ? 50 : pad + (1 - (v - min) / range) * usable,
  }));
}

/** SVG polyline `points` attribute for a normalized series. */
export function polylinePoints(pts: LinePt[]): string {
  return pts.map((p) => `${p.x},${p.y}`).join(" ");
}

/**
 * CSS `polygon()` fraction list closing a line down to the bottom edge —
 * feeds `clip-path` on the dithered area fill under the net-worth line.
 */
export function areaPolygon(pts: LinePt[]): string {
  if (pts.length === 0) return "polygon(0% 100%, 100% 100%)";
  const line = pts.map((p) => `${p.x}% ${p.y}%`).join(", ");
  return `polygon(${pts[0].x}% 100%, ${line}, ${pts[pts.length - 1].x}% 100%)`;
}

/** Nearest series index for a horizontal fraction (0..1) across n points. */
export function nearestIndex(fracX: number, n: number): number {
  if (n <= 1) return 0;
  const i = Math.round(fracX * (n - 1));
  return Math.min(n - 1, Math.max(0, i));
}

export interface DeltaSummary { latest: number; delta: number; pct: number | null; }

/** Latest value and its change vs the previous point (pct null off zero). */
export function deltaSummary(values: number[]): DeltaSummary {
  if (values.length === 0) return { latest: 0, delta: 0, pct: null };
  const latest = values[values.length - 1];
  if (values.length === 1) return { latest, delta: 0, pct: null };
  const prev = values[values.length - 2];
  const delta = latest - prev;
  return { latest, delta, pct: prev !== 0 ? delta / Math.abs(prev) : null };
}

/** True when every month of the series carries no balance at all. */
export function isFlatZero(series: NetWorthPoint[]): boolean {
  return series.every((p) => p.budget_fils === 0 && p.tracking_fils === 0 && p.networth_fils === 0);
}

/**
 * Indices to label under a dense line chart: first, last, and up to
 * `maxLabels − 2` evenly spread between, deduplicated and sorted.
 */
export function axisIndices(n: number, maxLabels = 4): number[] {
  if (n <= 0) return [];
  if (n <= maxLabels) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>([0, n - 1]);
  const inner = maxLabels - 2;
  for (let k = 1; k <= inner; k++) out.add(Math.round((k * (n - 1)) / (inner + 1)));
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Income v expense matrix helpers
// ---------------------------------------------------------------------------

/** Split ordered matrix rows into their income / spending blocks. */
export function matrixBlocks(rows: IncomeExpenseRow[]): {
  income: IncomeExpenseRow[];
  spending: IncomeExpenseRow[];
} {
  return {
    income: rows.filter((r) => r.kind === "income"),
    spending: rows.filter((r) => r.kind !== "income"),
  };
}

/** Two-line column header for a "YYYY-MM" month: { mon: "May", yr: "’26" }. */
export function monthColumn(month: string): { mon: string; yr: string } {
  return { mon: monthLabel(month), yr: `’${month.slice(2, 4)}` };
}

/** Total and integer average of the per-month net row. */
export function netTotals(netByMonth: number[]): { total: number; avg: number } {
  const total = netByMonth.reduce((s, v) => s + v, 0);
  return { total, avg: netByMonth.length > 0 ? Math.trunc(total / netByMonth.length) : 0 };
}

/**
 * Whether a transaction belongs to a category for drill-down purposes.
 * Split parents carry `CategoryID: null` — their lines hold the categories,
 * so a matching split line claims the parent row.
 */
export function txnMatchesCategory(t: ReportTxn, categoryId: number): boolean {
  if (t.CategoryID === categoryId) return true;
  return (t.Splits ?? []).some((s) => s.CategoryID === categoryId);
}

/** The transactions behind one matrix cell: category × "YYYY-MM" month. */
export function cellTxns(txns: ReportTxn[], categoryId: number, month: string): ReportTxn[] {
  return txns.filter((t) => t.PostedAt.slice(0, 7) === month && txnMatchesCategory(t, categoryId));
}

/** All of a month's transactions (net-worth / trend drill). */
export function monthTxns(txns: ReportTxn[], month: string): ReportTxn[] {
  return txns.filter((t) => t.PostedAt.slice(0, 7) === month);
}

// ---------------------------------------------------------------------------
// Age of money — client mirror of internal/budget/age.go's FIFO, over the
// same cashflow definition (confirmed income-kind credits fill a dated pool,
// confirmed spending debits drain it oldest-first). Powers the tile's
// sparkline and the "spends behind this" drill; the headline number itself
// stays the server's.
// ---------------------------------------------------------------------------

export interface SpendAge { id: number; date: string; ageDays: number; }

const AGE_SAMPLE = 10;

function wholeDaysBetween(a: string, b: string): number {
  const day = (s: string) => Date.UTC(
    Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  const d = Math.round((day(b) - day(a)) / 86_400_000);
  return Math.max(d, 0);
}

/**
 * FIFO ages for the last ≤10 funded spends, oldest first. Mirrors the server:
 * a spend that draws anything from the pool is "funded" and its age is the
 * days from the lot covering its final available fil; spends hitting an empty
 * pool are skipped, not aged at zero. Foreign rows with no AED value are
 * skipped (they contribute nothing server-side either).
 */
export function fifoSpendAges(txns: ReportTxn[]): SpendAge[] {
  const flows = txns
    .filter((t) => t.Status === "confirmed")
    .filter((t) =>
      (t.Kind === "income" && t.Direction === "credit") ||
      (t.Kind === "spending" && t.Direction === "debit"))
    .map((t) => ({ t, amt: aedFils(t) }))
    .filter((f): f is { t: ReportTxn; amt: number } => f.amt !== null && f.amt > 0)
    .sort((a, b) => a.t.PostedAt.localeCompare(b.t.PostedAt) || a.t.ID - b.t.ID);

  const pool: { at: string; remaining: number }[] = [];
  const ages: SpendAge[] = [];
  for (const { t, amt } of flows) {
    if (t.Kind === "income") {
      pool.push({ at: t.PostedAt, remaining: amt });
      continue;
    }
    let remaining = amt;
    let funded = false;
    let lastLotAt = "";
    while (remaining > 0 && pool.length > 0) {
      const lot = pool[0];
      const take = Math.min(lot.remaining, remaining);
      lot.remaining -= take;
      remaining -= take;
      funded = true;
      lastLotAt = lot.at;
      if (lot.remaining === 0) pool.shift();
    }
    if (!funded) continue;
    ages.push({ id: t.ID, date: t.PostedAt, ageDays: wholeDaysBetween(lastLotAt, t.PostedAt) });
    if (ages.length > AGE_SAMPLE) ages.shift();
  }
  return ages;
}

// ---------------------------------------------------------------------------
// 24-month trend → year-over-year compare
// ---------------------------------------------------------------------------

export interface YoYRow {
  /** Calendar-month label, e.g. "Aug". */
  label: string;
  /** This-year period "YYYY-MM". */
  period: string;
  /** Same calendar month one year earlier. */
  prevPeriod: string;
  cur: number;
  /** null = the prior year predates the data entirely (unknown, not zero). */
  prev: number | null;
  delta: number | null;
  pct: number | null;
}

function shiftYear(period: string, delta: number): string {
  return `${Number(period.slice(0, 4)) + delta}${period.slice(4)}`;
}

/**
 * The trailing 12 months (ending at `now`, oldest first), each paired with
 * the same calendar month a year earlier. Months absent from `trend` count 0
 * inside the data's own span; prior-year months before the earliest data
 * month are null — "no record" must not render as a real zero.
 */
export function yoyRows(trend: MonthlyTotal[], now: string): YoYRow[] {
  const spent = new Map(trend.map((t) => [t.period, t.spent]));
  const dataStart = trend.reduce<string | null>(
    (min, t) => (min === null || t.period < min ? t.period : min), null);
  const out: YoYRow[] = [];
  for (let i = 11; i >= 0; i--) {
    const [y, m] = now.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const prevPeriod = shiftYear(period, -1);
    const cur = spent.get(period) ?? 0;
    const prevKnown = dataStart !== null && prevPeriod >= dataStart;
    const prev = prevKnown ? (spent.get(prevPeriod) ?? 0) : null;
    out.push({
      label: monthLabel(period),
      period,
      prevPeriod,
      cur,
      prev,
      delta: prev === null ? null : cur - prev,
      pct: prev === null || prev === 0 ? null : (cur - prev) / prev,
    });
  }
  return out;
}

export interface YoYSummary {
  curTotal: number;
  prevTotal: number;
  delta: number;
  pct: number | null;
  /** How many of the 12 months have a comparable prior-year figure. */
  comparableMonths: number;
}

/** Year totals across only the months where both years are known. */
export function yoySummary(rows: YoYRow[]): YoYSummary {
  let curTotal = 0, prevTotal = 0, comparable = 0;
  for (const r of rows) {
    if (r.prev === null) continue;
    curTotal += r.cur;
    prevTotal += r.prev;
    comparable++;
  }
  return {
    curTotal,
    prevTotal,
    delta: curTotal - prevTotal,
    pct: prevTotal !== 0 ? (curTotal - prevTotal) / prevTotal : null,
    comparableMonths: comparable,
  };
}

/** Signed percent label: "+6%", "−12%", "0%"; "—" when not computable. */
export function pctLabel(pct: number | null): string {
  if (pct === null) return "—";
  const rounded = Math.round(pct * 100);
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)}%`;
}
