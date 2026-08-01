import { expect, test } from "bun:test";
import { foldBlobs, type LogEntry, type PositionedBlob } from "../replay/replay";
import { emptyState, entityKey, serializeState, type State } from "../replay/state";
import { openBlob, sealBlob, type Stream } from "../wire/blob";
import { ZERO_HASH, chainHash, chainKey, type ChainKey, type HashRow, type Head } from "../wire/chain";
import {
  decodeBlobOps,
  encodeBlobOps,
  encodeCheckpointPayload,
  encodeRawBody,
  type CheckpointHead,
  type Op,
  type OpType,
} from "../wire/op";
import {
  ANOMALY_KINDS,
  INVARIANT_IDS,
  WRITER_KIND_DEVICE,
  WRITER_KIND_INGEST,
  checkAll,
  type CheckInput,
  type SyncRow,
  type Violation,
  type Writer,
} from "./check";

// ---------------------------------------------------------------------------
// Reading the results
// ---------------------------------------------------------------------------

const ids = (vs: Violation[]): string[] => vs.map((v) => v.id);
const hardStops = (vs: Violation[]): Violation[] => vs.filter((v) => v.severity === "hard_stop");
const stopIDs = (vs: Violation[]): string[] => ids(hardStops(vs));
const find = (vs: Violation[], id: string): Violation | undefined => vs.find((v) => v.id === id);

/** Every violation of `id`, so a test can assert on the one it means. */
const all = (vs: Violation[], id: string): Violation[] => vs.filter((v) => v.id === id);

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/**
 * Flips a byte deep in a blob's PADDING: the frame, the AAD, the length and the
 * payload are all untouched, so the blob still opens and still decodes and only
 * its hash moves. That is what makes it a clean probe of the chain alone.
 */
function flipPadding(b: Uint8Array): void {
  const i = b.length - 20; // past the payload, before the 16-byte tag slot
  b[i] = (b[i] ?? 0) ^ 0xff;
}

// ---------------------------------------------------------------------------
// Op builders
//
// Real ops that `validateOp` accepts: 64-hex ingest ids, RFC3339 UTC timestamps,
// money as decimal STRINGS. A builder that produced something the wire model
// refuses would exercise the anomaly path by accident.
// ---------------------------------------------------------------------------

const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

let opCounter = 0;
const nextOpID = (): string => `op-${++opCounter}`;

function mk(type: OpType, authoredAt: string, rest: Partial<Op> & { payload: unknown }): Op {
  return { v: 1, type, op_id: nextOpID(), authored_at: authoredAt, parent_version: null, ...rest };
}

interface TxnFields {
  amount_minor?: string;
  currency?: string;
  merchant_raw?: string;
  last4?: string;
  posted_at?: string;
}

function txnPayload(over: TxnFields): Record<string, unknown> {
  return {
    amount_minor: over.amount_minor ?? "25000",
    currency: over.currency ?? "AED",
    direction: "debit",
    posted_at: over.posted_at ?? "2026-06-05T09:00:00Z",
    merchant_raw: over.merchant_raw ?? "CARREFOUR",
    last4: over.last4 ?? "3701",
  };
}

const homeCurrency = (ccy: string, at = "2026-06-01T00:00:00Z"): Op =>
  mk("home_currency_set", at, { payload: { currency: ccy } });

const rateSet = (ccy: string, micro: string, at = "2026-06-01T00:01:00Z"): Op =>
  mk("rate_set", at, { payload: { currency: ccy, rate_micro: micro } });

const ingested = (ingest: string, txnId: string, over: TxnFields = {}, at = "2026-06-05T09:00:05Z"): Op =>
  mk("txn_ingested", at, { entity: { kind: "txn", id: txnId }, ingest_id: ingestID(ingest), payload: txnPayload(over) });

const superseded = (ingest: string, txnId: string, over: TxnFields = {}, at = "2026-06-06T09:00:05Z"): Op =>
  mk("txn_superseded", at, {
    entity: { kind: "txn", id: txnId },
    ingest_id: ingestID(ingest),
    payload: txnPayload(over),
  });

const categorized = (txnId: string, parent: number, category: string, at = "2026-06-05T10:00:00Z"): Op =>
  mk("txn_categorized", at, { entity: { kind: "txn", id: txnId }, parent_version: parent, payload: { category } });

const split = (txnId: string, parent: number, parts: [string, string][], at = "2026-06-05T11:00:00Z"): Op =>
  mk("txn_split", at, {
    entity: { kind: "txn", id: txnId },
    parent_version: parent,
    payload: { parts: parts.map(([category, amount_minor]) => ({ category, amount_minor })) },
  });

const edited = (txnId: string, parent: number, fields: Record<string, unknown>, at = "2026-06-05T12:00:00Z"): Op =>
  mk("txn_edited", at, { entity: { kind: "txn", id: txnId }, parent_version: parent, payload: fields });

const ruleAdded = (id: string, parent: number | null, category: string, at = "2026-06-05T14:00:00Z"): Op =>
  mk("rule_added", at, {
    entity: { kind: "rule", id },
    parent_version: parent,
    payload: { pattern: `P-${category}`, match: "contains", category, priority: 10 },
  });

const checkpointOp = (heads: CheckpointHead[], at = "2026-06-07T00:00:00Z"): Op =>
  mk("writer_checkpoint", at, { payload: encodeCheckpointPayload(heads) });

// ---------------------------------------------------------------------------
// The fixture assembler
//
// Everything is REAL: real sealed blobs at real envelopes, real SHA-256 chains,
// a real fold. A fixture built from hand-written rows would let the checker pass
// against bytes no server could produce, which is the failure mode that makes an
// invariant checker worthless.
// ---------------------------------------------------------------------------

const USER = "11111111-1111-1111-1111-111111111111";

interface Plan {
  writer: string;
  ops?: Op[];
  /** Overrides `ops`: a body that is not an op list (a raw body, or garbage). */
  plaintext?: Uint8Array;
  /** Built from the chain heads standing BEFORE this blob — for checkpoints. */
  opsFrom?: (heads: Map<ChainKey, Head>) => Op[];
}

interface AssembleOpts {
  stream?: Stream;
  plans: Plan[];
  roster?: Writer[];
  cursorBefore?: bigint;
  pinnedHeads?: Map<ChainKey, Head>;
  /** Used when the stream is cold, where the bodies are not ops. */
  state?: State;
}

const device = (id: string, revoked: string | null = null): Writer => ({
  writer_id: id,
  kind: WRITER_KIND_DEVICE,
  revoked_at: revoked,
});
const ingestWriter = (): Writer => ({ writer_id: "ingest", kind: WRITER_KIND_INGEST, revoked_at: null });

function assemble(o: AssembleOpts): CheckInput {
  const stream: Stream = o.stream ?? "hot";
  const heads = new Map<ChainKey, Head>(o.pinnedHeads ?? []);
  const rows: SyncRow[] = [];
  const hashList: HashRow[] = [];
  const blobs: PositionedBlob[] = [];
  let seq = o.cursorBefore ?? 0n;

  for (const p of o.plans) {
    seq += 1n;
    const key = chainKey(p.writer, stream);
    const prev = heads.get(key) ?? { counter: 0n, hash: ZERO_HASH };
    const counter = prev.counter + 1n;
    const plaintext = p.plaintext ?? encodeBlobOps(p.opsFrom !== undefined ? p.opsFrom(heads) : (p.ops ?? []));
    const blob = sealBlob({ userId: USER, stream, writerId: p.writer, writerCounter: counter }, plaintext);
    const blobHash = chainHash(prev.hash, blob);
    heads.set(key, { counter, hash: blobHash });
    rows.push({
      seq,
      stream,
      writer_id: p.writer,
      writer_counter: counter,
      prev_hash: prev.hash,
      blob_hash: blobHash,
      blob,
      size_bucket: blob.length,
    });
    hashList.push({ seq, writer_id: p.writer, writer_counter: counter, prev_hash: prev.hash, blob_hash: blobHash });
    blobs.push({ pos: { writer_id: p.writer, stream, writer_counter: counter, seq }, body: plaintext });
  }

  // The hot stream is the one replay folds; a cold body is a raw email.
  let state = o.state ?? emptyState();
  const ops: LogEntry[] = [];
  if (stream === "hot") {
    state = foldBlobs(blobs, state);
    for (const b of blobs) {
      let decoded: Op[];
      try {
        decoded = decodeBlobOps(b.body);
      } catch {
        continue; // set aside; it is in state.unreadable and contributes no ops
      }
      for (const op of decoded) ops.push({ op, seq: b.pos.seq, writer_id: b.pos.writer_id });
    }
  }

  const last = rows[rows.length - 1];
  return {
    userId: USER,
    stream,
    rows,
    hashList: stream === "cold" ? hashList : [],
    ops,
    state,
    roster: o.roster ?? [ingestWriter(), device("dev-a")],
    pinnedHeads: new Map(o.pinnedHeads ?? []),
    pinnedBlobHashes: new Map(),
    cursorBefore: o.cursorBefore ?? 0n,
    next: last === undefined ? (o.cursorBefore ?? 0n) : last.seq,
  };
}

/**
 * The standard hot log: an onboarding pair, two ingests in two currencies, a
 * clean edit chain, a split that sums, a supersede with an origin, and one true
 * concurrent fork. Anomaly-free on purpose — "clean" has to mean clean, so every
 * anomaly a test needs is introduced by that test.
 */
function hotPlans(): Plan[] {
  return [
    { writer: "dev-a", ops: [homeCurrency("AED")] },
    { writer: "dev-a", ops: [rateSet("USD", "3672500")] },
    { writer: "ingest", ops: [ingested("i1", "t1", { amount_minor: "25000", currency: "AED" })] },
    { writer: "ingest", ops: [ingested("i2", "t2", { amount_minor: "10000", currency: "USD", last4: "3702" })] },
    { writer: "dev-a", ops: [categorized("t1", 1, "dining")] },
    { writer: "dev-a", ops: [split("t1", 2, [["a", "10000"], ["b", "15000"]])] },
    { writer: "ingest", ops: [superseded("i1", "t3", { amount_minor: "26000", currency: "AED" })] },
    { writer: "dev-a", ops: [edited("t2", 1, { merchant_raw: "SPINNEYS" }, "2026-06-05T12:00:00Z")] },
    // Names parent 1 while the head is already 2: a true concurrent fork, and
    // the later authored_at makes the challenger win.
    { writer: "dev-a", ops: [categorized("t2", 1, "groceries", "2026-06-05T13:00:00Z")] },
  ];
}

/** A dev-a blob whose plaintext is not an op list at all. */
const corruptPlan = (): Plan => ({ writer: "dev-a", plaintext: new TextEncoder().encode("not an op blob") });

/** Names every chain head this client has observed, which is what a checkpoint is. */
const checkpointPlan = (writer: string): Plan => ({
  writer,
  opsFrom: (heads) =>
    [
      checkpointOp(
        [...heads.entries()].map(([key, h]) => {
          const sep = key.indexOf("|");
          return {
            writer_id: key.slice(0, sep),
            stream: key.slice(sep + 1),
            counter: `${h.counter}`,
            hash: hex(h.hash),
          };
        }),
      ),
    ],
});

function cleanInput(over: Partial<AssembleOpts> = {}): CheckInput {
  return assemble({ plans: hotPlans(), ...over });
}

/** A cold stream of raw email bodies, which is all a cold blob may ever carry. */
function coldPlans(n: number): Plan[] {
  return Array.from({ length: n }, (_, i) => ({
    writer: "ingest",
    plaintext: encodeRawBody({
      ingest_id: ingestID(`cold-${i}`),
      received_at: "2026-06-05T09:00:00Z",
      raw: new TextEncoder().encode(`From: bank@example.test\r\n\r\nmessage ${i}\r\n`),
    }),
  }));
}

/**
 * The 90-day rolling window of spec §3.3:70 — a hash list covering the whole
 * cold chain, bodies for two counters only. It must not be a violation.
 */
function coldWindowInput(have: bigint[], of = 12): CheckInput {
  const input = assemble({ stream: "cold", plans: coldPlans(of) });
  input.rows = input.rows.filter((r) => have.includes(r.writer_counter));
  const last = input.rows[input.rows.length - 1];
  input.next = last === undefined ? input.cursorBefore : last.seq;
  return input;
}

/** Rewrites the seqs a page arrived at, leaving everything else intact. */
function reseq(input: CheckInput, seqs: bigint[]): CheckInput {
  input.rows.forEach((r, i) => {
    r.seq = seqs[i] ?? r.seq;
  });
  const last = input.rows[input.rows.length - 1];
  input.next = last === undefined ? input.cursorBefore : last.seq;
  return input;
}

// ---------------------------------------------------------------------------
// The clean baseline
//
// Every "fires when broken" test below is worthless unless this one holds: a
// checker that reports a violation on correct data gets its output ignored.
// ---------------------------------------------------------------------------

test("a clean pull produces no hard stops", () => {
  expect(hardStops(checkAll(cleanInput()))).toHaveLength(0);
});

test("a clean pull's notices are only the ones a healthy single-device account earns", () => {
  const vs = checkAll(cleanInput());
  expect(new Set(ids(vs))).toEqual(new Set(["I11_roster_checkpoint", "I14_forks_surfaced"]));
});

test("a clean cold pull produces no hard stops", () => {
  expect(hardStops(checkAll(assemble({ stream: "cold", plans: coldPlans(4) })))).toHaveLength(0);
});

test("there are seventeen invariants and every one of them has an id", () => {
  expect(INVARIANT_IDS).toHaveLength(17);
  expect(new Set(INVARIANT_IDS).size).toBe(17);
});

test("checkAll is pure: the same input twice gives the identical answer", () => {
  // It re-folds the op log, and a re-fold that touched the caller's state would
  // make a second opinion disagree with the first — the worst property an
  // instrument can have, because the retry looks like the fix.
  const input = cleanInput();
  const before = serializeState(input.state);
  const first = checkAll(input);
  const second = checkAll(input);
  expect(second).toEqual(first);
  expect(serializeState(input.state)).toBe(before);
});

test("checkAll reports rather than throws, whatever it is handed", () => {
  // A checker that crashes on broken input is not a checker: the caller learns
  // nothing and the session dies on the exception instead of on the finding.
  const junk = { stream: "hot", rows: [{}], hashList: [{}], ops: [{}], roster: [] } as unknown as CheckInput;
  let vs: Violation[] = [];
  expect(() => {
    vs = checkAll(junk);
  }).not.toThrow();
  expect(hardStops(vs).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// I1 — the pulled stream's ordering
// ---------------------------------------------------------------------------

test("I1 does NOT fire on a legitimate hot-only pull with sparse global seqs", () => {
  // seq is one total order across BOTH streams (Decision 13), so a hot-only pull
  // seeing 1, 3, 5, ... is the normal case and not a gap.
  const input = reseq(cleanInput(), [1n, 3n, 5n, 7n, 9n, 11n, 13n, 15n, 17n]);
  expect(ids(checkAll(input))).not.toContain("I1_stream_cursor_monotone");
});

test("I1 fires when the server reorders a stream", () => {
  const input = reseq(cleanInput(), [1n, 5n, 3n, 7n, 9n, 11n, 13n, 15n, 17n]);
  expect(stopIDs(checkAll(input))).toContain("I1_stream_cursor_monotone");
});

test("I1 fires when a row repeats a seq", () => {
  const input = reseq(cleanInput(), [1n, 2n, 2n, 4n, 5n, 6n, 7n, 8n, 9n]);
  expect(stopIDs(checkAll(input))).toContain("I1_stream_cursor_monotone");
});

test("I1 fires when the server re-serves rows the client has already passed", () => {
  const input = cleanInput();
  input.cursorBefore = 5n;
  expect(stopIDs(checkAll(input))).toContain("I1_stream_cursor_monotone");
});

test("I1 fires when `next` runs past the last row the server actually sent", () => {
  // The cursor the client persists comes from `next`. If it may exceed the rows
  // delivered, the client skips everything in between, forever, in silence.
  const input = cleanInput();
  input.next = input.next + 40n;
  expect(stopIDs(checkAll(input))).toContain("I1_stream_cursor_monotone");
});

test("I1 fires when an empty page still advances `next`", () => {
  const input = cleanInput();
  input.rows = [];
  input.next = 99n;
  expect(stopIDs(checkAll(input))).toContain("I1_stream_cursor_monotone");
});

test("I1 fires when the server splices a row from the other stream into the page", () => {
  const input = cleanInput();
  input.rows[3]!.stream = "cold";
  expect(stopIDs(checkAll(input))).toContain("I1_stream_cursor_monotone");
});

// ---------------------------------------------------------------------------
// I2 — per (writer, stream) counter contiguity
// ---------------------------------------------------------------------------

test("I2 fires when the server skips a hot writer_counter", () => {
  const input = cleanInput();
  input.rows = input.rows.filter((r) => !(r.writer_id === "dev-a" && r.writer_counter === 3n));
  expect(stopIDs(checkAll(input))).toContain("I2_writer_counters");
});

test("I2 fires when the server serves a writer's blobs out of counter order", () => {
  const input = cleanInput();
  const a = input.rows.filter((r) => r.writer_id === "dev-a");
  [a[1]!.writer_counter, a[2]!.writer_counter] = [a[2]!.writer_counter, a[1]!.writer_counter];
  expect(stopIDs(checkAll(input))).toContain("I2_writer_counters");
});

test("I2 fires when a writer's run does not continue the pinned head", () => {
  // A client resuming at counter 4 that is served counters 1.. again is being
  // rewound, which is how a re-chained history is delivered.
  const input = cleanInput();
  input.pinnedHeads.set(chainKey("dev-a", "hot"), { counter: 4n, hash: ZERO_HASH });
  expect(stopIDs(checkAll(input))).toContain("I2_writer_counters");
});

test("I2 does not fire on a cold stream synced as a rolling window", () => {
  // Bodies for two counters, a hash list covering all twelve: the shape spec
  // §3.3:70 mandates. Treating the absent bodies as gaps would make the legal
  // configuration a permanent hard stop.
  expect(hardStops(checkAll(coldWindowInput([5n, 11n])))).toHaveLength(0);
});

test("I2 fires on a cold stream when the HASH LIST itself skips a counter", () => {
  const input = coldWindowInput([5n, 11n]);
  input.hashList = input.hashList.filter((h) => h.writer_counter !== 7n);
  expect(stopIDs(checkAll(input))).toContain("I2_writer_counters");
});

// ---------------------------------------------------------------------------
// I3 — the hash chain over the bytes actually delivered
// ---------------------------------------------------------------------------

test("I3 fires when a blob's bytes no longer hash to its claimed blob_hash", () => {
  const input = cleanInput();
  flipPadding(input.rows[2]!.blob);
  const vs = checkAll(input);
  expect(stopIDs(vs)).toContain("I3_chain");
  // Precisely targeted: the frame is untouched, so nothing else may fire.
  expect(stopIDs(vs)).not.toContain("I4_aad");
  expect(stopIDs(vs)).not.toContain("I5_bucket");
});

test("I3 fires when a row's prev_hash does not link to the row before it", () => {
  const input = cleanInput();
  const row = input.rows.filter((r) => r.writer_id === "dev-a")[2]!;
  row.prev_hash = new Uint8Array(32).fill(9);
  row.blob_hash = chainHash(row.prev_hash, row.blob); // re-hashed, so only the LINK is wrong
  expect(stopIDs(checkAll(input))).toContain("I3_chain");
});

test("I3 fires when a writer's first blob does not start from the genesis hash", () => {
  const input = cleanInput();
  const first = input.rows.find((r) => r.writer_counter === 1n)!;
  first.prev_hash = new Uint8Array(32).fill(1);
  first.blob_hash = chainHash(first.prev_hash, first.blob);
  expect(stopIDs(checkAll(input))).toContain("I3_chain");
});

test("I3 fires when a run does not continue the pinned head it resumes from", () => {
  const input = assemble({
    plans: hotPlans(),
    cursorBefore: 3n,
    pinnedHeads: new Map([[chainKey("dev-a", "hot"), { counter: 1n, hash: new Uint8Array(32).fill(7) }]]),
  });
  // The assembler chained honestly from that pinned hash; move the pin and the
  // first dev-a row no longer links to it.
  input.pinnedHeads.set(chainKey("dev-a", "hot"), { counter: 1n, hash: new Uint8Array(32).fill(8) });
  expect(stopIDs(checkAll(input))).toContain("I3_chain");
});

test("I3 does NOT detect a wholly re-chained history, and that limitation is the reason I11 exists", () => {
  // chain.ts is explicit: verification is arithmetic over bytes the server
  // holds, so a server that rewrites a blob AND every hash after it produces a
  // page that verifies. Pinning this keeps anyone from reading a green I3 as
  // "the server served me everything".
  const input = cleanInput();
  const rows = input.rows.filter((r) => r.writer_id === "dev-a");
  const target = rows[2]!;
  flipPadding(target.blob);
  let prev = target.prev_hash;
  for (const r of rows.slice(2)) {
    r.prev_hash = prev;
    r.blob_hash = chainHash(prev, r.blob);
    prev = r.blob_hash;
  }
  expect(stopIDs(checkAll(input))).not.toContain("I3_chain");
});

// ---------------------------------------------------------------------------
// I3b — the cold hash list, and the bodies checked against it
// ---------------------------------------------------------------------------

test("I3b fires when a cold body is swapped after its hash was pinned", () => {
  const input = coldWindowInput([5n, 11n]);
  const row = input.rows[0]!;
  const swapped = sealBlob(
    { userId: USER, stream: "cold", writerId: row.writer_id, writerCounter: row.writer_counter },
    encodeRawBody({
      ingest_id: ingestID("swapped"),
      received_at: "2026-06-05T09:00:00Z",
      raw: new TextEncoder().encode("a different email entirely"),
    }),
  );
  row.blob = swapped;
  row.blob_hash = chainHash(row.prev_hash, swapped); // the server re-hashes too
  const vs = checkAll(input);
  expect(stopIDs(vs)).toContain("I3b_cold_hash_list");
});

test("I3b fires when a cold body is swapped against a hash pinned in an EARLIER session", () => {
  // The cross-session case is the one that matters: the client pinned the list
  // days ago and fetches a body today. A server free to re-pin is not committed.
  const input = coldWindowInput([5n]);
  const pinned = new Map(input.hashList.map((h) => [h.writer_counter, h.blob_hash]));
  input.pinnedBlobHashes.set(chainKey("ingest", "cold"), pinned);
  input.hashList = []; // this session fetched bodies only
  const row = input.rows[0]!;
  row.blob = sealBlob(
    { userId: USER, stream: "cold", writerId: row.writer_id, writerCounter: row.writer_counter },
    encodeRawBody({
      ingest_id: ingestID("swapped"),
      received_at: "2026-06-05T09:00:00Z",
      raw: new TextEncoder().encode("a different email entirely"),
    }),
  );
  row.blob_hash = chainHash(row.prev_hash, row.blob);
  expect(stopIDs(checkAll(input))).toContain("I3b_cold_hash_list");
});

test("I3b fires when the hash list does not link to the pinned cold head", () => {
  const input = coldWindowInput([5n]);
  input.hashList[0]!.prev_hash = new Uint8Array(32).fill(3);
  expect(stopIDs(checkAll(input))).toContain("I3b_cold_hash_list");
});

test("I3b fires when a cold body arrives at a counter nothing ever pinned", () => {
  const input = coldWindowInput([5n]);
  input.hashList = input.hashList.filter((h) => h.writer_counter !== 5n);
  expect(stopIDs(checkAll(input))).toContain("I3b_cold_hash_list");
});

test("I3b fires when cold bodies are used with nothing pinned to check them against", () => {
  const input = coldWindowInput([5n]);
  input.hashList = [];
  expect(stopIDs(checkAll(input))).toContain("I3b_cold_hash_list");
});

// ---------------------------------------------------------------------------
// I4 — the AAD binds a blob to the position it is stored at
// ---------------------------------------------------------------------------

test("I4 fires when a blob is served at a position it was not sealed for", () => {
  const input = cleanInput();
  // Two rows from the same writer, contents exchanged: counters, hashes and
  // buckets all still line up, and only the sealed-in position disagrees.
  const a = input.rows.filter((r) => r.writer_id === "dev-a");
  const [x, y] = [a[0]!, a[1]!];
  [x.blob, y.blob] = [y.blob, x.blob];
  x.blob_hash = chainHash(x.prev_hash, x.blob);
  y.prev_hash = x.blob_hash;
  y.blob_hash = chainHash(y.prev_hash, y.blob);
  expect(stopIDs(checkAll(input))).toContain("I4_aad");
});

test("I4 fires when a blob sealed for another user is spliced into this log", () => {
  const input = cleanInput();
  const row = input.rows[1]!;
  row.blob = sealBlob(
    {
      userId: "22222222-2222-2222-2222-222222222222",
      stream: "hot",
      writerId: row.writer_id,
      writerCounter: row.writer_counter,
    },
    encodeBlobOps([]),
  );
  row.size_bucket = row.blob.length;
  row.blob_hash = chainHash(row.prev_hash, row.blob);
  expect(stopIDs(checkAll(input))).toContain("I4_aad");
});

// ---------------------------------------------------------------------------
// I5 — the size-bucket ladder
// ---------------------------------------------------------------------------

test("I5 fires when size_bucket is not one of the seven buckets", () => {
  const input = cleanInput();
  input.rows[0]!.size_bucket = 1500;
  expect(stopIDs(checkAll(input))).toContain("I5_bucket");
});

test("I5 fires when the stored blob is not exactly its size_bucket long", () => {
  const input = cleanInput();
  input.rows[0]!.blob = input.rows[0]!.blob.slice(0, 900);
  expect(stopIDs(checkAll(input))).toContain("I5_bucket");
});

test("I5 accepts every rung of the ladder", () => {
  // Seven, not six: the padding ladder is frozen at 1K/4K/16K/64K/256K/512K/1M.
  const input = cleanInput();
  for (const bucket of [1 << 10, 4 << 10, 16 << 10, 64 << 10, 256 << 10, 512 << 10, 1024 << 10]) {
    const row = input.rows[0]!;
    row.blob = new Uint8Array(bucket);
    row.size_bucket = bucket;
    expect(ids(checkAll(input)).filter((id) => id === "I5_bucket")).toHaveLength(0);
  }
});

// ---------------------------------------------------------------------------
// I6 — schema versions
// ---------------------------------------------------------------------------

test("I6 fires on an op from a newer schema version", () => {
  const input = cleanInput();
  input.ops[0]!.op.v = 2;
  expect(stopIDs(checkAll(input))).toContain("I6_schema_version");
});

// ---------------------------------------------------------------------------
// I7 — one live transaction per ingest id
// ---------------------------------------------------------------------------

test("I7 fires when the live index points at a superseded transaction", () => {
  const input = cleanInput();
  const t1 = input.state.txns.get("t1")!;
  input.state.liveByIngestID.set(t1.ingest_id, "t1"); // t1 was retired by t3
  expect(stopIDs(checkAll(input))).toContain("I7_one_live_per_ingest");
});

test("I7 fires when a live transaction is unreachable from the live index", () => {
  const input = cleanInput();
  input.state.liveByIngestID.delete(input.state.txns.get("t2")!.ingest_id);
  expect(stopIDs(checkAll(input))).toContain("I7_one_live_per_ingest");
});

test("I7 fires when the live index names a transaction that does not exist", () => {
  const input = cleanInput();
  input.state.liveByIngestID.set(ingestID("phantom"), "nope");
  expect(stopIDs(checkAll(input))).toContain("I7_one_live_per_ingest");
});

test("I7 does not mind that a retired transaction is still fully visible", () => {
  const input = cleanInput();
  expect(input.state.txns.get("t1")!.superseded_by).not.toBeNull();
  expect(stopIDs(checkAll(input))).not.toContain("I7_one_live_per_ingest");
});

// ---------------------------------------------------------------------------
// I8 — splits sum to their parent
// ---------------------------------------------------------------------------

test("I8 fires when an applied split does not sum to its parent's amount", () => {
  const input = cleanInput();
  input.state.txns.get("t1")!.splits[0]!.amount_minor = 9999n;
  expect(stopIDs(checkAll(input))).toContain("I8_split_sum");
});

test("I8 fires when a split part carries a JS number instead of a bigint", () => {
  const input = cleanInput();
  (input.state.txns.get("t1")!.splits[0] as unknown as { amount_minor: number }).amount_minor = 10000;
  expect(stopIDs(checkAll(input))).toContain("I8_split_sum");
});

// ---------------------------------------------------------------------------
// I9 — version contiguity
// ---------------------------------------------------------------------------

test("I9 fires when a materialized entity's version disagrees with its head", () => {
  const input = cleanInput();
  input.state.txns.get("t2")!.version = 9;
  expect(stopIDs(checkAll(input))).toContain("I9_version_contiguity");
});

test("I9 fires when a head sits at a version the op log never authored", () => {
  const input = cleanInput();
  const head = input.state.heads.get("txn t2")!;
  head.version += 3;
  input.state.txns.get("t2")!.version = head.version;
  expect(stopIDs(checkAll(input))).toContain("I9_version_contiguity");
});

test("I9 fires on a version below 1, because numbering starts at the create", () => {
  const input = cleanInput();
  input.state.heads.get("txn t2")!.version = 0;
  input.state.txns.get("t2")!.version = 0;
  expect(stopIDs(checkAll(input))).toContain("I9_version_contiguity");
});

test("I9 fires when an entity is materialized with no head registered for it", () => {
  const input = cleanInput();
  input.state.heads.delete("txn t2");
  expect(stopIDs(checkAll(input))).toContain("I9_version_contiguity");
});

test("I9 does not flag the head a retired transaction keeps forever", () => {
  // `heads` is never pruned: a supersede does not end the predecessor's version
  // line, because an offline edit to the retired row still has to resolve.
  const input = cleanInput();
  expect(input.state.heads.has("txn t1")).toBe(true);
  expect(stopIDs(checkAll(input))).not.toContain("I9_version_contiguity");
});

// ---------------------------------------------------------------------------
// I10 — the state is reproducible by re-folding from position 0
// ---------------------------------------------------------------------------

test("I10 fires when a frozen FX snapshot in the state does not match a re-fold", () => {
  const input = cleanInput();
  input.state.txns.get("t2")!.amount_home_minor = 1n;
  expect(stopIDs(checkAll(input))).toContain("I10_fx_prefix_monotone");
});

test("I10 fires when a transaction in the state is not in the op log at all", () => {
  const input = cleanInput();
  const t = input.state.txns.get("t2")!;
  input.state.txns.set("ghost", { ...t, id: "ghost" });
  expect(stopIDs(checkAll(input))).toContain("I10_fx_prefix_monotone");
});

test("I10 fires when the ops it is given cannot be folded in the order given", () => {
  const input = cleanInput();
  [input.ops[1], input.ops[2]] = [input.ops[2]!, input.ops[1]!];
  expect(stopIDs(checkAll(input))).toContain("I10_fx_prefix_monotone");
});

test("I10 refuses a caller that passes only the current page's ops", () => {
  // `ops` is documented as every op folded into `state`, and I9/I10 both
  // re-derive from it — so a partial list is not a weaker check, it is a wrong
  // one. Making the precondition a CHECKED one means a caller that gets it
  // wrong sees a violation instead of a green run over a re-fold of nothing.
  const input = cleanInput();
  input.ops = input.ops.slice(-2);
  expect(stopIDs(checkAll(input))).toContain("I10_fx_prefix_monotone");
});

test("I10 catches an end-of-fold freeze, which is the FX hazard §3.7:134 names", () => {
  // A rate that arrives AFTER a transaction must backfill it at that position,
  // not re-denominate it at the final head. Freezing everything against the last
  // rate produces this: a snapshot that no prefix of the log ever computed.
  const input = assemble({
    plans: [
      { writer: "dev-a", ops: [homeCurrency("AED")] },
      { writer: "ingest", ops: [ingested("i9", "t9", { amount_minor: "10000", currency: "USD" })] },
      { writer: "dev-a", ops: [rateSet("USD", "3672500")] },
      { writer: "dev-a", ops: [rateSet("USD", "9000000")] },
    ],
  });
  expect(input.state.txns.get("t9")!.amount_home_minor).toBe(36725n);
  input.state.txns.get("t9")!.amount_home_minor = 90000n; // the final head, wrongly
  expect(stopIDs(checkAll(input))).toContain("I10_fx_prefix_monotone");
});

// ---------------------------------------------------------------------------
// I11 — roster and checkpoint
// ---------------------------------------------------------------------------

test("I11 is only a notice for a single-writer user with no checkpoint", () => {
  const input = cleanInput({ roster: [ingestWriter(), device("dev-a")] });
  expect(find(checkAll(input), "I11_roster_checkpoint")!.severity).toBe("notice");
});

test("I11 hard-stops when two writers are enrolled and no checkpoint exists", () => {
  const input = cleanInput({ roster: [ingestWriter(), device("dev-a"), device("dev-b")] });
  const v = find(checkAll(input), "I11_roster_checkpoint")!;
  expect(v.severity).toBe("hard_stop");
});

test("I11 is a notice, not a hard stop, for a brand-new account with no device writers", () => {
  // The case the first draft left undefined, which is how an invariant passes
  // vacuously with the whole feature absent.
  const input = cleanInput({ roster: [ingestWriter()] });
  expect(find(checkAll(input), "I11_roster_checkpoint")!.severity).toBe("notice");
});

test("I11 counts only LIVE device writers when deciding whether a checkpoint is required", () => {
  const input = cleanInput({ roster: [ingestWriter(), device("dev-a"), device("dev-b", "2026-07-01T00:00:00Z")] });
  expect(find(checkAll(input), "I11_roster_checkpoint")!.severity).toBe("notice");
});

test("I11 stops being a notice once a checkpoint lands", () => {
  const input = cleanInput({ plans: [...hotPlans(), checkpointPlan("dev-a")] });
  expect(input.state.checkpoints.length).toBeGreaterThan(0);
  expect(ids(checkAll(input))).not.toContain("I11_roster_checkpoint");
});

test("I11 hard-stops when the checkpoint omits a live device writer", () => {
  const input = cleanInput({
    plans: [...hotPlans(), checkpointPlan("dev-a")],
    roster: [ingestWriter(), device("dev-a"), device("dev-b")],
  });
  const v = all(checkAll(input), "I11_roster_checkpoint").find((x) => x.severity === "hard_stop");
  expect(v?.detail).toContain("dev-b");
});

test("I11 fires when the server omits a writer from the roster", () => {
  const input = cleanInput({ plans: [...hotPlans(), checkpointPlan("dev-a")] });
  input.roster = input.roster.filter((w) => w.writer_id !== "dev-a");
  expect(ids(checkAll(input))).toContain("I11_roster_checkpoint");
});

test("I11 hard-stops when a checkpoint head claims a counter no blob has reached", () => {
  const input = cleanInput({ plans: [...hotPlans(), checkpointPlan("dev-a")] });
  input.state.checkpoints[0]!.counter = 900n;
  const v = all(checkAll(input), "I11_roster_checkpoint").find((x) => x.severity === "hard_stop");
  expect(v?.detail).toContain("900");
});

test("I11 hard-stops when the server serves not one blob from a writer a checkpoint names", () => {
  // Spec §3.4's actual attack: the whole of dev-b's chain withheld at bootstrap.
  const input = cleanInput({ plans: [...hotPlans(), checkpointPlan("dev-a")], roster: [ingestWriter(), device("dev-a"), device("dev-b")] });
  input.state.checkpoints.push({ writer_id: "dev-b", stream: "hot", counter: 4n, hash: "0".repeat(64) });
  const v = all(checkAll(input), "I11_roster_checkpoint").find((x) => x.severity === "hard_stop" && x.detail.includes("dev-b"));
  expect(v).toBeDefined();
});

test("I11 does not hard-stop over a checkpoint head on a stream this pull did not cover", () => {
  // A hot-only pull cannot observe the cold chain, and §3.3:70 makes that the
  // normal mode. Hard-stopping here would break every hot-only sync.
  const input = cleanInput({ plans: [...hotPlans(), checkpointPlan("dev-a")] });
  input.state.checkpoints.push({ writer_id: "ingest", stream: "cold", counter: 77n, hash: "0".repeat(64) });
  const vs = all(checkAll(input), "I11_roster_checkpoint");
  expect(vs.filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  expect(vs.some((v) => v.severity === "notice" && v.detail.includes("cold"))).toBe(true);
});

test("I11 notices a blob from a writer the roster does not list", () => {
  const input = cleanInput({ roster: [ingestWriter()] });
  const vs = all(checkAll(input), "I11_roster_checkpoint");
  expect(vs.some((v) => v.detail.includes("dev-a"))).toBe(true);
});

// ---------------------------------------------------------------------------
// I12 — money shape
// ---------------------------------------------------------------------------

test("I12 fires when an amount is a JS number rather than a BigInt", () => {
  const input = cleanInput();
  (input.state.txns.get("t2") as unknown as { amount_minor: number }).amount_minor = 10000;
  expect(stopIDs(checkAll(input))).toContain("I12_money_shape");
});

test("I12 fires on a non-positive amount", () => {
  const input = cleanInput();
  input.state.txns.get("t2")!.amount_minor = 0n;
  expect(stopIDs(checkAll(input))).toContain("I12_money_shape");
});

test("I12 fires on a direction outside debit|credit", () => {
  const input = cleanInput();
  (input.state.txns.get("t2") as unknown as { direction: string }).direction = "DEBIT";
  expect(stopIDs(checkAll(input))).toContain("I12_money_shape");
});

test("I12 fires when a frozen FX snapshot is a number", () => {
  const input = cleanInput();
  (input.state.txns.get("t2") as unknown as { amount_home_minor: number }).amount_home_minor = 36725;
  expect(stopIDs(checkAll(input))).toContain("I12_money_shape");
});

test("I12 fires when a rate head is a number", () => {
  const input = cleanInput();
  (input.state.rates as unknown as Map<string, number>).set("USD", 3672500);
  expect(stopIDs(checkAll(input))).toContain("I12_money_shape");
});

test("I12 accepts a zero home-currency snapshot, which rounding can legitimately produce", () => {
  const input = cleanInput();
  input.state.txns.get("t2")!.amount_home_minor = 0n;
  expect(stopIDs(checkAll(input))).not.toContain("I12_money_shape");
});

// ---------------------------------------------------------------------------
// I13 — a supersede names an ingest a txn_ingested introduced
// ---------------------------------------------------------------------------

test("I13 notices a supersede whose ingest id no txn_ingested ever introduced", () => {
  const input = cleanInput({
    plans: [...hotPlans(), { writer: "ingest", ops: [superseded("i-orphan", "orphan")] }],
  });
  const v = find(checkAll(input), "I13_supersede_has_origin")!;
  expect(v.severity).toBe("notice");
});

test("I13 notices a supersede that arrives BEFORE the ingest it claims to replace", () => {
  const input = assemble({
    plans: [
      { writer: "ingest", ops: [superseded("i1", "t1b")] },
      { writer: "ingest", ops: [ingested("i1", "t1")] },
    ],
  });
  expect(ids(checkAll(input))).toContain("I13_supersede_has_origin");
});

test("I13 stays quiet for a supersede chain over one ingest", () => {
  const input = assemble({
    plans: [
      { writer: "ingest", ops: [ingested("i1", "t1")] },
      { writer: "ingest", ops: [superseded("i1", "t2")] },
      { writer: "ingest", ops: [superseded("i1", "t3")] },
    ],
  });
  expect(ids(checkAll(input))).not.toContain("I13_supersede_has_origin");
});

// ---------------------------------------------------------------------------
// I14 — forks and anomalies are surfaced, never zero-suppressed
// ---------------------------------------------------------------------------

test("I14 reports even when there is nothing to report", () => {
  // "Never zero-suppressed" is the whole content of the invariant: an operator
  // who only sees the line when it is non-empty cannot tell a clean sync from a
  // reporting bug.
  const input = assemble({ plans: [{ writer: "dev-a", ops: [homeCurrency("AED")] }] });
  expect(input.state.forks).toHaveLength(0);
  expect(input.state.anomalies).toHaveLength(0);
  const v = find(checkAll(input), "I14_forks_surfaced")!;
  expect(v.severity).toBe("notice");
  expect(v.detail).toContain("0 forks");
});

test("I14 counts the forks and anomalies the fold actually recorded", () => {
  const input = cleanInput();
  const v = find(checkAll(input), "I14_forks_surfaced")!;
  expect(v.detail).toContain("1 fork");
});

test("I14 names every anomaly kind it saw, so a possible_duplicate cannot hide in a total", () => {
  const input = cleanInput();
  input.state.anomalies.push({ kind: "possible_duplicate", detail: "t9 matches t8", at_seq: 4n });
  const v = find(checkAll(input), "I14_forks_surfaced")!;
  expect(v.detail).toContain("possible_duplicate");
});

test("I14 fires on an anomaly kind outside the frozen vocabulary", () => {
  const input = cleanInput();
  input.state.anomalies.push({ kind: "made_up_kind", detail: "x", at_seq: 1n });
  expect(all(checkAll(input), "I14_forks_surfaced").some((v) => v.detail.includes("made_up_kind"))).toBe(true);
});

test("I14 fires on a fork notice naming one op as both winner and loser", () => {
  // The exact shape rule 8's redelivery hazard produced: an entity forked
  // against itself. It is a notice-severity id, so the detail has to be loud.
  const input = cleanInput();
  input.state.forks.push({ entity: { kind: "txn", id: "t2" }, winner_op: "op-1", loser_op: "op-1", at_seq: 3n });
  expect(all(checkAll(input), "I14_forks_surfaced").some((v) => v.detail.includes("op-1"))).toBe(true);
});

test("I14 fires when a flagged duplicate appears on a row but in no anomaly", () => {
  const input = cleanInput();
  input.state.txns.get("t2")!.possible_duplicate_of = "t1";
  expect(all(checkAll(input), "I14_forks_surfaced").some((v) => v.detail.includes("possible_duplicate"))).toBe(true);
});

test("I14 does NOT require possible_duplicate_of to still share a fingerprint", () => {
  // It is a snapshot of the answer when the row was indexed, not a live claim:
  // the row it points at may since have been edited into another bucket, and
  // nothing re-walks the rows pointing at it.
  const input = cleanInput();
  const t2 = input.state.txns.get("t2")!;
  t2.possible_duplicate_of = "t3";
  input.state.anomalies.push({ kind: "possible_duplicate", detail: "t2 matches t3", at_seq: 4n });
  expect(input.state.txns.get("t3")!.merchant_raw).not.toBe("nothing like t2");
  expect(hardStops(checkAll(input))).toHaveLength(0);
});

test("the anomaly vocabulary is pinned against replay.ts itself", async () => {
  // Task 11 recorded 19 kinds; Task 12 then added one. A hand-maintained list
  // drifts, and a checker that silently accepts an unknown kind reports nothing
  // when the engine grows a new refusal.
  const src = await Bun.file(`${import.meta.dir}/../replay/replay.ts`).text();
  const fromSource = new Set([...src.matchAll(/anomaly\(\s*s,\s*[^,]+,\s*"([a-z_]+)"/g)].map((m) => m[1]!));
  expect(fromSource.size).toBe(20);
  expect([...ANOMALY_KINDS].sort()).toEqual([...fromSource].sort());
});

// ---------------------------------------------------------------------------
// I15 — unreadable blobs are set aside, and never abort
// ---------------------------------------------------------------------------

test("I15: an undecodable blob is a notice and never a hard stop", () => {
  const plans = hotPlans();
  plans.splice(4, 0, corruptPlan());
  const input = cleanInput({ plans });
  expect(input.state.unreadable).toHaveLength(1);
  const vs = checkAll(input);
  expect(ids(vs)).toContain("I15_unreadable_set_aside");
  expect(hardStops(vs)).toHaveLength(0);
});

test("I15 records the position of the blob it set aside", () => {
  const plans = hotPlans();
  plans.splice(4, 0, corruptPlan());
  const u = cleanInput({ plans }).state.unreadable[0]!;
  expect(u.writer_id).toBe("dev-a");
  expect(u.stream).toBe("hot");
  expect(u.writer_counter).toBe(3n);
  expect(u.seq).toBe(5n);
});

test("I15 fires when a set-aside blob did not carry the cursor past it", () => {
  // The seam hazard: a consumed seq the cursor never passed can be re-delivered
  // later with different content and folded as if it were new.
  const plans = hotPlans();
  plans.splice(4, 0, corruptPlan());
  const input = cleanInput({ plans });
  input.state.cursors.hot = 2n;
  expect(stopIDs(checkAll(input))).toContain("I15_unreadable_set_aside");
});

test("I15 fires on a set-aside record that does not say where it came from", () => {
  const input = cleanInput();
  input.state.unreadable.push({ writer_id: "", stream: "hot", writer_counter: 0n, seq: 1n, reason: "" });
  expect(stopIDs(checkAll(input))).toContain("I15_unreadable_set_aside");
});

// ---------------------------------------------------------------------------
// I16 — cold blobs carry no ops
// ---------------------------------------------------------------------------

test("I16 fires when a cold blob decodes as an op list", () => {
  // What licenses a hot-only sync to be a COMPLETE materialization. If a cold
  // blob could carry state, every hot-only client would be silently wrong.
  const plans = coldPlans(4);
  plans[2] = { writer: "ingest", ops: [categorized("t1", 1, "smuggled")] };
  const input = assemble({ stream: "cold", plans });
  expect(stopIDs(checkAll(input))).toContain("I16_cold_carries_no_ops");
});

test("I16 fires when a cold blob is neither a raw body nor anything else known", () => {
  const plans = coldPlans(3);
  plans[1] = {
    writer: "ingest",
    plaintext: new TextEncoder().encode(JSON.stringify({ v: 1, kind: "something_else" })),
  };
  const input = assemble({ stream: "cold", plans });
  expect(stopIDs(checkAll(input))).toContain("I16_cold_carries_no_ops");
});

test("I16 leaves an undecodable cold blob to I15 rather than calling it an op list", () => {
  const plans = coldPlans(3);
  plans[1] = { writer: "ingest", plaintext: new TextEncoder().encode("not json") };
  const input = assemble({ stream: "cold", plans });
  expect(stopIDs(checkAll(input))).not.toContain("I16_cold_carries_no_ops");
});

test("I16 says nothing about a hot pull", () => {
  expect(ids(checkAll(cleanInput()))).not.toContain("I16_cold_carries_no_ops");
});

// ---------------------------------------------------------------------------
// The guards that only fire on already-broken input
//
// Line coverage over the suite above found these branches unreached. An
// unreached branch in the exit-criterion instrument is an untested one, and a
// guard nobody has ever seen fire is a guard nobody knows is wired up.
// ---------------------------------------------------------------------------

test("I2 fires when a counter is not a bigint at all", () => {
  const input = cleanInput();
  (input.rows[0] as unknown as { writer_counter: number }).writer_counter = 1;
  expect(stopIDs(checkAll(input))).toContain("I2_writer_counters");
});

test("I3 fires when a row's hashes are not 32 bytes", () => {
  const input = cleanInput();
  input.rows[0]!.blob_hash = new Uint8Array(8);
  expect(stopIDs(checkAll(input))).toContain("I3_chain");
});

test("I4 fires when a blob is too short to carry associated data at all", () => {
  const input = cleanInput();
  input.rows[0]!.blob = input.rows[0]!.blob.slice(0, 2);
  const v = all(checkAll(input), "I4_aad")[0];
  expect(v?.detail).toContain("no readable associated data");
});

test("I7 fires when the live index files a transaction under the wrong ingest id", () => {
  const input = cleanInput();
  const t = input.state.txns.get("t2")!;
  input.state.liveByIngestID.delete(t.ingest_id);
  input.state.liveByIngestID.set(ingestID("someone-elses-email"), "t2");
  expect(all(checkAll(input), "I7_one_live_per_ingest").some((v) => v.detail.includes("but the row carries"))).toBe(true);
});

test("I9 fires when a head exists for an entity nothing materialized", () => {
  const input = cleanInput();
  input.state.heads.set(entityKey("txn", "ghost"), {
    kind: "txn",
    id: "ghost",
    version: 1,
    op_id: "op-x",
    writer_id: "dev-a",
    authored_at_ms: 0,
  });
  expect(all(checkAll(input), "I9_version_contiguity").some((v) => v.detail.includes("ghost"))).toBe(true);
});

test("I10 fires when the op log creates a transaction the state has dropped", () => {
  // The direction that catches a state MISSING a row, as opposed to holding an
  // extra one. A single-direction comparison would call this state correct.
  const input = cleanInput();
  input.state.txns.delete("t2");
  expect(all(checkAll(input), "I10_fx_prefix_monotone").some((v) => v.detail.includes("which is not in the state"))).toBe(true);
});

test("I11 fires on a checkpoint head that names no usable chain", () => {
  const input = cleanInput();
  input.state.checkpoints = [{ writer_id: "", stream: "hot", counter: 1n, hash: "0".repeat(64) }];
  expect(all(checkAll(input), "I11_roster_checkpoint").some((v) => v.detail.includes("cannot be a chain key"))).toBe(true);
});

test("I11 counts a cold hash list as evidence of a chain head", () => {
  // The client fetched one body but pinned the whole list, so it HAS witnessed
  // counter 6 even though it holds no bytes for it. Reading only the fetched
  // bodies would hard-stop a correctly synced rolling window.
  const input = coldWindowInput([1n], 6);
  input.roster = [ingestWriter()];
  input.state.checkpoints = [{ writer_id: "ingest", stream: "cold", counter: 6n, hash: "0".repeat(64) }];
  expect(hardStops(checkAll(input))).toHaveLength(0);
  input.state.checkpoints = [{ writer_id: "ingest", stream: "cold", counter: 7n, hash: "0".repeat(64) }];
  expect(stopIDs(checkAll(input))).toContain("I11_roster_checkpoint");
});

test("I12 fires on a negative home-currency snapshot", () => {
  const input = cleanInput();
  input.state.txns.get("t2")!.amount_home_minor = -1n;
  expect(stopIDs(checkAll(input))).toContain("I12_money_shape");
});

test("I12 fires on a split part that is not a positive amount", () => {
  const input = cleanInput();
  input.state.txns.get("t1")!.splits[0]!.amount_minor = 0n;
  expect(all(checkAll(input), "I12_money_shape").some((v) => v.detail.includes("split part"))).toBe(true);
});

test("I12 fires on a non-positive rate head", () => {
  const input = cleanInput();
  input.state.rates.set("USD", 0n);
  expect(all(checkAll(input), "I12_money_shape").some((v) => v.detail.includes("USD"))).toBe(true);
});

test("I14 fires on a fork whose at_seq is not a bigint", () => {
  const input = cleanInput();
  input.state.forks.push({
    entity: { kind: "txn", id: "t2" },
    winner_op: "op-a",
    loser_op: "op-b",
    at_seq: 3 as unknown as bigint,
  });
  expect(all(checkAll(input), "I14_forks_surfaced").some((v) => v.detail.includes("at_seq"))).toBe(true);
});

test("I16 does not call a cold blob it cannot even open a smuggled op list", () => {
  const input = assemble({ stream: "cold", plans: coldPlans(3) });
  const row = input.rows[1]!;
  // Sealed for a different position: it will not open here, so nothing can be
  // claimed about what kind of body it holds. I4 is the finding, not I16.
  row.blob = sealBlob(
    { userId: USER, stream: "cold", writerId: row.writer_id, writerCounter: 99n },
    encodeBlobOps([categorized("t1", 1, "smuggled")]),
  );
  row.blob_hash = chainHash(row.prev_hash, row.blob);
  input.hashList[1]!.blob_hash = row.blob_hash;
  input.hashList[2]!.prev_hash = row.blob_hash;
  const vs = checkAll(input);
  expect(stopIDs(vs)).toContain("I4_aad");
  expect(stopIDs(vs)).not.toContain("I16_cold_carries_no_ops");
});

// ---------------------------------------------------------------------------
// A hostile log
//
// Every fixture above is small and built to break exactly one thing. A checker
// that is only ever run against those has never met a real fold: no batched ops
// sharing a seq, no three-way writer interleave, no anomaly it did not put there
// itself. This is the other direction — a large, deliberately nasty, entirely
// VALID log, where any hard stop at all is a false positive in the instrument
// the exit criterion is read from.
// ---------------------------------------------------------------------------

/** A deterministic LCG: the hostile log must be the same log on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function hostilePlans(): Plan[] {
  const rand = rng(20260801);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const writers = ["dev-a", "dev-b", "dev-c"];
  const currencies = ["AED", "USD", "EUR"];
  const out: Plan[] = [];
  let clock = Date.UTC(2026, 5, 1);
  const tick = (): string => {
    clock += Math.floor(rand() * 600_000);
    return new Date(clock).toISOString();
  };

  out.push({ writer: "dev-a", ops: [homeCurrency("AED", tick()), rateSet("USD", "3672500", tick())] }); // batched
  out.push({ writer: "dev-b", ops: [rateSet("EUR", "4000000", tick())] });

  interface Tracked {
    id: string;
    ingest: string;
    version: number;
    amount: bigint;
  }
  const txns: Tracked[] = [];
  const seenRules = new Set<string>();
  for (let i = 0; i < 24; i++) {
    const amount = BigInt(1000 + Math.floor(rand() * 40) * 100);
    const t: Tracked = { id: `t${i}`, ingest: `i${i}`, version: 1, amount };
    out.push({
      writer: "ingest",
      // Merchants and last4 repeat, so fingerprint collisions happen without
      // being contrived.
      ops: [
        ingested(t.ingest, t.id, {
          amount_minor: `${amount}`,
          currency: pick(currencies),
          merchant_raw: `M${i % 7}`,
          last4: `${3700 + (i % 3)}`,
          posted_at: `2026-06-${String(1 + (i % 18)).padStart(2, "0")}T09:00:00Z`,
        }, tick()),
      ],
    });
    txns.push(t);
  }

  for (let i = 0; i < 60; i++) {
    const t = pick(txns);
    const w = pick(writers);
    const roll = rand();
    if (roll < 0.4) {
      const stale = rand() < 0.25 && t.version > 1; // the stale ones are true forks
      out.push({ writer: w, ops: [categorized(t.id, stale ? t.version - 1 : t.version, `c${Math.floor(rand() * 5)}`, tick())] });
      t.version += 1;
    } else if (roll < 0.55) {
      const bad = rand() < 0.3; // a split that does not sum: refused, consumes no version
      const half = t.amount / 2n;
      const rest = bad ? t.amount - half - 1n : t.amount - half;
      out.push({ writer: w, ops: [split(t.id, t.version, [["a", `${half}`], ["b", `${rest}`]], tick())] });
      if (!bad) t.version += 1;
    } else if (roll < 0.68) {
      out.push({ writer: w, ops: [edited(t.id, t.version, { merchant_raw: `E${Math.floor(rand() * 4)}` }, tick())] });
      t.version += 1;
    } else if (roll < 0.78) {
      // Two devices editing the same head at the same instant: the writer_id
      // tie. Two blobs, because one blob has exactly one writer.
      const tie = tick();
      out.push({ writer: "dev-a", ops: [categorized(t.id, t.version, "tie-a", tie)] });
      out.push({ writer: "dev-b", ops: [categorized(t.id, t.version, "tie-b", tie)] });
      t.version += 2;
    } else if (roll < 0.88) {
      const id = `s${i}`;
      out.push({ writer: "ingest", ops: [superseded(t.ingest, id, { amount_minor: `${t.amount + 100n}`, currency: pick(currencies) }, tick())] });
      txns.push({ id, ingest: t.ingest, version: 1, amount: t.amount + 100n });
    } else if (roll < 0.94) {
      // Rules are the OTHER entity keyspace, with its own version line. Without
      // them, every entity-shaped invariant is only ever tested against txns.
      const id = `r${i % 4}`;
      out.push({ writer: w, ops: [ruleAdded(id, seenRules.has(id) ? 1 : null, `c${i % 3}`, tick())] });
      seenRules.add(id);
    } else {
      out.push({ writer: w, ops: [rateSet(pick(currencies), `${3_000_000 + i * 1000}`, tick())] });
    }
  }

  // The rare branches are emitted deliberately rather than left to the dice: a
  // clean bill of health over a log that happens to contain no orphan supersede
  // says nothing about orphan supersedes.
  const twin = { amount_minor: "31400", currency: "AED", merchant_raw: "TWIN", last4: "9999", posted_at: "2026-06-09T08:00:00Z" };
  out.push({ writer: "ingest", ops: [ingested("i-twin-a", "twin-a", twin, tick())] });
  out.push({ writer: "ingest", ops: [ingested("i-twin-b", "twin-b", { ...twin, posted_at: "2026-06-09T20:00:00Z" }, tick())] }); // possible_duplicate
  const last = txns[txns.length - 1]!;
  out.push({ writer: "ingest", ops: [ingested(last.ingest, "dup-ingest", {}, tick())] }); // duplicate_ingest
  out.push({ writer: "ingest", ops: [ingested("i-extra", last.id, {}, tick())] }); // duplicate_create
  out.push({ writer: "dev-a", ops: [categorized("ghost", 1, "dining", tick())] }); // unknown_entity
  out.push({ writer: "dev-a", ops: [categorized(last.id, last.version + 5, "dining", tick())] }); // future_parent
  out.push({ writer: "dev-a", ops: [categorized(last.id, 0, "zero", tick())] }); // nonexistent_parent
  out.push({ writer: "ingest", ops: [superseded("i-orphan", "orphan", {}, tick())] }); // supersede_without_origin
  out.push({ writer: "dev-a", ops: [rateSet("AED", "2000000", tick())] }); // rate_set_for_home_currency
  out.push(corruptPlan()); // set aside, and the cursor still advances past it
  out.push(checkpointPlan("dev-a")); // last, so every writer has a head by now
  return out;
}

let cachedHostile: CheckInput | undefined;

function hostileInput(): CheckInput {
  // Memoized and rebuilt from a fixed seed, so "the same log" is literally true.
  if (cachedHostile === undefined) {
    const saved = opCounter;
    opCounter = 1_000_000;
    cachedHostile = assemble({
      plans: hostilePlans(),
      roster: [ingestWriter(), device("dev-a"), device("dev-b"), device("dev-c")],
    });
    opCounter = saved;
  }
  return cachedHostile;
}

test("the hostile log actually exercises the paths a clean bill of health would otherwise be about nothing", () => {
  const s = hostileInput().state;
  expect(s.txns.size).toBeGreaterThan(20);
  expect(s.forks.length).toBeGreaterThan(2);
  expect(s.rules.size).toBeGreaterThan(1);
  expect([...s.txns.values()].filter((t) => t.superseded_by !== null).length).toBeGreaterThan(2);
  expect([...s.txns.values()].filter((t) => t.splits.length > 0).length).toBeGreaterThan(2);
  expect([...s.txns.values()].filter((t) => t.possible_duplicate_of !== null).length).toBeGreaterThan(0);
  expect(new Set(s.anomalies.map((a) => a.kind)).size).toBeGreaterThan(6);
  expect(s.unreadable).toHaveLength(1);
  expect(s.checkpoints.length).toBeGreaterThan(0);
  // Three devices plus ingest really did interleave, and at least one blob
  // really did carry several ops at one seq — which is the case the ordering
  // guard has to admit and therefore the case a checker is most likely to get
  // wrong. Counted as "fewer distinct seqs than ops", because op and blob counts
  // happen to cancel here: one batched pair, one set-aside blob carrying none.
  const input = hostileInput();
  expect(new Set(input.rows.map((r) => r.writer_id)).size).toBe(4);
  expect(new Set(input.ops.map((o) => o.seq)).size).toBeLessThan(input.ops.length);
});

test("the checker reports no hard stop anywhere in the hostile log", () => {
  // Every anomaly in there is a NOTICE by design: spec §3.3:68 reserves hard
  // stops for chain breaks and unknown-newer versions, and a checker that
  // escalated a refused split into an aborted sync would strand a real device.
  const vs = checkAll(hostileInput());
  expect(hardStops(vs)).toHaveLength(0);
});

test("the hostile log's notices are exactly the three a healthy nasty log earns", () => {
  const vs = checkAll(hostileInput());
  expect(new Set(ids(vs))).toEqual(
    new Set(["I13_supersede_has_origin", "I14_forks_surfaced", "I15_unreadable_set_aside"]),
  );
});

/** Replays the hostile log one blob at a time, as a paging client actually does. */
function eachPage(fn: (n: number, page: CheckInput) => void): void {
  const whole = hostileInput();
  let state = emptyState();
  const ops: LogEntry[] = [];
  for (const [n, row] of whole.rows.entries()) {
    const body = openBlob(
      { userId: USER, stream: "hot", writerId: row.writer_id, writerCounter: row.writer_counter },
      row.blob,
    );
    state = foldBlobs([{ pos: { writer_id: row.writer_id, stream: "hot", writer_counter: row.writer_counter, seq: row.seq }, body }], state);
    try {
      for (const op of decodeBlobOps(body)) ops.push({ op, seq: row.seq, writer_id: row.writer_id });
    } catch {
      /* set aside, exactly as the fold did */
    }
    const page: CheckInput = {
      ...whole,
      rows: [row],
      ops: [...ops],
      state,
      cursorBefore: n === 0 ? 0n : whole.rows[n - 1]!.seq,
      next: row.seq,
      pinnedHeads: new Map(
        whole.rows.slice(0, n).map((r) => [chainKey(r.writer_id, "hot"), { counter: r.writer_counter, hash: r.blob_hash }]),
      ),
    };
    fn(n, page);
  }
}

test("the hostile log stays green when it is folded one blob at a time", () => {
  // The client syncs in pages. A checker that only holds against a single
  // whole-log fold would be green in tests and wrong in the product.
  //
  // I11 is excluded here and pinned by its own test below: it is a claim about
  // the ACCOUNT (does a checkpoint exist for this roster?), not about a page,
  // and a multi-device account legitimately has no checkpoint until one is
  // written. Every other invariant is a per-page claim and must hold at every
  // page boundary.
  eachPage((n, page) => {
    const stops = hardStops(checkAll(page)).filter((v) => v.id !== "I11_roster_checkpoint");
    expect(stops.map((v) => `blob ${n}: ${v.id} ${v.detail}`)).toEqual([]);
  });
});

test("I11 hard-stops every page of a multi-device bootstrap until the checkpoint lands", () => {
  // **An ordering dependency Task 14 has to handle, recorded here because it is
  // invisible from a whole-log test.** The plan makes "two or more device
  // writers and no checkpoint" a hard stop, and `Client.pull()` persists nothing
  // over a hard stop — so a second device cannot finish its first sync until
  // some device has written a checkpoint. The plan's own remedy is that `push`
  // emits one whenever the roster it sees has changed, so enrolling dev-b makes
  // dev-a checkpoint on its next push; the dependency is real but self-clearing,
  // and Task 38 step 4 already sequences it that way.
  //
  // The rule is NOT weakened to make this go away. Its whole purpose is that a
  // multi-device account without a checkpoint has no cross-check against a
  // withheld writer, and a checker that shrugged at that would be green with
  // spec §3.4's protection entirely absent.
  const seen: boolean[] = [];
  eachPage((_n, page) => {
    seen.push(hardStops(checkAll(page)).some((v) => v.id === "I11_roster_checkpoint"));
  });
  expect(seen[0]).toBe(true); // bootstrap: no checkpoint yet, three devices enrolled
  expect(seen[seen.length - 1]).toBe(false); // the page carrying the checkpoint clears it
  expect(seen.filter((x) => x).length).toBe(seen.length - 1); // and only that page clears it
});

// ---------------------------------------------------------------------------
// The corrections the engine's own behaviour forces on this checker
//
// Each of these is a thing the plan's wording invites a checker to assert, and
// each would fire on a correct log. They are tests so that a later, tidier
// rewrite cannot quietly reintroduce them.
// ---------------------------------------------------------------------------

test("future_parent is not a hard stop: it is reachable after ANY refusal", () => {
  // A split that does not sum consumes no version, so the author's next op names
  // a parent the head never reached. The corrected op must still apply cleanly.
  const input = assemble({
    plans: [
      { writer: "ingest", ops: [ingested("i1", "t1", { amount_minor: "25000" })] },
      { writer: "dev-a", ops: [split("t1", 1, [["a", "1"], ["b", "2"]])] }, // refused: split_sum
      { writer: "dev-a", ops: [categorized("t1", 2, "dining")] }, // future_parent
    ],
  });
  expect(input.state.anomalies.map((a) => a.kind)).toEqual(["split_sum", "future_parent"]);
  expect(hardStops(checkAll(input))).toHaveLength(0);
});

test("a stale-parent op whose payload is refused yields no ForkNotice, and that is not a violation", () => {
  const input = assemble({
    plans: [
      { writer: "ingest", ops: [ingested("i1", "t1", { amount_minor: "25000" })] },
      { writer: "dev-a", ops: [categorized("t1", 1, "dining")] }, // head -> 2
      { writer: "dev-b", ops: [split("t1", 1, [["a", "9"]])] }, // stale parent AND a bad sum
    ],
  });
  expect(input.state.forks).toHaveLength(0);
  expect(input.state.anomalies.map((a) => a.kind)).toContain("split_sum");
  expect(hardStops(checkAll(input))).toHaveLength(0);
});

test("a home-currency row re-armed as pending is not read as a missing rate", () => {
  // `txn_edited{amount_home_minor: null}` on a home-currency row files it under
  // pendingByCurrency[H] — a bucket no rate_set can ever drain, because that op
  // is refused. Deterministic, repairable by a later carrying edit, and NOT a
  // signal that the home currency needs a rate.
  const input = assemble({
    plans: [
      { writer: "dev-a", ops: [homeCurrency("AED")] },
      { writer: "ingest", ops: [ingested("i1", "t1", { amount_minor: "25000", currency: "AED" })] },
      { writer: "dev-a", ops: [edited("t1", 1, { amount_home_minor: null })] },
    ],
  });
  expect(input.state.pendingByCurrency.get("AED")).toEqual(new Set(["t1"]));
  expect(input.state.rates.get("AED")).toBe(1_000_000n);
  expect(hardStops(checkAll(input))).toHaveLength(0);
});

test("an op batch re-delivered at the same seq is quiet, and its anomaly is in the vocabulary", () => {
  // foldBlobs and the raw fold/applyOp APIs deliberately disagree here: a blob
  // redelivered at a folded seq throws (a caller bug, loudly), while an op batch
  // redelivered at the cursor is idempotent. The checker must accept the second.
  const input = cleanInput();
  input.state.anomalies.push({ kind: "duplicate_delivery", detail: "op-1 was already applied", at_seq: 1n });
  const vs = checkAll(input);
  expect(hardStops(vs)).toHaveLength(0);
  expect(find(vs, "I14_forks_surfaced")!.detail).toContain("duplicate_delivery");
});
