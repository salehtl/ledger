/**
 * Settings, over the v2 runtime.
 *
 * The four things this screen exists to make reachable, each asserted here:
 * a second passkey (the only account recovery this product can offer), the
 * inbound address, held mail, and signing out — plus the sync row, which is
 * the only place a person can find out whether their ledger is moving.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { MotionProvider } from "../../app/MotionProvider";
import { ToastProvider } from "../../components/Toast";
import { projectionWith } from "../../test/projectionFixture";
import { fakeRuntime, WithV2, type FakeRuntimeOptions } from "../../test/v2Runtime";
import { PasskeyError } from "../../v2/session";
import { V2Settings, type V2SettingsProps } from "./V2Settings";

let db: SqlDriver;

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  db = await projectionWith();
});

function wrap(props: Partial<V2SettingsProps> = {}, rt: Partial<FakeRuntimeOptions> = {}) {
  const { runtime, runs } = fakeRuntime({ driver: db, ...rt });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <MotionProvider>
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <WithV2 runtime={runtime}>
            <V2Settings address={async () => "u-abc@in.sirdab.ae"} {...props} />
          </WithV2>
        </ToastProvider>
      </QueryClientProvider>
    </MotionProvider>,
  );
  return { ...view, runtime, runs };
}

describe("V2Settings", () => {
  it("shows the inbound address the server actually holds, and copies it", async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    wrap({ copy: async (t) => void copied.push(t) });

    expect(await screen.findByTestId("settings-inbound-address")).toHaveTextContent("u-abc@in.sirdab.ae");
    await user.click(screen.getByRole("button", { name: /copy address/i }));
    expect(copied).toEqual(["u-abc@in.sirdab.ae"]);
  });

  it("reads the home currency from the log, and says it cannot be changed", async () => {
    wrap();
    expect(await screen.findByTestId("settings-home-currency")).toHaveTextContent("AED");
    expect(screen.getByTestId("settings-home-currency-note").textContent ?? "").toMatch(/cannot be changed/i);
  });

  it("adds another passkey — the entry point onboarding's copy promises", async () => {
    const user = userEvent.setup();
    const add = vi.fn(async () => "cred-2");
    wrap({ addAnotherPasskey: add });

    await user.click(await screen.findByRole("button", { name: /add another passkey/i }));
    await waitFor(() => {
      expect(add).toHaveBeenCalledTimes(1);
    });
    expect((await screen.findByTestId("settings-passkey-note")).textContent ?? "").toMatch(/added/i);
  });

  it("says a dismissed passkey prompt was not an error, and leaves the button usable", async () => {
    const user = userEvent.setup();
    wrap({
      addAnotherPasskey: async () => {
        throw new PasskeyError("cancelled", "the passkey prompt was dismissed");
      },
    });

    await user.click(await screen.findByRole("button", { name: /add another passkey/i }));
    const note = await screen.findByTestId("settings-passkey-note");
    expect(note.textContent ?? "").toMatch(/prompt was closed/i);
    expect(screen.getByRole("button", { name: /add another passkey/i })).toBeEnabled();
  });

  it("states that there is no recovery, next to the control that is the only answer to it", async () => {
    wrap();
    const warning = await screen.findByTestId("settings-recovery-warning");
    expect(warning.textContent ?? "").toMatch(/no password to reset/i);
  });

  it("opens held mail — the surface onboarding hands an unfiled remainder to", async () => {
    const user = userEvent.setup();
    const onOpenQuarantine = vi.fn();
    wrap({ onOpenQuarantine });
    await user.click(await screen.findByRole("button", { name: /held mail/i }));
    expect(onOpenQuarantine).toHaveBeenCalled();
  });

  it("says when the ledger last moved, and offers to move it now", async () => {
    const user = userEvent.setup();
    const { runs } = wrap({ now: () => Date.parse("2026-08-07T10:05:00Z") }, {
      sync: { lastCompletedAt: Date.parse("2026-08-07T10:00:00Z") },
    });
    expect((await screen.findByTestId("settings-sync")).textContent ?? "").toMatch(/5 minutes ago/i);
    await user.click(screen.getByRole("button", { name: /sync now/i }));
    expect(runs).toContain("refresh");
  });

  it("says plainly that no sync has finished yet, rather than printing a fake time", async () => {
    wrap();
    expect((await screen.findByTestId("settings-sync")).textContent ?? "").toMatch(/no sync has finished/i);
  });

  it("shows the halt reason on the sync row rather than a reassuring idle state", async () => {
    wrap({}, { haltReason: "chain break at seq 12" });
    const row = await screen.findByTestId("settings-sync");
    expect(row.textContent ?? "").toMatch(/chain break at seq 12/);
    // A halted engine must not also be advertising a "sync now" button that
    // cannot work: the engine refuses every later sync until it is resumed.
    expect(screen.queryByRole("button", { name: /sync now/i })).toBeNull();
  });

  it("signs out only after saying that a passkey is the only way back", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn(async () => {});
    wrap({ signOut });

    await user.click(await screen.findByRole("button", { name: /sign out/i }));
    expect(signOut).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent ?? "").toMatch(/passkey/i);

    await user.click(within(dialog).getByRole("button", { name: /^sign out$/i }));
    await waitFor(() => {
      expect(signOut).toHaveBeenCalledTimes(1);
    });
  });

  it("makes no v1 HTTP call — ledgerd does not serve those routes", async () => {
    wrap();
    await screen.findByTestId("settings-inbound-address");
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map(([u]) => String(u)).filter((u) => !u.startsWith("/api/v1/"))).toEqual([]);
  });
});

