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
