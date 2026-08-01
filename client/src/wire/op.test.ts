import { expect, test } from "bun:test";
import {
  BlobDecodeError,
  OP_TYPES,
  SCHEMA_VERSION,
  UnknownNewerVersionError,
  authoredAtMs,
  canonicalTime,
  decodeBlobOps,
  decodeCheckpointPayload,
  decodeRawBody,
  encodeBlobOps,
  encodeCheckpointPayload,
  encodeRawBody,
  isParentFree,
  kindOf,
  parseDecimal,
  validateOp,
  type CheckpointHead,
  type Op,
} from "./op";

const manifest: {
  schema_version: number;
  types: string[];
  parent_free: string[];
  golden_ops_base64: string;
  golden_raw_body_base64: string;
  golden_checkpoint_base64: string;
  expect_ops: {
    type: string;
    op_id: string;
    authored_at_unix_ms: string;
    has_entity: boolean;
    parent_version: string | null;
    ingest_id: string;
  }[];
  authored_at_cases: { wire: string; expect_unix_ms: string }[];
} = await Bun.file(`${import.meta.dir}/../../../conformance/op/manifest.json`).json();

const goldenOps = new Uint8Array(Buffer.from(manifest.golden_ops_base64, "base64"));
const goldenRawBody = new Uint8Array(Buffer.from(manifest.golden_raw_body_base64, "base64"));
const goldenCheckpoint = new Uint8Array(Buffer.from(manifest.golden_checkpoint_base64, "base64"));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

const ingestID = "a".repeat(64);

function opsBlob(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

// ---------------------------------------------------------------------------
// The frozen vocabulary
// ---------------------------------------------------------------------------

test("the op type set and the parent-free set match Go's", () => {
  expect(SCHEMA_VERSION).toBe(manifest.schema_version);
  expect([...OP_TYPES]).toEqual(manifest.types as Op["type"][]);
  expect(OP_TYPES.filter(isParentFree)).toEqual(manifest.parent_free as Op["type"][]);
  // Named explicitly as well as compared: a manifest regenerated from a broken
  // Go build would otherwise agree with a broken mirror.
  expect(manifest.parent_free).toEqual(["rate_set", "rate_unset", "home_currency_set", "writer_checkpoint"]);
});

// ---------------------------------------------------------------------------
// Decoding what Go encoded
// ---------------------------------------------------------------------------

test("decodeBlobOps reads the Go golden bytes", () => {
  const ops = decodeBlobOps(goldenOps);
  expect(ops.length).toBe(manifest.expect_ops.length);
  ops.forEach((o, i) => {
    const want = manifest.expect_ops[i]!;
    expect(o.type).toBe(want.type as Op["type"]);
    expect(o.op_id).toBe(want.op_id);
    // Instants, never strings. Go's RFC3339Nano trims trailing zeros where
    // toISOString pads to three digits, so the STRINGS legitimately differ.
    expect(String(authoredAtMs(o))).toBe(want.authored_at_unix_ms);
    expect(o.entity !== undefined).toBe(want.has_entity);
    expect(o.parent_version === null ? null : String(o.parent_version)).toBe(want.parent_version);
    expect(o.ingest_id ?? "").toBe(want.ingest_id);
  });
});

test("parent_version is a raw JSON number and money is a decimal string", () => {
  // Both halves of the same frozen oddity: parent_version contradicts the
  // decimal-string rule for counters, and the payload obeys it.
  expect(utf8(goldenOps)).toContain(`"parent_version":3`);
  expect(utf8(goldenOps)).toContain(`"parent_version":null`);
  expect(utf8(goldenOps)).toContain(`"amount_minor":"25000"`);
  expect(utf8(goldenOps)).not.toContain(`"amount_minor":25000`);

  const ops = decodeBlobOps(goldenOps);
  expect(ops[1]!.parent_version).toBe(3);
  const payload = ops[0]!.payload as { amount_minor: string };
  expect(typeof payload.amount_minor).toBe("string");
  expect(parseDecimal(payload.amount_minor)).toBe(25000n);
});

test("parent_version is present and null on every op, including a create", () => {
  // A create and a parent-free op are distinguished by the TYPE, never by the
  // field's absence.
  expect(utf8(goldenOps).split(`"parent_version"`).length - 1).toBe(3);
  expect(utf8(goldenOps).split(`"ingest_id"`).length - 1).toBe(1);
});

test("decodeRawBody reads the Go golden bytes and refuses an op blob", () => {
  const r = decodeRawBody(goldenRawBody);
  expect(r.ingest_id).toBe(ingestID);
  expect(utf8(r.raw)).toBe("hi");
  expect(Date.parse(r.received_at)).toBe(Date.parse("2026-06-05T10:00:00Z"));

  // Invariant I16, in both directions: a cold blob never carries ops.
  expect(kindOf(goldenRawBody)).toBe("raw_body");
  expect(kindOf(goldenOps)).toBe("ops");
  expect(() => decodeRawBody(goldenOps)).toThrow(BlobDecodeError);
  expect(() => decodeBlobOps(goldenRawBody)).toThrow(BlobDecodeError);
});

// ---------------------------------------------------------------------------
// Encoding bytes Go accepts
// ---------------------------------------------------------------------------

test("encodeBlobOps reproduces the Go golden bytes except for the ONE documented divergence", () => {
  // The divergence: Go's RFC3339Nano trims trailing zeros ("…:00Z") and
  // JavaScript's toISOString always pads to three digits ("…:00.000Z"). That is
  // the whole of it — every other byte, including field order, omitted `entity`
  // on the parent-free op, omitted `ingest_id` and present-null
  // `parent_version`, must be identical, which is what makes this assertion a
  // pin on the field order rather than a vague "close enough".
  const got = utf8(encodeBlobOps(decodeBlobOps(goldenOps)));
  const want = utf8(goldenOps).replaceAll("T10:00:00Z", "T10:00:00.000Z");
  expect(got).toBe(want);
  expect(got).not.toBe(utf8(goldenOps)); // the divergence is real, not theoretical
});

test("the timestamp divergence is bytes only: both encoders name the same instant", () => {
  const fromGo = decodeBlobOps(goldenOps);
  const fromTS = decodeBlobOps(encodeBlobOps(fromGo));
  expect(fromTS.map(authoredAtMs)).toEqual(fromGo.map(authoredAtMs));
});

test("encodeRawBody reproduces the Go golden bytes except for the same divergence", () => {
  const r = decodeRawBody(goldenRawBody);
  const got = utf8(encodeRawBody(r));
  expect(got).toBe(utf8(goldenRawBody).replaceAll("T10:00:00Z", "T10:00:00.000Z"));
});

test("the checkpoint payload IS byte-identical, and that is claimed on purpose", () => {
  // No timestamp and no character either encoder escapes: digits, hex and
  // [a-zA-Z0-9._-] writer ids. So this one is a real byte comparison.
  const heads: CheckpointHead[] = [
    { writer_id: "ingest", stream: "hot", counter: "9", hash: "b".repeat(64) },
    { writer_id: "dev-a", stream: "hot", counter: "12", hash: "c".repeat(64) },
    { writer_id: "ingest", stream: "cold", counter: "9", hash: "d".repeat(64) },
  ];
  expect(JSON.stringify(encodeCheckpointPayload(heads))).toBe(utf8(goldenCheckpoint));

  const decoded = decodeCheckpointPayload(JSON.parse(utf8(goldenCheckpoint)));
  expect(decoded.map((h) => `${h.writer_id}|${h.stream}`)).toEqual(["dev-a|hot", "ingest|cold", "ingest|hot"]);
  // Counters are decimal strings, so a 2^53+ head survives.
  expect(parseDecimal(decoded[0]!.counter)).toBe(12n);
});

test("checkpoint payloads that are not canonical are refused", () => {
  const good: CheckpointHead = { writer_id: "dev-a", stream: "hot", counter: "1", hash: "c".repeat(64) };
  expect(() => encodeCheckpointPayload([{ ...good, stream: "" }])).toThrow();
  expect(() => encodeCheckpointPayload([good, { ...good, counter: "2" }])).toThrow();
  expect(() => encodeCheckpointPayload([{ ...good, counter: "1.5" }])).toThrow();
  expect(() => encodeCheckpointPayload([{ ...good, hash: "nope" }])).toThrow();
  // An unsorted heads array hashes differently on two devices that agree on
  // every value in it, so decoding refuses it rather than silently sorting.
  expect(() =>
    decodeCheckpointPayload({
      heads: [
        { writer_id: "ingest", stream: "hot", counter: "9", hash: "b".repeat(64) },
        { writer_id: "dev-a", stream: "hot", counter: "12", hash: "c".repeat(64) },
      ],
    }),
  ).toThrow(BlobDecodeError);
});

// ---------------------------------------------------------------------------
// authored_at: the millisecond rule
// ---------------------------------------------------------------------------

test("authored_at is truncated to milliseconds, to the instants Go decoded", () => {
  // These pairs were GENERATED by Go's decoder. They are the whole point of the
  // rule: a Go writer emitting microseconds would produce two ops that Go orders
  // and TypeScript calls tied, i.e. two executors materialising different money.
  expect(manifest.authored_at_cases.length).toBeGreaterThan(0);
  for (const c of manifest.authored_at_cases) {
    const ops = decodeBlobOps(
      opsBlob(
        `{"v":1,"kind":"ops","ops":[{"v":1,"type":"rate_set","op_id":"R1",` +
          `"authored_at":"${c.wire}","parent_version":null,"payload":{}}]}`,
      ),
    );
    expect(String(authoredAtMs(ops[0]!))).toBe(c.expect_unix_ms);
    // And the decoded string carries no precision a Date cannot hold.
    expect(ops[0]!.authored_at).toBe(new Date(Number(c.expect_unix_ms)).toISOString());
  }
});

test("sub-millisecond precision is truncated, never rounded", () => {
  // Pinned separately from the manifest loop because it is the case that would
  // silently diverge: Go truncates, and a JS engine that rounded .0015 to 2ms
  // would break fork tiebreaks without breaking anything visible.
  expect(canonicalTime("2026-06-05T10:00:00.0015Z")).toBe("2026-06-05T10:00:00.001Z");
  expect(canonicalTime("2026-06-05T10:00:00.0019Z")).toBe("2026-06-05T10:00:00.001Z");
  expect(canonicalTime("2026-06-05T10:00:00.0000015Z")).toBe("2026-06-05T10:00:00.000Z");
  // Offsets are normalised to UTC.
  expect(canonicalTime("2026-06-05T14:00:00.5+04:00")).toBe("2026-06-05T10:00:00.500Z");
});

test("timestamps Go's time.Time would refuse are refused here too", () => {
  // Date.parse accepts implementation-defined formats that Go rejects outright,
  // so without the RFC3339 shape check this executor would accept blobs the
  // other one sets aside.
  for (const bad of ["June 5 2026", "2026-06-05", "2026-06-05 10:00:00Z", "", "0001-01-01T00:00:00Z"]) {
    expect(() => canonicalTime(bad)).toThrow(BlobDecodeError);
  }
  // The sharpest of them: Go's time.Parse(time.RFC3339) refuses a lowercase
  // t/z separator and Date.parse accepts it happily, so without the explicit
  // uppercase requirement this executor would fold an op the other sets aside.
  expect(Date.parse("2026-06-05t10:00:00z")).toBe(Date.parse("2026-06-05T10:00:00Z"));
  expect(() => canonicalTime("2026-06-05t10:00:00z")).toThrow(BlobDecodeError);
  // A numeric offset is accepted by both, including -00:00.
  expect(canonicalTime("2026-06-05T10:00:00-00:00")).toBe("2026-06-05T10:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Money and counters are BigInt, never number
// ---------------------------------------------------------------------------

test("parseDecimal keeps values a float64 cannot hold", () => {
  const huge = "9007199254740993"; // 2^53 + 1
  expect(parseDecimal(huge)).toBe(9007199254740993n);
  expect(String(Number(huge))).not.toBe(huge); // the bug this exists to prevent
  for (const bad of ["", "-1", "+1", "1.5", "1e3", " 1", "0x10", "١٢٣"]) {
    expect(() => parseDecimal(bad)).toThrow(BlobDecodeError);
  }
});

test("FX conversion must be BigInt: the intermediate product overflows 2^53", () => {
  // A guard, not the implementation — positional FX snapshots are Task 12's
  // client/src/replay/fx.ts. Pinned here because the trap is in the wire model's
  // units: amount_minor and rate_micro are both decimal strings for this reason.
  const convert = (amountMinor: bigint, rateMicro: bigint) => (amountMinor * rateMicro + 500_000n) / 1_000_000n;
  const viaFloat64 = (amountMinor: bigint, rateMicro: bigint) =>
    BigInt(Math.round((Number(amountMinor) * Number(rateMicro)) / 1_000_000));

  // An ordinary amount: the PRODUCT already leaves the exact range even though
  // both operands and the result are comfortably inside it.
  const amountMinor = parseDecimal("2500000000"); // 25,000,000.00 minor units
  const rateMicro = parseDecimal("3672500");
  expect(convert(amountMinor, rateMicro)).toBe(9181250000n);
  expect(Number(amountMinor) * Number(rateMicro)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

  // This is why the trap is latent rather than loud: at ordinary magnitudes the
  // final division by 1e6 absorbs the float64 error, so a `number` implementation
  // passes every plausible test and is still wrong.
  expect(viaFloat64(amountMinor, rateMicro)).toBe(convert(amountMinor, rateMicro));

  // Push the product far enough past 2^53 that the ulp survives the division —
  // amount_minor is an int64 on the wire, so this is a representable value —
  // and the two answers separate.
  const big = parseDecimal("9007199254740993"); // 2^53 + 1
  const rate = parseDecimal("1000001");
  expect(convert(big, rate)).toBe(9007208261940248n);
  expect(viaFloat64(big, rate)).not.toBe(convert(big, rate));
  // The operand itself is already lost before any arithmetic happens.
  expect(BigInt(Number(big))).not.toBe(big);
});

// ---------------------------------------------------------------------------
// Hard stop vs set aside
// ---------------------------------------------------------------------------

test("an unknown newer version hard-stops, at the blob level and the op level", () => {
  expect(() => decodeBlobOps(opsBlob(`{"v":2,"kind":"ops","ops":[]}`))).toThrow(UnknownNewerVersionError);
  expect(() =>
    decodeBlobOps(
      opsBlob(
        `{"v":1,"kind":"ops","ops":[{"v":2,"type":"rate_set","op_id":"R1",` +
          `"authored_at":"2026-06-05T10:00:00Z","parent_version":null,"payload":{}}]}`,
      ),
    ),
  ).toThrow(UnknownNewerVersionError);
  // Reserved for exactly that: everything else is a set-aside, so a caller can
  // tell "stop syncing" from "skip this blob" by the class alone.
  expect(new UnknownNewerVersionError("x")).not.toBeInstanceOf(BlobDecodeError);
  expect(new BlobDecodeError("x")).not.toBeInstanceOf(UnknownNewerVersionError);
});

test("a blob that will not decode is a set-aside, not a hard stop", () => {
  for (const bad of [
    ``,
    `not json`,
    `[]`,
    `{"v":0,"kind":"ops","ops":[]}`,
    `{"v":1,"kind":"raw_body","ops":[]}`,
    `{"v":1,"kind":"ops","ops":{}}`,
    `{"v":1,"kind":"ops","ops":[7]}`,
    `{"v":1,"ops":[]}`,
  ]) {
    expect(() => decodeBlobOps(opsBlob(bad))).toThrow(BlobDecodeError);
  }
  // A missing or null ops array is zero ops, matching Go's nil slice — refusing
  // it would set aside a blob the other executor reads happily.
  expect(decodeBlobOps(opsBlob(`{"v":1,"kind":"ops"}`))).toEqual([]);
  expect(decodeBlobOps(opsBlob(`{"v":1,"kind":"ops","ops":null}`))).toEqual([]);
});

test("raw_base64 is decoded strictly", () => {
  // Buffer.from(s, "base64") silently ignores characters outside the alphabet,
  // so a corrupted body would come back short and plausible.
  const body = (raw: string) =>
    opsBlob(`{"v":1,"kind":"raw_body","ingest_id":"${ingestID}","received_at":"2026-06-05T10:00:00Z","raw_base64":"${raw}"}`);
  expect(utf8(decodeRawBody(body("aGk=")).raw)).toBe("hi");
  for (const bad of ["a Gk=", "aGk", "aG!=", "====", "aGk=="]) {
    expect(() => decodeRawBody(body(bad))).toThrow(BlobDecodeError);
  }
});

// ---------------------------------------------------------------------------
// validateOp: the structural rules replay depends on
// ---------------------------------------------------------------------------

function rateOp(): Op {
  return {
    v: 1,
    type: "rate_set",
    op_id: "01J000000000000000000000R1",
    authored_at: "2026-06-05T10:00:00.000Z",
    parent_version: null,
    payload: { currency: "USD", rate_micro: "3672500" },
  };
}

function txnOp(): Op {
  return {
    v: 1,
    type: "txn_ingested",
    op_id: "01J000000000000000000000I1",
    authored_at: "2026-06-05T10:00:00.000Z",
    entity: { kind: "txn", id: "T1" },
    parent_version: null,
    ingest_id: ingestID,
    payload: { amount_minor: "25000", currency: "AED" },
  };
}

test("a parent-free op may not name an entity or carry a parent_version", () => {
  // Modelling rates as versioned entities imports fork resolution into FX, and
  // the two readings produce different numbers across the two executors.
  expect(() => validateOp(rateOp())).not.toThrow();
  expect(() => validateOp({ ...rateOp(), entity: { kind: "rate", id: "USD" } })).toThrow();
  expect(() => validateOp({ ...rateOp(), parent_version: 1 })).toThrow();
});

test("a causal op must name an entity", () => {
  const { entity, ...noEntity } = txnOp();
  expect(entity).toBeDefined();
  expect(() => validateOp(noEntity as Op)).toThrow();
  expect(() => validateOp({ ...txnOp(), entity: { kind: "txn", id: "" } })).toThrow();
  expect(() => validateOp({ ...txnOp(), parent_version: -1 })).toThrow();
});

/** Drops the key entirely, which is what "carries no ingest_id" means on the wire. */
function withoutIngestID(o: Op): Op {
  const { ingest_id, ...rest } = o;
  void ingest_id;
  return rest;
}

test("ingest_id is required on the two ingest ops and refused on every other", () => {
  expect(() => validateOp({ ...txnOp(), ingest_id: "junk" })).toThrow();
  expect(() => validateOp({ ...rateOp(), ingest_id: ingestID })).toThrow();
  expect(() =>
    validateOp({ ...withoutIngestID(txnOp()), type: "txn_categorized", payload: { category: "groceries" } }),
  ).not.toThrow();
});

test("a parent_version past 2^53 is refused rather than silently rounded", () => {
  // The frozen wire carries parent_version as a raw JSON NUMBER, so Go's int64
  // can express a value this executor cannot. JSON.parse has already rounded it
  // by the time we see it, and folding a silently altered version number picks
  // the wrong parent — so the honest answer is to set the blob aside.
  const wire =
    `{"v":1,"kind":"ops","ops":[{"v":1,"type":"txn_categorized","op_id":"A1",` +
    `"authored_at":"2026-06-05T10:00:00Z","entity":{"kind":"txn","id":"T1"},` +
    `"parent_version":9007199254740993,"payload":{}}]}`;
  expect(JSON.parse(wire).ops[0].parent_version).toBe(9007199254740992); // already lossy
  expect(() => decodeBlobOps(opsBlob(wire))).toThrow(BlobDecodeError);
  // The largest value that IS exact still works.
  expect(() =>
    validateOp({ ...withoutIngestID(txnOp()), type: "txn_edited", parent_version: 9007199254740991 }),
  ).not.toThrow();
});

test("encodeBlobOps refuses to write an op the log could never take back", () => {
  // The log is append-only: an invalid op that reaches it is permanent.
  expect(() => encodeBlobOps([{ ...rateOp(), type: "nope" as Op["type"] }])).toThrow();
  expect(() => encodeBlobOps([{ ...rateOp(), op_id: "" }])).toThrow();
  expect(() => encodeBlobOps([{ ...rateOp(), authored_at: "whenever" }])).toThrow();
  expect(() => encodeBlobOps([{ ...rateOp(), payload: undefined }])).toThrow();
  expect(() => encodeBlobOps([{ ...rateOp(), v: 2 }])).toThrow(UnknownNewerVersionError);
});
