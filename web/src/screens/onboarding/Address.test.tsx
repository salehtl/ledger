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

function mountForwarding(over: { onForwardingDeclared?: (expectConfirmation: boolean) => void } = {}) {
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
      />
    </MotionProvider>,
  );
  return { onForwardingDeclared };
}

describe("the forwarding step's provider instructions", () => {
  it("offers every provider in the registry, plus a way out for the rest", async () => {
    mountForwarding();
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
    mountForwarding();
    const steps = await screen.findByTestId("forwarding-steps");
    expect(steps.textContent).toMatch(/forwarding or auto-forward setting/i);
    expect(steps.textContent).not.toMatch(/gmail/i);
  });

  it("replaces the steps with the chosen provider's", async () => {
    const user = userEvent.setup();
    mountForwarding();
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
    await user.click(await screen.findByRole("button", { name: /outlook/i }));
    const caveat = screen.getByTestId("provider-caveat");
    expect(caveat.textContent).toMatch(/administrator/i);
    expect(caveat.textContent).toMatch(/work or school/i);
  });

  it("shows no caveat for a provider that has none", async () => {
    const user = userEvent.setup();
    mountForwarding();
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

    await user.click(await screen.findByRole("button", { name: "iCloud Mail" }));
    await user.click(screen.getByRole("button", { name: /i have set up forwarding/i }));
    expect(onForwardingDeclared).toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Gmail" }));
    await user.click(screen.getByRole("button", { name: /i have set up forwarding/i }));
    expect(onForwardingDeclared).toHaveBeenLastCalledWith(true);
  });
});
