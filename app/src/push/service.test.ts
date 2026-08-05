import { describe, expect, test } from "bun:test";
import { handleNotificationTap, installNotificationTapHandling, isValidPushToken, PushRegistration, type NotificationTap, type PushNative } from "./service.ts";

function native(permission: "granted" | "denied" | "undetermined" = "granted", token = "ExponentPushToken[abc]"): PushNative {
  return { platform: "ios", permission: async () => permission, requestPermission: async () => permission, expoToken: async () => token };
}

describe("push registration", () => {
  test("posts the authenticated server contract including the revocable writer", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const service = new PushRegistration({
      server: "https://ledger.test", sessionToken: () => "session", writerId: () => "device-a", native: native(),
      fetch: async (input, init) => { calls.push([input, init]); return new Response(null, { status: 204 }); },
    });
    expect(await service.register()).toEqual({ kind: "registered", token: "ExponentPushToken[abc]" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("https://ledger.test/api/v1/push/tokens");
    expect(calls[0]![1]).toEqual({
      method: "POST",
      headers: { authorization: "Bearer session", "content-type": "application/json" },
      body: JSON.stringify({ token: "ExponentPushToken[abc]", platform: "ios", writer_id: "device-a" }),
    });
  });

  test("denial makes no network or token request", async () => {
    let tokenCalls = 0;
    const n = native("denied");
    n.expoToken = async () => { tokenCalls++; return "token"; };
    const service = new PushRegistration({ server: "", sessionToken: () => "s", writerId: () => "w", native: n,
      fetch: async () => { throw new Error("network called"); } });
    expect(await service.register()).toEqual({ kind: "denied" });
    expect(tokenCalls).toBe(0);
  });

  test("rejects whitespace, controls, empty and oversized tokens locally", () => {
    expect(isValidPushToken("valid![]")).toBe(true);
    for (const token of ["", "has space", "line\nbreak", "x".repeat(513)]) expect(isValidPushToken(token)).toBe(false);
  });

  test("deletes the encoded token with authentication", async () => {
    let call: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const service = new PushRegistration({ server: "https://ledger.test", sessionToken: () => "s", writerId: () => "w", native: native(),
      fetch: async (input, init) => { call = [input, init]; return new Response(null, { status: 204 }); } });
    await service.unregister("Expo/token?[x]");
    expect(call).toEqual(["https://ledger.test/api/v1/push/tokens/Expo%2Ftoken%3F%5Bx%5D", {
      method: "DELETE", headers: { authorization: "Bearer s" },
    }]);
  });
});

describe("notification tap", () => {
  test("content-free payload triggers sync and exposes nothing else", async () => {
    let syncs = 0;
    expect(await handleNotificationTap({ title: "New transaction", body: "", data: {} }, async () => { syncs++; })).toBe(true);
    expect(syncs).toBe(1);
  });

  test("a cold-start response syncs once, is cleared, and is deduplicated from the live listener", async () => {
    const cold: NotificationTap = { id: "response-1", content: { title: "New transaction", body: "", data: {} } };
    let live: ((tap: NotificationTap) => void) | undefined;
    let clears = 0;
    let syncs = 0;
    const unsubscribe = await installNotificationTapHandling({
      lastResponse: async () => { live?.(cold); return cold; },
      clearLastResponse: async () => { clears++; },
      listen: (listener) => { live = listener; return () => { live = undefined; }; },
    }, async () => { syncs++; }, () => { throw new Error("unexpected live error"); });
    await Promise.resolve();
    expect(syncs).toBe(1);
    expect(clears).toBe(1);
    unsubscribe();
    expect(live).toBeUndefined();
  });

  test("startup awaits the live-won in-flight sync and preserves the response on failure", async () => {
    const cold: NotificationTap = { id: "response-2", content: { title: "New transaction", body: "", data: {} } };
    let live: ((tap: NotificationTap) => void) | undefined;
    let rejectSync: ((error: Error) => void) | undefined;
    let clears = 0;
    const installing = installNotificationTapHandling({
      lastResponse: async () => { live?.(cold); return cold; },
      clearLastResponse: async () => { clears++; },
      listen: (listener) => { live = listener; return () => { live = undefined; }; },
    }, () => new Promise((_, reject) => { rejectSync = reject; }), () => {});
    await Promise.resolve();
    rejectSync!(new Error("sync failed"));
    await expect(installing).rejects.toThrow("sync failed");
    expect(clears).toBe(0);
    expect(live).toBeUndefined();
  });

  test("a post-install live sync failure reaches the explicit error policy", async () => {
    let live: ((tap: NotificationTap) => void) | undefined;
    const errors: unknown[] = [];
    let errorSeen: (() => void) | undefined;
    const seen = new Promise<void>((resolve) => { errorSeen = resolve; });
    await installNotificationTapHandling({
      lastResponse: async () => null,
      clearLastResponse: async () => {},
      listen: (listener) => { live = listener; return () => {}; },
    }, async () => { throw new Error("offline"); }, (error) => { errors.push(error); errorSeen!(); });
    live!({ id: "later", content: { title: "New transaction", body: "", data: {} } });
    await seen;
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("offline");
  });

  test("transaction data, changed title, or changed body is rejected without sync", async () => {
    let syncs = 0;
    const sync = async () => { syncs++; };
    for (const content of [
      { title: "New transaction", body: "", data: { amount: "12.00" } },
      { title: "New transaction", body: "", data: { merchant: "Shop", count: 1 } },
      { title: "New transaction", body: "", subtitle: "AED 12", data: {} },
      { title: "1 new transaction", body: "", data: {} },
      { title: "New transaction", body: "AED 12", data: {} },
    ]) expect(await handleNotificationTap(content, sync)).toBe(false);
    expect(syncs).toBe(0);
  });
});
