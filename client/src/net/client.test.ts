import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";

import { Client, HardStopError, decodeWireRow, registrationMessage } from "./client";
import { memStore, type WireRow } from "../store/store";
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

  /** Appends a blob to a chain, sealing and chaining it honestly. */
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

  /** Rows a pull may see: `dropWriterCounter` is withheld here and nowhere else. */
  private visible(stream: Stream): FakeRow[] {
    return this.rows.filter(
      (r) =>
        r.stream === stream &&
        !(this.opts.dropWriterCounter !== undefined && r.stream === STREAM_HOT && r.writer_id === "ingest" && r.writer_counter === this.opts.dropWriterCounter),
    );
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
      const all = this.visible(stream).filter((r) => r.seq > after);
      const page = all.slice(0, limit);
      const last = page[page.length - 1];
      const next = last === undefined ? after : last.seq;
      const maxSeq = this.visible(stream).reduce((m, r) => (r.seq > m ? r.seq : m), 0n);
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
      // reachable against a server that appends atomically.
      this.dropNextUploadResponse = false;
      return this.json({ error: "internal" }, 500);
    }
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

/** Seeds `n` hot ingest blobs, optionally interleaving cold ones. */
function seedIngest(srv: FakeServer, n: number, opts: { cold?: boolean; corruptAt?: bigint } = {}): void {
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
  const c = new Client({ store: memStore(), server: srv.url, ...(writerId === undefined ? {} : { writerId }) });
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

  test("a roster that has not changed does not produce a second checkpoint", async () => {
    const srv = serve({ writers: [{ writer_id: "dev-a", kind: "device", revoked_at: null }] });
    const c = await loggedIn(srv, "dev-a");
    c.emit({ type: "rate_set", payload: { currency: "USD", rate_micro: "3672500" } });
    await c.push();
    c.emit({ type: "rate_set", payload: { currency: "EUR", rate_micro: "3900000" } });
    const second = await c.push();
    expect(second.checkpointed).toBe(false);
    expect(second.ops).toBe(1);
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
});

describe("state", () => {
  test("a hard stop leaves the store byte-identical to what it was", async () => {
    const srv = serve();
    seedIngest(srv, 2);
    const store = memStore();
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
