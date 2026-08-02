import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, HardStopError, ROSTER_CHECKPOINT, decodeWireRow, registrationMessage } from "./client";
import { INVARIANT_IDS, VIOLATION_CHAIN_WITHHELD, VIOLATION_ROSTER_COVERAGE } from "../invariants/check";
import { bunDriver } from "../store/driver";
import { openMemStore } from "../store/open";
import { sqliteStore } from "../store/sqlite";
import { memSecretStore, type Store, type WireRow } from "../store/store";
import { STREAM_COLD, STREAM_HOT, sealBlob, type Stream } from "../wire/blob";
import { ZERO_HASH, chainHash, chainKey } from "../wire/chain";
import { SCHEMA_VERSION, encodeBlobOps, encodeRawBody, type Op } from "../wire/op";

// ---------------------------------------------------------------------------
// A fake server
//
// It speaks the real wire protocol over a real socket — the client's HTTP path,
// its decoders and its chain checks all run for real — while letting a test
// stage the three failures a live server will not produce on demand: a dropped
// row, a blob that will not decode, and a roster that changes between pushes.
// ---------------------------------------------------------------------------

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

interface FakeOpts {
  /** Omit this counter of the ingest hot chain from every pull response. */
  dropWriterCounter?: bigint;
  /** Answer the hash list with a cursor that never advances. */
  stallHashCursor?: boolean;
  /** Writers the roster starts with. */
  writers?: { writer_id: string; kind: string; revoked_at: string | null }[];
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

class FakeServer {
  readonly userId = randomUUID();
  readonly rows: FakeRow[] = [];
  readonly uploaded: { writer_counter: bigint; prev_hash: Uint8Array; blob_hash: Uint8Array }[] = [];
  writers: { writer_id: string; kind: string; revoked_at: string | null }[];
  /** Commit the next upload and then lose the answer, as a dropped connection does. */
  dropNextUploadResponse = false;
  /**
   * Seqs withheld from `GET /api/v1/sync` but NOT from the hash list.
   *
   * This is read-after-write lag, and it is what keeps a straddle reachable now
   * that `push` pre-syncs: without it the pre-pull would discover the row the
   * lost round committed and simply build the next batch above it. It applies
   * to bodies only, which is deliberate — `readChainHead` reads the HASH LIST
   * precisely so the resend path does not depend on the body pull having caught
   * up, and this pins that.
   */
  readonly laggingSeqs = new Set<bigint>();
  private seq = 0n;
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor(private readonly opts: FakeOpts = {}) {
    this.writers = opts.writers ?? [];
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

  /**
   * Appends a blob to a chain, sealing and chaining it honestly.
   *
   * `sealAs` seals the blob for a DIFFERENT position than the one it is stored
   * at, while still chaining it correctly — the one shape that gets past
   * `verifyChain` (which hashes the bytes and never looks inside them) and has
   * to be caught by the invariant checker instead.
   */
  append(writerId: string, stream: Stream, plaintext: Uint8Array, sealAs?: bigint): FakeRow {
    const prev = this.head(writerId, stream);
    const counter = prev.counter + 1n;
    const blob = sealBlob({ userId: this.userId, stream, writerId, writerCounter: sealAs ?? counter }, plaintext);
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

  /**
   * Truncations: chain key -> the highest counter still served.
   *
   * A truncation is a CLEAN PREFIX, so nothing about the rows it does serve is
   * wrong — `verifyChain` passes, no hash is out of place, and the only thing
   * that can detect it is a checkpoint a peer wrote before the rows vanished.
   * That is the entire point of I11's withholding branch.
   */
  readonly truncated = new Map<string, bigint>();

  truncate(writerId: string, stream: Stream, keepUpTo: bigint): void {
    this.truncated.set(`${writerId}|${stream}`, keepUpTo);
  }

  /** Rows a pull may see: `dropWriterCounter` is withheld here and nowhere else. */
  private visible(stream: Stream): FakeRow[] {
    return this.rows.filter(
      (r) =>
        r.stream === stream &&
        !(this.opts.dropWriterCounter !== undefined && r.stream === STREAM_HOT && r.writer_id === "ingest" && r.writer_counter === this.opts.dropWriterCounter) &&
        r.writer_counter <= (this.truncated.get(`${r.writer_id}|${r.stream}`) ?? r.writer_counter),
    );
  }

  /** Rows a BODY pull may see: `visible` minus whatever is lagging. */
  private visibleBodies(stream: Stream): FakeRow[] {
    return this.visible(stream).filter((r) => !this.laggingSeqs.has(r.seq));
  }

  private json(v: unknown, status = 200): Response {
    return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === "POST" && path === "/api/v1/auth/exchange") {
      return this.json({ session_token: "fake-session", user_id: this.userId });
    }
    if (req.method === "POST" && path === "/api/v1/writers/challenge") {
      return this.json({ nonce: b64(new Uint8Array(32).fill(7)) });
    }
    if (req.method === "POST" && path === "/api/v1/writers/register") {
      const body = (await req.json()) as { writer_id: string };
      this.writers.push({ writer_id: body.writer_id, kind: "device", revoked_at: null });
      return new Response(null, { status: 204 });
    }
    if (req.method === "GET" && path === "/api/v1/writers") {
      return this.json({ writers: this.writers });
    }
    if (req.method === "GET" && path === "/api/v1/sync") {
      const stream = (url.searchParams.get("stream") ?? "") as Stream;
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const all = this.visibleBodies(stream).filter((r) => r.seq > after);
      const page = all.slice(0, limit);
      const last = page[page.length - 1];
      const next = last === undefined ? after : last.seq;
      const maxSeq = this.visibleBodies(stream).reduce((m, r) => (r.seq > m ? r.seq : m), 0n);
      return this.json({ stream, rows: page.map((r) => this.wire(r)), next: next.toString(10), complete: next >= maxSeq });
    }
    if (req.method === "GET" && path === "/api/v1/sync/hashes") {
      const stream = (url.searchParams.get("stream") ?? "") as Stream;
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const all = this.visible(stream).filter((r) => r.seq > after);
      const maxSeq = this.visible(stream).reduce((m, r) => (r.seq > m ? r.seq : m), 0n);
      const last = all[all.length - 1];
      const next = this.opts.stallHashCursor === true ? after : last === undefined ? after : last.seq;
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
        complete: this.opts.stallHashCursor === true ? false : next >= maxSeq,
      });
    }
    if (req.method === "POST" && path === "/api/v1/sync") return this.upload(req);
    return this.json({ error: "not_found" }, 404);
  }

  /**
   * `POST /api/v1/sync`, with `oplog.AppendClient`'s conflict semantics: a batch
   * every one of whose positions is already held by byte-identical content is
   * IDEMPOTENT and answers 200 with the seqs those rows already have; a batch
   * that straddles the head answers 409 with the contract text; a position held
   * by different bytes is a chain break. Getting these three apart is the point
   * — the client's remedies differ, and only one of them is "resend a suffix".
   */
  private async upload(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      writer_id: string;
      stream: Stream;
      blobs: { writer_counter: string; prev_hash: string; blob_hash: string; size_bucket: number; blob: string }[];
    };
    for (const b of body.blobs) {
      this.uploaded.push({
        writer_counter: BigInt(b.writer_counter),
        prev_hash: new Uint8Array(Buffer.from(b.prev_hash, "hex")),
        blob_hash: new Uint8Array(Buffer.from(b.blob_hash, "hex")),
      });
    }
    const stored = body.blobs.map((b) =>
      this.rows.find(
        (r) => r.writer_id === body.writer_id && r.stream === body.stream && r.writer_counter === BigInt(b.writer_counter),
      ),
    );
    const held = stored.filter((r) => r !== undefined).length;
    if (held === body.blobs.length && held > 0) {
      for (const [i, b] of body.blobs.entries()) {
        if (hex(stored[i]!.blob_hash) !== b.blob_hash) {
          return this.json({ error: "chain_break", detail: "that position already holds different bytes" }, 409);
        }
      }
      return this.json({ seqs: stored.map((r) => r!.seq.toString(10)) });
    }
    if (held > 0) {
      for (const [i, b] of body.blobs.entries()) {
        const s = stored[i];
        if (s !== undefined && hex(s.blob_hash) !== b.blob_hash) {
          return this.json({ error: "chain_break", detail: "that position already holds different bytes" }, 409);
        }
      }
      return this.json({ error: "conflict", detail: "read the chain head and resend only the rows above it" }, 409);
    }

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
    if (this.dropNextUploadResponse) {
      // The rows COMMITTED and the answer was lost — the one way a straddle is
      // reachable against a server that appends atomically. They also go
      // lagging, so the client's next pre-sync does not simply discover them
      // and build above them; see `laggingSeqs`.
      this.dropNextUploadResponse = false;
      for (const q of seqs) this.laggingSeqs.add(BigInt(q));
      return this.json({ error: "internal" }, 500);
    }
    // A successful append is where the lag resolves.
    this.laggingSeqs.clear();
    return this.json({ seqs });
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let live: FakeServer[] = [];
function serve(opts: FakeOpts = {}): FakeServer {
  const s = new FakeServer(opts);
  live.push(s);
  return s;
}
afterEach(() => {
  for (const s of live) s.stop();
  live = [];
});

let opSeq = 0;
function op(type: Op["type"], payload: unknown, extra: Partial<Op> = {}): Op {
  opSeq++;
  return {
    v: SCHEMA_VERSION,
    type,
    op_id: `op-${String(opSeq).padStart(4, "0")}`,
    authored_at: new Date(Date.UTC(2026, 7, 1, 0, 0, opSeq)).toISOString(),
    parent_version: null,
    payload,
    ...extra,
  };
}

const rateSet = (ccy: string, micro: string): Op => op("rate_set", { currency: ccy, rate_micro: micro });

/** `oplog.IngestWriterID` — the server's own writer. */
const INGEST = "ingest";

/** Three-LETTER codes: `currencyOf` refuses anything else, digits included. */
const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "SEK", "NOK", "NZD"];

/**
 * A string gzip cannot shrink much, for forcing a batch across the bucket
 * ladder. Random bytes in base64 compress to roughly three quarters, so two of
 * these do not share one 1 MiB blob — which is the only way to build a batch of
 * more than one blob without a megabyte of hand-written ops.
 */
function incompressible(bytes: number): string {
  return randomBytes(bytes).toString("base64");
}

/** A body that opens, is a well-formed JSON op blob, and will not decode. */
const undecodable = (): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ v: 1, kind: "ops", ops: [{ v: 1, op_id: "x", payload: {} }] }));

/**
 * Seeds `n` hot ingest blobs, optionally interleaving cold ones.
 *
 * It also puts the ingest writer on the roster, because the real server does:
 * `auth.Writers.EnsureIngestWriter` enrols it the first time it appends for an
 * account. That matters here rather than being decoration — a checkpoint names
 * one head per ROSTER writer, so a fixture whose roster omitted `ingest` would
 * have no `ingest|hot` pair to get right or wrong.
 */
function seedIngest(srv: FakeServer, n: number, opts: { cold?: boolean; corruptAt?: bigint } = {}): void {
  if (n > 0 && !srv.writers.some((w) => w.writer_id === INGEST)) {
    srv.writers.push({ writer_id: INGEST, kind: "ingest", revoked_at: null });
  }
  for (let i = 1; i <= n; i++) {
    const counter = BigInt(i);
    const code = CODES[(i - 1) % CODES.length];
    if (code === undefined) throw new Error("ran out of currency codes");
    const body = opts.corruptAt === counter ? undecodable() : encodeBlobOps([rateSet(code, `${1_000_000 + i}`)]);
    srv.append(INGEST, STREAM_HOT, body);
    if (opts.cold === true) {
      srv.append(
        INGEST,
        STREAM_COLD,
        encodeRawBody({
          ingest_id: "a".repeat(64),
          received_at: "2026-08-01T00:00:00.000Z",
          raw: new TextEncoder().encode(`message ${i}`),
        }),
      );
    }
  }
}

async function loggedIn(srv: FakeServer, writerId?: string): Promise<Client> {
  const c = new Client({ store: openMemStore(), server: srv.url, ...(writerId === undefined ? {} : { writerId }) });
  await c.login("apple", "dev:alice");
  return c;
}

// ---------------------------------------------------------------------------

describe("pull", () => {
  test("refuses to advance the cursor when a hard-stop invariant fires", async () => {
    const srv = serve({ dropWriterCounter: 3n });
    seedIngest(srv, 5);
    const c = await loggedIn(srv);

    await expect(c.pull()).rejects.toThrow(/I2_writer_counters/);
    expect(c.cursor("hot")).toBe(0n);
    expect(c.state().txns.size).toBe(0);
    expect(c.pinnedHead(INGEST, STREAM_HOT).counter).toBe(0n);
  });

  test("a hot-only pull succeeds against a log that interleaves cold blobs", async () => {
    const srv = serve();
    seedIngest(srv, 4, { cold: true });
    const c = await loggedIn(srv);

    await c.pull();

    expect(c.cursor("hot")).toBeGreaterThan(0n);
    expect(c.cursor("cold")).toBe(0n);
    expect(c.check().filter((v) => v.severity === "hard_stop")).toHaveLength(0);
    // The pulled seqs are strictly increasing and NOT contiguous: the cold rows
    // occupy the gaps, and this client deliberately did not fetch them.
    const seqs = c.rowsFor(STREAM_HOT).map((r) => decodeWireRow(r).seq);
    expect(seqs).toEqual([1n, 3n, 5n, 7n]);
    expect(c.state().rates.size).toBe(4);
  });

  test("an undecodable blob is set aside and the cursor still advances", async () => {
    const srv = serve();
    seedIngest(srv, 3, { corruptAt: 2n });
    const c = await loggedIn(srv);

    await c.pull();

    const state = c.state();
    expect(state.unreadable).toHaveLength(1);
    expect(state.unreadable[0]?.writer_counter).toBe(2n);
    expect(c.cursor("hot")).toBe(3n);
    // The two that DID decode still folded, and the checker does not call this
    // a hard stop: one bad blob must never strand a device.
    expect(state.rates.size).toBe(2);
    expect(c.check().filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  });

  test("a second page continues from the cursor the first one left", async () => {
    const srv = serve();
    seedIngest(srv, 5);
    const c = await loggedIn(srv);

    const report = await c.pull({ limit: 2 });

    expect(report.pages).toBe(3);
    expect(report.rows).toBe(5);
    expect(c.cursor("hot")).toBe(5n);
    expect(c.state().rates.size).toBe(5);
  });

  test("pulling cold bodies without pinning their hashes first is refused", async () => {
    const srv = serve();
    seedIngest(srv, 2, { cold: true });
    const c = await loggedIn(srv);

    await expect(c.pull({ stream: STREAM_COLD })).rejects.toThrow(/pull-cold-hashes/);
    expect(c.cursor("cold")).toBe(0n);
  });

  test("pull-cold-hashes pins the chain, and a cold pull is then verified against it", async () => {
    const srv = serve();
    seedIngest(srv, 3, { cold: true });
    const c = await loggedIn(srv);

    const pinned = await c.pullColdHashes();
    expect(pinned.pinned).toBe(3);
    expect(c.pinnedHead(INGEST, STREAM_COLD).counter).toBe(3n);

    await c.pull({ stream: STREAM_COLD });
    expect(c.cursor("cold")).toBe(6n);
    expect(c.cursor("hot")).toBe(0n);
  });

  test("a cold body that does not match its pinned hash is refused", async () => {
    const srv = serve();
    seedIngest(srv, 2, { cold: true });
    const c = await loggedIn(srv);
    await c.pullColdHashes();

    // The server changes its mind about a body it already committed a hash for.
    const target = srv.rows.find((r) => r.stream === STREAM_COLD && r.writer_counter === 1n);
    if (target === undefined) throw new Error("no cold row to corrupt");
    target.blob = sealBlob(
      { userId: srv.userId, stream: STREAM_COLD, writerId: INGEST, writerCounter: 1n },
      encodeRawBody({ ingest_id: "b".repeat(64), received_at: "2026-08-01T00:00:00.000Z", raw: new Uint8Array([1, 2, 3]) }),
    );

    await expect(c.pull({ stream: STREAM_COLD })).rejects.toThrow(/hashes to .*, but .* was pinned/);
    expect(c.cursor("cold")).toBe(0n);
  });
});

describe("push", () => {
  test("assigns contiguous writer counters and a valid chain", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");

    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    c.emit({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    const report = await c.push();

    expect(srv.uploaded.map((b) => b.writer_counter)).toEqual([1n]); // one batched blob
    expect(srv.uploaded[0]?.prev_hash).toEqual(ZERO_HASH);
    expect(report.blobs).toBe(1);
    // Two rate_sets plus the checkpoint push emits when it first sees a roster.
    expect(report.ops).toBe(3);
    expect(report.checkpointed).toBe(true);
    // The self-sync folded them at the seqs the server assigned.
    expect(c.state().rates.get("USD")).toBe(3672500n);
    expect(c.pinnedHead("dev-a", STREAM_HOT).counter).toBe(1n);
    expect(c.pending).toHaveLength(0);
  });

  test("a second push chains onto the head the first one left", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");

    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();
    c.emit({ type: "rate_set", payload: { currency: "GBP", rate_micro: "4600000" } });
    await c.push();

    expect(srv.uploaded.map((b) => b.writer_counter)).toEqual([1n, 2n]);
    const [first, second] = srv.uploaded;
    if (first === undefined || second === undefined) throw new Error("expected two uploads");
    expect(second.prev_hash).toEqual(first.blob_hash);
    expect(c.check().filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  });

  test("emits a checkpoint when the roster changes, naming every (writer x stream) pair", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");

    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    const first = await c.push();
    expect(first.checkpointed).toBe(true);
    expect(c.state().checkpoints.map((h) => `${h.writer_id}|${h.stream}`).sort()).toEqual(["dev-a|cold", "dev-a|hot"]);

    // A second device enrolls. Nothing asks for a checkpoint; the next push
    // notices the roster moved and emits one.
    srv.writers.push({ writer_id: "dev-b", kind: "device", revoked_at: null });
    c.emit({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    const second = await c.push();

    expect(second.checkpointed).toBe(true);
    const named = c.state().checkpoints.map((h) => `${h.writer_id}|${h.stream}`).sort();
    expect(named).toEqual(["dev-a|cold", "dev-a|hot", "dev-b|cold", "dev-b|hot"]);
    // dev-b has authored nothing, so it is named at counter 0 with genesis —
    // CHECKPOINT_NAMES_THE_ROSTER. A checkpoint built from observed chains
    // could not name it at all, and I11 would hard-stop forever.
    const devB = c.state().checkpoints.filter((h) => h.writer_id === "dev-b");
    expect(devB.map((h) => h.counter)).toEqual([0n, 0n]);
    expect(devB.map((h) => h.hash)).toEqual(["0".repeat(64), "0".repeat(64)]);
    expect(c.check(STREAM_HOT, srv.writers).filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  });

  // The rule this REPLACED — "checkpoint only when the roster string changes" —
  // meant exactly one checkpoint was ever written per account. The roster stops
  // moving; the chains do not.
  test("an unchanged roster still produces a checkpoint once the heads have moved", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();
    c.emit({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    const second = await c.push();
    expect(second.checkpointed).toBe(true);
    expect(second.ops).toBe(2); // the rate_set plus the checkpoint
    // …and it says something the first one could not: blob 1 of its own chain.
    const own = c.state().checkpoints.find((h) => h.writer_id === "dev-a" && h.stream === STREAM_HOT);
    expect(own?.counter).toBe(1n);
  });

  test("two enrolled device writers and no checkpoint is a hard stop", async () => {
    const srv = serve({
      writers: [
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
      ],
    });
    seedIngest(srv, 2);
    const c = await loggedIn(srv, "dev-b");

    // Contract: a multi-device account hard-stops until a checkpoint lands, and
    // enrolment and the first checkpoint are strictly ordered. This is the rule
    // doing its job, not a bug.
    await expect(c.pull()).rejects.toThrow(/I11_roster_checkpoint/);
    expect(c.cursor("hot")).toBe(0n);
  });

  test("nothing pending and an unchanged roster uploads nothing", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();
    const again = await c.push();
    expect(again.blobs).toBe(0);
    expect(srv.uploaded).toHaveLength(1);
  });

  test("a partially-applied batch is resent from the chain head, not retried whole", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");

    // The straddle, reproduced honestly. The server appends a batch atomically,
    // so the ONLY way a batch can be partly applied is a second batch that
    // overlaps a first one which committed while its answer was lost. Round 1
    // commits and 500s, so the client keeps its pending ops and does not know
    // the row is stored.
    srv.dropNextUploadResponse = true;
    c.emit({ type: "txn_edited", payload: { fields: { merchant_raw: incompressible(700_000) } }, entity: { kind: "txn", id: "t1" }, parentVersion: 1 });
    await expect(c.push()).rejects.toThrow(/500/);
    expect(srv.rows.filter((r) => r.writer_id === "dev-a")).toHaveLength(1);

    // Round 2 adds a second op. The batch now spans counters 1..2, and blob 1
    // is BYTE-IDENTICAL to the stored one (its ops kept their ids and
    // timestamps), which is exactly the straddle the 409 is for.
    c.emit({ type: "txn_edited", payload: { fields: { merchant_raw: incompressible(700_000) } }, entity: { kind: "txn", id: "t2" }, parentVersion: 1 });
    const report = await c.push();

    // Two blobs were built, the server was told about both, and only the one
    // above its head was resent: three positions offered across three requests.
    expect(report.blobs).toBe(1);
    expect(srv.uploaded.map((b) => b.writer_counter)).toEqual([1n, 1n, 2n, 2n]);
    expect(srv.rows.filter((r) => r.writer_id === "dev-a").map((r) => r.writer_counter)).toEqual([1n, 2n]);
    expect(c.pending).toHaveLength(0);
  });

  test("readChainHead reports the head the resend has to build on", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    expect((await c.readChainHead("dev-a", STREAM_HOT)).counter).toBe(0n);
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();
    const head = await c.readChainHead("dev-a", STREAM_HOT);
    expect(head.counter).toBe(1n);
    expect(head.hash).toEqual(srv.head("dev-a", STREAM_HOT).hash);
  });
});

describe("enroll", () => {
  test("signs the registration message the server verifies", async () => {
    const srv = serve();
    const c = await loggedIn(srv);
    await c.enroll("dev-a");
    expect(srv.writers.map((w) => w.writer_id)).toEqual(["dev-a"]);
    expect(c.writerId).toBe("dev-a");
  });

  test("the registration message matches auth.RegistrationMessage's encoding", () => {
    const nonce = new Uint8Array(32).fill(1);
    const pub = new Uint8Array(32).fill(2);
    const got = registrationMessage(nonce, "dev-a", pub);
    const want = Buffer.concat([
      Buffer.from("ledger-v2-writer-registration\u0000", "utf8"),
      Buffer.from(nonce),
      Buffer.from([0]),
      Buffer.from("dev-a", "utf8"),
      Buffer.from([0]),
      Buffer.from(pub),
    ]);
    expect(Buffer.from(got)).toEqual(want);
  });

  // A `WriterKey` is a JWK pair, so both halves are UNPADDED base64url — 43
  // characters for 32 bytes, `-`/`_` and never `+`/`/` or `=`. This is the
  // on-disk format of the one secret the client holds, and it was previously
  // produced by `node:crypto`'s JWK export rather than by any code here; now
  // that the platform seam mints it, nothing but this test pins the shape.
  // A padded or standard-alphabet variant still round-trips through this
  // module, so every other test stays green while the state file changes format
  // under an already-enrolled device.
  test("a minted writer key is stored as unpadded base64url, the JWK encoding", () => {
    const store = openMemStore();
    const c = new Client({ store, server: "http://127.0.0.1:1" });
    const pub = c.ensureWriterKey("dev-a");
    expect(pub).toHaveLength(32);

    const k = store.load().writers.get("dev-a");
    expect(k).toBeDefined();
    expect(k!.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k!.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k!.x).toBe(Buffer.from(pub).toString("base64url"));
    expect(k!.x).not.toBe(k!.d);

    // And it is stable: asking again returns the same key rather than minting.
    expect(Buffer.from(c.ensureWriterKey("dev-a"))).toEqual(Buffer.from(pub));
  });
});

describe("state", () => {
  // `pull` step 4 used to be ONE write, because the rows lived inside the
  // state. Splitting the log out split the write, so the two halves are wrapped
  // in `Store.transaction` — and this is what that buys. A save that fails
  // takes the rows with it, so the next run resumes from the same cursor over
  // the same page.
  //
  // The failure this rules out is not "some rows are missing": it is a store
  // holding rows ABOVE its saved cursor, which makes the next pull re-serve
  // rows the fold has already consumed and the replay ordering guard refuse
  // them. Measured, not assumed — this test failed exactly that way before the
  // transaction went in.
  //
  // The store is SQLite explicitly, not `openMemStore()`: it is the phone's
  // store, it is the only one that can actually be atomic, and `memStore.load()`
  // hands back the very object the client mutates, so an unsaved cursor would
  // read as saved.
  test("a pull whose save fails stores neither the rows nor the cursor", async () => {
    const srv = serve();
    seedIngest(srv, 3);
    const inner = sqliteStore(bunDriver(join(mkdtempSync(join(tmpdir(), "ledger-crash-")), "p.db")), {
      secrets: memSecretStore(),
    });
    let fail = false;
    const store: Store = {
      get location() {
        return inner.location;
      },
      load: () => inner.load(),
      save: (s) => {
        if (fail) throw new Error("simulated crash: the state could not be saved");
        inner.save(s);
      },
      rows: () => inner.rows(),
      transaction: (fn) => inner.transaction(fn),
    };
    const c = new Client({ store, server: srv.url });
    await c.login("apple", "dev:alice");

    fail = true;
    await expect(c.pull()).rejects.toThrow(/simulated crash/);
    expect(inner.rows().count(STREAM_HOT)).toBe(0);
    expect(inner.load().cursors.hot).toBe(0n);

    // …and the resume: the next run pulls the same page, once.
    fail = false;
    const again = new Client({ store, server: srv.url });
    await again.pull();
    expect(inner.rows().count(STREAM_HOT)).toBe(3);
    expect(inner.load().cursors.hot).toBe(3n);
  });

  test("a hard stop leaves the store byte-identical to what it was", async () => {
    const srv = serve();
    seedIngest(srv, 2);
    const store = openMemStore();
    const c = new Client({ store, server: srv.url });
    await c.login("apple", "dev:alice");
    await c.pull();
    const before = JSON.stringify(store.load(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));

    // A row the client has already folded comes back with different bytes.
    const target = srv.rows.find((r) => r.stream === STREAM_HOT && r.writer_counter === 2n);
    if (target === undefined) throw new Error("no row to corrupt");
    srv.append(INGEST, STREAM_HOT, encodeBlobOps([rateSet("ZZZ", "1")]));
    const forged = srv.rows[srv.rows.length - 1];
    if (forged === undefined) throw new Error("no forged row");
    forged.prev_hash = new Uint8Array(32).fill(9);

    await expect(c.pull()).rejects.toBeInstanceOf(Error);
    const after = JSON.stringify(store.load(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(after).toBe(before);
  });

  test("chainKey is what pinned heads are filed under", async () => {
    const srv = serve();
    seedIngest(srv, 2);
    const c = await loggedIn(srv);
    await c.pull();
    expect(chainKey(INGEST, STREAM_HOT)).toBe("ingest|hot");
    expect(c.pinnedHead(INGEST, STREAM_HOT).counter).toBe(2n);
  });

  test("a hard stop reports every violation, not only the first", async () => {
    const srv = serve({ dropWriterCounter: 2n });
    seedIngest(srv, 4);
    const c = await loggedIn(srv);
    try {
      await c.pull();
      throw new Error("expected a hard stop");
    } catch (err) {
      expect(err).toBeInstanceOf(HardStopError);
      const v = (err as HardStopError).violations;
      expect(v.some((x) => x.id === "I2_writer_counters" && x.severity === "hard_stop")).toBe(true);
      expect(v.some((x) => x.id === "I14_forks_surfaced")).toBe(true); // never zero-suppressed
    }
  });
});

describe("checkpoint", () => {
  // The defect this whole section exists for: `checkpoint()` filled every
  // (roster writer x stream) pair from `pinnedHead()`, which falls back to
  // genesis for a chain the device has not looked at. A device that had pulled
  // nothing therefore attested "every chain is empty" — which satisfies I11's
  // coverage requirement while asserting NOTHING, and leaves a peer with no
  // trusted head for the cold stream, where the raw email bodies are.
  test("attests the real heads of chains this device did not author", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    seedIngest(srv, 5, { cold: true });
    const c = await loggedIn(srv, "dev-a");

    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    const report = await c.push();
    expect(report.checkpointed).toBe(true);

    const heads = new Map(c.state().checkpoints.map((h) => [`${h.writer_id}|${h.stream}`, h.counter]));
    expect(heads.get("ingest|hot")).toBe(5n);
    // The cold chain in particular: it is never pulled by a hot-only client, so
    // it is the pair the naive implementation always got wrong.
    expect(heads.get("ingest|cold")).toBe(5n);
    // Its own chain is genuinely empty at the moment it attests: the blob
    // carrying this very checkpoint is counter 1 and cannot attest itself.
    expect(heads.get("dev-a|hot")).toBe(0n);
    expect(heads.get("dev-a|cold")).toBe(0n);
    expect(c.check(STREAM_HOT, srv.writers).filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  });

  // Counter 0 must mean EMPTY, not UNKNOWN. Task 13's I11 now emits a notice
  // when a checkpoint claims a chain is empty that the reader holds blobs on,
  // and this pins which side of that line each chain falls on.
  test("claims 0 only for the one chain it cannot possibly attest: its own", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    seedIngest(srv, 3, { cold: true });
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();

    const staleFor = (): string[] =>
      c
        .check(STREAM_HOT, srv.writers)
        .filter((v) => v.id === "I11_roster_checkpoint" && v.detail.includes("claims that chain is empty"))
        .map((v) => v.detail.replace(/^checkpoint head \((.*?)\).*$/, "$1"));

    // The chains this device merely READS are attested for real. That is the
    // defect: the naive implementation claimed 0 for every one of them.
    expect(staleFor()).not.toContain("ingest|hot");
    expect(staleFor()).not.toContain("ingest|cold");

    // Its own hot chain is the exception, and it is not fixable: this
    // checkpoint IS blob 1 of that chain, and a payload cannot contain the hash
    // of the blob that carries it. So the first checkpoint a device writes
    // necessarily claims 0 for itself.
    expect(staleFor()).toContain("dev-a|hot");

    // …and it clears itself on the next one, which attests blob 1 for real.
    c.emit({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    await c.push();
    expect(staleFor()).toHaveLength(0);
  });

  // Gating re-checkpointing on the roster alone meant exactly ONE checkpoint
  // was ever written: the roster string stops changing and the chains keep
  // moving, so the log's only checkpoint went on claiming counter 0 forever.
  test("keeps checkpointing as the chains advance, not only when the roster does", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");

    for (let i = 0; i < 4; i++) {
      c.emit({ type: "rate_set", payload: { currency: CODES[i]!, rate_micro: `${1_000_000 + i}` } });
      await c.push();
    }
    const head = c.pinnedHead("dev-a", STREAM_HOT).counter;
    expect(head).toBeGreaterThan(3n);
    const claimed = c.state().checkpoints.find((h) => h.writer_id === "dev-a" && h.stream === STREAM_HOT);
    // It necessarily lags by the blob it is riding in — a checkpoint cannot
    // attest itself — but it TRACKS, which the roster-gated version did not.
    expect(claimed?.counter).toBeGreaterThan(0n);
    expect(head - (claimed?.counter ?? 0n)).toBeLessThanOrEqual(2n);
  });

  test("a push with nothing to say uploads nothing, checkpoint or not", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();
    const after = srv.uploaded.length;
    // Twice, because the churn this guards against needs a second round to
    // show: the first no-op push would attest the previous checkpoint's own
    // blob, move the head, and give the next one something to attest again.
    expect((await c.push()).blobs).toBe(0);
    expect((await c.push()).blobs).toBe(0);
    expect(srv.uploaded.length).toBe(after);
  });

  // The deadlock the pre-sync would otherwise create: once dev-b is enrolled
  // and unattested, EVERY device's pull hard-stops on I11 — including the one
  // that has to write the healing checkpoint.
  test("pushes through the I11 hard stop it is about to repair", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();

    srv.writers.push({ writer_id: "dev-b", kind: "device", revoked_at: null });
    // A plain pull is refused, which is the rule doing its job.
    await expect(c.pull()).rejects.toThrow(/I11_roster_checkpoint/);
    // A push is not, because writing the checkpoint is the repair.
    const healing = await c.push();
    expect(healing.checkpointed).toBe(true);
    expect(c.state().checkpoints.map((h) => `${h.writer_id}|${h.stream}`).sort()).toEqual([
      "dev-a|cold",
      "dev-a|hot",
      "dev-b|cold",
      "dev-b|hot",
    ]);
    // …and the account syncs again afterwards.
    await c.pull();
  });

  // A chain break during the pre-sync is NOT something a checkpoint repairs, so
  // it must still stop the push dead.
  test("does not push through a hard stop that a checkpoint cannot repair", async () => {
    const srv = serve({ dropWriterCounter: 2n, writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    seedIngest(srv, 4);
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await expect(c.push()).rejects.toThrow(/I2_writer_counters/);
    expect(srv.uploaded).toHaveLength(0);
  });

  test("the invariant id the push escape keys on is a real one", () => {
    expect(INVARIANT_IDS).toContain(ROSTER_CHECKPOINT);
  });
});

describe("guards", () => {
  // Everything else that stops a pull is caught by verifyChain before the
  // checker ever runs, so removing pull()'s own hard-stop throw failed almost
  // nothing. This is the case that isolates it: a blob sealed for one position
  // and stored at another chains PERFECTLY — verifyChain hashes the bytes and
  // never looks inside them — and only I4 can see it.
  test("a blob sealed for another position is refused by the checker, not the chain", async () => {
    const srv = serve();
    seedIngest(srv, 2);
    srv.append(INGEST, STREAM_HOT, encodeBlobOps([rateSet("GBP", "4600000")]), 99n);
    const c = await loggedIn(srv);

    const err = await c.pull().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardStopError);
    expect((err as HardStopError).violations.some((v) => v.id === "I4_aad" && v.severity === "hard_stop")).toBe(true);
    // No chain break was involved, so nothing was attributed from one.
    expect((err as HardStopError).cause).toBeUndefined();
    expect(c.cursor(STREAM_HOT)).toBe(0n);
    expect(c.state().txns.size).toBe(0);
  });

  test("a hash list whose cursor never advances is refused rather than looped on", async () => {
    const srv = serve({ stallHashCursor: true });
    seedIngest(srv, 2, { cold: true });
    const c = await loggedIn(srv);
    await expect(c.pullColdHashes()).rejects.toThrow(/does not advance past/);
  });

  test("a peer public key of the wrong length is refused before it is enrolled", async () => {
    const srv = serve();
    const c = await loggedIn(srv);
    await c.enroll("dev-a");
    await expect(c.enroll("dev-b", { signWith: "dev-a", publicKey: new Uint8Array(31) })).rejects.toThrow(
      /31 bytes, and Ed25519 keys are 32/,
    );
    expect(srv.writers.map((w) => w.writer_id)).toEqual(["dev-a"]);
  });
});

describe("withholding is never escaped", () => {
  /**
   * The hole this section exists for, built end to end.
   *
   * `I11_roster_checkpoint` bundles a benign condition — the roster names a
   * writer the checkpoint does not cover — with an adversarial one: a
   * checkpoint claims a head above anything this client has seen, which means
   * the server is withholding rows a peer already witnessed. `push` proceeds
   * over the first, because writing the checkpoint is the repair. Matching on
   * the ID alone made it proceed over the second too, and the consequence is
   * that the withheld-from device REPLACES the honest attestation with one
   * claiming genesis — `applyCheckpoint` keeps only the latest — after which
   * the truncation is a notice nobody has to act on.
   */
  async function truncatedAccount(): Promise<{ srv: FakeServer; c: Client }> {
    const srv = serve({
      writers: [
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
        { writer_id: "dev-c", kind: "device", revoked_at: null },
      ],
    });
    // dev-a authors up to hot counter 4. Every push carries a checkpoint, and
    // the roster is complete from the start, so dev-c is covered throughout.
    const a = await loggedIn(srv, "dev-a");
    for (let i = 0; i < 4; i++) {
      a.emit({ type: "rate_set", payload: { currency: CODES[i]!, rate_micro: `${1_000_000 + i}` } });
      await a.push();
    }
    expect(srv.head("dev-a", STREAM_HOT).counter).toBe(4n);

    // dev-b syncs the whole log and attests it. Its checkpoint is the newest in
    // the account, and it names dev-a|hot at its real head.
    const b = await loggedIn(srv, "dev-b");
    b.emit({ type: "rate_set", payload: { currency: "ZAR", rate_micro: "200000" } });
    await b.push();
    const attested = b.state().checkpoints.find((h) => h.writer_id === "dev-a" && h.stream === STREAM_HOT);
    expect(attested?.counter).toBe(4n);

    // The server now truncates dev-a's hot chain to counter 2. A clean prefix:
    // no chain break, no bad hash, nothing local can see it.
    srv.truncate("dev-a", STREAM_HOT, 2n);

    const c = await loggedIn(srv, "dev-c");
    c.emit({ type: "rate_set", payload: { currency: "BRL", rate_micro: "700000" } });
    return { srv, c };
  }

  test("a truncated peer chain is the ONLY hard stop dev-c sees, and it is not a coverage one", async () => {
    const { c } = await truncatedAccount();
    const err = await c.pull().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HardStopError);
    const stops = (err as HardStopError).violations.filter((v) => v.severity === "hard_stop");
    expect(stops).toHaveLength(1);
    expect(stops[0]?.id).toBe(ROSTER_CHECKPOINT);
    expect(stops[0]?.kind).toBe(VIOLATION_CHAIN_WITHHELD);
    expect(stops[0]?.detail).toMatch(/withholding rows a peer device has already witnessed/);
  });

  test("push refuses rather than laundering the truncation into a fresh genesis claim", async () => {
    const { srv, c } = await truncatedAccount();
    const uploadsBefore = srv.uploaded.length;

    await expect(c.push()).rejects.toThrow(/withholding rows a peer device has already witnessed/);

    // Nothing was written. In particular no checkpoint from a device that
    // cannot see the chain it would be attesting.
    expect(srv.uploaded.length).toBe(uploadsBefore);
    expect(srv.rows.some((r) => r.writer_id === "dev-c")).toBe(false);
    // dev-b's honest attestation is still the latest one in the log, so the
    // next device to sync meets the same hard stop rather than a notice.
    const again = await c.pull().catch((e: unknown) => e);
    expect((again as HardStopError).violations.some((v) => v.kind === VIOLATION_CHAIN_WITHHELD)).toBe(true);
  });

  // The boundary the escape rests on: it is an ALLOW-list over every hard stop,
  // so a coverage stop travelling with any other stop must still refuse.
  // Mutating `.every` to `.some` passes every other test in this file.
  test("a coverage stop alongside another hard stop is still a refusal", async () => {
    const srv = serve({
      dropWriterCounter: 2n,
      writers: [
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
      ],
    });
    seedIngest(srv, 4);
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });

    // Two live device writers and no checkpoint at all is the COVERAGE stop —
    // the one a push may proceed over — and the dropped ingest row is an I2
    // stop, which it may not. Together they must refuse.
    const err = await c.pull().catch((e: unknown) => e);
    const stops = (err as HardStopError).violations.filter((v) => v.severity === "hard_stop");
    expect(stops.some((v) => v.kind === VIOLATION_ROSTER_COVERAGE)).toBe(true);
    expect(stops.some((v) => v.id === "I2_writer_counters")).toBe(true);

    await expect(c.push()).rejects.toThrow(/I2_writer_counters/);
    expect(srv.uploaded).toHaveLength(0);
  });

  test("the two conditions the escape distinguishes are both real and both under I11", () => {
    expect(INVARIANT_IDS).toContain(ROSTER_CHECKPOINT);
    expect(VIOLATION_ROSTER_COVERAGE).not.toBe(VIOLATION_CHAIN_WITHHELD);
  });
});
