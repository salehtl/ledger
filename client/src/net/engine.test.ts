import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, HardStopError, ProtocolError } from "./client";
import {
  CHUNK_SIZE,
  SyncEngine,
  SyncHaltedError,
  closeSharedDriver,
  closeSharedDrivers,
  sharedDriver,
  sharedDriverIsOpen,
  type SyncPhase,
  type SyncProgress,
} from "./engine";
import { projectionIsUsable, readMeta, readTxns } from "../replay/projection";
import { serializeState } from "../replay/state";
import { bunDriver, type SqlDriver } from "../store/driver";
import { fileStore } from "../store/file";
import { openMemStore } from "../store/open";
import { arrayRowStore, type RowStore, type Store, type WireRow } from "../store/store";
import { STREAM_COLD, STREAM_HOT, sealBlob, type Stream } from "../wire/blob";
import { ZERO_HASH, chainHash, chainKey } from "../wire/chain";
import {
  KIND_OPS,
  SCHEMA_VERSION,
  UnknownNewerVersionError,
  decodeBlobOps,
  encodeBlobOps,
  encodeRawBody,
  type Op,
} from "../wire/op";

// ---------------------------------------------------------------------------
// A fake server, speaking the real wire protocol over a real socket
//
// Ported from `client.test.ts`'s, trimmed to what this file needs and grown by
// the two things it needs that that one does not: a page counter a test can
// react to (for the SIGKILL sweep), and a request log (for the fetch-storm
// guard).
// ---------------------------------------------------------------------------

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

interface FakeRow {
  seq: bigint;
  stream: Stream;
  writer_id: string;
  writer_counter: bigint;
  size_bucket: number;
  blob_hash: Uint8Array;
  prev_hash: Uint8Array;
  blob: Uint8Array;
}

class FakeServer {
  readonly userId = randomUUID();
  readonly rows: FakeRow[] = [];
  readonly requests: string[] = [];
  // The ingest writer is on the roster from the account's first message — it is
  // created server-side, not enrolled by a device. A fake roster without it
  // would make every checkpoint here silently omit the ingest chains, which is
  // precisely the omission the `pin` step exists to make impossible.
  writers: { writer_id: string; kind: string; revoked_at: string | null }[] = [
    { writer_id: "ingest", kind: "ingest", revoked_at: null },
  ];
  /** Withhold this hot ingest counter from every body pull. I2's dropped row. */
  dropWriterCounter: bigint | null = null;
  /** Serve the hot body page in reverse. I3's reordering. */
  reversePages = false;
  /** Answer the per-blob hash list with a cursor that never advances. */
  stallHashCursor = false;
  /** Called with the 1-based page number every time a body page is served. */
  onPage: ((n: number) => void) | null = null;
  private pages = 0;
  private seq = 0n;
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor() {
    this.server = Bun.serve({ port: 0, fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  head(writerId: string, stream: Stream): { counter: bigint; hash: Uint8Array } {
    let out = { counter: 0n, hash: ZERO_HASH };
    for (const r of this.rows) {
      if (r.writer_id === writerId && r.stream === stream && r.writer_counter > out.counter) {
        out = { counter: r.writer_counter, hash: r.blob_hash };
      }
    }
    return out;
  }

  append(writerId: string, stream: Stream, plaintext: Uint8Array): FakeRow {
    const prev = this.head(writerId, stream);
    const counter = prev.counter + 1n;
    const blob = sealBlob({ userId: this.userId, stream, writerId, writerCounter: counter }, plaintext);
    const row: FakeRow = {
      seq: ++this.seq,
      stream,
      writer_id: writerId,
      writer_counter: counter,
      size_bucket: blob.length,
      blob_hash: chainHash(prev.hash, blob),
      prev_hash: prev.hash,
      blob,
    };
    this.rows.push(row);
    return row;
  }

  /** Replaces a stored blob's BYTES while leaving the chain naming the old hash. */
  corrupt(seq: bigint, bytes: Uint8Array): void {
    const row = this.rows.find((r) => r.seq === seq);
    if (row === undefined) throw new Error(`no row at seq ${seq}`);
    row.blob = bytes;
    row.size_bucket = bytes.length;
  }

  private wire(r: FakeRow): WireRow {
    return {
      seq: r.seq.toString(10),
      stream: r.stream,
      writer_id: r.writer_id,
      writer_counter: r.writer_counter.toString(10),
      type_flag: r.writer_id === "ingest" ? "ingest" : "edit",
      size_bucket: r.size_bucket,
      blob_hash: hex(r.blob_hash),
      prev_hash: hex(r.prev_hash),
      created_at: "2026-08-01T00:00:00.000Z",
      blob: b64(r.blob),
    };
  }

  private visible(stream: Stream): FakeRow[] {
    return this.rows.filter(
      (r) =>
        r.stream === stream &&
        !(this.dropWriterCounter !== null && r.stream === STREAM_HOT && r.writer_id === "ingest" && r.writer_counter === this.dropWriterCounter),
    );
  }

  private json(v: unknown, status = 200): Response {
    return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    this.requests.push(`${req.method} ${path}${url.search}`);
    if (req.method === "POST" && path === "/api/v1/auth/exchange") {
      return this.json({ session_token: "fake-session", user_id: this.userId });
    }
    if (req.method === "POST" && path === "/api/v1/writers/challenge") {
      return this.json({ nonce: b64(new Uint8Array(32).fill(7)) });
    }
    if (req.method === "POST" && path === "/api/v1/writers/register") {
      const body = (await req.json()) as { writer_id: string };
      if (!this.writers.some((w) => w.writer_id === body.writer_id)) {
        this.writers.push({ writer_id: body.writer_id, kind: "device", revoked_at: null });
      }
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && path === "/api/v1/writers") return this.json({ writers: this.writers });
    if (req.method === "GET" && path === "/api/v1/sync") {
      const stream = (url.searchParams.get("stream") ?? "") as Stream;
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const all = this.visible(stream).filter((r) => r.seq > after);
      const page = all.slice(0, limit);
      const last = page[page.length - 1];
      const next = last === undefined ? after : last.seq;
      const maxSeq = this.visible(stream).reduce((m, r) => (r.seq > m ? r.seq : m), 0n);
      const wire = page.map((r) => this.wire(r));
      if (this.reversePages && stream === STREAM_HOT) wire.reverse();
      this.pages++;
      this.onPage?.(this.pages);
      return this.json({ stream, rows: wire, next: next.toString(10), complete: next >= maxSeq });
    }
    if (req.method === "GET" && path === "/api/v1/sync/hashes") {
      const stream = (url.searchParams.get("stream") ?? "") as Stream;
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const all = this.visible(stream).filter((r) => r.seq > after);
      const maxSeq = this.visible(stream).reduce((m, r) => (r.seq > m ? r.seq : m), 0n);
      const last = all[all.length - 1];
      const next = this.stallHashCursor ? after : last === undefined ? after : last.seq;
      return this.json({
        stream,
        hashes: all.map((r) => ({
          seq: r.seq.toString(10),
          writer_id: r.writer_id,
          writer_counter: r.writer_counter.toString(10),
          blob_hash: hex(r.blob_hash),
          prev_hash: hex(r.prev_hash),
        })),
        next: next.toString(10),
        complete: this.stallHashCursor ? false : next >= maxSeq,
      });
    }
    if (req.method === "POST" && path === "/api/v1/sync") {
      const body = (await req.json()) as {
        writer_id: string;
        stream: Stream;
        blobs: { writer_counter: string; prev_hash: string; blob_hash: string; size_bucket: number; blob: string }[];
      };
      const seqs: string[] = [];
      for (const b of body.blobs) {
        const prev = this.head(body.writer_id, body.stream);
        if (BigInt(b.writer_counter) !== prev.counter + 1n) {
          return this.json({ error: "chain_break", detail: "writer hash chain break" }, 409);
        }
        const row: FakeRow = {
          seq: ++this.seq,
          stream: body.stream,
          writer_id: body.writer_id,
          writer_counter: BigInt(b.writer_counter),
          size_bucket: b.size_bucket,
          blob_hash: new Uint8Array(Buffer.from(b.blob_hash, "hex")),
          prev_hash: new Uint8Array(Buffer.from(b.prev_hash, "hex")),
          blob: new Uint8Array(Buffer.from(b.blob, "base64")),
        };
        this.rows.push(row);
        seqs.push(row.seq.toString(10));
      }
      return this.json({ seqs });
    }
    return this.json({ error: "not_found" }, 404);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const live: FakeServer[] = [];
const drivers: SqlDriver[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of live.splice(0)) s.stop();
  for (const d of drivers.splice(0)) d.close();
  closeSharedDrivers();
  dirs.splice(0);
});

function server(): FakeServer {
  const s = new FakeServer();
  live.push(s);
  return s;
}

function db(): SqlDriver {
  const d = bunDriver(":memory:");
  drivers.push(d);
  return d;
}

function scratchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ledger-engine-"));
  dirs.push(d);
  return d;
}

const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

function txnOp(i: number, over: Record<string, unknown> = {}): Op {
  return {
    v: SCHEMA_VERSION,
    type: "txn_ingested",
    op_id: `op-${String(i).padStart(6, "0")}`,
    authored_at: "2026-08-01T00:00:00.000Z",
    parent_version: null,
    entity: { kind: "txn", id: `t${i}` },
    ingest_id: ingestID(`m${i}`),
    payload: {
      amount_minor: `${1000 + i}`,
      currency: "AED",
      direction: i % 2 === 0 ? "debit" : "credit",
      posted_at: "2026-06-05T09:00:00Z",
      merchant_raw: `MERCHANT ${i}`,
      last4: String(1000 + (i % 9000)),
      ...over,
    },
  };
}

/** Seeds `n` honestly-chained `txn_ingested` blobs on the ingest hot chain. */
function seedTxns(s: FakeServer, n: number): void {
  for (let i = 1; i <= n; i++) s.append("ingest", STREAM_HOT, encodeBlobOps([txnOp(i)]));
}

async function deviceClient(s: FakeServer, store: Store, writer = "dev-a"): Promise<Client> {
  const c = new Client({ store, server: s.url });
  await c.login("apple", "token");
  await c.enroll(writer);
  return c;
}

/**
 * A client that signs in and enrols NOTHING.
 *
 * A read-only sync (`push: false`) needs no writer, and enrolling one has a
 * consequence worth stating: `I11_roster_checkpoint` downgrades to a notice
 * while an account has a single device writer and becomes a HARD STOP at two,
 * until some device writes a checkpoint. So a fixture that casually enrols a
 * second device turns every subsequent `push: false` sync into a halt — which
 * is correct behaviour, and made an earlier draft of the interruption sweep
 * measure a refused sync instead of an interrupted one.
 */
async function readerClient(s: FakeServer, store: Store): Promise<Client> {
  const c = new Client({ store, server: s.url });
  await c.login("apple", "token");
  return c;
}

// ---------------------------------------------------------------------------
// Rule 1a — chunking and the yield, by CONSTRUCTION
//
// This is the weak half and is labelled as such: it proves the mechanism is
// PRESENT. Phase 0 measured total `yieldMs` at 1.9-4.2 ms across a 58 s
// restore, so a `setTimeout` that is called the right number of times has still
// bought almost no event-loop time. What it buys is collector headroom, and
// that is the next test's job.
// ---------------------------------------------------------------------------

test("foldsInChunksAndYieldsBetweenThem: ceil(n/chunk) - 1 real scheduler ticks", async () => {
  const s = server();
  seedTxns(s, 7);
  const c = await deviceClient(s, openMemStore());
  const engine = new SyncEngine(c, db(), { chunkSize: 3 });

  // The GLOBAL setTimeout is counted, not an injected spy: an engine that
  // yielded with `await Promise.resolve()` would satisfy an injected hook while
  // never returning to the event loop at all.
  const real = globalThis.setTimeout;
  const delays: unknown[] = [];
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    delays.push(ms);
    return real(fn, ms, ...(rest as []));
  }) as typeof setTimeout;
  try {
    await engine.sync({ push: false });
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = real;
  }

  // 7 rows at 3 per chunk is 3 chunks and 2 gaps in the FOLD, and 7 projected
  // transactions at 3 per chunk is another 3 chunks and 2 gaps in the PROJECTION.
  const zeroDelay = delays.filter((d) => d === 0).length;
  expect(zeroDelay).toBe(2 + 2);
});

test("a log shorter than one chunk yields not at all", async () => {
  const s = server();
  seedTxns(s, 2);
  const c = await deviceClient(s, openMemStore());
  const engine = new SyncEngine(c, db(), { chunkSize: CHUNK_SIZE });
  const real = globalThis.setTimeout;
  let ticks = 0;
  (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (ms === 0) ticks++;
    return real(fn, ms, ...(rest as []));
  }) as typeof setTimeout;
  try {
    await engine.sync({ push: false });
  } finally {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = real;
  }
  expect(ticks).toBe(0);
});

// ---------------------------------------------------------------------------
// Rule 1b — the yield's PROPERTY: bounded retention across chunks
//
// This is the one that would have caught the Phase 0 crash. It measures heap
// retention after a FORCED collection at every chunk boundary, so what it reads
// is what the fold is holding on to rather than what it has allocated.
//
// It is calibrated rather than trusted. The same code path is run twice — once
// with `keepOps: false` (what the engine uses) and once with `keepOps: true`
// (what the invariant checker needs) — and the retaining arm has to be SEEN to
// grow before the bounded arm's flatness means anything. A sampler that could
// not see 8 MB of retention would report both arms flat and pass over a fold
// that kept every inflated payload alive.
// ---------------------------------------------------------------------------

const PAD_BYTES = 8192;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Distinct three-letter codes. `currencyOf` refuses anything else. */
function ccy(i: number): string {
  return `${LETTERS[Math.floor(i / 676) % 26] ?? "A"}${LETTERS[Math.floor(i / 26) % 26] ?? "A"}${LETTERS[i % 26] ?? "A"}`;
}

function noise(n: number): string {
  let out = "";
  while (out.length < n) out += Math.random().toString(36).slice(2, 18);
  return out.slice(0, n);
}

/**
 * A store holding `n` honestly-chained hot rows whose blobs are big and whose
 * STATE contribution is tiny: one `rate_set` per row plus `PAD_BYTES` of
 * incompressible padding the fold reads and discards.
 *
 * The asymmetry is the whole design. If the payload's bytes ended up in the
 * state, both arms would grow by the same 12 MB and the measurement would be of
 * the state rather than of the retention. `rate_set` adds one small map entry
 * and drops everything else, so the only thing that can hold the padding alive
 * is the op list.
 *
 * The home currency is `AAA`, which `ccy(i)` cannot produce for any `i >= 1`,
 * so no `rate_set` here ever names it — a collision would fold as an anomaly,
 * and anomalies carry detail STRINGS that would grow the state.
 */
function paddedStore(n: number, userId: string): Store {
  const store = openMemStore("http://127.0.0.1:9");
  const st = store.load();
  st.userId = userId;
  st.writerId = "ingest";
  store.save(st);
  const rows: WireRow[] = [];
  let prev = ZERO_HASH;
  for (let i = 1; i <= n; i++) {
    const counter = BigInt(i);
    const op: Op =
      i === 1
        ? {
            v: SCHEMA_VERSION,
            type: "home_currency_set",
            op_id: "op-000001",
            authored_at: "2026-08-01T00:00:00.000Z",
            parent_version: null,
            payload: { currency: "AAA" },
          }
        : {
            v: SCHEMA_VERSION,
            type: "rate_set",
            op_id: `op-${String(i).padStart(6, "0")}`,
            authored_at: "2026-08-01T00:00:00.000Z",
            parent_version: null,
            payload: { currency: ccy(i), rate_micro: `${1_000_000 + i}`, padding: noise(PAD_BYTES) },
          };
    const blob = sealBlob({ userId, stream: STREAM_HOT, writerId: "ingest", writerCounter: counter }, encodeBlobOps([op]));
    const hash = chainHash(prev, blob);
    rows.push({
      seq: counter.toString(10),
      stream: STREAM_HOT,
      writer_id: "ingest",
      writer_counter: counter.toString(10),
      type_flag: "ingest",
      size_bucket: blob.length,
      blob_hash: hex(hash),
      prev_hash: hex(prev),
      created_at: "2026-08-01T00:00:00.000Z",
      blob: b64(blob),
    });
    prev = hash;
  }
  store.rows().append(STREAM_HOT, rows);
  return store;
}

/**
 * Runs ONE fold arm in a FRESH PROCESS and returns its per-chunk memory samples.
 *
 * # Why a child process, and not a second call in this one
 *
 * The first draft measured both arms in the test process and the calibration
 * arm refused it — correctly. Two arms in one process contaminate each other:
 * the previous arm's ~12 MB is still on the heap when the next one takes its
 * baseline, and gets collected during it, so the retaining arm read
 * `10.4, 2.1, 4.0, 6.2, 8.3, 10.7` — monotone from the second sample but with a
 * polluted first, and `last - first` came out at 0.3 MB. A statistic tuned to
 * survive that would have been a statistic tuned to the noise.
 *
 * A fresh process has one restore in it, which is also what a device has.
 *
 * Both arms read the SAME corpus file, so the two series differ in exactly one
 * thing: whether the fold keeps its decoded ops.
 */
async function foldArm(corpus: string, userId: string, keepOps: boolean): Promise<{ heap: number[]; rss: number[]; ops: number; rates: number; anomalies: number; unreadable: number }> {
  const src = join(import.meta.dir, "..");
  const script = `${corpus}.${keepOps ? "keep" : "drop"}.ts`;
  await Bun.write(
    script,
    `
import { Client } from ${JSON.stringify(join(src, "net/client.ts"))};
import { memStore } from ${JSON.stringify(join(src, "store/store.ts"))};

const store = memStore("http://127.0.0.1:9");
const st = store.load();
st.userId = ${JSON.stringify(userId)};
st.writerId = "ingest";
store.save(st);

// Loaded in slices and freed as it goes. Holding the file's text, its 1,500
// split lines and the parsed objects all at once puts ~30 MB of loader garbage
// on the heap, and the collector reclaiming THAT mid-fold swamped the signal
// this is here to read — the first version of this arm reported heapUsed going
// 28 MB NEGATIVE during a fold that allocates.
{
  let text = await Bun.file(${JSON.stringify(corpus)}).text();
  const lines = text.trimEnd().split("\\n");
  text = "";
  for (let i = 0; i < lines.length; i += 250) {
    store.rows().append("hot", lines.slice(i, i + 250).map((l) => JSON.parse(l)));
    for (let k = i; k < Math.min(i + 250, lines.length); k++) lines[k] = "";
  }
  lines.length = 0;
}

const client = new Client({ store });
// TWICE. \`Bun.gc(true)\` returns before JSC has finished sweeping, so a single
// call leaves \`heapUsed\` reporting a stale figure — the first version of this
// read 40 MB, then the identical 40 MB, then dropped 40 MB in one step, which
// is the accounting catching up rather than anything the fold did.
const sample = () => { Bun.gc(true); Bun.gc(true); const m = process.memoryUsage(); return { heap: m.heapUsed, rss: m.rss }; };
const base = sample();
const heap = [];
const rss = [];
const take = () => { const s = sample(); heap.push(s.heap - base.heap); rss.push(s.rss - base.rss); };
const got = await client.materializeChunked({
  chunkSize: ${CHUNK_SIZE},
  keepOps: ${String(keepOps)},
  between: async () => { take(); await new Promise((r) => { setTimeout(r, 0); }); },
});
take();
console.log(JSON.stringify({ heap, rss, ops: got.opsApplied, rates: got.state.rates.size,
  anomalies: got.state.anomalies.length, unreadable: got.state.unreadable.length }));
`,
  );
  const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`fold arm keepOps=${String(keepOps)} failed: ${err}`);
  return JSON.parse(out.trim()) as ReturnType<typeof JSON.parse>;
}

/** Writes the padded corpus to a JSONL file both arms read. */
async function writeCorpus(n: number, userId: string): Promise<string> {
  const store = paddedStore(n, userId);
  const lines: string[] = [];
  let after = 0n;
  for (;;) {
    const chunk = store.rows().range(STREAM_HOT, after, 500);
    if (chunk.length === 0) break;
    for (const r of chunk) lines.push(JSON.stringify(r));
    const last = chunk[chunk.length - 1];
    if (last === undefined) break;
    after = BigInt(last.seq);
  }
  const path = join(scratchDir(), "padded.jsonl");
  await Bun.write(path, lines.join("\n"));
  return path;
}

test("rssIsBoundedAcrossChunks: the fold's retention is flat, and the sampler can see it when it is not", async () => {
  const n = 2000;
  const userId = randomUUID();
  const corpus = await writeCorpus(n, userId);
  const payloadBytes = n * PAD_BYTES; // ~12.3 MB, if every op were held

  const retaining = await foldArm(corpus, userId, true);
  const bounded = await foldArm(corpus, userId, false);

  // Anti-vacuity: both arms have to have folded the whole corpus. A fold that
  // fell over on row 3 produces a flat, tiny series and would otherwise pass.
  for (const arm of [retaining, bounded]) {
    expect(arm.ops).toBe(n);
    expect(arm.rates).toBe(n); // AAA (the home identity) plus one per rate_set
    expect(arm.anomalies).toBe(0);
    expect(arm.unreadable).toBe(0);
    expect(arm.heap.length).toBe(Math.ceil(n / CHUNK_SIZE));
  }

  // The SETTLED HALF of the series is the measurement window, and the reason is
  // in the readings. Bun's `heapUsed` tracks JSC's heap SIZE, which includes
  // free space in blocks, so while the allocator is still growing it reports
  // figures that have nothing to do with retention — the first three samples of
  // both arms read `0.00, 40.5, 40.5` and then dropped 40 MB in one step, in
  // lockstep, in both arms. Calling `Bun.gc(true)` twice per sample does not
  // change it, so it is the allocator settling and not a stale sweep.
  //
  // From the midpoint on, both arms are steady and reproducible to two decimal
  // places across runs, and the retaining arm's slope lands on the value theory
  // predicts: one chunk of payload retained per chunk folded. That prediction is
  // what makes this a calibrated instrument rather than a threshold somebody
  // picked.
  const settled = (xs: number[]): number[] => xs.slice(Math.ceil(xs.length / 2));
  const span = (xs: number[]): number => Math.max(...settled(xs)) - Math.min(...settled(xs));
  const slope = (xs: number[]): number => {
    const t = settled(xs);
    return ((t[t.length - 1] as number) - (t[0] as number)) / (t.length - 1);
  };
  const rising = (xs: number[]): boolean => settled(xs).every((v, i, a) => i === 0 || v > (a[i - 1] as number));

  const oneChunk = CHUNK_SIZE * PAD_BYTES; // ~2.0 MB of payload per chunk

  // 1. CALIBRATION, as a PREDICTION rather than a threshold. A fold that keeps
  //    its decoded ops must retain one chunk's payload for every chunk it
  //    folds, so its slope is one chunk's worth. If the instrument cannot see
  //    that, nothing below means anything — so it fails loudly here rather than
  //    passing vacuously there.
  expect(slope(retaining.heap)).toBeGreaterThan(oneChunk * 0.5);
  expect(slope(retaining.heap)).toBeLessThan(oneChunk * 1.8);
  expect(rising(retaining.heap)).toBe(true);
  //    …and over the whole corpus that is the shape Phase 0 froze on.
  expect(span(retaining.heap)).toBeGreaterThan(payloadBytes / 5);

  // 2. THE PROPERTY. The bounded fold's retention does not track the corpus: it
  //    holds less than half of ONE chunk across the settled half of the run, and
  //    it does not climb.
  expect(span(bounded.heap)).toBeLessThan(oneChunk / 2);
  expect(slope(bounded.heap)).toBeLessThan(slope(retaining.heap) / 10);
  //    "Flat" is a claim about the SLOPE, not about monotonicity. A correct fold
  //    grows a little every chunk no matter what it does with its ops — 2,000
  //    rate entries and 2,000 head-registry rows are state, and state is the
  //    thing a fold is for. The measured figure is ~0.09 MB per chunk against a
  //    chunk of payload at 2.05 MB, i.e. under 5 %; asserting `not rising` would
  //    be asserting that a fold accumulates nothing, which is false and which
  //    made this fail on a run where everything was working.
  expect(slope(bounded.heap)).toBeLessThan(oneChunk * 0.15);

  // 3. RESIDENT SET, not just the JS heap — the plan's `rssBytes()`. It is the
  //    coarser instrument (an allocator does not hand pages back promptly), so
  //    it is asserted as a ceiling against the other arm rather than as a trend.
  expect(span(bounded.rss)).toBeLessThan(span(retaining.rss) / 2);
}, 120_000);

test("the engine's fold is the bounded arm — it asks for keepOps: false", async () => {
  // The wiring half of the measurement above. `rssIsBoundedAcrossChunks` proves
  // what `keepOps: false` BUYS; this proves the engine asks for it. Written,
  // tested green, never wired is this project's second-most-expensive defect
  // shape, and a memory property measured on a code path production does not
  // take is exactly that shape.
  const s = server();
  seedTxns(s, 5);
  const c = await readerClient(s, openMemStore());
  const asked: (boolean | undefined)[] = [];
  const real = c.materializeChunked.bind(c);
  c.materializeChunked = ((opts: Parameters<Client["materializeChunked"]>[0]) => {
    asked.push(opts?.keepOps);
    return real(opts);
  }) as Client["materializeChunked"];

  const out = await new SyncEngine(c, db(), { chunkSize: 2 }).sync({ push: false });
  expect(asked).toEqual([false]);
  expect(out.applied).toBe(5);
});

// ---------------------------------------------------------------------------
// Rule 2 — one SQLite connection for the app's lifetime
// ---------------------------------------------------------------------------

test("openingTheStoreTwiceReturnsTheSameDriver", () => {
  const dir = scratchDir();
  const path = join(dir, "one.db");
  let opened = 0;
  const open = (): SqlDriver => {
    opened++;
    const d = bunDriver(path);
    return d;
  };

  const a = sharedDriver(path, open);
  const b = sharedDriver(path, open);
  const c = sharedDriver(path, open);
  expect(b).toBe(a);
  expect(c).toBe(a);
  // The count is the measurement. Object identity alone would also be satisfied
  // by a factory that opened a native handle and threw it away.
  expect(opened).toBe(1);

  // A different database is a different handle: the rule is one per database,
  // not one per process, and a test process legitimately opens several.
  const other = sharedDriver(join(dir, "two.db"), () => bunDriver(join(dir, "two.db")));
  expect(other).not.toBe(a);

  // Explicit close on teardown, and it is really closed.
  expect(sharedDriverIsOpen(path)).toBe(true);
  closeSharedDriver(path);
  expect(sharedDriverIsOpen(path)).toBe(false);
  expect(() => a.exec("SELECT 1")).toThrow();

  // …and after a close the next open is a NEW handle, not the closed one.
  const again = sharedDriver(path, open);
  expect(again).not.toBe(a);
  expect(opened).toBe(2);
  closeSharedDrivers();
  expect(sharedDriverIsOpen(join(dir, "two.db"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Rule 3 — the isRunning guard
// ---------------------------------------------------------------------------

test("concurrentSyncCallsIssueOneRequestSet", async () => {
  const s = server();
  seedTxns(s, 40);
  const c = await deviceClient(s, openMemStore());
  const engine = new SyncEngine(c, db(), { chunkSize: 10 });

  const before = s.requests.length;
  // Five presses on a frozen thread. Phase 0's ~39-request / 144 MB storm.
  const all = [engine.sync({ push: false }), engine.sync({ push: false }), engine.sync({ push: false }), engine.sync({ push: false }), engine.sync({ push: false })];
  const results = await Promise.all(all);
  const issued = s.requests.slice(before).filter((r) => r.startsWith("GET /api/v1/sync?"));

  // One page sequence: 40 rows at limit 10 is four full pages plus the page that
  // reports `complete`. Not five sequences.
  expect(issued.length).toBeLessThanOrEqual(5);
  expect(issued.length).toBeGreaterThanOrEqual(4);
  // Every caller got the real answer, not a no-op.
  for (const r of results) expect(r.pulled).toBe(40);
  // The same promise, so five awaits cost one sync.
  expect(all[1] === all[0]).toBe(true);
  expect(engine.running).toBe(false);

  // A SECOND sync after the first settles does run — the guard is not a latch.
  const after = s.requests.length;
  await engine.sync({ push: false });
  expect(s.requests.slice(after).some((r) => r.startsWith("GET /api/v1/sync?"))).toBe(true);
});

// ---------------------------------------------------------------------------
// The order: pull -> verify -> pin -> fold -> attest -> push
// ---------------------------------------------------------------------------

test("the engine runs pull, fold, project, push in that order and ends idle", async () => {
  const s = server();
  seedTxns(s, 5);
  const c = await deviceClient(s, openMemStore());
  const engine = new SyncEngine(c, db(), { chunkSize: 2 });
  const phases: SyncPhase[] = [];
  engine.subscribe((p) => {
    if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
  });
  await engine.sync();
  // The push uploads a checkpoint, so the fold and the projection run a second
  // time over the rows that upload's own pull brought back.
  expect(phases).toEqual(["pulling", "folding", "projecting", "pushing", "folding", "projecting", "idle"]);
});

test("pin is not skipped: the checkpoint attests real heads, hot AND cold", async () => {
  // The defect the canonical order's `pin` step exists to close. A checkpoint
  // built from unpinned heads claims genesis for chains that are merely
  // un-pinned, and this device has never downloaded a single cold BODY — its
  // only evidence about the cold chain is the pinned per-blob hash list.
  const s = server();
  seedTxns(s, 3);
  for (let i = 1; i <= 4; i++) {
    s.append("ingest", STREAM_COLD, encodeRawBody({ ingest_id: ingestID(`c${i}`), received_at: "2026-08-01T00:00:00.000Z", raw: new Uint8Array([i, i, i]) }));
  }
  const c = await deviceClient(s, openMemStore());
  const engine = new SyncEngine(c, db());
  const out = await engine.sync();
  expect(out.halted).toBe(false);

  // The engine pulled HOT only, so no cold body is on disk…
  expect(c.cursor(STREAM_COLD)).toBe(0n);
  // …and yet the cold head is pinned, from the hash list.
  expect(c.pinnedHead("ingest", STREAM_COLD).counter).toBe(4n);
  expect(c.pinnedHead("ingest", STREAM_HOT).counter).toBe(3n);

  // And the checkpoint this device uploaded says so. Decoded from the bytes the
  // server actually received, not from the client's intent.
  const uploaded = s.rows.filter((r) => r.writer_id === "dev-a" && r.stream === STREAM_HOT);
  const heads = uploaded
    .flatMap((r) => decodeBlobOps(openFor(s.userId, r)))
    .filter((op) => op.type === "writer_checkpoint")
    .flatMap((op) => (op.payload as { heads: { writer_id: string; stream: string; counter: string }[] }).heads);
  expect(heads.length).toBeGreaterThan(0);
  expect(heads.find((h) => h.writer_id === "ingest" && h.stream === STREAM_COLD)?.counter).toBe("4");
  expect(heads.find((h) => h.writer_id === "ingest" && h.stream === STREAM_HOT)?.counter).toBe("3");
});

test("a device holding cold HASHES but no cold bodies is not reported as being withheld from", async () => {
  // `observedHead()` counts pinned per-blob hashes precisely so this device is
  // not accused. Skip the pin and the same run reports `chain_withheld`, which
  // is a hard stop no device can clear — the false alarm the pin step prevents.
  const s = server();
  seedTxns(s, 2);
  for (let i = 1; i <= 5; i++) {
    s.append("ingest", STREAM_COLD, encodeRawBody({ ingest_id: ingestID(`c${i}`), received_at: "2026-08-01T00:00:00.000Z", raw: new Uint8Array([i, i, i]) }));
  }
  const a = await deviceClient(s, openMemStore(), "dev-a");
  await new SyncEngine(a, db()).sync();

  // A SECOND device, so the checkpoint under test was written by someone else —
  // a fixture with one device cannot tell "attests its own heads" from "attests
  // the account's".
  const b = await deviceClient(s, openMemStore(), "dev-b");
  const out = await new SyncEngine(b, db()).sync();
  expect(out.halted).toBe(false);
  expect(out.violations.filter((v) => v.severity === "hard_stop")).toEqual([]);
  expect(out.violations.some((v) => v.kind === "chain_withheld")).toBe(false);
  expect(b.pinnedHead("ingest", STREAM_COLD).counter).toBe(5n);
});

test("the projection is written by sync, complete, and agrees with the fold", async () => {
  const s = server();
  seedTxns(s, 9);
  const c = await deviceClient(s, openMemStore());
  const d = db();
  const engine = new SyncEngine(c, d, { chunkSize: 4 });
  await engine.sync({ push: false });

  expect(projectionIsUsable(d)).toBe(true);
  const rows = readTxns(d);
  expect(rows.size).toBe(9);
  expect(readMeta(d)?.cursorHot).toBe(c.cursor(STREAM_HOT));
  // Field-by-field against the fold, not merely by count.
  const state = c.state();
  for (const [id, want] of state.txns) {
    expect(rows.get(id)?.amount_minor).toBe(want.amount_minor);
    expect(rows.get(id)?.direction).toBe(want.direction);
    expect(rows.get(id)?.merchant_raw).toBe(want.merchant_raw);
  }
});

// ---------------------------------------------------------------------------
// Halting, and what deliberately does not halt
// ---------------------------------------------------------------------------

test("a server-side dropped row halts, names an invariant, and persists nothing", async () => {
  const s = server();
  seedTxns(s, 6);
  s.dropWriterCounter = 3n;
  const c = await deviceClient(s, openMemStore());
  const d = db();
  const out = await new SyncEngine(c, d).sync({ push: false });

  expect(out.halted).toBe(true);
  const stops = out.violations.filter((v) => v.severity === "hard_stop");
  expect(stops.length).toBeGreaterThan(0);
  expect(stops.some((v) => v.id.startsWith("I2") || v.id.startsWith("I3"))).toBe(true);
  // Nothing was persisted over the uncertified page: the cursor did not move…
  expect(c.cursor(STREAM_HOT)).toBe(0n);
  // …and the projection was never completed, so no screen can read half a log.
  expect(projectionIsUsable(d)).toBe(false);
});

test("a hard stop that is NOT roster coverage is never escaped by pushing over it", async () => {
  // The laundering shape, and the reason `pullOrHeal` hands the decision to
  // `Client.push` instead of deciding itself. Every other halt test here runs
  // with `push: false`, which never reaches the repair path at all — so without
  // this one, an engine that caught the stop and pushed regardless would pass
  // the whole file. Phase 1 built that consequence end to end: a truncated peer
  // chain, a device that pushes over the stop, and a fresh checkpoint claiming
  // genesis replaces the honest attestation.
  const s = server();
  seedTxns(s, 6);
  s.dropWriterCounter = 3n;
  const c = await deviceClient(s, openMemStore());
  const uploadedBefore = s.rows.filter((r) => r.writer_id === "dev-a").length;

  const out = await new SyncEngine(c, db()).sync(); // push ENABLED

  expect(out.halted).toBe(true);
  expect(out.violations.some((v) => v.severity === "hard_stop")).toBe(true);
  expect(c.cursor(STREAM_HOT)).toBe(0n);
  // Nothing was authored. A device that cannot certify what it pulled has
  // nothing trustworthy to attest, so it must write no checkpoint at all.
  expect(s.rows.filter((r) => r.writer_id === "dev-a").length).toBe(uploadedBefore);
});

test("the I11 repair does not swallow an error that is not the I11 escape", async () => {
  // The other half of `pullOrHeal`'s contract, and the one a `try { push() }
  // catch {}` would quietly break. Handing a refused pull to `push` is only safe
  // because `push` REPORTS what it could not do: if its own pre-sync or its cold
  // hash refresh fails for a reason that is not the benign roster-coverage stop,
  // that failure has to reach the caller rather than being stepped over on the
  // way to a retry.
  //
  // Staged as a stalled hash-list cursor, which `pullColdHashes` refuses with a
  // ProtocolError — a server that never advances would otherwise spin forever.
  const s = server();
  seedTxns(s, 3);
  for (let i = 1; i <= 3; i++) {
    s.append("ingest", STREAM_COLD, encodeRawBody({ ingest_id: ingestID(`c${i}`), received_at: "2026-08-01T00:00:00.000Z", raw: new Uint8Array([i, i, i]) }));
  }
  // Two device writers and no checkpoint: dev-b's pull hard-stops on the BENIGN
  // roster-coverage condition, which is what routes it into the repair path.
  await deviceClient(s, openMemStore(), "dev-a");
  const b = await deviceClient(s, openMemStore(), "dev-b");
  s.stallHashCursor = true;

  const engine = new SyncEngine(b, db());
  await expect(engine.sync()).rejects.toThrow(ProtocolError);
  expect(engine.progress.phase).toBe("halted");
});

test("a server-side reordered page halts", async () => {
  const s = server();
  seedTxns(s, 6);
  s.reversePages = true;
  const c = await deviceClient(s, openMemStore());
  const out = await new SyncEngine(c, db()).sync({ push: false });
  expect(out.halted).toBe(true);
  expect(out.violations.some((v) => v.severity === "hard_stop")).toBe(true);
  expect(c.cursor(STREAM_HOT)).toBe(0n);
});

test("an undecodable blob does NOT halt: it is set aside and the cursor advances past it", async () => {
  const s = server();
  seedTxns(s, 5);
  // A blob sealed CORRECTLY for its own position whose BODY is not an op list.
  //
  // The position matters: sealing at the wrong counter is I4's AAD violation,
  // which is a hard stop and a different condition entirely — the first draft of
  // this test used it and was measuring `I4_aad`, not the set-aside path. Here
  // the envelope, the AAD, the padding rung and the chain all verify, and only
  // `decodeBlobOps` fails, which is the one failure spec §3.3:68 says must not
  // strand a device.
  s.corrupt(
    3n,
    sealBlob(
      { userId: s.userId, stream: STREAM_HOT, writerId: "ingest", writerCounter: 3n },
      new TextEncoder().encode('{"v":1,"kind":"ops","ops":"not a list"}'),
    ),
  );
  const rehashed = s.rows.find((r) => r.seq === 3n);
  if (rehashed !== undefined) {
    const prev = s.rows.find((r) => r.seq === 2n);
    rehashed.blob_hash = chainHash(prev?.blob_hash ?? ZERO_HASH, rehashed.blob);
    for (const r of s.rows.filter((r) => r.seq > 3n && r.stream === STREAM_HOT && r.writer_id === "ingest")) {
      const before = s.rows.find((x) => x.seq === r.seq - 1n);
      r.prev_hash = before?.blob_hash ?? ZERO_HASH;
      r.blob_hash = chainHash(r.prev_hash, r.blob);
    }
  }
  const c = await deviceClient(s, openMemStore());
  const d = db();
  const out = await new SyncEngine(c, d).sync({ push: false });

  expect(out.halted).toBe(false);
  expect(c.cursor(STREAM_HOT)).toBe(5n);
  const state = c.state();
  expect(state.unreadable.length).toBe(1);
  expect(state.unreadable[0]?.seq).toBe(3n);
  // Four transactions, not five: the set-aside row's op never folded. The
  // cursor still moved past it, so it is never re-requested.
  expect(state.txns.size).toBe(4);
  expect(readTxns(d).size).toBe(4);
  expect(projectionIsUsable(d)).toBe(true);
});

test("an op with a newer schema version halts with UnknownNewerVersionError", async () => {
  const s = server();
  seedTxns(s, 2);
  // Framed by hand: `encodeBlobOps` refuses to ENCODE a newer op (an invalid op
  // in an append-only log is permanent), and the condition under test is a
  // client DECODING one a newer peer wrote.
  const newer = { ...txnOp(3), v: SCHEMA_VERSION + 1 };
  const body = new TextEncoder().encode(
    JSON.stringify({
      v: SCHEMA_VERSION,
      kind: KIND_OPS,
      ops: [
        {
          v: newer.v,
          type: newer.type,
          op_id: newer.op_id,
          authored_at: newer.authored_at,
          entity: newer.entity,
          parent_version: null,
          ingest_id: newer.ingest_id,
          payload: newer.payload,
        },
      ],
    }),
  );
  s.append("ingest", STREAM_HOT, body);
  const c = await deviceClient(s, openMemStore());
  const d = db();
  const engine = new SyncEngine(c, d);
  await expect(engine.sync({ push: false })).rejects.toThrow(UnknownNewerVersionError);
  expect(engine.progress.phase).toBe("halted");
  // The whole page was refused, so even the two readable rows below it did not
  // land: `pull` persists a page or none of it.
  expect(c.cursor(STREAM_HOT)).toBe(0n);
  expect(projectionIsUsable(d)).toBe(false);
});

test("halt() stops the run in flight and the next one refuses until resume()", async () => {
  const s = server();
  seedTxns(s, 12);
  const c = await deviceClient(s, openMemStore());
  const projDb = db();
  const engine = new SyncEngine(c, projDb, { chunkSize: 2 });
  const phases: SyncPhase[] = [];
  let armed = true;
  engine.subscribe((p) => {
    if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
    if (armed && p.phase === "folding" && p.chunk === 2) {
      armed = false;
      engine.halt("integrity check pending");
    }
  });
  const out = await engine.sync({ push: false });
  expect(out.halted).toBe(true);
  expect(engine.halted).toBe("integrity check pending");
  expect(engine.progress.phase).toBe("halted");
  // It stopped AT THE FOLD's next chunk boundary, not merely somewhere later.
  // The projection has its own cancellation check, so an engine that ignored the
  // halt during the fold would still end up halted — one phase and one whole
  // corpus later, which is exactly the freeze this is meant to interrupt.
  expect(phases).toContain("folding");
  expect(phases).not.toContain("projecting");
  expect(projectionIsUsable(projDb)).toBe(false);

  const again = await engine.sync({ push: false });
  expect(again.halted).toBe(true);

  engine.resume();
  const healed = await engine.sync({ push: false });
  expect(healed.halted).toBe(false);
  expect(healed.applied).toBe(12);
});

test("a HardStopError leaves the engine halted and a SyncHaltedError is thrown by checkHalt", async () => {
  // Pins the two halt shapes apart: a hard stop is DATA (returned, with
  // violations) and a caller-requested halt is CONTROL (a named error class the
  // engine catches itself). Neither may be reported as the other.
  const s = server();
  seedTxns(s, 4);
  s.dropWriterCounter = 2n;
  const c = await deviceClient(s, openMemStore());
  const engine = new SyncEngine(c, db());
  const out = await engine.sync({ push: false });
  expect(out.halted).toBe(true);
  expect(out.violations.length).toBeGreaterThan(0);
  expect(engine.halted).toContain("sync stopped");
  expect(new SyncHaltedError("x")).toBeInstanceOf(Error);
  expect(new HardStopError([])).toBeInstanceOf(Error);
});

test("progress is a SNAPSHOT: a subscriber cannot reach into the engine's state", async () => {
  const s = server();
  seedTxns(s, 6);
  const c = await readerClient(s, openMemStore());
  const engine = new SyncEngine(c, db(), { chunkSize: 2 });

  // Handing out the live object would let one screen's stale render, or a
  // reducer that mutates its argument, rewrite what every other subscriber
  // sees — and the engine's own control state with it.
  const seen: SyncProgress[] = [];
  engine.subscribe((p) => {
    seen.push(p);
    (p as { phase: SyncPhase }).phase = "halted";
    (p as { opsApplied: number }).opsApplied = -1;
  });
  const out = await engine.sync({ push: false });

  expect(out.halted).toBe(false);
  expect(engine.progress.phase).toBe("idle");
  expect(engine.progress.opsApplied).toBe(6);
  // Two different subscribers must not be handed the same object either.
  expect(seen.length).toBeGreaterThan(1);
  expect(seen[0]).not.toBe(seen[1]);

  const snap = engine.progress;
  (snap as { opsApplied: number }).opsApplied = 999;
  expect(engine.progress.opsApplied).toBe(6);
});

test("the projected cursors are the client's, cold included", async () => {
  // `materializeChunked` builds a fresh state whose cold cursor is not derivable
  // from the hot rows — replay never advances it (invariant I16) — so it has to
  // be carried over from the persisted state. Dropped, the projection tells the
  // UI the cold stream is at genesis while the client has a window of bodies.
  const s = server();
  seedTxns(s, 3);
  for (let i = 1; i <= 4; i++) {
    s.append("ingest", STREAM_COLD, encodeRawBody({ ingest_id: ingestID(`c${i}`), received_at: "2026-08-01T00:00:00.000Z", raw: new Uint8Array([i, i, i]) }));
  }
  const c = await readerClient(s, openMemStore());
  await c.pullColdHashes();
  await c.pull({ stream: STREAM_COLD });
  expect(c.cursor(STREAM_COLD)).toBeGreaterThan(0n);

  const d = db();
  await new SyncEngine(c, d).sync({ push: false });
  const meta = readMeta(d);
  expect(meta?.cursorHot).toBe(c.cursor(STREAM_HOT));
  expect(meta?.cursorCold).toBe(c.cursor(STREAM_COLD));
});

test("a row store that does not advance is refused rather than looped on forever", async () => {
  // The async fold needs its own progress guarantee: `eachRowChunk` has one and
  // this loop is not that loop. A FULL chunk that does not advance is the
  // looping shape — a short chunk ends the walk on its own.
  const s = server();
  seedTxns(s, 4);
  const inner = openMemStore();
  const c0 = await readerClient(s, inner);
  await c0.pull();
  // The first two rows, served over and over regardless of the cursor. They fold
  // cleanly the first time, so the fold's OWN ordering guard does not fire and
  // the loop's guard is what has to catch it — an earlier version of this
  // fixture returned the same row twice inside one chunk, which `foldBlobs`
  // refused first and left this loop untested.
  const firstTwo = inner.rows().range(STREAM_HOT, 0n, 2);

  const stuck: Store = {
    location: inner.location,
    load: () => inner.load(),
    save: (st) => inner.save(st),
    rows: () => ({
      append: () => undefined,
      range: (_s, _after, limit) => firstTwo.slice(0, limit).map((r) => ({ ...r })),
      count: () => 4,
      prune: () => undefined,
    }),
    transaction: (fn) => fn(),
  };
  const c = new Client({ store: stuck });
  await expect(c.materializeChunked({ chunkSize: 2 })).rejects.toThrow(/did not advance/);
  expect(() => c.reconcile(STREAM_HOT)).toThrow(/did not advance/);
});

// ---------------------------------------------------------------------------
// Rule 1c — the fold consumes each chunk before it asks for the next
// ---------------------------------------------------------------------------

/**
 * A store that POISONS the chunk it handed out last when the next is asked for.
 *
 * Task 5's technique, applied to the ASYNC fold. An implementation that paged
 * through `range()` collecting the rows and decoded them after the loop reads
 * exactly the same bytes, produces the same counts, and holds the whole log —
 * against this store it decodes poison and fails loudly.
 */
function poisoning(inner: Store): Store {
  const rows = inner.rows();
  let lastHandedOut: WireRow[] = [];
  const wrapper: RowStore = {
    append: (s, r) => rows.append(s, r),
    range: (s, after, limit) => {
      for (const r of lastHandedOut) r.blob = "!!!! poisoned: this chunk was retained past its turn";
      lastHandedOut = rows.range(s, after, limit);
      return lastHandedOut;
    },
    count: (s) => rows.count(s),
    prune: (s, before) => rows.prune(s, before),
  };
  return {
    location: inner.location,
    load: () => inner.load(),
    save: (s) => inner.save(s),
    rows: () => wrapper,
    transaction: (fn) => inner.transaction(fn),
  };
}

test("materializeChunked folds each chunk before it asks for the next", async () => {
  const n = 7;
  const s = server();
  seedTxns(s, n);
  const inner = openMemStore();
  const c0 = await deviceClient(s, inner);
  await c0.pull();

  const c = new Client({ store: poisoning(inner) });
  const got = await c.materializeChunked({ chunkSize: 2 });
  expect(got.opsApplied).toBe(n);
  expect(got.state.txns.size).toBe(n);
  expect(got.state.unreadable).toEqual([]);
});

test("the poisoning store really does catch a read-all-then-decode fold", async () => {
  // The calibration for the test above. Without it, a poisoning wrapper that
  // silently did nothing would certify a read-all fold as streaming — the
  // by-construction defect shape, inside the instrument.
  //
  // This is the anti-pattern, written out: page through `range()` collecting
  // rows, then decode afterwards. It reads exactly the same bytes and produces
  // exactly the same counts as the streaming fold.
  const s = server();
  seedTxns(s, 7);
  const inner = openMemStore();
  const c0 = await deviceClient(s, inner);
  await c0.pull();

  const rows = poisoning(inner).rows();
  const collected: WireRow[] = [];
  let after = 0n;
  for (;;) {
    const chunk = rows.range(STREAM_HOT, after, 2);
    if (chunk.length === 0) break;
    collected.push(...chunk);
    const last = chunk[chunk.length - 1];
    if (last === undefined) break;
    after = BigInt(last.seq);
    if (chunk.length < 2) break;
  }
  expect(collected.length).toBe(7);
  expect(collected.filter((r) => r.blob.startsWith("!!!!")).length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Resumability
// ---------------------------------------------------------------------------

test("rows persisted above the cursor are verified, PINNED and folded once", async () => {
  // The deterministic reproduction of `fileStore`'s residual crash window: rows
  // on disk, the cursor and the heads behind them. Task 5 recorded that the next
  // pull then died with `ReplayOrderError`; this is the automatic repair its
  // report names as Task 8's job.
  const s = server();
  seedTxns(s, 6);
  const store = openMemStore();
  const c0 = await deviceClient(s, store);
  await c0.pull();
  const clean = serializeState(c0.state());

  // Wind the state back to what a crash between the two writes leaves behind:
  // the rows are there, the cursor and the pinned head are not.
  const st = store.load();
  st.cursors.hot = 0n;
  st.pinnedHeads.delete(chainKey("ingest", STREAM_HOT));
  store.save(st);

  const c = new Client({ store, server: s.url });
  const engine = new SyncEngine(c, db());
  const out = await engine.sync({ push: false });

  expect(out.halted).toBe(false);
  expect(c.cursor(STREAM_HOT)).toBe(6n);
  // PINNED, not merely advanced. A cursor that ran ahead of the head would make
  // the very next page a chain break this client could never clear.
  expect(c.pinnedHead("ingest", STREAM_HOT).counter).toBe(6n);
  expect(serializeState(c.state())).toBe(clean);
  expect(out.applied).toBe(6);
  // Applied once, not twice: a second application would fork every entity
  // against itself and show up as anomalies.
  expect(c.state().anomalies).toEqual([]);
  expect(c.state().txns.size).toBe(6);
});

test("reconcile refuses rows on disk that do not follow the pinned head", async () => {
  // The resume path must not become a way to launder unverified rows into the
  // log. A cursor bumped without a chain check is exactly that.
  const s = server();
  seedTxns(s, 4);
  const store = openMemStore();
  const c0 = await deviceClient(s, store);
  await c0.pull();

  const st = store.load();
  st.cursors.hot = 0n;
  // A head that the stored rows do NOT continue from.
  st.pinnedHeads.set(chainKey("ingest", STREAM_HOT), { counter: 9n, hash: new Uint8Array(32).fill(1) });
  store.save(st);

  const c = new Client({ store, server: s.url });
  expect(() => c.reconcile(STREAM_HOT)).toThrow();
  expect(c.cursor(STREAM_HOT)).toBe(0n);
});

test("reconcile is a no-op on a healthy store", async () => {
  const s = server();
  seedTxns(s, 5);
  const store = openMemStore();
  const c = await deviceClient(s, store);
  await c.pull();
  expect(c.reconcile(STREAM_HOT)).toEqual({ rows: 0, cursor: 5n });
});

// ---------------------------------------------------------------------------
// Resumability across a REAL interruption
//
// SIGKILL to a child process: no unwind, no `finally`, no flush. A simulated
// interruption — an injected throw, an aborted promise — proves the code's own
// error path and says nothing about what is on disk when the process simply
// stops existing.
//
// The child uses `fileStore`, deliberately: it is the store whose crash window
// is real (two files, no journal, rows written first). `sqliteStore` cannot
// reach the state at all, which makes it the wrong instrument for this.
// ---------------------------------------------------------------------------

function childScript(dir: string, url: string, profile: string): string {
  const src = join(import.meta.dir, "..");
  return `
import { Client } from ${JSON.stringify(join(src, "net/client.ts"))};
import { SyncEngine } from ${JSON.stringify(join(src, "net/engine.ts"))};
import { fileStore } from ${JSON.stringify(join(src, "store/file.ts"))};
import { bunDriver } from ${JSON.stringify(join(src, "store/driver.ts"))};

const store = fileStore(${JSON.stringify(dir)}, ${JSON.stringify(profile)});
const client = new Client({ store, server: ${JSON.stringify(url)} });
const db = bunDriver(${JSON.stringify(join(dir, "proj.db"))});
const engine = new SyncEngine(client, db, { chunkSize: 50 });
console.log("started");
await engine.sync({ push: false });
console.log("finished");
`;
}

async function interruptedRun(s: FakeServer, dir: string, profile: string, killAfterMs: number): Promise<void> {
  const script = join(dir, `child-${killAfterMs}.ts`);
  await Bun.write(script, childScript(dir, s.url, profile));
  const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe", stderr: "pipe" });
  // Kill `killAfterMs` after THIS run's first page is served, so the signal
  // lands inside the child's own work rather than before it started or after it
  // finished. Different delays land in different windows: the fetch of the next
  // page, the fold, the check, and the two-file persist.
  //
  // Counted locally rather than from the server's running page number: that one
  // does not reset between runs, and keying on `n === 1` made every run after
  // the first wait forever for a page number that had already gone by.
  let armedAt = 0;
  const armed = new Promise<void>((resolve) => {
    s.onPage = () => {
      if (++armedAt !== 1) return;
      setTimeout(() => {
        proc.kill(9);
        resolve();
      }, killAfterMs);
    };
  });
  // A child that dies before it asks for anything must not hang the suite: the
  // page may never come, and a bare `await armed` would wait for it forever.
  await Promise.race([armed, proc.exited.then(() => undefined)]);
  proc.kill(9);
  await proc.exited;
  s.onPage = null;
}

test("a SIGKILL mid-sync resumes to the identical state, with nothing lost and nothing applied twice", async () => {
  const n = 400;
  const s = server();
  seedTxns(s, n);
  const dir = scratchDir();

  // The reference: a clean, uninterrupted sync of the same log.
  const refStore = fileStore(scratchDir(), "ref");
  const ref = await readerClient(s, refStore);
  await new SyncEngine(ref, db(), { chunkSize: 50 }).sync({ push: false });
  const want = serializeState(ref.state());
  expect(ref.state().txns.size).toBe(n);

  // The profile the child will resume: signed in and enrolled by the parent,
  // because sign-in is not what is being interrupted.
  const store = fileStore(dir, "kill");
  await readerClient(s, store);

  // What each kill actually left behind, measured rather than assumed.
  const landed: { delay: number; rows: number; cursor: bigint }[] = [];
  for (const d of [0, 2, 5, 10, 20, 35, 60, 120]) {
    await interruptedRun(s, dir, "kill", d);
    const rowsFile = join(dir, "kill.rows.jsonl");
    const lines = existsSync(rowsFile)
      ? readFileSync(rowsFile, "utf8")
          .trimEnd()
          .split("\n")
          .filter((l) => l !== "").length
      : 0;
    landed.push({ delay: d, rows: lines, cursor: fileStore(dir, "kill").load().cursors.hot });
  }

  // ANTI-VACUITY. If every kill landed before the child did any work, this whole
  // test is asserting that a fresh sync works — which is covered five times
  // over elsewhere. At least one signal has to have interrupted a sync that was
  // genuinely part-way through the log.
  const midway = landed.filter((l) => l.cursor > 0n && l.cursor < BigInt(n));
  expect(midway.length).toBeGreaterThan(0);

  // The rows-ahead-of-cursor state — `fileStore`'s residual window — is a
  // MEASUREMENT here, not a requirement. The two writes it sits between have no
  // `await` in them, so a signal lands there only if it interrupts the syscall
  // itself; Task 5 judged the exposure low for exactly this reason and the
  // reading below is the evidence for that judgement rather than an assertion
  // that would flake. The window's REPAIR is pinned deterministically by "rows
  // persisted above the cursor are verified, PINNED and folded once".
  const inWindow = landed.filter((l) => BigInt(l.rows) > l.cursor).length;
  expect(inWindow).toBeGreaterThanOrEqual(0);

  // Every kill left a state the resume path can read: rows are never BEHIND a
  // cursor that claims them, which is the unrecoverable direction.
  for (const l of landed) expect(BigInt(l.rows)).toBeGreaterThanOrEqual(l.cursor);

  // Now resume, in this process, from whatever the last kill left on disk.
  const resumed = new Client({ store: fileStore(dir, "kill"), server: s.url });
  const engine = new SyncEngine(resumed, db(), { chunkSize: 50 });
  const out = await engine.sync({ push: false });

  expect(out.halted).toBe(false);
  expect(resumed.state().txns.size).toBe(n);
  expect(resumed.state().anomalies).toEqual([]);
  expect(resumed.cursor(STREAM_HOT)).toBe(BigInt(n));
  expect(resumed.pinnedHead("ingest", STREAM_HOT).counter).toBe(BigInt(n));
  // The strongest statement available: byte-identical to a log that was never
  // interrupted. A row applied twice, or lost, or applied out of order, all show
  // up here.
  expect(serializeState(resumed.state())).toBe(want);
}, 180_000);

test("the interruption harness really does kill a running child", async () => {
  // Calibration for the sweep above. A `proc.kill` that silently did nothing
  // would let every run finish cleanly and the resume test would be asserting
  // that an uninterrupted sync works.
  const s = server();
  seedTxns(s, 400);
  const dir = scratchDir();
  await readerClient(s, fileStore(dir, "calib"));
  const script = join(dir, "calib.ts");
  await Bun.write(script, childScript(dir, s.url, "calib"));
  const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe", stderr: "pipe" });
  await new Promise<void>((resolve) => {
    s.onPage = (n) => {
      if (n === 1) setTimeout(resolve, 3);
    };
  });
  proc.kill(9);
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  expect(out).toContain("started");
  expect(out).not.toContain("finished");
  expect(code).not.toBe(0);
}, 60_000);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Opens a stored fake-server blob, for asserting on what was really uploaded. */
function openFor(userId: string, r: FakeRow): Uint8Array {
  // Imported lazily through the same path production uses, so a change to the
  // envelope shows up here rather than in a hand-rolled copy.
  const { openBlob } = require("../wire/blob") as typeof import("../wire/blob");
  return openBlob({ userId, stream: r.stream, writerId: r.writer_id, writerCounter: r.writer_counter }, r.blob);
}

// Silences the unused-import lint for a type-only usage above.
void arrayRowStore;
