/**
 * The 50/30/20 read, over the local projection.
 *
 * A port of `app/src/screens/budget/source.ts` — the same SQL, the same
 * `bigint` totals, the same `usable` gate — with the import paths pointed at
 * the web tree. Framework-free and over a `SqlDriver`, so it is testable
 * without React and without a network.
 *
 * # What is NOT in here, and why the Home screen therefore lost widgets
 *
 * There are no envelopes, no per-bucket targets, no monthly plan and no
 * projection-to-month-end: `client/src/replay/state.ts` has `txns`, `rules`,
 * `homeCurrency`, `rates`, `forks` and `anomalies` and nothing else, so no op
 * in the v2 vocabulary can author a target. v1's Home read those from
 * `/api/summary`, which `ledgerd` does not serve. The bucket percentages are
 * the *rule* (50/30/20), applied by the screen as labels; the money is the sum
 * of what actually happened.
 */

import { ensureProjection, projectionIsUsable, readBudgetSplit, readMeta } from "@ledger/client/replay/projection";
import type { BudgetSplit } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";

import { categoryMapping, readCategoryDefs } from "./categories";

export type BudgetBucket = "need" | "want" | "saving";

export type { BudgetSplit };

/**
 * The rule, and what an account with no `budget_split_set` op reads as.
 *
 * The default lives HERE, in the consumer, and not in the fold: `State.budgetSplit`
 * is `null` until a user chooses, so "never chose" and "chose 50/30/20" stay
 * distinguishable in the log while rendering identically. That is what makes the
 * schema-v3 upgrade a no-op for data.
 */
export const DEFAULT_BUDGET_SPLIT: BudgetSplit = { need: 50, want: 30, saving: 20 };

/**
 * What the three percentages add up to. Exported because a screen has to say it
 * BEFORE the user saves.
 *
 * There is deliberately no `normalise`: a user who typed 60/30/20 meant
 * something, and quietly rewriting it to 55/27/18 is a change to their plan that
 * nothing told them about.
 */
export function splitSum(split: BudgetSplit): number {
  return split.need + split.want + split.saving;
}

/**
 * The op one chosen plan authors.
 *
 * It REFUSES a split that does not sum to 100 rather than repairing it. The fold
 * refuses the same op as an `invalid_payload` anomaly (`replay.ts`), so writing
 * one would append a permanent record of a plan that never took effect — the
 * worst of both: the user's screen says 60/30/20 and their ledger has no plan at
 * all.
 */
export function budgetSplitOps(split: BudgetSplit): { type: string; payload: unknown }[] {
  for (const [what, value] of Object.entries(split)) {
    if (!Number.isInteger(value)) throw new Error(`${what} must be a whole percentage, got ${value}`);
    if (value < 0 || value > 100) throw new Error(`${what} is ${value}, and a percentage is between 0 and 100`);
  }
  const sum = splitSum(split);
  if (sum !== 100) throw new Error(`needs, wants and savings must add up to 100, not ${sum}`);
  return [{ type: "budget_split_set", payload: { need: split.need, want: split.want, saving: split.saving } }];
}

export interface BudgetMapping {
  categories: Readonly<Record<string, BudgetBucket>>;
  fallback: BudgetBucket | null;
}

export const DEFAULT_BUDGET_MAPPING: BudgetMapping = {
  categories: {
    groceries: "need",
    housing: "need",
    utilities: "need",
    transport: "need",
    healthcare: "need",
    insurance: "need",
    dining: "want",
    entertainment: "want",
    shopping: "want",
    travel: "want",
    savings: "saving",
    investments: "saving",
    debt: "saving",
  },
  fallback: null,
};

/**
 * The built-in table with the user's own categories layered over it.
 *
 * A layer, not a replacement: an account that has defined nothing gets
 * {@link DEFAULT_BUDGET_MAPPING} back unchanged (asserted in
 * `categories.test.ts`), and one that has defined "Gym" gets that name too. A
 * user's definition of a name the table already knows WINS — otherwise moving
 * "Dining" to needs would be a control that does not control anything.
 *
 * Retired categories are still mapped. The money filed under them is still in
 * the ledger and still belongs to the bucket it was filed in; see
 * `sources/categories.ts`.
 */
export function budgetMappingFor(db: SqlDriver): BudgetMapping {
  const mine = categoryMapping(readCategoryDefs(db));
  if (Object.keys(mine).length === 0) return DEFAULT_BUDGET_MAPPING;
  return { categories: { ...DEFAULT_BUDGET_MAPPING.categories, ...mine }, fallback: DEFAULT_BUDGET_MAPPING.fallback };
}

/**
 * `usable` mirrors {@link projectionIsUsable} exactly. When `false`, every
 * other field is a safe zero/empty placeholder, never a real (and therefore
 * misleading) partial total.
 */
export interface BudgetSnapshot {
  usable: boolean;
  homeCurrency: string | null;
  /**
   * The plan the buckets are read against — the user's if they chose one,
   * {@link DEFAULT_BUDGET_SPLIT} if they did not. It changes what the buckets
   * MEAN and never what is in them: the money is still the sum of what happened.
   */
  split: BudgetSplit;
  buckets: Record<BudgetBucket, bigint>;
  income: bigint;
  unassigned: bigint;
  confirmedTransactions: number;
  historyDays: number;
  warming: boolean;
  excluded: {
    missingHomeRate: number;
    unparsed: number;
    unresolvedDuplicates: number;
    sameDuplicates: number;
  };
}

export interface BudgetSource {
  read(nowMs: number): BudgetSnapshot;
}

/**
 * What "counts" — exported so `sources/insights.ts` slices the *same* set of
 * transactions this screen totals. Two copies of this predicate is how Home and
 * Insights eventually print two different numbers for the same month.
 */
export const CONFIRMED =
  "superseded_by IS NULL AND needs_review=0 AND unparsed=0 AND (possible_duplicate_of IS NULL OR duplicate_disposition='different')";

function mappingSQL(mapping: BudgetMapping): { sql: string; args: unknown[] } {
  const args: unknown[] = [];
  const arms = Object.entries(mapping.categories).map(([category, bucket]) => {
    args.push(category.toLowerCase(), bucket);
    return "WHEN ? THEN ?";
  });
  args.push(mapping.fallback);
  return { sql: `CASE lower(category) ${arms.join(" ")} ELSE ? END`, args };
}

/**
 * A grouped total, as exact decimal TEXT.
 *
 * SQLite hands an INTEGER back to sql.js as a JS `number`, which silently
 * loses precision past 2^53 — so the query CASTs the SUM to TEXT and this
 * refuses anything that did not arrive that way rather than quietly rounding.
 */
function exact(row: Record<string, unknown>, field: string): bigint {
  const value = row[field];
  if (typeof value !== "string" || !/^-?[0-9]+$/.test(value)) {
    throw new Error(`budget ${field} is not exact decimal text`);
  }
  return BigInt(value);
}

function unusable(homeCurrency: string | null): BudgetSnapshot {
  return {
    usable: false,
    homeCurrency,
    // The rule, not a half-read plan: an unusable projection is a "come back in
    // a moment" state, and the labels it renders under are still the default.
    split: DEFAULT_BUDGET_SPLIT,
    buckets: { need: 0n, want: 0n, saving: 0n },
    income: 0n,
    unassigned: 0n,
    confirmedTransactions: 0,
    historyDays: 0,
    warming: false,
    excluded: { missingHomeRate: 0, unparsed: 0, unresolvedDuplicates: 0, sameDuplicates: 0 },
  };
}

/**
 * `mapping` is a test seam and an override. Left out — which is what production
 * does — the mapping is read from the projection on every `read`, so a category
 * defined on another device starts bucketing as soon as its op is folded.
 */
export function sqlBudgetSource(db: SqlDriver, mapping?: BudgetMapping): BudgetSource {
  ensureProjection(db);
  return {
    read(nowMs) {
      const table = mapping ?? budgetMappingFor(db);
      // A projection written by an older build, or left half-written, must
      // never be summed and shown as fact: correctness depends on
      // `txn_split.amount_home_minor` having been written by THIS build, which
      // an unmigrated device can leave NULL.
      const meta = readMeta(db);
      if (meta === null || !projectionIsUsable(db)) return unusable(meta?.homeCurrency ?? null);

      const buckets: Record<BudgetBucket, bigint> = { need: 0n, want: 0n, saving: 0n };
      let income = 0n;
      let unassigned = 0n;
      const mapped = mappingSQL(table);
      const rows = db
        .prepare(
          `WITH parts AS (
    SELECT direction, category, amount_home_minor AS home FROM txn WHERE ${CONFIRMED} AND amount_home_minor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM txn_split s WHERE s.txn_id=txn.id)
    UNION ALL
    SELECT t.direction, s.category, s.amount_home_minor AS home FROM txn t JOIN txn_split s ON s.txn_id=t.id WHERE t.${CONFIRMED} AND s.amount_home_minor IS NOT NULL
  ) SELECT direction, ${mapped.sql} AS bucket, CAST(SUM(CAST(home AS INTEGER)) AS TEXT) AS total FROM parts GROUP BY direction, bucket`,
        )
        .all(...mapped.args) as Record<string, unknown>[];
      for (const row of rows) {
        const total = exact(row, "total");
        if (row["direction"] === "credit") income += total;
        else if (row["bucket"] === null) unassigned += total;
        else buckets[row["bucket"] as BudgetBucket] += total;
      }

      const stats = db
        .prepare(
          `SELECT
    SUM(CASE WHEN unparsed=1 THEN 1 ELSE 0 END) AS unparsed,
    SUM(CASE WHEN unparsed=0 AND needs_review=0 AND amount_home_minor IS NULL THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN possible_duplicate_of IS NOT NULL AND duplicate_disposition IS NULL THEN 1 ELSE 0 END) AS unresolved,
    SUM(CASE WHEN possible_duplicate_of IS NOT NULL AND duplicate_disposition='same' THEN 1 ELSE 0 END) AS same_dup,
    SUM(CASE WHEN ${CONFIRMED} THEN 1 ELSE 0 END) AS confirmed,
    MIN(CASE WHEN ${CONFIRMED} THEN posted_at END) AS earliest FROM txn WHERE superseded_by IS NULL`,
        )
        .all()[0] as Record<string, unknown>;

      // Counts, not money: a `number` is correct here and nowhere above.
      const confirmedTransactions = Number(stats["confirmed"] ?? 0);
      const earliest = stats["earliest"] === null || stats["earliest"] === undefined ? null : Date.parse(String(stats["earliest"]));
      const historyDays =
        earliest === null || !Number.isFinite(earliest) ? 0 : Math.max(0, Math.floor((nowMs - earliest) / 86_400_000));
      return {
        usable: true,
        homeCurrency: meta.homeCurrency,
        split: readBudgetSplit(db) ?? DEFAULT_BUDGET_SPLIT,
        buckets,
        income,
        unassigned,
        confirmedTransactions,
        historyDays,
        warming: historyDays < 14 && confirmedTransactions < 10,
        excluded: {
          missingHomeRate: Number(stats["missing"] ?? 0),
          unparsed: Number(stats["unparsed"] ?? 0),
          unresolvedDuplicates: Number(stats["unresolved"] ?? 0),
          sameDuplicates: Number(stats["same_dup"] ?? 0),
        },
      };
    },
  };
}
