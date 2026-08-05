/**
 * The bank step, rendered.
 *
 * The one thing only a render shows here, and the reason this file exists: a
 * waitlist join has to LEAVE the step. `join()` used to record the bank on the
 * server, set a message and invite the donation without ever emitting
 * `bank_picked`, so the exact user the waitlist exists for — the one whose bank
 * is not DIB or ENBD — could not finish onboarding at all. `onboarding.test.ts`
 * cannot see that: the machine is correct, nothing called it.
 */

import { render, screen, userEvent, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ThemeProvider } from "../../app/Theme.tsx";
import { emptyFacts, onboardingReducer, stepFor } from "../../lib/onboarding.ts";
import { SUPPORTED_BANKS, WAITLIST_BANK } from "../../samples/source.ts";
import { BankScreen } from "./BankScreen.tsx";

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

// `render` is async in @testing-library/react-native 14 — it awaits `act`
// internally, and forgetting the await leaves `screen` as the un-rendered
// default, whose every query throws "`render` function has not been called".
async function mount(over: { join?: (bank: string) => Promise<void> } = {}) {
  const picked: string[] = [];
  const invitations: number[] = [];
  const joined: string[] = [];
  const waitlist = {
    join: async (bank: string) => {
      joined.push(bank);
      await over.join?.(bank);
    },
  };
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <BankScreen waitlist={waitlist} onSelect={(b) => picked.push(b)} onInviteDonation={() => invitations.push(1)} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { picked, invitations, joined };
}

it("advances the step machine past bank when a waitlist join succeeds", async () => {
  const m = await mount();
  await userEvent.type(screen.getByLabelText("Bank name"), "Mashreq");
  await userEvent.press(screen.getByTestId("bank-request"));

  await waitFor(() => expect(screen.getByText("Added to the bank request list.")).toBeTruthy());
  expect(m.joined).toEqual(["Mashreq"]);
  expect(m.picked).toEqual([WAITLIST_BANK]);
  expect(m.invitations).toEqual([1]);

  // And the sentinel is a fact the machine accepts: applying the event the
  // navigator maps `onSelect` to actually moves the position off `bank`.
  const before = { ...emptyFacts(), hasSession: true, accountId: "u-1" };
  expect(stepFor(before)).toBe("invited");
  expect(stepFor(onboardingReducer(before, { type: "bank_picked", bank: m.picked[0]! }))).toBe("bank_picked");
});

it("does not advance, and does not invite a donation, when the join fails", async () => {
  const m = await mount({ join: async () => { throw new Error("500"); } });
  await userEvent.type(screen.getByLabelText("Bank name"), "Mashreq");
  await userEvent.press(screen.getByTestId("bank-request"));

  await waitFor(() => expect(screen.getByText("Could not add that bank. Try again.")).toBeTruthy());
  expect(m.picked).toEqual([]);
  expect(m.invitations).toEqual([]);
});

it("picks a supported bank by its id without touching the waitlist", async () => {
  const m = await mount();
  await userEvent.press(screen.getByText(SUPPORTED_BANKS[0].name));
  expect(m.picked).toEqual([SUPPORTED_BANKS[0].id]);
  expect(m.joined).toEqual([]);
});
