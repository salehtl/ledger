import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bunDriver, type SqlDriver } from "../store/driver";
import { sqliteStore } from "../store/sqlite";
import { memSecretStore, memStore, type RowStore, type WireRow } from "../store/store";
import { fold, type LogEntry } from "./replay";
import { serializeState } from "./state";
import {
  SNAPSHOT_FIELDS,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_VERSION,
  loadSnapshot,
  readEvents,
  readSnapshot,
  saveSnapshot,
  snapshotBytes,
  type LogBinding,
  rowStoreBinding,
} from "./snapshot";
import type { Op, OpType } from "../wire/op";

const open: SqlDriver[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

function db(): SqlDriver {
  const d = bunDriver(join(mkdtempSync(join(tmpdir(), "ledger-snapshot-")), "test.db"));
  open.push(d);
  return d;
}

function binding(tips: Map<bigint, string>, probes?: bigint[]): LogBinding {
  return {
    tipAt(seq) {
      probes?.push(seq);
      return tips.get(seq) ?? null;
    },
    rows: () => tips.size,
  };
}

function entry(n: number, type: OpType, payload: unknown): LogEntry {
  const op: Op = {
    v: 1,
    type,
    op_id: `op-${n}`,
    authored_at: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
    parent_version: null,
    payload,
  };
  return { seq: BigInt(n), writer_id: "dev-a", op };
}

const LOG: LogEntry[] = [
  entry(1, "home_currency_set", { currency: "AED" }),
  entry(2, "rate_set", { currency: "USD", rate_micro: "3672500" }),
  entry(3, "rate_set", { currency: "EUR", rate_micro: "4100000" }),
  entry(4, "rate_unset", { currency: "EUR" }),
  entry(5, "writer_checkpoint", { heads: [{ writer_id: "dev-a", stream: "hot", counter: "4", hash: "ab".repeat(32) }] }),
];

const TIPS = new Map(LOG.map((e) => [e.seq, `tip-${e.seq}`]));

function wire(seq: bigint): WireRow {
  return {
    seq: seq.toString(10), stream: "hot", writer_id: "dev-a",
    writer_counter: seq.toString(10), type_flag: "edit", size_bucket: 1024,
    blob_hash: `${Number(seq) % 10}`.repeat(64), prev_hash: "0".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z", blob: "QUJDRA==",
  };
}

function bindingRows(kind: "memory" | "sqlite"): RowStore {
  if (kind === "memory") return memStore("http://snapshot.test").rows();
  return sqliteStore(db(), { secrets: memSecretStore() }).rows();
}

describe("device-local fold snapshot", () => {
  test("save then load reproduces the canonical state and revives bigint fields", () => {
    const d = db();
    const state = fold(LOG);
    state.cursors.cold = 17n;
    state.appliedAtCursor.add("same-seq-op");
    saveSnapshot(d, state, state.cursors, binding(TIPS));

    const loaded = loadSnapshot(d, binding(TIPS));
    expect(loaded).not.toBeNull();
    expect(serializeState(loaded!.state)).toBe(serializeState(state));
    expect(loaded!.state.appliedAtCursor).toEqual(state.appliedAtCursor);
    expect(typeof loaded!.state.cursors.hot).toBe("bigint");
    expect(typeof loaded!.state.rates.get("USD")).toBe("bigint");
    expect(snapshotBytes(d)).toBeLessThan(SNAPSHOT_MAX_BYTES);
    expect(new Set(SNAPSHOT_FIELDS)).toEqual(new Set(Object.keys(state) as (keyof typeof state)[]));
  });

  test("the load ceiling measures UTF-8 bytes, not JavaScript code units", () => {
    const d = db();
    const state = fold(LOG);
    state.anomalies.push({ kind: "unicode", detail: "💰".repeat(50), at_seq: 5n });
    saveSnapshot(d, state, state.cursors, binding(TIPS));
    const payload = d.prepare("SELECT state_json, applied_json FROM fold_snapshot WHERE id = 1").all()[0] as {
      state_json: string; applied_json: string;
    };
    const expected = new TextEncoder().encode(payload.state_json).byteLength + new TextEncoder().encode(payload.applied_json).byteLength;
    expect(snapshotBytes(d)).toBe(expected);
    expect(loadSnapshot(d, binding(TIPS))?.bytes).toBe(expected);
    expect(expected).toBeGreaterThan(payload.state_json.length + payload.applied_json.length);
  });

  test("snapshot at five different cursors plus the suffix equals a fold from genesis", () => {
    const want = serializeState(fold(LOG));
    for (let cursor = 1; cursor <= 5; cursor++) {
      const d = db();
      const prefix = fold(LOG.slice(0, cursor));
      saveSnapshot(d, prefix, prefix.cursors, binding(TIPS));
      const loaded = loadSnapshot(d, binding(TIPS));
      expect(loaded).not.toBeNull();
      expect(serializeState(fold(LOG.slice(cursor), loaded!.state))).toBe(want);
    }
  });

  test("version mismatch is discarded before payload is read", () => {
    const d = db();
    const state = fold(LOG);
    saveSnapshot(d, state, state.cursors, binding(TIPS));
    d.prepare("UPDATE fold_snapshot SET version = ?, state_json = ? WHERE id = 1").run(SNAPSHOT_VERSION + 1, "payload-must-not-be-read");
    const probes: bigint[] = [];
    expect(loadSnapshot(d, binding(TIPS, probes))).toBeNull();
    expect(probes).toEqual([]);
    expect(d.prepare("SELECT id FROM fold_snapshot").all()).toEqual([]);
    expect(readEvents(d)[0]?.detail).toContain("version");
  });

  test("corrupt payload is discarded rather than shown", () => {
    const d = db();
    const state = fold(LOG);
    saveSnapshot(d, state, state.cursors, binding(TIPS));
    d.prepare("UPDATE fold_snapshot SET state_json = ? WHERE id = 1").run("{}");
    const verdict = readSnapshot(d, binding(TIPS));
    expect(verdict).toMatchObject({ reject: "corrupt" });
    expect(loadSnapshot(d, binding(TIPS))).toBeNull();
    expect(d.prepare("SELECT id FROM fold_snapshot").all()).toEqual([]);
  });

  test("load performs one O(1) tip probe and never scans the log", () => {
    const d = db();
    const state = fold(LOG);
    saveSnapshot(d, state, state.cursors, binding(TIPS));
    const probes: bigint[] = [];
    const loaded = loadSnapshot(d, binding(TIPS, probes));
    expect(loaded).not.toBeNull();
    expect(probes).toEqual([5n]);
    expect(loaded!.nodes).toBeGreaterThan(0);
  });

  for (const kind of ["memory", "sqlite"] as const) {
    test(`rowStoreBinding has exact-tip, gap, and prune semantics on ${kind}`, () => {
      const rows = bindingRows(kind);
      rows.append("hot", [wire(1n), wire(3n)]);
      const bound = rowStoreBinding(rows);
      expect(bound.tipAt(1n)).not.toBeNull();
      expect(bound.tipAt(2n)).toBeNull(); // must not bind to the next higher row
      expect(bound.tipAt(3n)).not.toBeNull();
      rows.prune("hot", 3n);
      expect(bound.tipAt(1n)).toBeNull();
      expect(bound.tipAt(3n)).not.toBeNull();
    });
  }

  test("snapshot code is not an input to any emitted op", () => {
    const root = join(import.meta.dir, "..");
    const emitters = [join(root, "net", "client.ts"), join(root, "outbox", "outbox.ts")];
    for (const path of emitters) {
      expect(readFileSync(path, "utf8")).not.toMatch(/from ["'][^"']*replay\/(snapshot|audit)["']/);
    }
  });
});
