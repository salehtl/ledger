import { expect, test } from "bun:test";
import { bunDriver } from "../store/driver";
import { memStore } from "../store/store";
import { emptyState } from "../replay/state";
import { rowStoreBinding, saveSnapshot } from "../replay/snapshot";
import { readMeta } from "../replay/projection";
import { STREAM_COLD, STREAM_HOT } from "../wire/blob";
import { SyncEngine } from "./engine";
import type { Client } from "./client";

test("SyncEngine loads a bound snapshot as the fold prefix and saves after projection", async () => {
  const db = bunDriver(":memory:");
  const rows = memStore().rows();
  rows.append(STREAM_HOT, [{
    seq: "1", stream: STREAM_HOT, writer_id: "ingest", writer_counter: "1", type_flag: "ingest",
    size_bucket: 256, blob_hash: "a".repeat(64), prev_hash: "0".repeat(64),
    created_at: "2026-08-03T00:00:00.000Z", blob: "A".repeat(256),
  }]);
  const prefix = emptyState();
  prefix.cursors.hot = 1n;
  saveSnapshot(db, prefix, { hot: 1n, cold: 0n }, rowStoreBinding(rows));
  let receivedPrefix = false;
  const client = {
    rows: () => rows,
    cursor: (stream: "hot" | "cold") => stream === STREAM_HOT ? 1n : 0n,
    reconcile: () => ({ rows: 0 }),
    pull: async () => ({ stream: STREAM_HOT, rows: 0, cursor: 1n, complete: true, violations: [] }),
    materializeChunked: async (opts: { initialState?: typeof prefix; afterSeq?: bigint }) => {
      receivedPrefix = opts.initialState === prefix || (opts.initialState?.cursors.hot === 1n && opts.afterSeq === 1n);
      return { state: opts.initialState ?? emptyState(), ops: null, opsApplied: 0, chunks: 0, rows: 0 };
    },
  } as unknown as Client;
  const engine = new SyncEngine(client, db, { yield: async () => {} });
  const result = await engine.sync({ push: false, stream: STREAM_HOT });
  expect(result.halted).toBe(false);
  expect(receivedPrefix).toBe(true);
  expect(client.cursor(STREAM_COLD)).toBe(0n);
  db.close();
});

test("quiesce waits for in-flight pull to reach the engine boundary", async () => {
  const db = bunDriver(":memory:");
  const rows = memStore().rows();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const client = {
    rows: () => rows,
    cursor: () => 0n,
    reconcile: () => ({ rows: 0 }),
    pull: async () => { await blocked; return { stream: STREAM_HOT, rows: 0, cursor: 0n, complete: true, violations: [] }; },
  } as unknown as Client;
  const engine = new SyncEngine(client, db, { yield: async () => {} });
  const sync = engine.sync({ push: false });
  let settled = false;
  const quiet = engine.quiesce("test teardown").then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await quiet;
  await sync;
  expect(settled).toBe(true);
  db.close();
});

test("SyncEngine audit refolds to the saved boundary and reprojects a mismatch", async () => {
  const db = bunDriver(":memory:");
  const rows = memStore().rows();
  rows.append(STREAM_HOT, [{
    seq: "1", stream: STREAM_HOT, writer_id: "ingest", writer_counter: "1", type_flag: "ingest",
    size_bucket: 256, blob_hash: "b".repeat(64), prev_hash: "0".repeat(64),
    created_at: "2026-08-03T00:00:00.000Z", blob: "B".repeat(256),
  }]);
  const stale = emptyState();
  stale.cursors.hot = 1n;
  saveSnapshot(db, stale, { hot: 1n, cold: 0n }, rowStoreBinding(rows));
  const truth = emptyState();
  truth.cursors.hot = 1n;
  truth.homeCurrency = "AED";
  let boundedAt: bigint | undefined;
  const client = {
    rows: () => rows,
    materializeChunked: async (opts: { upToSeq?: bigint }) => {
      boundedAt = opts.upToSeq;
      return { state: truth, ops: null, opsApplied: 0, chunks: 1, rows: 1 };
    },
  } as unknown as Client;
  const engine = new SyncEngine(client, db, { yield: async () => {} });
  const result = await engine.audit(() => ({ mainsPower: true, foreground: true, thermal: "nominal", busy: false }));
  expect(boundedAt).toBe(1n);
  expect(result.outcome).toBe("mismatch");
  expect(readMeta(db)?.homeCurrency).toBe("AED");
  db.close();
});
