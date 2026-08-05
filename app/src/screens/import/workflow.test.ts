import { expect, test } from "bun:test";
import type { ImportMap } from "@ledger/client/importer/map.ts";
import { commitImport, planImport, previewCSV } from "./workflow.ts";
import { fold } from "@ledger/client/replay/replay.ts";
import type { Op } from "@ledger/client/wire/op.ts";

const map: ImportMap = { columns: { date: "Date", description: "Merchant", amount: "Amount" }, dateFormat: "2006-01-02", currency: "AED", directionMode: "sign" };

test("preview is capped at 20 and 3,683 rows plan into single-digit blobs", async () => {
  const csv = ["Date,Merchant,Amount", ...Array.from({ length: 3683 }, (_, i) => `2026-08-03,Merchant ${i},-${i + 1}.00`)].join("\n");
  expect(previewCSV(csv, map).raw).toHaveLength(20);
  let id = 0; const plan = planImport(csv, map, () => `01ARZ3NDEKTSV4RRFFQ${String(id++).padStart(6, "0")}`);
  expect(plan.errors).toHaveLength(0); expect(plan.specs).toHaveLength(3683); expect(plan.estimatedBlobs).toBeLessThan(10);
  const queued: unknown[] = []; let yields = 0;
  await commitImport(plan, { enqueueMany: (s) => queued.push(...s), newId: () => "unused", yieldToUI: async () => { yields++; } });
  expect(queued).toHaveLength(3683); expect(yields).toBeGreaterThan(0);
});

test("commit awaits the UI yield before enqueuing the next durable batch", async () => {
  const csv = ["Date,Merchant,Amount", ...Array.from({ length: 501 }, (_, i) => `2026-08-03,M${i},-${i + 1}`)].join("\n");
  let id = 0; const plan = planImport(csv, map, () => `id-${id++}`); const counts: number[] = [];
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = commitImport(plan, { enqueueMany: (batch) => counts.push(batch.length), newId: () => "unused", yieldToUI: () => gate });
  await Promise.resolve(); expect(counts).toEqual([250]);
  release(); await running; expect(counts).toEqual([250, 250, 1]);
});

test("overlap is emitted, never filtered, so replay can surface possible_duplicate", () => {
  const csv = "Date,Merchant,Amount\n2026-08-03,Same merchant,-12.34";
  const plan = planImport(csv, map, () => "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(plan.specs).toHaveLength(1);
  expect(plan.specs[0]).toMatchObject({ type: "txn_ingested", payload: { merchant_raw: "Same merchant", amount_minor: "1234" } });
  const payload = plan.specs[0]!.payload;
  const imported: Op = { v: 1, type: "txn_ingested", op_id: "op-import", authored_at: "2026-08-03T00:00:01Z", entity: plan.specs[0]!.entity!, parent_version: null, ingest_id: plan.specs[0]!.ingestId!, payload };
  const mail: Op = { ...imported, op_id: "op-mail", authored_at: "2026-08-03T00:00:00Z", entity: { kind: "txn", id: "mail-txn" }, ingest_id: "a".repeat(64), payload: { ...(payload as object), tier: "template" } };
  const state = fold([{ op: mail, seq: 1n, writer_id: "ingest" }, { op: imported, seq: 2n, writer_id: "device-a" }]);
  expect(state.txns.get("01ARZ3NDEKTSV4RRFFQ69G5FAV")?.possible_duplicate_of).toBe("mail-txn");
  expect([...state.txns.values()].filter((t) => t.superseded_by === null)).toHaveLength(2);
});

test("identical rows have distinct positional ingest ids and both survive as duplicate review", () => {
  const csv = "Date,Merchant,Amount\n2026-08-03,Same,-12.34\n2026-08-03,Same,-12.34"; let id = 0;
  const plan = planImport(csv, map, () => `txn-${++id}`);
  expect(plan.specs[0]!.ingestId).not.toBe(plan.specs[1]!.ingestId);
  const ops = plan.specs.map((spec, i): Op => ({ v: 1, type: "txn_ingested", op_id: `op-${i}`, authored_at: `2026-08-03T00:00:0${i}Z`, entity: spec.entity!, parent_version: null, ingest_id: spec.ingestId!, payload: spec.payload }));
  const state = fold(ops.map((op, i) => ({ op, seq: BigInt(i + 1), writer_id: "device" })));
  expect([...state.txns.values()].filter((t) => t.superseded_by === null)).toHaveLength(2);
  expect(state.txns.get("txn-2")?.possible_duplicate_of).toBe("txn-1");
  const again = planImport(csv, map, () => `again-${++id}`); expect(again.specs.map((s) => s.ingestId)).toEqual(plan.specs.map((s) => s.ingestId));
});
