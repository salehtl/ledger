import { expect, test } from "bun:test";
import { Client, MAX_UPLOAD_BLOBS } from "../net/client.ts";
import { openMemStore } from "../store/open.ts";
import { MAX_BUCKET } from "../wire/blob.ts";

function measured(rows: number) {
  const store = openMemStore("https://ledger.example"); const state = store.load();
  state.userId = "00000000-0000-4000-8000-000000000001"; store.save(state);
  const client = new Client({ store, server: "https://ledger.example", writerId: "device-a" });
  for (let start = 0; start < rows; start += 250) {
    client.emitMany(Array.from({ length: Math.min(250, rows - start) }, (_, offset) => {
      const i = start + offset;
      return { type: "txn_ingested", entity: { kind: "txn", id: `import-${i}` }, parentVersion: null,
        ingestId: i.toString(16).padStart(64, "0"), payload: { amount_minor: `${i + 1}00`, currency: "AED",
          direction: "debit", posted_at: "2026-08-03T00:00:00.000Z", merchant_raw: `Imported merchant ${i}`,
          last4: "", category: null, needs_review: true, tier: "none", unparsed: false } };
    }));
  }
  return client.previewPendingUpload();
}

for (const rows of [500, 3683]) test(`production Client packer measures ${rows} imported rows`, () => {
  const got = measured(rows);
  expect(got.blobs).toBeLessThan(10);
  expect(got.requests).toBe(Math.ceil(got.blobs / MAX_UPLOAD_BLOBS));
  expect(got.sizes.every((size) => size <= MAX_BUCKET)).toBe(true);
}, 60_000);
