import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { PushNotificationsPanel, type PushNotificationsPanelProps } from "./PushNotificationsPanel";
import type { PushEnvironment } from "../../v2/webpush";

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";

/** A supported browser. The panel's own probes are stubbed through `env`. */
function supported(permission: NotificationPermission = "default"): PushEnvironment {
  return {
    navigator: { serviceWorker: {} } as unknown as Navigator,
    notification: { permission, requestPermission: vi.fn() },
    secureContext: true,
  };
}

function renderPanel(props: Partial<PushNotificationsPanelProps> = {}) {
  vi.stubGlobal("PushManager", function PushManager() {});
  return render(
    <ToastProvider>
      <PushNotificationsPanel
        client={{ sessionToken: "t" }}
        env={supported()}
        vapidKey={async () => KEY}
        subscribed={async () => false}
        enable={async () => ({ kind: "on" })}
        disable={async () => true}
        {...props}
      />
    </ToastProvider>,
  );
}

describe("PushNotificationsPanel", () => {
  it("offers a switch and turns notifications on", async () => {
    const enable = vi.fn(async () => ({ kind: "on" }) as const);
    renderPanel({ enable });
    const toggle = await screen.findByLabelText("Notifications on this device");
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(enable).toHaveBeenCalled();
  });

  // The distinction the whole panel exists to get right. A blocked browser will
  // never prompt again, so a switch there is a control that cannot work — and
  // copy telling the user to "allow it when asked" describes a prompt that will
  // not appear.
  it("replaces the switch with the only instruction that works once blocked", async () => {
    renderPanel({ enable: async () => ({ kind: "denied" }) });
    const toggle = await screen.findByLabelText("Notifications on this device");
    await userEvent.click(toggle);
    await waitFor(() => expect(screen.queryByLabelText("Notifications on this device")).toBeNull());
    expect(screen.getByText(/blocked for ledger in this browser/i)).toBeInTheDocument();
    expect(screen.getByText(/browser's settings for this site/i)).toBeInTheDocument();
  });

  // A dismissal is not a failure and must not be treated as one: the browser
  // will ask again, so the switch stays.
  it("keeps the switch available after a dismissed prompt", async () => {
    renderPanel({ enable: async () => ({ kind: "dismissed" }) });
    const toggle = await screen.findByLabelText("Notifications on this device");
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.getByLabelText("Notifications on this device")).toBeInTheDocument();
    expect(screen.queryByText(/blocked/i)).toBeNull();
  });

  it("says so plainly when the server has no push configured, and offers no switch", async () => {
    renderPanel({ vapidKey: async () => null });
    expect(await screen.findByText("Notifications are not set up on this server.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Notifications on this device")).toBeNull();
  });

  // The iPhone case. "This browser can't show notifications" would be false and
  // would hide the one action that fixes it.
  it("tells an uninstalled iOS browser to add ledger to the Home Screen", async () => {
    vi.stubGlobal("PushManager", undefined);
    render(
      <ToastProvider>
        <PushNotificationsPanel
          client={{ sessionToken: "t" }}
          env={supported()}
          vapidKey={async () => KEY}
          subscribed={async () => false}
        />
      </ToastProvider>,
    );
    expect(await screen.findByText(/add ledger to your Home Screen/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Notifications on this device")).toBeNull();
  });

  it("shows a browser already blocked as blocked without waiting for a click", async () => {
    renderPanel({ env: supported("denied") });
    expect(await screen.findByText(/blocked for ledger in this browser/i)).toBeInTheDocument();
  });

  it("turns notifications off again", async () => {
    const disable = vi.fn(async () => true);
    renderPanel({ subscribed: async () => true, disable });
    const toggle = await screen.findByLabelText("Notifications on this device");
    await waitFor(() => expect(toggle).toBeChecked());
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(disable).toHaveBeenCalled();
  });

  // Everything this panel says must be true of a content-free notification.
  it("never promises to say what was spent", async () => {
    const { container } = renderPanel();
    await screen.findByLabelText("Notifications on this device");
    const copy = container.textContent ?? "";
    for (const lie of ["amount", "merchant", "AED", "how much you", "what you spent"]) {
      expect(copy.toLowerCase()).not.toContain(lie.toLowerCase());
    }
    expect(copy).toContain("Never what or how much.");
  });
});
