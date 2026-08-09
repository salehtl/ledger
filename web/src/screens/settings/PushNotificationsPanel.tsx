/**
 * Settings → Device → Notifications.
 *
 * # The one thing the copy may promise
 *
 * That something arrived. Not what, not how much. The payload is content-free
 * on the server and the service worker renders its own constant
 * (`lib/pushNotification.ts`), so a sentence like "we'll tell you what you
 * spent" would be a promise the code refuses to keep. The line under the switch
 * says what a notification actually contains, because a user deciding whether
 * to allow lock-screen alerts is deciding about that.
 *
 * # Dismissed and blocked are different screens
 *
 * A browser that was never asked, or was asked and dismissed, will show the
 * prompt again — so the switch stays live and no explanation is owed. A browser
 * that was BLOCKED will never prompt again; `requestPermission()` resolves to
 * "denied" instantly and shows nothing. Offering "try again" there is a button
 * that cannot work, so the switch is replaced by the only instruction that can:
 * change it in the browser's own settings for this site.
 *
 * # Why the state is read from the browser and not from the server
 *
 * The server's listing says which rows exist for the ACCOUNT. This switch is
 * about THIS browser, and a row created by a browser whose site data was since
 * cleared would make it show "on" for something that receives nothing.
 */

import { useCallback, useEffect, useState } from "react";

import { Card } from "../../components/ui/Card";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { Switch } from "../../components/ui/Switch";
import { useToast } from "../../components/Toast";
import {
  disablePush,
  enablePush,
  fetchVapidKey,
  isPushSubscribed,
  pushPermission,
  pushUnsupportedReason,
  type PushEnvironment,
  type PushUnsupportedReason,
  type WebPushDeps,
} from "../../v2/webpush";

export interface PushNotificationsPanelProps {
  /** `handle.client` — read for its bearer token only. */
  client: { sessionToken: string | null };
  /** The profile `initV2` was given; namespaces the writer id. */
  profile?: string;
  server?: string;
  fetch?: typeof fetch;
  /** Test seams. Default to the real browser APIs. */
  env?: PushEnvironment;
  enable?: typeof enablePush;
  disable?: typeof disablePush;
  subscribed?: typeof isPushSubscribed;
  vapidKey?: typeof fetchVapidKey;
}

type Status =
  | { kind: "loading" }
  /** Nothing on this device can show a notification. */
  | { kind: "unsupported"; reason: PushUnsupportedReason }
  /** This deployment has no push configured. */
  | { kind: "unavailable" }
  /** Blocked in the browser's site settings. Only the user can undo it. */
  | { kind: "blocked" }
  | { kind: "ready"; on: boolean };

const UNSUPPORTED_COPY: Record<PushUnsupportedReason, string> = {
  browser: "This browser can't show notifications.",
  insecure: "Notifications need a secure connection.",
  install: "On iPhone and iPad, add ledger to your Home Screen first. Then notifications can be turned on.",
};

export function PushNotificationsPanel({
  client,
  profile,
  server,
  fetch: doFetch,
  env,
  enable = enablePush,
  disable = disablePush,
  subscribed = isPushSubscribed,
  vapidKey = fetchVapidKey,
}: PushNotificationsPanelProps) {
  const { show } = useToast();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const deps: WebPushDeps = {
    client,
    ...(profile === undefined ? {} : { profile }),
    ...(server === undefined ? {} : { server }),
    ...(doFetch === undefined ? {} : { fetch: doFetch }),
    ...env,
  };

  const load = useCallback(async () => {
    const reason = pushUnsupportedReason(env);
    if (reason !== null) {
      setStatus({ kind: "unsupported", reason });
      return;
    }
    // Asked before the permission state is reported, so a deployment with no
    // push configured shows "not set up here" rather than a switch whose only
    // possible outcome is a failure toast.
    const key = await vapidKey({
      ...(server === undefined ? {} : { server }),
      ...(doFetch === undefined ? {} : { fetch: doFetch }),
    }).catch(() => null);
    if (key === null) {
      setStatus({ kind: "unavailable" });
      return;
    }
    if (pushPermission(env) === "denied") {
      setStatus({ kind: "blocked" });
      return;
    }
    setStatus({ kind: "ready", on: await subscribed(env) });
    // `env` and `deps` are deliberately NOT in the dependency lists here or on
    // `toggle`. Both are object literals rebuilt on every render, so including
    // them would re-run this effect on every render — a permission check and a
    // network call in a loop. What they hold is either a prop that is fixed for
    // the life of the panel or a live browser API that is read at call time
    // regardless, so the stale closure this normally guards against cannot
    // arise.
  }, [doFetch, server, subscribed, vapidKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (next: boolean) => {
      setBusy(true);
      try {
        if (!next) {
          if (await disable(deps)) setStatus({ kind: "ready", on: false });
          else show({ message: "Couldn't turn notifications off. Try again.", tone: "error" });
          return;
        }
        const outcome = await enable(deps);
        switch (outcome.kind) {
          case "on":
            setStatus({ kind: "ready", on: true });
            break;
          case "denied":
            // Not a toast: this is a lasting state of the browser, and it needs
            // the instruction that goes with it.
            setStatus({ kind: "blocked" });
            break;
          case "dismissed":
            // Said quietly. The user closed a prompt; nothing went wrong, and
            // the switch stays available because the prompt can come back.
            setStatus({ kind: "ready", on: false });
            break;
          case "unavailable":
            setStatus({ kind: "unavailable" });
            break;
          case "failed":
            setStatus({ kind: "ready", on: false });
            show({ message: "Couldn't turn notifications on. Try again.", tone: "error" });
            break;
        }
      } finally {
        setBusy(false);
      }
    },
    [disable, enable, show], // deps: see the note on `load`
  );

  return (
    <section className="space-y-2" data-testid="push-notifications">
      <SectionLabel as="h2" className="px-1">
        Notifications
      </SectionLabel>
      <Card className="space-y-3">
        {status.kind === "loading" ? (
          <p className="text-sm text-muted">Checking…</p>
        ) : status.kind === "unsupported" ? (
          <p className="text-sm leading-relaxed text-muted">{UNSUPPORTED_COPY[status.reason]}</p>
        ) : status.kind === "unavailable" ? (
          <p className="text-sm leading-relaxed text-muted">Notifications are not set up on this server.</p>
        ) : status.kind === "blocked" ? (
          <>
            <p className="text-sm leading-relaxed">Notifications are blocked for ledger in this browser.</p>
            <p className="text-sm leading-relaxed text-muted">
              Only you can undo that, in your browser's settings for this site. ledger cannot ask again.
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 min-h-11">
              <div className="min-w-0">
                <p className="text-sm font-medium">Notify me on this device</p>
                <p className="text-xs text-muted">Says that something arrived. Never what or how much.</p>
              </div>
              <Switch
                aria-label="Notifications on this device"
                checked={status.on}
                disabled={busy}
                onChange={(e) => void toggle(e.target.checked)}
              />
            </div>
            <p className="text-sm leading-relaxed text-muted">Open ledger to see what it was.</p>
          </>
        )}
      </Card>
    </section>
  );
}
