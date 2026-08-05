import { describe, expect, test } from "bun:test";

import type { SyncRow } from "@ledger/client/invariants/check.ts";
import { memStore, type WireRow } from "@ledger/client/store/store.ts";
import { STREAM_COLD, sealBlob } from "@ledger/client/wire/blob.ts";
import { encodeRawBody } from "@ledger/client/wire/op.ts";
import { memoryColdBodyIndex } from "../db/coldIndex.ts";

import { COLD_WINDOW_DAYS, RollingColdSync, type ColdProgress } from "./cold.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const INGEST = "a".repeat(64);
const DAY = 86_400_000;

function wire(seq: bigint, createdAt: string, ingestId = INGEST, raw = new Uint8Array([1, 2, 3])): WireRow {
  const blob = sealBlob(
    { userId: USER, stream: STREAM_COLD, writerId: "ingest", writerCounter: seq },
    encodeRawBody({ ingest_id: ingestId, received_at: createdAt, raw }),
  );
  let binary = "";
  for (const byte of blob) binary += String.fromCharCode(byte);
  return {
    seq: seq.toString(),
    stream: STREAM_COLD,
    writer_id: "ingest",
    writer_counter: seq.toString(),
    type_flag: "ingest",
    size_bucket: blob.length,
    blob_hash: "0".repeat(64),
    prev_hash: "0".repeat(64),
    created_at: createdAt,
    blob: btoa(binary),
  };
}

class FakeClient {
  readonly userId = USER;
  readonly calls: string[] = [];
  pages: SyncRow[][] = [];
  cursor = 41n;
  hashPosition = 73n;
  hashCancellation: (() => boolean) | undefined;

  async pullColdHashes(opts?: { cancelled?: () => boolean }) {
    this.calls.push("pin");
    this.hashCancellation = opts?.cancelled;
    return { pinned: 7 };
  }

  hashCursor(_stream: "cold") {
    return this.hashPosition;
  }

  async pullColdRange(opts: { fromSeq: bigint; toSeq: bigint; onPage?: (rows: readonly SyncRow[]) => void | Promise<void>; onPersisted?: (rows: readonly SyncRow[]) => void | Promise<void> }) {
    this.calls.push(`range:${opts.fromSeq}-${opts.toSeq}`);
    let rows = 0;
    for (const page of this.pages) {
      await opts.onPage?.(page);
      await opts.onPersisted?.(page);
      rows += page.length;
    }
    return { pages: this.pages.length, rows };
  }
}

function setup() {
  const store = memStore();
  return { rows: store.rows(), client: new FakeClient(), index: memoryColdBodyIndex() };
}

describe("RollingColdSync", () => {
  test("pins hashes before requesting any body and reports page progress", async () => {
    const { rows, client, index } = setup();
    client.pages = [[{ seq: 10n } as SyncRow, { seq: 11n } as SyncRow], [{ seq: 12n } as SyncRow]];
    const progress: ColdProgress[] = [];
    const cold = new RollingColdSync({ client, rows, index, onProgress: (p) => progress.push(p) });

    expect(await cold.fetchRange(10n, 12n)).toBe(3);
    expect(client.calls).toEqual(["pin", "range:10-12"]);
    expect(progress.map(({ pages, rows }) => ({ pages, rows }))).toEqual([
      { pages: 1, rows: 2 },
      { pages: 2, rows: 3 },
    ]);
    expect(progress.map(({ fromSeq, toSeq }) => [fromSeq, toSeq])).toEqual([[10n, 12n], [10n, 12n]]);
  });

  test("range access cannot corrupt either Client cursor", async () => {
    const { rows, client, index } = setup();
    const cold = new RollingColdSync({ client, rows, index });
    await cold.fetchRange(3n, 9n);
    expect({ body: client.cursor, hashes: client.hashPosition }).toEqual({ body: 41n, hashes: 73n });
  });

  test("reads a cached body without a network request", async () => {
    const { rows, client, index } = setup();
    rows.append(STREAM_COLD, [wire(4n, "2026-08-01T00:00:00.000Z", INGEST, new Uint8Array([9, 8]))]);
    const cold = new RollingColdSync({ client, rows, index });
    expect(await cold.fetchBody(INGEST)).toEqual(new Uint8Array([9, 8]));
    expect(client.calls).toEqual([]);
  });

  test("rebuilds the production index from genesis on a cache miss and still pins first", async () => {
    const { rows, client, index } = setup();
    const fetched = wire(8n, "2026-08-01T00:00:00.000Z");
    client.pages = [[{ ...fetched, seq: 8n, writer_counter: 8n, blob: Uint8Array.from(atob(fetched.blob), (c) => c.charCodeAt(0)), blob_hash: new Uint8Array(32), prev_hash: new Uint8Array(32) } as SyncRow]];
    // The real Client persists after onPage. Model that boundary in the fake.
    const original = client.pullColdRange.bind(client);
    client.pullColdRange = async (opts) => {
      const result = await original(opts);
      rows.append(STREAM_COLD, [fetched]);
      return result;
    };
    client.hashPosition = 8n;
    const cold = new RollingColdSync({ client, rows, index });

    expect(await cold.fetchBody(INGEST)).toEqual(new Uint8Array([1, 2, 3]));
    expect(client.calls).toEqual(["pin", "range:1-8"]);
    expect(index.get(INGEST)).toBe(8n);
  });

  test("an append failure publishes no dangling ingest index entry", async () => {
    const { rows, client, index } = setup();
    const fetched = wire(8n, "2026-08-01T00:00:00.000Z");
    const page = [{
      ...fetched,
      seq: 8n,
      writer_counter: 8n,
      blob: Uint8Array.from(atob(fetched.blob), (c) => c.charCodeAt(0)),
      blob_hash: new Uint8Array(32),
      prev_hash: new Uint8Array(32),
    } as SyncRow];
    client.pullColdRange = async (opts) => {
      await opts.onPage?.(page);
      // Models RowStore.append throwing: onPersisted is never reached.
      throw new Error("append failed");
    };
    const cold = new RollingColdSync({ client, rows, index });
    await expect(cold.fetchRange(8n, 8n)).rejects.toThrow("append failed");
    expect(rows.count(STREAM_COLD)).toBe(0);
    expect(index.get(INGEST)).toBeNull();
  });

  test("prunes only the old prefix, retaining the boundary and newer bodies", () => {
    const { rows, client, index } = setup();
    const now = Date.parse("2026-08-03T00:00:00.000Z");
    const cutoff = now - COLD_WINDOW_DAYS * DAY;
    rows.append(STREAM_COLD, [
      wire(1n, new Date(cutoff - 1).toISOString(), "1".repeat(64)),
      wire(2n, new Date(cutoff).toISOString(), "2".repeat(64)),
      wire(3n, new Date(cutoff + DAY).toISOString(), "3".repeat(64)),
    ]);
    new RollingColdSync({ client, rows, index, now: () => now }).prune();
    expect(rows.range(STREAM_COLD, 0n, 10).map((r) => r.seq)).toEqual(["2", "3"]);
  });

  test("pruning bodies never invokes hash pinning or mutates client cursors", () => {
    const { rows, client, index } = setup();
    rows.append(STREAM_COLD, [wire(1n, "2020-01-01T00:00:00.000Z")]);
    new RollingColdSync({ client, rows, index, now: () => Date.parse("2026-08-03T00:00:00.000Z") }).prune();
    expect(rows.count(STREAM_COLD)).toBe(0);
    expect(client.calls).toEqual([]);
    expect({ body: client.cursor, hashes: client.hashPosition }).toEqual({ body: 41n, hashes: 73n });
  });

  test("an unreadable cached row is set aside and does not hide a later valid body", async () => {
    const { rows, client, index } = setup();
    const bad = wire(1n, "2026-08-01T00:00:00.000Z", "b".repeat(64));
    bad.blob = btoa("not a framed blob");
    rows.append(STREAM_COLD, [bad, wire(2n, "2026-08-01T00:00:00.000Z", INGEST, new Uint8Array([7]))]);
    const unreadable: bigint[] = [];
    const cold = new RollingColdSync({ client, rows, index, onUnreadable: (seq) => unreadable.push(seq) });
    expect(await cold.fetchBody(INGEST)).toEqual(new Uint8Array([7]));
    expect(unreadable).toEqual([1n]);
  });

  test("the requested ingest id is used for the durable index lookup", async () => {
    const { rows, client } = setup();
    const asked: string[] = [];
    const base = memoryColdBodyIndex();
    const index = { ...base, get: (id: string) => (asked.push(id), base.get(id)) };
    client.hashPosition = 0n;
    const wanted = "c".repeat(64);
    await new RollingColdSync({ client, rows, index }).fetchBody(wanted);
    expect(asked).toEqual([wanted]);
  });

  test("a cache miss threads cancellation through hash pinning before body paging", async () => {
    const { rows, client, index } = setup();
    let stop = false;
    client.pullColdHashes = async (opts) => {
      client.calls.push("pin");
      client.hashCancellation = opts?.cancelled;
      stop = true;
      return { pinned: 1 };
    };
    const cold = new RollingColdSync({ client, rows, index });
    expect(await cold.fetchBody(INGEST, () => stop)).toBeNull();
    expect(client.hashCancellation?.()).toBe(true);
    expect(client.calls).toEqual(["pin"]);
  });
});
