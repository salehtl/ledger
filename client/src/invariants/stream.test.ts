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
import { discardingOps, storedOps, storedRows } from "./source";
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
// 3. Bounded memory — measured by REACHABILITY, never by the clock
//
// # Why this is not a byte count, and never a duration
//
// The first version of this section measured live `external` bytes across an
// 8 MB corpus: 500 sealed 16 KiB blobs, regenerated on every one of the
// checker's passes because a re-iterable source may not cache. That is ~90 MB of
// gzip-and-seal work, and it read **1.7 s on an idle box and 7.5 s at load 9** —
// past bun's 5 s per-test ceiling, so `v2-check.sh` exited 1 on a machine that
// was merely busy.
//
// Raising the ceiling would have been the wrong fix twice over. This repo
// already carries one wall-clock limit (`replay/fx.test.ts`) under a standing
// rule not to raise it, because a 5,708 ms reading there was contention and
// raising it would have erased the signal; a second one turns "the gate is red"
// into background noise, which is how real failures get waved through. And a
// duration was never the property anyway: how long a fold takes is a fact about
// the machine, while what it RETAINS is a fact about the algorithm.
//
// So the instrument is a weak reference. A blob handed to the checker that is
// still alive after `Bun.gc(true)` is a blob something still holds — which is
// the same answer on a loaded two-core box as on an idle one, and costs sixty
// small blobs instead of five hundred large ones.
// ---------------------------------------------------------------------------

/**
 * Hands `rows` out a chunk at a time as FRESH copies, weakly references every
 * blob it hands over, and samples how many are still alive at the end of each
 * pass.
 *
 * Three decisions, each of which a measurement here got wrong first:
 *
 *  - **Copies, not the fixture's own rows.** `rows` stays alive for the whole
 *    test, so weak references into it could never be collected and the answer
 *    would be "everything survives" whatever the consumer did. What is measured
 *    is what the CONSUMER kept of what it was given. Copying also means the
 *    corpus is sealed once instead of once per pass, which is most of why this
 *    is now milliseconds rather than seconds.
 *  - **The peak, sampled DURING the run, not the residue after it.** A consumer
 *    that accumulates every chunk into a local drops the whole array when it
 *    returns, so an after-the-fact count reports zero and calls it bounded. That
 *    exact mutant (`checkChain` keeping every row instead of 32 bytes of hash)
 *    survived the post-run version of this test and is killed by this one:
 *    honest peaks at one chunk, the retainer at the whole log.
 *  - **`Bun.gc(true)` twice, once per pass.** One collection leaves floaters,
 *    and one sample per chunk boundary cost 4 s of forced collections — which
 *    is how a structural assertion turns back into the wall-clock one it
 *    replaced. Measured over three runs: 20-21 for a 60-row log and 21-40 for a
 *    240-row one, against 60 and 240 for a consumer that accumulates.
 */
function tracked(rows: readonly SyncRow[], size: number): {
  src: Chunks<SyncRow>;
  /** The most blobs simultaneously reachable at the end of any one pass. */
  peak: () => number;
  handed: () => number;
} {
  const refs: WeakRef<Uint8Array>[] = [];
  let peak = 0;
  const sample = (): void => {
    Bun.gc(true);
    Bun.gc(true);
    const alive = refs.filter((w) => w.deref() !== undefined).length;
    if (alive > peak) peak = alive;
  };
  return {
    src: {
      each(fn) {
        for (let k = 0; k < rows.length; k += size) {
          const chunk = rows.slice(k, k + size).map((r) => ({ ...r, blob: Uint8Array.from(r.blob) }));
          for (const r of chunk) refs.push(new WeakRef(r.blob));
          fn(chunk);
        }
        // Once per PASS rather than once per chunk. A consumer that accumulates
        // still holds everything when its pass ends — that is where its peak is
        // — so this catches it, at a twelfth of the collections. Forcing a full
        // GC at every boundary took the file to 4 s, which is how a structural
        // assertion quietly turns back into a wall-clock one.
        sample();
      },
    },
    peak: () => peak,
    handed: () => refs.length,
  };
}

test("a whole-log check holds a chunk, not the log — and the instrument can see the difference", () => {
  const N = 120;
  const CHUNK = 10;
  const rows = corpus(N);

  // Arm A: the checker. Every one of its passes gets its own copies, and the
  // peak is taken across all of them.
  const streamed = tracked(rows, CHUNK);
  const report = checkAllStream({ ...inputFor([], []), next: BigInt(N), rows: streamed.src, ops: arrayChunks([]) });
  expect(report.filter((v) => v.severity === "hard_stop")).toEqual([]);
  expect(streamed.handed()).toBeGreaterThanOrEqual(N); // it really did walk the log, repeatedly

  // Arm B: the CALIBRATION — the same source, the same instrument, and a
  // consumer that accumulates instead of consuming. This is the `all()` shape
  // `RowStore` was refactored to remove and what `Client.check()` used to do.
  // Without this arm, arm A is a memory assertion that has never been seen to
  // fail; with it, the instrument is shown to report retention when there is
  // some.
  const held = tracked(rows, CHUNK);
  const accumulated: SyncRow[] = [];
  held.src.each((chunk) => {
    for (const r of chunk) accumulated.push(r);
  });
  expect(accumulated).toHaveLength(N);
  expect(held.peak()).toBe(N);

  // And the checker does not. The bound is three chunks against a hundred and
  // twenty rows — a tenfold margin over arm B, with room for the one artefact
  // this instrument does have: Bun's collector scans the stack conservatively,
  // so the chunk BEFORE the current one is sometimes still reachable from a
  // stale slot. Measured, the honest path reads one chunk at every boundary of
  // every pass and occasionally two; a retainer reads the whole log.
  //
  // The claim is about REACHABILITY, so it reads the same on a loaded two-core
  // box as on an idle one — which is the entire reason this is not a byte count
  // over a corpus big enough to need seconds of sealing.
  expect(streamed.peak()).toBeLessThanOrEqual(3 * CHUNK);
});

test("no retention GROWS with the log: what is reachable at once is bounded by a chunk, not by n", () => {
  // The complement: the test above pins the level, this pins the SLOPE.
  // Quadruple the log and the peak must not follow it — which is the difference
  // between "holds a chunk" and "holds a fraction of the log".
  const CHUNK = 20;
  const peak = (n: number): number => {
    const t = tracked(corpus(n), CHUNK);
    checkAllStream({ ...inputFor([], []), next: BigInt(n), rows: t.src, ops: arrayChunks([]) });
    expect(t.handed()).toBeGreaterThanOrEqual(n);
    return t.peak();
  };
  const small = peak(60);
  const large = peak(240);
  if (process.env["PEAKDBG"] === "1") console.log("PEAKS", small, large);
  // Quadruple the log: the peak must not follow it. A consumer that accumulated
  // would read 60 and 240 here, failing both.
  expect(large - small).toBeLessThanOrEqual(2 * CHUNK);
  expect(large).toBeLessThanOrEqual(3 * CHUNK);
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

test("the fold's op sink keeps nothing, which is what makes check() a state fold and not a copy", () => {
  // `Client.check()` folds the log for its state and re-derives the ops lazily,
  // so the fold's op list must not accumulate a second whole-log copy. That was
  // the one property in this task no instrument could reach — an array
  // truncated between chunks inside a sync method reads as zero afterwards
  // whether or not the truncation is there. Naming the sink is what makes it
  // assertable, and this is the assertion.
  const sink = discardingOps();
  const entry = { op: { op_id: "op-1" }, seq: 1n, writer_id: "dev-a" } as unknown as LogEntry;
  expect(sink.push(entry)).toBe(0);
  sink.push(entry, entry);
  expect(sink).toHaveLength(0);
  expect([...sink]).toEqual([]);
  // And it is still a real array, because `applyRows` takes one.
  expect(Array.isArray(sink)).toBe(true);
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
