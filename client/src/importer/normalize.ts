import type { RawRow } from "./csv";
import { parseAmount, parseImportDate, validateMap, type ImportMap } from "./map";

export interface NormalizedImportRow { rowIndex: number; postedAt: string; merchantRaw: string; amountMinor: bigint; currency: string; direction: "debit" | "credit"; category: string | null }
export type NormalizeResult = { ok: true; row: NormalizedImportRow } | { ok: false; rowIndex: number; error: string };

export function normalizeRow(raw: RawRow, map: ImportMap, rowIndex: number): NormalizeResult {
  const configErrors = validateMap(map); if (configErrors.length) return { ok: false, rowIndex, error: configErrors.join(" ") };
  try {
    const date = (raw[map.columns.date] ?? "").trim(); if (!date) throw new Error(`date column ${JSON.stringify(map.columns.date)} is empty`);
    const merchantRaw = (raw[map.columns.description] ?? "").trim(); if (!merchantRaw) throw new Error(`description column ${JSON.stringify(map.columns.description)} is empty`);
    const amount = parseAmount(raw, map);
    if (map.skipZeroAmounts && amount.amountMinor === 0n) throw new Error("zero amount skipped");
    const sourceCategory = map.columns.category ? (raw[map.columns.category] ?? "").trim() : "";
    return { ok: true, row: { rowIndex, postedAt: parseImportDate(date, map.dateFormat), merchantRaw, ...amount, currency: map.currency, category: sourceCategory === "" ? null : map.categories?.[sourceCategory] ?? sourceCategory } };
  } catch (error) { return { ok: false, rowIndex, error: error instanceof Error ? error.message : String(error) }; }
}

export function normalizeRows(rows: readonly RawRow[], map: ImportMap): NormalizeResult[] { return rows.map((row, i) => normalizeRow(row, map, i + 1)); }
