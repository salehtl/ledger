import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { ensureProjection, projectionIsUsable, readMeta } from "@ledger/client/replay/projection.ts";

export type BudgetBucket = "need" | "want" | "saving";
export interface BudgetMapping { categories: Readonly<Record<string, BudgetBucket>>; fallback: BudgetBucket | null }
export const DEFAULT_BUDGET_MAPPING: BudgetMapping = { categories: { groceries: "need", housing: "need", utilities: "need", transport: "need", healthcare: "need", insurance: "need", dining: "want", entertainment: "want", shopping: "want", travel: "want", savings: "saving", investments: "saving", debt: "saving" }, fallback: null };
/**
 * `usable` mirrors {@link projectionIsUsable} exactly, the way
 * `currencies/source.ts`'s `CurrencyView.usable` does — the two read models
 * must never drift onto separate "is this safe to show" mechanisms. When
 * `false`, every other field is a safe zero/empty placeholder, never a real
 * (and therefore misleading) partial total.
 */
export interface BudgetSnapshot { usable: boolean; homeCurrency: string | null; buckets: Record<BudgetBucket, bigint>; income: bigint; unassigned: bigint; confirmedTransactions: number; historyDays: number; warming: boolean; excluded: { missingHomeRate: number; unparsed: number; unresolvedDuplicates: number; sameDuplicates: number } }
export interface BudgetSource { read(nowMs: number): BudgetSnapshot }

const CONFIRMED = "superseded_by IS NULL AND needs_review=0 AND unparsed=0 AND (possible_duplicate_of IS NULL OR duplicate_disposition='different')";
function mappingSQL(mapping: BudgetMapping): { sql: string; args: unknown[] } { const args: unknown[] = []; const arms = Object.entries(mapping.categories).map(([category, bucket]) => { args.push(category.toLowerCase(), bucket); return "WHEN ? THEN ?"; }); args.push(mapping.fallback); return { sql: `CASE lower(category) ${arms.join(" ")} ELSE ? END`, args }; }
function exact(row: Record<string, unknown>, field: string): bigint { const value = row[field]; if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) throw new Error(`budget ${field} is not exact decimal text`); return BigInt(value); }

function unusable(homeCurrency: string | null): BudgetSnapshot {
  return { usable: false, homeCurrency, buckets: { need: 0n, want: 0n, saving: 0n }, income: 0n, unassigned: 0n, confirmedTransactions: 0, historyDays: 0, warming: false, excluded: { missingHomeRate: 0, unparsed: 0, unresolvedDuplicates: 0, sameDuplicates: 0 } };
}

export function sqlBudgetSource(db: SqlDriver, mapping: BudgetMapping = DEFAULT_BUDGET_MAPPING): BudgetSource {
  ensureProjection(db);
  return { read(nowMs) {
  // The gate `currencies/source.ts:32` already has: a projection written by an
  // older build or left half-written must never be summed and shown as fact.
  // Before Task 21's fix this was survivable because splits were allocated in
  // JS at read time; the fix itself made correctness depend on
  // `txn_split.amount_home_minor` having been written by THIS build, which
  // `ensureProjection`'s migration can leave NULL on an unmigrated device — see
  // the "a pre-v4 database" test in `client/src/replay/projection.test.ts`.
  const meta = readMeta(db);
  if (meta === null || !projectionIsUsable(db)) return unusable(meta?.homeCurrency ?? null);
  const buckets: Record<BudgetBucket, bigint> = { need: 0n, want: 0n, saving: 0n }; let income = 0n; let unassigned = 0n;
  const mapped = mappingSQL(mapping);
  const rows = db.prepare(`WITH parts AS (
    SELECT direction, category, amount_home_minor AS home FROM txn WHERE ${CONFIRMED} AND amount_home_minor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM txn_split s WHERE s.txn_id=txn.id)
    UNION ALL
    SELECT t.direction, s.category, s.amount_home_minor AS home FROM txn t JOIN txn_split s ON s.txn_id=t.id WHERE t.${CONFIRMED} AND s.amount_home_minor IS NOT NULL
  ) SELECT direction, ${mapped.sql} AS bucket, CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total FROM parts GROUP BY direction, bucket`).all(...mapped.args) as Record<string, unknown>[];
  for (const row of rows) { const total = exact(row, "total"); if (row["direction"] === "credit") income += total; else if (row["bucket"] === null) unassigned += total; else buckets[row["bucket"] as BudgetBucket] += total; }
  const stats = db.prepare(`SELECT
    SUM(CASE WHEN unparsed=1 THEN 1 ELSE 0 END) AS unparsed,
    SUM(CASE WHEN unparsed=0 AND needs_review=0 AND amount_home_minor IS NULL THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN possible_duplicate_of IS NOT NULL AND duplicate_disposition IS NULL THEN 1 ELSE 0 END) AS unresolved,
    SUM(CASE WHEN possible_duplicate_of IS NOT NULL AND duplicate_disposition='same' THEN 1 ELSE 0 END) AS same_dup,
    SUM(CASE WHEN ${CONFIRMED} THEN 1 ELSE 0 END) AS confirmed,
    MIN(CASE WHEN ${CONFIRMED} THEN posted_at END) AS earliest FROM txn WHERE superseded_by IS NULL`).all()[0] as Record<string, unknown>;
  const confirmedTransactions = Number(stats["confirmed"] ?? 0); const earliest = stats["earliest"] === null ? null : Date.parse(String(stats["earliest"])); const historyDays = earliest === null || !Number.isFinite(earliest) ? 0 : Math.max(0, Math.floor((nowMs - earliest) / 86_400_000));
  return { usable: true, homeCurrency: meta.homeCurrency, buckets, income, unassigned, confirmedTransactions, historyDays, warming: historyDays < 14 && confirmedTransactions < 10, excluded: { missingHomeRate: Number(stats["missing"] ?? 0), unparsed: Number(stats["unparsed"] ?? 0), unresolvedDuplicates: Number(stats["unresolved"] ?? 0), sameDuplicates: Number(stats["same_dup"] ?? 0) } };
} }; }
