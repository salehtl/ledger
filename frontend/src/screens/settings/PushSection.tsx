import { useCallback, useEffect, useState } from "react";
import { getJSON, postJSON } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/Toast";
import {
  derivePushState,
  pushSupported,
  subscriptionPayload,
  urlBase64ToUint8Array,
  type PushState,
} from "../../lib/push";

/**
 * Settings → Notifications → "Push notifications": the browser half of Web
 * Push. The threshold and upcoming-bill gates below it decide *when* to
 * notify; nothing is delivered at all until this device has a subscription
 * registered with the server, which is why it sits at the top.
 *
 * Permission is requested from the button's tap on purpose — asking on mount
 * is both hostile and, on iOS, rejected outright as a non-user gesture.
 */
export function PushSection() {
  const { show } = useToast();
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setState(
        derivePushState({
          supported: true,
          permission: Notification.permission,
          subscribed: sub !== null,
        }),
      );
    } catch {
      setState("unsupported");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(derivePushState({ supported: true, permission, subscribed: false }));
        if (permission === "denied") show({ message: "Notifications blocked", tone: "error" });
        return;
      }
      const { public_key } = await getJSON<{ public_key: string }>("/api/push/vapid-public");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        // Required by every browser, and iOS enforces it: each push MUST
        // surface a visible notification.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key),
      });
      const payload = subscriptionPayload(sub);
      if (!payload) throw new Error("subscription is missing its keys");
      await postJSON("/api/push/subscribe", payload);
      setState("subscribed");
      show({ message: "Push enabled on this device" });
    } catch {
      show({ message: "Couldn't enable push notifications", tone: "error" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Tell the server first: if unsubscribe() succeeds and the DELETE then
        // fails, the server keeps pushing to a dead endpoint forever.
        await postJSON("/api/push/subscribe", { endpoint: sub.endpoint }, "DELETE");
        await sub.unsubscribe();
      }
      setState("idle");
      show({ message: "Push disabled on this device" });
    } catch {
      show({ message: "Couldn't disable push notifications", tone: "error" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      await postJSON("/api/push/test", {});
      show({ message: "Test notification sent" });
    } catch {
      show({ message: "Couldn't send the test notification", tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return null;

  return (
    <div>
      <p className="text-sm font-medium mb-1">Push notifications</p>

      {state === "unsupported" ? (
        <p className="text-xs text-muted">
          This browser can't receive push notifications. On iPhone, open ledger in Safari, tap Share
          → Add to Home Screen, then turn push on from the installed app.
        </p>
      ) : state === "blocked" ? (
        <p className="text-xs text-muted">
          Notifications are blocked for this site. Re-allow them in iOS Settings → Notifications →
          ledger, then come back.
        </p>
      ) : state === "subscribed" ? (
        <>
          <p className="text-xs text-muted mb-2">Enabled on this device.</p>
          <div className="flex gap-2">
            <Button onClick={sendTest} disabled={busy}>
              Send test
            </Button>
            <Button variant="ghost" onClick={disable} disabled={busy}>
              Disable
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-xs text-muted mb-2">
            Get alerts on this device even when ledger isn't open.
          </p>
          <Button variant="primary" onClick={enable} disabled={busy}>
            Enable on this device
          </Button>
        </>
      )}
    </div>
  );
}
