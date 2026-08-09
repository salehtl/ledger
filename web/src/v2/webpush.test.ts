import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  disablePush,
  enablePush,
  fetchVapidKey,
  isPushSubscribed,
  pushUnsupportedReason,
  type PushEnvironment,
  type WebPushDeps,
} from "./webpush";
import { SECRET_WRITER_ID, webSecretStore } from "./session";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const ENDPOINT = "https://push.example.test/sub/abc";

/** A PushSubscription as a browser hands one back. */
function fakeSubscription(unsubscribe = vi.fn().mockResolvedValue(true)) {
  return {
    endpoint: ENDPOINT,
    unsubscribe,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: "p256dh-value", auth: "auth-value" } }),
  } as unknown as PushSubscription;
}

interface FakeBrowser {
  env: PushEnvironment;
  subscribe: ReturnType<typeof vi.fn>;
  getSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
}

function fakeBrowser(opts: {
  permission?: NotificationPermission;
  grants?: NotificationPermission;
  existing?: PushSubscription | null;
  subscription?: PushSubscription;
}): FakeBrowser {
  const subscription = opts.subscription ?? fakeSubscription();
  const subscribe = vi.fn().mockResolvedValue(subscription);
  const getSubscription = vi.fn().mockResolvedValue(opts.existing ?? null);
  const requestPermission = vi.fn().mockResolvedValue(opts.grants ?? "granted");
  return {
    subscribe,
    getSubscription,
    requestPermission,
    env: {
      navigator: {
        serviceWorker: { ready: Promise.resolve({ pushManager: { subscribe, getSubscription } }) },
      } as unknown as Navigator,
      notification: { permission: opts.permission ?? "default", requestPermission },
      secureContext: true,
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deps(browser: FakeBrowser, doFetch: typeof fetch): WebPushDeps {
  return { client: { sessionToken: "session-token" }, profile: "test", fetch: doFetch, ...browser.env };
}

beforeEach(() => {
  // The writer id is READ, never minted — a subscription naming a writer the
  // server has never seen is refused. Planted here because these tests are not
  // about enrolment.
  webSecretStore("test").set(SECRET_WRITER_ID, "web-test-writer");
  // PushManager is a bare global that pushUnsupportedReason probes for.
  vi.stubGlobal("PushManager", function PushManager() {});
});

describe("pushUnsupportedReason", () => {
  it("names the browser when there is no service worker at all", () => {
    expect(
      pushUnsupportedReason({
        navigator: {} as Navigator,
        notification: { permission: "default", requestPermission: vi.fn() },
      }),
    ).toBe("browser");
  });

  // The iOS case, and the reason this is not a boolean: a user on an iPhone can
  // fix it, and telling them "this browser can't show notifications" would be
  // both false and a dead end.
  it("says install when a secure context has a service worker but no PushManager", () => {
    vi.stubGlobal("PushManager", undefined);
    expect(
      pushUnsupportedReason({
        navigator: { serviceWorker: {} } as unknown as Navigator,
        notification: { permission: "default", requestPermission: vi.fn() },
        secureContext: true,
      }),
    ).toBe("install");
  });

  it("says insecure before it says install, because http is the more specific answer", () => {
    vi.stubGlobal("PushManager", undefined);
    expect(
      pushUnsupportedReason({
        navigator: { serviceWorker: {} } as unknown as Navigator,
        notification: { permission: "default", requestPermission: vi.fn() },
        secureContext: false,
      }),
    ).toBe("insecure");
  });
});

describe("fetchVapidKey", () => {
  it("reads null from a 404 rather than throwing", async () => {
    const doFetch = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(fetchVapidKey({ fetch: doFetch as unknown as typeof fetch })).resolves.toBeNull();
  });

  it("reads the key from a 200", async () => {
    const doFetch = vi.fn().mockResolvedValue(jsonResponse(200, { public_key: KEY }));
    await expect(fetchVapidKey({ fetch: doFetch as unknown as typeof fetch })).resolves.toBe(KEY);
  });
});

describe("enablePush", () => {
  it("subscribes and posts the browser's own subscription fields", async () => {
    const browser = fakeBrowser({});
    const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/vapid")) return jsonResponse(200, { public_key: KEY });
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        endpoint: ENDPOINT,
        p256dh: "p256dh-value",
        auth: "auth-value",
        writer_id: "web-test-writer",
      });
      return new Response(null, { status: 204 });
    });

    await expect(enablePush(deps(browser, doFetch as unknown as typeof fetch))).resolves.toEqual({ kind: "on" });
    expect(browser.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.anything() }),
    );
  });

  // The distinction the whole permission model turns on. A dismissed prompt can
  // be shown again; a block cannot, and `requestPermission()` would resolve
  // "denied" instantly without showing anything.
  it("reports a dismissed prompt separately from a block", async () => {
    const dismissed = fakeBrowser({ grants: "default" });
    const doFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/vapid") ? jsonResponse(200, { public_key: KEY }) : new Response(null, { status: 204 }),
    );
    await expect(enablePush(deps(dismissed, doFetch as unknown as typeof fetch))).resolves.toEqual({
      kind: "dismissed",
    });
    expect(dismissed.subscribe).not.toHaveBeenCalled();
  });

  it("reports a block without prompting, because prompting is a no-op once blocked", async () => {
    const blocked = fakeBrowser({ permission: "denied" });
    const doFetch = vi.fn();
    await expect(enablePush(deps(blocked, doFetch as unknown as typeof fetch))).resolves.toEqual({ kind: "denied" });
    expect(blocked.requestPermission).not.toHaveBeenCalled();
    // Not even the key is fetched: nothing about this browser can subscribe.
    expect(doFetch).not.toHaveBeenCalled();
  });

  // The single prompt a browser will show must not be spent on a deployment
  // that cannot send anything.
  it("does not prompt when the server has no push key", async () => {
    const browser = fakeBrowser({});
    const doFetch = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    await expect(enablePush(deps(browser, doFetch as unknown as typeof fetch))).resolves.toEqual({
      kind: "unavailable",
    });
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });

  // A local subscription the server does not know about is a browser that
  // believes notifications are on and receives nothing, permanently.
  it("undoes the browser subscription when the server refuses to store it", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const browser = fakeBrowser({ subscription: fakeSubscription(unsubscribe) });
    const doFetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/vapid")
        ? jsonResponse(200, { public_key: KEY })
        : jsonResponse(400, { error: "invalid_writer" }),
    );
    const got = await enablePush(deps(browser, doFetch as unknown as typeof fetch));
    expect(got.kind).toBe("failed");
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("refuses to subscribe a device that has no writer id yet", async () => {
    webSecretStore("test").set(SECRET_WRITER_ID, null);
    const browser = fakeBrowser({});
    const doFetch = vi.fn().mockResolvedValue(jsonResponse(200, { public_key: KEY }));
    const got = await enablePush(deps(browser, doFetch as unknown as typeof fetch));
    expect(got.kind).toBe("failed");
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(browser.requestPermission).not.toHaveBeenCalled();
  });
});

describe("disablePush", () => {
  // Order matters and is the whole test: if the browser unsubscribed first and
  // the request then failed, the server would keep a row it sends to that
  // nothing can turn off.
  it("deletes the server row before it unsubscribes the browser", async () => {
    const order: string[] = [];
    const unsubscribe = vi.fn(async () => {
      order.push("unsubscribe");
      return true;
    });
    const browser = fakeBrowser({ existing: fakeSubscription(unsubscribe) });
    const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      order.push("delete");
      expect(init?.method).toBe("DELETE");
      expect(String(input)).toContain(encodeURIComponent(ENDPOINT));
      return new Response(null, { status: 204 });
    });

    await expect(disablePush(deps(browser, doFetch as unknown as typeof fetch))).resolves.toBe(true);
    expect(order).toEqual(["delete", "unsubscribe"]);
  });

  it("leaves the browser subscribed when the server delete fails", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const browser = fakeBrowser({ existing: fakeSubscription(unsubscribe) });
    const doFetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    await expect(disablePush(deps(browser, doFetch as unknown as typeof fetch))).resolves.toBe(false);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("is a no-op when this browser holds no subscription", async () => {
    const browser = fakeBrowser({ existing: null });
    const doFetch = vi.fn();
    await expect(disablePush(deps(browser, doFetch as unknown as typeof fetch))).resolves.toBe(true);
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe("isPushSubscribed", () => {
  // Read from the BROWSER, never from the server's listing: a row created by a
  // browser whose site data was since cleared would show "on" for a device that
  // receives nothing.
  it("reports what this browser holds", async () => {
    await expect(isPushSubscribed(fakeBrowser({ existing: fakeSubscription() }).env)).resolves.toBe(true);
    await expect(isPushSubscribed(fakeBrowser({ existing: null }).env)).resolves.toBe(false);
  });
});
