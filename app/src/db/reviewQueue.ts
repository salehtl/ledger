/**
 * The review queue's reads: four lane queries over the projection, plus the one
 * table this screen owns.
 *
 * # Why the queries are here and not in the screen
 *
 * `app/src/lib/review.ts` holds the decisions; this holds the SQL. The split is
 * what lets both halves be tested under `bun test` — this file is exercised
 * against a real SQLite database holding a real {@link project}ion of a real
 * fold, so what is checked is the query, not a fixture's idea of one.
 *
 * # Three rules the queries obey
 *
 *  1. **A window, never the table.** `readTxns` exists for tests and small
 *     accounts; a queue that called it would hold every transaction in a JS
 *     array, which is the shape Phase 0's >500 MB freeze came out of. Every
 *     read here is `LIMIT`/`OFFSET` and the full pass ({@link laneMoney})
 *     chunks and yields.
 *  2. **One predicate per lane.** The count, the page and the money summary
 *     share {@link laneWhere}, because three spellings of "which rows are in
 *     this lane" is three chances for the badge to disagree with the list.
 *  3. **Rows are decoded by the projection's own decoder.** `decodeTxnRow` is
 *     what `projectionMatchesState` compares through; a local decoder here
 *     would certify this file's reading of the columns rather than the
 *     projection's.
 */

import { decodeTxnRow, ensureProjection, TXN_COLUMNS } from "@ledger/client/replay/projection.ts";
import type { Rule, Split, Txn } from "@ledger/client/replay/state.ts";
import { parseDecimal } from "@ledger/client/wire/op.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";

import {
  duplicateKey,
  forkKey,
  isDisposition,
  itemKey,
  reasonOf,
  reviewMoney,
  type Disposition,
  type ForkItem,
  type Lane,
  type ReviewItem,
  type ReviewMoney,
} from "../lib/review.ts";

/**
 * The one table this screen owns.
 *
 * **Deliberately not part of `PROJECTION_SCHEMA`.** `project()` clears its own
 * six tables on every rebuild, and a dismissal that vanished when the app
 * re-folded would put every notice the user has already answered back on the
 * glass — the projection is a pure function of the log, this is not derivable
 * from the log at all, and the two therefore have different lifetimes.
 *
 * `at` is a device clock reading, used for "you dismissed this on Tuesday" and
 * nothing else. It never enters an op, never orders anything and is never
 * compared across devices: `authored_at` is the only wall clock the log has,
 * and it is a fork tiebreak.
 */
export const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_disposition (
  item_key TEXT PRIMARY KEY,
  lane     TEXT NOT NULL,
  answer   TEXT NOT NULL,
  at       TEXT NOT NULL
);
`;

export function ensureReviewTables(db: SqlDriver): void {
  ensureProjection(db);
  db.exec(REVIEW_SCHEMA);
}

// ---------------------------------------------------------------------------
// Lane predicates
// ---------------------------------------------------------------------------

/**
 * The SQL form of `laneOf`, and the reason the two are kept honest.
 *
 * They are two spellings of one rule — TypeScript's over a decoded `Txn`, and
 * SQLite's over the stored row — which is exactly the divergence this project
 * has been bitten by before. What holds them together is not discipline: the
 * suite runs every projected row through both and fails on the first
 * disagreement (`reviewQueue.test.ts`, "the SQL lanes agree with laneOf"), so a
 * change to one that is not made to the other is a red test rather than a badge
 * that counts differently from the list under it.
 *
 * `t` is the alias every query below uses for `txn`.
 */
export function laneWhere(lane: Lane): string {
  switch (lane) {
    case "unparsed":
      return "t.superseded_by IS NULL AND t.unparsed = 1";
    case "duplicate":
      return "t.superseded_by IS NULL AND t.unparsed = 0 AND t.possible_duplicate_of IS NOT NULL AND t.duplicate_disposition IS NULL";
    case "needs_review":
      return "t.superseded_by IS NULL AND t.unparsed = 0 AND t.possible_duplicate_of IS NULL AND t.needs_review = 1";
    case "forks":
      // The fork lane does not read `txn` at all; it is here so that a new lane
      // cannot be added without deciding what it selects.
      return "1 = 0";
  }
}

/**
 * The key expression, in SQL, for the lane's dismissal filter.
 *
 * It mirrors `itemKey`/`duplicateKey` and the mirroring is *tested by
 * construction from the other side*: the suite dismisses a row using the
 * TypeScript key and then asserts the SQL page no longer returns it. A test
 * that compared two strings this file produced would prove only that this file
 * agrees with itself.
 */
function keyExpr(lane: Lane): string {
  return lane === "duplicate"
    ? "'dup:' || COALESCE(t.possible_duplicate_of, '') || ':' || t.id"
    : "'txn:' || t.id";
}

function notDismissed(lane: Lane): string {
  return `NOT EXISTS (SELECT 1 FROM review_disposition d WHERE d.item_key = ${keyExpr(lane)})`;
}

/**
 * Newest first, and `id` breaks the tie.
 *
 * The tiebreak is load-bearing rather than tidy: every unparsed row from one
 * day's mail carries the same `posted_at` (the message date is all the pipeline
 * has), so without a second key SQLite may return them in any order and a
 * paged queue would show one row twice and another never.
 */
const ORDER = "ORDER BY t.posted_at DESC, t.id DESC";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type LaneCounts = Record<Lane, number>;

/** How many items each lane holds, dismissals excluded. */
export function laneCounts(db: SqlDriver): LaneCounts {
  ensureReviewTables(db);
  const one = (lane: Lane): number => {
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM txn t WHERE ${laneWhere(lane)} AND ${notDismissed(lane)}`).all();
    return intOf(rows[0], "n");
  };
  return {
    needs_review: one("needs_review"),
    unparsed: one("unparsed"),
    duplicate: one("duplicate"),
    forks: forkCount(db),
  };
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

/** The default page. Small: this is a deck, not a feed. */
export const PAGE_SIZE = 20;

/**
 * One page of a lane.
 *
 * The duplicate lane joins its counterpart in the same statement rather than
 * asking per row — a per-row lookup over a page is the N+1 a windowed list
 * exists to avoid, and here it would run on every card the user swipes past.
 */
export function lanePage(db: SqlDriver, lane: Lane, opts: PageOptions = {}): ReviewItem[] {
  ensureReviewTables(db);
  if (lane === "forks") return [];
  const limit = opts.limit ?? PAGE_SIZE;
  const offset = opts.offset ?? 0;

  const rows = db
    .prepare(`SELECT ${TXN_COLUMNS} FROM txn t WHERE ${laneWhere(lane)} AND ${notDismissed(lane)} ${ORDER} LIMIT ? OFFSET ?`)
    .all(limit, offset);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => textOf(r, "id"));
  const splits = splitsFor(db, ids);
  const counterparts = lane === "duplicate" ? counterpartsFor(db, rows.map((r) => stringOrNull(r, "possible_duplicate_of"))) : new Map<string, Txn>();

  return rows.map((raw) => {
    const t = decodeTxnRow(raw, splits.get(textOf(raw, "id")) ?? []);
    const key = lane === "duplicate" ? duplicateKey(t) : itemKey(t);
    const other = t.possible_duplicate_of === null ? null : counterparts.get(t.possible_duplicate_of) ?? null;
    return { key, lane, reason: reasonOf(t), txn: t, counterpart: other };
  });
}

/** The `txn_split` parts for a page's rows, in one statement. */
function splitsFor(db: SqlDriver, ids: readonly string[]): Map<string, Split[]> {
  const out = new Map<string, Split[]>();
  if (ids.length === 0) return out;
  const holes = ids.map(() => "?").join(", ");
  for (const raw of db
    .prepare(`SELECT txn_id, idx, category, amount_minor FROM txn_split WHERE txn_id IN (${holes}) ORDER BY txn_id, idx`)
    .all(...ids)) {
    const id = textOf(raw, "txn_id");
    const list = out.get(id) ?? [];
    list.push({ category: textOf(raw, "category"), amount_minor: parseDecimal(textOf(raw, "amount_minor")) });
    out.set(id, list);
  }
  return out;
}

/**
 * The rows a page's duplicate notices point AT.
 *
 * A counterpart that is superseded or missing is simply absent from the map and
 * the card says so. It is never a reason to hide the notice: `possible_duplicate_of`
 * is a snapshot of an answer rather than a live claim (`state.ts`), and dropping
 * the item would be the silent drop §3.3 forbids.
 */
function counterpartsFor(db: SqlDriver, ids: readonly (string | null)[]): Map<string, Txn> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  const out = new Map<string, Txn>();
  if (wanted.length === 0) return out;
  const holes = wanted.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT ${TXN_COLUMNS} FROM txn t WHERE t.id IN (${holes})`).all(...wanted);
  const splits = splitsFor(db, rows.map((r) => textOf(r, "id")));
  for (const raw of rows) {
    const t = decodeTxnRow(raw, splits.get(textOf(raw, "id")) ?? []);
    out.set(t.id, t);
  }
  return out;
}

function forkCount(db: SqlDriver): number {
  const rows = db
    .prepare(
      "SELECT COUNT(*) AS n FROM fork_notice f WHERE NOT EXISTS " +
        "(SELECT 1 FROM review_disposition d WHERE d.item_key = 'fork:' || f.winner_op || ':' || f.loser_op)",
    )
    .all();
  return intOf(rows[0], "n");
}

/**
 * A page of resolved forks, newest first.
 *
 * Ordered by `at_seq` rather than by `idx`: `idx` is the projection writer's row
 * number and means "the order the fold happened to walk them", which is the
 * same thing here today and would stop being so the moment the projection is
 * written incrementally.
 */
export function forkPage(db: SqlDriver, opts: PageOptions = {}): ForkItem[] {
  ensureReviewTables(db);
  const rows = db
    .prepare(
      "SELECT entity_kind, entity_id, winner_op, loser_op, at_seq FROM fork_notice f " +
        "WHERE NOT EXISTS (SELECT 1 FROM review_disposition d WHERE d.item_key = 'fork:' || f.winner_op || ':' || f.loser_op) " +
        "ORDER BY CAST(at_seq AS INTEGER) DESC, winner_op DESC LIMIT ? OFFSET ?",
    )
    .all(opts.limit ?? PAGE_SIZE, opts.offset ?? 0);
  return rows.map((raw) => {
    const notice = {
      entity: { kind: textOf(raw, "entity_kind"), id: textOf(raw, "entity_id") },
      winner_op: textOf(raw, "winner_op"),
      loser_op: textOf(raw, "loser_op"),
      at_seq: parseDecimal(textOf(raw, "at_seq")),
    };
    return { key: forkKey(notice), notice };
  });
}

export interface MoneyOptions {
  chunkSize?: number;
  /** Awaited between chunks. Production passes the `setTimeout(0)` yield. */
  between?: (chunk: number) => Promise<void> | void;
}

/** Rows read per chunk, and per yield. The project's standing number. */
export const MONEY_CHUNK = 250;

/**
 * What the queue's header says: how much money is waiting, and how many items
 * carry none.
 *
 * # Why this is not `SELECT SUM(...) WHERE unparsed = 0`
 *
 * That query would be a fourth place the rule "an unparsed row is not money"
 * lives, and `state.ts` is explicit that the rule is only true if every
 * aggregate calls the same function. So the rows are decoded and passed through
 * {@link reviewMoney}, which calls `countsTowardMoney` — the single definition —
 * and the sum, the count and the excluded count come out of one pass over one
 * predicate.
 *
 * # Why it chunks
 *
 * A DIB user reviews every transaction, so this lane is not small: three years
 * of history is ~3,700 rows. Reading them in one statement and decoding them
 * into one array is precisely the unguarded full pass Phase 0 froze on. It
 * reads 250 at a time and yields between chunks — and the yield is the
 * load-bearing half, not the chunking.
 */
export async function laneMoney(db: SqlDriver, lane: Lane, opts: MoneyOptions = {}): Promise<ReviewMoney> {
  ensureReviewTables(db);
  const total: ReviewMoney = { counted: 0, excluded: 0, totalHomeMinor: 0n, awaitingRate: 0 };
  if (lane === "forks") return total;
  const chunk = opts.chunkSize ?? MONEY_CHUNK;
  const st = db.prepare(`SELECT ${TXN_COLUMNS} FROM txn t WHERE ${laneWhere(lane)} AND ${notDismissed(lane)} ${ORDER} LIMIT ? OFFSET ?`);
  for (let offset = 0, n = 0; ; offset += chunk) {
    const rows = st.all(chunk, offset);
    if (rows.length === 0) break;
    // Splits are irrelevant to the sum and cost a second statement per chunk,
    // so the rows are decoded without them. `reviewMoney` reads `unparsed` and
    // `amount_home_minor` and nothing else.
    const part = reviewMoney(rows.map((raw) => decodeTxnRow(raw, [])));
    total.counted += part.counted;
    total.excluded += part.excluded;
    total.awaitingRate += part.awaitingRate;
    total.totalHomeMinor += part.totalHomeMinor;
    if (rows.length < chunk) break;
    n += 1;
    await opts.between?.(n);
  }
  return total;
}

/**
 * The categories to put in the grid, most-used first.
 *
 * There is no fixed taxonomy in v2 — a category is a string, bounded by
 * `MIN_CATEGORY_RUNES`/`MAX_CATEGORY_RUNES` and nothing else — so the grid is
 * built from what this user actually uses. That is also the right answer for a
 * queue touched several times a day: the four categories that cover most of a
 * person's spending end up under the thumb.
 *
 * Categories that appear only in a rule are included at the end: a user who
 * wrote a rule for "Fuel" and has not spent on it yet should still see it.
 */
export function topCategories(db: SqlDriver, limit = 12): string[] {
  ensureReviewTables(db);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of db
    .prepare(
      "SELECT category, COUNT(*) AS n FROM txn t WHERE t.superseded_by IS NULL AND t.category IS NOT NULL " +
        "GROUP BY category ORDER BY n DESC, category ASC LIMIT ?",
    )
    .all(limit)) {
    const c = textOf(raw, "category");
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  if (out.length >= limit) return out;
  for (const raw of db.prepare("SELECT DISTINCT category FROM rule ORDER BY category LIMIT ?").all(limit)) {
    const c = textOf(raw, "category");
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Every materialised rule, for the write-back's "do I already have this one" check. */
export function rulesOf(db: SqlDriver): Rule[] {
  ensureReviewTables(db);
  return db
    .prepare("SELECT pattern, match, category, priority, version FROM rule")
    .all()
    .map((raw) => ({
      pattern: textOf(raw, "pattern"),
      match: textOf(raw, "match"),
      category: textOf(raw, "category"),
      priority: intOf(raw, "priority"),
      version: intOf(raw, "version"),
    }));
}

/** The version the projection currently holds for a row, or null if it has none. */
export function versionOf(db: SqlDriver, txnID: string): number | null {
  ensureReviewTables(db);
  const rows = db.prepare("SELECT version FROM txn WHERE id = ?").all(txnID);
  if (rows.length === 0) return null;
  return intOf(rows[0], "version");
}

// ---------------------------------------------------------------------------
// Dispositions
// ---------------------------------------------------------------------------

export interface DispositionRow {
  itemKey: string;
  lane: Lane;
  answer: Disposition;
  at: string;
}

/**
 * Records the user's answer to a notice the log cannot hold.
 *
 * `INSERT OR REPLACE`, because answering the same notice twice is the user
 * changing their mind rather than an error, and a second row would be a second
 * answer to one question.
 */
export function setDisposition(db: SqlDriver, itemKey: string, lane: Lane, answer: Disposition, at: string): void {
  ensureReviewTables(db);
  db.prepare("INSERT OR REPLACE INTO review_disposition (item_key, lane, answer, at) VALUES (?, ?, ?, ?)").run(itemKey, lane, answer, at);
}

/** Undoes a dismissal, putting the item back in its lane. */
export function clearDisposition(db: SqlDriver, itemKey: string): void {
  ensureReviewTables(db);
  db.prepare("DELETE FROM review_disposition WHERE item_key = ?").run(itemKey);
}

export function dispositionOf(db: SqlDriver, itemKey: string): DispositionRow | null {
  ensureReviewTables(db);
  const rows = db.prepare("SELECT item_key, lane, answer, at FROM review_disposition WHERE item_key = ?").all(itemKey);
  const raw = rows[0];
  if (raw === undefined) return null;
  const answer = textOf(raw, "answer");
  if (!isDisposition(answer)) throw new Error(`stored disposition ${JSON.stringify(answer)} is not one this build knows`);
  return { itemKey: textOf(raw, "item_key"), lane: textOf(raw, "lane") as Lane, answer, at: textOf(raw, "at") };
}

// ---------------------------------------------------------------------------
// The seam the screen sees
// ---------------------------------------------------------------------------

/**
 * What `ReviewScreen` needs from storage.
 *
 * The screen takes this rather than a `SqlDriver` so that a render test can
 * drive it without a native SQLite — `expo-sqlite` has no host implementation
 * and there is no simulator on this box. The real implementation below is what
 * production passes and what `bun test` exercises against a real database, so
 * the seam moves the untestable part (rendering) away from the part that would
 * otherwise be mocked (the queries).
 */
export interface ReviewSource {
  counts(): Promise<LaneCounts>;
  page(lane: Lane, opts?: PageOptions): Promise<ReviewItem[]>;
  forks(opts?: PageOptions): Promise<ForkItem[]>;
  money(lane: Lane): Promise<ReviewMoney>;
  categories(): Promise<string[]>;
  rules(): Promise<Rule[]>;
  version(txnID: string): Promise<number | null>;
  dismiss(itemKey: string, lane: Lane, answer: Disposition): Promise<void>;
  restore(itemKey: string): Promise<void>;
}

/** The yield Phase 0's fix turned out to depend on. */
const yieldToUI = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * The production source.
 *
 * `now` is injected because the disposition timestamp is the one wall-clock
 * reading in this file and a test that could not pin it would be a test with a
 * clock in it.
 */
export function sqliteReviewSource(db: SqlDriver, now: () => string = () => new Date().toISOString()): ReviewSource {
  return {
    counts: async () => laneCounts(db),
    page: async (lane, opts) => lanePage(db, lane, opts),
    forks: async (opts) => forkPage(db, opts),
    money: (lane) => laneMoney(db, lane, { between: yieldToUI }),
    categories: async () => topCategories(db),
    rules: async () => rulesOf(db),
    version: async (id) => versionOf(db, id),
    dismiss: async (key, lane, answer) => setDisposition(db, key, lane, answer, now()),
    restore: async (key) => clearDisposition(db, key),
  };
}

// ---------------------------------------------------------------------------
// Column reads
//
// The same shape as the projection's own: a column that came back the wrong
// type is a loud failure here rather than a silent wrong number three layers up.
// ---------------------------------------------------------------------------

function textOf(raw: unknown, name: string): string {
  const v = (raw as Record<string, unknown>)[name];
  if (typeof v !== "string") throw new Error(`review query column ${name} is ${typeof v}, want string`);
  return v;
}

function stringOrNull(raw: unknown, name: string): string | null {
  const v = (raw as Record<string, unknown>)[name];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new Error(`review query column ${name} is ${typeof v}, want string or null`);
  return v;
}

function intOf(raw: unknown, name: string): number {
  const v = (raw as Record<string, unknown>)[name];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`review query column ${name} is ${String(v)}, want an integer`);
  return v;
}
