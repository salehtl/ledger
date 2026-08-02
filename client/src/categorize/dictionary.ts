/**
 * The device's copy of the global merchant dictionary, and the pass that
 * proposes categories for transactions that do not have one.
 *
 * # What this holds, and what it deliberately does not
 *
 * `GET /api/v1/dictionary?since=<version>` is a delta feed: `{version, entries,
 * removed}`, the same bytes for every client, with no user id anywhere in the
 * request's answer. This module stores what it returns and advances the cursor.
 *
 * There is **no submission path here**. `internal/v2/dict.Submit` exists and is
 * deliberately unexposed: its own package doc records that it has neither a rate
 * limit nor a per-user entry cap, and that both must land before any client
 * endpoint reaches it. Until they do, this device consumes published entries and
 * contributes nothing. The consent copy the plan's Task 20 Step 4 asks for
 * belongs to that route, not to this one, and writing it now would describe a
 * disclosure the beta does not make.
 *
 * # The dictionary is NOT part of the projection
 *
 * `replay/projection.ts` is a cache of a pure function of the op log and is
 * dropped and rebuilt whenever it looks stale. The dictionary is not derived
 * from the log at all — it is server state, paged in by cursor — so it lives in
 * its own tables, and `project()`'s `DELETE FROM` list does not name them. If it
 * did, every re-projection would silently reset the cursor to 0 and re-download
 * the dictionary, which is the kind of bug that shows up as a data-usage
 * complaint months later.
 *
 * # Never rewrite the user's decision
 *
 * {@link proposeCategories} scans ONLY rows with `category IS NULL`. A row that
 * already carries a category is left alone whatever the dictionary now says,
 * because there is no way to tell the user's own confirmation apart from an
 * earlier auto-categorization once both are `txn_categorized` ops — and the
 * fail-safe reading of that ambiguity is "do not touch it". The cost is that a
 * dictionary correction never reaches a row that was auto-categorized wrongly;
 * the user re-categorizes it from the transaction screen, which is a visible
 * action, and their rule then wins forever.
 *
 * Two more exclusions, both in SQL and both tested on their own, because a total
 * that silently absorbs the wrong rows is wrong in a way no user can see:
 *
 *   - `unparsed = 0`. An unparsed row has no merchant; categorizing it would
 *     invent one.
 *   - `superseded_by IS NULL`. A superseded row is history.
 *
 * # Chunked, and yielding
 *
 * The scan is keyset-paged at {@link CANDIDATE_CHUNK} rows and awaits
 * `between()` after each page, the same shape `project()` uses. The yield is the
 * load-bearing part — Phase 0's freeze post-mortem is explicit that chunking
 * without a yield restores nothing.
 *
 * # Host imports
 *
 * None. `SqlDriver` is `import type` only, exactly as `projection.ts` does, so
 * this module reaches Hermes and drags no `bun:sqlite` with it.
 */

import type { SqlDriver } from "../store/driver";
import { projectionIsUsable, readRules } from "../replay/projection";
import {
  type DictEntry,
  type Decision,
  type Defect,
  type PreparedRules,
  type UserRule,
  categorize,
  prepare,
  validateDictEntry,
} from "./rules";

/** Rows read per page, and per yield. `projection.ts`'s `PROJECT_CHUNK`. */
export const CANDIDATE_CHUNK = 250;

export const DICTIONARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS dict_entry (
  pattern  TEXT NOT NULL,
  match    TEXT NOT NULL,
  category TEXT NOT NULL,
  PRIMARY KEY (pattern, category)
);

CREATE TABLE IF NOT EXISTS dict_meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version TEXT    NOT NULL
);
`;

/**
 * A server response that does not fit the contract.
 *
 * Thrown rather than tolerated. Every case below means the client's cursor
 * bookkeeping or the server's is wrong, and applying a delta on top of that
 * produces a dictionary nobody can reason about — which then silently
 * mis-categorizes. Refusing is visible; guessing is not.
 */
export class DictionaryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DictionaryProtocolError";
  }
}

/** One decoded page of the feed. `version` is the cursor to send back next. */
export interface DictionaryDelta {
  version: bigint;
  entries: DictEntry[];
  removed: DictEntry[];
}

/** What {@link applyDictionaryDelta} did. */
export interface DictionaryApplyReport {
  /** Entries stored (inserted or replaced). */
  applied: number;
  /** Entries deleted because the server retracted them. */
  removed: number;
  /**
   * Entries the load-time gate refused. Not silent: a device holding a
   * dictionary the server thinks it sent is a support question, and this is the
   * answer to it.
   */
  refused: Defect[];
  /** The cursor after the delta. */
  cursor: bigint;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Decodes `GET /api/v1/dictionary`'s body.
 *
 * `version` is a DECIMAL STRING on the wire because it is an `int64` in Go and
 * `JSON.parse` would land it in a float64 — the same rule `seq` and
 * `writer_counter` follow. A JSON number here is refused rather than coerced:
 * accepting it is how a cursor past 2^53 starts skipping pages.
 */
export function decodeDictionaryDelta(raw: unknown): DictionaryDelta {
  if (typeof raw !== "object" || raw === null) throw new DictionaryProtocolError("dictionary response is not an object");
  const r = raw as Record<string, unknown>;
  const v = r["version"];
  if (typeof v !== "string" || !DECIMAL.test(v)) {
    throw new DictionaryProtocolError(`dictionary version must be a decimal string, got ${JSON.stringify(v)}`);
  }
  return {
    version: BigInt(v),
    entries: decodeEntries(r["entries"], "entries"),
    removed: decodeEntries(r["removed"], "removed"),
  };
}

function decodeEntries(raw: unknown, what: string): DictEntry[] {
  // Always an array, never null: api/dict.go is explicit that both fields are
  // arrays precisely so a device does not have to distinguish "no changes" from
  // "the field was missing".
  if (!Array.isArray(raw)) throw new DictionaryProtocolError(`dictionary ${what} is not an array`);
  return raw.map((e, i) => {
    if (typeof e !== "object" || e === null) throw new DictionaryProtocolError(`dictionary ${what}[${i}] is not an object`);
    const o = e as Record<string, unknown>;
    const s = (k: string): string => {
      const val = o[k];
      if (typeof val !== "string") throw new DictionaryProtocolError(`dictionary ${what}[${i}].${k} is not a string`);
      return val;
    };
    return { pattern: s("pattern"), match: s("match"), category: s("category") };
  });
}

/** Creates the tables if they are not there. Idempotent. */
export function ensureDictionary(db: SqlDriver): void {
  db.exec(DICTIONARY_SCHEMA);
}

/** The cursor to send as `?since=`. Zero when nothing has ever been synced. */
export function dictionaryCursor(db: SqlDriver): bigint {
  ensureDictionary(db);
  const rows = db.prepare("SELECT version FROM dict_meta WHERE id = 1").all();
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return 0n;
  const v = row["version"];
  if (typeof v !== "string" || !DECIMAL.test(v)) throw new DictionaryProtocolError("stored dictionary cursor is not a decimal string");
  return BigInt(v);
}

/** Every stored entry, ordered so two devices read them identically. */
export function readDictionary(db: SqlDriver): DictEntry[] {
  ensureDictionary(db);
  const out: DictEntry[] = [];
  for (const raw of db.prepare("SELECT pattern, match, category FROM dict_entry ORDER BY pattern, category").all()) {
    const r = raw as Record<string, unknown>;
    out.push({ pattern: String(r["pattern"]), match: String(r["match"]), category: String(r["category"]) });
  }
  return out;
}

/**
 * Empties the local dictionary and resets the cursor to 0, so the next sync
 * pulls the whole feed.
 *
 * The only way to get a full resync, and it is explicit for a reason: `since=0`
 * carries an empty `removed` list by design (a client with nothing has nothing
 * to remove), so a client that quietly restarted from 0 while holding entries
 * would keep serving retracted ones forever.
 */
export function resetDictionary(db: SqlDriver): void {
  ensureDictionary(db);
  db.transaction(() => {
    db.exec("DELETE FROM dict_entry");
    db.exec("DELETE FROM dict_meta");
  });
}

/**
 * Applies one page of the feed and advances the cursor, in one transaction.
 *
 * Three refusals, each of which is a server contradiction rather than a
 * situation to recover from:
 *
 *   - A cursor that goes BACKWARDS. `dict.Since` returns `max(since, highest
 *     visible version)`, so it is monotone by construction; a lower one means
 *     this response does not belong to this client's history.
 *   - An entry named in BOTH `entries` and `removed`. The server cannot produce
 *     it — one row is either publishable or retracted — and there is no reading
 *     of it that is safe to guess at.
 *   - A `removed` list against a cursor of 0. `dict.Since` sends none, because a
 *     client starting from scratch has nothing to remove and the list would name
 *     patterns it is not allowed to learn.
 */
export function applyDictionaryDelta(db: SqlDriver, delta: DictionaryDelta): DictionaryApplyReport {
  ensureDictionary(db);
  const cursor = dictionaryCursor(db);
  if (delta.version < cursor) {
    throw new DictionaryProtocolError(`dictionary cursor went backwards: have ${cursor}, server sent ${delta.version}`);
  }
  if (cursor === 0n && delta.removed.length > 0) {
    throw new DictionaryProtocolError("dictionary delta from cursor 0 names retractions, which the feed never sends");
  }

  const refused: Defect[] = [];
  const keep = new Map<string, DictEntry>();
  for (const e of delta.entries) {
    const v = validateDictEntry(e);
    if ("defect" in v) {
      refused.push(v.defect);
      continue;
    }
    keep.set(key(v.entry), v.entry);
  }
  const drop = new Map<string, DictEntry>();
  for (const e of delta.removed) {
    const v = validateDictEntry(e);
    if ("defect" in v) {
      refused.push(v.defect);
      continue;
    }
    const k = key(v.entry);
    if (keep.has(k)) {
      throw new DictionaryProtocolError(`dictionary delta both publishes and retracts ${v.entry.pattern}`);
    }
    drop.set(k, v.entry);
  }

  const put = db.prepare("INSERT INTO dict_entry (pattern, match, category) VALUES (?, ?, ?) ON CONFLICT(pattern, category) DO UPDATE SET match = excluded.match");
  const del = db.prepare("DELETE FROM dict_entry WHERE pattern = ? AND category = ?");
  const meta = db.prepare("INSERT INTO dict_meta (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version");
  db.transaction(() => {
    for (const e of keep.values()) put.run(e.pattern, e.match, e.category);
    for (const e of drop.values()) del.run(e.pattern, e.category);
    meta.run(delta.version.toString());
  });
  return { applied: keep.size, removed: drop.size, refused, cursor: delta.version };
}

function key(e: DictEntry): string {
  // The primary key `dict_entries` uses. ` ` cannot occur in either field:
  // both are canonicalized, and `validateDictEntry` refuses an unprintable.
  return `${e.pattern} ${e.category}`;
}

/**
 * Fetches one page and applies it. `fetch` is injected rather than imported.
 *
 * `net/client.ts` owns every authenticated request in this codebase and has no
 * dictionary method yet; this is the seam it plugs into, so that the applier
 * above is testable without a server and so that nothing here reimplements
 * `Client`'s auth, retry or error handling. One line in `Client`:
 *
 *     dictionary(since: bigint) { return this.request("GET", `/api/v1/dictionary?since=${since}`); }
 *
 * and then `syncDictionary(db, (since) => client.dictionary(since))`.
 */
export type DictionaryFetch = (since: bigint) => Promise<unknown>;

/** Pulls one page from `since = ` the stored cursor and applies it. */
export async function syncDictionary(db: SqlDriver, fetch: DictionaryFetch): Promise<DictionaryApplyReport> {
  const since = dictionaryCursor(db);
  return applyDictionaryDelta(db, decodeDictionaryDelta(await fetch(since)));
}

/**
 * The user's own rules, out of the projection, with their entity ids.
 *
 * `readRules` keys the map by entity id and the {@link UserRule} carries it as a
 * field, because the id is part of the matcher's tiebreak — a caller that
 * dropped it would make the order depend on the Map again. This adapter exists
 * so no screen has to remember that.
 */
export function readUserRules(db: SqlDriver): UserRule[] {
  const out: UserRule[] = [];
  for (const [id, r] of readRules(db)) {
    out.push({ id, pattern: r.pattern, match: r.match, category: r.category, priority: r.priority });
  }
  return out;
}

/**
 * Everything the matcher needs, read from this device's own storage: the user's
 * rules out of the projection and the dictionary out of its own tables.
 *
 * The one call a screen makes. Validation, canonicalization, regex compilation
 * and ordering all happen here, once.
 */
export function prepareFromStore(db: SqlDriver): PreparedRules {
  return prepare(readUserRules(db), readDictionary(db));
}

/** One transaction with no category yet. */
export interface Candidate {
  id: string;
  merchant_raw: string;
}

/** A category this pass would give a transaction, and what decided it. */
export interface Proposal {
  txn_id: string;
  decision: Extract<Decision, { category: string }>;
}

export interface ProposeOptions {
  chunkSize?: number;
  /** Awaited between pages. Pass the `setTimeout(0)` yield on a device. */
  between?: (chunk: number) => Promise<void> | void;
  /** Consulted at every page boundary. */
  cancelled?: () => boolean;
}

export interface ProposeReport {
  /** Candidate rows read. */
  scanned: number;
  /** Rows a rule or the dictionary resolved. */
  proposed: number;
  /** Pages read; `chunks - 1` yields happened between them. */
  chunks: number;
}

/**
 * Walks every uncategorized, parsed, live transaction and hands each proposal to
 * `sink`.
 *
 * Streaming rather than array-returning on purpose: the caller is the writer,
 * which batches ops, and a function that collected 3,683 proposals into a JS
 * array before anyone could act on one of them is the read-everything shape this
 * codebase is written against.
 *
 * It emits proposals and appends NOTHING. Turning a proposal into a
 * `txn_categorized` op is the writer's job (Task 18/19), and it needs the
 * entity's current head version, which lives in the projection and can go stale
 * between this scan and the append — so it must be re-read at emit time, never
 * carried along from here.
 */
export async function proposeCategories(
  db: SqlDriver,
  prepared: PreparedRules,
  sink: (p: Proposal) => void | Promise<void>,
  opts: ProposeOptions = {},
): Promise<ProposeReport> {
  const chunkSize = opts.chunkSize ?? CANDIDATE_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`proposeCategories needs a positive integer chunk size, got ${String(chunkSize)}`);
  }
  if (!projectionIsUsable(db)) {
    throw new Error("proposeCategories needs a complete projection at the current version");
  }
  const page = db.prepare(
    `SELECT id, merchant_raw FROM txn
      WHERE category IS NULL AND unparsed = 0 AND superseded_by IS NULL AND id > ?
      ORDER BY id LIMIT ?`,
  );
  const report: ProposeReport = { scanned: 0, proposed: 0, chunks: 0 };
  let after = "";
  for (;;) {
    if (opts.cancelled?.() === true) return report;
    const rows = page.all(after, chunkSize);
    if (rows.length === 0) return report;
    report.chunks++;
    for (const raw of rows) {
      const r = raw as Record<string, unknown>;
      const id = String(r["id"]);
      after = id;
      report.scanned++;
      const d = categorize(String(r["merchant_raw"] ?? ""), prepared);
      if (d.category === null) continue;
      report.proposed++;
      await sink({ txn_id: id, decision: d });
    }
    // The yield, not the chunking, is what gives the collector a turn.
    if (opts.between !== undefined) await opts.between(report.chunks);
    if (rows.length < chunkSize) return report;
  }
}

/** How many rows {@link proposeCategories} would look at. A SQL aggregate. */
export function countUncategorized(db: SqlDriver): number {
  const rows = db
    .prepare("SELECT count(*) AS n FROM txn WHERE category IS NULL AND unparsed = 0 AND superseded_by IS NULL")
    .all();
  const r = rows[0] as Record<string, unknown> | undefined;
  return r === undefined ? 0 : Number(r["n"]);
}
