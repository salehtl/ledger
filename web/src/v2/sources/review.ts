/**
 * The review queue: which rows are in it, what a card says, and what answering
 * one appends to the log.
 *
 * A port of the retired Expo client's `app/src/db/reviewQueue.ts` (the SQL)
 * together with the half of `app/src/lib/review.ts` this screen actually uses
 * (the decisions), merged into one module for the same reason
 * `sources/transactions.ts` merged its two — `app`'s split existed so the pure
 * half could run under `bun test` without a
 * native SQLite, and here both halves run under vitest against the real browser
 * driver, so the split buys nothing and costs a second import path.
 *
 * # Three rules the queries obey, unchanged from the native port
 *
 *  1. **A window, never the table.** Every read is `LIMIT`/`OFFSET` and the full
 *     pass ({@link laneMoney}) chunks and yields. Phase 0's >500 MB freeze came
 *     out of a queue holding every transaction in a JS array.
 *  2. **One predicate per lane.** The count, the page and the money summary all
 *     go through {@link laneWhere}: three spellings of "which rows are in this
 *     lane" is three chances for the badge to disagree with the list.
 *  3. **Rows are decoded by the projection's own decoder.** `decodeTxnRow` is
 *     what `projectionMatchesState` compares through; a local decoder here would
 *     certify this file's reading of the columns rather than the projection's.
 *
 * # What is NOT ported
 *
 * The native queue also owns manual entry (`txn_superseded` over an unparsed
 * row) and the duplicate lane's cross-device disposition op. Both are real and
 * both are out of this task's scope; what is here is the categorize/confirm
 * path, and the lanes those two would drive are read-only until they land. A
 * control that looked live and silently did nothing would be worse than its
 * absence — the same rule `Transactions.tsx` applied to v1's write endpoints.
 */

import { runeLength } from "@ledger/client/categorize/canon";
import { MAX_CATEGORY_RUNES, MIN_CATEGORY_RUNES, MIN_EXACT_RUNES, subjectOf } from "@ledger/client/categorize/rules";
import type { OpSpec } from "@ledger/client/outbox/outbox";
import { decodeTxnRow, ensureProjection, TXN_COLUMNS } from "@ledger/client/replay/projection";
import { countsTowardMoney } from "@ledger/client/replay/state";
import type { CategoryDef, ForkNotice, Rule, Split, Txn } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";
import { parseDecimal, type Op } from "@ledger/client/wire/op";

import { readCategoryDefs } from "./categories";

// ---------------------------------------------------------------------------
// 1. Why a row is here
// ---------------------------------------------------------------------------

/**
 * The four reasons a row can be in this queue, which are four different things
 * even though a user sees one "needs review" badge for all of them.
 *
 * The hot payload carries `tier`, `needs_review` and `unparsed` and nothing else
 * about why, so this is the finest distinction the wire supports today.
 */
export type ReviewReason = "unreadable" | "pattern_guess" | "unsigned_headers" | "entered" | "uncategorized";

/**
 * Why one row is in the queue.
 *
 * The order of the tests is the point. The lane comes first because the other
 * four reasons all describe *how the row was read*, and the `uncategorized` lane
 * is not about the reading at all — a row that reached it was read cleanly, by a
 * template, with nothing uncertain about it. Calling that card "Signed, but not
 * the encoding" (which is what the tier alone says about every DIB message)
 * would put an alarming sentence on the one card that has nothing wrong with it.
 *
 * After that, `unparsed` is checked first because it is the only field that
 * means "there is nothing here" — `tier === "none"` does not imply it (every
 * client-authored op reads as `"none"` and carries real money), and reading the
 * tier first would file every import under "we couldn't read this".
 */
function reasonOf(t: Txn, lane: Lane | null = laneOf(t)): ReviewReason {
  if (lane === "uncategorized") return "uncategorized";
  if (t.unparsed) return "unreadable";
  if (t.tier === "heuristic") return "pattern_guess";
  if (t.tier === "template") return "unsigned_headers";
  return "entered";
}

export interface ReasonCopy {
  title: string;
  detail: string;
}

/**
 * The copy, in one place, because these sentences are the whole difference
 * between an honest screen and an alarming one.
 *
 * **Nothing claims an attack.** `unsigned_headers` is the common case — today it
 * is every DIB message — and describing the common case as a possible forgery
 * trains a user to confirm without reading, which is the one outcome that makes
 * the flag worthless.
 */
export const REVIEW_REASON_COPY: Record<ReviewReason, ReasonCopy> = {
  unreadable: {
    title: "We couldn't read this one",
    detail: "The message is kept in full, but no amount, merchant or date was found in it.",
  },
  pattern_guess: {
    title: "Read by a general pattern",
    detail: "No template covers this sender yet, so the details were pulled out by a generic rule.",
  },
  unsigned_headers: {
    title: "Signed, but not the encoding",
    detail: "Your bank signed this message, but not the headers that say how the text is encoded.",
  },
  entered: {
    title: "Added by you",
    detail: "This came from an import or a manual entry rather than from an email.",
  },
  uncategorized: {
    title: "Needs a category",
    detail: "This one was read cleanly. It just hasn't been filed under anything yet.",
  },
};

// ---------------------------------------------------------------------------
// 2. Lanes
// ---------------------------------------------------------------------------

export type Lane = "needs_review" | "unparsed" | "duplicate" | "uncategorized" | "forks";

/**
 * The lanes the confirm deck can actually answer, in the order it deals them.
 *
 * Both are answered by the same gesture and the same op — a `txn_categorized`
 * through {@link categorizeOps} — which is the whole test for whether a lane
 * belongs here. `unparsed` and `duplicate` do not: they need a typed-in row and
 * a yes/no, whose ops this screen does not author.
 */
export const DECK_LANES: readonly Lane[] = ["needs_review", "uncategorized"];

/**
 * Which lane a transaction belongs to, or `null` if it is not a review item.
 *
 * **Lanes are disjoint**, and the precedence is not arbitrary: a superseded row
 * is nothing at all; `unparsed` outranks everything else because the question is
 * different in kind (there is no amount to confirm); and a duplicate notice
 * outranks a plain review flag, because "is this the same purchase twice" has to
 * be answered before "what category is it" is a sensible question.
 *
 * `uncategorized` is last for the same reason, one step further on: "the parse
 * is uncertain" and "this needs a category" are different questions, and only
 * once the first is settled is the second worth asking. It is also the lane the
 * screen was missing entirely — a template-tier row with every capture group
 * filled is never `needs_review`, so before this it belonged to no lane and the
 * queue said "All caught up" over a transaction nothing had ever filed.
 *
 * A row whose SPLITS carry the categories is not in it: `txn_split` leaves the
 * transaction's own `category` null while the parts hold the answer, so asking
 * again would be asking a question the user has already answered.
 */
export function laneOf(t: Txn): Lane | null {
  if (t.superseded_by !== null) return null;
  if (t.unparsed) return "unparsed";
  if (t.possible_duplicate_of !== null && (t.duplicate_disposition ?? null) === null) return "duplicate";
  if (t.needs_review) return "needs_review";
  if ((t.category ?? "") === "" && t.splits.length === 0) return "uncategorized";
  return null;
}

// ---------------------------------------------------------------------------
// 3. Item identity — the fingerprint collapse must not come back
// ---------------------------------------------------------------------------

/**
 * The key a queue item is tracked by: dismissals, list keys, undo, everything.
 *
 * **It is the entity id and nothing else.** Every unparsed row has the same
 * amount (`0`), the same currency (`""`), the same direction (`""`), the same
 * (empty) merchant and, for a day's backlog, the same day — so ANY key built
 * from what the user can see would make every unparsed message of a day one
 * item, and the user would answer one card and silently lose the rest.
 */
export function itemKey(t: Txn): string {
  return `txn:${t.id}`;
}

/**
 * The key for one duplicate *notice*, which is a pair rather than a row.
 *
 * Ordered as `(flagged-against, flagged)` rather than sorted, because that is
 * the direction the notice was recorded in.
 */
export function duplicateKey(t: Txn): string {
  return `dup:${t.possible_duplicate_of ?? ""}:${t.id}`;
}

/**
 * The key for a fork notice.
 *
 * Op ids, not the row index: `fork_notice.idx` is assigned by the projection
 * writer and would renumber on a rebuild, resurrecting every notice the user had
 * dismissed.
 */
function forkKey(f: ForkNotice): string {
  return `fork:${f.winner_op}:${f.loser_op}`;
}

/** One card in the deck. */
export interface ReviewItem {
  key: string;
  lane: Lane;
  reason: ReviewReason;
  txn: Txn;
  /**
   * The duplicate lane's other row, when it is still live. `null` means the row
   * this one was flagged against has since been superseded or is outside the
   * projection — the notice still shows, because `possible_duplicate_of` is a
   * snapshot of an answer and not a live claim, and hiding it would be the
   * silent drop §3.3 forbids.
   */
  counterpart: Txn | null;
}

/** One resolved-fork card. */
export interface ForkItem {
  key: string;
  notice: ForkNotice;
}

// ---------------------------------------------------------------------------
// 4. Money, through the one predicate
// ---------------------------------------------------------------------------

export interface ReviewMoney {
  counted: number;
  excluded: number;
  totalHomeMinor: bigint;
  /**
   * Counted items whose FX snapshot is still null. They are in `counted` and NOT
   * in `totalHomeMinor`, so a screen that prints the total without printing this
   * is printing a number that is quietly short.
   */
  awaitingRate: number;
}

/**
 * Summarises a set of review rows for the queue header.
 *
 * The exclusion runs through {@link countsTowardMoney} rather than through a
 * local `!t.unparsed`: the rule is only true if every aggregate calls the same
 * thing. An unparsed row adds `0` to a sum, so getting this wrong is invisible
 * in the total — it shows up as a *count*, which is why the count is reported
 * separately and asserted.
 */
function reviewMoney(rows: Iterable<Txn>): ReviewMoney {
  let counted = 0;
  let excluded = 0;
  let awaitingRate = 0;
  let totalHomeMinor = 0n;
  for (const t of rows) {
    if (!countsTowardMoney(t)) {
      excluded++;
      continue;
    }
    counted++;
    if (t.amount_home_minor === null) awaitingRate++;
    else totalHomeMinor += t.amount_home_minor;
  }
  return { counted, excluded, totalHomeMinor, awaitingRate };
}

/**
 * Two lanes' summaries as one, for a screen that deals from both.
 *
 * The lanes are disjoint, so no row is counted twice, and `totalHomeMinor` stays
 * `bigint` the whole way through — a merge that went via `Number` would be the
 * one place in this file money stopped being exact.
 */
export function mergeMoney(parts: Iterable<ReviewMoney>): ReviewMoney {
  const total: ReviewMoney = { counted: 0, excluded: 0, totalHomeMinor: 0n, awaitingRate: 0 };
  for (const p of parts) {
    total.counted += p.counted;
    total.excluded += p.excluded;
    total.awaitingRate += p.awaitingRate;
    total.totalHomeMinor += p.totalHomeMinor;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 5. The one table this screen owns
// ---------------------------------------------------------------------------

/**
 * **Deliberately not part of `PROJECTION_SCHEMA`.** `project()` clears its own
 * tables on every rebuild, and a dismissal that vanished when the app re-folded
 * would put every notice the user has already answered back on the glass — the
 * projection is a pure function of the log, this is not derivable from the log
 * at all, and the two therefore have different lifetimes.
 */
const REVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS review_disposition (
  item_key TEXT PRIMARY KEY,
  lane     TEXT NOT NULL,
  answer   TEXT NOT NULL,
  at       TEXT NOT NULL
);
`;

function ensureReviewTables(db: SqlDriver): void {
  ensureProjection(db);
  db.exec(REVIEW_SCHEMA);
}

/**
 * A user's answer to a notice the op log has no way to record.
 */
export type Disposition = "not_transaction" | "not_duplicate" | "duplicate_confirmed" | "acknowledged";

const DISPOSITION_KINDS: readonly Disposition[] = [
  "not_transaction",
  "not_duplicate",
  "duplicate_confirmed",
  "acknowledged",
];

function isDisposition(s: string): s is Disposition {
  return (DISPOSITION_KINDS as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------
// 6. Lane predicates
// ---------------------------------------------------------------------------

/**
 * The SQL form of {@link laneOf}, and the reason the two are kept honest.
 *
 * They are two spellings of one rule — TypeScript's over a decoded `Txn`, and
 * SQLite's over the stored row. What holds them together is not discipline: the
 * suite runs every projected row through both and fails on the first
 * disagreement ("the SQL lanes agree with laneOf"), so a change to one that is
 * not made to the other is a red test rather than a badge that counts
 * differently from the list under it.
 */
function laneWhere(lane: Lane): string {
  switch (lane) {
    case "unparsed":
      return "t.superseded_by IS NULL AND t.unparsed = 1";
    case "duplicate":
      return "t.superseded_by IS NULL AND t.unparsed = 0 AND t.possible_duplicate_of IS NOT NULL AND t.duplicate_disposition IS NULL";
    case "needs_review":
      return "t.superseded_by IS NULL AND t.unparsed = 0 AND t.possible_duplicate_of IS NULL AND t.needs_review = 1";
    case "uncategorized":
      // The duplicate test is spelled in full rather than as
      // `possible_duplicate_of IS NULL`: a notice the user has already disposed
      // of is no longer a duplicate item, and `laneOf` files that row here — so
      // the looser spelling would make the SQL disagree with it.
      return (
        "t.superseded_by IS NULL AND t.unparsed = 0 AND t.needs_review = 0 " +
        "AND NOT (t.possible_duplicate_of IS NOT NULL AND t.duplicate_disposition IS NULL) " +
        "AND (t.category IS NULL OR t.category = '') " +
        "AND NOT EXISTS (SELECT 1 FROM txn_split s WHERE s.txn_id = t.id)"
      );
    case "forks":
      // The fork lane does not read `txn` at all; it is here so that a new lane
      // cannot be added without deciding what it selects.
      return "1 = 0";
  }
}

/**
 * The key expression, in SQL, for the lane's dismissal filter.
 *
 * It mirrors {@link itemKey}/{@link duplicateKey}, and the mirroring is tested
 * *by construction from the other side*: the suite dismisses a row using the
 * TypeScript key and then asserts the SQL page no longer returns it.
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
 * day's mail carries the same `posted_at`, so without a second key SQLite may
 * return them in any order and a paged queue would show one row twice and
 * another never.
 */
const ORDER = "ORDER BY t.posted_at DESC, t.id DESC";

// ---------------------------------------------------------------------------
// 7. Reads
// ---------------------------------------------------------------------------

export type LaneCounts = Record<Lane, number>;

/** How many items each lane holds, dismissals excluded. */
export function laneCounts(db: SqlDriver): LaneCounts {
  ensureReviewTables(db);
  const one = (lane: Lane): number => {
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM txn t WHERE ${laneWhere(lane)} AND ${notDismissed(lane)}`)
      .all();
    return intOf(rows[0], "n");
  };
  return {
    needs_review: one("needs_review"),
    unparsed: one("unparsed"),
    duplicate: one("duplicate"),
    uncategorized: one("uncategorized"),
    forks: forkCount(db),
  };
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

/** The default page. Small: this is a deck, not a feed. */
const PAGE_SIZE = 20;

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
    .prepare(
      `SELECT ${TXN_COLUMNS} FROM txn t WHERE ${laneWhere(lane)} AND ${notDismissed(lane)} ${ORDER} LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => textOf(r, "id"));
  const splits = splitsFor(db, ids);
  const counterparts =
    lane === "duplicate"
      ? counterpartsFor(
          db,
          rows.map((r) => stringOrNull(r, "possible_duplicate_of")),
        )
      : new Map<string, Txn>();

  return rows.map((raw) => {
    const t = decodeTxnRow(raw, splits.get(textOf(raw, "id")) ?? []);
    const key = lane === "duplicate" ? duplicateKey(t) : itemKey(t);
    const other = t.possible_duplicate_of === null ? null : (counterparts.get(t.possible_duplicate_of) ?? null);
    // The lane is passed rather than re-derived: it is the one the row was
    // SELECTed under, so the card's sentence and the query that produced it can
    // never be about two different questions.
    return { key, lane, reason: reasonOf(t, lane), txn: t, counterpart: other };
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
 * the card says so. It is never a reason to hide the notice.
 */
function counterpartsFor(db: SqlDriver, ids: readonly (string | null)[]): Map<string, Txn> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  const out = new Map<string, Txn>();
  if (wanted.length === 0) return out;
  const holes = wanted.map(() => "?").join(", ");
  const rows = db.prepare(`SELECT ${TXN_COLUMNS} FROM txn t WHERE t.id IN (${holes})`).all(...wanted);
  const splits = splitsFor(
    db,
    rows.map((r) => textOf(r, "id")),
  );
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
 * number and means "the order the fold happened to walk them", which is the same
 * thing here today and would stop being so the moment the projection is written
 * incrementally.
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
    const notice: ForkNotice = {
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
const MONEY_CHUNK = 250;

/**
 * What the queue's header says: how much money is waiting, and how many items
 * carry none.
 *
 * Not `SELECT SUM(...) WHERE unparsed = 0`: that would be a fourth place the
 * rule "an unparsed row is not money" lives. The rows are decoded and passed
 * through {@link reviewMoney}, which calls `countsTowardMoney` — the single
 * definition.
 *
 * It reads 250 at a time and yields between chunks, and the yield is the
 * load-bearing half rather than the chunking.
 */
export async function laneMoney(db: SqlDriver, lane: Lane, opts: MoneyOptions = {}): Promise<ReviewMoney> {
  ensureReviewTables(db);
  const total: ReviewMoney = { counted: 0, excluded: 0, totalHomeMinor: 0n, awaitingRate: 0 };
  if (lane === "forks") return total;
  const chunk = opts.chunkSize ?? MONEY_CHUNK;
  const st = db.prepare(
    `SELECT ${TXN_COLUMNS} FROM txn t WHERE ${laneWhere(lane)} AND ${notDismissed(lane)} ${ORDER} LIMIT ? OFFSET ?`,
  );
  for (let offset = 0, n = 0; ; offset += chunk) {
    const rows = st.all(chunk, offset);
    if (rows.length === 0) break;
    // Splits are irrelevant to the sum and cost a second statement per chunk, so
    // the rows are decoded without them.
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
 * There is no fixed taxonomy in v2 — a category is a string bounded by
 * `MIN_CATEGORY_RUNES`/`MAX_CATEGORY_RUNES` and nothing else — so the grid is
 * built from what this user actually uses. That is also the right answer for a
 * queue touched several times a day.
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
// 8. Dispositions
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
  db.prepare("INSERT OR REPLACE INTO review_disposition (item_key, lane, answer, at) VALUES (?, ?, ?, ?)").run(
    itemKey,
    lane,
    answer,
    at,
  );
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
  if (!isDisposition(answer)) {
    throw new Error(`stored disposition ${JSON.stringify(answer)} is not one this build knows`);
  }
  return { itemKey: textOf(raw, "item_key"), lane: textOf(raw, "lane") as Lane, answer, at: textOf(raw, "at") };
}

// ---------------------------------------------------------------------------
// 9. Versions — the self-fork this screen would otherwise ship
// ---------------------------------------------------------------------------

/**
 * The `parent_version` the next op for `entityId` must name.
 *
 * # Why the projection's version is not the answer
 *
 * A queue like this one is used offline and in bursts. The projection only moves
 * when a fold runs, and a fold only runs after a push and a pull — so every op
 * the user authors in a session sees the SAME projected version. Two ops naming
 * the same parent are, by `replay.ts`'s definition, a true concurrent fork: the
 * second is resolved against the first by author timestamp, and inside one
 * millisecond (or on a tie) *the user's later op is the one discarded*. A
 * confirm followed by an undo would drop the undo, and the queue would show a
 * fork notice for a fork the user never made.
 *
 * So the next parent is the highest version the log will hold once everything
 * already queued has been folded: each pending op naming parent `P` produces
 * version `P + 1`.
 */
export function nextParentVersion(entityId: string, projectedVersion: number, pending: readonly Op[]): number {
  let v = projectedVersion;
  for (const op of pending) {
    if (op.entity?.id !== entityId) continue;
    if (op.parent_version === null) continue;
    if (op.parent_version + 1 > v) v = op.parent_version + 1;
  }
  return v;
}

// ---------------------------------------------------------------------------
// 10. The ops an answer produces
// ---------------------------------------------------------------------------

export function categoryIsUsable(category: string): boolean {
  const n = runeLength(category.trim());
  return n >= MIN_CATEGORY_RUNES && n <= MAX_CATEGORY_RUNES;
}

/**
 * The pattern a rule write-back would use, or `null` when the merchant string
 * cannot carry one.
 *
 * `subjectOf` is `categorize/rules.ts`'s own canonicaliser, so the user's rule is
 * tested against the string this shows rather than a prettier one that would
 * match differently.
 *
 * `exact` rather than `contains`: a `contains` rule written from one card
 * silently re-categorises every merchant whose name contains this one, and a
 * user confirming a card is answering about a merchant, not writing a policy.
 */
export function ruleTargetOf(merchantRaw: string): string | null {
  const subject = subjectOf(merchantRaw);
  if (runeLength(subject) < MIN_EXACT_RUNES) return null;
  return subject;
}

export interface ConfirmArgs {
  txn: Txn;
  /** `null` confirms the row as it stands without setting a category. */
  category: string | null;
  /** The version the projection currently holds for this row. */
  projectedVersion: number;
  /** Ops already queued on this device, for {@link nextParentVersion}. */
  pending: readonly Op[];
  /** Every rule already materialised, so a merchant confirmed twice does not write the same rule twice. */
  rules: Iterable<Rule>;
  /** A ULID source. Injected so a test can pin ids. */
  newID: () => string;
}

/**
 * What confirming one card emits: the categorisation, and — first time only —
 * the rule that means this merchant is never asked about again.
 *
 * Returned as a list and enqueued together so that ONE flush carries both. An
 * app killed between two flushes would leave a categorised transaction with no
 * rule, and the next message from the same merchant would ask the user the same
 * question they already answered.
 *
 * `txn_categorized` carries `needs_review: false` and that is what clears the
 * flag — there is no separate "confirmed" op, and adding a `txn_edited` to do it
 * would be a second op consuming a second version for one user action.
 */
export function confirmOps(args: ConfirmArgs): OpSpec[] {
  const { txn, category, projectedVersion, pending, newID } = args;
  const parent = nextParentVersion(txn.id, projectedVersion, pending);
  const specs: OpSpec[] = [
    {
      type: "txn_categorized",
      entity: { kind: "txn", id: txn.id },
      parentVersion: parent,
      payload: { category, needs_review: false },
    },
  ];
  if (category === null || !categoryIsUsable(category)) return specs;
  const pattern = ruleTargetOf(txn.merchant_raw);
  if (pattern === null) return specs;
  for (const r of args.rules) {
    if (r.match === "exact" && r.pattern === pattern && r.category === category) return specs;
  }
  specs.push({
    type: "rule_added",
    entity: { kind: "rule", id: newID() },
    parentVersion: null,
    payload: { pattern, match: "exact", category, priority: 0 },
  });
  return specs;
}

export interface CategorizeArgs extends ConfirmArgs {
  /**
   * Whether the merchant write-back is wanted — the deck's "always use this
   * category for this merchant" switch, and the same switch on the transaction
   * list's sheet.
   */
  makeRule: boolean;
}

/**
 * What ONE categorisation records, wherever it was given.
 *
 * There are two entry points now — the review deck answers the `needs_review`
 * lane, and the transaction list answers everything else, which is the only way
 * a template-tier parse (trusted, never flagged) can be categorised at all. They
 * go through this one function rather than each assembling the group, because
 * two spellings of "how a categorisation is recorded" is two things to keep in
 * agreement forever: the op kinds, the parent-version arithmetic, the rule
 * dedupe, and the fact that dropping the rule is a FILTER on the group rather
 * than a different call — the rule's shape stays in {@link confirmOps} either
 * way.
 */
export function categorizeOps(args: CategorizeArgs): OpSpec[] {
  const specs = confirmOps(args);
  return args.makeRule ? specs : specs.filter((s) => s.type !== "rule_added");
}

export interface UndoConfirmArgs {
  txn: Txn;
  projectedVersion: number;
  pending: readonly Op[];
}

/**
 * Undoing a confirm.
 *
 * The log is append-only, so this is a compensating op rather than a deletion:
 * the row goes back to the category it had and back to `needs_review`, and both
 * ops stay in the log forever.
 *
 * The rule write-back is deliberately NOT undone. A user who said "this merchant
 * is Groceries" and then corrected the *transaction* has not necessarily
 * retracted the merchant rule.
 */
export function undoConfirmOps(args: UndoConfirmArgs): OpSpec[] {
  const { txn, projectedVersion, pending } = args;
  return [
    {
      type: "txn_categorized",
      entity: { kind: "txn", id: txn.id },
      parentVersion: nextParentVersion(txn.id, projectedVersion, pending),
      payload: { category: txn.category, needs_review: true },
    },
  ];
}

// ---------------------------------------------------------------------------
// 11. What is already answered but not yet folded
// ---------------------------------------------------------------------------

export interface Settlement {
  entityIDs: ReadonlySet<string>;
  ingestIDs: ReadonlySet<string>;
}

/**
 * Which rows the outbox has already answered.
 *
 * The queue reads the *projection*, and the projection only moves when a fold
 * runs. So for the whole of an offline session every row the user has confirmed
 * is still `needs_review = 1` in SQLite, and the next refresh would put all of
 * them back on the deck.
 *
 * It is derived from the outbox rather than remembered in component state
 * because a `Set` in state is lost when the tab is killed and the ops are not —
 * `Client.emit` commits before it returns.
 */
export function settledBy(pending: readonly Op[]): Settlement {
  const entityIDs = new Set<string>();
  const ingestIDs = new Set<string>();
  for (const op of pending) {
    if (op.type === "txn_categorized" || op.type === "txn_edited" || op.type === "txn_split") {
      if (op.entity !== undefined) entityIDs.add(op.entity.id);
    } else if (op.type === "txn_superseded") {
      if (op.ingest_id !== undefined && op.ingest_id !== "") ingestIDs.add(op.ingest_id);
    }
  }
  return { entityIDs, ingestIDs };
}

/** Whether a row has an answer already queued. */
export function isSettled(t: Txn, s: Settlement): boolean {
  return s.entityIDs.has(t.id) || s.ingestIDs.has(t.ingest_id);
}

/** The answer a `txn_categorized` this device authored gave for one row. */
export interface PendingAnswer {
  category: string | null;
  needs_review: boolean;
  /**
   * The version the op produces (`parent_version + 1`), or `null` when the op
   * named no parent.
   *
   * It is what makes the answer STOP being evidence. A remembered answer is
   * only true while the projection is behind the op that produced it; once the
   * row is at or past this version the fold has happened and the projection is
   * the truth — including when a peer's op won the fork and the category is not
   * the one this device asked for. Without this an answer outlives its
   * evidence, which is its own trap.
   */
  version: number | null;
}

/**
 * What the outbox has already answered, by transaction, with the answer itself.
 *
 * {@link settledBy} is enough for the deck, which only has to take a card OFF
 * the pile. A list has to keep showing the row, and the projection does not move
 * until a sync folds — so without this the row a user has just categorised goes
 * on reading "Uncategorized", offline for as long as the session lasts. A user
 * who sees no change very reasonably answers again, and two answers for one
 * merchant is how a contradicting rule gets written.
 *
 * Later ops overwrite earlier ones, so a row answered twice reads as the user's
 * LAST answer — the same order `fold` will resolve them in.
 */
export function pendingCategories(pending: readonly Op[]): Map<string, PendingAnswer> {
  const out = new Map<string, PendingAnswer>();
  for (const op of pending) {
    if (op.type !== "txn_categorized" || op.entity === undefined) continue;
    const payload = op.payload as { category?: unknown; needs_review?: unknown };
    out.set(op.entity.id, {
      category: typeof payload.category === "string" ? payload.category : null,
      needs_review: payload.needs_review === true,
      version: op.parent_version === null ? null : op.parent_version + 1,
    });
  }
  return out;
}

/**
 * One row as it will read once the queued answer folds.
 *
 * It claims exactly what the op says and nothing else: the category and the
 * review flag the op carries. Money, provenance and every other column are
 * untouched, because `txn_categorized` does not touch them either.
 *
 * And it stops claiming once the projection has caught up — see
 * {@link PendingAnswer.version}.
 */
export function withPendingCategory(t: Txn, answered: ReadonlyMap<string, PendingAnswer>): Txn {
  const answer = answered.get(t.id);
  if (answer === undefined) return t;
  // The fold has reached (or passed) this answer, so the projection is the
  // better source — even if it disagrees.
  if (answer.version !== null && t.version >= answer.version) return t;
  if (answer.category === t.category && answer.needs_review === t.needs_review) return t;
  return { ...t, category: answer.category, needs_review: answer.needs_review };
}

/**
 * The rules a queued `rule_added` will materialise, in {@link Rule} shape.
 *
 * Passed to {@link confirmOps} alongside the projection's own rules so that a
 * merchant answered twice in one offline session does not queue the same rule
 * twice — the projection cannot know about a rule that has not folded yet.
 */
export function pendingRules(pending: readonly Op[]): Rule[] {
  const out: Rule[] = [];
  for (const op of pending) {
    if (op.type !== "rule_added") continue;
    const p = op.payload as { pattern?: unknown; match?: unknown; category?: unknown; priority?: unknown };
    if (typeof p.pattern !== "string" || typeof p.match !== "string" || typeof p.category !== "string") continue;
    out.push({
      pattern: p.pattern,
      match: p.match,
      category: p.category,
      priority: typeof p.priority === "number" ? p.priority : 0,
      version: 0,
    });
  }
  return out;
}

/**
 * The category an `exact` rule already sends this merchant to, or `null`.
 *
 * # Why a second rule is not an option
 *
 * There is no rule-delete and no rule-edit op, so every `rule_added` is
 * permanent. Two `exact` rules on one pattern with the same priority and
 * DIFFERENT categories are resolved by `client/src/categorize/rules.ts` by
 * comparing the category strings' code points — alphabetically, not by
 * intent — which would make a user who *corrected* a category silently hand
 * that merchant to whichever of the two sorts first, forever. It would also
 * make `rules.ts`'s own promise ("it never decides between two different
 * categories that a user could have distinguished") false.
 *
 * So a screen offering the write-back has to know whether one already exists.
 * Queued-but-unfolded rules count: within one offline session they are the only
 * record there is.
 */
export function existingRuleCategory(
  merchantRaw: string,
  rules: Iterable<Rule>,
  pending: readonly Op[] = [],
): string | null {
  const pattern = ruleTargetOf(merchantRaw);
  if (pattern === null) return null;
  let found: string | null = null;
  for (const r of [...rules, ...pendingRules(pending)]) {
    if (r.match === "exact" && r.pattern === pattern) found = r.category;
  }
  return found;
}

// ---------------------------------------------------------------------------
// 12. The seam the screen sees
// ---------------------------------------------------------------------------

/**
 * What the review screen needs from storage.
 *
 * The screen takes this rather than a `SqlDriver` so a render test can drive it
 * without standing up the whole boot gate. The real implementation below is what
 * production passes and what the suite exercises against a real database, so the
 * seam moves the untestable part (rendering) away from the part that would
 * otherwise be mocked (the queries).
 */
export interface ReviewSource {
  counts(): Promise<LaneCounts>;
  page(lane: Lane, opts?: PageOptions): Promise<ReviewItem[]>;
  forks(opts?: PageOptions): Promise<ForkItem[]>;
  money(lane: Lane): Promise<ReviewMoney>;
  categories(): Promise<string[]>;
  /**
   * The categories the user DEFINED, retired ones included.
   *
   * Separate from {@link ReviewSource.categories}, which is the set they have
   * USED — the two answer different questions, and the picker needs both: the
   * definitions supply kind, bucket and colour, and the retirements are what
   * take a name out of the grid.
   */
  categoryDefs(): Promise<CategoryDef[]>;
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
export function sqlReviewSource(db: SqlDriver, now: () => string = () => new Date().toISOString()): ReviewSource {
  ensureReviewTables(db);
  return {
    counts: async () => laneCounts(db),
    page: async (lane, opts) => lanePage(db, lane, opts),
    forks: async (opts) => forkPage(db, opts),
    money: (lane) => laneMoney(db, lane, { between: yieldToUI }),
    categories: async () => topCategories(db),
    categoryDefs: async () => readCategoryDefs(db),
    rules: async () => rulesOf(db),
    version: async (id) => versionOf(db, id),
    dismiss: async (key, lane, answer) => setDisposition(db, key, lane, answer, now()),
    restore: async (key) => clearDisposition(db, key),
  };
}

// ---------------------------------------------------------------------------
// Column reads
//
// The same shape as the projection's own: a column that came back the wrong type
// is a loud failure here rather than a silent wrong number three layers up.
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
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`review query column ${name} is ${String(v)}, want an integer`);
  }
  return v;
}
