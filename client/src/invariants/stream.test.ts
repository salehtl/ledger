/**
 * The streaming half of Task 12: the checker holds one chunk of the log, not the
 * log.
 *
 * Three properties, and the third is the one that is easy to fake:
 *
 *  1. **Same answers.** Streamed and array runs agree, at every chunk size.
 *  2. **No retention.** A chunk handed to the checker is not read again after
 *     the next one arrives — proven by destroying it and re-running, which is a
 *     deterministic assertion rather than a hopeful one.
 *  3. **Bounded memory.** Measured, with the instrument itself validated: the
 *     same measurement is taken over the ARRAY path in the same run, and the
 *     test requires it to show the retention. A memory assertion that has never
 *     been seen to fail is a memory assertion that measures nothing.
 */

import { expect, test } from "bun:test";
import { Client } from "../net/client";
import { emptyState } from "../replay/state";
import { memStore } from "../store/store";
import { sealBlob, type Stream } from "../wire/blob";
import { ZERO_HASH, chainHash, type Head } from "../wire/chain";
import { encodeBlobOps, type Op } from "../wire/op";
import { arrayChunks, checkAll, checkAllStream, type CheckInput, type Chunks, type SyncRow, type Violation } from "./check";
import { storedOps, storedRows } from "./source";
import type { LogEntry } from "../replay/replay";
import type { WireRow } from "../store/store";

const USER = "11111111-1111-1111-1111-111111111111";
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

let opCounter = 0;
function txnOp(n: number, pad = 0): Op {
  return {
    v: 1,
    type: "txn_ingested",
    op_id: `op-${++opCounter}`,
    authored_at: "2026-06-05T09:00:05Z",
    parent_version: null,
    entity: { kind: "txn", id: `t${n}` },
    ingest_id: new Bun.CryptoHasher("sha256").update(`i${n}`).digest("hex"),
    payload: {
      amount_minor: "25000",
      currency: "AED",
      direction: "debit",
      posted_at: "2026-06-05T09:00:00Z",
      merchant_raw: pad === 0 ? "CARREFOUR" : `CARREFOUR ${noise(pad)}`,
      last4: "3701",
    },
  } as Op;
}

/**
 * `n` bytes of INCOMPRESSIBLE padding.
 *
 * Random rather than repeated, because a blob is gzipped before it is sealed:
 * twelve thousand `x`s land on the 1 KiB rung, which made the first draft of the
 * memory measurement below quietly measure a 700 KB corpus.
 */
const noise = (n: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString("base64");

/** One op, padded, so a fixture can choose which size rung its blobs land on. */
const batch = (k: number, pad: number): Op[] => [txnOp(k, pad)];

/**
 * `n` real sealed hot rows on one chain, generated fresh on every call.
 *
 * Regenerated rather than cached on purpose: a corpus held in a closure is a
 * strong reference to every blob in it, which would make the retention
 * measurement below measure the fixture instead of the checker.
 */
function corpus(n: number, writer = "dev-a", stream: Stream = "hot", pad = 0): SyncRow[] {
  const rows: SyncRow[] = [];
  let head: Head = { counter: 0n, hash: ZERO_HASH };
  for (let k = 1; k <= n; k++) {
    const counter = BigInt(k);
    const blob = sealBlob({ userId: USER, stream, writerId: writer, writerCounter: counter }, encodeBlobOps(batch(k, pad)));
    const blobHash = chainHash(head.hash, blob);
    rows.push({
      seq: BigInt(k),
      stream,
      writer_id: writer,
      writer_counter: counter,
      prev_hash: head.hash,
      blob_hash: blobHash,
      blob,
      size_bucket: blob.length,
    });
    head = { counter, hash: blobHash };
  }
  return rows;
}

function wire(r: SyncRow): WireRow {
  return {
    seq: r.seq.toString(10),
    stream: r.stream,
    writer_id: r.writer_id,
    writer_counter: r.writer_counter.toString(10),
    type_flag: "ops",
    size_bucket: r.size_bucket,
    blob_hash: hex(r.blob_hash),
    prev_hash: hex(r.prev_hash),
    created_at: "2026-06-05T09:00:00Z",
    blob: b64(r.blob),
  };
}

function inputFor(rows: SyncRow[], ops: LogEntry[]): CheckInput {
  const last = rows[rows.length - 1];
  return {
    userId: USER,
    stream: "hot",
    rows,
    hashList: [],
    ops,
    state: emptyState(),
    roster: [],
    pinnedHeads: new Map(),
    pinnedBlobHashes: new Map(),
    cursorBefore: 0n,
    next: last === undefined ? 0n : last.seq,
  };
}

// ---------------------------------------------------------------------------
// 1. The same answers
// ---------------------------------------------------------------------------

test("every chunk size gives the identical report", () => {
  const rows = corpus(40);
  const base = checkAll(inputFor(rows, []));
  for (const size of [1, 2, 7, 39, 40, 41, 250]) {
    const streamed = checkAllStream({ ...inputFor(rows, []), rows: arrayChunks(rows, size), ops: arrayChunks([], size) });
    expect(streamed).toEqual(base);
  }
});

test("a chain break is still found when its two rows land in different chunks", () => {
  // The predecessor lookup is a WINDOW now. A break at the chunk boundary is
  // where a windowed lookup would stop linking, so it is the case that gets a
  // test rather than a comment.
  const rows = corpus(40);
  rows[20]!.prev_hash = new Uint8Array(32).fill(9);
  rows[20]!.blob_hash = chainHash(rows[20]!.prev_hash, rows[20]!.blob);
  for (const size of [1, 4, 20, 21]) {
    const vs = checkAllStream({ ...inputFor(rows, []), rows: arrayChunks(rows, size), ops: arrayChunks([]) });
    expect(vs.filter((v) => v.id === "I3_chain" && v.severity === "hard_stop").length).toBeGreaterThan(0);
  }
});

// ---------------------------------------------------------------------------
// 2. No retention — proven by destroying what was handed over
// ---------------------------------------------------------------------------

/**
 * A source that OVERWRITES every chunk it has handed out as soon as the next one
 * is asked for.
 *
 * This is the store's contract stated as a hostile fixture: `eachRowChunk`'s doc
 * says `fn` "must consume it before returning", and a consumer that squirrels a
 * chunk away has simply moved `all()` into its own body. If any check here did
 * that, it would be reading zeroed rows and the report would differ.
 */
function poisoning(rows: SyncRow[], size: number): Chunks<SyncRow> {
  return {
    each(fn) {
      let previous: SyncRow[] | null = null;
      for (let n = 0; n < rows.length; n += size) {
        if (previous !== null) {
          for (const r of previous) {
            r.blob = new Uint8Array(0);
            r.blob_hash = new Uint8Array(0);
            r.prev_hash = new Uint8Array(0);
            r.seq = -1n;
            r.writer_counter = -1n;
            r.size_bucket = -1;
          }
        }
        // Fresh copies, so poisoning one pass's chunks cannot corrupt the next.
        const chunk = rows.slice(n, n + size).map((r) => ({ ...r }));
        previous = chunk;
        fn(chunk);
      }
    },
  };
}

test("nothing retains a chunk past the next one: poisoning every consumed chunk changes no answer", () => {
  const rows = corpus(30);
  const base = checkAll(inputFor(rows, []));
  for (const size of [1, 5, 29]) {
    const vs = checkAllStream({ ...inputFor(rows, []), rows: poisoning(rows, size), ops: arrayChunks([]) });
    expect(vs).toEqual(base);
  }
});

test("the poisoning fixture would CATCH a consumer that retains chunks", () => {
  // The test above is worth nothing unless this one holds: a deliberate
  // retainer, run against the same source, must produce a different answer.
  const rows = corpus(30);
  const held: SyncRow[] = [];
  const src = poisoning(rows, 5);
  src.each((chunk) => {
    for (const r of chunk) held.push(r);
  });
  // Everything but the last chunk was destroyed while it was being held.
  expect(held.filter((r) => r.blob.length === 0).length).toBe(25);
  expect(held.filter((r) => r.blob.length > 0).length).toBe(5);
});

// ---------------------------------------------------------------------------
// 3. Bounded memory — measured, with the instrument validated
// ---------------------------------------------------------------------------

/**
 * Live BYTES held in typed arrays, after a forced full collection.
 *
 * `external`, not `heapUsed`: a `Uint8Array`'s backing store is not in the JS
 * heap, so `heapUsed` reports **zero** for 8 MB of held blobs — which is how an
 * earlier draft of this test managed to "measure" memory while being blind to
 * the only thing on the heap that is measured in megabytes. Verified both ways
 * below: the array arm must show the log it holds.
 *
 * Two collections, because one leaves floaters.
 */
function liveBytes(): number {
  Bun.gc(true);
  Bun.gc(true);
  return (process.memoryUsage() as unknown as { external: number }).external;
}

test("a whole-log check holds a chunk, not the log — and the measurement can see the difference", () => {
  // 500 rows on the 16 KiB rung is ~8 MB of blob. Small next to the operator's
  // 3,683-message history at up to 1 MiB a blob, and already several times what
  // any chunk holds.
  //
  // What is measured is the live byte count after a forced collection (see
  // {@link liveBytes}) — not `heapUsed`, which counts garbage the collector has
  // not reached AND excludes typed-array storage entirely. It is taken at the
  // top of the stack rather than mid-pass, because Bun's collector scans the
  // stack conservatively and a sample inside the checker's own frames keeps that
  // pass's garbage alive. The transient peak is the test below, which counts
  // survivors instead.
  const N = 500;
  const CHUNK = 50;
  const PAD = 12_000; // 12 KB of incompressible payload: the 16 KiB rung
  const bytes = corpus(1, "dev-a", "hot", PAD).reduce((n, r) => n + r.blob.length, 0) * N;
  expect(bytes).toBeGreaterThan(6_000_000);

  const base = liveBytes();

  // The streaming arm: rows are generated a chunk at a time and nothing outside
  // the callback ever holds one.
  const streamedSource: Chunks<SyncRow> = {
    each(fn) {
      let head: Head = { counter: 0n, hash: ZERO_HASH };
      let k = 1;
      while (k <= N) {
        const chunk: SyncRow[] = [];
        for (let j = 0; j < CHUNK && k <= N; j++, k++) {
          const counter = BigInt(k);
          const blob = sealBlob(
            { userId: USER, stream: "hot", writerId: "dev-a", writerCounter: counter },
            encodeBlobOps(batch(k, PAD)),
          );
          const blobHash = chainHash(head.hash, blob);
          chunk.push({
            seq: BigInt(k),
            stream: "hot",
            writer_id: "dev-a",
            writer_counter: counter,
            prev_hash: head.hash,
            blob_hash: blobHash,
            blob,
            size_bucket: blob.length,
          });
          head = { counter, hash: blobHash };
        }
        fn(chunk);
      }
    },
  };

  const streamedReport = checkAllStream({
    ...inputFor([], []),
    next: BigInt(N),
    rows: streamedSource,
    ops: arrayChunks([]),
  });
  expect(streamedReport.filter((v) => v.severity === "hard_stop")).toEqual([]);
  const streamedLive = liveBytes() - base;

  // The array arm: the same log, materialized, which is what `Client.check()`
  // did before this task. It must show the retention, or the assertion below is
  // measuring nothing at all.
  const rows = corpus(N, "dev-a", "hot", PAD);
  const arrayReport = checkAll(inputFor(rows, []));
  const arrayLive = liveBytes() - base;
  expect(arrayReport.filter((v) => v.severity === "hard_stop")).toEqual([]);
  expect(rows.length).toBe(N); // `rows` is still referenced here, which is the point

  // The instrument can see a held log...
  expect(arrayLive).toBeGreaterThan(bytes / 2);
  // ...and the streaming arm does not hold one. This is the whole claim: the
  // array path keeps every blob alive for as long as the session lasts, which is
  // the shape that took the Phase 0 build past 500 MB and froze it.
  expect(streamedLive).toBeLessThan(bytes / 8);
});

test("no retention GROWS with the log: what survives a run is bounded by a chunk, not by n", () => {
  // The complement of the peak measurement. Weak references to every blob the
  // source ever handed out; after the run and a forced GC, the ones still alive
  // are what the checker kept. That number must not scale with the corpus.
  const survivors = (n: number): number => {
    const refs: WeakRef<Uint8Array>[] = [];
    const src: Chunks<SyncRow> = {
      each(fn) {
        const all = corpus(n);
        for (let k = 0; k < all.length; k += 100) {
          const chunk = all.slice(k, k + 100);
          for (const r of chunk) refs.push(new WeakRef(r.blob));
          fn(chunk);
        }
      },
    };
    checkAllStream({ ...inputFor([], []), next: BigInt(n), rows: src, ops: arrayChunks([]) });
    Bun.gc(true);
    Bun.gc(true);
    return refs.filter((w) => w.deref() !== undefined).length;
  };
  const small = survivors(200);
  const large = survivors(800);
  // Four times the log, no more than one extra chunk's worth of survivors.
  expect(large).toBeLessThanOrEqual(small + 100);
});

// ---------------------------------------------------------------------------
// The store-backed sources, and the wiring that uses them
// ---------------------------------------------------------------------------

function decode(r: WireRow): SyncRow {
  return {
    seq: BigInt(r.seq),
    stream: r.stream as Stream,
    writer_id: r.writer_id,
    writer_counter: BigInt(r.writer_counter),
    size_bucket: r.size_bucket,
    blob_hash: Uint8Array.from(Buffer.from(r.blob_hash, "hex")),
    prev_hash: Uint8Array.from(Buffer.from(r.prev_hash, "hex")),
    blob: Uint8Array.from(Buffer.from(r.blob, "base64")),
  };
}

test("storedRows and storedOps reproduce what the store holds, twice over", () => {
  const rows = corpus(12);
  const store = memStore("http://127.0.0.1:1");
  store.rows().append("hot", rows.map(wire));

  const src = storedRows(store.rows(), "hot", decode, 5);
  const first: bigint[] = [];
  const second: bigint[] = [];
  src.each((chunk) => {
    for (const r of chunk) first.push(r.seq);
  });
  src.each((chunk) => {
    for (const r of chunk) second.push(r.seq);
  });
  expect(first).toEqual(rows.map((r) => r.seq));
  expect(second).toEqual(first); // re-iterable, which every check depends on

  const ops: string[] = [];
  storedOps(store.rows(), USER, decode, 5).each((chunk) => {
    for (const e of chunk) ops.push(String(e.op.op_id));
  });
  expect(ops).toHaveLength(12);
});

test("storedOps sets aside exactly what the fold sets aside, and never invents an op", () => {
  // The agreement that matters: I9 and I10 re-fold these ops and compare the
  // result against the state the CLIENT folded. A source that yielded ops from a
  // blob the fold set aside would make them disagree about a log neither is
  // wrong about.
  const rows = corpus(6);
  const junk = new TextEncoder().encode("not an op blob");
  rows[2]!.blob = sealBlob({ userId: USER, stream: "hot", writerId: "dev-a", writerCounter: 3n }, junk);
  rows[3]!.blob = new Uint8Array(rows[3]!.blob.length); // will not even open

  const store = memStore("http://127.0.0.1:1");
  store.rows().append("hot", rows.map(wire));
  const ops: LogEntry[] = [];
  storedOps(store.rows(), USER, decode, 2).each((chunk) => {
    for (const e of chunk) ops.push(e);
  });
  expect(ops.map((e) => Number(e.seq))).toEqual([1, 2, 5, 6]);
});

test("Client.check() runs the streaming path end to end over a real store", () => {
  // The wiring, not the module. A function that streams beautifully and is never
  // called is the defect shape this project has paid for six times.
  const rows = corpus(9);
  const store = memStore("http://127.0.0.1:1");
  store.save({ ...store.load(), userId: USER, writerId: "dev-a" });
  store.rows().append("hot", rows.map(wire));

  const client = new Client({ store, server: "http://127.0.0.1:1" });
  const vs: Violation[] = client.check();
  expect(vs.filter((v) => v.severity === "hard_stop")).toEqual([]);
  // It saw all nine: I1 compares `next` against the last row, and the state it
  // folded has all nine transactions in it.
  expect(client.state().txns.size).toBe(9);
  expect(vs.some((v) => v.id === "I14_forks_surfaced")).toBe(true);
});

test("Client.check() reports a tampered stored blob rather than passing it", () => {
  // The check above proves the path runs. This one proves it still BITES after
  // being rewritten to stream: a green streaming check over a broken log is the
  // whole failure mode of this task.
  const rows = corpus(9);
  const store = memStore("http://127.0.0.1:1");
  store.save({ ...store.load(), userId: USER, writerId: "dev-a" });
  const wires = rows.map(wire);
  const bad = wires[4]!;
  const bytes = Uint8Array.from(Buffer.from(bad.blob, "base64"));
  bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0xff;
  wires[4] = { ...bad, blob: b64(bytes) };
  store.rows().append("hot", wires);

  const client = new Client({ store, server: "http://127.0.0.1:1" });
  const stops = client.check().filter((v) => v.severity === "hard_stop");
  expect(stops.map((v) => v.id)).toContain("I3_chain");
});

test("a chain key with two writers is walked per writer, not as one run", () => {
  // A fixture with one of something cannot tell "correct grouping" from "no
  // grouping": with a single writer, per-writer counters and page order are the
  // same sequence. Two writers interleaved is the fixture that can tell.
  const a = corpus(4, "dev-a");
  const b = corpus(4, "ingest");
  const merged: SyncRow[] = [];
  for (let k = 0; k < 4; k++) {
    merged.push({ ...a[k]!, seq: BigInt(k * 2 + 1) }, { ...b[k]!, seq: BigInt(k * 2 + 2) });
  }
  const clean = checkAllStream({
    ...inputFor(merged, []),
    next: 8n,
    rows: arrayChunks(merged, 3),
    ops: arrayChunks([]),
  });
  expect(clean.filter((v) => v.severity === "hard_stop")).toEqual([]);

  // Drop ONE of ingest's rows: dev-a's run is still perfect, so anything that
  // walked the page as one sequence would see 7 rows and no gap.
  const holed = merged.filter((r) => !(r.writer_id === "ingest" && r.writer_counter === 2n));
  const vs = checkAllStream({
    ...inputFor(holed, []),
    next: 8n,
    rows: arrayChunks(holed, 3),
    ops: arrayChunks([]),
  });
  expect(vs.filter((v) => v.id === "I2_writer_counters").map((v) => v.detail).join(" ")).toContain("ingest|hot");
});

test("a broken link is still found when the OTHER writer's rows sit between its two ends", () => {
  // Found by mutation: shrinking the predecessor window to one entry survived
  // the whole suite, because every chain fixture above has a single writer and
  // its predecessor is therefore always the row immediately before. Interleave
  // a second writer and the two ends of a link are never adjacent — which is
  // what a real page looks like, since `seq` is one order across all writers.
  const a = corpus(6, "dev-a");
  const b = corpus(6, "ingest");
  const merged: SyncRow[] = [];
  for (let k = 0; k < 6; k++) {
    merged.push({ ...a[k]!, seq: BigInt(k * 2 + 1) }, { ...b[k]!, seq: BigInt(k * 2 + 2) });
  }
  const clean = checkAllStream({ ...inputFor(merged, []), next: 12n, rows: arrayChunks(merged, 4), ops: arrayChunks([]) });
  expect(clean.filter((v) => v.severity === "hard_stop")).toEqual([]);

  // dev-a's fourth blob links to nothing its own chain produced, and its hash is
  // recomputed so I3's byte check stays quiet: only the LINK is wrong.
  const broken = merged.map((r) => ({ ...r }));
  const target = broken.find((r) => r.writer_id === "dev-a" && r.writer_counter === 4n)!;
  target.prev_hash = new Uint8Array(32).fill(7);
  target.blob_hash = chainHash(target.prev_hash, target.blob);
  const vs = checkAllStream({ ...inputFor(broken, []), next: 12n, rows: arrayChunks(broken, 4), ops: arrayChunks([]) });
  expect(vs.filter((v) => v.id === "I3_chain" && v.severity === "hard_stop").length).toBeGreaterThan(0);
});

test("storedRows retains nothing between passes", () => {
  // Found by mutation: a source that MEMOIZED its first pass survived every
  // assertion above, because a cache returns identical data — it is `all()` in
  // disguise, and `all()` is the method the store was refactored to remove.
  const store = memStore("http://127.0.0.1:1");
  store.rows().append("hot", corpus(20).map(wire));
  const src = storedRows(store.rows(), "hot", decode, 5);

  const refs: WeakRef<Uint8Array>[] = [];
  src.each((chunk) => {
    for (const r of chunk) refs.push(new WeakRef(r.blob));
  });
  expect(refs).toHaveLength(20);
  // A second pass, then a collection: nothing the FIRST pass decoded may still
  // be alive, because a re-iterable source re-reads rather than remembers.
  src.each(() => {});
  Bun.gc(true);
  Bun.gc(true);
  expect(refs.filter((w) => w.deref() !== undefined)).toHaveLength(0);
});
