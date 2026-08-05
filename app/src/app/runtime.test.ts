import { afterEach, describe, expect, test } from "bun:test";

import { bunDriver } from "@ledger/client/store/driver.ts";
import { memSecretStore } from "@ledger/client/store/store.ts";
import { sqliteStore } from "@ledger/client/store/sqlite.ts";
import { fold, type LogEntry } from "@ledger/client/replay/replay.ts";
import { project } from "@ledger/client/replay/projection.ts";
import { readAuditState } from "@ledger/client/replay/audit.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import { EMPTY_FILTERS } from "../lib/transactions.ts";

import { createRuntime, type AppRuntime, PRODUCT_DATABASE } from "./runtime.ts";
import { bootstrapRuntime } from "./bootstrap.ts";
import { STREAM_COLD, STREAM_HOT, sealBlob } from "@ledger/client/wire/blob.ts";
import { encodeRawBody } from "@ledger/client/wire/op.ts";
import type { Definition } from "@ledger/client/tmpl/exec.ts";
import { commitImport, planImport } from "../screens/import/workflow.ts";
import type { ImportMap } from "@ledger/client/importer/map.ts";

let runtime: AppRuntime | null = null;
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

describe("production runtime graph", () => {
  test("owns one driver and one graph across repeated construction", () => {
    let opens = 0;
    const deps = {
      server: "https://ledger.example",
      secrets: memSecretStore(),
      openDriver(name: string) {
        opens++;
        expect(name).toBe(PRODUCT_DATABASE);
        return bunDriver(":memory:");
      },
      yieldToUI: async () => {},
      newId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };

    runtime = createRuntime(deps);
    const again = createRuntime(deps);

    expect(again).toBe(runtime);
    expect(opens).toBe(1);
    expect(runtime.client).toBeDefined();
    expect(runtime.sync).toBeDefined();
    expect(runtime.coordinator).toBeDefined();
    expect(runtime.outbox).toBeDefined();
    expect(runtime.txns).toBeDefined();
    expect(runtime.review).toBeDefined();
    expect(runtime.currencies).toBeDefined();
    expect(Object.isFrozen(runtime)).toBe(true);
  });

  test("dispose closes the shared graph and permits a clean recreation", async () => {
    let opens = 0;
    const deps = {
      server: "https://ledger.example",
      secrets: memSecretStore(),
      openDriver: () => {
        opens++;
        return bunDriver(":memory:");
      },
    };
    runtime = createRuntime(deps);
    const first = runtime;
    await first.dispose();
    runtime = createRuntime(deps);
    expect(runtime).not.toBe(first);
    expect(opens).toBe(2);
  });

  test("runAudit does not enter the audit engine when cadence is not due", async () => {
    runtime = createRuntime({ server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:") });
    readAuditState(runtime.db);
    runtime.db.prepare("INSERT OR REPLACE INTO fold_audit (id, launches, last_ok_at, last_ok_seq, due_since, skips, last_outcome, last_detail) VALUES (1, 0, ?, '0', 0, 0, '', '')").run(Date.now());
    await runtime.runAudit();
    expect(readAuditState(runtime.db).lastOutcome).toBe("");
  });

  test("refuses to alias a different account configuration onto the live graph", () => {
    runtime = createRuntime({
      server: "https://ledger.example",
      secrets: memSecretStore(),
      openDriver: () => bunDriver(":memory:"),
    });
    expect(() => createRuntime({
      server: "https://other.example",
      secrets: memSecretStore(),
      openDriver: () => bunDriver(":memory:"),
    })).toThrow("already active");
  });

  test("the runtime transaction source reads the state projected by the real projector", async () => {
    runtime = createRuntime({ server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:") });
    const op: Op = {
      v: 1, type: "txn_ingested", op_id: "op-runtime-1", authored_at: "2026-08-03T00:00:00.000Z",
      entity: { kind: "txn", id: "txn-runtime-1" }, parent_version: null, ingest_id: "a".repeat(64),
      payload: { amount_minor: "1234", currency: "AED", direction: "debit", posted_at: "2026-08-03T00:00:00.000Z", merchant_raw: "Runtime Merchant", last4: "1234", category: null, needs_review: false, tier: "template" },
    };
    const state = fold([{ op, seq: 1n, writer_id: "ingest" } satisfies LogEntry]);
    await project(runtime.db, state, { between: async () => {} });
    expect(runtime.txns.read("txn-runtime-1")?.merchant_raw).toBe("Runtime Merchant");
    expect(runtime.txns.list(EMPTY_FILTERS, { limit: 10, after: null }).rows.map((row) => row.id)).toEqual(["txn-runtime-1"]);
  });

  test("the runtime currency source shares the projection and durable outbox", async () => {
    runtime = createRuntime({ server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:") });
    const state = fold([{
      op: {
        v: 1, type: "home_currency_set", op_id: "op-home", authored_at: "2026-08-03T00:00:00.000Z",
        parent_version: null, payload: { currency: "AED" },
      },
      seq: 1n, writer_id: "dev-a",
    } satisfies LogEntry]);
    await project(runtime.db, state, { between: async () => {} });
    expect(runtime.currencies.read(Date.parse("2026-08-03T00:00:00Z")).homeCurrency).toBe("AED");
    const action = runtime.currencies.setRate("USD", "3.672500");
    expect(action.ok).toBe(true);
    expect(runtime.outbox.pending.map((op) => op.type)).toEqual(["rate_set"]);
  });

  test("the runtime budget source reads the same projected frozen-home rows", async () => {
    runtime = createRuntime({ server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:") });
    const ops: Op[] = [
      { v: 1, type: "home_currency_set", op_id: "budget-home", authored_at: "2026-08-01T00:00:00.000Z", parent_version: null, payload: { currency: "AED" } },
      { v: 1, type: "txn_ingested", op_id: "budget-txn", authored_at: "2026-08-01T00:00:01.000Z", entity: { kind: "txn", id: "budget-txn" }, parent_version: null, ingest_id: "b".repeat(64), payload: { amount_minor: "500", currency: "AED", direction: "debit", posted_at: "2026-08-01T00:00:00.000Z", merchant_raw: "Grocer", last4: "", category: "groceries", needs_review: false, tier: "template" } },
    ];
    await project(runtime.db, fold(ops.map((op, i) => ({ op, seq: BigInt(i + 1), writer_id: i === 0 ? "dev-a" : "ingest" }))), { between: async () => {} });
    expect(runtime.budget.read(Date.parse("2026-08-03T00:00:00Z")).buckets).toEqual({ need: 500n, want: 0n, saving: 0n });
  });

  test("the runtime import IO batches a CSV into the durable outbox and projected transaction source", async () => {
    runtime = createRuntime({
      server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:"),
      newId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAV", yieldToUI: async () => {},
    });
    const map: ImportMap = { columns: { date: "Date", description: "Merchant", amount: "Amount" }, dateFormat: "2006-01-02", currency: "AED", directionMode: "sign" };
    const plan = planImport("Date,Merchant,Amount\n2026-08-03,Imported Shop,-12.34", map, runtime.importIO.newId);
    await commitImport(plan, runtime.importIO);
    expect(runtime.outbox.pending).toHaveLength(1);
    const state = fold(runtime.outbox.pending.map((op, i) => ({ op, seq: BigInt(i + 1), writer_id: "dev-a" })));
    await project(runtime.db, state, { between: async () => {} });
    expect(runtime.txns.read("01ARZ3NDEKTSV4RRFFQ69G5FAV")?.merchant_raw).toBe("Imported Shop");
  });

  test("reprocessing consumes projected verified origin and the real cached cold body", async () => {
    const db = bunDriver(":memory:");
    const secrets = memSecretStore();
    const seeded = sqliteStore(db, { secrets, server: "https://ledger.example" });
    const persisted = seeded.load();
    persisted.sessionToken = "template-token";
    persisted.userId = "10000000-0000-4000-8000-000000000001";
    seeded.save(persisted);
    const definition: Definition = { id: "bank.v1", version: 1, bank: "bank", normalizer_version: 1,
      match: { sender_domain: ["bank.example"] }, default_currency: "AED", date_from: "email",
      extract: [{ field: "amount", type: "amount", source: "body", patterns: ["(?P<amt>[0-9]+\\.[0-9]{2}) debited"], on_match: { direction: "debit" } }], required: ["amount", "direction"] };
    runtime = createRuntime({ server: "https://ledger.example", secrets, openDriver: () => db, newId: () => "txn-reprocessed",
      yieldToUI: async () => {}, fetch: (async () => new Response(JSON.stringify({ version: "1", templates: [{ id: definition.id, bank: definition.bank, version: 1, normalizer_version: 1, definition, status: "published" }], removed: [] }), { status: 200 })) as unknown as typeof fetch });
    const ingestId = "e".repeat(64);
    const original: Op = { v: 2, type: "txn_ingested", op_id: "op-unparsed", authored_at: "2026-08-03T00:00:00.000Z", entity: { kind: "txn", id: "txn-unparsed" }, parent_version: null, ingest_id: ingestId,
      payload: { amount_minor: "0", currency: "", direction: "", posted_at: "2026-08-03T00:00:00.000Z", merchant_raw: "", last4: "", category: null, needs_review: true, unparsed: true, tier: "none", parse_error: "no_match", verified_origin_domain: "bank.example" } };
    await project(db, fold([{ op: original, seq: 1n, writer_id: "ingest" }]), { between: async () => {} });
    const raw = new TextEncoder().encode("From: attacker@example.test\r\nSubject: Alert\r\nDate: Mon, 03 Aug 2026 00:00:00 +0000\r\n\r\n12.34 debited");
    const blob = sealBlob({ userId: runtime.client.userId!, stream: STREAM_COLD, writerId: "ingest", writerCounter: 1n }, encodeRawBody({ ingest_id: ingestId, received_at: "2026-08-03T00:00:00.000Z", raw }));
    let binary = ""; for (const byte of blob) binary += String.fromCharCode(byte);
    runtime.client.rows().append(STREAM_COLD, [{ seq: "1", stream: STREAM_COLD, writer_id: "ingest", writer_counter: "1", type_flag: "ingest", size_bucket: blob.length, blob_hash: "0".repeat(64), prev_hash: "0".repeat(64), created_at: "2025-01-01T00:00:00.000Z", blob: btoa(binary) }]);

    const result = await runtime.reprocess.start(() => {}, () => false);
    expect(result).toMatchObject({ examined: 1, emitted: 1, unavailable: 0 });
    expect(runtime.outbox.pending[0]).toMatchObject({ type: "txn_superseded", ingest_id: ingestId, payload: { amount_minor: "1234", tier: "template" } });
    expect(runtime.client.rows().count(STREAM_COLD)).toBe(0);
  });

  test("transaction-detail recomputes advance through the runtime's live pending outbox", async () => {
    runtime = createRuntime({ server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:") });
    const ops: Op[] = [
      { v: 1, type: "home_currency_set", op_id: "op-home-2", authored_at: "2026-08-03T00:00:00.000Z", parent_version: null, payload: { currency: "AED" } },
      { v: 1, type: "rate_set", op_id: "op-rate", authored_at: "2026-08-03T00:00:01.000Z", parent_version: null, payload: { currency: "USD", rate_micro: "3672500" } },
      { v: 1, type: "txn_ingested", op_id: "op-usd", authored_at: "2026-08-03T00:00:02.000Z", entity: { kind: "txn", id: "txn-usd" }, parent_version: null, ingest_id: "c".repeat(64), payload: { amount_minor: "1000", currency: "USD", direction: "debit", posted_at: "2026-08-03T00:00:00.000Z", merchant_raw: "USD Merchant", last4: "1234", category: null, needs_review: false, tier: "template" } },
    ];
    await project(runtime.db, fold(ops.map((op, i) => ({ op, seq: BigInt(i + 1), writer_id: i === 2 ? "ingest" : "dev-a" }))), { between: async () => {} });
    expect(runtime.txns.recomputeHome("txn-usd").ok).toBe(true);
    expect(runtime.txns.recomputeHome("txn-usd").ok).toBe(true);
    expect(runtime.currencies.recompute("txn-usd").ok).toBe(true);
    expect(runtime.currencies.recompute("txn-usd").ok).toBe(true);
    expect(runtime.outbox.pending.map((op) => op.parent_version)).toEqual([1, 2, 3, 4]);
  });

  test("the runtime quarantine source uses the live client session and configured transport", async () => {
    const db = bunDriver(":memory:");
    const secrets = memSecretStore();
    const seeded = sqliteStore(db, { secrets, server: "https://ledger.example" });
    const state = seeded.load();
    state.sessionToken = "runtime-token";
    state.userId = "user-runtime";
    seeded.save(state);
    const requests: Request[] = [];
    runtime = createRuntime({
      server: "https://ledger.example",
      secrets,
      openDriver: () => db,
      fetch: (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        return new Response(JSON.stringify({ items: [], action_needed: 0, expiring_soon: 0, complete: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const page = await runtime.quarantine.list();
    expect(page.complete).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://ledger.example/api/v1/quarantine?");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer runtime-token");
  });

  test("wipe enumerates every persisted Map writer before deleting storage", async () => {
    const purged: string[][] = [];
    let deleted = "";
    runtime = createRuntime({
      server: "https://ledger.example", secrets: memSecretStore(), openDriver: () => bunDriver(":memory:"),
      deleteDatabase: async (name) => { deleted = name; },
      purgeSecrets: async (ids) => { purged.push([...ids]); },
    });
    const state = runtime.store.load();
    state.writers.set("dev-a", { x: "A".repeat(43), d: "B".repeat(43) });
    state.writers.set("dev-b", { x: "C".repeat(43), d: "D".repeat(43) });
    runtime.store.save(state);
    await runtime.wipeAccount();
    expect(deleted).toBe(PRODUCT_DATABASE);
    expect(purged).toEqual([["dev-a", "dev-b"]]);
    runtime = null;
  });

  test("real bootstrap retains account storage on 401 and destroys then recreates it on 410", async () => {
    let db = bunDriver(":memory:");
    const secrets = memSecretStore();
    const seeded = sqliteStore(db, { secrets, server: "https://ledger.example" });
    const state = seeded.load();
    state.sessionToken = "held";
    state.userId = "user-1";
    state.writers.set("dev-a", { x: "A".repeat(43), d: "B".repeat(43) });
    // An ENROLLED device, which is what this case is about: `bootstrapRuntime`
    // now ensures the device writer before it syncs, and an unenrolled fixture
    // would stop at that step instead of reaching the 401/410 it measures.
    // `writer_id` in the Keychain and `writerId` in the state are the pair
    // `ensureDeviceWriter` takes as "already done, no network".
    state.writerId = "dev-a";
    secrets.set("writer_id", "dev-a");
    state.pending.push({ v: 1, type: "rate_set", op_id: "op-pending", authored_at: "2026-08-03T00:00:00.000Z", parent_version: null, payload: { currency: "USD", rate_micro: "3672500" } });
    seeded.save(state);
    seeded.rows().append(STREAM_HOT, [{ seq: "1", stream: STREAM_HOT, writer_id: "ingest", writer_counter: "1", type_flag: "ingest", size_bucket: 256, blob_hash: "d".repeat(64), prev_hash: "0".repeat(64), created_at: "2026-08-03T00:00:00.000Z", blob: "D".repeat(256) }]);
    let deleted = 0;
    const deps = {
      server: "https://ledger.example", secrets, openDriver: () => db,
      deleteDatabase: async () => { deleted++; db = bunDriver(":memory:"); },
      purgeSecrets: async (ids: readonly string[]) => {
        secrets.set("session_token", null);
        for (const id of ids) secrets.set(`writer_key:${id}`, null);
      },
    };
    runtime = createRuntime(deps);
    const unauthorized = Object.assign(new Error("expired"), { status: 401, code: "" });
    expect(await bootstrapRuntime(runtime, { refresh: async () => { throw unauthorized; }, wipe: () => runtime!.wipeAccount() })).toEqual({ step: "signed_out" });
    expect(runtime.store.load().pending.map((op) => op.op_id)).toEqual(["op-pending"]);
    expect(runtime.client.rows().count(STREAM_HOT)).toBe(1);
    expect(runtime.store.load().writers.has("dev-a")).toBe(true);
    expect(secrets.get("writer_key:dev-a")).toBe("B".repeat(43));

    const deletedError = Object.assign(new Error("deleted"), { status: 410, code: "account_deleted" });
    expect(await bootstrapRuntime(runtime, { refresh: async () => { throw deletedError; }, wipe: () => runtime!.wipeAccount() })).toEqual({ step: "signed_out" });
    expect(deleted).toBe(1);
    expect(secrets.get("session_token")).toBeNull();
    expect(secrets.get("writer_key:dev-a")).toBeNull();
    runtime = createRuntime(deps);
    expect(runtime.client.sessionToken).toBeNull();
    expect(runtime.client.rows().count(STREAM_HOT)).toBe(0);
    expect(runtime.outbox.pending).toHaveLength(0);
  });
});
