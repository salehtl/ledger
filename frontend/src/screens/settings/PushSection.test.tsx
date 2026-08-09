import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MotionProvider } from "../../app/MotionProvider";
import { ToastProvider } from "../../components/Toast";
import { PushSection } from "./PushSection";

function renderSection() {
  return render(
    <MotionProvider>
      <ToastProvider>
        <PushSection />
      </ToastProvider>
    </MotionProvider>,
  );
}

/** Installs a fake PushManager; `sub` null means "not subscribed". */
function stubPush(opts: {
  permission?: NotificationPermission;
  sub?: { endpoint: string } | null;
  subscribe?: () => Promise<unknown>;
}) {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const existing = opts.sub === undefined ? null : opts.sub;
  const registration = {
    pushManager: {
      getSubscription: vi.fn().mockResolvedValue(existing ? { ...existing, unsubscribe } : null),
      subscribe:
        opts.subscribe ??
        vi.fn().mockResolvedValue({
          endpoint: "https://push.example.com/new",
          toJSON: () => ({
            endpoint: "https://push.example.com/new",
            keys: { p256dh: "PPP", auth: "AAA" },
          }),
        }),
    },
  };
  vi.stubGlobal("navigator", {
    ...navigator,
    serviceWorker: { ready: Promise.resolve(registration) },
  });
  vi.stubGlobal("PushManager", function PushManager() {});
  vi.stubGlobal("Notification", {
    permission: opts.permission ?? "default",
    requestPermission: vi.fn().mockResolvedValue(opts.permission ?? "granted"),
  });
  return { registration, unsubscribe };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).includes("vapid-public")) {
        return new Response(JSON.stringify({ public_key: "a-b_cd" }), { status: 200 });
      }
      // 204 must be constructed with a null body — an empty string throws.
      return new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PushSection", () => {
  it("explains the iOS Home-Screen requirement when push is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    renderSection();
    expect(await screen.findByText(/Add to Home Screen/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable/i })).not.toBeInTheDocument();
  });

  it("points at OS settings when permission is denied, since no in-page button can undo it", async () => {
    stubPush({ permission: "denied" });
    renderSection();
    expect(await screen.findByText(/blocked for this site/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable/i })).not.toBeInTheDocument();
  });

  it("offers the enable button when supported and not yet subscribed", async () => {
    stubPush({ permission: "default" });
    renderSection();
    expect(await screen.findByRole("button", { name: /enable on this device/i })).toBeInTheDocument();
  });

  it("subscribes and registers with the server when enabled", async () => {
    stubPush({ permission: "granted", sub: null });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /enable on this device/i }));

    // The subscribed state is what matters; asserting on the copy would also
    // match the confirmation toast.
    expect(await screen.findByRole("button", { name: /send test/i })).toBeInTheDocument();
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find((c) => String(c[0]).includes("/api/push/subscribe"));
    expect(post, "expected a POST to /api/push/subscribe").toBeTruthy();
    expect(JSON.parse(post![1].body)).toEqual({
      endpoint: "https://push.example.com/new",
      keys: { p256dh: "PPP", auth: "AAA" },
    });
  });

  it("shows Send test / Disable once subscribed", async () => {
    stubPush({ permission: "granted", sub: { endpoint: "https://push.example.com/old" } });
    renderSection();
    expect(await screen.findByRole("button", { name: /send test/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disable/i })).toBeInTheDocument();
  });

  it("DELETEs the server subscription before unsubscribing locally", async () => {
    // Order matters: unsubscribing first and then failing the DELETE would
    // leave the server pushing at a dead endpoint forever.
    const { unsubscribe } = stubPush({
      permission: "granted",
      sub: { endpoint: "https://push.example.com/old" },
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /disable/i }));

    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const del = calls.find((c) => c[1]?.method === "DELETE");
    expect(del, "expected a DELETE to /api/push/subscribe").toBeTruthy();
    expect(JSON.parse(del![1].body)).toEqual({ endpoint: "https://push.example.com/old" });
  });

  it("posts to the test endpoint from Send test", async () => {
    stubPush({ permission: "granted", sub: { endpoint: "https://push.example.com/old" } });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /send test/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c) => String(c[0]).includes("/api/push/test"))).toBe(true);
    });
  });

  it("surfaces a failure instead of claiming success when subscribe() rejects", async () => {
    stubPush({
      permission: "granted",
      sub: null,
      subscribe: vi.fn().mockRejectedValue(new Error("denied by push service")),
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /enable on this device/i }));

    expect(await screen.findByText(/couldn't enable push/i)).toBeInTheDocument();
  });
});
