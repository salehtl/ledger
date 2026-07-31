import { useEffect, useState } from "react";
import { Button, SafeAreaView, ScrollView, Text } from "react-native";
import { RECORD_SIZE, derivePub, hexToBytes, openBlob } from "./crypto";
import { SERVER, RECIPIENT_PRIV_HEX } from "./config";
import { Op, bucketDebits, getDb, insertOps, reopenDb, resetDb } from "./replay";

// CHUNK_SIZE: records processed per decrypt -> decode -> insert cycle during
// cold restore. Chunking bounds peak memory: only one chunk's decrypted
// buffers and parsed ops are ever reachable at once, instead of ~3,683
// decrypted buffers AND ~3,683 op objects all alive simultaneously (see
// spike/phase0/RESULTS.md, "Pre-fix catastrophic run", for the memory
// incident this design fixes). 250 is a starting point; tune here if the
// on-device measurement wants a different memory/overhead tradeoff.
const CHUNK_SIZE = 250;
const CHUNK_BYTES = CHUNK_SIZE * RECORD_SIZE;

// LOG_CAP: the on-screen log is capped so that running the 3-cold + 3-warm
// measurement protocol repeatedly cannot grow the log array (and the
// ScrollView/DOM it drives) without bound.
const LOG_CAP = 50;

// keyDeriveMs: hexToBytes + derivePub(priv) — a real X25519 scalar
// multiplication, i.e. genuine crypto cost, same class as decryptMs. Timed
// separately (once per cold restore, NOT summed per record like decryptMs —
// the recipient pub key is derived once and reused for every openBlob call,
// see crypto.ts) so it can't hide inside dbOpenMs.
//
// dbOpenMs: reopenDb() only — close-the-previous-connection (if any) +
// open-a-genuinely-fresh native connection + CREATE TABLE. Nothing else is
// in this window. It IS uniform across every cold-restore press, including
// the first: the warm-start effect below always opens the shared connection
// via getDb() on mount, before any button is pressable, so by the time
// "Cold Restore" is pressed for the first time there is already an open
// connection for reopenDb() to close — every press pays the same
// close+open+CREATE-TABLE cost. A shared/reopened connection exists at all
// because a bare per-press SQLite.openDatabaseSync() with no matching close
// was leaking a native connection on every press (Cold Restore AND Reset
// DB), memory outside the JS heap that no amount of chunking/GC can
// reclaim.
//
// resetMs: resetDb(db) — `DELETE FROM transactions` — split out from
// dbOpenMs because it is NOT uniform and is NOT a database-open cost: it
// deletes 0 rows on a press against an already-empty table (e.g. right
// after "Reset DB") and up to 3,683 rows otherwise, and expo-sqlite has no
// WAL mode configured here, so every DELETE pays a rollback-journal write +
// fsync. Whether the operator pressed "Reset DB" between runs moves this
// cost in or out of the window entirely — report it as its own field rather
// than let it distort dbOpenMs's meaning.
//
// decryptMs: crypto-only (shared-secret + AES-GCM + gunzip), summed across
// chunks (see CHUNK_SIZE above), isolated from decodeMs so the Phase 0
// decision rule can tell whether decrypt itself dominates.
//
// decodeMs: decode+JSON.parse only, summed across chunks. On SDK 54 / RN
// 0.81, global.TextDecoder is Expo's winter-runtime polyfill (a pure-JS
// fork of the `text-encoding` package: per record it round-trips the bytes
// through a plain-array handler loop and builds the string with per-code-
// point `String.fromCharCode` calls), one to two orders of magnitude slower
// than a native TextDecoder. decodeMs is therefore a known-slow stand-in in
// the SAME class as decryptMs, not a measurement of "real" decode cost — the
// architecture decision rule needs a branch for a dominant decodeMs, the
// same way it has one for decryptMs, or it will misread this as fetch/
// insert/compute dominating and fail the architecture on a polyfill artifact.
//
// yieldMs: totalMs minus the sum of every stage above. totalMs stays
// wall-clock for the whole restore (it's the number the <10s gate is judged
// against, and a real app pays repaint costs too) but yieldMs makes the
// event-loop-yield / GC-breathing-room overhead visible instead of letting
// it silently vanish into whichever stage happened to run last.
type Timings = {
  keyDeriveMs: number;
  dbOpenMs: number;
  resetMs: number;
  fetchMs: number;
  decryptMs: number;
  decodeMs: number;
  insertMs: number;
  computeMs: number;
  yieldMs: number;
  totalMs: number;
};

// Best-effort memory sample (single point-in-time reading, formatted for the
// log). On RN 0.81 (Expo SDK 54) / Hermes, `performance.memory` IS expected
// to be present — Hermes maps `usedJSHeapSize` -> `hermes_allocatedBytes`
// and `totalJSHeapSize` -> `hermes_heapSize` — so the `HermesInternal`
// fallback below is expected to be dead code on this stack; it is kept as a
// fallback, not relied upon. Returns null (never a fabricated number) when
// neither is available, so callers can print an explicit "unavailable"
// rather than imply memory was measured when it wasn't. Both figures are
// JS-heap-only: they will NOT reconcile with a device's total RSS (what the
// user's Expo perf overlay showed as >500 MB includes native allocations —
// the SQLite connection(s), the JS engine's own overhead, image/font caches,
// etc.) — do not equate a JS-heap number from this function with the RSS
// figure in the Phase 0 write-up.
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

// Raw numeric heap reading (MB) for per-chunk peak tracking below. Only
// reads `performance.memory` — the reliable numeric source on this stack
// per the comment above — deliberately not the HermesInternal fallback,
// which returns an arbitrary stats object with no guaranteed numeric field
// to max-track. Returns null if performance.memory isn't present.
function sampleHeapMB(): { used: number; total: number } | null {
  const perfMem = (globalThis as any).performance?.memory;
  if (perfMem && typeof perfMem.usedJSHeapSize === "number") {
    return {
      used: perfMem.usedJSHeapSize / 1e6,
      total: typeof perfMem.totalJSHeapSize === "number" ? perfMem.totalJSHeapSize / 1e6 : NaN,
    };
  }
  return null;
}

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const [warmMs, setWarmMs] = useState<number | null>(null);
  // Row count actually read during the warm-start measurement, plus the
  // manifest's expected count (fetched separately, see the effect below) so
  // the UI can flag a partial-corpus warm start as VOID. This exists
  // because per-chunk commits mean a force-quit or error mid-cold-restore
  // leaves a partial table durably in phase0.db —
  // and the protocol's warm phase is built on force-quitting. Without a row
  // count on screen, a warm-start reading over e.g. 2,000 rows is
  // indistinguishable from one over the full 3,683.
  const [warmRows, setWarmRows] = useState<number | null>(null);
  const [warmExpectedCount, setWarmExpectedCount] = useState<number | null>(null);
  // Guards against a double-press starting a second coldRestore() while one
  // is already in flight. This matters specifically because of reopenDb():
  // if two coldRestore() calls overlapped, the second's reopenDb() would
  // close the connection the first one is still mid-use with, turning a
  // double-tap into a hard "closed database" error instead of the old
  // behavior (two independently-leaked connections racing each other).
  // Also disables Reset DB while running, so it can't race a cold restore's
  // inserts via the same shared connection.
  const [isRunning, setIsRunning] = useState(false);
  const say = (s: string) => setLog((l) => [...l, s].slice(-LOG_CAP));

  useEffect(() => {
    // Warm-start measurement: data already in SQLite from a prior cold
    // restore. Deliberately reuses the shared connection (getDb()) rather
    // than forcing a fresh open — warm start is not meant to measure a
    // connection-open cost, cold restore already does that (see dbOpenMs
    // comment on Timings below).
    const t0 = performance.now();
    const db = getDb();
    const n = db.getFirstSync<{ n: number }>("SELECT COUNT(*) AS n FROM transactions")?.n ?? 0;
    if (n > 0) {
      bucketDebits(db);
      setWarmMs(performance.now() - t0); // timed window ends here; nothing below can inflate this figure
      setWarmRows(n);
      // Fetch the manifest purely to learn the expected row count for the
      // VOID indicator — deliberately AFTER warmMs is already captured, so
      // this network call can never be part of the number the <2s warm-
      // start gate is judged against. Best-effort: a failed fetch just
      // means no void/valid verdict is shown, not a broken warm-start figure.
      fetch(`${SERVER}/manifest.json`)
        .then((r) => r.json())
        .then((m) => setWarmExpectedCount(typeof m.count === "number" ? m.count : null))
        .catch(() => {});
    }
  }, []);

  async function coldRestore() {
    if (isRunning) return;
    setIsRunning(true);
    try {
      await runColdRestore();
    } catch (e) {
      say(String(e));
    } finally {
      setIsRunning(false);
    }
  }

  async function runColdRestore() {
    // Sampled before t0 (per review): its own tiny cost must not be folded
    // into any measured stage, and it should reflect memory truly "before
    // the run" rather than after work has already begun.
    const memBefore = sampleMemory();
    const t0 = performance.now();

    const priv = hexToBytes(RECIPIENT_PRIV_HEX);
    const recipPub = derivePub(priv); // X25519 scalar mult — real crypto; see keyDeriveMs comment on Timings
    const t1 = performance.now();
    const keyDeriveMs = t1 - t0;

    // reopenDb(), not getDb(): every cold-restore press closes whatever
    // connection is currently shared and opens a genuinely fresh one, so
    // dbOpenMs below is a real open cost on every press, and nothing leaks
    // across repeated presses (see replay.ts).
    const db = reopenDb();
    const t2 = performance.now();
    const dbOpenMs = t2 - t1;

    // Separate from dbOpenMs on purpose — see resetMs comment on Timings:
    // this DELETE is not a database-open cost and its size varies with
    // whatever was already in the table.
    resetDb(db);
    const t3 = performance.now();
    const resetMs = t3 - t2;

    const manifest = await (await fetch(`${SERVER}/manifest.json`)).json();
    const buf = new Uint8Array(await (await fetch(`${SERVER}/all.bin`)).arrayBuffer());
    const t4 = performance.now();
    const fetchMs = t4 - t3;

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

    // Per-chunk memory peak tracking (review M4): sampling only before the
    // run / after compute / at the end cannot see a mid-run peak — and the
    // mid-run peak is exactly where the >500 MB spike the user saw lives.
    // 15 chunks means 15 free sample points; track the max instead.
    let maxUsedMB = -Infinity;
    let maxTotalMB = -Infinity;
    let memSamples = 0;

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

      // Own transaction per chunk — insertOps wraps this call in
      // db.withTransactionSync internally, so each chunk commits before the
      // yield below rather than holding a transaction open across an
      // awaited event-loop tick.
      insertOps(db, ops);
      const td = performance.now();
      insertMs += td - tc;
      opsCount += ops.length;

      const heap = sampleHeapMB();
      if (heap) {
        memSamples++;
        if (heap.used > maxUsedMB) maxUsedMB = heap.used;
        if (!Number.isNaN(heap.total) && heap.total > maxTotalMB) maxTotalMB = heap.total;
      }

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

    const totalMs = t6 - t0;
    const stageSum = keyDeriveMs + dbOpenMs + resetMs + fetchMs + decryptMs + decodeMs + insertMs + computeMs;
    const yieldMs = totalMs - stageSum;

    const t: Timings = { keyDeriveMs, dbOpenMs, resetMs, fetchMs, decryptMs, decodeMs, insertMs, computeMs, yieldMs, totalMs };
    say(
      `ops=${opsCount}/${manifest.count}  ` + JSON.stringify(t) +
      `  (dbOpenMs: fresh close+reopen every press; resetMs: DELETE cost, not uniform — ` +
      `varies with rows already present; decodeMs: Expo pure-JS TextDecoder polyfill — stand-in, like decryptMs)`
    );

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

    // Peak = max over the 15 per-chunk samples taken during the corpus loop
    // above — this is what can actually see the mid-run spike; a single
    // before/after-compute/end reading cannot (review M4).
    const memPeak = memSamples > 0
      ? `usedJSHeapSize=${maxUsedMB.toFixed(1)}MB totalJSHeapSize=${Number.isFinite(maxTotalMB) ? maxTotalMB.toFixed(1) : "?"}MB (${memSamples} per-chunk samples)`
      : null;
    const memEnd = sampleMemory();
    if (memBefore === null && memPeak === null && memEnd === null) {
      say("memory: unavailable");
    } else {
      say(
        `memory: before=${memBefore ?? "unavailable"} peak=${memPeak ?? "unavailable"} end=${memEnd ?? "unavailable"}` +
        `  (JS heap only — excludes native/off-heap memory; do not equate with device RSS in the perf monitor)`
      );
    }
  }

  const warmVoid = warmExpectedCount !== null && warmRows !== null && warmRows !== warmExpectedCount;

  return (
    <SafeAreaView style={{ flex: 1, padding: 16 }}>
      <Text>
        warm start: {warmMs === null
          ? "no data yet (run cold restore, then relaunch)"
          : `${warmMs.toFixed(0)}ms over ${warmRows} rows`}
      </Text>
      {warmVoid && (
        <Text style={{ color: "red", fontWeight: "bold" }}>
          VOID — partial corpus ({warmRows}/{warmExpectedCount} rows). A force-quit or error left
          a partial commit; this warm-start number does not count.
        </Text>
      )}
      <Button title="Cold Restore" disabled={isRunning} onPress={() => coldRestore()} />
      <Button title="Reset DB" disabled={isRunning} onPress={() => resetDb(getDb())} />
      <ScrollView>{log.map((l, i) => <Text key={i} selectable>{l}</Text>)}</ScrollView>
    </SafeAreaView>
  );
}
