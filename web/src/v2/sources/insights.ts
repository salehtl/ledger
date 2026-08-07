/**
 * The Insights read, over the local projection.
 *
 * Framework-free and over a `SqlDriver`, exactly like `sources/budget.ts` and
 * `sources/transactions.ts`: no React, no network, `bigint` money, and a
 * `usable` flag that mirrors {@link projectionIsUsable} so a half-written
 * projection is never summed and presented as fact.
 *
 * # Everything here is an aggregate, which is why nothing here is a `number`
 *
 * The projection stores amounts as TEXT because a JS `number` cannot hold an
 * `int64` (`client/src/replay/projection.ts`). A *list* screen can get away
 * with sloppiness for a while — one row is small. A screen that SUMS cannot:
 * every total, delta and month here is a `bigint` from the SQL cast to the
 * rendered string, and the only `number`s that exist are ratios (`deltaPct`,
 * `savingsRate`) and row counts, both derived by dividing in `bigint` first and
 * letting the bounded result cross into a float.
 *
 * # The category→bucket mapping is not a second copy
 *
 * It is {@link DEFAULT_BUDGET_MAPPING}, the same table the 50/30/20 read uses,
 * so a category cannot be a "need" on Home and a "want" here. `"unassigned"` is
 * a fourth bucket rather than a silently-dropped remainder: dropping it would
 * make the shares on this screen sum to less than the money that left, which is
 * the failure mode the Home screen names out loud.
 *
 * # What this source deliberately cannot answer
 *
 * There is no target, envelope, plan or run-rate in it, because there is no op
 * that authors one — `client/src/replay/state.ts` holds `txns`, `rules`,
 * `homeCurrency`, `rates`, `forks` and `anomalies`. So no "over budget" flag, no
 * pace, no projection to month-end. There is no account or balance either, so
 * no net worth. See `screens/Insights.tsx` for the panels that came out.
 */

import { decodeTxnRow, projectionIsUsable, readMeta, TXN_COLUMNS } from "@ledger/client/replay/projection";
import type { Txn } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";

import { monthLabel } from "../../lib/insights";
import { CONFIRMED, DEFAULT_BUDGET_MAPPING, type BudgetBucket, type BudgetMapping } from "./budget";
import { readSplits } from "./transactions";

/** The three rule buckets, plus the remainder that has no category yet. */
export type InsightsBucket = BudgetBucket | "unassigned";

/** A month-over-month comparison of one slice of spending. */
export interface SpendDelta {
  /** Stable identity for React and for the drill-in. */
  key: string;
  name: string;
  spent: bigint;
  prevSpent: bigint;
  /** `spent − prevSpent`. */
  delta: bigint;
  /** `delta / prevSpent`, or `null` when there is nothing to be a fraction of. */
  deltaPct: number | null;
  isNew: boolean;
  isGone: boolean;
}

export interface BucketDelta extends SpendDelta {
  bucket: InsightsBucket;
}

export interface CategoryDelta extends SpendDelta {
  /** The projection's own category string; `null` is "uncategorized". */
  category: string | null;
  bucket: InsightsBucket;
}

export interface MerchantTotal {
  merchant: string;
  spent: bigint;
  /** Rows, not money — a `number` is correct here and nowhere else. */
  count: number;
}

export interface TrendMonth {
  period: string;
  label: string;
  spent: bigint;
  income: bigint;
}

/**
 * When `usable` is false every figure below is a safe zero/empty placeholder,
 * never a real partial total — and the screen must not print one as a headline,
 * for the reason `screens/Home.tsx` records.
 */
export interface InsightsSnapshot {
  usable: boolean;
  homeCurrency: string | null;
  period: string;
  /** Confirmed debits in `period`, converted to the home currency. */
  spent: bigint;
  /** Confirmed credits in `period`. */
  income: bigint;
  net: bigint;
  savingsRate: number | null;
  /** Whether the previous month has anything to compare against. */
  hasPrevious: boolean;
  buckets: BucketDelta[];
  categories: CategoryDelta[];
  merchants: MerchantTotal[];
  trend: TrendMonth[];
}

/** What a breakdown row drills into. `name` is display only. */
export type DrillTarget =
  | { type: "bucket"; bucket: InsightsBucket; name: string }
  | { type: "category"; category: string | null; name: string }
  | { type: "merchant"; merchant: string; name: string };

/**
 * The transactions behind one breakdown row.
 *
 * # Why this lives here and not behind `TxnFilters`
 *
 * The first cut of the drill-in reused `sqlTxnSource.list`, and it printed a
 * subtotal that could contradict the row directly above it, two ways:
 *
 *   - `TxnFilters.query` is a `merchant_raw LIKE '%…%'`, but the breakdown
 *     groups by the *exact* `merchant_raw`. Drilling "CARREFOUR" listed
 *     "CARREFOUR MARKET" too, and the subtotal came out LARGER than the row.
 *   - `TxnFilters.categories` matches `txn.category`, but the breakdown sums
 *     `txn_split` parts through the `PARTS` CTE. A split transaction was
 *     invisible to the filter, and any that did appear contributed its whole
 *     `amount_home_minor` rather than the part in this category.
 *
 * Both are the same mistake — asking a second query the question the first one
 * already answered. So the drill runs over the very same `PARTS` CTE the totals
 * come from: {@link DrillPage.total} is the sum of the *matching parts* and is
 * therefore equal to the row's own figure, by construction rather than by
 * coincidence.
 */
export interface DrillPage {
  /** The matching transactions, newest first, capped at the requested limit. */
  rows: Txn[];
  /** Matching transactions in the month, BEFORE the cap. */
  matches: number;
  /**
   * Exact sum of the matching parts across the whole month — the same `bigint`
   * the breakdown row shows, capped list or not.
   */
  total: bigint;
  /** True when `rows` is shorter than `matches`. */
  truncated: boolean;
  /**
   * At least one listed row is split, so its printed amount is the whole
   * transaction while {@link DrillPage.total} counts only the part in this
   * group. The sheet has to say so; the two figures are both right and they do
   * not add up.
   */
  hasSplit: boolean;
}

export interface InsightsSource {
  /**
   * `period` is `"YYYY-MM"`; `trendPeriods` is the ordered list the flow chart
   * plots. The clock is the caller's — nothing in here reads `Date`, so the
   * same projection and the same arguments always give the same answer.
   */
  read(period: string, trendPeriods: readonly string[]): InsightsSnapshot;
  /** The transactions behind one breakdown row. See {@link DrillPage}. */
  drill(period: string, target: DrillTarget, limit: number): DrillPage;
}

const UNCATEGORIZED = "Uncategorized";

/**
 * The parts of a transaction that count, one row per split part and one per
 * unsplit transaction — the same CTE `sources/budget.ts` sums, plus the two
 * columns this screen slices by.
 */
const PARTS = `WITH parts AS (
    SELECT id AS txn_id, direction, category, amount_home_minor AS home, substr(posted_at,1,7) AS period, posted_at, merchant_raw
      FROM txn
     WHERE ${CONFIRMED} AND amount_home_minor IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM txn_split s WHERE s.txn_id=txn.id)
    UNION ALL
    SELECT t.id AS txn_id, t.direction, s.category, s.amount_home_minor AS home, substr(t.posted_at,1,7) AS period, t.posted_at, t.merchant_raw
      FROM txn t JOIN txn_split s ON s.txn_id=t.id
     WHERE t.${CONFIRMED} AND s.amount_home_minor IS NOT NULL
  )`;

/**
 * A grouped total as exact decimal TEXT.
 *
 * sql.js hands an INTEGER back as a JS `number`, which loses precision past
 * 2^53, so every SUM is CAST to TEXT and this refuses anything that did not
 * arrive that way rather than quietly rounding.
 */
function exact(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
    throw new Error(`insights ${field} is not exact decimal text`);
  }
  return BigInt(value);
}

/**
 * `num / den` as a float, divided in `bigint` first.
 *
 * The division happens at six decimal places in exact integer arithmetic and
 * only the bounded quotient crosses into a double, so no money value is ever
 * held in a float — the ratio is, and a ratio is not money.
 */
function ratio(num: bigint, den: bigint): number | null {
  if (den === 0n) return null;
  return Number((num * 1_000_000n) / den) / 1_000_000;
}

function delta(key: string, name: string, spent: bigint, prevSpent: bigint): SpendDelta {
  const d = spent - prevSpent;
  return {
    key,
    name,
    spent,
    prevSpent,
    delta: d,
    deltaPct: prevSpent === 0n ? null : ratio(d, prevSpent),
    isNew: prevSpent === 0n && spent > 0n,
    isGone: spent === 0n && prevSpent > 0n,
  };
}

function bucketOf(mapping: BudgetMapping, category: string | null): InsightsBucket {
  if (category === null) return "unassigned";
  return mapping.categories[category.toLowerCase()] ?? mapping.fallback ?? "unassigned";
}

function unusable(period: string, homeCurrency: string | null): InsightsSnapshot {
  return {
    usable: false,
    homeCurrency,
    period,
    spent: 0n,
    income: 0n,
    net: 0n,
    savingsRate: null,
    hasPrevious: false,
    buckets: [],
    categories: [],
    merchants: [],
    trend: [],
  };
}

/** The previous `YYYY-MM`, computed arithmetically — no `Date`, no timezone. */
export function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return period;
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

const BUCKET_ORDER: InsightsBucket[] = ["need", "want", "saving", "unassigned"];

/**
 * The predicate that selects exactly the parts one breakdown row is made of.
 *
 * Every arm matches the way the totals were grouped and no other way: an equal
 * on `merchant_raw` (never a `LIKE` — see {@link DrillPage}), an equal or
 * `IS NULL` on the part's own `category`, and for a bucket the set of category
 * names the mapping puts in it. `"unassigned"` is the complement: no category,
 * or one the mapping does not name — the same `ELSE` arm the totals fold into.
 */
function drillPredicate(mapping: BudgetMapping, target: DrillTarget): { sql: string; args: unknown[] } {
  if (target.type === "merchant") return { sql: "merchant_raw = ?", args: [target.merchant] };
  if (target.type === "category") {
    return target.category === null
      ? { sql: "category IS NULL", args: [] }
      : { sql: "category = ?", args: [target.category] };
  }
  const known = Object.keys(mapping.categories);
  if (target.bucket === "unassigned") {
    // `mapping.fallback` sends unmapped categories to a real bucket when it is
    // set, and then nothing is left over; honour it rather than listing rows
    // the totals put somewhere else.
    if (mapping.fallback !== null) return { sql: "category IS NULL", args: [] };
    if (known.length === 0) return { sql: "1=1", args: [] };
    return {
      sql: `(category IS NULL OR lower(category) NOT IN (${known.map(() => "?").join(",")}))`,
      args: known,
    };
  }
  const mine = known.filter((c) => mapping.categories[c] === target.bucket);
  const arms: string[] = [];
  const args: unknown[] = [];
  if (mine.length > 0) {
    arms.push(`lower(category) IN (${mine.map(() => "?").join(",")})`);
    args.push(...mine);
  }
  if (mapping.fallback === target.bucket && known.length > 0) {
    arms.push(`(category IS NOT NULL AND lower(category) NOT IN (${known.map(() => "?").join(",")}))`);
    args.push(...known);
  }
  return arms.length === 0 ? { sql: "1=0", args: [] } : { sql: `(${arms.join(" OR ")})`, args };
}

export function sqlInsightsSource(db: SqlDriver, mapping: BudgetMapping = DEFAULT_BUDGET_MAPPING): InsightsSource {
  return {
    read(period, trendPeriods) {
      const meta = readMeta(db);
      if (meta === null || !projectionIsUsable(db)) return unusable(period, meta?.homeCurrency ?? null);
      const prev = previousPeriod(period);

      // --- categories, this month against last -----------------------------
      const catRows = db
        .prepare(
          `${PARTS}
  SELECT period, direction, category, CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total
    FROM parts WHERE period IN (?, ?) GROUP BY period, direction, category`,
        )
        .all(period, prev) as Record<string, unknown>[];

      const cur = new Map<string | null, bigint>();
      const was = new Map<string | null, bigint>();
      let spent = 0n;
      let income = 0n;
      let hasPrevious = false;
      for (const row of catRows) {
        const total = exact(row, "total");
        const inPeriod = row["period"] === period;
        if (!inPeriod) hasPrevious = true;
        if (row["direction"] === "credit") {
          if (inPeriod) income += total;
          continue;
        }
        const category = row["category"] === null || row["category"] === undefined ? null : String(row["category"]);
        const into = inPeriod ? cur : was;
        into.set(category, (into.get(category) ?? 0n) + total);
        if (inPeriod) spent += total;
      }

      const categories: CategoryDelta[] = [...new Set([...cur.keys(), ...was.keys()])]
        .map((category) => ({
          ...delta(
            category === null ? " uncategorized" : `cat:${category}`,
            category ?? UNCATEGORIZED,
            cur.get(category) ?? 0n,
            was.get(category) ?? 0n,
          ),
          category,
          bucket: bucketOf(mapping, category),
        }))
        .sort((a, b) => (b.spent === a.spent ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : b.spent > a.spent ? 1 : -1));

      // --- buckets, folded from the same rows so the two cannot disagree ----
      const buckets: BucketDelta[] = BUCKET_ORDER.map((bucket) => {
        const mine = categories.filter((c) => c.bucket === bucket);
        const sum = (pick: (c: CategoryDelta) => bigint) => mine.reduce((s, c) => s + pick(c), 0n);
        return {
          ...delta(bucket, bucket, sum((c) => c.spent), sum((c) => c.prevSpent)),
          bucket,
        };
      });

      // --- merchants, this month only (there is no prior-month comparison) --
      const merchants = (
        db
          .prepare(
            `${PARTS}
  SELECT merchant_raw, CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total, COUNT(*) AS n
    FROM parts WHERE period = ? AND direction = 'debit' GROUP BY merchant_raw`,
          )
          .all(period) as Record<string, unknown>[]
      )
        .map((row) => ({
          merchant: String(row["merchant_raw"] ?? ""),
          spent: exact(row, "total"),
          count: Number(row["n"] ?? 0),
        }))
        .sort((a, b) => (b.spent === a.spent ? (a.merchant < b.merchant ? -1 : 1) : b.spent > a.spent ? 1 : -1));

      // --- the trailing flow chart -----------------------------------------
      const trend: TrendMonth[] = [];
      if (trendPeriods.length > 0) {
        const placeholders = trendPeriods.map(() => "?").join(",");
        const flowRows = db
          .prepare(
            `${PARTS}
  SELECT period, direction, CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total
    FROM parts WHERE period IN (${placeholders}) GROUP BY period, direction`,
          )
          .all(...trendPeriods) as Record<string, unknown>[];
        const flow = new Map<string, { spent: bigint; income: bigint }>();
        for (const row of flowRows) {
          const p = String(row["period"]);
          const cell = flow.get(p) ?? { spent: 0n, income: 0n };
          if (row["direction"] === "credit") cell.income += exact(row, "total");
          else cell.spent += exact(row, "total");
          flow.set(p, cell);
        }
        for (const p of trendPeriods) {
          const cell = flow.get(p) ?? { spent: 0n, income: 0n };
          trend.push({ period: p, label: monthLabel(p), spent: cell.spent, income: cell.income });
        }
      }

      return {
        usable: true,
        homeCurrency: meta.homeCurrency,
        period,
        spent,
        income,
        net: income - spent,
        savingsRate: income > 0n ? ratio(income - spent, income) : null,
        hasPrevious,
        buckets,
        categories,
        merchants,
        trend,
      };
    },

    drill(period, target, limit) {
      const empty: DrillPage = { rows: [], matches: 0, total: 0n, truncated: false, hasSplit: false };
      if (readMeta(db) === null || !projectionIsUsable(db)) return empty;

      // Spending only, like the breakdown it came from: a credit is income
      // context there and would be a row here that belongs to no bar.
      const where = drillPredicate(mapping, target);
      const scope = `WHERE period = ? AND direction = 'debit' AND ${where.sql}`;
      const args = [period, ...where.args];

      const totals = db
        .prepare(
          `${PARTS}
  SELECT CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total, COUNT(DISTINCT txn_id) AS matches FROM parts ${scope}`,
        )
        .all(...args)[0] as Record<string, unknown>;
      const matches = Number(totals["matches"] ?? 0);
      if (matches === 0) return empty;

      const picked = (
        db
          .prepare(
            `${PARTS}
  SELECT txn_id, MAX(posted_at) AS posted_at FROM parts ${scope}
   GROUP BY txn_id ORDER BY posted_at DESC, txn_id DESC LIMIT ?`,
          )
          .all(...args, limit) as Record<string, unknown>[]
      ).map((r) => String(r["txn_id"]));

      // Hydrated the same way `listTransactions` does — same columns, same
      // decoder, same split attachment — so a row looks identical wherever the
      // user meets it.
      const splits = readSplits(db, picked);
      const raw = db
        .prepare(`SELECT ${TXN_COLUMNS} FROM txn WHERE id IN (${picked.map(() => "?").join(",")})`)
        .all(...picked) as Record<string, unknown>[];
      const byID = new Map(raw.map((r) => [String(r["id"]), r]));
      const rows: Txn[] = [];
      for (const id of picked) {
        const row = byID.get(id);
        if (row !== undefined) rows.push(decodeTxnRow(row, splits.get(id) ?? []));
      }

      return {
        rows,
        matches,
        total: exact(totals, "total"),
        truncated: matches > rows.length,
        hasSplit: rows.some((t) => t.splits.length > 0),
      };
    },
  };
}
