import { expect, test } from "bun:test";
import type { Txn } from "@ledger/client/replay/state.ts";
import type { Definition } from "@ledger/client/tmpl/exec.ts";
import { reprocessCold, senderDomainMatches } from "./reprocess.ts";
import { fetchTemplates } from "./templates.ts";
import { fold } from "@ledger/client/replay/replay.ts";
import type { Op } from "@ledger/client/wire/op.ts";

const definition: Definition = { id: "bank.v1", version: 1, bank: "bank", normalizer_version: 1,
  match: { sender_domain: ["bank.example"] }, default_currency: "AED", date_from: "email",
  extract: [{ field: "amount", type: "amount", source: "body", patterns: ["(?P<amt>[0-9]+\\.[0-9]{2}) debited"], on_match: { direction: "debit" } }], required: ["amount", "direction"] };
const raw = new TextEncoder().encode("From: alerts@bank.example\r\nSubject: Alert\r\n\r\n12.34 debited");

test("verified sender domains mirror Go label-boundary suffix matching", () => {
  for (const [domain, want] of [["bank.example", true], ["alerts.bank.example", true], [" ALERTS.BANK.EXAMPLE. ", true], ["evilbank.example", false], [".bank.example", false], ["bank", false], ["alerts..bank.example", false]] as const) expect(senderDomainMatches(["bank.example"], domain)).toBe(want);
});
function txn(extra: Partial<Txn> = {}): Txn { return { id: "old", ingest_id: "a".repeat(64), amount_minor: 0n, currency: "", direction: "", posted_at: "2026-08-01T00:00:00.000Z", merchant_raw: "", last4: "", category: null, needs_review: true, unparsed: true, tier: "none", parse_error: "no_match", provenance: "ingest", amount_home_minor: null, splits: [], superseded_by: null, possible_duplicate_of: null, version: 1, ...extra }; }

test("verified cold template match emits one explicit supersede and yields progressively", async () => {
  const specs: any[] = []; let yields = 0; const result = await reprocessCold({ candidates: () => [{ txn: txn(), verifiedDomain: "bank.example" }], cold: async () => ({ verified: true, body: raw }), templates: [definition], enqueue: (s) => specs.push(s), newId: () => "new", yieldToUI: async () => { yields++; }, chunkSize: 1 });
  expect(result).toMatchObject({ examined: 1, emitted: 1, cancelled: false });
  expect(specs[0]).toMatchObject({ type: "txn_superseded", entity: { id: "new" }, ingestId: "a".repeat(64), payload: { amount_minor: "1234", currency: "AED", direction: "debit", tier: "template", unparsed: false } });
  expect(yields).toBe(1);
});

test("unverified body hard-refuses before parsing and emits nothing", async () => {
  let emitted = 0;
  await expect(reprocessCold({ candidates: () => [{ txn: txn(), verifiedDomain: "bank.example" }], cold: async () => ({ verified: false, body: raw }), templates: [definition], enqueue: () => { emitted++; }, newId: () => "new", yieldToUI: async () => {} })).rejects.toThrow("failed chain verification");
  expect(emitted).toBe(0);
});

test("heuristic candidates are explicitly unavailable and cancellation is bounded", async () => {
  let coldCalls = 0;
  const result = await reprocessCold({ candidates: () => [{ txn: txn({ tier: "heuristic" }), verifiedDomain: "bank.example" }], cold: async () => { coldCalls++; return { verified: true, body: raw }; }, templates: [definition], enqueue: () => {}, newId: () => "new", yieldToUI: async () => {} });
  expect(result).toMatchObject({ unavailable: 1, emitted: 0 }); expect(coldCalls).toBe(0);
  const alreadyParsed = await reprocessCold({ candidates: () => [{ txn: txn({ unparsed: false }), verifiedDomain: "bank.example" }], cold: async () => { coldCalls++; return { verified: true, body: raw }; }, templates: [definition], enqueue: () => {}, newId: () => "new", yieldToUI: async () => {} });
  expect(alreadyParsed).toMatchObject({ skipped: 1, emitted: 0 }); expect(coldCalls).toBe(0);
  const cancelled = await reprocessCold({ candidates: () => [{ txn: txn(), verifiedDomain: "bank.example" }], cold: async () => ({ verified: true, body: raw }), templates: [definition], enqueue: () => {}, newId: () => "new", yieldToUI: async () => {}, cancelled: () => true });
  expect(cancelled.cancelled).toBe(true); expect(cancelled.examined).toBe(0);
});

test("cancellation is passed into a potentially unbounded cold fetch", async () => {
  let stop = false; let observed = false;
  const result = await reprocessCold({ candidates: () => [{ txn: txn(), verifiedDomain: "bank.example" }], cold: async (_id, cancelled) => { stop = true; observed = cancelled(); return { verified: true, body: null }; }, templates: [definition], enqueue: () => {}, newId: () => "new", yieldToUI: async () => {}, cancelled: () => stop });
  expect(observed).toBe(true); expect(result.cancelled).toBe(true); expect(result.emitted).toBe(0);
});

test("template fetch is authenticated, incremental, and rejects draft envelopes", async () => {
  let request: Request | null = null;
  const page = await fetchTemplates({ server: "https://ledger.example", token: "tok", since: 7n, fetch: async (r) => { request = r; return new Response(JSON.stringify({ version: "8", templates: [{ id: definition.id, bank: definition.bank, version: definition.version, normalizer_version: 1, definition, status: "published" }], removed: [] }), { status: 200, headers: { "content-type": "application/json" } }); } });
  expect(request!.url).toEndWith("/api/v1/templates?since=7"); expect(request!.headers.get("authorization")).toBe("Bearer tok"); expect(page.version).toBe(8n);
  await expect(fetchTemplates({ server: "https://ledger.example", token: "tok", since: 0n, fetch: async () => new Response(JSON.stringify({ version: "1", templates: [{ id: definition.id, bank: definition.bank, version: 1, normalizer_version: 1, definition, status: "draft" }], removed: [] }), { status: 200, headers: { "content-type": "application/json" } }) })).rejects.toThrow("non-published");
});

test("the emitted supersede freezes FX at its own later log position", async () => {
  const usd = { ...definition, default_currency: "USD" }; const specs: any[] = [];
  await reprocessCold({ candidates: () => [{ txn: txn(), verifiedDomain: "bank.example" }], cold: async () => ({ verified: true, body: raw }), templates: [usd], enqueue: (s) => specs.push(s), newId: () => "new", yieldToUI: async () => {} });
  const base = (type: Op["type"], id: string, payload: unknown): Op => ({ v: 1, type, op_id: id, authored_at: "2026-08-03T00:00:00Z", parent_version: null, payload });
  const original: Op = { ...base("txn_ingested", "old-op", { amount_minor: "0", currency: "", direction: "", posted_at: "2026-08-01T00:00:00Z", merchant_raw: "", last4: "", category: null, needs_review: true, unparsed: true, tier: "none", parse_error: "no_match" }), entity: { kind: "txn", id: "old" }, ingest_id: "a".repeat(64) };
  const spec = specs[0]; const replacement: Op = { ...base("txn_superseded", "new-op", spec.payload), entity: spec.entity, ingest_id: spec.ingestId };
  const state = fold([
    { seq: 1n, writer_id: "device", op: base("home_currency_set", "home", { currency: "AED" }) },
    { seq: 2n, writer_id: "device", op: base("rate_set", "rate-old", { currency: "USD", rate_micro: "2000000" }) },
    { seq: 3n, writer_id: "ingest", op: original },
    { seq: 4n, writer_id: "device", op: base("rate_set", "rate-new", { currency: "USD", rate_micro: "3000000" }) },
    { seq: 5n, writer_id: "device", op: replacement },
  ]);
  expect(state.txns.get("new")?.amount_home_minor).toBe(3702n);
  expect(state.txns.get("old")?.superseded_by).toBe("new-op");
});
