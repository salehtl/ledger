import { useEffect, useState } from "react";
import { Button, SafeAreaView, ScrollView, Text } from "react-native";
import { RECORD_SIZE, derivePub, hexToBytes, openBlob } from "./crypto";
import { SERVER, RECIPIENT_PRIV_HEX } from "./config";
import { Op, bucketDebits, insertOps, openDb, resetDb } from "./replay";

// CHUNK_SIZE: records processed per decrypt -> decode -> insert cycle during
// cold restore. Chunking bounds peak memory: only one chunk's decrypted
// buffers and parsed ops are ever reachable at once, instead of ~3,683
// decrypted buffers AND ~3,683 op objects all alive simultaneously (see
// task-3c-brief.md). 250 is a starting point; tune here if the on-device
// measurement wants a different memory/overhead tradeoff.
const CHUNK_SIZE = 250;
const CHUNK_BYTES = CHUNK_SIZE * RECORD_SIZE;

// LOG_CAP: the on-screen log is capped so that running the 3-cold + 3-warm
// measurement protocol repeatedly cannot grow the log array (and the
// ScrollView/DOM it drives) without bound.
const LOG_CAP = 50;

// dbOpenMs: connection-open + CREATE TABLE, inside the measured window (it
// used to run before t0 and was silently excluded from a measurement whose
// whole purpose is the cold-restore total).
// decryptMs / decodeMs: crypto-only vs decode+parse-only, each summed across
// chunks (see CHUNK_SIZE above) but still isolated from one another so the
// Phase 0 decision rule can tell whether decrypt itself dominates, rather
// than a window that silently mixed crypto with string/JSON work.
// yieldMs: totalMs minus the summed stage times below. totalMs stays
// wall-clock for the whole restore (it's the number the <10s gate is judged
// against, and a real app pays repaint costs too) but yieldMs makes the
// event-loop-yield / GC-breathing-room overhead visible instead of letting
// it silently vanish into whichever stage happened to run last.
type Timings = {
  dbOpenMs: number;
  fetchMs: number;
  decryptMs: number;
  decodeMs: number;
  insertMs: number;
  computeMs: number;
  yieldMs: number;
  totalMs: number;
};

// Best-effort memory sample. `performance.memory` is a V8/JSC extension that
// Hermes does not reliably provide; `HermesInternal.getInstrumentedStats()`
// is the closest on-device signal Hermes actually exposes. Returns null
// (never a fabricated number) when neither is available, so callers can
// print an explicit "unavailable" rather than imply memory was measured
// when it wasn't.
function sampleMemory(): string | null {
  const perfMem = (globalThis as any).performance?.memory;
  if (perfMem && typeof perfMem.usedJSHeapSize === "number") {
    const used = (perfMem.usedJSHeapSize / 1e6).toFixed(1);
    const total = perfMem.totalJSHeapSize != null ? (perfMem.totalJSHeapSize / 1e6).toFixed(1) : "?";
    return `usedJSHeapSize=${used}MB totalJSHeapSize=${total}MB`;
  }
  const stats = (globalThis as any).HermesInternal?.getInstrumentedStats?.();
  if (stats && typeof stats === "object" && Object.keys(stats).length > 0) {
    return JSON.stringify(stats);
  }
  return null;
}

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const [warmMs, setWarmMs] = useState<number | null>(null);
  const say = (s: string) => setLog((l) => [...l, s].slice(-LOG_CAP));

  useEffect(() => {
    // Warm-start measurement: data already in SQLite from a prior cold restore.
    const t0 = performance.now();
    const db = openDb();
    const n = db.getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")?.n ?? 0;
    if (n > 0) {
      bucketDebits(db);
      setWarmMs(performance.now() - t0);
    }
  }, []);

  async function coldRestore() {
    const t0 = performance.now();
    const memBefore = sampleMemory();
    const priv = hexToBytes(RECIPIENT_PRIV_HEX);
    const recipPub = derivePub(priv); // derived once, not per record — see crypto.ts
    const db = openDb();
    resetDb(db);
    const t1 = performance.now();
    const dbOpenMs = t1 - t0;

    const manifest = await (await fetch(`${SERVER}/manifest.json`)).json();
    const buf = new Uint8Array(await (await fetch(`${SERVER}/all.bin`)).arrayBuffer());
    const t2 = performance.now();
    const fetchMs = t2 - t1;

    // Chunked cold restore: for each CHUNK_SIZE-record slice of the corpus,
    // decrypt -> decode+parse -> insert -> yield, then let the chunk's
    // arrays fall out of scope so nothing beyond one chunk's worth of
    // decrypted buffers/ops is ever reachable at once. The two-pass
    // decrypt-then-decode split is preserved *within* each chunk so
    // decryptMs stays crypto-only, isolated from decode/JSON-parse cost.
    const dec = new TextDecoder();
    let decryptMs = 0;
    let decodeMs = 0;
    let insertMs = 0;
    let opsCount = 0;

    for (let chunkStart = 0; chunkStart < buf.length; chunkStart += CHUNK_BYTES) {
      const chunkEnd = Math.min(chunkStart + CHUNK_BYTES, buf.length);

      const ta = performance.now();
      const plains: Uint8Array[] = [];
      for (let off = chunkStart; off < chunkEnd; off += RECORD_SIZE) {
        plains.push(openBlob(buf.subarray(off, off + RECORD_SIZE), priv, recipPub));
      }
      const tb = performance.now();
      decryptMs += tb - ta;

      const ops: Op[] = [];
      for (const p of plains) ops.push(JSON.parse(dec.decode(p)));
      const tc = performance.now();
      decodeMs += tc - tb;

      // Own transaction per chunk (see report: task-3c) — insertOps wraps
      // this call in db.withTransactionSync internally, so each chunk
      // commits before the yield below rather than holding a transaction
      // open across an awaited event-loop tick.
      insertOps(db, ops);
      const td = performance.now();
      insertMs += td - tc;
      opsCount += ops.length;

      // plains/ops are block-scoped to this iteration and become
      // unreachable once it ends — nothing further to release explicitly.

      // Yield to the event loop between chunks: the whole restore used to
      // be one synchronous block, so the UI couldn't repaint (JS FPS read
      // 0) and the GC never got a chance to run.
      await new Promise((r) => setTimeout(r, 0));
    }
    const t5 = performance.now();

    const computed = bucketDebits(db);
    const t6 = performance.now();
    const computeMs = t6 - t5;
    const memAfterCompute = sampleMemory();

    const totalMs = t6 - t0;
    const stageSum = dbOpenMs + fetchMs + decryptMs + decodeMs + insertMs + computeMs;
    const yieldMs = totalMs - stageSum;

    const t: Timings = { dbOpenMs, fetchMs, decryptMs, decodeMs, insertMs, computeMs, yieldMs, totalMs };
    say(`ops=${opsCount}/${manifest.count}  ` + JSON.stringify(t));

    if (opsCount !== manifest.count) {
      say(`COUNT MISMATCH: decrypted ${opsCount} ops but manifest declares ${manifest.count}`);
    }

    if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) {
      say(`NO CHECKS: manifest.checks is empty — nothing was verified against expected bucket totals`);
    }

    for (const check of manifest.checks) {
      const got = computed[check.month] ?? {};
      const ok = Object.entries(check.bucket_debits).every(([b, v]) => got[b] === v)
        && Object.keys(got).length === Object.keys(check.bucket_debits).length;
      say(`${check.month}: ${ok ? "MATCH" : `MISMATCH got=${JSON.stringify(got)} want=${JSON.stringify(check.bucket_debits)}`}`);
    }

    const memEnd = sampleMemory();
    if (memBefore === null && memAfterCompute === null && memEnd === null) {
      say("memory: unavailable");
    } else {
      say(`memory: before=${memBefore ?? "unavailable"} afterCompute=${memAfterCompute ?? "unavailable"} end=${memEnd ?? "unavailable"}`);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text>warm start: {warmMs === null ? "no data yet (run cold restore, then relaunch)" : `${warmMs.toFixed(0)}ms`}</Text>
      <Button title="Cold Restore" onPress={() => coldRestore().catch((e) => say(String(e)))} />
      <Button title="Reset DB" onPress={() => resetDb(openDb())} />
      <ScrollView>{log.map((l, i) => <Text key={i} selectable>{l}</Text>)}</ScrollView>
    </SafeAreaView>
  );
}
