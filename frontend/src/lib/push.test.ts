import { describe, expect, it } from "vitest";
import { derivePushState, subscriptionPayload, urlBase64ToUint8Array } from "./push";

describe("derivePushState", () => {
  it("reports unsupported before anything else — a denied permission is moot without an API", () => {
    expect(derivePushState({ supported: false, permission: "denied", subscribed: false })).toBe("unsupported");
    expect(derivePushState({ supported: false, permission: "granted", subscribed: true })).toBe("unsupported");
  });

  it("reports blocked when the user denied permission, since no button can undo it in-page", () => {
    expect(derivePushState({ supported: true, permission: "denied", subscribed: false })).toBe("blocked");
  });

  it("reports subscribed only when a subscription actually exists", () => {
    expect(derivePushState({ supported: true, permission: "granted", subscribed: true })).toBe("subscribed");
    expect(derivePushState({ supported: true, permission: "granted", subscribed: false })).toBe("idle");
  });

  it("treats a default (never-asked) permission as idle so the button is offered", () => {
    expect(derivePushState({ supported: true, permission: "default", subscribed: false })).toBe("idle");
  });

  it("trusts an existing subscription over a stale 'default' permission read", () => {
    // Safari has been observed reporting `default` while a subscription lives
    // on. Showing "Enable" there would double-subscribe the same device.
    expect(derivePushState({ supported: true, permission: "default", subscribed: true })).toBe("subscribed");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes the URL-safe base64 VAPID key into the 65 bytes subscribe() wants", () => {
    const key = "BGtHjBJ1oCC5665l69-OxGlHtZV0-Q7QXwL4pLNrDANa6lO6iRg_P5unlyNYxME73nvo3mUgzNCFOmnJjIbH8ys";
    const out = urlBase64ToUint8Array(key);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(65);
    expect(out[0]).toBe(0x04); // uncompressed EC point marker
  });

  it("translates the URL-safe alphabet rather than choking on - and _", () => {
    // "-" and "_" stand in for "+" and "/"; atob rejects them outright.
    expect(() => urlBase64ToUint8Array("a-b_cd")).not.toThrow();
    // Same bytes whether the caller hands us the URL-safe or standard form.
    expect(urlBase64ToUint8Array("a-b_cd")).toEqual(urlBase64ToUint8Array("a+b/cd"));
  });
});

describe("subscriptionPayload", () => {
  it("flattens a PushSubscription into the shape POST /api/push/subscribe requires", () => {
    const sub = {
      endpoint: "https://push.example.com/xyz",
      toJSON: () => ({
        endpoint: "https://push.example.com/xyz",
        keys: { p256dh: "PPP", auth: "AAA" },
      }),
    } as unknown as PushSubscription;
    expect(subscriptionPayload(sub)).toEqual({
      endpoint: "https://push.example.com/xyz",
      keys: { p256dh: "PPP", auth: "AAA" },
    });
  });

  it("returns null when keys are absent, so we never POST a subscription the server will 400", () => {
    const sub = {
      endpoint: "https://push.example.com/xyz",
      toJSON: () => ({ endpoint: "https://push.example.com/xyz" }),
    } as unknown as PushSubscription;
    expect(subscriptionPayload(sub)).toBeNull();
  });
});
