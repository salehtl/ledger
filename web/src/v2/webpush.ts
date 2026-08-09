/**
 * Turning browser notifications on and off.
 *
 * # What a notification from ledger says
 *
 * "New activity", and nothing else — no merchant, no amount, no count. The
 * server's payload is content-free (`internal/v2/pushv2/webpush.go`) and the
 * service worker renders its own constant regardless
 * (`lib/pushNotification.ts`). Any copy this module's callers show has to be
 * true of that, which rules out "we'll tell you what you spent".
 *
 * # Permission has three states and only two of them are the same story
 *
 * `Notification.permission` is `granted`, `denied` or `default`, and the
 * distinction that matters is between the last two:
 *
 *  - `default` — never asked, or asked and DISMISSED. The browser will show the
 *    prompt again. Offering the switch again is correct.
 *  - `denied` — the user (or a policy) said no. `requestPermission()` resolves
 *    to `denied` immediately WITHOUT showing anything, forever, until the user
 *    changes it in the browser's own site settings. A UI that responds to this
 *    by offering "try again" is a button that cannot work, and copy that says
 *    "allow notifications when prompted" describes a prompt that will not
 *    appear.
 *
 * {@link enablePush} returns those as separate kinds so a caller cannot
 * accidentally collapse them.
 *
 * # Why it re-subscribes every time rather than trusting stored state
 *
 * A push subscription can be retired by the browser without the page being
 * told: clearing site data, a `pushsubscriptionchange` while nothing is open, a
 * profile sync. The server row would survive and every send to it would fail.
 * So {@link enablePush} always calls `subscribe()` — which returns the existing
 * subscription unchanged when there is one — and always re-POSTs it. The server
 * side is an upsert that does not touch `created_at`, so a repeat is free.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";

import { fromBase64Url, SECRET_WRITER_ID, webSecretStore } from "./session";

/**
 * Why notifications are not available on this device at all.
 *
 * Three reasons and not a boolean, because they need different sentences and
 * only one of them is something the person can act on. Telling an iPhone user
 * "this browser can't show notifications" would be false AND would hide the fix.
 */
export type PushUnsupportedReason =
  /** No `serviceWorker` and no `Notification`. Nothing to be done. */
  | "browser"
  /** Not a secure context — plain http. Push requires https. */
  | "insecure"
  /**
   * Secure, has a service worker, but no `PushManager`. This is iOS Safari in
   * an ordinary tab: it withholds push until the site is added to the Home
   * Screen. Actionable, and the actionable one.
   */
  | "install";

export type PushOutcome =
  /** Subscribed, and the server has it. */
  | { kind: "on" }
  /** The prompt was dismissed. It can be shown again. */
  | { kind: "dismissed" }
  /** Blocked. Only the browser's site settings can undo this. */
  | { kind: "denied" }
  /** This server has no VAPID key configured, so there is nothing to subscribe to. */
  | { kind: "unavailable" }
  /** Something failed. `detail` is for a log, not for a user. */
  | { kind: "failed"; detail: string };

export interface PushEnvironment {
  /** Defaults to the global `navigator`. */
  navigator?: Navigator;
  /** Defaults to the global `Notification`. Injected by tests. */
  notification?: {
    permission: NotificationPermission;
    requestPermission: () => Promise<NotificationPermission>;
  };
  /** Defaults to `isSecureContext`. */
  secureContext?: boolean;
}

export interface WebPushDeps extends PushEnvironment {
  /** `handle.client` — read for its bearer token only. */
  client: { sessionToken: string | null };
  /** Same profile name `initV2` was given; namespaces the writer id. */
  profile?: string;
  server?: string;
  fetch?: typeof fetch;
}

/** Whether this browser can show push notifications at all; `null` when it can. */
export function pushUnsupportedReason(env: PushEnvironment = {}): PushUnsupportedReason | null {
  const nav = env.navigator ?? (typeof navigator === "undefined" ? undefined : navigator);
  const secure = env.secureContext ?? (typeof isSecureContext === "undefined" ? true : isSecureContext);
  const notification = env.notification ?? (typeof Notification === "undefined" ? undefined : Notification);
  if (nav === undefined || !("serviceWorker" in nav) || notification === undefined) return "browser";
  // Ordered: an insecure context has no PushManager either, and "you are on
  // http" is the more specific answer than "add it to your Home Screen".
  if (!secure) return "insecure";
  if (typeof PushManager === "undefined") return "install";
  return null;
}

/** The current permission, without asking for anything. */
export function pushPermission(env: PushEnvironment = {}): NotificationPermission {
  const notification = env.notification ?? (typeof Notification === "undefined" ? undefined : Notification);
  return notification?.permission ?? "default";
}

function doFetchOf(deps: WebPushDeps): typeof fetch {
  return deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
}

async function authed(deps: WebPushDeps, method: string, path: string, body?: unknown): Promise<Response> {
  const token = deps.client.sessionToken;
  if (token === null || token === "") {
    throw new ApiError(401, "unauthorized", "", `${method} ${path}: no session`);
  }
  try {
    return await doFetchOf(deps)(`${deps.server ?? ""}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new NetworkError(`${method} ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

/**
 * The deployment's VAPID public key, or `null` when this server has none.
 *
 * `null` is a first-class answer, not an error: a deployment can legitimately
 * run without Web Push configured, and the honest thing to show then is "not
 * set up on this server" rather than a switch that turns on and delivers
 * nothing. The route needs no session, so this can be asked before sign-in.
 */
export async function fetchVapidKey(deps: Pick<WebPushDeps, "server" | "fetch">): Promise<string | null> {
  const path = "/api/v1/push/vapid";
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${deps.server ?? ""}${path}`);
  } catch (err) {
    throw new NetworkError(`GET ${path}: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new ApiError(res.status, "", "", `GET ${path}: ${String(res.status)}`);
  const body = (await res.json()) as { public_key?: string };
  return body.public_key === undefined || body.public_key === "" ? null : body.public_key;
}

/**
 * The writer id this browser enrolled under.
 *
 * Read, never minted. `ensureWriterId` would create one, and a subscription
 * naming a writer the server has never seen is refused — correctly, because
 * that link is what makes the subscription revocable. A device with no writer
 * id has not finished enrolling and cannot subscribe yet.
 */
function writerIdOf(deps: WebPushDeps): string | null {
  return webSecretStore(deps.profile ?? "ledger").get(SECRET_WRITER_ID);
}

/**
 * Ask for permission, subscribe, and tell the server.
 *
 * Never throws for a user decision — a dismissal and a block are outcomes, not
 * errors. It throws for nothing at all: a transport or server failure comes
 * back as `{kind: "failed"}` with a detail for the log, because every caller of
 * this is a switch that has to end up in a definite position.
 */
export async function enablePush(deps: WebPushDeps): Promise<PushOutcome> {
  if (pushUnsupportedReason(deps) !== null) {
    return { kind: "failed", detail: "push is not supported here" };
  }
  const notification = deps.notification ?? Notification;

  // Asked BEFORE requesting: a blocked browser resolves requestPermission() to
  // "denied" instantly and shows nothing, so calling it would be
  // indistinguishable from the user having just refused.
  if (notification.permission === "denied") return { kind: "denied" };

  const key = await fetchVapidKey(deps).catch(() => undefined);
  if (key === undefined) return { kind: "failed", detail: "could not read the server's push key" };
  // Checked before the prompt. Asking a user for permission and then telling
  // them it was pointless is the one ordering that wastes the single prompt a
  // browser will show.
  if (key === null) return { kind: "unavailable" };

  const writerId = writerIdOf(deps);
  if (writerId === null) return { kind: "failed", detail: "this device has no writer id yet" };

  const permission = await notification.requestPermission();
  if (permission === "denied") return { kind: "denied" };
  if (permission !== "granted") return { kind: "dismissed" };

  try {
    const nav = deps.navigator ?? navigator;
    const registration = await nav.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      // Required by Chrome, and true: every push shows a notification. A silent
      // push would be a background wake-up the user never agreed to.
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(key) as BufferSource,
    });
    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (json.endpoint === undefined || p256dh === undefined || auth === undefined) {
      return { kind: "failed", detail: "the browser returned an incomplete subscription" };
    }
    const res = await authed(deps, "POST", "/api/v1/push/subscriptions", {
      endpoint: json.endpoint,
      p256dh,
      auth,
      writer_id: writerId,
    });
    if (res.status === 404) {
      // The server lost its VAPID key between the two calls. Undo the local
      // subscription rather than leaving a browser subscribed to a deployment
      // that will never send to it.
      await subscription.unsubscribe().catch(() => undefined);
      return { kind: "unavailable" };
    }
    if (!res.ok) {
      await subscription.unsubscribe().catch(() => undefined);
      return { kind: "failed", detail: `subscribe answered ${String(res.status)}` };
    }
    return { kind: "on" };
  } catch (err) {
    return { kind: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Stop notifications on this browser.
 *
 * The server row is deleted FIRST. If the order were reversed and the request
 * failed, the browser would hold no subscription while the server still held a
 * row it would keep sending to — a notification nothing could turn off, which
 * is exactly the state 00019 was written to make impossible.
 *
 * Returns true when the browser is left unsubscribed.
 */
export async function disablePush(deps: WebPushDeps): Promise<boolean> {
  const nav = deps.navigator ?? (typeof navigator === "undefined" ? undefined : navigator);
  if (nav === undefined || !("serviceWorker" in nav)) return true;
  const registration = await nav.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return true;
  const res = await authed(
    deps,
    "DELETE",
    `/api/v1/push/subscriptions/${encodeURIComponent(subscription.endpoint)}`,
  );
  // 404 means the deployment has no web push configured any more; the row
  // cannot exist, so unsubscribing locally is still the right end state.
  if (!res.ok && res.status !== 404) return false;
  return subscription.unsubscribe();
}

/**
 * Whether THIS browser currently holds a subscription.
 *
 * Read from the browser rather than from the server: the server's listing says
 * what rows exist for the account, and a row created by a browser whose site
 * data was since cleared would make this switch show "on" for a device that
 * receives nothing.
 */
export async function isPushSubscribed(env: PushEnvironment = {}): Promise<boolean> {
  if (pushUnsupportedReason(env) !== null) return false;
  const nav = env.navigator ?? navigator;
  const registration = await nav.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) !== null;
}
