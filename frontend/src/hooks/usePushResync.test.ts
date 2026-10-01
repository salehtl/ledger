import { afterEach, describe, expect, it, vi } from "vitest";
import { resyncPush } from "./usePushResync";

/** Installs a fake service worker registration; `sub` null means none. */
function stubPush(sub: { endpoint: string; keys?: boolean } | null) {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const local = sub && {
    endpoint: sub.endpoint,
    unsubscribe,
    toJSON: () => ({
      endpoint: sub.endpoint,
      keys: sub.keys === false ? undefined : { p256dh: "PPP", auth: "AAA" },
    }),
  };
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(local) } }) },
  });
  vi.stubGlobal("PushManager", function PushManager() {});
  // Safari has reported "default" while a subscription is live, so the
  // re-sync must not gate on permission.
  vi.stubGlobal("Notification", { permission: "default" });
  return { unsubscribe };
}

function stubFetch(status: number) {
  const fetchMock = vi.fn(async () => new Response(status === 204 ? null : "{}", { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resyncPush", () => {
  it("re-sends the phone's subscription, marked as a re-sync, so a server that lost it gets it back", async () => {
    stubPush({ endpoint: "https://push.example.com/live" });
    const fetchMock = stubFetch(204);
    expect(await resyncPush()).toBe("synced");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/push/subscribe");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      endpoint: "https://push.example.com/live",
      keys: { p256dh: "PPP", auth: "AAA" },
      resync: true,
    });
  });

  it("drops a subscription the server says is gone, so Settings offers Enable again", async () => {
    const { unsubscribe } = stubPush({ endpoint: "https://push.example.com/dead" });
    stubFetch(410);
    expect(await resyncPush()).toBe("gone");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps the subscription on any other failure (offline, 500)", async () => {
    const { unsubscribe } = stubPush({ endpoint: "https://push.example.com/live" });
    stubFetch(500);
    expect(await resyncPush()).toBe("error");
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("does nothing when the phone has no subscription", async () => {
    stubPush(null);
    const fetchMock = stubFetch(204);
    expect(await resyncPush()).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing where push is unsupported", async () => {
    vi.stubGlobal("navigator", {});
    const fetchMock = stubFetch(204);
    expect(await resyncPush()).toBe("none");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
