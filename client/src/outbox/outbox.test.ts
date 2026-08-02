/**
 * The writer: the outbox, the offline queue, the chain and the checkpoint.
 *
 * # How the crash cases in here are produced
 *
 * By actually crashing. `Bun.spawn` + `proc.kill(9)` gives a process that gets
 * no unwind, no `finally` and no flush — the closest thing to a phone whose app
 * is terminated — and the fake server holds the upload response open so the
 * signal lands INSIDE the window where the rows are committed and the client
 * does not know it. Writing the post-crash state by hand instead would be
 * asserting the fix's own model of the failure, which is the shape of check
 * this project has paid for repeatedly.
 *
 * The fake server is ported from `net/client.test.ts`'s, trimmed, and grown by
 * the one thing this file needs that that one does not: a way to make a request
 * hang after it has committed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, MAX_UPLOAD_BLOBS, MAX_UPLOAD_BYTES, type PushReport } from "../net/client";
import { Outbox, OutboxStalledError, type Pusher } from "./outbox";
import { fileStore } from "../store/file";
import { openMemStore } from "../store/open";
import { decodeState, encodeState, emptyClientState, type Store, type WireRow } from "../store/store";
import { STREAM_COLD, STREAM_HOT, MAX_BUCKET, sealBlob, type Stream } from "../wire/blob";
import { ChainBreakError, ZERO_HASH, chainHash } from "../wire/chain";
import { SCHEMA_VERSION, encodeBlobOps, encodeRawBody, type Op } from "../wire/op";

// ---------------------------------------------------------------------------
// A fake server
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
  writers?: { writer_id: string; kind: string; revoked_at: string | null }[];
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");

class FakeServer {
  readonly userId: string;
  readonly rows: FakeRow[] = [];
  readonly uploaded: { writer_counter: bigint; blob_hash: Uint8Array }[] = [];
  /** Every request path, for the fetch-storm and no-socket assertions. */
  readonly requests: string[] = [];
  writers: { writer_id: string; kind: string; revoked_at: string | null }[];
  /** Commit the next upload, then never answer. The ambiguous commit, held open. */
  hangNextUpload = false;
  /** Resolves the first time an upload has committed and is being held. */
  readonly committed: Promise<void>;
  private announceCommitted!: () => void;
  /** Withhold committed rows from BODY pulls, as read-after-write lag does. */
  readonly laggingSeqs = new Set<bigint>();
  /** Answer every further upload 503, for a flush that dies between pages. */
  refuseUploads = false;
  private seq = 0n;
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly url: string;

  constructor(opts: FakeOpts = {}) {
    this.userId = randomUUID();
    this.writers = opts.writers ?? [];
    this.committed = new Promise((r) => {
      this.announceCommitted = r;
    });
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

  /** Chain key -> highest counter still served. A clean prefix; nothing local sees it. */
  readonly truncated = new Map<string, bigint>();

  truncate(writerId: string, stream: Stream, keepUpTo: bigint): void {
    this.truncated.set(`${writerId}|${stream}`, keepUpTo);
  }

  private wire(r: FakeRow): WireRow {
    return {
      seq: r.seq.toString(10),
      stream: r.stream,
      writer_id: r.writer_id,
      writer_counter: r.writer_counter.toString(10),
      type_flag: r.writer_id === INGEST ? "ingest" : "edit",
      size_bucket: r.size_bucket,
      blob_hash: hex(r.blob_hash),
      prev_hash: hex(r.prev_hash),
      created_at: "2026-08-02T00:00:00.000Z",
      blob: b64(r.blob),
    };
  }

  private visible(stream: Stream): FakeRow[] {
    return this.rows.filter(
      (r) => r.stream === stream && r.writer_counter <= (this.truncated.get(`${r.writer_id}|${r.stream}`) ?? r.writer_counter),
    );
  }

  private visibleBodies(stream: Stream): FakeRow[] {
    return this.visible(stream).filter((r) => !this.laggingSeqs.has(r.seq));
  }

  private json(v: unknown, status = 200): Response {
    return new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    this.requests.push(`${req.method} ${path}`);
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
    if (req.method === "GET" && path === "/api/v1/writers") return this.json({ writers: this.writers });
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
      const next = last === undefined ? after : last.seq;
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
        complete: next >= maxSeq,
      });
    }
    if (req.method === "POST" && path === "/api/v1/sync") return this.upload(req);
    return this.json({ error: "not_found" }, 404);
  }

  /** `oplog.AppendClient`'s three conflict outcomes, kept apart. */
  private async upload(req: Request): Promise<Response> {
    const body = (await req.json()) as {
      writer_id: string;
      stream: Stream;
      blobs: { writer_counter: string; prev_hash: string; blob_hash: string; size_bucket: number; blob: string }[];
    };
    // The caps the real endpoint enforces (`api/sync.go`), mirrored: without
    // them a client that stopped paging would sail through this fixture and
    // fail only in production.
    if (body.blobs.length > MAX_UPLOAD_BLOBS) {
      return this.json({ error: "too_large", detail: `at most ${MAX_UPLOAD_BLOBS} blobs per upload` }, 413);
    }
    for (const b of body.blobs) {
      this.uploaded.push({
        writer_counter: BigInt(b.writer_counter),
        blob_hash: new Uint8Array(Buffer.from(b.blob_hash, "hex")),
      });
    }
    if (this.refuseUploads) return this.json({ error: "internal", detail: "" }, 503);
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
    if (this.hangNextUpload) {
      // Committed, and the answer never comes. This is the window a phone gets
      // terminated in, and the only one in which "did my ops land" is unknown.
      this.hangNextUpload = false;
      for (const q of seqs) this.laggingSeqs.add(BigInt(q));
      this.announceCommitted();
      await new Promise(() => {});
    }
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

const INGEST = "ingest";
const CODES = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "SEK", "NOK", "NZD"];
const GENESIS = "0".repeat(64);

let opSeq = 0;
function fixedOp(type: Op["type"], payload: unknown, extra: Partial<Op> = {}): Op {
  opSeq++;
  return {
    v: SCHEMA_VERSION,
    type,
    op_id: `op-${String(opSeq).padStart(4, "0")}`,
    authored_at: new Date(Date.UTC(2026, 7, 2, 0, 0, opSeq)).toISOString(),
    parent_version: null,
    payload,
    ...extra,
  };
}

const rateSet = (ccy: string, micro: string): Op => fixedOp("rate_set", { currency: ccy, rate_micro: micro });

const txnIngested = (txnId: string, ingestId: string): Op =>
  fixedOp(
    "txn_ingested",
    {
      amount_minor: "25000",
      currency: "AED",
      direction: "debit",
      posted_at: "2026-06-05T09:00:00Z",
      merchant_raw: "CARREFOUR",
      last4: "3701",
    },
    { entity: { kind: "txn", id: txnId }, ingest_id: ingestId },
  );

/** Random base64: gzip cannot shrink it, so each op fills its own 1 MiB blob. */
function incompressible(bytes: number): string {
  return randomBytes(bytes).toString("base64");
}

function seedIngest(srv: FakeServer, n: number, opts: { cold?: boolean } = {}): void {
  if (n > 0 && !srv.writers.some((w) => w.writer_id === INGEST)) {
    srv.writers.push({ writer_id: INGEST, kind: "ingest", revoked_at: null });
  }
  for (let i = 1; i <= n; i++) {
    srv.append(INGEST, STREAM_HOT, encodeBlobOps([rateSet(CODES[(i - 1) % CODES.length]!, `${1_000_000 + i}`)]));
    if (opts.cold === true) {
      srv.append(
        INGEST,
        STREAM_COLD,
        encodeRawBody({
          ingest_id: "a".repeat(64),
          received_at: "2026-08-02T00:00:00.000Z",
          raw: new TextEncoder().encode(`message ${i}`),
        }),
      );
    }
  }
}

async function loggedIn(srv: FakeServer, writerId?: string, store?: Store): Promise<Client> {
  const c = new Client({
    store: store ?? openMemStore(),
    server: srv.url,
    ...(writerId === undefined ? {} : { writerId }),
  });
  await c.login("apple", "dev:alice");
  return c;
}

/** Every op id the folded log holds, in order, so duplicates are visible. */
function foldedOpIds(c: Client): string[] {
  return c.materialize().ops.map((e) => e.op.op_id);
}

function duplicates(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

// ===========================================================================
// 1. The offline queue survives termination — proved by terminating it
// ===========================================================================

describe("an op authored offline survives the app being killed", () => {
  /**
   * Runs a child that does `work` against `srv` with a durable file store, and
   * SIGKILLs it once `until` resolves. No unwind, no `finally`, no flush.
   */
  async function killDuring(
    srv: FakeServer,
    dir: string,
    profile: string,
    work: string,
    until: Promise<unknown>,
  ): Promise<number | null> {
    const script = join(dir, `child-${profile}.ts`);
    writeFileSync(
      script,
      `import { Client } from ${JSON.stringify(join(import.meta.dir, "../net/client.ts"))};\n` +
        `import { Outbox } from ${JSON.stringify(join(import.meta.dir, "./outbox.ts"))};\n` +
        `import { fileStore } from ${JSON.stringify(join(import.meta.dir, "../store/file.ts"))};\n` +
        `const store = fileStore(${JSON.stringify(dir)}, ${JSON.stringify(profile)});\n` +
        `const c = new Client({ store, server: ${JSON.stringify(srv.url)}, writerId: "dev-a" });\n` +
        `await c.login("apple", "dev:alice");\n` +
        `const outbox = new Outbox(c);\n` +
        work +
        `\n// Stay alive so the kill, not the exit, is what ends this.\n` +
        `await new Promise(() => {});\n`,
    );
    const proc = Bun.spawn(["bun", "run", script], { stdout: "pipe", stderr: "pipe" });
    await until;
    proc.kill(9);
    await proc.exited;
    return proc.signalCode === null ? proc.exitCode : null;
  }

  test("a queued op outlives the process and is pushed on the next launch", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const dir = mkdtempSync(join(tmpdir(), "ledger-outbox-"));

    // The child queues an op and announces it by writing the state file. It is
    // killed with the op queued and nothing uploaded.
    const queued = (async (): Promise<void> => {
      for (;;) {
        try {
          if (fileStore(dir, "kill").load().pending.length > 0) return;
        } catch {
          /* the file is not there yet */
        }
        await Bun.sleep(5);
      }
    })();
    await killDuring(
      srv,
      dir,
      "kill",
      `outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });`,
      queued,
    );

    // ANTI-VACUITY: the child really did die before uploading anything.
    expect(srv.uploaded).toHaveLength(0);

    const resumed = new Client({ store: fileStore(dir, "kill"), server: srv.url, writerId: "dev-a" });
    const outbox = new Outbox(resumed);
    expect(outbox.queued).toBe(1);
    const report = await outbox.flush();

    expect(report.stopped).toBe("drained");
    expect(outbox.queued).toBe(0);
    expect(resumed.state().rates.get("USD")).toBe(3672500n);
    expect(duplicates(foldedOpIds(resumed))).toEqual([]);
  }, 20_000);

  test("a SIGKILL between the upload and its answer never appends the batch twice", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const dir = mkdtempSync(join(tmpdir(), "ledger-outbox-"));
    srv.hangNextUpload = true;

    // Killed while awaiting a response the server will never send, with the
    // rows already committed. `authoredHead` and the emptied `pending` are both
    // written after that await, so neither of them ever happened.
    await killDuring(
      srv,
      dir,
      "amb",
      `outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });\n` +
        `outbox.flush().catch(() => {});`,
      srv.committed,
    );

    // ANTI-VACUITY: the upload really did commit, and the child really was
    // inside the ambiguous window when it died.
    expect(srv.uploaded).toHaveLength(1);
    expect(srv.rows.filter((r) => r.writer_id === "dev-a")).toHaveLength(1);
    const left = fileStore(dir, "amb").load();
    expect(left.pending.length).toBeGreaterThan(0);
    expect(left.inflight).not.toBeNull();
    expect(left.authoredHead).toBeNull();

    // The lag resolves, as it does within a second in production, so the
    // resuming device's pre-push sync sees the row that committed.
    srv.laggingSeqs.clear();
    const resumed = new Client({ store: fileStore(dir, "amb"), server: srv.url, writerId: "dev-a" });
    const outbox = new Outbox(resumed);
    await outbox.flush();

    // Nothing was appended twice. There IS a second blob, and it is a NEW
    // `writer_checkpoint`: the bookkeeping that says "this device has already
    // attested those heads" is written in the same commit the crash cost, so
    // the resumed device honestly does not know it checkpointed. A redundant
    // checkpoint is cheap and truthful; a repeated `rate_set` would not be.
    const mine = srv.rows.filter((r) => r.writer_id === "dev-a");
    expect(mine.map((r) => r.writer_counter)).toEqual([1n, 2n]);
    expect(duplicates(foldedOpIds(resumed))).toEqual([]);
    expect(foldedOpIds(resumed)).toHaveLength(3);
    expect(resumed.materialize().ops.map((e) => e.op.type)).toEqual([
      "rate_set",
      "writer_checkpoint",
      "writer_checkpoint",
    ]);
    expect(outbox.queued).toBe(0);
    expect(resumed.state().forks).toHaveLength(0);
  }, 20_000);

  test("the same kill, resumed while the server is still lagging, resends the same bytes", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const dir = mkdtempSync(join(tmpdir(), "ledger-outbox-"));
    srv.hangNextUpload = true;
    await killDuring(
      srv,
      dir,
      "lag",
      `outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });\n` +
        `outbox.flush().catch(() => {});`,
      srv.committed,
    );
    const sentHash = hex(srv.uploaded[0]!.blob_hash);

    // The device comes back before the row is visible to a body pull, and — the
    // case that wedged the chain before `inflight` — the user has edited again
    // in the meantime, so a re-derived batch would pack both ops into blob 1.
    const resumed = new Client({ store: fileStore(dir, "lag"), server: srv.url, writerId: "dev-a" });
    const outbox = new Outbox(resumed);
    outbox.enqueue({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    const report = await outbox.flush();

    // Counter 1 was offered again with the SAME hash, which is what makes the
    // server's idempotent-replay contract apply instead of its chain break.
    expect(srv.uploaded.filter((u) => u.writer_counter === 1n).map((u) => hex(u.blob_hash))).toEqual([
      sentHash,
      sentHash,
    ]);
    expect(report.stopped).toBe("drained");
    expect(duplicates(foldedOpIds(resumed))).toEqual([]);
    expect(resumed.state().rates.get("USD")).toBe(3672500n);
    expect(resumed.state().rates.get("EUR")).toBe(3900000n);
  }, 20_000);
});

// ===========================================================================
// 2. The guard is load-bearing — remove it and the same sequence breaks
// ===========================================================================

describe("the in-flight record is what makes a resumed push safe", () => {
  /** An interrupted push, in-process: rows committed, answer lost, lag on. */
  async function interrupted(): Promise<{ srv: FakeServer; c: Client; store: Store }> {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const store = openMemStore();
    const c = await loggedIn(srv, "dev-a", store);
    srv.hangNextUpload = true;
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    // Abandoned rather than awaited: the request never answers, exactly as the
    // killed child's did not.
    void c.push().catch(() => {});
    await srv.committed;
    return { srv, c, store };
  }

  test("with the record, a resumed push is byte-identical and the server replays it", async () => {
    const { srv, store } = await interrupted();
    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    const outbox = new Outbox(resumed);
    outbox.enqueue({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    await outbox.flush();
    expect(duplicates(foldedOpIds(resumed))).toEqual([]);
    expect(outbox.queued).toBe(0);
  });

  test("without it, the greedy packer regroups the batch and the chain wedges", async () => {
    const { srv, store } = await interrupted();
    // Exactly the state a build with no `inflight` field leaves behind, and the
    // state a restore from a backup taken before the push leaves behind.
    const lost = store.load();
    lost.inflight = null;
    store.save(lost);

    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    const outbox = new Outbox(resumed);
    outbox.enqueue({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });

    // `409 chain_break`: different bytes at a counter the server already holds.
    // Nothing clears it — every later push rebuilds the same batch — and it
    // reaches the user as a tampering warning for the client's own fault.
    await expect(outbox.flush()).rejects.toThrow(ChainBreakError);
    expect(outbox.queued).toBeGreaterThan(0);
  });

  test("without it, once the lag clears, the same ops are appended a second time", async () => {
    const { srv, store } = await interrupted();
    const lost = store.load();
    lost.inflight = null;
    store.save(lost);
    srv.laggingSeqs.clear();

    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    await resumed.push();

    // The permanent double-append: same op ids, two positions, in a log that
    // cannot be rewritten.
    expect(srv.rows.filter((r) => r.writer_id === "dev-a").map((r) => r.writer_counter)).toEqual([1n, 2n]);
    expect(duplicates(foldedOpIds(resumed))).toHaveLength(2);
  });

  test("a resumed batch whose bytes no longer reproduce is refused, not sent", async () => {
    const { srv, store } = await interrupted();
    // The determinism check: the recorded hash is what the resend is measured
    // against, so a record that no longer describes the ops must stop the push
    // rather than claim a position with bytes nobody wrote down.
    const tampered = store.load();
    tampered.inflight = [{ ...tampered.inflight![0]!, hash: new Uint8Array(32).fill(9) }];
    store.save(tampered);

    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    await expect(new Outbox(resumed).flush()).rejects.toThrow(/sealing is no longer deterministic/);
  });

  test("an op that vanished from the outbox while in flight stops the resend", async () => {
    const { srv, store } = await interrupted();
    const emptied = store.load();
    emptied.pending = [];
    store.save(emptied);
    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    // `pending` empty is the "nothing to push" short-circuit, so this needs one
    // queued op to reach the rebuild at all.
    const outbox = new Outbox(resumed);
    outbox.enqueue({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    await expect(outbox.flush()).rejects.toThrow(/no longer in its outbox/);
  });

  test("a server that substitutes this device's own blob is a chain break, not a resend", async () => {
    const { srv, store } = await interrupted();
    // The server drops the row this device authored and puts a DIFFERENT blob at
    // the same counter, honestly chained from genesis. Nothing local can see it
    // by verification alone: the chain is contiguous and every hash recomputes.
    // The only thing that contradicts it is the hash this device wrote down
    // before it sent the batch — which is why the comparison has to happen, and
    // why it has to be against the pinned head rather than another local flag.
    const mine = srv.rows.findIndex((r) => r.writer_id === "dev-a");
    expect(mine).toBeGreaterThanOrEqual(0);
    srv.rows.splice(mine, 1);
    srv.laggingSeqs.clear();
    srv.append("dev-a", STREAM_HOT, encodeBlobOps([rateSet("JPY", "27000")]));

    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    const outbox = new Outbox(resumed);
    const queuedBefore = outbox.queued;
    const err = await outbox.flush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainBreakError);
    expect((err as Error).message).toMatch(/own chain forked at counter 1: it sent /);
    // And — the part that matters more than the error — the user's queued edits
    // are STILL QUEUED. Reconciliation decides the batch landed by comparing the
    // hash it wrote down against the verified head; skip that comparison and it
    // declares this substituted blob "landed", drops those ops from the outbox
    // and commits. The push then fails anyway, one guard later, with the ops
    // already destroyed. Silent loss of a user's edits, behind a correct-looking
    // error.
    expect(outbox.queued).toBe(queuedBefore);
    // It latches, so nothing retries into a chain this device cannot trust.
    expect(outbox.halted).toBe(err as Error);
  });

  test("a chain head above everything this device ever authored stops the push", async () => {
    const { srv, store } = await interrupted();
    // Two more rows appear under this writer's id — rows it never wrote. The
    // in-flight record says the highest counter it has ever claimed is 1, so a
    // server serving 3 is something else writing as this device.
    srv.laggingSeqs.clear();
    srv.append("dev-a", STREAM_HOT, encodeBlobOps([rateSet("JPY", "27000")]));
    srv.append("dev-a", STREAM_HOT, encodeBlobOps([rateSet("CHF", "41000")]));

    const resumed = new Client({ store, server: srv.url, writerId: "dev-a" });
    const err = await new Outbox(resumed).flush().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainBreakError);
    expect((err as Error).message).toMatch(/above the 1 it has ever authored/);
  });

  test("the in-flight record survives a state round trip, including its op ids", () => {
    const s = emptyClientState("http://x");
    s.inflight = [
      { counter: 7n, hash: new Uint8Array(32).fill(3), opIds: ["a", "b"] },
      { counter: 8n, hash: new Uint8Array(32).fill(4), opIds: ["c"] },
    ];
    const back = decodeState(JSON.parse(JSON.stringify(encodeState(s))) as unknown, "test");
    expect(back.inflight).toEqual(s.inflight);

    // Absent means "no batch was in the air", which is the truth about a file
    // written by a build that never left one — not a default for an unknown.
    const older = encodeState(emptyClientState("http://x")) as unknown as Record<string, unknown>;
    delete older["inflight"];
    expect(decodeState(older, "test").inflight).toBeNull();

    const bad = encodeState(s) as unknown as { inflight: { op_ids: unknown }[] };
    bad.inflight[0]!.op_ids = [1, 2];
    expect(() => decodeState(bad, "test")).toThrow(/not an array of strings/);
  });
});

// ===========================================================================
// 3. Paging — an upload claims 8 positions, a backlog can be longer
// ===========================================================================

describe("paging", () => {
  /**
   * `n` ops each too big to share a blob, so ops and blobs are one to one.
   *
   * "Too big" means over half the top bucket, since that is what makes two of
   * them not fit together — 550 KB of random base64, which gzip cannot shrink.
   * Kept as close to that floor as it can be: these tests move real megabytes
   * through a real socket, and the cost is quadratic-ish because every push
   * re-folds the log.
   */
  function fillOutbox(c: Client, n: number): void {
    for (let i = 0; i < n; i++) {
      c.emit({
        type: "txn_edited",
        payload: { fields: { merchant_raw: incompressible(550_000) } },
        entity: { kind: "txn", id: `t${i}` },
        parentVersion: 1,
      });
    }
  }

  test("one push sends at most one upload's worth and reports the rest", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    fillOutbox(c, MAX_UPLOAD_BLOBS + 2);
    const report = await c.push();
    expect(report.blobs).toBe(MAX_UPLOAD_BLOBS);
    expect(report.remaining).toBeGreaterThan(0);
    expect(c.pending.length).toBe(report.remaining);
  }, 30_000);

  test("flush drains a backlog bigger than one upload, in contiguous pages", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(c);
    fillOutbox(c, 11);
    const report = await outbox.flush();

    expect(report.stopped).toBe("drained");
    expect(outbox.queued).toBe(0);
    // 11 blobs: each 550 KB op fills its own, and the checkpoint this first
    // push emits on seeing a roster is small enough to share the last. 8 + 3.
    expect(report.pages).toBe(2);
    expect(report.blobs).toBe(11);
    expect(report.sent).toBe(12);
    expect(srv.rows.filter((r) => r.writer_id === "dev-a").map((r) => r.writer_counter)).toEqual(
      Array.from({ length: 11 }, (_, i) => BigInt(i + 1)),
    );
    expect(duplicates(foldedOpIds(c))).toEqual([]);
    expect(c.check().filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  }, 60_000);

  test("the page loop keeps going past a second page, and stops when the queue is empty", async () => {
    // Three pages, against a `Pusher`: the real client's page costs a megabyte
    // of random bytes through a socket, so proving the LOOP with real blobs
    // caps out at two pages and "did exactly two" is not the property. This is
    // the arithmetic, over more pages than a special case would cover.
    const plan: PushReport[] = [
      { blobs: 8, ops: 8, seqs: [], checkpointed: true, remaining: 9 },
      { blobs: 8, ops: 8, seqs: [], checkpointed: false, remaining: 1 },
      { blobs: 1, ops: 1, seqs: [], checkpointed: false, remaining: 0 },
    ];
    let queue = 17;
    const paged: Pusher = {
      get pending(): readonly Op[] {
        return Array.from({ length: queue }, () => fixedOp("rate_set", { currency: "USD", rate_micro: "1" }));
      },
      emit: () => {
        throw new Error("not used");
      },
      push: () => {
        const next = plan.shift();
        if (next === undefined) throw new Error("the loop asked for a fourth page");
        queue = next.remaining;
        return Promise.resolve(next);
      },
    };
    const report = await new Outbox(paged).flush();
    expect(report.pages).toBe(3);
    expect(report.sent).toBe(17);
    expect(report.blobs).toBe(17);
    expect(report.queued).toBe(0);
    expect(report.stopped).toBe("drained");
    expect(plan).toHaveLength(0);
  });

  test("a paged push that dies before its checkpoint page records no attestation", async () => {
    // The checkpoint is appended to the END of the outbox, so on a paged push it
    // rides the LAST page. Recording "this device has attested those heads" when
    // an earlier page succeeded would be recording an attestation still sitting
    // in the outbox — and because the gate is "have the heads changed since I
    // last attested", the next push would then see no change and never write the
    // checkpoint at all.
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(c);
    fillOutbox(c, MAX_UPLOAD_BLOBS + 1);

    const first = await c.push();
    expect(first.blobs).toBe(MAX_UPLOAD_BLOBS);
    expect(first.checkpointed).toBe(false);
    expect(first.remaining).toBeGreaterThan(0);
    srv.refuseUploads = true;
    await expect(outbox.flush()).rejects.toThrow(/503/);

    // Nothing claims an attestation, so the repair is still owed and still
    // reachable.
    srv.refuseUploads = false;
    const rest = await outbox.flush();
    expect(rest.stopped).toBe("drained");
    expect(c.state().checkpoints.length).toBeGreaterThan(0);
    expect(c.check().filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  }, 60_000);

  test("a full upload of top-bucket blobs fits the server's body cap", () => {
    // Measured rather than derived: the client pages on the blob count alone,
    // which is only safe because 8 of the biggest blobs cannot exceed 12 MiB.
    // Comparing two expressions computed from the same constant would prove
    // nothing, so this weighs an actual request body.
    const blob = b64(new Uint8Array(MAX_BUCKET));
    const body = JSON.stringify({
      writer_id: "dev-a",
      stream: STREAM_HOT,
      blobs: Array.from({ length: MAX_UPLOAD_BLOBS }, (_, i) => ({
        writer_counter: String(i + 1),
        prev_hash: GENESIS,
        blob_hash: GENESIS,
        type_flag: "edit",
        size_bucket: MAX_BUCKET,
        blob,
      })),
    });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThan(MAX_UPLOAD_BYTES);
  });

  test("a page that reports work left but moves nothing is refused, not looped on", async () => {
    // Against a `Pusher` rather than a `Client`, because the real client cannot
    // be made to do this: it clears exactly the ops it uploaded, so its queue
    // strictly shrinks. That is precisely why the guard needs a stand-in — a
    // loop whose termination rests on a remote party's report has to be checked
    // against the queue itself, and a check nobody has ever seen fire is a
    // check nobody knows works.
    let calls = 0;
    const stuck: Pusher = {
      pending: [fixedOp("rate_set", { currency: "USD", rate_micro: "1" })],
      emit: () => {
        throw new Error("not used");
      },
      push: () => {
        calls += 1;
        return Promise.resolve({ blobs: 1, ops: 1, seqs: [1n], checkpointed: false, remaining: 1 });
      },
    };
    await expect(new Outbox(stuck).flush()).rejects.toThrow(OutboxStalledError);
    // Once, not forever: the point is that it stops.
    expect(calls).toBe(1);
  });
});

// ===========================================================================
// 4. The flush guard rails
// ===========================================================================

describe("flush", () => {
  test("five concurrent flushes issue one page sequence", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(c);
    outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });

    const all = await Promise.all([outbox.flush(), outbox.flush(), outbox.flush(), outbox.flush(), outbox.flush()]);
    // Same promise, so the same result object — a second page sequence would
    // produce a second, differing report.
    for (const r of all) expect(r).toBe(all[0]!);
    expect(srv.requests.filter((p) => p === "POST /api/v1/sync")).toHaveLength(1);
  });

  test("a hard stop latches: the next flush throws it without touching the network", async () => {
    // The reviewer's scenario, driven through the outbox: dev-a authors to hot
    // counter 4, dev-b attests it, the server then truncates dev-a to a clean
    // prefix, and dev-c arrives. `chain_withheld` is the one condition of I11
    // that a push must NOT proceed over — proceeding replaces dev-b's honest
    // attestation with one claiming genesis, after which the truncation is a
    // notice nobody has to act on.
    const srv = serve({
      writers: [
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
        { writer_id: "dev-c", kind: "device", revoked_at: null },
      ],
    });
    const a = await loggedIn(srv, "dev-a");
    for (let i = 0; i < 4; i++) {
      a.emit({ type: "rate_set", payload: { currency: CODES[i]!, rate_micro: `${1_000_000 + i}` } });
      await a.push();
    }
    expect(srv.head("dev-a", STREAM_HOT).counter).toBe(4n);
    const b = await loggedIn(srv, "dev-b");
    b.emit({ type: "rate_set", payload: { currency: "ZAR", rate_micro: "200000" } });
    await b.push();
    expect(b.state().checkpoints.find((h) => h.writer_id === "dev-a" && h.stream === STREAM_HOT)?.counter).toBe(4n);
    srv.truncate("dev-a", STREAM_HOT, 2n);

    const c = await loggedIn(srv, "dev-c");
    const outbox = new Outbox(c);
    outbox.enqueue({ type: "rate_set", payload: { currency: "BRL", rate_micro: "700000" } });

    const uploadsBefore = srv.uploaded.length;
    const first = await outbox.flush().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/withholding rows a peer device has already witnessed/);
    // It wrote nothing. A device being withheld from has nothing trustworthy to
    // attest, so it authors no checkpoint at all.
    expect(srv.uploaded.length).toBe(uploadsBefore);
    expect(srv.rows.some((r) => r.writer_id === "dev-c")).toBe(false);

    expect(outbox.halted).toBe(first as Error);
    const before = srv.requests.length;
    await expect(outbox.flush()).rejects.toThrow((first as Error).message);
    expect(srv.requests.length).toBe(before);
    expect(outbox.queued).toBe(1);

    outbox.clearHalt();
    expect(outbox.halted).toBeNull();
  }, 30_000);

  test("a network failure is offline, not a halt: the ops stay queued and nothing latches", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(c);
    outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    srv.stop();

    const report = await outbox.flush();
    expect(report.stopped).toBe("offline");
    expect(report.offlineCause).toBeInstanceOf(Error);
    expect(outbox.halted).toBeNull();
    expect(outbox.queued).toBe(1);
  });

  test("an op is durable before enqueue returns", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const dir = mkdtempSync(join(tmpdir(), "ledger-outbox-"));
    const store = fileStore(dir, "durable");
    const c = await loggedIn(srv, "dev-a", store);
    const op = new Outbox(c).enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    // Read back through a SECOND store over the same files, i.e. what a fresh
    // process would see. Reading `c.pending` would only prove the array grew.
    expect(fileStore(dir, "durable").load().pending.map((o) => o.op_id)).toEqual([op.op_id]);
  });
});

// ===========================================================================
// 5. Checkpoints: the roster, the ingest chain, and truncation
// ===========================================================================

describe("a checkpoint names the roster, not the chains it has seen", () => {
  test("a brand-new account names the ingest writer's empty chains at counter 0", async () => {
    // The common path, not an edge case: `auth.UpsertUser` creates the ingest
    // writer with the user, so the roster holds it from the first sign-in and
    // its chain is empty until the first email arrives. A checkpoint built from
    // OBSERVED heads could not name it — there is nothing to observe — and
    // `I11` would then hard-stop this account forever with no checkpoint any
    // device could write to clear it.
    const srv = serve({
      writers: [
        { writer_id: INGEST, kind: "ingest", revoked_at: null },
        { writer_id: "dev-a", kind: "device", revoked_at: null },
      ],
    });
    const c = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(c);
    outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    const report = await outbox.flush();
    expect(report.stopped).toBe("drained");

    const named = c.state().checkpoints;
    expect(named.map((h) => `${h.writer_id}|${h.stream}`).sort()).toEqual([
      "dev-a|cold",
      "dev-a|hot",
      "ingest|cold",
      "ingest|hot",
    ]);
    for (const stream of [STREAM_HOT, STREAM_COLD] as const) {
      const h = named.find((x) => x.writer_id === INGEST && x.stream === stream);
      expect(h?.counter).toBe(0n);
      expect(h?.hash).toBe(GENESIS);
    }
    // A zero entry asserts nothing false: `0 > observed` is never true, so it
    // can hide no withheld row — and it is enough to satisfy coverage.
    expect(c.check(STREAM_HOT, srv.writers).filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  });

  test("a checkpoint attests the ingest chain once mail exists, on BOTH streams", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    seedIngest(srv, 3, { cold: true });
    const c = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(c);
    outbox.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await outbox.flush();

    const named = c.state().checkpoints;
    // Cold matters most: it is the chain the user's MAIL lands on, the one no
    // device can re-derive, and the one written by the party the threat model
    // declines to trust. A hot-only checkpoint attesting `ingest|cold: 0` while
    // three raw bodies sat there would satisfy coverage and assert nothing.
    expect(named.find((h) => h.writer_id === INGEST && h.stream === STREAM_HOT)?.counter).toBe(3n);
    expect(named.find((h) => h.writer_id === INGEST && h.stream === STREAM_COLD)?.counter).toBe(3n);
  });

  test("a truncated ingest chain behind an honest checkpoint is still detected", async () => {
    // The regression guard for the gap Phase 1 closed at `f0ac846`. Truncation
    // is a CLEAN PREFIX: contiguity holds, every hash is right, `verifyChain`
    // passes. The only thing that contradicts it is a checkpoint written while
    // the rows were still there.
    const srv = serve({
      writers: [
        { writer_id: INGEST, kind: "ingest", revoked_at: null },
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
      ],
    });
    seedIngest(srv, 4, { cold: true });
    const a = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(a);
    outbox.enqueue({ type: "rate_set", payload: { currency: "ZAR", rate_micro: "200000" } });
    await outbox.flush();
    // The bootstrap costs one round trip, and it is the documented ordering:
    // two device writers and no checkpoint is a hard stop, `pull` persists
    // nothing over one, and the escape lets the push through WITHOUT fresh
    // heads — so the first checkpoint claims 0 for everything and the second
    // one attests what the now-unblocked pull verified.
    expect(a.state().checkpoints.find((h) => h.writer_id === INGEST && h.stream === STREAM_HOT)?.counter).toBe(0n);
    outbox.enqueue({ type: "rate_set", payload: { currency: "MXN", rate_micro: "180000" } });
    await outbox.flush();
    expect(a.state().checkpoints.find((h) => h.writer_id === INGEST && h.stream === STREAM_HOT)?.counter).toBe(4n);
    expect(a.state().checkpoints.find((h) => h.writer_id === INGEST && h.stream === STREAM_COLD)?.counter).toBe(4n);

    // The server loses the last two emails — storage loss, a bad restore, a
    // partial drop. This is what an HONEST checkpoint buys, and all it buys:
    // Phase 2 blobs are plaintext, so a server that truncated AND rewrote the
    // attesting checkpoint stays undetectable until Phase 3 seals them.
    srv.truncate(INGEST, STREAM_HOT, 2n);

    const b = await loggedIn(srv, "dev-b");
    const err = await b.pull().catch((e: unknown) => e);
    const stops = (err as { violations?: { id: string; kind?: string; severity: string }[] }).violations?.filter(
      (v) => v.severity === "hard_stop",
    );
    expect(stops?.map((v) => v.kind)).toContain("chain_withheld");
    expect(stops?.every((v) => v.id === "I11_roster_checkpoint")).toBe(true);
  });

  test("pinned cold hashes with no bodies downloaded are not a withheld chain", async () => {
    // Spec §3.3:70's normal state: the cold stream is lazily synced behind a
    // rolling window, so a healthy device has pinned every cold hash and pulled
    // almost no cold bodies. Counting bodies rather than pinned hashes made
    // that read as the server withholding a chain a peer had witnessed — a hard
    // stop, on the ordinary path.
    const srv = serve({
      writers: [
        { writer_id: INGEST, kind: "ingest", revoked_at: null },
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
      ],
    });
    seedIngest(srv, 4, { cold: true });
    const a = await loggedIn(srv, "dev-a");
    const outbox = new Outbox(a);
    outbox.enqueue({ type: "rate_set", payload: { currency: "ZAR", rate_micro: "200000" } });
    await outbox.flush();

    // dev-b pins the cold hash list and downloads no cold body at all.
    const b = await loggedIn(srv, "dev-b");
    await b.pullColdHashes();
    await b.pull();
    expect(b.cursor(STREAM_COLD)).toBe(0n);
    expect(b.check(STREAM_HOT, srv.writers).filter((v) => v.severity === "hard_stop")).toHaveLength(0);
  });
});

// ===========================================================================
// 6. Airplane mode: two devices, one parent, one fork notice
// ===========================================================================

describe("airplane mode", () => {
  test("two offline writers on the same parent converge, with exactly one fork notice", async () => {
    const srv = serve({
      writers: [
        { writer_id: INGEST, kind: "ingest", revoked_at: null },
        { writer_id: "dev-a", kind: "device", revoked_at: null },
        { writer_id: "dev-b", kind: "device", revoked_at: null },
      ],
    });
    srv.append(INGEST, STREAM_HOT, encodeBlobOps([txnIngested("t1", "b".repeat(64))]));

    // A checkpoint has to exist before a second device can finish a sync: a
    // multi-device account hard-stops until one lands, and enrolment and the
    // first checkpoint are strictly ordered because of it. That is the rule
    // working, not a bug, and it is why dev-a pushes first.
    const a = await loggedIn(srv, "dev-a");
    const outboxA = new Outbox(a);
    outboxA.enqueue({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await outboxA.flush();

    const b = await loggedIn(srv, "dev-b");
    const outboxB = new Outbox(b);
    await b.pull();
    expect(a.state().txns.get("t1")?.version).toBe(1);
    expect(b.state().txns.get("t1")?.version).toBe(1);

    // Both go offline and both categorize the same transaction against version
    // 1. Separated by ≥5 ms deliberately: `authored_at` is milliseconds, and a
    // tie falls through to a `writer_id` comparison, which would make the
    // winner depend on how fast the machine is.
    const loser = outboxA.enqueue({
      type: "txn_categorized",
      payload: { category: "groceries" },
      entity: { kind: "txn", id: "t1" },
      parentVersion: 1,
    });
    await Bun.sleep(10);
    const winner = outboxB.enqueue({
      type: "txn_categorized",
      payload: { category: "dining" },
      entity: { kind: "txn", id: "t1" },
      parentVersion: 1,
    });
    expect(Date.parse(winner.authored_at) - Date.parse(loser.authored_at)).toBeGreaterThanOrEqual(5);

    // Reconnect, in the order that puts the LOSER on the log first — the harder
    // half, because the winner has to displace a value already materialized.
    await outboxA.flush();
    await outboxB.flush();
    await a.pull();

    for (const [name, c] of [
      ["dev-a", a],
      ["dev-b", b],
    ] as const) {
      const s = c.state();
      expect(`${name}:${s.txns.get("t1")?.category}`).toBe(`${name}:dining`);
      expect(`${name}:${s.forks.length}`).toBe(`${name}:1`);
      expect(`${name}:${s.forks[0]?.winner_op}`).toBe(`${name}:${winner.op_id}`);
      expect(`${name}:${s.forks[0]?.loser_op}`).toBe(`${name}:${loser.op_id}`);
      expect(`${name}:${s.forks[0]?.entity.id}`).toBe(`${name}:t1`);
    }
    // Converged, and not merely "both non-empty": the two devices' folds agree
    // op for op.
    expect(foldedOpIds(a)).toEqual(foldedOpIds(b));
    expect(duplicates(foldedOpIds(a))).toEqual([]);
  }, 30_000);
});
