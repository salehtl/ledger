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
import { BANK_NAME_RULE } from "../../lib/bank.ts";
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

/**
 * The waitlist is a demand counter and may never decide whether onboarding
 * continues.
 *
 * This test asserted the OPPOSITE before: that a failed join left the user on
 * this screen. That was the reviewer's must-fix — a user whose request 500s, or
 * who is offline, or whose name the server refuses for a reason this build does
 * not know about, was stranded on the bank step behind "Could not add that
 * bank. Try again." on a step that gates every later step. Retrying could not
 * help them.
 */
it("advances anyway when the join fails, and says so honestly", async () => {
  const m = await mount({ join: async () => { throw new Error("the server is unreachable"); } });
  await userEvent.type(screen.getByLabelText("Bank name"), "Mashreq");
  await userEvent.press(screen.getByTestId("bank-request"));

  await waitFor(() => expect(m.picked).toEqual([WAITLIST_BANK]));
  expect(m.invitations).toEqual([1]);
  const said = screen.getByTestId("bank-message").props.children as string;
  // It does not claim the bank was recorded, and it carries the server's own
  // reason rather than a generic apology.
  expect(said).toContain("could not record");
  expect(said).toContain("the server is unreachable");
  expect(said).not.toContain("Added to the bank request list");
});

/**
 * The reported hard stop, at the screen.
 *
 * `Mashreq (UAE)` is <= 64 code points and control-character free, so the old
 * client sent it; the server's grammar has no parentheses, so it came back
 * `400 invalid_bank` and surfaced as "Try again." Now it never leaves the
 * device, and what the user is told is what they are allowed to type.
 */
it("refuses a name the server cannot store BEFORE the request, naming what is allowed", async () => {
  const m = await mount();
  await userEvent.type(screen.getByLabelText("Bank name"), "Mashreq (UAE)");
  await userEvent.press(screen.getByTestId("bank-request"));

  await waitFor(() => expect(screen.getByTestId("bank-message")).toBeTruthy());
  // No request was made at all: the refusal is local.
  expect(m.joined).toEqual([]);
  expect(String(screen.getByTestId("bank-message").props.children)).toContain(BANK_NAME_RULE);
  // Correctable, so the step is held rather than spent: the user is one edit
  // from giving a demand signal, and "Continue without adding it" is on screen
  // for them if they would rather not. (The corrected spelling succeeding is
  // the first test in this file.)
  expect(m.picked).toEqual([]);
  expect(screen.getByTestId("bank-skip")).toBeTruthy();
});

/**
 * The escape hatch, which is what makes the grammar not a dead end for names it
 * genuinely cannot represent — Arabic, an en dash, a Turkish dotted I. Those
 * users were invited too, and no amount of retyping helps them.
 */
it("continues past the step with no request at all", async () => {
  const m = await mount();
  await userEvent.type(screen.getByLabelText("Bank name"), "\u0628\u0646\u0643 \u062f\u0628\u064a");
  await userEvent.press(screen.getByTestId("bank-skip"));

  expect(m.joined).toEqual([]);
  expect(m.picked).toEqual([WAITLIST_BANK]);
  expect(m.invitations).toEqual([1]);
});

/** The rule is on screen before anything has been refused. */
it("shows what a bank name may contain without waiting to be told no", async () => {
  await mount();
  expect(screen.getByTestId("bank-name-rule").props.children).toBe(BANK_NAME_RULE);
  expect(screen.queryByTestId("bank-message")).toBeNull();
});

it("picks a supported bank by its id without touching the waitlist", async () => {
  const m = await mount();
  await userEvent.press(screen.getByText(SUPPORTED_BANKS[0].name));
  expect(m.picked).toEqual([SUPPORTED_BANKS[0].id]);
  expect(m.joined).toEqual([]);
});
