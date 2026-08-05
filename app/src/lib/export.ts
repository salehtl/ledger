/**
 * Export: turning the device's own copy of a user's finances into a file they
 * can keep, in a shape something else can read.
 *
 * # Why this exists at all, and why it is not a nice-to-have
 *
 * The product's claim is that a user owns their data. Account deletion is the
 * half of that claim which proves we will let go; export is the half which
 * proves there was something to let go *of*. Shipping deletion without export
 * would mean the only way to get your history out of ledger is to destroy it.
 *
 * # Two formats, and neither one pretends to be the other
 *
 * **CSV** is what people can actually use — it opens in Numbers, Excel,
 * Sheets, pandas, and a bank's own import form. It is one flat table, so it can
 * hold exactly one thing: transactions. Everything structural about the ledger
 * (splits as records, rules, rates, notices) either flattens into a lossy cell
 * or is absent.
 *
 * **JSON** is the complete local *state* — every transaction including the
 * superseded ones, splits as real arrays, rules, rates, the home currency, the
 * fork and anomaly log, and the cursors that say how much of the log it is a
 * fold of.
 *
 * Both say what they omit, and the JSON one says it **inside the file**
 * ({@link EXPORT_OMISSIONS}), because an omission recorded only in a UI screen
 * is an omission the person reading the file two years from now will not see.
 *
 * # The op log is deliberately NOT a third format, and this is the honest part
 *
 * The op log — the verbatim `WireRow`s, their blobs, their chain hashes — is
 * the only artefact that is *complete* in the strong sense: it is what was
 * signed, and it is the only thing that can be re-verified. It is not offered,
 * for two reasons that are worth stating rather than leaving to be discovered:
 *
 *  1. **It would be complete-looking and actually partial.** Task 10's cold
 *     window prunes: the raw email bodies behind old transactions are not on
 *     the device any more. An "op log export" would hand a user a file that
 *     claims to be the whole record and is missing exactly the part they would
 *     go looking for.
 *  2. **Nothing but this app can read it.** It is base64 envelope frames. A
 *     user cannot check it, and no other tool can open it, so as a *user*
 *     artefact it is worse than the JSON, which is a lossless rendering of the
 *     fold of that same log.
 *
 * What the JSON therefore loses relative to the log is **provenance and
 * verifiability**, not content: who authored each op, in what order, under
 * which chain hash. That sentence is in {@link EXPORT_OMISSIONS} verbatim.
 *
 * # Money
 *
 * `bigint` minor units, everywhere, and out of this file as a **decimal
 * string** built by string arithmetic — never `Number`, never
 * `toLocaleString`, never `JSON.stringify` on a `bigint` (which throws, and
 * `export.test.ts` pins that it throws, so a stray bigint is a loud failure
 * rather than a silent `[object Object]`). The file carries both
 * `amount_minor` (the exact integer, as a string) and `amount` (the same value
 * with a decimal point), so nothing is expressed *only* in a form that a
 * consumer might round.
 *
 * # Nothing here touches a native module
 *
 * It is a generator of strings and a driver that pushes them at a sink. The
 * `expo-file-system` / `expo-sharing` half is `app/src/account/native.ts`, so
 * everything in this file runs under `bun test` on this box.
 */

import type { Anomaly, ForkNotice, Rule, Split, Txn } from "@ledger/client/replay/state.ts";

import { MINOR_DIGITS, MINOR_SCALE } from "./money.ts";

/**
 * Transactions written per chunk, and per yield.
 *
 * The same 250 as `store.ROW_CHUNK` and `projection.PROJECT_CHUNK`, for the
 * same reason: Phase 0's freeze was fixed by chunking **with a yield between
 * chunks**, and the yield was the load-bearing half. Repeated rather than
 * imported because these count different things (rows read, rows projected,
 * rows serialized) and tuning one must not silently retune the others.
 */
export const EXPORT_CHUNK = 250;

export type ExportFormat = "csv" | "json";

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * `bigint` minor units as a decimal string: `1234n` → `"12.34"`.
 *
 * **String arithmetic only.** `Number(9223372036854775807n) / 100` is
 * `92233720368547760`, which is not the number and never was — `export.test.ts`
 * asserts that exact wrong string alongside the right one, so the gate can
 * fail rather than being satisfied by whatever this function happens to
 * return.
 *
 * The sign is an ASCII hyphen, not `money.ts`'s U+2212. That file formats for
 * glass, where a typographic minus is correct; this one writes a file that a
 * parser reads, and U+2212 is not a minus sign to any of them. Amounts are
 * positive by invariant, so the negative branch exists for totality rather
 * than for a real row.
 *
 * No grouping separators, for the same reason.
 */
export function decimalMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / MINOR_SCALE).toString(10);
  const frac = (abs % MINOR_SCALE).toString(10).padStart(MINOR_DIGITS, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Leading characters a spreadsheet reads as the start of a formula.
 *
 * This is not paranoia about a hypothetical: merchant strings arrive from
 * *email*, which is attacker-controlled input by construction, and an export
 * is the one artefact this app produces that gets opened in a program with an
 * evaluator in it. A merchant called `=cmd|' /C calc'!A0` in a `.csv` is a
 * code-execution path into the user's own machine, delivered by us, in a file
 * they trust because they asked for it.
 *
 * `\t` and `\r` are in the set because Excel strips leading whitespace before
 * deciding, so `\t=1+1` is a formula too.
 */
const FORMULA_LEADS = new Set(["=", "+", "@", "-", "\t", "\r"]);

/**
 * One CSV field, RFC 4180, with the formula guard applied first.
 *
 * Order matters: the guard prefixes an apostrophe, and the quoting decision is
 * then made about the *guarded* string, so a field that needed both gets both
 * and in the order a reader will undo them.
 *
 * The guard is skipped for anything that parses as a plain decimal number,
 * because `-12.34` is a number and `'-12.34` is text — corrupting the money to
 * defend the merchant would be the cure killing the patient. Money in this
 * export is unsigned anyway (direction is its own column), so the exception is
 * narrow.
 */
export function csvField(raw: string): string {
  let value = raw;
  const lead = value[0];
  if (lead !== undefined && FORMULA_LEADS.has(lead) && !/^-?\d+(\.\d+)?$/.test(value)) {
    value = `'${value}`;
  }
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * The CSV's columns, in order. Exported so the header, the row builder and the
 * tests all read one list — three spellings of a column order is how a file
 * ends up with its amounts under `merchant`.
 */
export const CSV_COLUMNS = [
  "id",
  "posted_at",
  "merchant",
  "amount",
  "currency",
  "direction",
  "category",
  "amount_home",
  "home_currency",
  "last4",
  "needs_review",
  "unparsed",
  "tier",
  "parse_error",
  "provenance",
  "splits",
  "superseded_by",
  "possible_duplicate_of",
  "ingest_id",
] as const;

/**
 * Splits, flattened into one cell.
 *
 * Lossy on purpose and named as such in {@link EXPORT_OMISSIONS}: a category
 * may itself contain `;` or `=`, so this string is a human summary and not a
 * parseable structure. The JSON export carries the real records.
 */
function splitSummary(splits: readonly Split[]): string {
  return splits.map((s) => `${s.category}=${decimalMinor(s.amount_minor)}`).join("; ");
}

/**
 * One CSV record.
 *
 * An **unparsed** row leaves `amount`, `currency` and `direction` empty rather
 * than writing `0.00` / `debit`. Task 7's whole point: a row with nothing
 * extracted is a message that arrived, not a zero-dirham purchase, and a
 * spreadsheet that sums the amount column must not silently count it.
 */
function csvRow(t: Txn, homeCurrency: string | null): string {
  const money = t.unparsed ? "" : decimalMinor(t.amount_minor);
  const fields: Record<(typeof CSV_COLUMNS)[number], string> = {
    id: t.id,
    posted_at: t.posted_at,
    merchant: t.merchant_raw,
    amount: money,
    currency: t.unparsed ? "" : t.currency,
    direction: t.direction,
    category: t.category ?? "",
    amount_home: t.amount_home_minor === null ? "" : decimalMinor(t.amount_home_minor),
    home_currency: t.amount_home_minor === null ? "" : (homeCurrency ?? ""),
    last4: t.last4,
    needs_review: t.needs_review ? "true" : "false",
    unparsed: t.unparsed ? "true" : "false",
    tier: t.tier,
    parse_error: t.parse_error ?? "",
    provenance: t.provenance,
    splits: splitSummary(t.splits),
    superseded_by: t.superseded_by ?? "",
    possible_duplicate_of: t.possible_duplicate_of ?? "",
    ingest_id: t.ingest_id,
  };
  return CSV_COLUMNS.map((c) => csvField(fields[c])).join(",");
}

// ---------------------------------------------------------------------------
// What each format is not
// ---------------------------------------------------------------------------

/**
 * The honest small print, as data, so the screen and the file cannot disagree
 * about it and a test can assert on it.
 *
 * Written as sentences a person can act on rather than as a schema note. "Does
 * not include the op log" means nothing to a user; "cannot be used to prove
 * these figures were not altered" is the thing they would want to know.
 */
export const EXPORT_OMISSIONS: Readonly<Record<ExportFormat, readonly string[]>> = {
  csv: [
    "Transactions only. Your categorisation rules, exchange rates, and ledger's own notices about duplicates and conflicts are not in this file — the JSON export has them.",
    "Split transactions are summarised into a single text cell, so a split whose category contains a semicolon cannot be read back apart. The JSON export keeps splits as records.",
    "Transactions that were later corrected or replaced are left out, so this is what your ledger says today rather than everything it has ever said.",
    "The original emails are not in it, and neither is the op log — this file cannot be used to prove the figures in it were not altered after export.",
  ],
  json: [
    "The op log itself is not in it: this is the fold of your log, not the signed records it was folded from, so it carries the content but not the provenance — who authored each change, in what order, under which chain hash — and cannot be re-verified.",
    "The original email bodies are not in it. They live in the cold stream, which this device prunes as it ages.",
    "Nothing secret is in it, deliberately: not your session, not this device's private key, not your inbound email address's credentials.",
    "It is a copy of what THIS device holds. A change made on another device that has not synced here yet is not in it.",
  ],
};

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

/**
 * Everything an export reads, with exactly one thing chunked.
 *
 * The asymmetry is deliberate. Rules, rates, forks and anomalies are bounded by
 * how many merchants and currencies a person has and how many conflicts their
 * devices produced — hundreds, at beta scale — so holding them in an array is a
 * cost that does not grow. Transactions are the only unbounded collection, and
 * they are the one the interface refuses to hand over in a single array. That
 * is the same rule `RowStore` enforces by deleting `all()`.
 */
export interface ExportSource {
  /** RFC3339, from the caller's clock. Named in the manifest and the filename. */
  generatedAt: string;
  homeCurrency: string | null;
  cursorHot: bigint;
  cursorCold: bigint;
  /**
   * How many transactions the source believes it holds.
   *
   * Read from the database independently of the rows themselves (a `count(*)`,
   * not a running tally of what was yielded), so the manifest's count and the
   * written rows are two measurements rather than one expression printed twice.
   * `export.test.ts` compares them.
   */
  txnCount: number;
  txnChunks(): Iterable<readonly Txn[]>;
  rules: readonly Rule[];
  rates: ReadonlyMap<string, bigint | null>;
  forks: readonly ForkNotice[];
  anomalies: readonly Anomaly[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A yield point. The generator emits one after each transaction chunk. */
const CHUNK_BREAK = Symbol("chunk");

type Piece = string | typeof CHUNK_BREAK;

function* renderCsv(src: ExportSource): Generator<Piece> {
  yield `${CSV_COLUMNS.join(",")}\n`;
  for (const chunk of src.txnChunks()) {
    let buf = "";
    for (const t of chunk) buf += `${csvRow(t, src.homeCurrency)}\n`;
    yield buf;
    yield CHUNK_BREAK;
  }
}

/**
 * The JSON document, emitted as a stream.
 *
 * The transactions array is **last** so that the only unbounded section is the
 * tail: everything before it is a bounded prefix that can be built in one
 * string, and the part that streams needs no lookahead. `export.test.ts`
 * asserts the bytes are identical at chunk size 1 and 999, which is the
 * property that says the streaming is a serialization detail and not a
 * semantic one.
 */
function* renderJson(src: ExportSource): Generator<Piece> {
  const head = {
    ledger_export: {
      format: "json" as const,
      generated_at: src.generatedAt,
      transaction_count: src.txnCount,
      cursor_hot: src.cursorHot.toString(10),
      cursor_cold: src.cursorCold.toString(10),
      money: `amounts are exact integer minor units (${MINOR_DIGITS.toString(10)} decimal places) as strings; "amount" is the same value with a decimal point`,
      omits: [...EXPORT_OMISSIONS.json],
    },
    home_currency: src.homeCurrency,
    rules: src.rules.map((r) => ({
      pattern: r.pattern,
      match: r.match,
      category: r.category,
      priority: r.priority,
      version: r.version,
    })),
    rates: [...src.rates].map(([currency, micro]) => ({
      currency,
      rate_micro: micro === null ? null : micro.toString(10),
    })),
    forks: src.forks.map((f) => ({
      entity_kind: f.entity.kind,
      entity_id: f.entity.id,
      winner_op: f.winner_op,
      loser_op: f.loser_op,
      at_seq: f.at_seq.toString(10),
    })),
    anomalies: src.anomalies.map((a) => ({ kind: a.kind, detail: a.detail, at_seq: a.at_seq.toString(10) })),
  };
  // Serialized whole and then unwrapped by one character, so the escaping of
  // every bounded section is `JSON.stringify`'s and not this file's.
  const prefix = JSON.stringify(head);
  yield `${prefix.slice(0, -1)},"transactions":[`;

  let first = true;
  for (const chunk of src.txnChunks()) {
    let buf = "";
    for (const t of chunk) {
      buf += `${first ? "" : ","}${JSON.stringify(jsonTxn(t))}`;
      first = false;
    }
    yield buf;
    yield CHUNK_BREAK;
  }
  yield "]}";
}

/**
 * One transaction, with every `bigint` already a string.
 *
 * `JSON.stringify` **throws** on a `bigint` rather than coercing it, and
 * `export.test.ts` pins that. So a field added here and forgotten is a red
 * test, not a file with `[object Object]` where an amount should be.
 */
function jsonTxn(t: Txn): Record<string, unknown> {
  return {
    id: t.id,
    ingest_id: t.ingest_id,
    posted_at: t.posted_at,
    merchant_raw: t.merchant_raw,
    amount_minor: t.unparsed ? null : t.amount_minor.toString(10),
    amount: t.unparsed ? null : decimalMinor(t.amount_minor),
    currency: t.currency,
    direction: t.direction,
    category: t.category,
    amount_home_minor: t.amount_home_minor === null ? null : t.amount_home_minor.toString(10),
    amount_home: t.amount_home_minor === null ? null : decimalMinor(t.amount_home_minor),
    needs_review: t.needs_review,
    unparsed: t.unparsed,
    tier: t.tier,
    parse_error: t.parse_error,
    provenance: t.provenance,
    splits: t.splits.map((s) => ({
      category: s.category,
      amount_minor: s.amount_minor.toString(10),
      amount: decimalMinor(s.amount_minor),
    })),
    superseded_by: t.superseded_by,
    possible_duplicate_of: t.possible_duplicate_of,
    version: t.version,
  };
}

/** The whole document, as a stream of pieces. */
export function renderExport(src: ExportSource, format: ExportFormat): Generator<Piece> {
  return format === "csv" ? renderCsv(src) : renderJson(src);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteExportOptions {
  /**
   * Awaited at every chunk boundary. On the device this is
   * `() => new Promise(r => setTimeout(r, 0))` — the same yield Phase 0's fix
   * turned on, which is what lets the UI redraw between chunks.
   *
   * Note what it does NOT buy, because Phase 0 measured it: total time *inside*
   * the yields across a 58 s restore was 1.9–4.2 ms. The JS thread still runs
   * in slabs. The yield restores the garbage collector and lets a pending
   * touch land; work that must not block the thread has to leave it.
   */
  between?: (chunk: number) => Promise<void> | void;
  /** Consulted at each boundary; a `true` abandons the write. */
  cancelled?: () => boolean;
}

export class ExportCancelled extends Error {
  constructor(readonly chunk: number) {
    super(`export cancelled after ${chunk} chunk${chunk === 1 ? "" : "s"}`);
    this.name = "ExportCancelled";
  }
}

export interface ExportReport {
  /** Bytes handed to the sink, measured at the sink. */
  bytes: number;
  /** Pieces of transaction data written. One yield happened between each pair. */
  chunks: number;
}

/**
 * Drives a rendered export into a sink, yielding between chunks.
 *
 * `bytes` is UTF-8 length measured as each piece goes past, not
 * `text.length` — a merchant name in Arabic is two or three bytes per
 * character, and a size shown to a user that disagrees with the file on disk is
 * a small lie in the one screen whose whole job is being trustworthy about what
 * the file contains.
 */
export async function writeExport(
  pieces: Iterable<Piece>,
  sink: (text: string) => void | Promise<void>,
  opts: WriteExportOptions = {},
): Promise<ExportReport> {
  const encoder = new TextEncoder();
  let bytes = 0;
  let chunks = 0;
  for (const piece of pieces) {
    if (piece === CHUNK_BREAK) {
      if (opts.cancelled?.() === true) throw new ExportCancelled(chunks);
      await opts.between?.(chunks);
      continue;
    }
    if (piece === "") continue;
    bytes += encoder.encode(piece).length;
    chunks++;
    await sink(piece);
  }
  return { bytes, chunks };
}

/**
 * The filename a share sheet shows.
 *
 * Date only, no time: two exports on one day overwrite each other in the cache
 * directory, which is the desired behaviour for a scratch file that exists for
 * the length of a share sheet.
 *
 * Every character outside `[A-Za-z0-9._-]` is dropped, so a malformed clock
 * reading cannot put a `/` in a path.
 */
export function exportFileName(format: ExportFormat, generatedAt: string): string {
  const day = generatedAt.slice(0, 10).replace(/[^A-Za-z0-9-]/g, "");
  return `ledger-${day}.${format}`;
}
