/**
 * The transaction list: what it asks the local SQLite for, what comes back, and
 * how a row presents itself.
 *
 * A port of the READ half of `app/src/lib/transactions.ts` plus
 * `app/src/screens/transactions/source.ts`'s `sqlTxnSource`, with the import
 * paths pointed at the web tree. The write half of the native source (`edit`,
 * `split`, `recomputeHome`) is deliberately NOT here: those author ops through
 * an outbox, which Task 9 wires up, and a read-only screen that carried
 * half-connected mutation seams would be the worse kind of stub.
 *
 * # The list reads a WINDOW, never the table
 *
 * `client/src/replay/projection.ts` exposes `readTxns`, which loads every row
 * into a `Map`. That is a test accessor and a small-account convenience, and a
 * list built on it is the read-all-then-render shape the native app's >500 MB
 * freeze came out of. So the query here is keyset-paged and bound to the list's
 * window: `WHERE (posted_at, id) < cursor ORDER BY posted_at DESC, id DESC
 * LIMIT n`.
 *
 * Keyset rather than `OFFSET` because `OFFSET n` re-walks the first `n` rows on
 * every page, and because a row inserted by a sync mid-scroll shifts every
 * offset, which silently duplicates or skips a row. The cursor is
 * `(posted_at, id)`: `posted_at` alone is **not** unique — the fixture has two
 * rows at the same instant on purpose, because a cursor without the tiebreak
 * loses exactly one of them and loses it quietly.
 *
 * ## …and the web screen does not use the cursor yet. Deliberately.
 *
 * `Transactions.tsx` asks for one page with `after: null` and grows `limit`,
 * so "Show older" re-walks the window — the very cost the paragraph above
 * criticises `OFFSET` for. Two reasons it is the right trade *here* and not on
 * the phone: the walk is over local SQLite rather than a network, and it keeps
 * the rendered list a pure function of one query key, where cursor state
 * accumulated across renders is the shape whose off-by-one lost exactly one
 * row per page in the native port. The bound is 150 rows, so the re-walk is
 * bounded too. The cursor machinery stays because it is correct, tested, and
 * what a virtualised list would need on the day one is built — it is not dead
 * code left behind, it is unclaimed.
 *
 * # Rows are decoded by the projection's own decoder
 *
 * `decodeTxnRow` is imported rather than re-written. A second decoder would
 * certify this file's reading of the columns rather than the projection's.
 *
 * # Two deliberate additions to the port, both in `TxnFilters`
 *
 *   - **`from`/`to`** — a period bound. The web shell has a scope selector in
 *     its top bar and hands every list screen a `from`/`to`; the native app has
 *     no such control, so its filters had no date dimension. Without this the
 *     scope selector would silently do nothing on this screen, which is a lie
 *     told by omission.
 *   - **the `confirmed` flag** — `needs_review = 0 AND unparsed = 0`, the
 *     segmented control's third segment. The native filter set only had
 *     positive flags, and "confirmed" is the one segment that is a negation.
 *
 * Both are bound parameters and both are covered in `transactions.test.ts`.
 */

import { decodeTxnRow, ensureProjection, readMeta, TXN_COLUMNS } from "@ledger/client/replay/projection";
import { countsTowardMoney } from "@ledger/client/replay/state";
import type { ForkNotice, Split, Txn } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";
import { parseDecimal } from "@ledger/client/wire/op";

import { signedMinor, type MinorFlow } from "../../lib/minorMoney";

export type Direction = "debit" | "credit";
export type Provenance = Txn["provenance"];

/**
 * A state a row can be in that a user might want to filter on.
 *
 * `unparsed` and `needs_review` are separate because they are separate
 * questions: every unparsed row needs review, and most rows that need review
 * parsed perfectly well.
 */
export type TxnFlag = "needs_review" | "unparsed" | "possible_duplicate" | "split" | "confirmed";

export interface TxnFilters {
  readonly directions: readonly Direction[];
  /** `null` is a real value here: "uncategorized", which is not the same as "any". */
  readonly categories: readonly (string | null)[];
  readonly currencies: readonly string[];
  readonly provenance: readonly Provenance[];
  readonly flags: readonly TxnFlag[];
  /** A merchant substring. Wildcards are literal — see {@link likeLiteral}. */
  readonly query: string;
  /** Inclusive `YYYY-MM-DD` lower bound on the posted day, or `""` for none. */
  readonly from: string;
  /** Inclusive `YYYY-MM-DD` upper bound on the posted day, or `""` for none. */
  readonly to: string;
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
  from: "",
  to: "",
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

export interface TxnPageOptions {
  limit: number;
  after: TxnCursor | null;
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
  // The day, not the instant: `posted_at` is a canonicalised RFC3339 UTC
  // timestamp and the bounds are calendar days, so comparing the whole string
  // against `"2026-07-31"` would drop every row on the 31st. The cut is in UTC
  // — `substr` of an already-canonical string, no `Date` anywhere — which is
  // what keeps it identical on a device in Dubai and one in Los Angeles.
  //
  // NOTE for whoever meets `lib/scope.ts` next: `scopeBounds` hands a range's
  // upper bound as `"YYYY-MM-32"`, a day that does not exist. That is not a
  // bug and it is load-bearing HERE — SQLite compares TEXT lexicographically,
  // so `"2026-07-31" <= "2026-07-32"` holds and the sentinel admits the whole
  // last day. "Fixing" it into a real date (`-31`) is safe for this predicate
  // but not for a caller that compares whole timestamps, which is why the
  // sentinel exists; changing either end without the other silently drops a
  // day's transactions.
  if (f.from !== "") {
    where.push("substr(posted_at, 1, 10) >= ?");
    params.push(f.from);
  }
  if (f.to !== "") {
    where.push("substr(posted_at, 1, 10) <= ?");
    params.push(f.to);
  }
  if (opts.after !== null) {
    // The row-value form `(a, b) < (?, ?)` needs SQLite 3.15; this spells it out
    // so the query does not depend on the driver's build.
    where.push("(posted_at < ? OR (posted_at = ? AND id < ?))");
    params.push(opts.after.posted_at, opts.after.posted_at, opts.after.id);
  }

  const sql =
    `SELECT ${TXN_COLUMNS} FROM txn` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY posted_at DESC, id DESC LIMIT ?`;
  params.push(opts.limit + 1);
  return { sql, params };
}

/**
 * One page of transactions, newest first, with each row's split parts attached.
 *
 * The parts are fetched in **one** statement for the whole page rather than one
 * per row: an N+1 inside a list's paging callback is the fetch-storm shape at
 * the SQLite layer instead of the network one.
 */
export function listTransactions(db: SqlDriver, f: TxnFilters, opts: TxnPageOptions): TxnPage {
  ensureProjection(db);
  const { sql, params } = buildTxnQuery(f, opts);
  const raw = db.prepare(sql).all(...params);
  const hasMore = raw.length > opts.limit;
  const page = hasMore ? raw.slice(0, opts.limit) : raw;
  const ids = page.map((r) => String((r as Record<string, unknown>)["id"]));
  const splits = readSplits(db, ids);
  const rows = page.map((r) => decodeTxnRow(r, splits.get(String((r as Record<string, unknown>)["id"])) ?? []));
  const boundary = rows[rows.length - 1];
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
 * happened to.
 */
export function readForkNoticesFor(db: SqlDriver, id: string): ForkNotice[] {
  ensureProjection(db);
  return db
    .prepare(
      "SELECT entity_kind, entity_id, winner_op, loser_op, at_seq FROM fork_notice WHERE entity_kind = 'txn' AND entity_id = ? ORDER BY idx",
    )
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
    // every sum, which is precisely why excluding it has to be deliberate.
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
  flow: MinorFlow;
  /** Nothing was extracted: show the state, not a number. */
  unreadable: boolean;
}

/**
 * What the amount cell says.
 *
 * An unparsed row prints an em dash rather than `0.00`, and this is the reason
 * the flag exists rather than a check on `amount_minor === 0n`: a real zero and
 * an empty row would be indistinguishable by amount.
 */
export function txnAmountLabel(t: Txn): AmountLabel {
  if (!countsTowardMoney(t)) return { text: "—", flow: "none", unreadable: true };
  const { text, flow } = signedMinor(t.direction, t.amount_minor);
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
 * from the writer the blob was attributed to and is AAD-bound.
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
// The source
// ---------------------------------------------------------------------------

/** The chip values a filter strip can offer, drawn from what is actually here. */
export interface TxnFacets {
  /** Includes `null` when some live row is uncategorized. */
  categories: (string | null)[];
  currencies: string[];
}

export interface TxnSource {
  list(filters: TxnFilters, opts: TxnPageOptions): TxnPage;
  read(id: string): Txn | null;
  forks(id: string): ForkNotice[];
  facets(): TxnFacets;
  homeCurrency(): string | null;
}

/** A read-only source over the projection. */
export function sqlTxnSource(db: SqlDriver): TxnSource {
  ensureProjection(db);
  return {
    list: (filters, opts) => listTransactions(db, filters, opts),
    read: (id) => readTxn(db, id),
    forks: (id) => readForkNoticesFor(db, id),
    facets(): TxnFacets {
      // Bounded by the number of distinct categories and currencies, not by the
      // log's length, so this is one small query rather than a pass over the
      // table. A filter strip that had to scan every row to know what to offer
      // would be the read-all shape wearing a different hat.
      const categories = db
        .prepare("SELECT DISTINCT category FROM txn WHERE superseded_by IS NULL ORDER BY category")
        .all()
        .map((r) => {
          const v = (r as Record<string, unknown>)["category"];
          return v === null || v === undefined ? null : String(v);
        });
      const currencies = db
        .prepare("SELECT DISTINCT currency FROM txn WHERE superseded_by IS NULL AND currency <> '' ORDER BY currency")
        .all()
        .map((r) => String((r as Record<string, unknown>)["currency"]));
      return { categories, currencies };
    },
    homeCurrency: () => readMeta(db)?.homeCurrency ?? null,
  };
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
    case "confirmed":
      return "(needs_review = 0 AND unparsed = 0)";
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

/**
 * Every part of every named transaction, in `idx` order, in one statement.
 *
 * Exported for `sources/insights.ts`, which hydrates its drill-in rows the same
 * way this file does. A second implementation of "attach the splits" is how one
 * screen comes to show a split transaction and another does not.
 */
export function readSplits(db: SqlDriver, ids: readonly string[]): Map<string, Split[]> {
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
