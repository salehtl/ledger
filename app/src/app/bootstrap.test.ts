import { describe, expect, test } from "bun:test";
import { bootstrapRuntime, persistedBootstrap } from "./bootstrap.ts";

describe("persisted bootstrap", () => {
  test("starts a device without a session signed out", () => {
    expect(persistedBootstrap({ sessionToken: null, userId: "must-not-be-read" })).toEqual({ step: "signed_out" });
  });

  test("resumes a persisted account without an IdP exchange", () => {
    expect(persistedBootstrap({ sessionToken: "held", userId: "user-1" })).toEqual({ step: "onboarding", userId: "user-1" });
  });

  test("a token without a persisted user becomes fatal instead of throwing", () => {
    const client = { sessionToken: "held", get userId(): string { throw new Error("not signed in"); } };
    expect(persistedBootstrap(client)).toMatchObject({ step: "fatal", error: new Error("not signed in") });
  });

  test("401 signs out without wiping and 410 wipes", async () => {
    const held = new Map<string, string | null>([["session_token", "held"], ["writer_key:dev", "key"]]);
    const runtime = {
      client: { sessionToken: "held", userId: "user-1" },
      secrets: { get: (name: string) => held.get(name) ?? null, set: (name: string, value: string | null) => held.set(name, value) },
    } as never;
    let wipes = 0;
    const wipe = async () => { wipes++; };
    const unauthorized = Object.assign(new Error("expired"), { status: 401, code: "" });
    expect(await bootstrapRuntime(runtime, { refresh: async () => { throw unauthorized; }, wipe })).toEqual({ step: "signed_out" });
    expect(wipes).toBe(0);
    expect(held.get("session_token")).toBeNull();
    expect(held.get("writer_key:dev")).toBe("key");
    const deleted = Object.assign(new Error("deleted"), { status: 410, code: "account_deleted" });
    expect(await bootstrapRuntime(runtime, { refresh: async () => { throw deleted; }, wipe })).toEqual({ step: "signed_out" });
    expect(wipes).toBe(1);
  });

  test("a complete returning account runs audit, syncs and applies the dictionary, and reaches ready", async () => {
    let syncs = 0;
    let passes = 0;
    let audits = 0;
    const facts = { inboundAddress: "u@in.example", firstMailConfirmedAt: "2026-08-03T00:00:00Z", homeCurrency: "AED" };
    const runtime = {
      client: { sessionToken: "held", userId: "user-1" },
      dictionary: { sync: async () => { syncs++; }, recategorize: async () => { passes++; } },
      runAudit: async () => { audits++; },
      onboardingFacts: async () => facts,
    } as never;
    expect(await bootstrapRuntime(runtime, { refresh: async () => {}, wipe: async () => {} })).toEqual({ step: "ready", userId: "user-1", facts });
    expect(syncs).toBe(1);
    expect(passes).toBe(1);
    expect(audits).toBe(1);
  });

  /**
   * The dictionary is a refinement, not a precondition. These three cover the
   * whole classification of a failure in it: an ordinary error is a non-event,
   * a 401 still signs out, and a 410 still wipes. Before this, all three took
   * the fatal branch — "Ledger could not safely open this account" — because
   * the sync was awaited inside the block that decides whether the app opens
   * and its error carried no `status` for the 401 rule to see.
   */
  const readyFacts = { inboundAddress: "u@in.example", firstMailConfirmedAt: "2026-08-03T00:00:00Z", homeCurrency: "AED" };
  const withDictionary = (fail: unknown, held: Map<string, string | null>) =>
    ({
      client: { sessionToken: "held", userId: "user-1" },
      secrets: { get: (name: string) => held.get(name) ?? null, set: (name: string, value: string | null) => held.set(name, value) },
      dictionary: { sync: async () => { throw fail; }, recategorize: async () => {} },
      runAudit: async () => {},
      onboardingFacts: async () => readyFacts,
    }) as never;

  test("a dictionary sync failure does not stop the app opening", async () => {
    const held = new Map<string, string | null>([["session_token", "held"]]);
    let wipes = 0;
    const got = await bootstrapRuntime(withDictionary(new Error("dictionary sync failed: 503"), held), {
      refresh: async () => {},
      wipe: async () => { wipes++; },
    });
    expect(got).toEqual({ step: "ready", userId: "user-1", facts: readyFacts });
    expect(wipes).toBe(0);
    expect(held.get("session_token")).toBe("held");
  });

  test("a 401 from the dictionary signs out rather than showing the fatal screen", async () => {
    const held = new Map<string, string | null>([["session_token", "held"], ["writer_key:dev", "key"]]);
    let wipes = 0;
    const got = await bootstrapRuntime(withDictionary(Object.assign(new Error("expired"), { status: 401, code: "" }), held), {
      refresh: async () => {},
      wipe: async () => { wipes++; },
    });
    expect(got).toEqual({ step: "signed_out" });
    expect(wipes).toBe(0);
    expect(held.get("session_token")).toBeNull();
    expect(held.get("writer_key:dev")).toBe("key");
  });

  test("a 410 from the dictionary wipes, like a 410 anywhere else", async () => {
    const held = new Map<string, string | null>([["session_token", "held"]]);
    let wipes = 0;
    const got = await bootstrapRuntime(withDictionary(Object.assign(new Error("deleted"), { status: 410, code: "account_deleted" }), held), {
      refresh: async () => {},
      wipe: async () => { wipes++; },
    });
    expect(got).toEqual({ step: "signed_out" });
    expect(wipes).toBe(1);
  });
});
