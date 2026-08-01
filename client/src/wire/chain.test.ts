import { expect, test } from "bun:test";
import { sealBlob, type Envelope, type Stream } from "./blob";
import {
  ChainBreakError,
  ZERO_HASH,
  chainHash,
  chainKey,
  headAfter,
  verifyChain,
  verifyFetchedRange,
  verifyHashList,
  type ChainRow,
  type Head,
  type HashRow,
} from "./chain";

const manifest: { zero_hash_hex: string; chain_steps: { fill_byte: string; length: number; expect_hash: string }[] } =
  await Bun.file(`${import.meta.dir}/../../../conformance/blob/manifest.json`).json();

const USER = "11111111-1111-1111-1111-111111111111";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A row that definitely names its chain, which every server response does. */
type TestRow = ChainRow & { writer_id: string; stream: Stream };

/** Builds a real chain: real sealed blobs, real hashes, so nothing is stubbed. */
function chain(writerId: string, stream: Stream, count: number, from: Head = genesis()): TestRow[] {
  const rows: TestRow[] = [];
  let prev = from.hash;
  for (let i = 0; i < count; i++) {
    const counter = from.counter + BigInt(i + 1);
    const env: Envelope = { userId: USER, stream, writerId, writerCounter: counter };
    const blob = sealBlob(env, new TextEncoder().encode(`{"v":1,"kind":"ops","ops":[],"n":${counter}}`));
    const blobHash = chainHash(prev, blob);
    rows.push({ writer_counter: counter, prev_hash: prev, blob_hash: blobHash, blob, writer_id: writerId, stream });
    prev = blobHash;
  }
  return rows;
}

function genesis(): Head {
  return { counter: 0n, hash: ZERO_HASH };
}

function hashRows(rows: TestRow[], firstSeq = 1n): HashRow[] {
  return rows.map((r, i) => ({
    seq: firstSeq + BigInt(i),
    writer_counter: r.writer_counter,
    blob_hash: r.blob_hash,
    prev_hash: r.prev_hash,
    writer_id: r.writer_id,
  }));
}

function pinnedFrom(list: HashRow[]): Map<bigint, Uint8Array> {
  return new Map(list.map((h) => [h.writer_counter, h.blob_hash]));
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("chainHash reproduces the golden vector Go generated", () => {
  // blob_hash[n] = SHA256(blob_hash[n-1] || blob_bytes[n]), genesis 32 zero
  // bytes. A change here is a data migration, not a code change.
  expect(hex(ZERO_HASH)).toBe(manifest.zero_hash_hex);
  expect(ZERO_HASH.length).toBe(32);
  expect(ZERO_HASH.every((b) => b === 0)).toBe(true);

  expect(manifest.chain_steps.length).toBeGreaterThan(0);
  let prev = ZERO_HASH;
  for (const step of manifest.chain_steps) {
    const body = new Uint8Array(step.length).fill(Number.parseInt(step.fill_byte, 16));
    prev = chainHash(prev, body);
    expect(hex(prev)).toBe(step.expect_hash);
  }
});

test("the hash covers the FRAMED bytes, so anyone holding the blob can recompute it", () => {
  const rows = chain("dev-a", "hot", 1);
  expect(hex(chainHash(ZERO_HASH, rows[0]!.blob))).toBe(hex(rows[0]!.blob_hash));
});

test("chainKey is the (writer_id, stream) pair every head is filed under", () => {
  expect(chainKey("dev-a", "hot")).toBe("dev-a|hot");
  // A writer id containing the separator would make two chains share one key.
  expect(() => chainKey("dev|a", "hot")).toThrow();
});

// ---------------------------------------------------------------------------
// verifyChain
// ---------------------------------------------------------------------------

test("verifyChain accepts a contiguous chain from genesis", () => {
  expect(() => verifyChain("dev-a|hot", chain("dev-a", "hot", 5), genesis())).not.toThrow();
  expect(() => verifyChain("dev-a|hot", [], genesis())).not.toThrow();
});

test("verifyChain accepts a contiguous chain continuing from a pinned head", () => {
  const rows = chain("dev-a", "hot", 5);
  const pinned: Head = { counter: 2n, hash: rows[1]!.blob_hash };
  expect(() => verifyChain("dev-a|hot", rows.slice(2), pinned)).not.toThrow();
  expect(headAfter(rows, genesis())).toEqual({ counter: 5n, hash: rows[4]!.blob_hash });

  // A run that does not continue the head it was verified against is refused —
  // this is what a persisted local head buys a returning device.
  expect(() => verifyChain("dev-a|hot", rows.slice(2), { counter: 2n, hash: ZERO_HASH })).toThrow(ChainBreakError);
  expect(() => verifyChain("dev-a|hot", rows, pinned)).toThrow(ChainBreakError);
});

test("verifyChain detects a dropped blob within a stream", () => {
  const full = chain("dev-a", "hot", 5);
  const rows = [full[0]!, full[1]!, full[3]!]; // counter 3 removed by a hostile server
  expect(() => verifyChain("dev-a|hot", rows, genesis())).toThrow(ChainBreakError);
});

test("verifyChain detects a reordered blob", () => {
  const full = chain("dev-a", "hot", 3);
  const rows = [full[0]!, full[2]!, full[1]!];
  expect(() => verifyChain("dev-a|hot", rows, genesis())).toThrow(ChainBreakError);
});

test("verifyChain detects a substituted blob even when the hash column is edited to match", () => {
  // Every hash is RECOMPUTED from the row's stored bytes rather than read from
  // the row, so a server that substitutes a blob cannot keep the chain intact by
  // also editing blob_hash.
  const rows = chain("dev-a", "hot", 3);
  const swapped = sealBlob(
    { userId: USER, stream: "hot", writerId: "dev-a", writerCounter: 2n },
    new TextEncoder().encode(`{"v":1,"kind":"ops","ops":[],"n":"forged"}`),
  );
  rows[1] = { ...rows[1]!, blob: swapped, blob_hash: chainHash(rows[1]!.prev_hash, swapped) };
  // The row is now internally consistent; only the NEXT row's prev_hash betrays it.
  expect(() => verifyChain("dev-a|hot", rows, genesis())).toThrow(ChainBreakError);
  // And a substitution with the original hash left in place fails immediately.
  const rows2 = chain("dev-a", "hot", 3);
  rows2[1] = { ...rows2[1]!, blob: swapped };
  expect(() => verifyChain("dev-a|hot", rows2, genesis())).toThrow(ChainBreakError);
});

test("verifyChain detects a forged prev_hash", () => {
  const rows = chain("dev-a", "hot", 3);
  rows[2] = { ...rows[2]!, prev_hash: ZERO_HASH };
  expect(() => verifyChain("dev-a|hot", rows, genesis())).toThrow(ChainBreakError);
});

test("verifyChain refuses rows spliced from more than one writer or stream", () => {
  // Interleaving two writers with continuous counters and honestly recomputed
  // hashes passes every other check, so failing closed is the safe reading.
  const a = chain("dev-a", "hot", 3);
  const b = chain("dev-b", "hot", 3);
  expect(() => verifyChain("dev-a|hot", [a[0]!, b[1]!, a[2]!], genesis())).toThrow(ChainBreakError);
  expect(() => verifyChain("dev-b|hot", a, genesis())).toThrow(ChainBreakError);
  const cold = chain("dev-a", "cold", 3);
  expect(() => verifyChain("dev-a|hot", cold, genesis())).toThrow(ChainBreakError);
});

test("hot and cold chains are verified independently", () => {
  // The same counter value 1 appears in both streams; verifying hot must not
  // consult cold, and vice versa. This is the property that makes a hot-only
  // pull verifiable (Decision 13): the ingest writer appends a hot blob and a
  // cold blob for the same email, and a single chain per writer would leave the
  // hot pull looking at counters 1, 3, 5, … with prev_hashes pointing at cold
  // blobs the client deliberately did not fetch.
  const hot = chain("ingest", "hot", 3);
  const cold = chain("ingest", "cold", 3);
  expect(hot[0]!.writer_counter).toBe(cold[0]!.writer_counter);
  expect(hex(hot[0]!.blob_hash)).not.toBe(hex(cold[0]!.blob_hash)); // different AAD, different bytes

  expect(() => verifyChain("ingest|hot", hot, genesis())).not.toThrow();
  expect(() => verifyChain("ingest|cold", cold, genesis())).not.toThrow();
  // Verifying hot against the cold head must fail: the streams share nothing.
  expect(() => verifyChain("ingest|hot", hot, { counter: 0n, hash: cold[0]!.blob_hash })).toThrow(ChainBreakError);
});

// ---------------------------------------------------------------------------
// The cold hash list (spec §3.3:72)
// ---------------------------------------------------------------------------

test("verifyHashList pins a cold head without any cold bodies", () => {
  const cold = chain("ingest", "cold", 6);
  const list = hashRows(cold);
  const head = verifyHashList("ingest|cold", list, genesis());
  expect(head.counter).toBe(BigInt(list.length));
  expect(hex(head.hash)).toBe(hex(cold[5]!.blob_hash));

  // An empty page leaves the head exactly where it was, so a client that keeps
  // sending its cursor back never rewinds.
  expect(verifyHashList("ingest|cold", [], head)).toEqual(head);
  // And a later page continues from the head the earlier one returned.
  const more = chain("ingest", "cold", 2, head);
  expect(verifyHashList("ingest|cold", hashRows(more, 7n), head).counter).toBe(8n);
});

test("verifyHashList detects a gap, a reorder and a wrong continuation", () => {
  const list = hashRows(chain("ingest", "cold", 5));
  expect(() => verifyHashList("ingest|cold", [list[0]!, list[1]!, list[3]!], genesis())).toThrow(ChainBreakError);
  expect(() => verifyHashList("ingest|cold", [list[0]!, list[2]!, list[1]!], genesis())).toThrow(ChainBreakError);
  expect(() => verifyHashList("ingest|cold", list.slice(2), genesis())).toThrow(ChainBreakError);
  // prev_hash is present in the server's hash list, so the linkage is checked
  // too — including the link from the first entry to the pinned head.
  expect(() => verifyHashList("ingest|cold", list, { counter: 0n, hash: list[2]!.blob_hash })).toThrow(ChainBreakError);
  const forged = [...list];
  forged[3] = { ...forged[3]!, prev_hash: ZERO_HASH };
  expect(() => verifyHashList("ingest|cold", forged, genesis())).toThrow(ChainBreakError);
  // seq is strictly increasing within a stream.
  const backwards = [...list];
  backwards[2] = { ...backwards[2]!, seq: 1n };
  expect(() => verifyHashList("ingest|cold", backwards, genesis())).toThrow(ChainBreakError);
  // And entries from another writer are not this chain's.
  const other = hashRows(chain("dev-a", "cold", 2));
  expect(() => verifyHashList("ingest|cold", other, genesis())).toThrow(ChainBreakError);
});

test("verifyFetchedRange rejects a cold body swapped after pinning", () => {
  const cold = chain("ingest", "cold", 6);
  const pinned = pinnedFrom(hashRows(cold));

  // The honest range verifies.
  expect(() => verifyFetchedRange(pinned, cold.slice(3, 5))).not.toThrow();

  const tampered = sealBlob(
    { userId: USER, stream: "cold", writerId: "ingest", writerCounter: 5n },
    new TextEncoder().encode(`{"v":1,"kind":"raw_body","forged":true}`),
  );
  const swapped: ChainRow = { ...cold[4]!, blob: tampered };
  expect(() => verifyFetchedRange(pinned, [swapped])).toThrow(ChainBreakError);

  // Re-chaining the swapped body against a forged prev does not help either:
  // matching the pinned hash would need a preimage.
  const rechained: ChainRow = { ...swapped, blob_hash: chainHash(swapped.prev_hash, tampered) };
  expect(() => verifyFetchedRange(pinned, [rechained])).toThrow(ChainBreakError);

  // A body at a counter that was never pinned is refused rather than trusted.
  expect(() => verifyFetchedRange(pinned, chain("ingest", "cold", 9).slice(8))).toThrow(ChainBreakError);
});

test("verifyHashList proves the server committed to a sequence, not that the bodies are honest", () => {
  // The claim boundary, asserted rather than only documented: a list of hashes
  // with no bodies cannot prove blob_hash[n] = SHA256(blob_hash[n-1] || blob[n]),
  // so a server free to invent BOTH still produces a list that verifies. What it
  // cannot do is change its mind later, which is what verifyFetchedRange catches.
  const invented: HashRow[] = [];
  let prev = ZERO_HASH;
  for (let i = 1n; i <= 3n; i++) {
    const fake = new Uint8Array(32).fill(Number(i));
    invented.push({ seq: i, writer_counter: i, blob_hash: fake, prev_hash: prev, writer_id: "ingest" });
    prev = fake;
  }
  expect(() => verifyHashList("ingest|cold", invented, genesis())).not.toThrow();
  // But no body it later serves can hash to those invented values.
  const real = chain("ingest", "cold", 3);
  expect(() => verifyFetchedRange(pinnedFrom(invented), real)).toThrow(ChainBreakError);
});

test("a row that names no writer fails loudly instead of skipping the check", () => {
  // requireSameChain used to return quietly when the row carried neither field,
  // so against a response type that omitted them the cross-chain splice
  // detection simply did not run — the check was present and vacuous. Go cannot
  // be bypassed that way because oplog.Row always carries both from its database
  // columns, so the fields are required here too.
  const rows = chain("dev-a", "hot", 2);
  const stripped = rows.map((r) => ({ ...r, writer_id: "" }));
  expect(() => verifyChain("dev-a|hot", stripped, genesis())).toThrow(ChainBreakError);

  const undef = rows.map((r) => ({ ...r, writer_id: undefined as unknown as string }));
  expect(() => verifyChain("dev-a|hot", undef, genesis())).toThrow(ChainBreakError);

  // Same for the hash list, whose entries name a writer but not a stream.
  const list = hashRows(rows).map((h) => ({ ...h, writer_id: "" }));
  expect(() => verifyHashList("dev-a|hot", list, genesis())).toThrow(ChainBreakError);
});

test("the hash list's prev_hash linkage is always checked, never optional", () => {
  // prev_hash was optional, which meant the linkage check silently did not run
  // for a caller that dropped it — including the link from the first entry to
  // the pinned head, which is the only thing tying the list to anything.
  const rows = chain("ingest", "cold", 3);
  const list = hashRows(rows);
  expect(() => verifyHashList("ingest|cold", list, genesis())).not.toThrow();
  const broken = [...list];
  broken[0] = { ...broken[0]!, prev_hash: new Uint8Array(32).fill(9) };
  expect(() => verifyHashList("ingest|cold", broken, genesis())).toThrow(ChainBreakError);
});
