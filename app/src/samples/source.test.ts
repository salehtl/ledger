import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DONATION_CONSENT } from "../lib/redaction.ts";
import { BankNameError, SAMPLE_DISCLOSURE, SUPPORTED_BANKS, SUPPORTED_TEMPLATE_IDS, SampleSource, waitlistSource } from "./source.ts";

describe("sample source", () => {
  test("waitlist sends only the aggregate bank, folded exactly as the server will store it, under session auth", async () => { let seen: { url: string; init?: RequestInit } | null = null; const source = waitlistSource("https://ledger.test", () => "session", async (input, init) => { seen = { url: String(input), ...(init === undefined ? {} : { init }) }; return new Response(null, { status: 204 }); }); await source.join("  New Bank  "); expect(seen!.url).toBe("https://ledger.test/api/v1/waitlist"); expect(seen!.init?.headers).toEqual({ authorization: "Bearer session", "content-type": "application/json" }); expect(JSON.parse(String(seen!.init?.body))).toEqual({ bank: "new bank" }); });
  test("supported banks are derived from every published seed id", () => { expect(SUPPORTED_TEMPLATE_IDS).toEqual(["dib.card.v1", "dib.account.v1", "enbd.transfer.v1", "enbd.alert.v1"]); expect(SUPPORTED_BANKS.flatMap((b) => b.templateIds)).toEqual([...SUPPORTED_TEMPLATE_IDS]); });
  test("report is content-free and never fetches cold bytes", async () => { let cold = 0; let sent: any; const s = new SampleSource({ server: "https://ledger.test", token: () => "s", cold: { fetchBody: async () => { cold++; return null; } }, fetch: async (_i, init) => { sent = JSON.parse(String(init?.body)); return new Response(null, { status: 204 }); } }); await s.report("a".repeat(64)); expect(sent).toEqual({ ingest_id: "a".repeat(64) }); expect(cold).toBe(0); });
  test("preview and donate use the exact verified cold bytes and consent", async () => { const bytes = new TextEncoder().encode("From: bank\n\nAED 12.34 CARD 1234"); const id = createHash("sha256").update(bytes).digest("hex"); const bodies: any[] = []; const s = new SampleSource({ server: "https://ledger.test", token: () => "s", cold: { fetchBody: async (asked) => { expect(asked).toBe(id); return bytes; } }, fetch: async (input, init) => { bodies.push([String(input), JSON.parse(String(init?.body))]); return new Response(null, { status: 204 }); } }); const preview = await s.preview(id); expect(preview.bytes).toEqual(bytes); expect(preview.text).toContain("CARD 1234"); expect(() => s.donate(preview, null)).toThrow(/requires consent/); await s.donate(preview, DONATION_CONSENT); expect(bodies).toEqual([["https://ledger.test/api/v1/samples/donate", { ingest_id: id, consent: DONATION_CONSENT }]]); });
  test("copy says complete content and 180 days", () => { for (const fact of ["complete email", "amounts", "merchants", "card digits", "everything", "180 days", "operator can read"]) expect(SAMPLE_DISCLOSURE.toLowerCase()).toContain(fact); });
});

/**
 * The client half of the grammar has to run BEFORE the request, or the user
 * meets it as a 400.
 *
 * `app/src/lib/bank.test.ts` proves the grammar itself agrees with Go's over a
 * shared fixture. What is proved here is that `join` actually consults it: a
 * name the server cannot store must never reach the network, and the error
 * must carry the sentence naming what is allowed rather than a status code.
 */
describe("waitlist join enforces the server's grammar before the wire", () => {
  test("a name outside the grammar is refused locally, with the rule, and sends nothing", async () => {
    let calls = 0;
    const source = waitlistSource("https://ledger.test", () => "session", async () => { calls++; return new Response(null, { status: 204 }); });
    await expect(source.join("Mashreq (UAE)")).rejects.toBeInstanceOf(BankNameError);
    await expect(source.join("Mashreq (UAE)")).rejects.toThrow(/Letters, digits, spaces/);
    expect(calls).toBe(0);
  });

  test("a server refusal surfaces the server's own detail, not the status", async () => {
    const source = waitlistSource("https://ledger.test", () => "session", async () =>
      new Response(JSON.stringify({ error: "invalid_bank", detail: "a bank name does not contain a decimal amount" }), { status: 400, headers: { "content-type": "application/json" } }));
    // "Mashreq" passes the client grammar, so this is genuinely the server
    // half: a build whose grammar the server later tightened.
    await expect(source.join("Mashreq")).rejects.toThrow("a bank name does not contain a decimal amount");
  });

  test("a refusal with no body still names the status rather than throwing on the parse", async () => {
    const source = waitlistSource("https://ledger.test", () => "session", async () => new Response(null, { status: 503 }));
    await expect(source.join("Mashreq")).rejects.toThrow(/503/);
  });
});
