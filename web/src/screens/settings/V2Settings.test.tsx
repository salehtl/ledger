/**
 * Settings, over the v2 runtime.
 *
 * The four things this screen exists to make reachable, each asserted here:
 * a second passkey (the only account recovery this product can offer), the
 * inbound address, held mail, and signing out — plus the sync row, which is
 * the only place a person can find out whether their ledger is moving.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";

import { MotionProvider } from "../../app/MotionProvider";
import { ToastProvider } from "../../components/Toast";
import { projectionWith } from "../../test/projectionFixture";
import { fakeRuntime, WithV2, type FakeRuntimeOptions } from "../../test/v2Runtime";
import { IDLE_PROGRESS } from "../../v2/engine";
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
    const note = (await screen.findByTestId("settings-passkey-note")).textContent ?? "";
    expect(note).toMatch(/added/i);
    // NOT onboarding's "Second passkey added." — this row can be used a third
    // and fourth time, and there is no route to list enrolled credentials, so
    // the note must not count what it cannot count. It points at the one place
    // that does know: the authenticator.
    expect(note).not.toMatch(/second/i);
    expect(note).toMatch(/authenticator|password manager/i);
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

  it("does not report a stopped sync as up to date when the engine has no verdict", async () => {
    // The ordinary failure, not an exotic one: `SyncEngine.run` publishes
    // `halted` and rethrows for every transport failure, `ChainBreakError` and
    // `ProtocolError`, and `useSync` classifies an offline throw as a NON-fault
    // — so no HaltWall covers it and this row is the only thing on the glass
    // that can say the sync stopped. Reporting it as "Up to date" is this row
    // announcing the exact condition it exists for as health.
    wrap({}, { sync: { progress: { ...IDLE_PROGRESS, phase: "halted" } }, haltReason: null });
    const row = await screen.findByTestId("settings-sync");
    expect(row.textContent ?? "").not.toMatch(/up to date/i);
    expect(row.textContent ?? "").toMatch(/did not finish/i);
    // A retry can genuinely work here — the engine has latched nothing.
    expect(screen.getByRole("button", { name: /sync now/i })).toBeEnabled();
  });

  it("keeps the elapsed time honest while Settings stays open", async () => {
    vi.useFakeTimers();
    try {
      let clock = Date.parse("2026-08-07T10:01:00Z");
      wrap({ now: () => clock }, { sync: { lastCompletedAt: Date.parse("2026-08-07T10:00:00Z") } });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId("settings-sync").textContent ?? "").toMatch(/1 minute ago/);

      // Five minutes pass with the screen still on. A figure read once at render
      // would still say "1 minute ago".
      clock += 5 * 60_000;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
      });
      expect(screen.getByTestId("settings-sync").textContent ?? "").toMatch(/6 minutes ago/);
    } finally {
      vi.useRealTimers();
    }
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

  it("offers the budget split, and refuses to save one that does not add up", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = {
      pending: [],
      enqueueMany: (s: readonly unknown[]) => void specs.push(...s),
      flush: async () => {},
    };
    wrap({ writer });

    // It opens on what the log holds — nothing, so the rule.
    const needs = (await screen.findByLabelText(/Needs/)) as HTMLInputElement;
    expect(needs.value).toBe("50");

    // 60/30/20 is a plausible plan that does not add up. The screen says so
    // BEFORE the save, and the save is not available — it is not silently
    // normalised to 55/27/18.
    await user.clear(needs);
    await user.type(needs, "60");
    expect(screen.getByText(/adds up to 110% — it has to be 100%/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(specs).toEqual([]);

    const wants = screen.getByLabelText(/Wants/);
    await user.clear(wants);
    await user.type(wants, "20");
    expect(screen.getByText(/adds up to 100%/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([{ type: "budget_split_set", payload: { need: 60, want: 20, saving: 20 } }]);
  });

  it("edits the bank list with the same control the bank step uses, one op per change", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = {
      pending: [],
      enqueueMany: (s: readonly unknown[]) => void specs.push(...s),
      flush: async () => {},
    };
    // Declared in the LOG, which is what a second device reads — not in this
    // browser's storage.
    db.prepare("INSERT INTO bank (name,ord,active) VALUES (?,?,?)").run("dib", 0, 1);
    wrap({ writer, templates: async () => [{ id: "dib", templates: 2 }, { id: "enbd", templates: 1 }] });

    const dib = await screen.findByTestId("settings-bank-row-dib");
    expect(dib.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("settings-bank-row-enbd").getAttribute("aria-checked")).toBe("false");

    await user.click(screen.getByTestId("settings-bank-row-enbd"));
    expect(specs).toEqual([{ type: "bank_declared", payload: { bank: "enbd", active: true } }]);

    // Removing is a declaration too — `active: false`, never a delete.
    await user.click(dib);
    expect(specs[1]).toEqual({ type: "bank_declared", payload: { bank: "dib", active: false } });
  });

  it("says exactly what removing a bank does, and does not claim it stops mail or untrusts a sender", async () => {
    // The allowlist is a separate, server-side thing (`sender_allowlist`,
    // written by the quarantine trust decision). This list drives the UI and the
    // waitlist and nothing else, so the copy may not imply otherwise.
    wrap({ templates: async () => [{ id: "dib", templates: 1 }] });
    const note = (await screen.findByTestId("settings-banks-note")).textContent ?? "";
    expect(note).toMatch(/mail|transactions/i);
    expect(note).toMatch(/still/i);
    expect(note).not.toMatch(/stop|block|untrust|delete/i);
  });

  it("opens the categories the user owns, and defines one into the log", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = {
      pending: [],
      enqueueMany: (s: readonly unknown[]) => void specs.push(...s),
      flush: async () => {},
    };
    wrap({ writer });

    // An account that has defined nothing says so rather than implying an
    // empty list: the built-in set is what it is using.
    await user.click(await screen.findByRole("button", { name: /your categories/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /add to needs/i }));
    await user.type(within(dialog).getByLabelText(/new category in needs/i), "Gym");
    await user.click(within(dialog).getByRole("button", { name: /add gym/i }));

    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      type: "category_defined",
      payload: { name: "Gym", kind: "spending", bucket: "need", active: true },
    });
  });

  it("makes no v1 HTTP call — ledgerd does not serve those routes", async () => {
    wrap();
    await screen.findByTestId("settings-inbound-address");
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map(([u]) => String(u)).filter((u) => !u.startsWith("/api/v1/"))).toEqual([]);
  });
});

