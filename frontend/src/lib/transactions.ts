import type { Txn } from "../api/types";

/**
 * Inclusive query bounds for a "YYYY-MM" month, matching the backend filter
 * `posted_at >= from AND posted_at <= to`. posted_at is stored as an RFC3339
 * timestamp, so the upper bound uses day "32": it sorts after every real
 * day+time in the month (e.g. "...-31T23:59:59Z") yet before the next month,
 * which an inclusive end-of-month date string would not (it would drop the
 * 31st's timestamped rows).
 */
export function monthRange(period: string): { from: string; to: string } {
  return { from: `${period}-01`, to: `${period}-32` };
}

export interface TxnTotals {
  count: number;
  spentFils: number;
}

/** Count plus total spend (sum of debit amounts) across the given rows. */
export function txnTotals(rows: Txn[]): TxnTotals {
  let spentFils = 0;
  for (const t of rows) {
    if (t.Direction === "debit") spentFils += t.AmountFils;
  }
  return { count: rows.length, spentFils };
}

export interface TxnFilters {
  buckets: string[];
  categoryIds: number[];
  directions: string[];
  sources: string[];
}

export const EMPTY_FILTERS: TxnFilters = { buckets: [], categoryIds: [], directions: [], sources: [] };

/** Total number of selected values across every dimension. */
export function filtersActive(f: TxnFilters): number {
  return f.buckets.length + f.categoryIds.length + f.directions.length + f.sources.length;
}

/** OR within a dimension, AND across dimensions. Empty dimensions are skipped. */
export function applyTxnFilters(rows: Txn[], f: TxnFilters): Txn[] {
  return rows.filter((t) => {
    if (f.buckets.length && !f.buckets.includes(t.Bucket)) return false;
    if (f.directions.length && !f.directions.includes(t.Direction)) return false;
    if (f.categoryIds.length && (t.CategoryID === null || !f.categoryIds.includes(t.CategoryID))) return false;
    if (f.sources.length && !f.sources.includes(t.Source)) return false;
    return true;
  });
}

const SOURCE_LABEL: Record<string, string> = {
  email: "Email", import: "Import", import_derived: "Import Derived",
  manual: "Manual", ai: "AI", ai_confirmed: "AI", heuristic: "Heuristic",
  dib: "DIB", enbd: "ENBD", rule: "Rule",
};

/** Friendly label for a transaction source string; prettifies unknown values. */
export function sourceLabel(s: string): string {
  if (SOURCE_LABEL[s]) return SOURCE_LABEL[s];
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
