/**
 * Settings, over the v2 runtime.
 *
 * The four things this screen exists to make reachable, each asserted here:
 * a second passkey (the only account recovery this product can offer), the
 * inbound address, held mail, and signing out — plus the sync row, which is
 * the only place a person can find out whether their ledger is moving.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SqlDriver } from "@ledger/client/store/driver";
import type { Op, OpType } from "@ledger/client/wire/op";

import { MotionProvider } from "../../app/MotionProvider";
import {
  isHapticsEnabled,
  isSoundEnabled,
  loadHapticsEnabled,
  loadSoundEnabled,
} from "../../lib/feedback";
import { ToastProvider } from "../../components/Toast";
import { projectionWith } from "../../test/projectionFixture";
import { fakeRuntime, WithV2, type FakeRuntimeOptions } from "../../test/v2Runtime";
import { IDLE_PROGRESS } from "../../v2/engine";
import { PasskeyError } from "../../v2/session";
import type { PasskeySummary } from "../../v2/passkeys";
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

/**
 * The plan's controls are locked until the stored plan has been read — a
 * placeholder is not the user's plan, and a field that discards what you typed
 * is worse than one that would not let you type. Every test that edits the plan
 * waits for that, exactly as a person would.
 */
async function planReady(): Promise<HTMLElement> {
  const needs = await screen.findByLabelText(/Needs/);
  await waitFor(() => {
    expect(needs).toBeEnabled();
  });
  return needs;
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
    // and fourth time, so the note must not count. The list is the count now.
    expect(note).not.toMatch(/second/i);
  });

  it("reloads the passkey list after a passkey is added", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async (): Promise<PasskeySummary[]> => []);
    wrap({ addAnotherPasskey: async () => "cred-2", listPasskeys: list });

    await screen.findByRole("button", { name: /add another passkey/i });
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(1);
    });
    await user.click(screen.getByRole("button", { name: /add another passkey/i }));
    await screen.findByTestId("settings-passkey-note");
    // The second call is the reload the add triggers — without it a passkey
    // added a second ago is missing from the list right under the button.
    await waitFor(() => {
      expect(list).toHaveBeenCalledTimes(2);
    });
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

  // The notifications control has to be REACHED to exist. Its own behaviour is
  // covered in PushNotificationsPanel.test.tsx; what this asserts is the thing
  // that test cannot — that the panel is mounted on the one screen a person can
  // get to. A component nobody renders is a feature that shipped switched off.
  //
  // jsdom has no service worker, so the panel lands in its "unsupported"
  // branch. That is fine for this assertion and it is why the copy is not
  // asserted here.
  it("carries the notifications control, next to the rest of this device's settings", async () => {
    wrap();
    expect(await screen.findByTestId("push-notifications")).toBeInTheDocument();
    // Not merely mounted: mounted in the Device group, with the text size and
    // the haptics, because it is a property of this browser and not of the
    // account. Task 7 could only reach "on the screen at all".
    const device = screen.getByTestId("settings-group-device");
    expect(within(device).getByTestId("push-notifications")).toBeInTheDocument();
  });

  /**
   * The information architecture, asserted as a whole.
   *
   * Four eyebrow labels in v1's order, and no fifth. There is deliberately no
   * Danger zone: v2 has nothing destructive to put under one, and a heading
   * with nothing under it is worse than no heading.
   *
   * "Finish setting up" rides above them and is not a group: it is what is left
   * of a setup the user was allowed to leave unfinished, it disappears when
   * there is nothing left to say, and it disappears for good when dismissed.
   * The fixture has mail that has never arrived, so it is showing here.
   */
  it("groups the settings the way v1 does, with the Danger zone last", async () => {
    // This test used to assert NO Danger zone existed, per the settings design's
    // "do not invent one to fill the shape". Account deletion is now real
    // (2026-08-09), so the zone is no longer invented — it is earned, it comes
    // last, and it holds exactly one row.
    wrap();
    await screen.findByTestId("settings-inbound-address");
    const groups = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    // "Your data" joined the list on 2026-08-09 with the statement importer:
    // it is where the user's own ledger moves in and out under their own hand,
    // and it sits above Library for the same reason Plan sits above Device —
    // it is about the ledger, not about this browser.
    expect(groups).toEqual([
      "Finish setting up",
      "Plan",
      "Automation",
      "Device",
      "Your data",
      "Library",
      "Danger zone",
    ]);
    const danger = screen.getByTestId("settings-danger");
    const rows = within(danger).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual(["Delete account"]);
  });

  it("opens the deletion ceremony from the Danger zone row", async () => {
    wrap();
    await screen.findByTestId("settings-inbound-address");
    fireEvent.click(within(screen.getByTestId("settings-danger")).getByText("Delete account"));
    expect(await screen.findByRole("heading", { name: "Delete account" })).toBeInTheDocument();
  });

  it("shows sync above the groups, because it is a state and not a setting", async () => {
    wrap();
    const line = await screen.findByTestId("settings-sync");
    // Not inside any group, and ahead of the first one in reading order.
    expect(line.closest("section")).toBeNull();
    const plan = screen.getAllByRole("heading", { level: 2 })[0]!;
    expect(line.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("puts sign out last in the Device group, after everything it could be mistaken for", async () => {
    wrap();
    await screen.findByTestId("settings-inbound-address");
    const device = screen.getByTestId("settings-group-device");
    const controls = within(device).getAllByRole("button");
    expect(controls[controls.length - 1]).toHaveTextContent(/^sign out$/i);
  });

  /**
   * Text size, haptics and sound are DEVICE-LOCAL. They are localStorage, read
   * before first paint by `main.tsx`, and they must never reach the op log: an
   * op carrying one would push this handset's screen size and this handset's
   * permission to buzz onto every other device on the account.
   */
  it("changes the text size on this device, and authors nothing", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = {
      pending: [],
      enqueueMany: (s: readonly unknown[]) => void specs.push(...s),
      flush: async () => {},
    };
    localStorage.removeItem("ledger-font-scale");
    document.documentElement.style.removeProperty("font-size");
    wrap({ writer });

    await user.click(await screen.findByRole("button", { name: /text size/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "90%" }));

    expect(document.documentElement.style.fontSize).toBe("90%");
    expect(localStorage.getItem("ledger-font-scale")).toBe("90");
    // The row shows what it now is, without waiting for a reload.
    expect(screen.getByRole("button", { name: /text size/i })).toHaveTextContent("90%");
    expect(specs).toEqual([]);

    document.documentElement.style.removeProperty("font-size");
    localStorage.removeItem("ledger-font-scale");
  });

  it("switches haptics and sound for this browser only, and authors nothing", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = {
      pending: [],
      enqueueMany: (s: readonly unknown[]) => void specs.push(...s),
      flush: async () => {},
    };
    localStorage.removeItem("ledger-haptics");
    localStorage.removeItem("ledger-sound");
    loadHapticsEnabled();
    loadSoundEnabled();
    wrap({ writer });

    await user.click(await screen.findByLabelText("Haptics"));
    await user.click(screen.getByLabelText("Sound"));

    // Haptics default on and sound defaults off, so one click each moves both.
    expect(isHapticsEnabled()).toBe(false);
    expect(isSoundEnabled()).toBe(true);
    expect(localStorage.getItem("ledger-haptics")).toBe("false");
    expect(localStorage.getItem("ledger-sound")).toBe("true");
    expect(specs).toEqual([]);

    localStorage.removeItem("ledger-haptics");
    localStorage.removeItem("ledger-sound");
    loadHapticsEnabled();
    loadSoundEnabled();
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
    const needs = (await planReady()) as HTMLInputElement;
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

  it("saves the plan with no monthly total exactly as it did before the field existed", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = { pending: [], enqueueMany: (s: readonly unknown[]) => void specs.push(...s), flush: async () => {} };
    wrap({ writer });

    // Nothing in the log, so the field opens empty — and an untouched field
    // authors a payload with no `monthly_total_minor` key at all.
    await planReady();
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("");
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([{ type: "budget_split_set", payload: { need: 50, want: 30, saving: 20 } }]);
  });

  it("saves a monthly total as minor units in a string, and keeps it on the next save", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = { pending: [], enqueueMany: (s: readonly unknown[]) => void specs.push(...s), flush: async () => {} };
    wrap({ writer });

    await planReady();
    await user.type(screen.getByLabelText(/monthly budget/i), "12000");
    expect(screen.getByText(/AED 12,000\.00 a month/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([
      { type: "budget_split_set", payload: { need: 50, want: 30, saving: 20, monthly_total_minor: "1200000" } },
    ]);
    expect((await screen.findByTestId("settings-split-note")).textContent ?? "").toMatch(/AED 12,000\.00 a month/);
  });

  it("seeds the total from the log, exactly, past 2^53", async () => {
    // The projection is where a `number` would have already lost this: the
    // column is TEXT and the read is a bigint.
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'9007199254740993')").run();
    wrap();
    const field = await screen.findByLabelText(/monthly budget/i);
    await waitFor(() => {
      expect(field).toHaveValue("90071992547409.93");
    });
  });

  it("refuses a total it cannot read, in words, and will not save while it stands", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = { pending: [], enqueueMany: (s: readonly unknown[]) => void specs.push(...s), flush: async () => {} };
    wrap({ writer });

    await planReady();
    const field = screen.getByLabelText(/monthly budget/i);
    await user.type(field, "12.345");
    expect(screen.getByText(/two decimal places/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();
    expect(specs).toEqual([]);
    // Nothing is rounded behind the user: the text is what they typed.
    expect(field).toHaveValue("12.345");
  });

  it("clearing the total is how a total is removed, and the op says so", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = { pending: [], enqueueMany: (s: readonly unknown[]) => void specs.push(...s), flush: async () => {} };
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,50,30,20,'1200000')").run();
    wrap({ writer });

    await planReady();
    const field = screen.getByLabelText(/monthly budget/i);
    await waitFor(() => {
      expect(field).toHaveValue("12000.00");
    });
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([{ type: "budget_split_set", payload: { need: 50, want: 30, saving: 20 } }]);
  });

  /**
   * The one that can destroy data.
   *
   * `sqlBudgetSource` returns a PLACEHOLDER snapshot while the projection is
   * unusable — `{split: DEFAULT_BUDGET_SPLIT, monthlyTotal: null}` — and that
   * placeholder is not `undefined`, so a presence check passes on it. Seeding
   * from it and latching means the fields sit on 50/30/20 and empty while the
   * log holds 60/20/20 and AED 12,000; pressing "Save plan" then authors the
   * user's plan away.
   *
   * `PROJECTION_VERSION` 6→7 makes this the LIKELY state, not a rare one: every
   * existing device rebuilds its projection on first open of this build, and
   * `project` writes `complete = 0` for the whole run.
   */
  it("never seeds the plan from an unusable projection, and picks up the real one when it lands", async () => {
    const user = userEvent.setup();
    const specs: unknown[] = [];
    const writer = { pending: [], enqueueMany: (s: readonly unknown[]) => void specs.push(...s), flush: async () => {} };
    db.prepare("INSERT INTO budget_split (id,need,want,saving,monthly_total_minor) VALUES (1,60,20,20,'1200000')").run();
    // Mid-rebuild: the rows are there, the projection is not readable yet.
    db.prepare("UPDATE projection_meta SET complete = 0 WHERE id = 1").run();
    wrap({ writer });

    // While it is unusable the plan must not be presented as an answer at all:
    // showing 50/30/20 over a stored 60/20/20 is a wrong number, and the save
    // button beside it would write it.
    const needs = (await screen.findByLabelText(/Needs/)) as HTMLInputElement;
    expect(screen.getByRole("button", { name: /save plan/i })).toBeDisabled();

    // And the fields are not merely unsaveable, they are DISABLED and say why.
    // An enabled field whose contents are about to be replaced by the seeding
    // is an invitation to type something that will be silently thrown away —
    // which is exactly what a reviewer did.
    expect(needs).toBeDisabled();
    expect(screen.getByLabelText(/monthly budget/i)).toBeDisabled();
    expect(screen.getByTestId("settings-plan-warming")).toHaveTextContent(/reading your plan/i);

    // The rebuild finishes and the queries are invalidated.
    db.prepare("UPDATE projection_meta SET complete = 1 WHERE id = 1").run();
    await user.click(screen.getByRole("button", { name: /sync now/i }));

    await waitFor(() => {
      expect(needs.value).toBe("60");
    });
    expect(screen.getByLabelText(/monthly budget/i)).toHaveValue("12000.00");
    // Once the plan is in, the fields are the user's to edit and the warming
    // line is gone — it must not linger over a screen that is now live.
    expect(needs).toBeEnabled();
    expect(screen.getByLabelText(/monthly budget/i)).toBeEnabled();
    expect(screen.queryByTestId("settings-plan-warming")).toBeNull();

    // And the save that follows carries the user's plan, not the default.
    await user.click(screen.getByRole("button", { name: /save plan/i }));
    expect(specs).toEqual([
      { type: "budget_split_set", payload: { need: 60, want: 20, saving: 20, monthly_total_minor: "1200000" } },
    ]);
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

  it("shows a second bank as selected the moment it is toggled, before any sync round-trip", async () => {
    // The projection does not move until a sync folds (writer.ts:28-30), so a
    // writer double whose `pending` array only ever grows models the real
    // outbox faithfully — and is exactly what would let this test pass for the
    // wrong reason if `selected` did not read it.
    const user = userEvent.setup();
    const specs: unknown[] = [];
    let pending: Op[] = [];
    let n = 0;
    const writer = {
      get pending(): readonly Op[] {
        return pending;
      },
      enqueueMany: (s: readonly { type: OpType; payload: unknown }[]) => {
        specs.push(...s);
        pending = [
          ...pending,
          ...s.map(
            (spec): Op => ({
              v: 1,
              type: spec.type,
              op_id: `settings-bank-test-${n++}`,
              authored_at: "2026-06-06T12:00:00.000Z",
              parent_version: null,
              payload: spec.payload,
            }),
          ),
        ];
      },
      flush: async () => {},
    };
    db.prepare("INSERT INTO bank (name,ord,active) VALUES (?,?,?)").run("dib", 0, 1);
    wrap({ writer, templates: async () => [{ id: "dib", templates: 2 }, { id: "enbd", templates: 1 }] });

    const dib = await screen.findByTestId("settings-bank-row-dib");
    expect(dib.getAttribute("aria-checked")).toBe("true");
    const enbd = screen.getByTestId("settings-bank-row-enbd");
    expect(enbd.getAttribute("aria-checked")).toBe("false");

    await user.click(enbd);

    // Both must read selected now — no sync has run, so this can only come
    // from the outbox, not the projection.
    await waitFor(() => {
      expect(screen.getByTestId("settings-bank-row-enbd").getAttribute("aria-checked")).toBe("true");
    });
    expect(screen.getByTestId("settings-bank-row-dib").getAttribute("aria-checked")).toBe("true");
  });

  it("does not offer a template id it could not declare, rather than blanking Settings on the tap", async () => {
    // Same hazard as the bank step: a template's `bank` is a free JSON string,
    // `bankDeclaredOps` throws for one the grammar refuses, and a throw in this
    // onClick unmounts the tree — there is no error boundary in web/src.
    wrap({
      templates: async () => [
        { id: "dib", templates: 1 },
        { id: "adib_uae", templates: 1 },
        { id: "DIB", templates: 1 },
      ],
    });
    expect(await screen.findByTestId("settings-bank-row-dib")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-bank-row-adib_uae")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-bank-row-DIB")).not.toBeInTheDocument();
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

  /**
   * The other half of "onboarding never blocks".
   *
   * A step a user is allowed to skip is a step that has to be finishable
   * afterwards, in the same words — otherwise "later" is just a nicer way of
   * losing the feature. Each of these opens the ONBOARDING screen rather than a
   * second copy of it, which is why the copy assertions below are the same ones
   * the walk's tests make.
   */
  describe("finishing a step that was skipped during setup", () => {
    /** A projection with no home currency: the state a skipped step leaves. */
    async function noCurrency(): Promise<SqlDriver> {
      const fresh = await projectionWith();
      fresh.prepare("UPDATE projection_meta SET home_currency = NULL WHERE id = 1").run();
      return fresh;
    }

    it("sets a home currency that was never set, with the permanence said before the tap", async () => {
      const user = userEvent.setup();
      const specs: { type: string; payload: unknown }[] = [];
      const writer = {
        pending: [],
        enqueueMany: (s: readonly { type: string; payload: unknown }[]) => void specs.push(...s),
        flush: async () => {},
      };
      wrap({ writer }, { driver: await noCurrency(), facts: { homeCurrency: null } });

      expect((await screen.findByTestId("settings-home-currency-unset")).textContent ?? "").toMatch(
        /cannot be changed/i,
      );
      await user.click(screen.getByRole("button", { name: /set my home currency/i }));
      const dialog = await screen.findByRole("dialog");

      // The same warning the walk shows, at first paint, before a currency is
      // even selected. A settings screen that dropped it would be offering the
      // one irreversible control in the product with no notice on it.
      expect(within(dialog).getByTestId("home-currency-permanence").textContent ?? "").toMatch(
        /no way to change|delete your account/i,
      );

      await user.click(within(dialog).getByRole("button", { name: /AED — UAE dirham/i }));
      const confirm = within(dialog).getByRole("button", { name: /set aed as my home currency/i });
      expect(confirm).toHaveProperty("disabled", true);
      expect(specs).toHaveLength(0);

      await user.click(within(dialog).getByRole("checkbox", { name: /AED is permanent/i }));
      await user.click(confirm);

      await waitFor(() => {
        expect(specs.map((s) => s.type)).toEqual(["home_currency_set", "rate_set"]);
      });
      expect(specs[0]?.payload).toEqual({ currency: "AED" });
    });

    it("offers nothing at all once a home currency exists", async () => {
      wrap();
      await screen.findByTestId("settings-home-currency-note");
      expect(screen.queryByRole("button", { name: /set my home currency/i })).toBeNull();
      expect(screen.queryByTestId("settings-home-currency-unset")).toBeNull();
    });

    it("re-opens the forwarding instructions, with the address to send mail to", async () => {
      const user = userEvent.setup();
      wrap();
      await screen.findByTestId("settings-inbound-address");
      await user.click(screen.getByRole("button", { name: /forwarding instructions/i }));
      const dialog = await screen.findByRole("dialog");
      // The forwarding instructions themselves, not a route picker: the
      // bank-side route is retired (`Address.DIRECT_BANK_ROUTE`), so there is
      // one path and nothing to choose between. The generic set leads, with
      // per-provider help collapsed beneath it — nothing here is asked either.
      expect(within(dialog).getByTestId("forwarding-generic")).toBeInTheDocument();
      expect(within(dialog).queryByTestId("route-picker")).toBeNull();
      expect(within(dialog).getByTestId("inbound-address").textContent).toBe("u-abc@in.sirdab.ae");
    });

    it("held confirmation with no readable link: the dialog's tap falls back to held mail", async () => {
      // The one-tap notice inside the forwarding dialog, on a confirmation
      // whose body carries no link ledger can pin to the signing domain. The
      // body copy says "open it" — so the tap must go somewhere: held mail,
      // through the same seam the Held mail row uses. Never a dead end.
      const user = userEvent.setup();
      const body = [
        "Return-Path: <forwarding-noreply@google.com>",
        "From: Gmail Team <forwarding-noreply@google.com>",
        "Subject: Gmail Forwarding Confirmation",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "you@example.com has requested to automatically forward mail.",
        "",
        "Confirmation code: 123456789",
        "",
      ].join("\r\n");
      const page = {
        items: [
          {
            id: "held-1",
            ingest_id: "ing-1",
            received_at: "2026-08-09T15:15:34Z",
            expires_at: "2026-09-08T15:15:34Z",
            outer_domain: "google.com",
            inner_domain: "",
            attested: false,
            attested_by: "",
            dkim: "pass",
            arc: "pass",
            size_bucket: 1,
            blob: btoa(body),
          },
        ],
        action_needed: 1,
        expiring_soon: 0,
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("/api/v1/quarantine")
            ? new Response(JSON.stringify(page))
            : new Response("[]"),
        ),
      );
      const onOpenQuarantine = vi.fn();
      wrap({ onOpenQuarantine });
      await screen.findByTestId("settings-inbound-address");
      await user.click(screen.getByRole("button", { name: /forwarding instructions/i }));

      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByTestId("forwarding-confirmation");
      await user.click(within(dialog).getByRole("button", { name: "Open the confirmation" }));
      expect(onOpenQuarantine).toHaveBeenCalledTimes(1);
    });

    /**
     * The check that used to be a step, with no onboarding anywhere near it.
     *
     * It waited for a real bank alert — an event the user cannot cause without
     * spending money — and it existed only during the walk, so a forwarding rule
     * that broke a month later had nothing to be checked with.
     */
    it("re-runs the mail check at any time, and pulls before it answers", async () => {
      const user = userEvent.setup();
      const { runs } = wrap();
      await screen.findByTestId("settings-inbound-address");
      await user.click(screen.getByRole("button", { name: /check my mail setup/i }));

      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByTestId("verification")).toBeInTheDocument();
      // Nothing can be learned without a pull: the log is what says whether mail
      // became a transaction.
      await waitFor(() => {
        expect(runs).toContain("refresh");
      });
      // And it is honest about a confirmation that never turned up, rather than
      // leaving "this product is broken" as the only reading.
      expect(within(dialog).getByTestId("verification-no-confirmation").textContent ?? "").toMatch(
        /may not send one|refused/i,
      );
    });
  });

  it("makes no v1 HTTP call — ledgerd does not serve those routes", async () => {
    wrap();
    await screen.findByTestId("settings-inbound-address");
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map(([u]) => String(u)).filter((u) => !u.startsWith("/api/v1/"))).toEqual([]);
  });
});

