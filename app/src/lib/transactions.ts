/**
 * The transaction list: what it asks SQLite for, what comes back, and how a row
 * presents itself.
 *
 * # The list reads a WINDOW, never the table
 *
 * `client/src/replay/projection.ts` exposes `readTxns`, which loads every row
 * into a `Map`. That is a test accessor and a small-account convenience, and a
 * list built on it is the read-all-then-render shape Phase 0's >500 MB freeze
 * came out of. So the query here is keyset-paged and bound to the list's window:
 * `WHERE (posted_at, id) < cursor ORDER BY posted_at DESC, id DESC LIMIT n`.
 *
 * Keyset rather than `OFFSET` because `OFFSET n` re-walks the first `n` rows on
 * every page, so scrolling a three-year log costs quadratically — and because a
 * row inserted by a sync mid-scroll shifts every offset, which silently
 * duplicates or skips a row. The cursor is `(posted_at, id)`: `posted_at` alone
 * is **not** unique — the fixture has two rows at the same instant on purpose,
 * because a cursor without the tiebreak loses exactly one of them and loses it
 * quietly.
 *
 * # Rows are decoded by the projection's own decoder
 *
 * `decodeTxnRow` is imported rather than re-written. A second decoder would
 * certify this file's reading of the columns rather than the projection's, which
 * is the "true by construction" trap in its most literal form: two decoders that
 * agree because they were written from the same mental model, and disagree the
 * day one column changes.
 *
 * # `countsTowardMoney` is the only definition of "this row is money"
 *
 * Not `amount_minor > 0n`, not `direction !== ""`, and not a comment. Task 7
 * put the rule in one function so that a total, a count, a direction split and a
 * currency breakdown cannot each answer it differently; {@link txnTotals} and
 * {@link txnAmountLabel} are two of its callers, and both go through it.
 */

import { decodeTxnRow, ensureProjection, TXN_COLUMNS } from "@ledger/client/replay/projection.ts";
import { countsTowardMoney } from "@ledger/client/replay/state.ts";
import type { ForkNotice, Split, Txn } from "@ledger/client/replay/state.ts";

export const TXN_PAGE_SIZE = 50;
export const MAX_RETAINED_TXNS = TXN_PAGE_SIZE * 3;
/**
 * Appends a page loaded going OLDER (`onEndReached`, scrolling down) and
 * trims from the FRONT.
 *
 * The front holds the earliest-loaded rows — the newest transactions, since
 * the list is newest-first — which is exactly what {@link prependTxnWindow}
 * exists to make recoverable: this function alone made the drop permanent,
 * because there was no reverse query to undo it. Keeping both functions is
 * the fix, not deleting this one — the memory bound a >500 MB freeze forced
 * on this screen (see the module doc) still has to hold.
 */
export function retainTxnWindow(previous: readonly Txn[], next: readonly Txn[], replace: boolean): Txn[] {
  return (replace ? [...next] : [...previous, ...next]).slice(-MAX_RETAINED_TXNS);
}
/**
 * Prepends a page loaded going NEWER (`onStartReached`, scrolling back up
 * toward rows {@link retainTxnWindow} evicted from the front) and trims from
 * the TAIL.
 *
 * This is the recovery path, and it is the mirror image of
 * {@link retainTxnWindow} on purpose: growing toward the top evicts from the
 * bottom — the end the user just scrolled away from — rather than leaving
 * scrolled-past rows unreachable forever. The bound stays exactly
 * {@link MAX_RETAINED_TXNS}; only which end pays for it changes with the
 * direction of travel.
 */
export function prependTxnWindow(previous: readonly Txn[], newer: readonly Txn[]): Txn[] {
  return [...newer, ...previous].slice(0, MAX_RETAINED_TXNS);
}
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { parseDecimal } from "@ledger/client/wire/op.ts";

import { signedAmount, type Flow } from "./money.ts";

export type Direction = "debit" | "credit";
export type Provenance = Txn["provenance"];

/**
 * A state a row can be in that a user might want to filter on.
 *
 * `unparsed` and `needs_review` are separate because they are separate
 * questions: every unparsed row needs review, and most rows that need review
 * parsed perfectly well. Collapsing them would hide the lane Task 19 is built
 * around.
 */
export type TxnFlag = "needs_review" | "unparsed" | "possible_duplicate" | "split";

export interface TxnFilters {
  readonly directions: readonly Direction[];
  /** `null` is a real value here: "uncategorized", which is not the same as "any". */
  readonly categories: readonly (string | null)[];
  readonly currencies: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly flags: readonly TxnFlag[];
  /** A merchant substring. Wildcards are literal — see {@link likeLiteral}. */
  readonly query: string;
  /**
   * Superseded rows are retained and inspectable (§2: nothing is dropped) but
   * they are not the ledger, so they are out of the list unless asked for.
   */
  readonly includeSuperseded: boolean;
}

export const EMPTY_FILTERS: TxnFilters = {
  directions: [],
  categories: [],
  currencies: [],
  provenance: [],
  flags: [],
  query: "",
  includeSuperseded: false,
};

/** The chip dimensions {@link withFilterToggled} can flip a value in. */
export type ChipDimension = "directions" | "categories" | "currencies" | "provenance" | "flags";

/** How many values are selected, across every dimension. Drives the "clear" affordance. */
export function filtersActive(f: TxnFilters): number {
  return (
    f.directions.length +
    f.categories.length +
    f.currencies.length +
    f.provenance.length +
    f.flags.length +
    (f.query.trim() === "" ? 0 : 1)
  );
}

/**
 * A chip pressed: the value goes in if it was out and out if it was in.
 *
 * Returns a new object — the filters live in React state and a mutation would
 * not re-render. `null` is compared by identity like any other value, so
 * "uncategorized" toggles the same way "Groceries" does.
 */
export function withFilterToggled<D extends ChipDimension>(
  f: TxnFilters,
  dimension: D,
  value: TxnFilters[D][number],
): TxnFilters {
  const current = f[dimension] as readonly (typeof value)[];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...f, [dimension]: next };
}

/** Where a page stopped. `(posted_at, id)`, because `posted_at` is not unique. */
export interface TxnCursor {
  posted_at: string;
  id: string;
}

export function cursorOf(t: Txn): TxnCursor {
  return { posted_at: t.posted_at, id: t.id };
}

/**
 * "older" (the default) pages backward in time from `after` — `onEndReached`,
 * the original forward-scrolling direction. "newer" pages forward in time
 * from `after` instead: the recovery direction, used to re-fetch rows
 * {@link retainTxnWindow}'s bound evicted from the front of the retained
 * window so scrolling back up is not scrolling into a hole.
 */
export type TxnPageDirection = "older" | "newer";

export interface TxnPageOptions {
  limit: number;
  after: TxnCursor | null;
  /** @default "older" */
  direction?: TxnPageDirection;
}

export interface TxnPage {
  rows: Txn[];
  /** The cursor for the next page, or `null` when this was the last one. */
  next: TxnCursor | null;
}

/**
 * The windowed query, as SQL and positional parameters.
 *
 * Built as a pure function so the SQL is testable without a database and so a
 * screen cannot assemble one by string concatenation. **Every value is a bound
 * parameter** — the merchant query included, which is the one field a user
 * types.
 *
 * It asks for `limit + 1` rows. That extra row is how {@link listTransactions}
 * knows whether there is a next page without a second `COUNT(*)` over the whole
 * filtered set.
 */
export function buildTxnQuery(f: TxnFilters, opts: TxnPageOptions): { sql: string; params: unknown[] } {
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new Error(`a page needs a positive integer limit, got ${String(opts.limit)}`);
  }
  const direction = opts.direction ?? "older";
  if (direction === "newer" && opts.after === null) {
    throw new Error('a "newer" page needs a cursor to page forward from — it recovers rows above a known boundary, it does not start a fresh list');
  }
  const where: string[] = [];
  const params: unknown[] = [];

  if (!f.includeSuperseded) where.push("superseded_by IS NULL");

  if (f.directions.length > 0) {
    where.push(`direction IN (${placeholders(f.directions.length)})`);
    params.push(...f.directions);
  }
  if (f.currencies.length > 0) {
    where.push(`currency IN (${placeholders(f.currencies.length)})`);
    params.push(...f.currencies);
  }
  if (f.provenance.length > 0) {
    where.push(`provenance IN (${placeholders(f.provenance.length)})`);
    params.push(...f.provenance);
  }
  if (f.categories.length > 0) {
    // `IN (?)` never matches NULL in SQL — three-valued logic — so an
    // "uncategorized" chip built that way selects nothing at all and looks like
    // an empty result rather than a broken filter.
    const named = f.categories.filter((c): c is string => c !== null);
    const parts: string[] = [];
    if (named.length > 0) {
      parts.push(`category IN (${placeholders(named.length)})`);
      params.push(...named);
    }
    if (f.categories.length !== named.length) parts.push("category IS NULL");
    where.push(`(${parts.join(" OR ")})`);
  }
  if (f.flags.length > 0) {
    where.push(`(${f.flags.map(flagPredicate).join(" OR ")})`);
  }
  const q = f.query.trim();
  if (q !== "") {
    where.push(`merchant_raw LIKE ? ESCAPE '\\'`);
    params.push(`%${likeLiteral(q)}%`);
  }
  if (opts.after !== null) {
    // The row-value form `(a, b) < (?, ?)` needs SQLite 3.15; this spells it out
    // so the query does not depend on the driver's build. "newer" flips the
    // comparison to `>` — the recovery direction, strictly above the boundary
    // rather than strictly below it.
    where.push(direction === "older" ? "(posted_at < ? OR (posted_at = ? AND id < ?))" : "(posted_at > ? OR (posted_at = ? AND id > ?))");
    params.push(opts.after.posted_at, opts.after.posted_at, opts.after.id);
  }

  // "older" orders newest-first, the list's natural order, so the page is
  // usable as-is. "newer" orders oldest-first-of-the-recovered-set — nearest
  // the boundary first — so the row closest to the boundary is what LIMIT
  // keeps when there are more than `limit` rows to recover; `listTransactions`
  // reverses the page back to newest-first before it reaches the screen.
  const order = direction === "older" ? "posted_at DESC, id DESC" : "posted_at ASC, id ASC";
  const sql =
    `SELECT ${TXN_COLUMNS} FROM txn` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${order} LIMIT ?`;
  params.push(opts.limit + 1);
  return { sql, params };
}

/**
 * One page of transactions, newest first, with each row's split parts attached.
 *
 * The parts are fetched in **one** statement for the whole page rather than one
 * per row: an N+1 inside a `FlatList`'s `onEndReached` is the fetch storm shape
 * Phase 0 froze on, at the SQLite layer instead of the network one.
 */
export function listTransactions(db: SqlDriver, f: TxnFilters, opts: TxnPageOptions): TxnPage {
  ensureProjection(db);
  const { sql, params } = buildTxnQuery(f, opts);
  const raw = db.prepare(sql).all(...params);
  const hasMore = raw.length > opts.limit;
  const page = hasMore ? raw.slice(0, opts.limit) : raw;
  const ids = page.map((r) => String((r as Record<string, unknown>)["id"]));
  const splits = readSplits(db, ids);
  let rows = page.map((r) => decodeTxnRow(r, splits.get(String((r as Record<string, unknown>)["id"])) ?? []));
  // "newer" fetched oldest-of-the-recovered-set first (nearest the boundary);
  // flip it back to the list's one true order — newest first — before it
  // reaches a caller. Nothing downstream of this function ever sees the
  // ascending order the recovery query needed internally.
  if (opts.direction === "newer") rows = rows.reverse();
  // For "older", `next` is the oldest row kept — continue below it. For
  // "newer", it is the newest row kept — continue above it, chasing whatever
  // {@link prependTxnWindow}'s bound has not yet recovered.
  const boundary = opts.direction === "newer" ? rows[0] : rows[rows.length - 1];
  return { rows, next: hasMore && boundary !== undefined ? cursorOf(boundary) : null };
}

/** One transaction by id, with its splits, or `null`. */
export function readTxn(db: SqlDriver, id: string): Txn | null {
  ensureProjection(db);
  const got = db.prepare(`SELECT ${TXN_COLUMNS} FROM txn WHERE id = ?`).all(id);
  const row = got[0];
  if (row === undefined) return null;
  return decodeTxnRow(row, readSplits(db, [id]).get(id) ?? []);
}

/**
 * The fork notices naming this entity.
 *
 * §3.3 requires a resolved concurrent edit to be surfaced and never silent, and
 * the place a user is most likely to be looking when it matters is the row it
 * happened to. Task 19 owns the queue lane; this is the same data, filtered to
 * one entity, so the detail screen can say "this changed on another device"
 * without loading the whole notice list.
 */
export function readForkNoticesFor(db: SqlDriver, id: string): ForkNotice[] {
  ensureProjection(db);
  return db
    .prepare("SELECT entity_kind, entity_id, winner_op, loser_op, at_seq FROM fork_notice WHERE entity_kind = 'txn' AND entity_id = ? ORDER BY idx")
    .all(id)
    .map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        entity: { kind: String(r["entity_kind"]), id: String(r["entity_id"]) },
        winner_op: String(r["winner_op"]),
        loser_op: String(r["loser_op"]),
        at_seq: parseDecimal(String(r["at_seq"])),
      };
    });
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface CurrencyTotal {
  debit: bigint;
  credit: bigint;
  count: number;
}

export interface TxnTotals {
  /** Rows considered, whatever they were. */
  rows: number;
  /** Rows {@link countsTowardMoney} admitted. */
  counted: number;
  /** Rows it refused — unparsed messages, which are not money. */
  unreadable: number;
  needsReview: number;
  /** Native totals per currency. A currency with no admitted row has no key. */
  byCurrency: Map<string, CurrencyTotal>;
  /**
   * Home-currency totals, over the rows that actually carry a snapshot.
   * `unconverted` is how many were left out for want of a rate — a number that
   * has to be visible, or a total silently understates itself (§3.7's null case
   * is a waiting state, not a zero).
   */
  home: { debit: bigint; credit: bigint; converted: number; unconverted: number };
}

/**
 * Sums a set of rows, in `bigint`, excluding everything
 * {@link countsTowardMoney} refuses.
 *
 * Grouped by currency because there is no single number: the beta's FX is
 * manual, so a currency with no rate has no home-currency value at all, and
 * adding native amounts across currencies would be adding dirhams to dollars.
 */
export function txnTotals(rows: readonly Txn[]): TxnTotals {
  const totals: TxnTotals = {
    rows: rows.length,
    counted: 0,
    unreadable: 0,
    needsReview: 0,
    byCurrency: new Map(),
    home: { debit: 0n, credit: 0n, converted: 0, unconverted: 0 },
  };
  for (const t of rows) {
    if (t.needs_review) totals.needsReview += 1;
    // The one rule, called rather than restated. An unparsed row adds zero to
    // every sum, which is precisely why excluding it has to be deliberate: it
    // would join the count, the direction split and the currency breakdown
    // without changing a single total, and nothing would look wrong.
    if (!countsTowardMoney(t)) {
      totals.unreadable += 1;
      continue;
    }
    totals.counted += 1;
    const bucket = totals.byCurrency.get(t.currency) ?? { debit: 0n, credit: 0n, count: 0 };
    if (t.direction === "credit") bucket.credit += t.amount_minor;
    else bucket.debit += t.amount_minor;
    bucket.count += 1;
    totals.byCurrency.set(t.currency, bucket);

    if (t.amount_home_minor === null) {
      totals.home.unconverted += 1;
      continue;
    }
    totals.home.converted += 1;
    if (t.direction === "credit") totals.home.credit += t.amount_home_minor;
    else totals.home.debit += t.amount_home_minor;
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface AmountLabel {
  text: string;
  flow: Flow;
  /** Nothing was extracted: show the state, not a number. */
  unreadable: boolean;
}

/**
 * What the amount cell says.
 *
 * An unparsed row prints an em dash rather than `0.00`, and this is the reason
 * the flag exists rather than a check on `amount_minor === 0n`: a real zero and
 * an empty row would be indistinguishable by amount, and a consumer inferring
 * one from the other gets it wrong the first time a client authors a legitimate
 * zero.
 */
export function txnAmountLabel(t: Txn): AmountLabel {
  if (!countsTowardMoney(t)) return { text: "—", flow: "none", unreadable: true };
  const { text, flow } = signedAmount(t.direction, t.amount_minor);
  return { text, flow, unreadable: false };
}

/**
 * The category line of a row.
 *
 * A split parent names its parts instead of a single category, because it has
 * none — v1's `splitLabel`, with the same "two, then a count" shaping.
 */
export function txnCategoryLabel(t: Txn): string {
  if (t.unparsed) return "Couldn't read this one";
  if (t.splits.length > 0) return splitLabel(t.splits);
  return t.category ?? "Uncategorized";
}

/** `Home + Groceries`, then `Home + 3 more`. */
export function splitLabel(splits: readonly Split[]): string {
  const names = splits.map((s) => s.category);
  if (names.length === 0) return "No parts";
  if (names.length <= 2) return names.join(" + ");
  return `${names[0]} + ${names.length - 1} more`;
}

export type MarkerKind = "ingest" | "unparsed" | "needs_review" | "possible_duplicate" | "superseded" | "split";

export interface Marker {
  kind: MarkerKind;
  /** Never an icon alone: a glyph with no words is a marker nobody can read. */
  label: string;
}

/**
 * The permanent markers a row carries.
 *
 * `ingest` is the one §3.3(b) requires: the UI must distinguish server-ingested
 * rows from user-authored ones, because the ingest writer's chain proves the
 * blob was stored intact and proves **nothing** about whether the operator was
 * honest about what went into it. It is derived from `provenance`, which comes
 * from the writer the blob was attributed to and is AAD-bound — a payload field
 * would let a client writer claim the label.
 */
export function txnMarkers(t: Txn): Marker[] {
  const out: Marker[] = [];
  if (t.provenance === "ingest") out.push({ kind: "ingest", label: "From your inbox" });
  if (t.unparsed) out.push({ kind: "unparsed", label: "Couldn't read this one" });
  else if (t.needs_review) out.push({ kind: "needs_review", label: "Needs review" });
  if (t.possible_duplicate_of !== null) out.push({ kind: "possible_duplicate", label: "Possible duplicate" });
  if (t.superseded_by !== null) out.push({ kind: "superseded", label: "Replaced by a re-read" });
  if (t.splits.length > 0) out.push({ kind: "split", label: `${t.splits.length} parts` });
  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function placeholders(n: number): string {
  return new Array<string>(n).fill("?").join(", ");
}

function flagPredicate(flag: TxnFlag): string {
  switch (flag) {
    case "needs_review":
      return "needs_review = 1";
    case "unparsed":
      return "unparsed = 1";
    case "possible_duplicate":
      return "possible_duplicate_of IS NOT NULL";
    case "split":
      return "EXISTS (SELECT 1 FROM txn_split WHERE txn_split.txn_id = txn.id)";
  }
}

/**
 * Escapes what SQLite's `LIKE` treats as a wildcard.
 *
 * A user typing `%` means a percent sign. Without this the pattern becomes
 * `%%%` and matches the entire table, which reads as "search is broken" rather
 * than as "no results" — and `_` matches any single character, which is worse
 * because it silently over-matches instead of obviously over-matching.
 */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Every part of every named transaction, in `idx` order, in one statement. */
function readSplits(db: SqlDriver, ids: readonly string[]): Map<string, Split[]> {
  const out = new Map<string, Split[]>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT txn_id, category, amount_minor FROM txn_split WHERE txn_id IN (${placeholders(ids.length)}) ORDER BY txn_id, idx`,
    )
    .all(...ids);
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const id = String(r["txn_id"]);
    const list = out.get(id) ?? [];
    list.push({ category: String(r["category"]), amount_minor: parseDecimal(String(r["amount_minor"])) });
    out.set(id, list);
  }
  return out;
}
