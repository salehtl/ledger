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

  test("a complete returning account runs audit and reaches ready", async () => {
    let audits = 0;
    const facts = { inboundAddress: "u@in.example", firstMailConfirmedAt: "2026-08-03T00:00:00Z", homeCurrency: "AED" };
    const runtime = {
      client: { sessionToken: "held", userId: "user-1" },
      runAudit: async () => { audits++; },
      onboardingFacts: async () => facts,
    } as never;
    expect(await bootstrapRuntime(runtime, { refresh: async () => {}, wipe: async () => {} })).toEqual({ step: "ready", userId: "user-1", facts });
    expect(audits).toBe(1);
  });
});
