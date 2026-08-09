/**
 * The list that replaced the corridor, and the status that replaced the wait.
 *
 * Two rules are load-bearing here and neither is obvious from the component:
 * the mail line must resolve itself when mail turns up (nobody should have to
 * come back to a screen to find out), and a dismissal must be permanent (a
 * checklist that returns is a nag, and this app has already been told it is too
 * verbose).
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { memSecretStore } from "@ledger/client/store/store";

import { MotionProvider } from "../../app/MotionProvider";
import { emptyFacts, type OnboardingFacts, type SkippableStep } from "../../v2/onboarding";
import type { ConfirmationTask } from "../../v2/verificationCode";

import { SETUP_DISMISSED_KEY, SetupStatus } from "./SetupStatus";

const ADDRESS = "u-7f3a91c4@in.sirdab.ae";

/** Signed in, keys held, and nothing else done. */
function fresh(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return { ...emptyFacts(), hasSession: true, accountId: "u_1", keysReady: true, ...over };
}

/** Everything setup asked for, done. */
function settled(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return fresh({
    banks: ["dib"],
    inboundAddress: ADDRESS,
    forwardingDeclared: true,
    homeCurrency: "AED",
    ...over,
  });
}

function mount(facts: OnboardingFacts, secrets = memSecretStore(), onOpenTask?: (s: SkippableStep) => void) {
  return render(
    <MotionProvider>
      <SetupStatus facts={facts} secrets={secrets} {...(onOpenTask === undefined ? {} : { onOpenTask })} />
    </MotionProvider>,
  );
}

describe("what is left of setup", () => {
  it("lists every step that was skipped, in the order the walk asked for them", () => {
    mount(fresh());
    const rows = screen.getAllByTestId(/^setup-task-/).map((el) => el.getAttribute("data-testid"));
    // No bank task: the bank question left the walk, and mail proves the bank.
    expect(rows).toEqual([
      "setup-task-address_issued",
      "setup-task-forwarding_configured",
      "setup-task-home_currency_set",
    ]);
  });

  it("drops a task the moment it is actually done, wherever it was done", () => {
    // Read from the facts and not from what was skipped: an address minted
    // later by a boot read has to leave this list without anything telling it to.
    mount(fresh({ inboundAddress: ADDRESS, skipped: ["address_issued"] }));
    expect(screen.queryByTestId("setup-task-address_issued")).toBeNull();
    expect(screen.getByTestId("setup-task-home_currency_set")).toBeInTheDocument();
  });

  it("opens the screen that finishes a task when one is offered", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    mount(fresh(), memSecretStore(), open);
    await user.click(screen.getByTestId("setup-task-address_issued"));
    expect(open).toHaveBeenCalledWith("address_issued");
  });
});

describe("the mail status", () => {
  it("says there is nothing to do while it waits, and never asks for a transaction", () => {
    mount(settled({ inboundAddress: ADDRESS }));
    const line = screen.getByTestId("setup-status-mail");
    expect(line.textContent ?? "").toMatch(/waiting for your first bank email/i);
    expect(line.textContent ?? "").toMatch(/nothing to do/i);
    // The failure this whole change exists to remove: a step that finishes only
    // when the user spends money.
    expect(line.textContent ?? "").not.toMatch(/make a (purchase|transaction)|spend/i);
  });

  it("resolves itself when mail arrives, with no screen to come back to", () => {
    // The same account, one bank email later. Nothing was pressed.
    const { container } = mount(settled({ firstMailConfirmedAt: "2026-08-01T00:00:00Z" }));
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("setup-status")).toBeNull();
  });

  it("does not tell a user with no address to wait for mail", () => {
    // There is nowhere for mail to arrive, so "waiting" would be pointing at a
    // pipe that was never laid.
    mount(fresh());
    expect(screen.getByTestId("setup-status-mail").textContent ?? "").toMatch(/no mail can arrive yet/i);
  });
});

describe("the provider's confirmation, as one tap", () => {
  const task: ConfirmationTask = {
    domain: "google.com",
    url: "https://mail-settings.google.com/mail/vf-abc",
    code: null,
    itemId: "q1",
  };

  function mountTask(over: Partial<ConfirmationTask> | null, seams: { openUrl?: (u: string) => void; onOpenHeldMail?: () => void } = {}) {
    return render(
      <MotionProvider>
        <SetupStatus
          facts={fresh({ inboundAddress: ADDRESS })}
          secrets={memSecretStore()}
          confirmation={over === null ? null : { ...task, ...over }}
          {...seams}
        />
      </MotionProvider>,
    );
  }

  it("is the first row: task copy, then the verified domain, verbatim", () => {
    mountTask({});
    const row = screen.getByTestId("setup-confirmation");
    // Above the waiting line: the one tap is the one thing to do, and "nothing
    // to do" below it stays true once it is done.
    expect(row.parentElement?.firstElementChild).toBe(row);
    expect(row.textContent).toContain("One tap to start forwarding");
    expect(row.textContent).toContain("Your mail provider sent a confirmation. Open it to switch forwarding on.");
    expect(screen.getByTestId("setup-confirmation-domain").textContent).toBe("google.com");
  });

  it("opens the extracted link through the seam", async () => {
    const user = userEvent.setup();
    const openUrl = vi.fn();
    mountTask({}, { openUrl, onOpenHeldMail: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Open the confirmation" }));
    expect(openUrl).toHaveBeenCalledWith(task.url);
  });

  it("falls back to held mail when no link could be read — never a dead end", async () => {
    const user = userEvent.setup();
    const openUrl = vi.fn();
    const onOpenHeldMail = vi.fn();
    mountTask({ url: null }, { openUrl, onOpenHeldMail });
    await user.click(screen.getByRole("button", { name: "Open the confirmation" }));
    expect(onOpenHeldMail).toHaveBeenCalledTimes(1);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("renders no row when nothing held could be a confirmation", () => {
    mountTask(null);
    expect(screen.queryByTestId("setup-confirmation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open the confirmation" })).toBeNull();
  });
});

describe("dismissing it", () => {
  it("stays dismissed — a list that comes back is a nag", async () => {
    const user = userEvent.setup();
    const secrets = memSecretStore();
    const first = mount(fresh(), secrets);

    await user.click(screen.getByRole("button", { name: /hide this/i }));
    expect(screen.queryByTestId("setup-status")).toBeNull();
    first.unmount();

    // A fresh mount, as a new session would be, with everything still
    // outstanding. It must not return.
    mount(fresh(), secrets);
    expect(screen.queryByTestId("setup-status")).toBeNull();
    expect(secrets.get(SETUP_DISMISSED_KEY)).toBe("1");
  });

  it("is dismissed per device, through the store the app already has", async () => {
    const user = userEvent.setup();
    const secrets = memSecretStore();
    mount(fresh(), secrets);
    expect(secrets.get(SETUP_DISMISSED_KEY)).toBeNull();
    await user.click(screen.getByRole("button", { name: /hide this/i }));
    expect(secrets.get(SETUP_DISMISSED_KEY)).toBe("1");
  });
});
