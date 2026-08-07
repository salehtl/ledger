/**
 * Pure Web Push helpers.
 *
 * The decision logic lives here rather than in NotificationsPage so the
 * awkward cases — a denied permission that no in-page button can undo, a
 * browser with no PushManager at all, Safari reporting a stale permission
 * while a subscription is live — are unit-testable without a service worker.
 */

/** What the UI should offer, in priority order. */
export type PushState =
  /** No serviceWorker/PushManager: iOS Safari outside an installed PWA. */
  | "unsupported"
  /** Permission denied — only the OS settings can reverse it. */
  | "blocked"
  /** Subscribed on this device. */
  | "subscribed"
  /** Supported, not subscribed: offer the enable button. */
  | "idle";

export function derivePushState(input: {
  supported: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
}): PushState {
  if (!input.supported) return "unsupported";
  // An existing subscription wins over a "default" permission read: Safari has
  // been seen reporting `default` while a subscription is still registered,
  // and offering "Enable" there would subscribe the same device twice.
  if (input.subscribed) return "subscribed";
  if (input.permission === "denied") return "blocked";
  return "idle";
}

/**
 * `applicationServerKey` takes raw bytes, but the server serves the VAPID key
 * as URL-safe base64 (`-`/`_`, no padding) — which `atob` rejects.
 */
// Returns Uint8Array<ArrayBuffer> rather than the default
// Uint8Array<ArrayBufferLike>: `applicationServerKey` demands a view backed by
// a real ArrayBuffer (not a SharedArrayBuffer), so building it over an
// explicit buffer keeps the call site cast-free.
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const standard = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(standard);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushSubPayload = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * Flattens a PushSubscription into the body `POST /api/push/subscribe` wants.
 * Returns null when the keys are missing rather than POSTing something the
 * server would reject with a 400 — the caller reports that as a failure to
 * enable instead of silently "succeeding" with a subscription that can never
 * be delivered to.
 */
export function subscriptionPayload(sub: PushSubscription): PushSubPayload | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** True when this browser can actually do Web Push. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}
