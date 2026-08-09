/**
 * The address step, and the forwarding step that follows it.
 *
 * These tests exist because the forwarding half shipped as four hardcoded Gmail
 * sentences. Anybody on iCloud, Outlook or Fastmail was reading instructions for
 * a product they do not use, and the one provider whose flow has no confirmation
 * code at all was being told to wait for one.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../../app/MotionProvider";
import { PROVIDERS } from "../../v2/providers";
import { Address } from "./Address";

const ADDRESS = "u-7f3a@in.ledger.example";

function mountForwarding(
  over: { onForwardingDeclared?: (expectConfirmation: boolean) => void; directRoute?: boolean } = {},
) {
  const onForwardingDeclared = over.onForwardingDeclared ?? vi.fn();
  render(
    <MotionProvider>
      <Address
        client={{ sessionToken: "tok" }}
        phase="forwarding"
        known={ADDRESS}
        onIssued={vi.fn()}
        onForwardingDeclared={onForwardingDeclared}
        copy={async () => {}}
        fetch={(async () => new Response("no route", { status: 404 })) as unknown as typeof fetch}
        {...(over.directRoute === undefined ? {} : { directRoute: over.directRoute })}
      />
    </MotionProvider>,
  );
  return { onForwardingDeclared };
}

/**
 * With the direct route retired there is nothing to walk through: forwarding is
 * where the screen already is. These tests keep the helper so the flag can be
 * turned back on without rewriting them.
 */
async function intoForwarding(_user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByTestId("provider-picker");
}

/**
 * The route the operator retired, still built and still tested.
 *
 * It is off by default (`DIRECT_BANK_ROUTE`) because a bank's alert address is
 * also where that bank sends security alerts and one-time codes, and most banks
 * keep only one — so taking it costs the user their own bank. These tests pass
 * `directRoute` explicitly, which is the point of the flag: the retired route
 * must not rot while it is off, or turning it back on ships something nobody
 * has run.
 */
describe("the retired direct route, behind its flag", () => {
  it("offers both routes before any forwarding instructions appear", async () => {
    mountForwarding({ directRoute: true });
    const picker = await screen.findByTestId("route-picker");
    expect(within(picker).getByRole("button", { name: /with your bank directly/i })).toBeTruthy();
    expect(within(picker).getByRole("button", { name: /forward it from my email/i })).toBeTruthy();
    // Nothing about providers or forwarding rules until the route is chosen.
    expect(screen.queryByTestId("provider-picker")).toBeNull();
    expect(screen.queryByTestId("forwarding-steps")).toBeNull();
  });

  it("takes the direct route without a word about forwarding or confirmation codes", async () => {
    const user = userEvent.setup();
    mountForwarding({ directRoute: true });
    await user.click(await screen.findByRole("button", { name: /with your bank directly/i }));

    const steps = await screen.findByTestId("direct-steps");
    expect(steps.textContent).not.toMatch(/forward/i);
    expect(steps.textContent).not.toMatch(/confirmation code/i);
    expect(screen.queryByTestId("provider-picker")).toBeNull();
    expect(screen.getByTestId("inbound-address").textContent).toBe(ADDRESS);
  });

  it("reaches the same waiting state, expecting no confirmation code", async () => {
    const user = userEvent.setup();
    const onForwardingDeclared = vi.fn();
    mountForwarding({ onForwardingDeclared, directRoute: true });

    await user.click(await screen.findByRole("button", { name: /with your bank directly/i }));
    await user.click(screen.getByRole("button", { name: /i have set this address with my bank/i }));
    expect(onForwardingDeclared).toHaveBeenCalledWith(false);
  });

  /**
   * Not every bank lets a customer change the address, and some have only one.
   * Said on the route that would otherwise strand them.
   */
  it("says what to do when the bank will not let the address be changed", async () => {
    const user = userEvent.setup();
    mountForwarding({ directRoute: true });
    await user.click(await screen.findByRole("button", { name: /with your bank directly/i }));
    expect(screen.getByTestId("direct-caveat").textContent).toMatch(/only one|cannot be changed/i);
    // And the way out is on the same screen, not a step backwards.
    await user.click(screen.getByRole("button", { name: /forward it from my email/i }));
    expect(await screen.findByTestId("provider-picker")).toBeTruthy();
  });
});

/**
 * The sunset, asserted on the DEFAULT — i.e. on what a real user gets, with no
 * prop passed. Everything above this describes the route with the flag forced
 * on, which is exactly the arrangement that would otherwise let it quietly come
 * back: a test that always passes `directRoute: true` cannot notice that the
 * default changed.
 */
describe("the bank-side route is not offered", () => {
  it("lands straight on the forwarding instructions, with no route to pick", async () => {
    mountForwarding();
    expect(await screen.findByTestId("provider-picker")).toBeTruthy();
    expect(screen.queryByTestId("route-picker")).toBeNull();
    expect(screen.queryByTestId("direct-steps")).toBeNull();
  });

  it("offers no way into it, from anywhere on the screen", async () => {
    mountForwarding();
    await screen.findByTestId("provider-picker");
    for (const button of screen.getAllByRole("button")) {
      expect(button.textContent ?? "").not.toMatch(/with my bank directly|with your bank directly/i);
    }
    expect(screen.queryByRole("button", { name: /i have set this address with my bank/i })).toBeNull();
  });

  /**
   * It was "one rule … works with a bank that will not change the address" —
   * this route described as the consolation prize for a route that is gone.
   * What stays is the privacy claim, which is not a tooltip candidate: it is
   * what a careful person weighs before writing the rule.
   */
  it("no longer presents forwarding as the second-best option", async () => {
    mountForwarding();
    await screen.findByTestId("provider-picker");
    const page = document.body.textContent ?? "";
    expect(page).not.toMatch(/instead|the first one is steadier|recommended/i);
    expect(page).toMatch(/never sees the rest of that mailbox/i);
  });

  /**
   * Sunset, not deleted. The caveat that admits the route's own failure is the
   * record of why it was retired, so it travels WITH the route rather than
   * being tidied away first.
   */
  it("keeps the route, its copy and its caveat intact behind the flag", async () => {
    const user = userEvent.setup();
    mountForwarding({ directRoute: true });
    await user.click(await screen.findByRole("button", { name: /with your bank directly/i }));
    expect(screen.getByTestId("direct-caveat").textContent).toMatch(/only one alert address/i);
  });
});

describe("the forwarding step's provider instructions", () => {
  it("offers every provider in the registry, plus a way out for the rest", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    const picker = await screen.findByTestId("provider-picker");
    for (const p of PROVIDERS) {
      expect(within(picker).getByRole("button", { name: p.label })).toBeTruthy();
    }
    expect(within(picker).getByRole("button", { name: /another provider/i })).toBeTruthy();
  });

  /**
   * Before a choice there are still instructions on screen — the generic ones —
   * rather than a blank panel or, as before, Gmail's presented as everyone's.
   */
  it("shows provider-neutral steps until a provider is chosen", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    const steps = await screen.findByTestId("forwarding-steps");
    expect(steps.textContent).toMatch(/forwarding or auto-forward setting/i);
    expect(steps.textContent).not.toMatch(/gmail/i);
  });

  it("replaces the steps with the chosen provider's", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(await screen.findByRole("button", { name: "Gmail" }));
    expect(screen.getByTestId("forwarding-steps").textContent).toMatch(/Forwarding and POP\/IMAP/i);

    await user.click(screen.getByRole("button", { name: "iCloud Mail" }));
    const steps = screen.getByTestId("forwarding-steps").textContent ?? "";
    expect(steps).toMatch(/iCloud\.com/i);
    expect(steps).not.toMatch(/POP\/IMAP/i);
  });

  it("says iCloud sends no confirmation code, rather than leaving the user waiting for one", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(await screen.findByRole("button", { name: "iCloud Mail" }));
    expect(screen.getByTestId("forwarding-steps").textContent).toMatch(/does not send a confirmation code/i);
  });

  /**
   * The Microsoft 365 default. Said before the user spends ten minutes finding
   * out that the setting will not save.
   */
  it("warns about a work Outlook account before the user tries", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(await screen.findByRole("button", { name: /outlook/i }));
    const caveat = screen.getByTestId("provider-caveat");
    expect(caveat.textContent).toMatch(/administrator/i);
    expect(caveat.textContent).toMatch(/work or school/i);
  });

  /**
   * "Before the user tries" is a position on the page, not a tone of voice. A
   * caveat that may mean THIS ROUTE CANNOT WORK AT ALL — a Microsoft 365 work
   * account — read below the numbered steps it invalidates.
   */
  it("renders the caveat above the steps it may invalidate", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(await screen.findByRole("button", { name: /outlook/i }));
    const caveat = screen.getByTestId("provider-caveat");
    const steps = screen.getByTestId("forwarding-steps");
    expect(caveat.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no caveat for a provider that has none", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(await screen.findByRole("button", { name: "Gmail" }));
    expect(screen.queryByTestId("provider-caveat")).toBeNull();
  });

  /**
   * The choice is UI state. It reaches the next screen only as "should that
   * screen offer a code reader", which is what `needsConfirmation` means and the
   * whole of what it may decide.
   */
  it("reports whether a confirmation is expected when the user declares the forward", async () => {
    const user = userEvent.setup();
    const onForwardingDeclared = vi.fn();
    mountForwarding({ onForwardingDeclared });
    await intoForwarding(user);

    await user.click(await screen.findByRole("button", { name: "iCloud Mail" }));
    await user.click(screen.getByRole("button", { name: /i have set up forwarding/i }));
    expect(onForwardingDeclared).toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Gmail" }));
    await user.click(screen.getByRole("button", { name: /i have set up forwarding/i }));
    expect(onForwardingDeclared).toHaveBeenLastCalledWith(true);
  });
});
