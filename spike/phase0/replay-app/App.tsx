import { useEffect, useState } from "react";
import { Button, SafeAreaView, ScrollView, Text } from "react-native";
import { RECORD_SIZE, derivePub, hexToBytes, openBlob } from "./crypto";
import { SERVER, RECIPIENT_PRIV_HEX } from "./config";
import { Op, bucketDebits, insertOps, openDb, resetDb } from "./replay";

// dbOpenMs: connection-open + CREATE TABLE, now inside the measured window
// (it used to run before t0 and was silently excluded from a measurement
// whose whole purpose is the cold-restore total).
// decryptMs: crypto only (shared-secret + HKDF + AES-GCM decrypt + gunzip),
// isolated from decodeMs (UTF-8 decode + JSON.parse) so Task 4's decision
// rule can tell whether decrypt itself dominates, rather than a window that
// silently mixed crypto with string/JSON work.
type Timings = {
  dbOpenMs: number;
  fetchMs: number;
  decryptMs: number;
  decodeMs: number;
  insertMs: number;
  computeMs: number;
  totalMs: number;
};

export default function App() {
  const [log, setLog] = useState<string[]>([]);
  const [warmMs, setWarmMs] = useState<number | null>(null);
  const say = (s: string) => setLog((l) => [...l, s]);

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
    const priv = hexToBytes(RECIPIENT_PRIV_HEX);
    const recipPub = derivePub(priv); // derived once, not per record — see crypto.ts
    const db = openDb();
    resetDb(db);
    const t1 = performance.now();

    const manifest = await (await fetch(`${SERVER}/manifest.json`)).json();
    const buf = new Uint8Array(await (await fetch(`${SERVER}/all.bin`)).arrayBuffer());
    const t2 = performance.now();

    const plains: Uint8Array[] = [];
    for (let off = 0; off < buf.length; off += RECORD_SIZE) {
      plains.push(openBlob(buf.subarray(off, off + RECORD_SIZE), priv, recipPub));
    }
    const t3 = performance.now();

    const ops: Op[] = [];
    const dec = new TextDecoder();
    for (const p of plains) ops.push(JSON.parse(dec.decode(p)));
    const t4 = performance.now();

    insertOps(db, ops);
    const t5 = performance.now();

    const computed = bucketDebits(db);
    const t6 = performance.now();

    const t: Timings = {
      dbOpenMs: t1 - t0,
      fetchMs: t2 - t1,
      decryptMs: t3 - t2,
      decodeMs: t4 - t3,
      insertMs: t5 - t4,
      computeMs: t6 - t5,
      totalMs: t6 - t0,
    };
    say(`ops=${ops.length}/${manifest.count}  ` + JSON.stringify(t));

    if (ops.length !== manifest.count) {
      say(`COUNT MISMATCH: decrypted ${ops.length} ops but manifest declares ${manifest.count}`);
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
