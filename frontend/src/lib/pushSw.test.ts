import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `public/push-sw.js` is imported into the generated service worker via
 * Workbox `importScripts`, so it never passes through the bundler and no other
 * test would ever execute it. It is also the one piece of push that runs when
 * the app is closed — exactly when nobody is watching. Run it here against a
 * stubbed worker global.
 */
const SOURCE = readFileSync(join(__dirname, "../../public/push-sw.js"), "utf8");

type Handler = (event: unknown) => void;

function loadWorker() {
  const handlers: Record<string, Handler> = {};
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const self = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    registration: { showNotification },
  };
  const clients = { matchAll: vi.fn().mockResolvedValue([]), openWindow: vi.fn() };
  // eslint-disable-next-line no-new-func
  new Function("self", "clients", SOURCE)(self, clients);
  return { handlers, showNotification, clients };
}

/** A push event whose data.json() behaves as the test dictates. */
function pushEvent(data: { json?: () => unknown; text?: () => string } | null) {
  const waits: unknown[] = [];
  return {
    event: { data, waitUntil: (p: unknown) => waits.push(p) },
    waits,
  };
}

let w: ReturnType<typeof loadWorker>;
beforeEach(() => {
  w = loadWorker();
});

describe("push-sw.js push handler", () => {
  it("registers push and notificationclick listeners", () => {
    expect(typeof w.handlers.push).toBe("function");
    expect(typeof w.handlers.notificationclick).toBe("function");
  });

  it("shows the {title, body} the server sends", () => {
    const { event } = pushEvent({
      json: () => ({ title: "ledger", body: "Dining is at 80% of its envelope." }),
    });
    w.handlers.push(event);
    expect(w.showNotification).toHaveBeenCalledWith(
      "ledger",
      expect.objectContaining({ body: "Dining is at 80% of its envelope." }),
    );
  });

  it("still notifies when the payload is not JSON, falling back to its text", () => {
    // iOS can revoke push permission from a push handled without showing a
    // notification, so a malformed payload must never mean silence.
    const { event } = pushEvent({
      json: () => {
        throw new Error("not json");
      },
      text: () => "raw text body",
    });
    w.handlers.push(event);
    expect(w.showNotification).toHaveBeenCalledWith(
      "ledger",
      expect.objectContaining({ body: "raw text body" }),
    );
  });

  it("still notifies when there is no payload at all", () => {
    const { event } = pushEvent(null);
    w.handlers.push(event);
    expect(w.showNotification).toHaveBeenCalledWith("ledger", expect.objectContaining({ body: "" }));
  });

  it("ignores a non-string title rather than rendering [object Object]", () => {
    const { event } = pushEvent({ json: () => ({ title: { a: 1 }, body: "hi" }) });
    w.handlers.push(event);
    expect(w.showNotification).toHaveBeenCalledWith("ledger", expect.objectContaining({ body: "hi" }));
  });

  it("collapses repeats under one tag so alerts don't stack into a wall", () => {
    const { event } = pushEvent({ json: () => ({ title: "ledger", body: "x" }) });
    w.handlers.push(event);
    expect(w.showNotification).toHaveBeenCalledWith("ledger", expect.objectContaining({ tag: "ledger" }));
  });

  it("keeps the work inside waitUntil so the worker isn't killed mid-notification", () => {
    const { event, waits } = pushEvent({ json: () => ({ title: "ledger", body: "x" }) });
    w.handlers.push(event);
    expect(waits).toHaveLength(1);
  });
});

describe("push-sw.js notificationclick handler", () => {
  it("focuses an already-open window instead of opening a second one", async () => {
    const focus = vi.fn();
    w.clients.matchAll.mockResolvedValue([{ focus, url: "http://x/" }]);
    const close = vi.fn();
    const waits: unknown[] = [];
    w.handlers.notificationclick({ notification: { close }, waitUntil: (p: unknown) => waits.push(p) });
    await waits[0];
    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(w.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens the app when no window is open", async () => {
    w.clients.matchAll.mockResolvedValue([]);
    const waits: unknown[] = [];
    w.handlers.notificationclick({ notification: { close: vi.fn() }, waitUntil: (p: unknown) => waits.push(p) });
    await waits[0];
    expect(w.clients.openWindow).toHaveBeenCalledWith("/");
  });
});
