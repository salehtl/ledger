import { useEffect, useState } from "react";
import { Button, SafeAreaView, ScrollView, Text } from "react-native";
import { RECORD_SIZE, hexToBytes, openBlob } from "./crypto";
import { SERVER, RECIPIENT_PRIV_HEX } from "./config";
import { Op, bucketDebits, insertOps, openDb, resetDb } from "./replay";

type Timings = { fetchMs: number; decryptMs: number; insertMs: number; computeMs: number; totalMs: number };

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
    const priv = hexToBytes(RECIPIENT_PRIV_HEX);
    const db = openDb();
    resetDb(db);
    const t0 = performance.now();

    const manifest = await (await fetch(`${SERVER}/manifest.json`)).json();
    const buf = new Uint8Array(await (await fetch(`${SERVER}/all.bin`)).arrayBuffer());
    const t1 = performance.now();

    const ops: Op[] = [];
    const dec = new TextDecoder();
    for (let off = 0; off < buf.length; off += RECORD_SIZE) {
      ops.push(JSON.parse(dec.decode(openBlob(buf.subarray(off, off + RECORD_SIZE), priv))));
    }
    const t2 = performance.now();

    insertOps(db, ops);
    const t3 = performance.now();

    const computed = bucketDebits(db);
    const t4 = performance.now();

    const t: Timings = { fetchMs: t1 - t0, decryptMs: t2 - t1, insertMs: t3 - t2, computeMs: t4 - t3, totalMs: t4 - t0 };
    say(`ops=${ops.length}/${manifest.count}  ` + JSON.stringify(t));

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
