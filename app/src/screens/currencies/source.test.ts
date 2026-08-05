import { expect, test } from "bun:test";
import { bunDriver } from "@ledger/client/store/driver.ts";
import { project } from "@ledger/client/replay/projection.ts";
import { emptyState, type Txn } from "@ledger/client/replay/state.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { sqlCurrencySource } from "./source.ts";

function txn(id: string, currency: string, home: bigint | null, extra: Partial<Txn> = {}): Txn {
  return { id, ingest_id: id.padEnd(64, "a").slice(0, 64), amount_minor: 100n, currency, direction: "debit",
    posted_at: "2026-08-01T00:00:00.000Z", merchant_raw: id, last4: "1234", category: null, needs_review: false,
    unparsed: false, tier: "template", parse_error: null, provenance: "ingest", amount_home_minor: home, splits: [],
    superseded_by: null, possible_duplicate_of: null, version: 3, ...extra };
}

test("SQL source distinguishes unset/missing, filters dead rows, and emits exact controls", async () => {
  const db = bunDriver(":memory:"); const state = emptyState(); state.homeCurrency = "AED";
  state.rates.set("USD", null); state.rateUpdatedAt.set("USD", "2026-07-01T00:00:00.000Z");
  state.txns.set("usd", txn("usd", "USD", null)); state.txns.set("eur", txn("eur", "EUR", null));
  state.txns.set("dead", txn("dead", "GBP", null, { superseded_by: "replacement" }));
  state.txns.set("raw", txn("raw", "JPY", null, { unparsed: true, currency: "", direction: "", amount_minor: 0n, tier: "none", needs_review: true }));
  await project(db, state);
  const emitted: OpSpec[] = []; const source = sqlCurrencySource(db, { enqueue: (op) => emitted.push(op), pending: [] });
  const view = source.read(Date.parse("2026-08-02T00:00:00.000Z"));
  expect(view.rates.map((r) => [r.currency, r.updatedAt, r.pending])).toEqual([["EUR", "", 1], ["USD", "2026-07-01T00:00:00.000Z", 1]]);
  expect(source.setRate("AED", "2").ok).toBe(false); expect(source.unsetRate("AED").ok).toBe(false);
  expect(source.setRate("EUR", "").ok).toBe(false); expect(source.setRate("EUR", "4.125").ok).toBe(true);
  expect(source.unsetRate("USD").ok).toBe(true);
  expect(emitted.map((o) => o.type)).toEqual(["rate_set", "rate_unset"]);
  db.close();
});

test("two offline recomputes advance through durable pending parents instead of self-forking", async () => {
  const db = bunDriver(":memory:"); const state = emptyState(); state.homeCurrency = "AED";
  state.rates.set("USD", 3_000_000n); state.rateUpdatedAt.set("USD", "2026-08-01T00:00:00.000Z"); state.txns.set("t1", txn("t1", "USD", 300n));
  await project(db, state);
  const pending: Op[] = []; const source = sqlCurrencySource(db, { pending, enqueue(spec) {
    pending.push({ v: 1, type: spec.type as Op["type"], op_id: `op-${pending.length}`, authored_at: "2026-08-02T00:00:00.000Z", ...(spec.entity === undefined ? {} : { entity: spec.entity }), parent_version: spec.parentVersion ?? null, ...(spec.ingestId === undefined ? {} : { ingest_id: spec.ingestId }), payload: spec.payload });
  } });
  expect(source.recompute("t1")).toMatchObject({ ok: true, op: { parentVersion: 3, payload: { amount_home_minor: "300" } } });
  expect(source.recompute("t1")).toMatchObject({ ok: true, op: { parentVersion: 4, payload: { amount_home_minor: "300" } } });
  expect(pending.map((op) => op.parent_version)).toEqual([3, 4]);
  db.close();
});
