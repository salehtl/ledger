import { describe, expect, test } from "bun:test";
import { ApiError } from "@ledger/client/net/client.ts";
import { CONFLICT_COPY, deletionNotice, trustBasis, trustRequest, type QuarantineItem } from "./quarantine.ts";
import { createQuarantineSource } from "../screens/quarantine/source.ts";
import { bunDriver } from "@ledger/client/store/driver.ts";
import { fold, type LogEntry } from "@ledger/client/replay/replay.ts";
import { project } from "@ledger/client/replay/projection.ts";
import type { Op } from "@ledger/client/wire/op.ts";
import { sqlTxnSource } from "../screens/transactions/source.ts";
import { EMPTY_FILTERS } from "./transactions.ts";

const ITEM: QuarantineItem = {
  id: "q1", ingestId: "a".repeat(64), receivedAt: "2026-08-01T00:00:00Z", expiresAt: "2026-08-02T00:00:00Z",
  warnedAt: "2026-08-02T00:00:00Z", deleteAfter: "2026-08-12T00:00:00Z", outerDomain: "gmail.com",
  innerDomain: "bank.ae", attested: true, attestedBy: "arc", dkim: "pass", arc: "pass", sizeBucket: 1024,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("quarantine trust model", () => {
  test("trust is based on the attested domain and never attacker-rendered content", () => {
    expect(trustBasis(ITEM)).toEqual({ authenticated: true, label: "bank.ae", domain: "bank.ae", source: "arc" });
    expect(trustRequest(ITEM)).toEqual({ domain: "bank.ae", scope: "inner" });
  });

  test("an unattested item is prominent and cannot produce a trust request", () => {
    const item = { ...ITEM, attested: false, attestedBy: "", innerDomain: "attacker.example" };
    expect(trustBasis(item)).toEqual({ authenticated: false, label: "Unauthenticated", domain: null, source: "No verified origin" });
    expect(trustRequest(item)).toBeNull();
  });

  test("the warning counts down to delete_after, never expires_at", () => {
    expect(deletionNotice(ITEM, Date.parse("2026-08-03T00:00:00Z"))).toBe("Scheduled for deletion in 9 days");
    expect(deletionNotice({ ...ITEM, warnedAt: null }, Date.now())).toBeNull();
  });

  test("both 409s have distinct actionable copy", () => {
    expect(CONFLICT_COPY.forwarder_domain).toContain("forwarder, not your bank");
    expect(CONFLICT_COPY.origin_unproven).toContain("verified signature");
    expect(CONFLICT_COPY.forwarder_domain).not.toBe(CONFLICT_COPY.origin_unproven);
  });
});

describe("quarantine API source", () => {
  test("list sends both halves of both keyset cursors and decodes trust fields", async () => {
    let url = "";
    let authorization = "";
    const source = createQuarantineSource({
      server: "https://ledger.example", token: () => "tok", sync: async () => {},
      fetch: async (input) => {
        url = input.url;
        authorization = input.headers.get("authorization") ?? "";
        return response({ items: [{
          id: "q1", ingest_id: "a".repeat(64), received_at: ITEM.receivedAt, expires_at: ITEM.expiresAt,
          warned_at: ITEM.warnedAt, delete_after: ITEM.deleteAfter, outer_domain: ITEM.outerDomain,
          inner_domain: ITEM.innerDomain, attested: true, attested_by: "arc", dkim: "pass", arc: "pass", size_bucket: 1024,
        }], removed: [], action_needed: 2, expiring_soon: 1, next: "n", next_id: "id", removed_next: "r", removed_next_id: "rid", complete: false });
      },
    });
    const page = await source.list({ after: "a", afterId: "ai", removedAfter: "r", removedAfterId: "ri" });
    expect(url).toContain("after=a&after_id=ai&removed_after=r&removed_after_id=ri");
    expect(authorization).toBe("Bearer tok");
    expect(page.items[0]).toMatchObject({ innerDomain: "bank.ae", attested: true, deleteAfter: ITEM.deleteAfter });
    expect(page.next).toEqual({ after: "n", afterId: "id", removedAfter: "r", removedAfterId: "rid" });
  });

  test("confirm sends bearer auth and a null token never reaches transport", async () => {
    let auth = "";
    const source = createQuarantineSource({
      server: "https://ledger.example", token: () => "tok", sync: async () => {},
      fetch: async (request) => { auth = request.headers.get("authorization") ?? ""; return response({ domain: "bank.ae", ingest_ids: [], reingest: null }); },
    });
    await source.confirm("bank.ae", "inner");
    expect(auth).toBe("Bearer tok");
    let calls = 0;
    const signedOut = createQuarantineSource({ server: "https://ledger.example", token: () => null, sync: async () => {}, fetch: async () => { calls++; return response({}); } });
    await expect(signedOut.list()).rejects.toThrow("not signed in");
    const blank = createQuarantineSource({ server: "https://ledger.example", token: () => "  \t", sync: async () => {}, fetch: async () => { calls++; return response({}); } });
    await expect(blank.list()).rejects.toThrow("not signed in");
    expect(calls).toBe(0);
  });

  test("confirm stops immediately when an unfinished page examined nothing", async () => {
    let calls = 0;
    const source = createQuarantineSource({
      server: "https://ledger.example", token: () => "tok", sync: async () => {},
      fetch: async () => { calls++; return response({ domain: "bank.ae", ingest_ids: [], reingest: { examined: 0, appended: 0, superseded: 0, unchanged: 0, failed: 0, remaining: 5, incomplete: true } }); },
    });
    await expect(source.confirm("bank.ae", "inner")).rejects.toThrow("did not make progress");
    expect(calls).toBe(1);
  });

  for (const code of ["forwarder_domain", "origin_unproven"] as const) {
    test(`confirm preserves the ${code} 409`, async () => {
      const source = createQuarantineSource({ server: "https://ledger.example", token: () => "tok", sync: async () => {}, fetch: async () => response({ error: code, detail: "no" }, 409) });
      try {
        await source.confirm("bank.ae", "inner");
        throw new Error("expected conflict");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(code);
      }
    });
  }

  test("incomplete and remaining confirms page, aggregate reports, then sync materializes N transactions", async () => {
    const replies = [
      { domain: "bank.ae", scope: "inner", ingest_ids: ["a".repeat(64), "b".repeat(64)], reingest: { examined: 2, appended: 2, superseded: 0, unchanged: 0, failed: 0, remaining: 0, incomplete: true } },
      { domain: "bank.ae", scope: "inner", ingest_ids: ["c".repeat(64)], reingest: { examined: 1, appended: 1, superseded: 0, unchanged: 0, failed: 0, remaining: 0, incomplete: false } },
    ];
    const db = bunDriver(":memory:");
    const txns = sqlTxnSource(db, { enqueue: () => { throw new Error("not expected"); }, newId: () => "new" });
    const entries: LogEntry[] = [1, 2, 3].map((n) => {
      const op: Op = { v: 1, type: "txn_ingested", op_id: `op-q-${n}`, authored_at: "2026-08-03T00:00:00Z", entity: { kind: "txn", id: `txn-q-${n}` }, parent_version: null, ingest_id: n.toString(16).padStart(64, "0"), payload: { amount_minor: "100", currency: "AED", direction: "debit", posted_at: "2026-08-03T00:00:00Z", merchant_raw: `Bank ${n}`, last4: "1234", category: null, needs_review: false, tier: "template" } };
      return { op, seq: BigInt(n), writer_id: "ingest" };
    });
    expect(txns.list(EMPTY_FILTERS, { limit: 10, after: null }).rows).toHaveLength(0);
    const pages: number[] = [];
    const source = createQuarantineSource({
      server: "https://ledger.example", token: () => "tok",
      fetch: async () => response(replies.shift()),
      sync: async () => { await project(db, fold(entries), { between: async () => {} }); },
    });
    const result = await source.confirm("bank.ae", "inner", (r) => pages.push(r.appended));
    expect(result.reingest).toMatchObject({ examined: 3, appended: 3, remaining: 0, incomplete: false });
    expect(result.ingestIds).toHaveLength(3);
    expect(pages).toEqual([2, 1]);
    expect(txns.list(EMPTY_FILTERS, { limit: 10, after: null }).rows.map((row) => row.id).sort()).toEqual(["txn-q-1", "txn-q-2", "txn-q-3"]);
    db.close();
  });
});
