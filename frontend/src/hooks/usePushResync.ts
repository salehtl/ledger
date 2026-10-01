import { useEffect } from "react";
import { pushSupported, subscriptionPayload } from "../lib/push";

export type ResyncResult = "none" | "synced" | "gone" | "error";

/**
 * Re-sends this device's push subscription to the server, marked as a
 * re-sync. A server that lost the row (a prune, a restored backup) gets it
 * back without a tap. If a push service already declared the endpoint gone,
 * the server answers 410 and the dead local subscription is dropped, so
 * Settings offers "Enable on this device" instead of a false "Enabled".
 *
 * It never subscribes on its own: iOS requires a tap for that.
 */
export async function resyncPush(): Promise<ResyncResult> {
  if (!pushSupported()) return "none";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return "none";
    const payload = subscriptionPayload(sub);
    if (!payload) return "none";
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, resync: true }),
    });
    if (res.status === 410) {
      await sub.unsubscribe();
      return "gone";
    }
    return res.ok ? "synced" : "error";
  } catch {
    return "error";
  }
}

/** Runs resyncPush once, when the app opens. */
export function usePushResync() {
  useEffect(() => {
    void resyncPush();
  }, []);
}
