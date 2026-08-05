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
  parseInstantMs,
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
  authored_at_cases: { wire: string; expect_unix_ms: string; expect_canonical_wire: string }[];
  authored_at_rejects: string[];
  parent_version_overflow_base64: string;
  parent_version_overflow: string;
  duplicate_disposition_base64: string;
  duplicate_disposition_invalid_payloads: unknown[];
  verified_origin_base64: string;
} = await Bun.file(`${import.meta.dir}/../../../conformance/op/manifest.json`).json();

const goldenOps = new Uint8Array(Buffer.from(manifest.golden_ops_base64, "base64"));
const goldenRawBody = new Uint8Array(Buffer.from(manifest.golden_raw_body_base64, "base64"));
const goldenCheckpoint = new Uint8Array(Buffer.from(manifest.golden_checkpoint_base64, "base64"));
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

const ingestID = "a".repeat(64);

/** The Go-authored blob manifest, read lazily so op.test.ts stays about ops. */
function blobFixtures(): { fixtures: { file: string; expect_plaintext_base64: string }[] } {
  return require(`${import.meta.dir}/../../../conformance/blob/manifest.json`);
}

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

test("the shared schema-v2 duplicate disposition fixture decodes", () => {
  const bytes = new Uint8Array(Buffer.from(manifest.duplicate_disposition_base64, "base64"));
  const [op] = decodeBlobOps(bytes);
  expect(op?.type).toBe("txn_duplicate_disposition");
  expect(op?.payload).toEqual({ other_txn_id: "T0", disposition: "same" });
});

test("both TS wire directions refuse every shared malformed duplicate disposition", () => {
  for (const [index, payload] of (manifest.duplicate_disposition_invalid_payloads as unknown[]).entries()) {
    const op: Op = {
      v: 2, type: "txn_duplicate_disposition", op_id: `invalid-${index}`,
      authored_at: "2026-06-05T10:00:00Z", entity: { kind: "txn", id: "T1" }, parent_version: 1, payload,
    };
    expect(() => encodeBlobOps([op])).toThrow();
    const body = opsBlob(JSON.stringify({ v: 2, kind: "ops", ops: [op] }));
    expect(() => decodeBlobOps(body)).toThrow(BlobDecodeError);
  }
});

test("the shared schema-v2 verified origin fixture is preserved", () => {
  const [op] = decodeBlobOps(new Uint8Array(Buffer.from(manifest.verified_origin_base64, "base64")));
  expect((op?.payload as Record<string, unknown>).verified_origin_domain).toBe("bank.example");
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

test("this executor can read the timestamp string Go actually writes", () => {
  // The direction the suite was missing entirely. Every timestamp assertion
  // above compares parsed INSTANTS, which is right for the trailing-zero
  // divergence and blind to a canonical form outside the shared grammar: the
  // wire admits `9999-12-31T23:59:59-23:59`, whose UTC value is year 10000, and
  // there Go writes `10000-01-01T23:58:59Z` while `toISOString` writes
  // `+010000-01-01T23:58:59.000Z`. Neither side ever saw the other's string, so
  // neither could notice. `expect_canonical_wire` carries Go's rendering and
  // this reads it.
  for (const c of manifest.authored_at_cases) {
    expect(parseInstantMs(c.expect_canonical_wire)).toBe(Number(c.expect_unix_ms));
    // Go's spelling is not this one — `.5Z` against `.500Z` — and that stays
    // true; what is claimed is that each side can READ the other's.
    expect(canonicalTime(c.expect_canonical_wire)).toBe(canonicalTime(c.wire));
  }
  // The divergence has to still be real, or the assertion above is vacuous.
  expect(manifest.authored_at_cases.some((c) => c.expect_canonical_wire !== canonicalTime(c.wire))).toBe(true);
});

test("canonicalTime is CLOSED over the wire grammar, and idempotent", () => {
  // Canonicalisation maps wire timestamps to wire timestamps. When it does not,
  // "both executors read the same instant" says nothing about the value they
  // STORE — which is how a wire-legal `posted_at` reached the replay state as
  // `+010000-01-01T23:58:59.000Z` and threw out of the fold (see replay.ts's
  // `instant`). Stated over the accept set Go publishes, so the two executors
  // are closed over the same inputs.
  for (const c of manifest.authored_at_cases) {
    const canonical = canonicalTime(c.wire);
    // Four year digits, named literally: this is the character the expanded
    // form adds, and the assertion that dies if this executor's spelling moves.
    expect(canonical).toMatch(/^[0-9]{4}-/);
    expect(parseInstantMs(canonical)).toBe(Number(c.expect_unix_ms));
    expect(canonicalTime(canonical)).toBe(canonical); // idempotent
  }
  // The boundary cases named, not just looped. The list is generated from Go's
  // timeAcceptCases, so a case DELETED from the fixture takes both executors
  // green together — a mutation run walked through exactly that hole by
  // dropping the year-9999 case. Go names the same four.
  const wires = manifest.authored_at_cases.map((c) => c.wire);
  for (const must of [
    "0000-01-01T00:00:00Z",
    "9999-12-31T23:59:59.999Z",
    "0000-02-29T00:00:00Z",
    "2026-06-05T10:00:00-23:59",
  ]) {
    expect(wires).toContain(must);
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
  expect(() => decodeBlobOps(opsBlob(`{"v":3,"kind":"ops","ops":[]}`))).toThrow(UnknownNewerVersionError);
  expect(() =>
    decodeBlobOps(
      opsBlob(
        `{"v":1,"kind":"ops","ops":[{"v":3,"type":"rate_set","op_id":"R1",` +
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

test("the parent_version overflow blob Go accepts is refused here, from shared bytes", () => {
  // Go encoded this blob and asserts IT decodes the value exactly; this side
  // must refuse the same bytes. The asymmetry is a property of the frozen wire —
  // parent_version is a raw JSON number, so an int64 above 2^53 is expressible
  // in Go and already rounded by JSON.parse before this executor sees it — and
  // pinning it from a shared artifact is what stops it being a claim in a
  // comment.
  expect(parseDecimal(manifest.parent_version_overflow)).toBe(9007199254740993n);
  const blob = new Uint8Array(Buffer.from(manifest.parent_version_overflow_base64, "base64"));
  expect(() => decodeBlobOps(blob)).toThrow(BlobDecodeError);
  // And it is a set-aside, not the sync hard stop.
  expect(() => decodeBlobOps(blob)).not.toThrow(UnknownNewerVersionError);
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
  expect(() => encodeBlobOps([{ ...rateOp(), v: 3 }])).toThrow(UnknownNewerVersionError);
});

// ---------------------------------------------------------------------------
// The timestamp grammar, as a SHARED table
// ---------------------------------------------------------------------------

test("every timestamp Go refuses is refused here too", () => {
  // conformance/op/manifest.json carries this list, and Go asserts the same
  // strings against its own decoder. Two hand-maintained lists would drift into
  // exactly the bug they exist to prevent: one side quietly accepting what the
  // other refuses.
  expect(manifest.authored_at_rejects.length).toBeGreaterThan(10);
  for (const wire of manifest.authored_at_rejects) {
    const blob = opsBlob(
      `{"v":1,"kind":"ops","ops":[{"v":1,"type":"rate_set","op_id":"R1",` +
        `"authored_at":${JSON.stringify(wire)},"parent_version":null,"payload":{}}]}`,
    );
    expect(() => decodeBlobOps(blob)).toThrow(BlobDecodeError);
  }
  // Named explicitly as well as looped, for the reason the parent-free set is:
  // the list is GENERATED from Go's timeRejectCases, so deleting an entry and
  // regenerating would take both executors green together. Go names the same
  // six.
  for (const must of [
    "9999-12-31T23:59:59-23:59",
    "0000-01-01T00:00:00+00:01",
    "+010000-01-01T23:58:59.000Z",
    "10000-01-01T23:58:59Z",
    "-0001-12-31T23:59:00Z",
    "2026-06-05T10:00:00-24:00",
  ]) {
    expect(manifest.authored_at_rejects).toContain(must);
  }
});

test("the expanded-year range is refused, and it is refused as a RULE", () => {
  // The divergence this test exists for, with both measured spellings.
  //
  // These two are wire-legal by every rule that existed: four digits of year, a
  // real calendar date, an offset inside ±23:59. Their UTC value leaves years
  // 0000-9999, which the grammar cannot express — and the executors do not
  // agree on how to write that.
  //
  //   9999-12-31T23:59:59-23:59  Go: 10000-01-01T23:58:59Z  JS: +010000-01-01T23:58:59.000Z
  //   0000-01-01T00:00:00+00:01  Go: -0001-12-31T23:59:00Z  JS: -000001-12-31T23:59:00.000Z
  //
  // Go ACCEPTED both and this executor refused them, so the op landed in one
  // executor's log and in neither device's — and this side only refused as a
  // by-product of `decodeOp` canonicalising before `validateOp` re-parses.
  for (const [wire, jsSpelling] of [
    ["9999-12-31T23:59:59-23:59", "+010000-01-01T23:58:59.000Z"],
    ["0000-01-01T00:00:00+00:01", "-000001-12-31T23:59:00.000Z"],
  ] as const) {
    // The instant is readable; it is the canonical FORM that is not. Pinned so
    // the test cannot pass for the wrong reason (e.g. the input being refused
    // by shape, which would make the closure check vacuous).
    expect(new Date(parseInstantMs(wire)).toISOString()).toBe(jsSpelling);
    expect(() => canonicalTime(wire)).toThrow(BlobDecodeError);
    // As a rule, not as an ordering accident: the refusal names the range.
    expect(() => canonicalTime(wire)).toThrow(/four-digit-year range/);
    // …and it holds on every path a timestamp enters or leaves by.
    const blob = opsBlob(
      `{"v":1,"kind":"ops","ops":[{"v":1,"type":"rate_set","op_id":"R1",` +
        `"authored_at":${JSON.stringify(wire)},"parent_version":null,"payload":{}}]}`,
    );
    expect(() => decodeBlobOps(blob)).toThrow(BlobDecodeError);
    expect(() => encodeBlobOps([{ ...rateOp(), authored_at: wire }])).toThrow();
    expect(() => encodeRawBody({ ingest_id: ingestID, received_at: wire, raw: new Uint8Array([1]) })).toThrow();
    expect(() =>
      decodeRawBody(
        opsBlob(
          `{"v":1,"kind":"raw_body","ingest_id":"${ingestID}",` +
            `"received_at":${JSON.stringify(wire)},"raw_base64":"aGk="}`,
        ),
      ),
    ).toThrow(BlobDecodeError);
  }

  // The legal neighbours still pass, so what is refused is the range and not
  // the millennium either side of it.
  expect(canonicalTime("9999-12-31T23:59:59.999Z")).toBe("9999-12-31T23:59:59.999Z");
  expect(canonicalTime("0000-01-01T00:00:00Z")).toBe("0000-01-01T00:00:00.000Z");
  expect(canonicalTime("0000-02-29T00:00:00Z")).toBe("0000-02-29T00:00:00.000Z"); // year 0 is leap
  // And an offset is bounded at ±23:59 in BOTH directions; only + was pinned.
  expect(canonicalTime("2026-06-05T10:00:00-23:59")).toBe("2026-06-06T09:59:00.000Z");
  expect(() => canonicalTime("2026-06-05T10:00:00-24:00")).toThrow(BlobDecodeError);
});

test("Date.parse's rollover never gets a say", () => {
  // The two rows of the divergence table that were live bugs. The second is
  // worse than an acceptance disagreement: Date.parse yields an instant in
  // MARCH for a February date, so this executor would have folded the op at a
  // moment no legal reading of the string produces — and authored_at is the
  // fork tiebreak.
  expect(new Date(Date.parse("2026-06-05T24:00:00Z")).toISOString()).toBe("2026-06-06T00:00:00.000Z");
  expect(new Date(Date.parse("2026-02-30T10:00:00Z")).toISOString()).toBe("2026-03-02T10:00:00.000Z");
  expect(() => canonicalTime("2026-06-05T24:00:00Z")).toThrow(BlobDecodeError);
  expect(() => canonicalTime("2026-02-30T10:00:00Z")).toThrow(BlobDecodeError);

  // Leap years are computed the Gregorian way, matching Go's daysIn.
  expect(() => canonicalTime("2024-02-29T00:00:00Z")).not.toThrow(); // divisible by 4
  expect(() => canonicalTime("2000-02-29T00:00:00Z")).not.toThrow(); // divisible by 400
  expect(() => canonicalTime("1900-02-29T00:00:00Z")).toThrow(); // century, not by 400
  expect(() => canonicalTime("2026-02-29T00:00:00Z")).toThrow();

  // An offset is accepted up to ±23:59 and no further. Stock Go read +24:00 as
  // a real offset and Date.parse refuses it, so both sides were tightened onto
  // the canonical RFC 3339 reading instead of either mirroring the other.
  expect(canonicalTime("2026-06-05T10:00:00+23:59")).toBe("2026-06-04T10:01:00.000Z");
  expect(() => canonicalTime("2026-06-05T10:00:00+24:00")).toThrow(BlobDecodeError);
  expect(() => canonicalTime("2026-06-05T10:00:00+00:60")).toThrow(BlobDecodeError);
});

// ---------------------------------------------------------------------------
// Number LITERALS, which JSON.parse throws away
// ---------------------------------------------------------------------------

test("a non-integer literal in a structural field is refused, as Go refuses it", () => {
  // Go decodes v into an int and parent_version into an *int64, both of which
  // refuse 1.0 outright. JSON.parse destroys the distinction, so the check runs
  // against the reviver's source text.
  expect(JSON.parse(`{"v":1.0}`).v).toBe(1); // indistinguishable after parsing
  expect(() => decodeBlobOps(opsBlob(`{"v":1.0,"kind":"ops","ops":[]}`))).toThrow(BlobDecodeError);
  expect(() =>
    decodeBlobOps(
      opsBlob(
        `{"v":1,"kind":"ops","ops":[{"v":1.0,"type":"rate_set","op_id":"R1",` +
          `"authored_at":"2026-06-05T10:00:00Z","parent_version":null,"payload":{}}]}`,
      ),
    ),
  ).toThrow(BlobDecodeError);
  expect(() =>
    decodeBlobOps(
      opsBlob(
        `{"v":1,"kind":"ops","ops":[{"v":1,"type":"txn_categorized","op_id":"A1",` +
          `"authored_at":"2026-06-05T10:00:00Z","entity":{"kind":"txn","id":"T1"},` +
          `"parent_version":3.0,"payload":{}}]}`,
      ),
    ),
  ).toThrow(BlobDecodeError);
});

test("the literal check is scoped to structural fields and leaves payloads alone", () => {
  // Go never parses a payload — it is a json.RawMessage — so rejecting a
  // fractional number inside one would trade this divergence for a worse one.
  const ops = decodeBlobOps(
    opsBlob(
      `{"v":1,"kind":"ops","ops":[{"v":1,"type":"rate_set","op_id":"R1",` +
        `"authored_at":"2026-06-05T10:00:00Z","parent_version":null,` +
        `"payload":{"v":1.5,"parent_version":2.5,"ratio":0.25}}]}`,
    ),
  );
  expect((ops[0]!.payload as { ratio: number }).ratio).toBe(0.25);
  expect((ops[0]!.payload as { v: number }).v).toBe(1.5);
});

test("Go's escaped payload decodes back to the same strings here", () => {
  // The Go->TypeScript direction of the escaping asymmetry. conformance/ts
  // already proves Go reads what JSON.stringify emits literally; this proves
  // this executor reads what Go's encoder escaped as \uXXXX. Without it the
  // asymmetry was only ever exercised with Go as the reader.
  const blobManifest = blobFixtures();
  const f = blobManifest.fixtures.find((x) => x.file === "hot-dev-a-11-escapes.bin");
  expect(f).toBeDefined();
  const plaintext = new Uint8Array(Buffer.from(f!.expect_plaintext_base64, "base64"));

  // Go really did escape them: the bytes contain no literal & or <.
  const asText = utf8(plaintext);
  expect(asText).toContain("\\u0026");
  expect(asText).toContain("\\u003c");
  expect(asText).toContain("\\u2028");
  expect(asText).not.toContain("&");

  const ops = decodeBlobOps(plaintext);
  const payload = ops[0]!.payload as { merchant_raw: string; note: string; amount_minor: string };
  expect(payload.merchant_raw).toBe("كارفور");
  expect(payload.note).toBe("Smith & Sons <flagged> \u2028 second line \u2029 end");
  expect(parseDecimal(payload.amount_minor)).toBe(25000n);
  expect(ops[0]!.parent_version).toBe(1);
});
