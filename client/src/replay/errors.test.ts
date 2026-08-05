/**
 * The error paths of the fold, as a class rather than as instances.
 *
 * Two defects motivate this file and both are "the refusal itself failed":
 *
 *   1. `JSON.stringify` throws `TypeError` on a `bigint`, so every
 *      `PayloadError` message built with it threw a DIFFERENT error than the one
 *      it was being constructed for, past `applyOp`'s `PayloadError` catch and
 *      out of the fold. A device re-folds its whole log on every sync, so one
 *      such op is not one lost row — it is a device that can never sync again.
 *      Money in `client/src` is `bigint` throughout and the transactions,
 *      review-queue and CSV-import paths all assemble ops in code, so
 *      `{ amount_minor: 25000n }` where the wire wants `"25000"` is the likeliest
 *      mistake any of them can make.
 *   2. A `txn_categorized` cleared `needs_review` on an unparsed row, which has
 *      no amount, no currency and no direction to show and is excluded from
 *      every total: the row landed on no surface at all, with no anomaly.
 *
 * The fuzz below is the class check for (1) and states its own input space; the
 * named tests either side of it pin the two instances, so a regression fails
 * with a sentence rather than as a count.
 */

import { expect, test } from "bun:test";
import { SCHEMA_VERSION, UnknownNewerVersionError, showValue, validateOp, type Op } from "../wire/op";
import { emptyState, fingerprint, serializeState, type State, type Txn } from "./state";
import { ReplayOrderError, applyOp, fold, foldBlobs, type LogEntry } from "./replay";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

let n = 0;
const opID = (): string => `e-${++n}`;

type Mutable = Record<string, unknown>;

function entry(seq: bigint, op: Mutable, writer = "ingest"): LogEntry {
  return { op: op as unknown as Op, seq, writer_id: writer };
}

function op(type: string, rest: Mutable): Mutable {
  return { v: 1, type, op_id: opID(), authored_at: "2026-06-05T09:00:05Z", parent_version: null, ...rest };
}

const parsedPayload = (over: Mutable = {}): Mutable => ({
  amount_minor: "25000",
  currency: "AED",
  direction: "debit",
  posted_at: "2026-06-05T09:00:00Z",
  merchant_raw: "CARREFOUR",
  last4: "3701",
  ...over,
});

const unparsedPayload = (over: Mutable = {}): Mutable => ({
  amount_minor: "0",
  currency: "",
  direction: "",
  posted_at: "2026-06-05T09:00:00Z",
  merchant_raw: "",
  last4: "",
  tier: "none",
  needs_review: true,
  unparsed: true,
  ...over,
});

const ingest = (name: string, id: string, payload: Mutable = parsedPayload()): Mutable =>
  op("txn_ingested", { entity: { kind: "txn", id }, ingest_id: ingestID(name), payload });

/** A state holding one parsed row (`t1`, v1) and one unparsed row (`u1`, v1). */
function twoRows(): State {
  const s = emptyState();
  fold([entry(1n, ingest("i1", "t1")), entry(2n, ingest("u1", "u1", unparsedPayload()))], s);
  expect(s.txns.get("t1")?.unparsed).toBe(false);
  expect(s.txns.get("u1")?.unparsed).toBe(true);
  expect(s.anomalies).toEqual([]);
  return s;
}

// ---------------------------------------------------------------------------
// showValue — the renderer every diagnostic on this path goes through
// ---------------------------------------------------------------------------

test("showValue renders exactly what JSON.stringify did, wherever JSON.stringify had an answer", () => {
  // Nothing below is a bigint, so this is the compatibility half of the
  // contract: no existing message text moves. It is asserted against
  // JSON.stringify itself rather than against transcribed literals, so it
  // cannot drift.
  const ordinary: unknown[] = [
    "AED",
    "",
    "a string with \"quotes\" and \\ and a \n newline",
    "ü — non-ASCII",
    0,
    -1,
    25000,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    true,
    false,
    null,
    [],
    [1, "two", null],
    {},
    { a: 1, b: "two" },
    { nested: { deep: [1, 2, 3] } },
  ];
  for (const v of ordinary) expect(showValue(v)).toBe(JSON.stringify(v) as string);
});

test("showValue is total: nothing it can be handed makes it throw", () => {
  const cyclic: Mutable = { name: "cyclic" };
  cyclic["self"] = cyclic;
  const revocable = Proxy.revocable({ a: 1 }, {});
  revocable.revoke();
  let deep: unknown = 0;
  for (let i = 0; i < 50_000; i++) deep = [deep];

  const hostile: [string, unknown][] = [
    ["bigint", 25_000n],
    ["negative bigint", -1n],
    ["symbol", Symbol("s")],
    ["undefined", undefined],
    ["function", () => 1],
    ["cyclic", cyclic],
    ["throwing toJSON", { toJSON: () => { throw new Error("no"); } }],
    ["throwing getter", { get boom(): never { throw new RangeError("no"); } }],
    ["revoked proxy", revocable.proxy],
    ["null-prototype object", Object.assign(Object.create(null) as object, { a: 1 })],
    ["stack-deep array", deep],
    ["nested bigint", { amount: { minor: 25_000n } }],
    ["bigint in an array", [1n, 2n]],
    ["huge string", "x".repeat(1_000_000)],
  ];
  for (const [name, v] of hostile) {
    let out = "";
    expect(() => {
      out = showValue(v);
    }, name).not.toThrow();
    expect(typeof out, name).toBe("string");
    expect(out.length, name).toBeGreaterThan(0);
    // Bounded: an unbounded render would ride from a payload into an anomaly
    // detail and stay in materialized state for the life of the log.
    expect(out.length, name).toBeLessThanOrEqual(513);
  }
});

test("showValue walks a deep value a bounded number of steps, and the bound is structural", () => {
  // Not a duration assertion — a COUNT one. Each link of the chain counts the
  // reads of it, so what is measured is the work `showValue` actually did, and
  // the number does not move with how loaded the box is.
  //
  // Without the depth cap `JSON.stringify`-with-a-replacer walks every one of
  // the 10,000 links and does it quadratically (measured: 313ms at 20,000 links,
  // 1.4s at 50,000). With it, the walk stops at SHOW_MAX_DEPTH.
  const counter = { reads: 0 };
  let chain: unknown = 0;
  for (let i = 0; i < 10_000; i++) {
    const child = chain;
    chain = {
      get a(): unknown {
        counter.reads++;
        return child;
      },
    };
  }
  const out = showValue(chain);
  expect(out).toBe("[deeply nested object]");
  expect(counter.reads).toBeLessThanOrEqual(32);
  expect(counter.reads).toBeGreaterThan(0);

  // And a value of ordinary shape is still rendered in full, so the cap is a
  // cap and not a refusal to render.
  expect(showValue({ parts: [{ category: "dining", amount_minor: "1" }] })).toBe(
    '{"parts":[{"category":"dining","amount_minor":"1"}]}',
  );

  // Where the cap bites, exactly. A constant with a fuzzy edge is a constant
  // nobody can reason about, and an off-by-one here is invisible to every other
  // assertion in this file.
  const nest = (k: number): unknown => {
    let x: unknown = 0;
    for (let i = 0; i < k; i++) x = [x];
    return x;
  };
  expect(showValue(nest(24)).startsWith("[[")).toBe(true);
  expect(showValue(nest(25))).toBe("[deeply nested object]");
});

test("showValue spells a bigint with the suffix, because that IS the diagnostic", () => {
  // The message exists to tell a caller that they passed 25000n where the wire
  // wants "25000". Rendering it as `25000` would describe both mistakes
  // identically and the message would be useless for the one case it is for.
  expect(showValue(25_000n)).toBe("25000n");
  expect(showValue({ amount_minor: 25_000n })).toBe('{"amount_minor":"25000n"}');
  expect(showValue("25000")).toBe('"25000"');
});

// ---------------------------------------------------------------------------
// The two hazards, reproduced in this runtime
// ---------------------------------------------------------------------------

test("the hazards this file exists for are real in this runtime", () => {
  // Calibration, not decoration: if a future runtime made either of these
  // harmless, the fuzz below would go green for a reason that has nothing to do
  // with the fix, and this test says so out loud.
  expect(() => JSON.stringify(25_000n)).toThrow(TypeError);
  expect(() => `${Symbol("s") as unknown as string}`).toThrow(TypeError);
});

// ---------------------------------------------------------------------------
// The fuzz
// ---------------------------------------------------------------------------

/**
 * What the fold is allowed to throw.
 *
 * `applyOp` leaves by exactly one of three doors — it returns, it throws
 * {@link ReplayOrderError} (the caller handed it a position it cannot use), or
 * it throws {@link UnknownNewerVersionError} (this build must not interpret this
 * log). Anything else is an ESCAPE, and an escape strands the device.
 *
 * Every entry the fuzz builds carries a well-formed position, so even
 * `ReplayOrderError` would be a defect there; it is counted separately rather
 * than folded into the escape count so a regression names itself.
 */
function classify(run: () => void): { escape?: unknown; ordering?: unknown; newer?: unknown } {
  try {
    run();
    return {};
  } catch (err) {
    if (err instanceof UnknownNewerVersionError) return { newer: err };
    if (err instanceof ReplayOrderError) return { ordering: err };
    return { escape: err ?? new Error("a falsy value was thrown") };
  }
}

test("the escape classifier is not vacuous", () => {
  expect(classify(() => { throw new TypeError("boom"); }).escape).toBeInstanceOf(TypeError);
  expect(classify(() => { throw "a bare string"; }).escape).toBe("a bare string");
  expect(classify(() => { throw new ReplayOrderError("x"); }).escape).toBeUndefined();
  expect(classify(() => { throw new UnknownNewerVersionError("x"); }).escape).toBeUndefined();
  expect(classify(() => undefined).escape).toBeUndefined();
});

/** The values a hostile op can carry. One entry per way a render can go wrong. */
function hostileValues(): [string, unknown][] {
  const cyclic: Mutable = { name: "cyclic" };
  cyclic["self"] = cyclic;
  const revocable = Proxy.revocable({ a: 1 }, {});
  revocable.revoke();
  let deep: unknown = 0;
  for (let i = 0; i < 20_000; i++) deep = [deep];
  return [
    ["bigint", 25_000n],
    ["bigint zero", 0n],
    ["negative bigint", -1n],
    ["bigint beyond 2^53", 9_007_199_254_740_993n],
    ["symbol", Symbol("hostile")],
    ["object holding a bigint", { amount: 25_000n }],
    ["array holding a bigint", [25_000n]],
    ["bigint behind toJSON", { toJSON: () => 25_000n }],
    ["throwing toJSON", { toJSON: () => { throw new Error("toJSON says no"); } }],
    ["throwing getter", { get amount_minor(): never { throw new RangeError("getter says no"); } }],
    ["cyclic object", cyclic],
    ["revoked proxy", revocable.proxy],
    ["null-prototype object", Object.assign(Object.create(null) as object, { amount_minor: "1" })],
    ["stack-deep array", deep],
    ["long string", "x".repeat(2_000)],
    ["function", () => 1],
    ["undefined", undefined],
    ["null", null],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["true", true],
    ["empty object", {}],
    ["empty array", []],
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1n]])],
  ];
}

/** The op fields every shape is attacked through, on top of its own payload keys. */
const OP_PATHS = ["v", "type", "op_id", "authored_at", "parent_version", "ingest_id", "entity", "entity.kind", "entity.id", "payload"];

interface Shape {
  name: string;
  /** Ops folded before the attacked one; the attacked op arrives at seq 3. */
  make: () => Mutable;
  writer?: string;
  paths: string[];
}

function shapes(): Shape[] {
  return [
    {
      name: "txn_ingested (parsed)",
      make: () => ingest("i9", "t9"),
      paths: ["payload.amount_minor", "payload.currency", "payload.direction", "payload.posted_at", "payload.merchant_raw",
        "payload.last4", "payload.category", "payload.needs_review", "payload.unparsed", "payload.tier", "payload.parse_error"],
    },
    {
      name: "txn_ingested (unparsed)",
      make: () => ingest("u9", "u9", unparsedPayload()),
      paths: ["payload.amount_minor", "payload.currency", "payload.direction", "payload.posted_at", "payload.merchant_raw",
        "payload.last4", "payload.category", "payload.needs_review", "payload.unparsed", "payload.tier", "payload.parse_error"],
    },
    {
      name: "txn_superseded",
      make: () => op("txn_superseded", { entity: { kind: "txn", id: "t2" }, ingest_id: ingestID("i1"), payload: parsedPayload() }),
      paths: ["payload.amount_minor", "payload.currency", "payload.tier", "payload.unparsed", "payload.parse_error"],
    },
    {
      name: "txn_categorized",
      make: () => op("txn_categorized", { entity: { kind: "txn", id: "t1" }, parent_version: 1, payload: { category: "dining", needs_review: false } }),
      writer: "dev-a",
      paths: ["payload.category", "payload.needs_review"],
    },
    {
      name: "txn_categorized (on the unparsed row)",
      make: () => op("txn_categorized", { entity: { kind: "txn", id: "u1" }, parent_version: 1, payload: { category: "dining" } }),
      writer: "dev-a",
      paths: ["payload.category", "payload.needs_review"],
    },
    {
      name: "txn_split",
      make: () => op("txn_split", { entity: { kind: "txn", id: "t1" }, parent_version: 1, payload: { parts: [{ category: "dining", amount_minor: "25000" }] } }),
      writer: "dev-a",
      paths: ["payload.parts", "payload.parts.0", "payload.parts.0.category", "payload.parts.0.amount_minor"],
    },
    {
      name: "txn_edited",
      make: () => op("txn_edited", { entity: { kind: "txn", id: "t1" }, parent_version: 1, payload: { merchant_raw: "NEW" } }),
      writer: "dev-a",
      paths: ["payload.merchant_raw", "payload.last4", "payload.posted_at", "payload.category", "payload.needs_review",
        "payload.amount_home_minor", "payload.amount_minor", "payload.unparsed"],
    },
    {
      name: "rule_added (create)",
      make: () => op("rule_added", { entity: { kind: "rule", id: "r9" }, payload: { pattern: "CARREFOUR", match: "contains", category: "groceries", priority: 10 } }),
      writer: "dev-a",
      paths: ["payload.pattern", "payload.match", "payload.category", "payload.priority"],
    },
    {
      name: "rate_set",
      make: () => op("rate_set", { payload: { currency: "USD", rate_micro: "3670000" } }),
      writer: "dev-a",
      paths: ["payload.currency", "payload.rate_micro"],
    },
    {
      name: "rate_unset",
      make: () => op("rate_unset", { payload: { currency: "USD" } }),
      writer: "dev-a",
      paths: ["payload.currency"],
    },
    {
      name: "home_currency_set",
      make: () => op("home_currency_set", { payload: { currency: "AED" } }),
      writer: "dev-a",
      paths: ["payload.currency"],
    },
    {
      name: "writer_checkpoint",
      make: () => op("writer_checkpoint", { payload: { heads: [{ writer_id: "dev-a", stream: "hot", counter: "4", hash: ingestID("h") }] } }),
      writer: "dev-a",
      paths: ["payload.heads", "payload.heads.0", "payload.heads.0.writer_id", "payload.heads.0.stream", "payload.heads.0.counter", "payload.heads.0.hash"],
    },
  ];
}

/** Sets `path` (dot-separated, array indices numeric) on `root` to `v`. */
function setPath(root: Mutable, path: string, v: unknown): void {
  const keys = path.split(".");
  let cur: Mutable = root;
  for (const k of keys.slice(0, -1)) {
    const next: unknown = cur[k];
    if (typeof next !== "object" || next === null) return;
    cur = next as Mutable;
  }
  cur[keys[keys.length - 1]!] = v;
}

test("no hostile op value escapes the fold — 4,425 cases, zero escapes", () => {
  // # The input space
  //
  // Twelve op shapes (every type in the vocabulary, `txn_ingested` in both its
  // parsed and unparsed forms, `txn_categorized` against both a parsed and an
  // unparsed row) × the field being poisoned (ten op-level fields common to all
  // shapes, plus that shape's own payload keys, 177 (shape, path) pairs in all)
  // × 25 hostile values covering every way a render can fail: bigint at four
  // magnitudes and nested inside an object, an array and a `toJSON`; symbol;
  // a throwing `toJSON`; a throwing getter; a cycle; a revoked Proxy; a
  // null-prototype object; a 20,000-deep array that overflows the stack inside
  // `JSON.stringify`; a 2,000-character string; a function; and the ordinary
  // wrong-type values (`undefined`, `null`, `NaN`, `Infinity`, `true`, `{}`,
  // `[]`, `Date`, `Map`).
  //
  // # What it does NOT cover, and why
  //
  // The op OBJECT is assumed to be plain data: no throwing accessors and no
  // Proxy traps on the op itself. That is what `decodeBlobOps` produces and what
  // every in-code assembler produces, and an op whose `op_id` getter throws is
  // the same class of caller bug as an entry with no op at all — `applyOp` reads
  // `op.op_id` before it has anywhere to record an anomaly. Hostile values
  // INSIDE the payload, including a payload object whose key is a throwing
  // getter, are covered.
  //
  // Nor is this a fuzz over LOG SHAPES — orderings, forks, duplicate delivery.
  // Those are `replay.test.ts`'s subject; this one is about the refusal path.
  const values = hostileValues();
  const escapes: string[] = [];
  const ordering: string[] = [];
  const stranded: string[] = [];
  const unwitnessable: string[] = [];
  let cases = 0;
  let pairs = 0;

  for (const shape of shapes()) {
    for (const path of [...OP_PATHS, ...shape.paths]) {
      pairs++;
      for (const [label, v] of values) {
        cases++;
        const where = `${shape.name} · ${path} = ${label}`;
        const s = twoRows();
        const poisoned = shape.make();
        setPath(poisoned, path, v);
        const c = classify(() => applyOp(s, entry(3n, poisoned, shape.writer ?? "ingest")));
        if (c.escape !== undefined) escapes.push(`${where}: ${String((c.escape as Error)?.name)} ${String((c.escape as Error)?.message)}`);
        if (c.ordering !== undefined) ordering.push(where);
        if (c.escape !== undefined || c.ordering !== undefined) continue;

        // The device is not stranded: the fold still accepts the next op, and
        // the state it reached can still be witnessed. Measured rather than
        // assumed — an op that poisoned a materialized field would fold
        // "successfully" and then break `serializeState`, which is how the
        // state reaches disk and how two replicas are compared.
        const after = classify(() => applyOp(s, entry(4n, op("rate_set", { payload: { currency: "EUR", rate_micro: "4000000" } }), "dev-a")));
        if (after.escape !== undefined || s.rates.get("EUR") !== 4_000_000n) stranded.push(where);
        try {
          serializeState(s);
        } catch (err) {
          unwitnessable.push(`${where}: ${String((err as Error)?.message)}`);
        }
      }
    }
  }

  expect(pairs).toBe(177);
  expect(cases).toBe(4_425);
  expect(escapes.slice(0, 10)).toEqual([]);
  expect(ordering.slice(0, 10)).toEqual([]);
  expect(stranded.slice(0, 10)).toEqual([]);
  expect(unwitnessable.slice(0, 10)).toEqual([]);
}, 60_000);

// ---------------------------------------------------------------------------
// Instance 1: the bigint that stranded the device
// ---------------------------------------------------------------------------

test("a bigint amount in an op assembled in code becomes an anomaly, not a stranded device", () => {
  const s = twoRows();
  const bad = ingest("i9", "t9", parsedPayload({ amount_minor: 25_000n }));
  expect(() => applyOp(s, entry(3n, bad))).not.toThrow();
  const a = s.anomalies.at(-1);
  expect(a?.kind).toBe("invalid_payload");
  // The rendered value is asserted, not just the kind. This is the assertion
  // that fails if anyone puts `JSON.stringify` back: it would throw here rather
  // than produce a wrong string.
  expect(a?.detail).toContain("amount_minor must be a decimal-integer string, got 25000n");
  expect(s.txns.has("t9")).toBe(false);
});

test("every money-shaped field takes a bigint the same way", () => {
  for (const key of ["amount_minor", "currency", "direction", "posted_at", "merchant_raw", "last4"]) {
    const s = twoRows();
    expect(() => applyOp(s, entry(3n, ingest("i9", "t9", parsedPayload({ [key]: 25_000n })))), key).not.toThrow();
    expect(s.anomalies.at(-1)?.kind, key).toBe("invalid_payload");
    expect(s.anomalies.at(-1)?.detail, key).toContain("25000n");
  }
});

test("a symbol in an unvalidated op field becomes an invalid_op anomaly", () => {
  // Reachable before `validateOp` has run, so the message is built from fields
  // nothing has checked: `${symbol}` throws TypeError in a template literal, and
  // that TypeError was outside every catch.
  const s = twoRows();
  const bad = ingest("i9", "t9");
  bad["type"] = Symbol("txn_ingested");
  expect(() => applyOp(s, entry(3n, bad))).not.toThrow();
  expect(s.anomalies.at(-1)?.kind).toBe("invalid_op");
  expect(s.anomalies.at(-1)?.detail).toContain("[symbol]");
});

test("a symbol op_id folded twice at one seq becomes a duplicate_delivery anomaly", () => {
  const s = twoRows();
  const bad = ingest("i9", "t9");
  bad["op_id"] = Symbol("op");
  expect(() => applyOp(s, entry(3n, bad))).not.toThrow();
  expect(() => applyOp(s, entry(3n, bad))).not.toThrow();
  expect(s.anomalies.at(-1)?.kind).toBe("duplicate_delivery");
});

test("an engine fault is recorded as one, and without the engine's own wording", () => {
  // A payload whose key THROWS when read. Nothing this codebase writes raises a
  // native error, so the class name is the honest signal and the message —
  // which differs between JavaScriptCore, V8 and Hermes — is deliberately not
  // in the anomaly detail: an anomaly is materialized state two replicas
  // compare byte for byte.
  const s = twoRows();
  const payload = parsedPayload();
  Object.defineProperty(payload, "amount_minor", {
    get: (): never => {
      throw new TypeError("an engine would phrase this differently");
    },
    enumerable: true,
  });
  const bad = ingest("i9", "t9", payload);
  expect(() => applyOp(s, entry(3n, bad))).not.toThrow();
  const a = s.anomalies.at(-1);
  expect(a?.kind).toBe("invalid_payload");
  expect(a?.detail).toContain("a fault in the replay engine");
  expect(a?.detail).toContain("TypeError");
  expect(a?.detail).not.toContain("an engine would phrase this differently");
});

test("an unreadable blob's recorded reason carries no engine wording either", () => {
  // `state.unreadable[].reason` is witnessed by `serializeState` exactly like an
  // anomaly detail, so the same rule applies — and this is the path where it was
  // being broken by the most ordinary failure there is, a corrupt blob:
  // `JSON.parse`'s message is JavaScriptCore's on one replica and V8's or
  // Hermes' on another, so two devices folding the same bad blob held different
  // states.
  const pos = { writer_id: "dev-a", stream: "hot", writer_counter: 1n, seq: 1n };
  const corrupt = emptyState();
  foldBlobs([{ pos, body: new TextEncoder().encode("not json at all") }], corrupt);
  expect(corrupt.unreadable).toHaveLength(1);
  expect(corrupt.unreadable[0]?.reason).toBe("op blob: body is not valid JSON (15 bytes)");

  // And a native fault raised before the decoder gets a chance is described by
  // class, not by the runtime's phrasing.
  const broken = emptyState();
  foldBlobs([{ pos, body: undefined as unknown as Uint8Array }], broken);
  expect(broken.unreadable[0]?.reason).toContain("a fault in the decoder");
  expect(broken.unreadable[0]?.reason).toContain("TypeError");

  // The decoder's OWN refusals keep their words: they are this codebase's, so
  // they are the same on every replica and they say what is wrong.
  const wrongKind = emptyState();
  foldBlobs([{ pos, body: new TextEncoder().encode('{"v":1,"kind":"raw_body","ops":[]}') }], wrongKind);
  expect(wrongKind.unreadable[0]?.reason).toContain("blob kind is");
});

test("the two hard stops still leave applyOp", () => {
  // The widened catch must not swallow them: a log this build cannot interpret
  // and a caller folding out of order are the two conditions that MUST stop a
  // sync (spec §3.3:68).
  const s = twoRows();
  const newer = ingest("i9", "t9");
  newer["v"] = SCHEMA_VERSION + 1;
  expect(() => applyOp(s, entry(3n, newer))).toThrow(UnknownNewerVersionError);
  expect(() => applyOp(s, entry(1n, ingest("i8", "t8")))).toThrow(ReplayOrderError);
  expect(() => applyOp(s, { op: null as unknown as Op, seq: 3n, writer_id: "ingest" })).toThrow(ReplayOrderError);
});

// ---------------------------------------------------------------------------
// Instance 2: the unparsed row that landed on no surface
// ---------------------------------------------------------------------------

test("txn_categorized cannot clear needs_review on an unparsed row", () => {
  const s = twoRows();
  // The ordinary review action: `needs_review` is ABSENT, and the categorize
  // decoder defaults it to false. That is what made this reachable by tapping a
  // button rather than by hand-crafting an op.
  const dismiss = op("txn_categorized", { entity: { kind: "txn", id: "u1" }, parent_version: 1, payload: { category: "dining" } });
  applyOp(s, entry(3n, dismiss, "dev-a"));
  const u = s.txns.get("u1")!;
  expect(u.unparsed).toBe(true);
  expect(u.needs_review).toBe(true);
  // The category the user chose still lands; only the dismissal is refused.
  expect(u.category).toBe("dining");
  expect(s.anomalies.at(-1)?.kind).toBe("unsupported_edit_field");
  expect(s.anomalies.at(-1)?.detail).toContain("needs_review cannot be cleared on an unparsed transaction");
  // And the refusal is visible at the position it happened.
  expect(s.anomalies.at(-1)?.at_seq).toBe(3n);
});

test("txn_edited cannot clear needs_review on an unparsed row either", () => {
  // Two op types can clear the flag. A guard on one of them is not a guard.
  const s = twoRows();
  applyOp(s, entry(3n, op("txn_edited", { entity: { kind: "txn", id: "u1" }, parent_version: 1, payload: { needs_review: false } }), "dev-a"));
  expect(s.txns.get("u1")?.needs_review).toBe(true);
  expect(s.anomalies.at(-1)?.kind).toBe("unsupported_edit_field");
});

test("the guard is not a blanket refusal: a parsed row dismisses normally", () => {
  // A fixture with only the refused case cannot tell "correct guard" from "no
  // categorization at all".
  const s = twoRows();
  applyOp(s, entry(3n, op("txn_categorized", { entity: { kind: "txn", id: "t1" }, parent_version: 1, payload: { category: "dining" } }), "dev-a"));
  const t = s.txns.get("t1")!;
  expect(t.needs_review).toBe(false);
  expect(t.category).toBe("dining");
  expect(s.anomalies).toEqual([]);
});

test("setting needs_review true on an unparsed row is not an anomaly", () => {
  const s = twoRows();
  applyOp(s, entry(3n, op("txn_categorized", { entity: { kind: "txn", id: "u1" }, parent_version: 1, payload: { category: "dining", needs_review: true } }), "dev-a"));
  expect(s.txns.get("u1")?.needs_review).toBe(true);
  expect(s.anomalies).toEqual([]);
});

test("an unparsed row is on the review surface for the whole log, not only at its create", () => {
  // The property in the terms it is actually about: after every op a client can
  // author against it, an unparsed row is still flagged. This is the assertion
  // `I12_money_shape` should make independently — see the task report.
  const s = twoRows();
  applyOp(s, entry(3n, op("txn_categorized", { entity: { kind: "txn", id: "u1" }, parent_version: 1, payload: { category: "x" } }), "dev-a"));
  applyOp(s, entry(4n, op("txn_edited", { entity: { kind: "txn", id: "u1" }, parent_version: 2, payload: { needs_review: false, merchant_raw: "M" } }), "dev-a"));
  applyOp(s, entry(5n, op("txn_split", { entity: { kind: "txn", id: "u1" }, parent_version: 3, payload: { parts: [] } }), "dev-a"));
  for (const [, t] of s.txns) {
    if (t.unparsed) expect(t.needs_review).toBe(true);
  }
});

test("an empty split on an unparsed row is refused rather than landing as a no-op", () => {
  // `parts: []` sums to 0n, which is exactly an unparsed row's amount, so it
  // passed the sum check, consumed a version and changed nothing.
  const s = twoRows();
  const before = s.txns.get("u1")!.version;
  applyOp(s, entry(3n, op("txn_split", { entity: { kind: "txn", id: "u1" }, parent_version: 1, payload: { parts: [] } }), "dev-a"));
  expect(s.anomalies.at(-1)?.kind).toBe("split_sum");
  expect(s.anomalies.at(-1)?.detail).toContain("no amount to split");
  // A payload-level refusal consumes no version, so a corrected op still applies.
  expect(s.txns.get("u1")?.version).toBe(before);
  expect(s.txns.get("u1")?.splits).toEqual([]);
});

// ---------------------------------------------------------------------------
// The dependency Task 7's disjointness argument rests on
// ---------------------------------------------------------------------------

test("the unparsed fingerprint namespace is disjoint ONLY because ingest_id is 64 hex", () => {
  // Task 7 claims `unparsed|<ingest_id>` cannot collide with a parsed
  // `last4|amount|direction|merchant|day`, because the parsed form always emits
  // four separators and the unparsed form always emits one. The second half is
  // true only because 64 lower-case hex characters contain no `|`, which is
  // `validateOp`'s check and nothing else. This test states both halves so that
  // relaxing the check fails a test that says why.
  const collidingID = "1|debit|ACME|2026-01-01";
  const asUnparsed = { unparsed: true, ingest_id: collidingID } as unknown as Txn;
  const asParsed = {
    unparsed: false,
    last4: "unparsed",
    amount_minor: 1n,
    direction: "debit",
    merchant_raw: "ACME",
    posted_at: "2026-01-01T00:00:00Z",
  } as unknown as Txn;
  // Half one: the namespaces DO collapse if such an ingest id ever reaches the
  // fold. This is not hypothetical arithmetic — it is the same function.
  expect(fingerprint(asUnparsed)).toBe(fingerprint(asParsed));

  // Half two: it cannot, because validateOp refuses it on both txn creates.
  for (const type of ["txn_ingested", "txn_superseded"]) {
    const o = op(type, { entity: { kind: "txn", id: "t9" }, ingest_id: collidingID, payload: parsedPayload() });
    expect(() => validateOp(o as unknown as Op), type).toThrow(/64-hex-char ingest_id/);
  }

  // And a real 64-hex id cannot spell a colliding value no matter the merchant.
  const real = { unparsed: true, ingest_id: ingestID("i1") } as unknown as Txn;
  expect(fingerprint(real).split("|").length).toBe(2);
});
