import type { Txn } from "../api/types";
import { dirhamsToFils } from "./format";
import { aedFils } from "./money";

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

/** Count plus actual expenditure across the given rows. Income, transfers, and
 * excluded categories are not spending, even when a transfer arrived as a
 * debit leg. */
export function txnTotals(rows: Txn[]): TxnTotals {
  let spentFils = 0;
  for (const t of rows) {
    if (t.Direction === "debit" && t.Status !== "transfer" && t.Kind !== "excluded") {
      spentFils += aedFils(t) ?? 0;
    }
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

export interface ManualTxnInput {
  merchant: string;
  amountAed: string;
  direction: string;
  date: string; // YYYY-MM-DD
  categoryId: number | null;
}

export interface ManualTxnPayload {
  posted_at: string;
  amount_fils: number;
  currency: string;
  direction: string;
  merchant_raw: string;
  category_id: number;
}

export type BuildResult =
  | { ok: true; payload: ManualTxnPayload }
  | { ok: false; error: string };

/** Validate a manual-entry form and project it onto the POST /api/transactions body. */
export function buildManualTxnPayload(input: ManualTxnInput): BuildResult {
  const merchant = input.merchant.trim();
  if (!merchant) return { ok: false, error: "Enter a merchant or description." };

  const aed = Number(input.amountAed);
  if (!Number.isFinite(aed) || aed <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }
  if (input.direction !== "debit" && input.direction !== "credit") {
    return { ok: false, error: "Choose debit or credit." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return { ok: false, error: "Choose a valid date." };
  }
  return {
    ok: true,
    payload: {
      posted_at: input.date,
      amount_fils: dirhamsToFils(aed),
      currency: "AED",
      direction: input.direction,
      merchant_raw: merchant,
      category_id: input.categoryId ?? 0,
    },
  };
}

/** Two-digit zero-pad for date parts. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Client-side name for a CSV export file, e.g. "ledger-export-2026-07-11.csv".
 * The server sets the same shape in Content-Disposition, but the Web Share path
 * builds a File in the browser and needs its own name.
 */
export function exportFilename(now: Date): string {
  return `ledger-export-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.csv`;
}

/**
 * URL for the CSV export endpoint, carrying the same server-side filters as
 * the list query (status/from/to/q). Client-only chip filters are deliberately
 * not reflected — export mirrors what the server can filter.
 */
export function exportUrl(opts: { status?: string; from?: string; to?: string; q?: string }): string {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  const q = opts.q?.trim();
  if (q) params.set("q", q);
  const qs = params.toString();
  return qs ? `/api/transactions/export?${qs}` : "/api/transactions/export";
}
