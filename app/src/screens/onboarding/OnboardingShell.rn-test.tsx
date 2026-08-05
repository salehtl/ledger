/**
 * The shell, rendered.
 *
 * `onboarding.test.ts` proves the derivation. What only a render can show:
 *
 *   - the derived step is actually the thing on the glass (a machine nothing
 *     routes off is the "written, tested green, never wired" defect);
 *   - the checkpoint wait and the held Gmail message read as normal states
 *     rather than as faults;
 *   - a placeholder for an unbuilt step cannot advance the machine over a fact
 *     the server or the log owns.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import {
  HALT_CHAIN_WITHHELD,
  HALT_NOT_VOUCHED_FOR,
  type Halt,
} from "@ledger/client/invariants/surface.ts";

import { ThemeProvider } from "../../app/Theme.tsx";
import {
  AWAITING_VOUCH,
  emptyFacts,
  encodeLocal,
  type OnboardingFacts,
  type OpSpec,
} from "../../lib/onboarding.ts";
import { OnboardingShell, type OnboardingShellProps } from "./OnboardingShell.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function facts(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return { ...emptyFacts(), hasSession: true, accountId: "u-1", ...over };
}

/** Every fact up to and including the first confirmed bank email. */
function readyForCurrency(): OnboardingFacts {
  return facts({
    bank: "dib",
    inboundAddress: "abc@in.example",
    forwardingDeclared: true,
    firstMailConfirmedAt: "2026-08-02T10:00:00.000Z",
  });
}

function halt(kind: Halt["kind"], title = "A stop", body = "Something happened."): Halt {
  return { kind, title, body, action: "Do the thing.", dismissable: false, syncStopped: true, violations: [] };
}

async function renderShell(over: Partial<OnboardingShellProps> = {}) {
  const props: OnboardingShellProps = {
    initialFacts: facts(),
    commitOps: async () => {},
    onDone: () => {},
    ...over,
  };
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <OnboardingShell {...props} />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

describe("routing", () => {
  it("puts the step the facts derive on the glass, not a stored one", async () => {
    await renderShell({ initialFacts: facts() });
    expect(screen.getByTestId("step-bank-body")).toBeTruthy();
  });

  it("routes a fully-forwarded account to the currency picker", async () => {
    await renderShell({ initialFacts: readyForCurrency() });
    expect(screen.getByTestId("home-currency-permanence")).toBeTruthy();
  });

  it("routes past the picker once the log carries a currency", async () => {
    // The reinstall case, on the glass: the picker must be unreachable, not
    // merely un-emitting.
    await renderShell({ initialFacts: { ...readyForCurrency(), homeCurrency: "AED" } });
    expect(screen.queryByTestId("home-currency-permanence")).toBeNull();
    expect(screen.getByTestId("onboarding-finish")).toBeTruthy();
  });

  it("a registered screen replaces the placeholder entirely", async () => {
    await renderShell({
      initialFacts: facts(),
      screens: { bank: () => <Text testID="task-16-bank">the real picker</Text> },
    });
    expect(screen.getByTestId("task-16-bank")).toBeTruthy();
    expect(screen.queryByTestId("step-bank-pending")).toBeNull();
  });

  it("reports completion once, when the machine reaches done", async () => {
    const done: number[] = [];
    await renderShell({
      initialFacts: { ...readyForCurrency(), homeCurrency: "AED" },
      onDone: () => done.push(1),
    });
    expect(done).toEqual([]);
    await userEvent.press(screen.getByTestId("onboarding-finish"));
    expect(done).toEqual([1]);
  });

  it("tells the caller there is no session rather than rendering a step", async () => {
    const out: number[] = [];
    await renderShell({ initialFacts: emptyFacts(), onSignedOut: () => out.push(1) });
    expect(out).toEqual([1]);
    expect(screen.queryByTestId("step-bank-body")).toBeNull();
  });
});

describe("the whole flow, driven through the shell", () => {
  it("walks bank → forwarding → currency → finish, persisting only the local half", async () => {
    const saved: ReturnType<typeof encodeLocal>[] = [];
    const batches: OpSpec[][] = [];
    await renderShell({
      // The address is server truth, so it is seeded: nothing in this build can
      // produce one, and a test that faked it through the UI would be testing a
      // path production does not have.
      initialFacts: facts({ inboundAddress: "abc@in.example", firstMailConfirmedAt: "2026-08-02T10:00:00.000Z" }),
      onFactsChange: (f) => saved.push(encodeLocal(f)),
      commitOps: async (ops) => {
        batches.push([...ops]);
      },
    });

    await userEvent.press(screen.getByTestId("step-bank-skip"));
    await userEvent.press(screen.getByTestId("step-forwarding-skip"));

    expect(screen.getByTestId("home-currency-permanence")).toBeTruthy();
    await userEvent.press(screen.getByTestId("currency-AED"));
    await userEvent.press(screen.getByTestId("home-currency-acknowledge"));
    await userEvent.press(screen.getByTestId("home-currency-confirm"));

    expect(batches.map((b) => b.map((o) => o.type))).toEqual([["home_currency_set", "rate_set"]]);
    expect(screen.getByTestId("onboarding-finish")).toBeTruthy();

    // The persisted record carries the device-local half and never the currency.
    const last = saved[saved.length - 1];
    expect(last).toEqual({ bank: "unspecified", forwardingDeclared: true, finishedAt: null });
    expect(JSON.stringify(saved)).not.toContain("AED");
  });
});

describe("the two states that must not read as faults", () => {
  it("an un-vouched-for device is a wait, in onboarding's words and not the library's", async () => {
    await renderShell({ initialFacts: facts(), halt: halt(HALT_NOT_VOUCHED_FOR) });
    expect(screen.getByTestId("onboarding-awaiting-vouch")).toBeTruthy();
    expect(screen.getByText(AWAITING_VOUCH.title)).toBeTruthy();
    expect(screen.getByText(AWAITING_VOUCH.body)).toBeTruthy();
    // The library's own copy for this halt says "syncing has stopped", which is
    // true and reads as a fault to somebody ninety seconds into the product.
    expect(JSON.stringify(screen.toJSON()).toLowerCase()).not.toContain("stopped");
    // And the step behind it is not rendered: this account genuinely cannot go on.
    expect(screen.queryByTestId("step-bank-body")).toBeNull();
  });

  it("every other hard stop keeps the library's own words", async () => {
    const h = halt(HALT_CHAIN_WITHHELD, "Some of your data is being withheld", "A peer saw entries this server will not send.");
    await renderShell({ initialFacts: facts(), halt: h });
    // Task 12's component, wired here rather than re-worded: it carries the
    // violation detail an operator needs, which a paraphrase would drop.
    expect(screen.getByTestId("halt-banner")).toBeTruthy();
    expect(screen.getByText(h.title)).toBeTruthy();
    expect(screen.getByText(h.body)).toBeTruthy();
    expect(screen.queryByTestId("onboarding-awaiting-vouch")).toBeNull();
  });

  it("the held Gmail message is explained as intended behaviour, twice", async () => {
    // Once where it is met — the verification step — and once on the finish
    // screen, because it stays held and a user who comes back to it later needs
    // the same sentence rather than a mystery.
    await renderShell({
      initialFacts: facts({ bank: "dib", inboundAddress: "abc@in.example", forwardingDeclared: true }),
    });
    const held = screen.getByTestId("step-verification-body");
    expect(held).toBeTruthy();
    const rendered = JSON.stringify(screen.toJSON()).toLowerCase();
    expect(rendered).toContain("held to one side");
    expect(rendered).toContain("working as");
    expect(rendered).not.toContain("failed");

    await renderShell({ initialFacts: { ...readyForCurrency(), homeCurrency: "AED" } });
    expect(screen.getByTestId("finish-quarantine-note")).toBeTruthy();
  });
});

describe("the steps that are not built yet", () => {
  it("names the task that owns each one instead of pretending", async () => {
    await renderShell({ initialFacts: facts() });
    expect(screen.getByTestId("step-bank-pending")).toBeTruthy();
    expect(screen.getByText(/Task 16/)).toBeTruthy();
  });

  it("may advance a device-local fact, and may never fake a server one", async () => {
    // The address and the first confirmed email are server and log truth. A
    // placeholder that advanced over one would put the machine past a step that
    // never happened — which is exactly how a "skip for now" becomes a defect.
    await renderShell({ initialFacts: facts({ bank: "dib" }) });
    expect(screen.queryByTestId("step-address-skip")).toBeNull();
    expect(screen.getByTestId("step-address-blocked")).toBeTruthy();

    await renderShell({ initialFacts: facts({ bank: "dib", inboundAddress: "a@b.c", forwardingDeclared: true }) });
    expect(screen.queryByTestId("step-verification-skip")).toBeNull();
    expect(screen.getByTestId("step-verification-blocked")).toBeTruthy();

    await renderShell({ initialFacts: facts({ bank: "dib", inboundAddress: "a@b.c" }) });
    expect(screen.getByTestId("step-forwarding-skip")).toBeTruthy();
  });
});
