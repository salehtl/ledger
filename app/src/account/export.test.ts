import { describe, expect, test } from "bun:test";
import type { ExportSource } from "../lib/export.ts";
import { exportAndShare } from "./export.ts";

const source: ExportSource = { generatedAt: "2026-08-03T12:00:00Z", homeCurrency: "AED", cursorHot: 4n, cursorCold: 2n, txnCount: 0, rules: [], rates: new Map(), forks: [], anomalies: [], *txnChunks() {} };

describe("native export orchestration", () => {
  test("streams bytes to a file, closes it, then shares the correct format", async () => { const events: string[] = []; const bytes: number[] = []; const report = await exportAndShare(source, "json", { open: (name) => { events.push(`open:${name}`); return { uri: "file:///ledger.json", write: (b) => bytes.push(...b), close: () => events.push("close") }; }, share: async (uri, format) => { events.push(`share:${uri}:${format}`); } }, async () => {}); expect(events).toEqual(["open:ledger-2026-08-03.json", "close", "share:file:///ledger.json:json"]); expect(new TextDecoder().decode(Uint8Array.from(bytes))).toContain('"transaction_count":0'); expect(report.bytes).toBe(bytes.length); });
  test("closes an incomplete file and never shares when a write fails", async () => { let closes = 0; let shares = 0; await expect(exportAndShare(source, "csv", { open: () => ({ uri: "file:///x", write: () => { throw new Error("disk full"); }, close: () => { closes++; } }), share: async () => { shares++; } }, async () => {})).rejects.toThrow("disk full"); expect(closes).toBe(1); expect(shares).toBe(0); });
});
