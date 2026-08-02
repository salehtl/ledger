import { afterEach, expect, test } from "bun:test";

import {
  CANDIDATE_CHUNK,
  DictionaryProtocolError,
  applyDictionaryDelta,
  countUncategorized,
  decodeDictionaryDelta,
  dictionaryCursor,
  ensureDictionary,
  prepareFromStore,
  proposeCategories,
  readDictionary,
  readUserRules,
  resetDictionary,
  syncDictionary,
  type Proposal,
} from "./dictionary";
import { type DictEntry, type UserRule, prepare } from "./rules";
import { project } from "../replay/projection";
import { emptyState, type Txn } from "../replay/state";
import { bunDriver, type SqlDriver } from "../store/driver";

const drivers: SqlDriver[] = [];

function db(): SqlDriver {
  const d = bunDriver(":memory:");
  drivers.push(d);
  return d;
}

afterEach(() => {
  for (const d of drivers.splice(0)) d.close();
});

// ---------------------------------------------------------------------------
// A projection fixture that is hostile on purpose.
//
// TWO rows of every kind that has to be excluded, and two of the kind that has
// to be included, because one of anything cannot tell "excluded correctly" from
// "there was nothing there". The already-categorized row carries a category
// that DISAGREES with the rule matching it, so a pass that rewrote it would
// change a value rather than write the same one back.
// ---------------------------------------------------------------------------

function txn(id: string, over: Partial<Txn>): Txn {
  return {
    id,
    ingest_id: `ing-${id}`,
    amount_minor: 1000n,
    currency: "AED",
    direction: "debit",
    posted_at: "2026-07-01T10:00:00.000Z",
    merchant_raw: "CARREFOUR HYPER",
    last4: "1234",
    category: null,
    needs_review: false,
    unparsed: false,
    tier: "template",
    parse_error: null,
    provenance: "ingest",
    amount_home_minor: 1000n,
    splits: [],
    superseded_by: null,
    possible_duplicate_of: null,
    version: 1,
    ...over,
  };
}

const FIXTURE: Txn[] = [
  txn("t01", {}), // rule match
  txn("t02", { merchant_raw: "carrefour city" }), // rule match, same rule
  txn("t03", { merchant_raw: "NOON.COM" }), // dictionary match
  txn("t04", { merchant_raw: "noon express" }), // dictionary match
  txn("t05", { merchant_raw: "DR ALIA CLINIC" }), // nothing matches
  txn("t06", { merchant_raw: "SOME CLINIC" }), // nothing matches
  txn("t07", { category: "gifts" }), // already categorized: rule says groceries
  txn("t08", { merchant_raw: "NOON.COM", category: "gifts" }), // already categorized: dict says shopping
  txn("t09", { merchant_raw: "", unparsed: true, tier: "none", direction: "", amount_minor: 0n }),
  txn("t10", { merchant_raw: "", unparsed: true, tier: "none", direction: "", amount_minor: 0n }),
  txn("t11", { superseded_by: "t01" }),
  txn("t12", { merchant_raw: "NOON.COM", superseded_by: "t03" }),
];

async function projected(): Promise<SqlDriver> {
  const d = db();
  const s = emptyState();
  for (const t of FIXTURE) s.txns.set(t.id, t);
  await project(d, s);
  return d;
}

const RULES: UserRule[] = [{ id: "rule-1", pattern: "carrefour", match: "contains", category: "groceries", priority: 10 }];
const ENTRIES: DictEntry[] = [{ pattern: "noon", match: "contains", category: "shopping" }];

async function collect(d: SqlDriver, opts = {}): Promise<{ proposals: Proposal[]; chunks: number; scanned: number }> {
  const proposals: Proposal[] = [];
  const report = await proposeCategories(d, prepare(RULES, ENTRIES), (p) => void proposals.push(p), opts);
  return { proposals, chunks: report.chunks, scanned: report.scanned };
}

// ---------------------------------------------------------------------------
// The delta feed
// ---------------------------------------------------------------------------

test("a delta is stored and the cursor advances", () => {
  const d = db();
  expect(dictionaryCursor(d)).toBe(0n);
  const r = applyDictionaryDelta(d, {
    version: 7n,
    entries: [
      { pattern: "carrefour", match: "contains", category: "groceries" },
      { pattern: "noon", match: "contains", category: "shopping" },
    ],
    removed: [],
  });
  expect(r).toEqual({ applied: 2, removed: 0, refused: [], cursor: 7n });
  expect(dictionaryCursor(d)).toBe(7n);
  expect(readDictionary(d)).toEqual([
    { pattern: "carrefour", match: "contains", category: "groceries" },
    { pattern: "noon", match: "contains", category: "shopping" },
  ]);
});

test("entries are stored CANONICALIZED, so a pattern matches what the device folds", () => {
  const d = db();
  applyDictionaryDelta(d, {
    version: 1n,
    entries: [{ pattern: "  CARREFOUR  Hyper ", match: "contains", category: "Groceries" }],
    removed: [],
  });
  expect(readDictionary(d)).toEqual([{ pattern: "carrefour hyper", match: "contains", category: "groceries" }]);
});

test("a retraction deletes only the entry it names", () => {
  const d = db();
  applyDictionaryDelta(d, {
    version: 1n,
    entries: [
      { pattern: "carrefour", match: "contains", category: "groceries" },
      { pattern: "noon", match: "contains", category: "shopping" },
    ],
    removed: [],
  });
  const r = applyDictionaryDelta(d, {
    version: 2n,
    entries: [],
    removed: [{ pattern: "noon", match: "contains", category: "shopping" }],
  });
  expect(r.removed).toBe(1);
  expect(readDictionary(d)).toEqual([{ pattern: "carrefour", match: "contains", category: "groceries" }]);
});

test("two entries sharing a pattern are separate rows, and one can be retracted alone", () => {
  // dict_entries' primary key is (pattern, category), not pattern. A local
  // store keyed on pattern alone would silently drop one of these and then
  // delete the wrong one.
  const d = db();
  applyDictionaryDelta(d, {
    version: 1n,
    entries: [
      { pattern: "noon", match: "contains", category: "shopping" },
      { pattern: "noon", match: "contains", category: "groceries" },
    ],
    removed: [],
  });
  expect(readDictionary(d)).toHaveLength(2);
  applyDictionaryDelta(d, {
    version: 2n,
    entries: [],
    removed: [{ pattern: "noon", match: "contains", category: "groceries" }],
  });
  expect(readDictionary(d)).toEqual([{ pattern: "noon", match: "contains", category: "shopping" }]);
});

test("an entry the load gate refuses is never stored, and is reported", () => {
  const d = db();
  const r = applyDictionaryDelta(d, {
    version: 3n,
    entries: [
      { pattern: "on", match: "contains", category: "charity" },
      { pattern: "^carrefour", match: "regex", category: "groceries" },
      { pattern: "noon", match: "contains", category: "shopping" },
    ],
    removed: [],
  });
  expect(r.applied).toBe(1);
  expect(r.refused.map((x) => x.code).sort()).toEqual(["contains_too_short", "regex_not_allowed"]);
  expect(readDictionary(d)).toEqual([{ pattern: "noon", match: "contains", category: "shopping" }]);
  // The cursor still advances: the server said these versions are gone, and
  // stalling on them would re-download the same refusal forever.
  expect(dictionaryCursor(d)).toBe(3n);
});

test("a row that reached the table some other way still cannot match", () => {
  // The gate runs at the network boundary AND at prepare time. This is the
  // second one on its own: the bad row is inserted straight into SQLite.
  const d = db();
  ensureDictionary(d);
  d.prepare("INSERT INTO dict_entry (pattern, match, category) VALUES (?, ?, ?)").run("on", "contains", "charity");
  const p = prepare([], readDictionary(d));
  expect(p.entries).toHaveLength(0);
  expect(p.defects.map((x) => x.code)).toEqual(["contains_too_short"]);
});

test("a cursor that goes backwards is refused", () => {
  const d = db();
  applyDictionaryDelta(d, { version: 9n, entries: [], removed: [] });
  expect(() => applyDictionaryDelta(d, { version: 8n, entries: [], removed: [] })).toThrow(DictionaryProtocolError);
  expect(dictionaryCursor(d)).toBe(9n);
  // A repeat of the same version is not backwards, and is idempotent.
  expect(applyDictionaryDelta(d, { version: 9n, entries: [], removed: [] }).cursor).toBe(9n);
});

test("a delta that both publishes and retracts one entry is refused, and changes nothing", () => {
  const d = db();
  applyDictionaryDelta(d, {
    version: 1n,
    entries: [{ pattern: "carrefour", match: "contains", category: "groceries" }],
    removed: [],
  });
  expect(() =>
    applyDictionaryDelta(d, {
      version: 2n,
      entries: [{ pattern: "noon", match: "contains", category: "shopping" }],
      removed: [{ pattern: "noon", match: "contains", category: "shopping" }],
    }),
  ).toThrow(DictionaryProtocolError);
  expect(readDictionary(d)).toEqual([{ pattern: "carrefour", match: "contains", category: "groceries" }]);
  expect(dictionaryCursor(d)).toBe(1n);
});

test("retractions against a cursor of 0 are refused: the feed never sends them", () => {
  const d = db();
  expect(() =>
    applyDictionaryDelta(d, {
      version: 4n,
      entries: [],
      removed: [{ pattern: "noon", match: "contains", category: "shopping" }],
    }),
  ).toThrow(DictionaryProtocolError);
});

test("resetDictionary empties the table and the cursor together", () => {
  const d = db();
  applyDictionaryDelta(d, {
    version: 5n,
    entries: [{ pattern: "noon", match: "contains", category: "shopping" }],
    removed: [],
  });
  resetDictionary(d);
  expect(dictionaryCursor(d)).toBe(0n);
  expect(readDictionary(d)).toEqual([]);
});

test("the version is a decimal STRING on the wire, and a JSON number is refused", () => {
  expect(decodeDictionaryDelta({ version: "12", entries: [], removed: [] }).version).toBe(12n);
  // 2^53 + 1: the value JSON.parse cannot hold, which is the whole reason the
  // field is a string.
  expect(decodeDictionaryDelta({ version: "9007199254740993", entries: [], removed: [] }).version).toBe(
    9007199254740993n,
  );
  for (const bad of [
    { version: 12, entries: [], removed: [] },
    { version: "12.0", entries: [], removed: [] },
    { version: "-1", entries: [], removed: [] },
    { version: "012", entries: [], removed: [] },
    { version: "12", entries: null, removed: [] },
    { version: "12", entries: [], removed: undefined },
    { version: "12", entries: [{ pattern: "x" }], removed: [] },
    null,
  ]) {
    expect(() => decodeDictionaryDelta(bad)).toThrow(DictionaryProtocolError);
  }
});

test("syncDictionary asks for the stored cursor and applies what comes back", async () => {
  const d = db();
  const asked: bigint[] = [];
  const fetch = async (since: bigint): Promise<unknown> => {
    asked.push(since);
    return since === 0n
      ? { version: "4", entries: [{ pattern: "noon", match: "contains", category: "shopping" }], removed: [] }
      : { version: "6", entries: [], removed: [{ pattern: "noon", match: "contains", category: "shopping" }] };
  };
  expect((await syncDictionary(d, fetch)).applied).toBe(1);
  expect((await syncDictionary(d, fetch)).removed).toBe(1);
  expect(asked).toEqual([0n, 4n]);
  expect(dictionaryCursor(d)).toBe(6n);
  expect(readDictionary(d)).toEqual([]);
});

test("the dictionary survives a re-projection", () => {
  // It is server state paged in by cursor, not a fold of the log, so
  // project()'s DELETE list must not name its tables. If it ever does, every
  // re-projection silently re-downloads the whole dictionary.
  const d = db();
  applyDictionaryDelta(d, {
    version: 11n,
    entries: [{ pattern: "noon", match: "contains", category: "shopping" }],
    removed: [],
  });
  return project(d, emptyState()).then(() => {
    expect(dictionaryCursor(d)).toBe(11n);
    expect(readDictionary(d)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The re-categorization pass
// ---------------------------------------------------------------------------

test("only uncategorized, parsed, live rows are proposed", async () => {
  const d = await projected();
  const { proposals, scanned } = await collect(d);
  expect(proposals.map((p) => p.txn_id).sort()).toEqual(["t01", "t02", "t03", "t04"]);
  // Six candidates were read: the four above plus the two nothing matched.
  expect(scanned).toBe(6);
  expect(countUncategorized(d)).toBe(6);
});

test("a row that already has a category is never proposed, whatever the rules now say", async () => {
  const d = await projected();
  const { proposals } = await collect(d);
  // t07 contains-matches `carrefour -> groceries` and t08 matches
  // `noon -> shopping`, and both carry `gifts`. A pass that rewrote a user's
  // decision would show up here as a changed value, not merely an extra row.
  expect(proposals.some((p) => p.txn_id === "t07" || p.txn_id === "t08")).toBe(false);
});

test("unparsed rows are excluded, and there are two of them", async () => {
  const d = await projected();
  const { proposals } = await collect(d);
  expect(proposals.some((p) => p.txn_id === "t09" || p.txn_id === "t10")).toBe(false);
  // Control: they really are in the table, so the exclusion is doing work.
  const rows = d.prepare("SELECT count(*) AS n FROM txn WHERE unparsed = 1").all() as Array<Record<string, unknown>>;
  expect(Number(rows[0]?.["n"])).toBe(2);
});

test("superseded rows are excluded, and there are two of them", async () => {
  const d = await projected();
  const { proposals } = await collect(d);
  expect(proposals.some((p) => p.txn_id === "t11" || p.txn_id === "t12")).toBe(false);
  const rows = d
    .prepare("SELECT count(*) AS n FROM txn WHERE superseded_by IS NOT NULL")
    .all() as Array<Record<string, unknown>>;
  expect(Number(rows[0]?.["n"])).toBe(2);
});

test("a proposal carries what decided it", async () => {
  const d = await projected();
  const { proposals } = await collect(d);
  const byRule = proposals.find((p) => p.txn_id === "t01");
  expect(byRule?.decision).toEqual({
    category: "groceries",
    source: "rule",
    id: "rule-1",
    pattern: "carrefour",
    match: "contains",
  });
  const byDict = proposals.find((p) => p.txn_id === "t03");
  expect(byDict?.decision).toEqual({ category: "shopping", source: "dictionary", pattern: "noon", match: "contains" });
});

test("the scan is paged and yields between pages", async () => {
  const d = await projected();
  const seen: number[] = [];
  const proposals: Proposal[] = [];
  const report = await proposeCategories(d, prepare(RULES, ENTRIES), (p) => void proposals.push(p), {
    chunkSize: 2,
    between: (c) => void seen.push(c),
  });
  // Six candidates at two per page.
  expect(report.chunks).toBe(3);
  expect(seen).toEqual([1, 2, 3]);
  expect(proposals).toHaveLength(4);
  // And the paging does not change the answer.
  const whole = await collect(d);
  expect(proposals.map((p) => p.txn_id)).toEqual(whole.proposals.map((p) => p.txn_id));
});

test("the default page size is the one the projection uses", () => {
  expect(CANDIDATE_CHUNK).toBe(250);
});

test("a cancelled scan stops early and reports what it did", async () => {
  const d = await projected();
  const proposals: Proposal[] = [];
  let pages = 0;
  const report = await proposeCategories(d, prepare(RULES, ENTRIES), (p) => void proposals.push(p), {
    chunkSize: 2,
    cancelled: () => pages++ >= 1,
  });
  expect(report.chunks).toBe(1);
  expect(proposals).toHaveLength(2);
});

test("the pass proposes nothing when there are no rules and no dictionary", async () => {
  const d = await projected();
  const proposals: Proposal[] = [];
  const report = await proposeCategories(d, prepare([], []), (p) => void proposals.push(p));
  expect(proposals).toEqual([]);
  // It still READ the candidates, so an empty result is "nothing matched" and
  // not "nothing was scanned".
  expect(report.scanned).toBe(6);
});

test("rules read back out of the projection still resolve the same way", async () => {
  // SQLite returns the `rule` table in no defined order, so this is the round
  // trip the comparator exists for: two rules that both match, whose answer must
  // not depend on page layout.
  const d = db();
  const s = emptyState();
  s.rules.set("rule-a", { pattern: "carrefour", match: "contains", category: "groceries", priority: 10, version: 1 });
  s.rules.set("rule-b", { pattern: "carrefour", match: "contains", category: "shopping", priority: 100, version: 1 });
  s.txns.set("t01", txn("t01", {}));
  await project(d, s);
  applyDictionaryDelta(d, {
    version: 1n,
    entries: [{ pattern: "carrefour", match: "contains", category: "dictionary answer" }],
    removed: [],
  });

  const p = prepareFromStore(d);
  expect(p.rules).toHaveLength(2);
  expect(p.defects).toEqual([]);
  const proposals: Proposal[] = [];
  await proposeCategories(d, p, (x) => void proposals.push(x));
  expect(proposals).toHaveLength(1);
  expect(proposals[0]?.decision).toEqual({
    category: "groceries",
    source: "rule",
    id: "rule-a",
    pattern: "carrefour",
    match: "contains",
  });
});

test("readUserRules keeps the entity id, which the tiebreak needs", async () => {
  const d = db();
  const s = emptyState();
  s.rules.set("rule-z", { pattern: "noon", match: "contains", category: "shopping", priority: 5, version: 3 });
  await project(d, s);
  expect(readUserRules(d)).toEqual([
    { id: "rule-z", pattern: "noon", match: "contains", category: "shopping", priority: 5 },
  ]);
});

test("the pass refuses to run against an incomplete projection", async () => {
  const d = db();
  ensureDictionary(d);
  await expect(proposeCategories(d, prepare(RULES, ENTRIES), () => {})).rejects.toThrow("complete projection");
});
