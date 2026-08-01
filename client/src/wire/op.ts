/**
 * The operation wire model, mirroring `internal/v2/oplog/op.go`.
 *
 * # A frozen contract, mirrored FROM Go
 *
 * Spec §3.5 mandates two independent executors — the Go one and this one — that
 * fold the same log into the same state. Go's `op.go` is the reference and this
 * is the mirror, so where the two could differ the answer is always "do what Go
 * does", and where they cannot help differing it is written down here rather
 * than left for a fold to discover.
 *
 * The three rules that exist BECAUSE this file exists:
 *
 *   - Money and counters are JSON STRINGS holding decimal integers, parsed with
 *     {@link parseDecimal} into `bigint`. `JSON.parse` of a number is a float64,
 *     so `25000` as a number is a rounding bug waiting for a big enough value.
 *   - `writer_checkpoint.heads` is a sorted ARRAY, not a map, so its canonical
 *     encoding is unambiguous in both languages.
 *   - `authored_at` is normalised to UTC and truncated to MILLISECONDS on encode
 *     and on decode, because a JavaScript `Date` cannot hold anything finer and
 *     fork resolution compares `authored_at` for an exact tie.
 *
 * # What is deliberately NOT claimed: byte-identical JSON
 *
 * Two encoders, two byte streams. Both are already true today:
 *
 *   - Go's RFC3339Nano trims trailing zeros (`…:00.5Z`) where `toISOString`
 *     always pads to three digits (`…:00.500Z`);
 *   - Go's `encoding/json` escapes `<`, `>`, `&`, U+2028 and U+2029 as `\uXXXX`
 *     where `JSON.stringify` emits them literally. A merchant string containing
 *     `&` is enough.
 *
 * Neither matters, and the reason is structural rather than lucky: each blob is
 * encoded exactly once, by its author, and the chain hashes the bytes AS STORED
 * (`chain.ts`), so the two encoders never have to agree byte for byte. What they
 * must agree on is the PARSED VALUE — which is what the millisecond rule buys,
 * and what `TestTypeScriptSealedBlobsOpenInGo` checks in the direction a
 * Go-authored fixture set cannot.
 *
 * **That safety rests on a usage property, not on this code.** The moment
 * anything re-encodes an op it did not author — log compaction, a snapshot
 * rewrite, a migration that re-serializes — byte-inequality stops being cosmetic
 * and becomes a chain break, and which executor did the rewriting decides whose
 * chain survives. Compaction is deferred (spec §3.3, where this caveat is
 * recorded next to the deferral); undeferring it means first making op encoding
 * byte-canonical across both languages. Do not add a "re-encode and re-upload"
 * path here without reading that note.
 *
 * The one place byte-identity IS claimed is {@link encodeCheckpointPayload},
 * whose fields are digits, hex and `[a-zA-Z0-9._-]` writer ids — nothing either
 * encoder escapes, and no timestamp.
 *
 * # Unknown newer versions hard-stop; unopenable blobs do not
 *
 * {@link UnknownNewerVersionError} is a HARD STOP: a client that meets an op it
 * cannot interpret must stop syncing and demand an upgrade rather than fold a
 * half-understood log into money (spec §3.3:68). {@link BlobDecodeError} is the
 * opposite: that one blob is set aside with a visible warning and sync
 * continues, because one bad blob must not strand a device. The two must never
 * be conflated — they are `oplog.ErrUnknownNewerVersion` and `blob.ErrSetAside`.
 */

/** The op schema this build understands. `blob.ts`'s VERSION versions the framing. */
export const SCHEMA_VERSION = 1;

export const KIND_OPS = "ops";
export const KIND_RAW_BODY = "raw_body";
export type BlobKind = typeof KIND_OPS | typeof KIND_RAW_BODY;

export type OpType =
  | "txn_ingested"
  | "txn_superseded"
  | "txn_categorized"
  | "txn_split"
  | "txn_edited"
  | "rule_added"
  | "rate_set"
  | "rate_unset"
  | "home_currency_set"
  | "writer_checkpoint";

/** Every op type at SCHEMA_VERSION, in wire order (mirrors `oplog.Types`). */
export const OP_TYPES: readonly OpType[] = [
  "txn_ingested",
  "txn_superseded",
  "txn_categorized",
  "txn_split",
  "txn_edited",
  "rule_added",
  "rate_set",
  "rate_unset",
  "home_currency_set",
  "writer_checkpoint",
];

const OP_TYPE_SET: ReadonlySet<string> = new Set(OP_TYPES);

/**
 * Parent-free ops are append-only facts rather than mutations of a versioned
 * entity: they name no entity, carry no `parent_version`, and are folded purely
 * by position. Modelling rates as versioned entities would import fork
 * resolution into FX, and the two readings produce different numbers across the
 * two executors — which is why this is enforced by {@link validateOp} rather
 * than left to convention.
 */
const PARENT_FREE: ReadonlySet<string> = new Set<OpType>([
  "rate_set",
  "rate_unset",
  "home_currency_set",
  "writer_checkpoint",
]);

export function isOpType(s: unknown): s is OpType {
  return typeof s === "string" && OP_TYPE_SET.has(s);
}

export function isParentFree(t: OpType): boolean {
  return PARENT_FREE.has(t);
}

export interface EntityRef {
  kind: string;
  id: string;
}

/**
 * One operation.
 *
 * `parent_version` is a `number`, not a `bigint`, because the wire carries it as
 * a raw JSON NUMBER — the one field that contradicts the decimal-string rule for
 * counters, and frozen that way. {@link validateOp} therefore rejects a value
 * outside the safe-integer range instead of letting `JSON.parse` round it: Go's
 * `*int64` can hold 2^53+1 and this cannot, so the honest answer is to refuse
 * rather than to fold a silently altered version number. See the divergence note
 * in `client/README` territory — in practice an entity version counts edits to
 * one transaction, so the range is unreachable, but "unreachable" is not a
 * property this file is willing to assume on its own.
 */
export interface Op {
  v: number;
  type: OpType;
  op_id: string;
  /** RFC3339 UTC, millisecond precision. Fork tiebreak ONLY — never read by FX. */
  authored_at: string;
  entity?: EntityRef;
  parent_version: number | null;
  /** hex sha256 of the raw body; present only on txn_ingested / txn_superseded. */
  ingest_id?: string;
  payload: unknown;
}

/** A cold-stream record: one raw email, joined to its hot op by `ingest_id`. */
export interface RawBodyRecord {
  ingest_id: string;
  received_at: string;
  raw: Uint8Array;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The sync HARD STOP: the log contains an op schema version this build does not
 * understand, so replay must not continue (spec §3.3:68). Mirrors
 * `oplog.ErrUnknownNewerVersion`.
 */
export class UnknownNewerVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownNewerVersionError";
  }
}

/**
 * A blob that cannot be decoded at all. Callers SET IT ASIDE with a visible
 * warning and keep syncing; they never abort (spec §3.3:68). Mirrors
 * `blob.ErrSetAside`, and is deliberately a different class from
 * {@link UnknownNewerVersionError}.
 */
export class BlobDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobDecodeError";
  }
}

/**
 * The caller passed an unusable {@link import("./blob").Envelope}. A programming
 * error on both seal and open, and NOT a set-aside condition — mirrors
 * `blob.ErrInvalidEnvelope`, which likewise does not wrap `ErrSetAside`.
 */
export class InvalidEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEnvelopeError";
  }
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * Parses a decimal-integer STRING into a `bigint`. This is the only way money
 * and counters are read off the wire; `Number(s)` is a bug in this codebase.
 *
 * The accepted grammar is exactly `oplog.isDecimal`: one or more ASCII digits,
 * nothing else — no sign, no whitespace, no exponent, and not the empty string
 * (which `BigInt("")` silently reads as 0n).
 */
export function parseDecimal(s: unknown): bigint {
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) {
    throw new BlobDecodeError(`want a decimal-integer string, got ${JSON.stringify(s)}`);
  }
  return BigInt(s);
}

/**
 * RFC3339 with an optional fraction and either `Z` or a numeric offset.
 *
 * `T` and `Z` are UPPERCASE-only, which is stricter than RFC 3339 itself and
 * exactly as strict as Go: `time.Parse(time.RFC3339, …)` refuses
 * `2026-06-05t10:00:00z` ("cannot parse ... as \"T\"") while `Date.parse`
 * accepts it. Allowing the lowercase spelling here would mean this executor
 * folding an op the other one sets aside — a divergence in the direction that
 * matters most, since a blob is either in the log for both or in neither.
 *
 * The shape is only half the check; see {@link parseInstantMs} for the ranges.
 */
const RFC3339 =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$/;

function daysInMonth(year: number, month: number): number {
  // Gregorian, matching Go's daysIn: divisible by 4, except centuries, except
  // those divisible by 400.
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Go's zero `time.Time`, which `Op.Validate` rejects. */
const GO_ZERO_TIME_MS = Date.parse("0001-01-01T00:00:00Z");

/**
 * Parses an `authored_at` / `received_at` string to epoch milliseconds.
 *
 * # Why this does not use `Date.parse` for the value
 *
 * `Date.parse` is lenient in ways `time.Parse(time.RFC3339, …)` is not, and the
 * leniency is not symmetric. Measured against both runtimes:
 *
 * | wire                        | Go              | `Date.parse`            |
 * |-----------------------------|-----------------|-------------------------|
 * | `2026-06-05T24:00:00Z`      | reject          | **accept** → the 6th    |
 * | `2026-02-30T10:00:00Z`      | reject          | **accept** → **Mar 2**  |
 * | `2026-06-05t10:00:00z`      | reject          | **accept**              |
 * | `2026-06-05T10:00:00+24:00` | accept (stock)  | reject                  |
 *
 * Every row is a blob that lands in one executor's log and not the other's, and
 * the second row is worse than that — it folds at an instant no legal reading of
 * the string produces. `authored_at` is the fork tiebreak, so a disagreement
 * here is two devices materialising different money from the same log.
 *
 * So the components are range-checked explicitly and the instant is computed
 * arithmetically. `Date.parse`'s rollover never gets a say. Go was tightened to
 * match on the one row where it was the lenient side (`parseWireTime`), rather
 * than this side mirroring a stdlib quirk that go.dev/issue/47353 plans to
 * remove anyway.
 *
 * Sub-millisecond digits are TRUNCATED, not rounded — `…00.0015Z` is 1 ms, which
 * is what Go's `Truncate(time.Millisecond)` yields. Taking the first three
 * fraction digits is truncation by construction, so this no longer depends on
 * V8 happening to truncate too.
 */
export function parseInstantMs(s: unknown): number {
  if (typeof s !== "string") {
    throw new BlobDecodeError(`want an RFC3339 timestamp, got ${JSON.stringify(s)}`);
  }
  const m = RFC3339.exec(s);
  if (m === null) throw new BlobDecodeError(`want an RFC3339 timestamp, got ${JSON.stringify(s)}`);
  const [, year, month, day, hour, minute, second, fraction, sign, offHour, offMinute] = m as unknown as string[];
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const sec = Number(second);
  if (mo < 1 || mo > 12) throw new BlobDecodeError(`timestamp ${JSON.stringify(s)} has month ${mo}`);
  if (d < 1 || d > daysInMonth(y, mo)) throw new BlobDecodeError(`timestamp ${JSON.stringify(s)} has day ${d}`);
  // Hour 24 is the one Date.parse rolls into the next day. No leap seconds: Go
  // refuses :60 and so must this.
  if (h > 23) throw new BlobDecodeError(`timestamp ${JSON.stringify(s)} has hour ${h}`);
  if (mi > 59) throw new BlobDecodeError(`timestamp ${JSON.stringify(s)} has minute ${mi}`);
  if (sec > 59) throw new BlobDecodeError(`timestamp ${JSON.stringify(s)} has second ${sec}`);

  let offsetMinutes = 0;
  if (sign !== undefined) {
    const oh = Number(offHour);
    const om = Number(offMinute);
    if (oh > 23 || om > 59) throw new BlobDecodeError(`timestamp ${JSON.stringify(s)} has an out-of-range UTC offset`);
    offsetMinutes = (sign === "-" ? -1 : 1) * (oh * 60 + om);
  }

  // First three fraction digits, right-padded: truncation, never rounding.
  const ms = fraction === undefined ? 0 : Number((fraction + "000").slice(0, 3));

  // Date.UTC maps years 0-99 onto 1900-1999, so the year is set explicitly.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, sec, ms);
  const epoch = date.getTime() - offsetMinutes * 60_000;
  if (Number.isNaN(epoch)) throw new BlobDecodeError(`unparseable timestamp ${JSON.stringify(s)}`);
  if (epoch === GO_ZERO_TIME_MS) throw new BlobDecodeError("timestamp is the zero time");
  return epoch;
}

/**
 * Puts a timestamp in the one form both executors read identically: UTC,
 * truncated to milliseconds. Mirrors `oplog.canonicalTime`, and is applied on
 * ENCODE and on DECODE for the reason Go states — encode-side truncation alone
 * only holds while every writer is one encoder, and there are two.
 */
export function canonicalTime(s: string): string {
  return new Date(parseInstantMs(s)).toISOString();
}

/** Epoch milliseconds of an op's authored_at. Compare INSTANTS, never strings. */
export function authoredAtMs(o: Op): number {
  return parseInstantMs(o.authored_at);
}

function isSHA256Hex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

// ---------------------------------------------------------------------------
// Blob bodies
// ---------------------------------------------------------------------------

/**
 * The literal source text of every number in a parsed document, filed by the
 * object that holds it.
 *
 * `JSON.parse` destroys the distinction between `1` and `1.0`, and rounds
 * anything past 2^53 before any code sees it — but Go's decoder sees the
 * literal, so `{"v":1.0}` is refused there and was accepted here, and a
 * `parent_version` of 2^53+1 arrived silently altered. The reviver's
 * source-access parameter hands back the exact characters, which is the only way
 * to make those two decisions the same on both sides.
 *
 * Filed by HOLDER rather than by key name so the strictness applies to the
 * STRUCTURAL fields only. A blanket rule over every number in the document would
 * reject a fractional number inside an op's `payload` — which Go accepts without
 * looking, since payload is a json.RawMessage — and trade one divergence for a
 * worse one.
 */
type NumberLiterals = WeakMap<object, Map<string, string>>;

interface ParsedBody {
  doc: Record<string, unknown>;
  literals: NumberLiterals;
}

/** The reviver signature including the source-access context (ES2025). */
type SourceReviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;

function parseBody(bytes: Uint8Array, what: string): ParsedBody {
  // Non-fatal decoding, so invalid UTF-8 becomes U+FFFD rather than throwing —
  // which is what Go's encoding/json does with invalid UTF-8 inside a string.
  const text = new TextDecoder("utf-8").decode(bytes);
  const literals: NumberLiterals = new WeakMap();
  const reviver: SourceReviver = function (key, value, context) {
    // `this` is the holder, and JSON.parse walks an already-built object, so the
    // identity recorded here is the identity the caller ends up with.
    if (typeof value === "number" && context?.source !== undefined && typeof this === "object" && this !== null) {
      let m = literals.get(this);
      if (m === undefined) {
        m = new Map();
        literals.set(this, m);
      }
      m.set(key, context.source);
    }
    return value;
  };
  let doc: unknown;
  try {
    doc = JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
  } catch (e) {
    throw new BlobDecodeError(`${what}: ${(e as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new BlobDecodeError(`${what}: body is not a JSON object`);
  }
  return { doc: doc as Record<string, unknown>, literals };
}

/**
 * Requires that a structural number was written as a plain integer literal.
 *
 * Go decodes `v` into an `int` and `parent_version` into an `*int64`, both of
 * which refuse `1.0`, `1e0` and `1.5` outright. Returns quietly when the runtime
 * does not support reviver source access, so this hardens the check where it can
 * and never invents a rejection it cannot justify.
 */
function requireIntegerLiteral(literals: NumberLiterals, holder: object, key: string, what: string): void {
  const source = literals.get(holder)?.get(key);
  if (source === undefined) return;
  if (!/^-?[0-9]+$/.test(source)) {
    throw new BlobDecodeError(`${what}: ${key} is written as ${source}, which Go refuses as a non-integer literal`);
  }
  // The literal is exact here even when the parsed number is not, so this
  // catches the 2^53 case without depending on how the rounding happened to go.
  const exact = BigInt(source);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BlobDecodeError(
      `${what}: ${key} is ${source}, outside the range a JSON number carries exactly — ` +
        `Go's int64 can hold it and this executor cannot`,
    );
  }
}

/**
 * Reads the body version, hard-stopping on an unknown newer one. The check
 * happens before anything else is parsed so it never depends on being able to
 * read the rest — the same reason Go has a `blobHeader` type.
 */
function readVersion(doc: Record<string, unknown>, what: string): number {
  const v = doc["v"];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new BlobDecodeError(`${what}: version is ${JSON.stringify(v)}`);
  }
  if (v > SCHEMA_VERSION) {
    throw new UnknownNewerVersionError(`${what} is v${v}, this build supports v${SCHEMA_VERSION}`);
  }
  if (v < 1) throw new BlobDecodeError(`${what}: version ${v} is not valid`);
  return v;
}

/**
 * Reports what a blob body claims to be. This is how invariant I16 checks that a
 * cold blob never carries ops, so it reads only the kind and never the body.
 *
 * Go's `KindOf` returns an unrecognised kind verbatim and lets the caller
 * refuse it; this throws, because the declared return type is the closed union
 * and every caller of both refuses anything else anyway.
 */
export function kindOf(bytes: Uint8Array): BlobKind {
  const kind = parseBody(bytes, "blob").doc["kind"];
  if (kind === KIND_OPS || kind === KIND_RAW_BODY) return kind;
  if (kind === undefined || kind === "") throw new BlobDecodeError("blob has no kind");
  throw new BlobDecodeError(`blob kind is ${JSON.stringify(kind)}`);
}

/**
 * Decodes a hot-stream blob body. It refuses a raw-body blob (invariant I16) and
 * hard-stops on an unknown newer schema version, at the blob level or on any op
 * inside it.
 *
 * Callers must split its errors two ways: {@link UnknownNewerVersionError} means
 * STOP SYNCING, anything else means this one blob is unreadable and gets set
 * aside with a warning while the rest of the log proceeds.
 */
export function decodeBlobOps(bytes: Uint8Array): Op[] {
  const { doc, literals } = parseBody(bytes, "op blob");
  requireIntegerLiteral(literals, doc, "v", "op blob");
  readVersion(doc, "op blob");
  if (doc["kind"] !== KIND_OPS) {
    throw new BlobDecodeError(`blob kind is ${JSON.stringify(doc["kind"])}, not ${JSON.stringify(KIND_OPS)}`);
  }
  const raw = doc["ops"];
  // Absent or null is zero ops, matching Go: a nil slice unmarshals from a
  // missing key without error, and refusing it here would set aside a blob the
  // other executor reads happily.
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BlobDecodeError("ops is not an array");
  return raw.map((o, i) => decodeOp(o, i, literals));
}

function decodeOp(raw: unknown, i: number, literals: NumberLiterals): Op {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BlobDecodeError(`op ${i}: not a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  // Checked on the op object itself, so a `v` or `parent_version` inside the
  // op's payload — which Go never parses — is left alone.
  requireIntegerLiteral(literals, o, "v", `op ${i}`);
  requireIntegerLiteral(literals, o, "parent_version", `op ${i}`);
  const v = o["v"];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new BlobDecodeError(`op ${i}: version is ${JSON.stringify(v)}`);
  }
  if (v > SCHEMA_VERSION) {
    throw new UnknownNewerVersionError(`op ${i} is v${v}, this build supports v${SCHEMA_VERSION}`);
  }

  const op: Op = {
    v,
    type: o["type"] as OpType,
    op_id: o["op_id"] as string,
    // Canonicalised on the way IN as well as out. Encode-side truncation alone
    // only holds while every writer is this encoder, and the other executor is
    // Go: a blob carrying "…:00.0000015Z" reads as 1500ns there and 0ms here, so
    // the two would disagree about whether two ops are an exact tie and hand the
    // same fork to different winners.
    authored_at: typeof o["authored_at"] === "string" ? canonicalTime(o["authored_at"]) : (o["authored_at"] as string),
    parent_version: o["parent_version"] === undefined ? null : (o["parent_version"] as number | null),
    payload: o["payload"],
  };
  if (o["entity"] !== undefined && o["entity"] !== null) {
    const e = o["entity"] as Record<string, unknown>;
    op.entity = { kind: e["kind"] as string, id: e["id"] as string };
  }
  if (o["ingest_id"] !== undefined && o["ingest_id"] !== "") {
    op.ingest_id = o["ingest_id"] as string;
  }

  try {
    validateOp(op);
  } catch (e) {
    if (e instanceof UnknownNewerVersionError) throw e;
    throw new BlobDecodeError(`op ${i}: ${(e as Error).message}`);
  }
  return op;
}

/**
 * Enforces the structural rules replay depends on. It deliberately does NOT
 * interpret `payload`: payload shapes are per-type and belong to the replay
 * engine, but a payload that is not even present must never reach it.
 */
export function validateOp(o: Op): void {
  if (typeof o.v !== "number" || !Number.isInteger(o.v)) throw new Error(`version is ${JSON.stringify(o.v)}`);
  if (o.v > SCHEMA_VERSION) throw new UnknownNewerVersionError(`op ${o.op_id} is v${o.v}`);
  if (o.v < 1) throw new Error(`version ${o.v} is not valid`);
  if (!isOpType(o.type)) throw new Error(`unknown type ${JSON.stringify(o.type)}`);
  if (typeof o.op_id !== "string" || o.op_id === "") throw new Error("op_id is empty");
  parseInstantMs(o.authored_at); // throws on a missing, malformed or zero timestamp

  if (isParentFree(o.type)) {
    if (o.entity !== undefined) throw new Error(`${o.type} is parent-free and must not name an entity`);
    if (o.parent_version !== null && o.parent_version !== undefined) {
      throw new Error(`${o.type} is parent-free and must not carry a parent_version`);
    }
  } else {
    if (o.entity === undefined) throw new Error(`${o.type} must name an entity`);
    if (typeof o.entity.kind !== "string" || o.entity.kind === "" || typeof o.entity.id !== "string" || o.entity.id === "") {
      throw new Error("entity needs both a kind and an id");
    }
    if (o.parent_version !== null && o.parent_version !== undefined) {
      const pv = o.parent_version;
      if (typeof pv !== "number" || !Number.isInteger(pv)) throw new Error(`parent_version is ${JSON.stringify(pv)}`);
      if (pv < 0) throw new Error(`parent_version ${pv} is negative`);
      // Go's parent_version is an int64 and the wire carries it as a raw JSON
      // number, so a value above 2^53 is representable there and NOT here —
      // JSON.parse would have already rounded it. Refusing is the only honest
      // answer: folding a silently altered version number picks the wrong parent.
      if (!Number.isSafeInteger(pv)) {
        throw new Error(`parent_version ${pv} is outside the range a JSON number can carry exactly`);
      }
    }
  }

  if (o.type === "txn_ingested" || o.type === "txn_superseded") {
    // The ingest id joins a hot op to its cold raw body. Without it that join is
    // unrecoverable, since the cold stream is fetched separately.
    if (!isSHA256Hex(o.ingest_id)) {
      throw new Error(`${o.type} needs a 64-hex-char ingest_id, got ${JSON.stringify(o.ingest_id)}`);
    }
  } else if (o.ingest_id !== undefined && o.ingest_id !== "") {
    // ingest_id is omitted when empty, so an unchecked value is junk riding into
    // a frozen wire model, and a future reader that joins on it joins to nothing.
    throw new Error(`${o.type} must not carry an ingest_id, got ${JSON.stringify(o.ingest_id)}`);
  }

  if (o.payload === undefined) throw new Error("payload is empty");
}

/**
 * Encodes ops as a hot-stream blob body. Every op is validated first: an invalid
 * op that reaches the log is permanent, because the log is append-only.
 *
 * The object handed to `JSON.stringify` is BUILT here, key by key, rather than
 * spread from the caller's: `JSON.stringify` emits keys in insertion order, so
 * building it is the only way the field order matches Go's struct order. A
 * spread of a decoded op would carry whatever order that blob happened to have.
 */
export function encodeBlobOps(ops: Op[]): Uint8Array {
  const out = ops.map((o, i) => {
    try {
      validateOp(o);
    } catch (e) {
      if (e instanceof UnknownNewerVersionError) throw e;
      throw new Error(`op ${i}: ${(e as Error).message}`);
    }
    const wire: Record<string, unknown> = {
      v: o.v,
      type: o.type,
      op_id: o.op_id,
      authored_at: canonicalTime(o.authored_at),
    };
    if (o.entity !== undefined) wire["entity"] = { kind: o.entity.kind, id: o.entity.id };
    // Present and null on every op, including a create: a create and a
    // parent-free op are distinguished by the TYPE, never by this field's
    // absence. Note it is emitted AFTER entity and BEFORE ingest_id.
    wire["parent_version"] = o.parent_version ?? null;
    if (o.ingest_id !== undefined && o.ingest_id !== "") wire["ingest_id"] = o.ingest_id;
    wire["payload"] = o.payload;
    return wire;
  });
  return new TextEncoder().encode(JSON.stringify({ v: SCHEMA_VERSION, kind: KIND_OPS, ops: out }));
}

/**
 * Decodes a cold-stream record, refusing an op blob (invariant I16).
 *
 * `raw_base64` is decoded strictly. `Buffer.from(s, "base64")` silently ignores
 * characters outside the alphabet, so a corrupted body would come back short and
 * plausible; Go's `base64.StdEncoding.DecodeString` refuses, and a cold body
 * that will not decode must be set aside rather than half-read.
 */
export function decodeRawBody(bytes: Uint8Array): RawBodyRecord {
  const { doc, literals } = parseBody(bytes, "raw body");
  requireIntegerLiteral(literals, doc, "v", "raw body");
  readVersion(doc, "raw body");
  if (doc["kind"] !== KIND_RAW_BODY) {
    throw new BlobDecodeError(`blob kind is ${JSON.stringify(doc["kind"])}, not ${JSON.stringify(KIND_RAW_BODY)}`);
  }
  const ingestID = doc["ingest_id"];
  if (!isSHA256Hex(ingestID)) {
    throw new BlobDecodeError(`raw body has no usable ingest_id: ${JSON.stringify(ingestID)}`);
  }
  const receivedAt = doc["received_at"];
  if (typeof receivedAt !== "string") {
    throw new BlobDecodeError(`raw body received_at is ${JSON.stringify(receivedAt)}`);
  }
  parseInstantMs(receivedAt);
  return { ingest_id: ingestID, received_at: receivedAt, raw: decodeBase64Strict(doc["raw_base64"]) };
}

/** Encodes a cold-stream record. Mirrors `oplog.EncodeRawBody`, field order included. */
export function encodeRawBody(r: RawBodyRecord): Uint8Array {
  if (!isSHA256Hex(r.ingest_id)) {
    throw new Error(`raw body needs a 64-hex-char ingest_id, got ${JSON.stringify(r.ingest_id)}`);
  }
  return new TextEncoder().encode(
    JSON.stringify({
      v: SCHEMA_VERSION,
      kind: KIND_RAW_BODY,
      ingest_id: r.ingest_id,
      received_at: canonicalTime(r.received_at),
      raw_base64: Buffer.from(r.raw).toString("base64"),
    }),
  );
}

function decodeBase64Strict(s: unknown): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new BlobDecodeError("raw_base64 is not standard base64");
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

// ---------------------------------------------------------------------------
// writer_checkpoint payloads
// ---------------------------------------------------------------------------

/**
 * One entry of a `writer_checkpoint` payload: the head of one writer's chain on
 * ONE stream. Chains are per (writer_id, stream), so a head that does not name a
 * stream is meaningless (Decision 13).
 */
export interface CheckpointHead {
  writer_id: string;
  stream: string;
  /** decimal string: a JS number would be lossy past 2^53 */
  counter: string;
  /** 64 hex chars */
  hash: string;
}

export interface CheckpointPayload {
  heads: CheckpointHead[];
}

/**
 * Compares two strings by their UTF-8 BYTES, which is what Go's
 * `strings.Compare` does. JavaScript's `<` compares UTF-16 code units, and the
 * two orders disagree for any string containing a character above U+FFFF (a
 * surrogate pair sorts below U+E000 in UTF-16 and above it in UTF-8).
 *
 * `auth.validWriterID` restricts writer ids to `[a-zA-Z0-9._-]`, so today the
 * two orders cannot diverge — this is written the exact way anyway, because the
 * cost is a few lines and the failure mode is two devices producing checkpoint
 * payloads that hash differently while agreeing on every value in them.
 */
function compareUTF8(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]! - y[i]!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function compareHeads(a: CheckpointHead, b: CheckpointHead): number {
  const c = compareUTF8(a.writer_id, b.writer_id);
  return c !== 0 ? c : compareUTF8(a.stream, b.stream);
}

function validateHead(h: CheckpointHead): void {
  if (typeof h.writer_id !== "string" || h.writer_id === "") throw new Error("checkpoint head has no writer_id");
  if (typeof h.stream !== "string" || h.stream === "") {
    throw new Error(`checkpoint head for ${JSON.stringify(h.writer_id)} names no stream`);
  }
  parseDecimal(h.counter);
  if (!isSHA256Hex(h.hash)) {
    throw new Error(`checkpoint head for ${JSON.stringify(h.writer_id)} has hash ${JSON.stringify(h.hash)}, want 64 hex chars`);
  }
}

/**
 * Builds the canonical `writer_checkpoint` payload: heads sorted by
 * (writer_id, stream), each object's keys in Go's struct order. This is the ONE
 * place byte-identical output across the two executors is claimed, and
 * `op.test.ts` checks it against the bytes Go generated.
 */
export function encodeCheckpointPayload(heads: CheckpointHead[]): CheckpointPayload {
  const out = heads.map((h) => {
    validateHead(h);
    return { writer_id: h.writer_id, stream: h.stream, counter: h.counter, hash: h.hash };
  });
  out.sort(compareHeads);
  for (let i = 1; i < out.length; i++) {
    if (compareHeads(out[i - 1]!, out[i]!) === 0) {
      throw new Error(`duplicate checkpoint head for (${out[i]!.writer_id}, ${out[i]!.stream})`);
    }
  }
  return { heads: out };
}

/**
 * Reads a `writer_checkpoint` payload and rejects one that is not canonically
 * ordered — an unsorted roster would hash differently on two devices that agree
 * on its contents.
 */
export function decodeCheckpointPayload(payload: unknown): CheckpointHead[] {
  if (typeof payload !== "object" || payload === null) throw new BlobDecodeError("checkpoint payload is not an object");
  const raw = (payload as Record<string, unknown>)["heads"];
  if (!Array.isArray(raw)) throw new BlobDecodeError("checkpoint payload has no heads array");
  const heads = raw.map((h) => {
    if (typeof h !== "object" || h === null) throw new BlobDecodeError("checkpoint head is not an object");
    const r = h as Record<string, unknown>;
    const head: CheckpointHead = {
      writer_id: r["writer_id"] as string,
      stream: r["stream"] as string,
      counter: r["counter"] as string,
      hash: r["hash"] as string,
    };
    try {
      validateHead(head);
    } catch (e) {
      throw new BlobDecodeError((e as Error).message);
    }
    return head;
  });
  for (let i = 1; i < heads.length; i++) {
    const c = compareHeads(heads[i - 1]!, heads[i]!);
    if (c > 0) throw new BlobDecodeError("checkpoint heads are not sorted by (writer_id, stream)");
    if (c === 0) throw new BlobDecodeError(`duplicate checkpoint head for (${heads[i]!.writer_id}, ${heads[i]!.stream})`);
  }
  return heads;
}
