/**
 * The address step, and the forwarding step that follows it.
 *
 * These tests exist because the forwarding half shipped as four hardcoded Gmail
 * sentences. Anybody on iCloud, Outlook or Fastmail was reading instructions for
 * a product they do not use, and the one provider whose flow has no confirmation
 * code at all was being told to wait for one.
 *
 * The second finding: the fix became a fork. A picker stood between the user
 * and the instructions, asking who the provider was before showing anything —
 * when the generic set is true everywhere. So the generic steps lead, and each
 * provider's exact taps are a collapsed disclosure, opened only on request.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../../app/MotionProvider";
import { PROVIDERS } from "../../v2/providers";
import { Address } from "./Address";
import { OPEN_CONFIRMATION_COPY } from "./SetupStatus";

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
  await screen.findByTestId("forwarding-generic");
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
    // Nothing about forwarding rules until the route is chosen.
    expect(screen.queryByTestId("forwarding-generic")).toBeNull();
  });

  it("takes the direct route without a word about forwarding or confirmation codes", async () => {
    const user = userEvent.setup();
    mountForwarding({ directRoute: true });
    await user.click(await screen.findByRole("button", { name: /with your bank directly/i }));

    const steps = await screen.findByTestId("direct-steps");
    expect(steps.textContent).not.toMatch(/forward/i);
    expect(steps.textContent).not.toMatch(/confirmation code/i);
    expect(screen.queryByTestId("forwarding-generic")).toBeNull();
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
    expect(await screen.findByTestId("forwarding-generic")).toBeTruthy();
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
    expect(await screen.findByTestId("forwarding-generic")).toBeTruthy();
    expect(screen.queryByTestId("route-picker")).toBeNull();
    expect(screen.queryByTestId("direct-steps")).toBeNull();
  });

  it("offers no way into it, from anywhere on the screen", async () => {
    mountForwarding();
    await screen.findByTestId("forwarding-generic");
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
    await screen.findByTestId("forwarding-generic");
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

/**
 * One instruction set, true everywhere, and provider help on request.
 *
 * The picker asked "Where does your bank mail arrive?" before showing anything
 * — a question the user had to answer to see instructions the generic set
 * already covered. Now nothing is asked: the generic steps lead, and each
 * provider's exact taps sit behind a collapsed disclosure named for what it
 * shows.
 */
describe("the forwarding instructions", () => {
  it("shows the forwarding instructions without asking who the provider is", async () => {
    mountForwarding();
    expect(await screen.findByTestId("forwarding-generic")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-picker")).toBeNull(); // no fork
    // Provider help exists, collapsed, and is optional:
    expect(screen.getByRole("button", { name: /gmail/i })).toBeInTheDocument();
  });

  it("expanding Gmail shows its steps and its caveat, on screen", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(screen.getByRole("button", { name: /gmail/i }));
    expect(screen.getByTestId("provider-steps-gmail")).toBeInTheDocument();
  });

  it("offers every provider's steps behind a named disclosure, collapsed", async () => {
    mountForwarding();
    await screen.findByTestId("forwarding-generic");
    for (const p of PROVIDERS) {
      // "Show the Gmail steps", never "More options": the label names exactly
      // what the press reveals.
      expect(screen.getByRole("button", { name: `Show the ${p.label} steps` })).toBeInTheDocument();
      expect(screen.queryByTestId(`provider-steps-${p.id}`)).toBeNull();
    }
    // No fork and no "Another provider" row: the generic steps ARE everyone's.
    expect(screen.queryByRole("button", { name: /another provider/i })).toBeNull();
  });

  it("leads with the rule to make, and says where a confirmation will appear", async () => {
    mountForwarding();
    const steps = await screen.findByTestId("forwarding-generic");
    const said = steps.textContent ?? "";
    expect(said).toMatch(/make a rule: mail from your bank forwards to this address/i);
    expect(said).toMatch(/forward the bank, not the whole mailbox/i);
    // Generic and truthful: no promised code, no promised screen, and the place
    // the message will actually be, by name.
    expect(said).toContain(
      "If your provider sends a confirmation, it appears in Held mail — ledger will point you at it.",
    );
    expect(said).not.toMatch(/gmail|the next screen/i);
  });

  it("closes an opened disclosure again, and says which state it is in", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    const header = screen.getByRole("button", { name: "Show the Gmail steps" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    await user.click(header);
    const opened = screen.getByRole("button", { name: "Hide the Gmail steps" });
    expect(opened).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("provider-steps-gmail")).toBeInTheDocument();
    await user.click(opened);
    expect(screen.queryByTestId("provider-steps-gmail")).toBeNull();
  });

  it("lets two providers' steps be open at once — reading is not answering", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(screen.getByRole("button", { name: "Show the Gmail steps" }));
    await user.click(screen.getByRole("button", { name: "Show the iCloud Mail steps" }));
    expect(screen.getByTestId("provider-steps-gmail")).toBeInTheDocument();
    expect(screen.getByTestId("provider-steps-icloud")).toBeInTheDocument();
  });

  it("says iCloud sends no confirmation code, rather than leaving the user waiting for one", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(screen.getByRole("button", { name: "Show the iCloud Mail steps" }));
    expect(screen.getByTestId("provider-steps-icloud").textContent).toMatch(/does not send a confirmation code/i);
  });

  /**
   * The Microsoft 365 default. Said before the user spends ten minutes finding
   * out that the setting will not save — and still a `Notice`, still above the
   * steps it may invalidate: "before the user tries" is a position on the page,
   * not a tone of voice.
   */
  it("keeps the work-account caveat as a Notice inside the opened Outlook steps", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(screen.getByRole("button", { name: /outlook/i }));
    const panel = screen.getByTestId("provider-steps-outlook");
    const caveat = within(panel).getByTestId("provider-caveat-outlook");
    expect(caveat.textContent).toMatch(/administrator/i);
    expect(caveat.textContent).toMatch(/work or school/i);
    const steps = within(panel).getByRole("list");
    expect(caveat.compareDocumentPosition(steps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no caveat for a provider that has none", async () => {
    const user = userEvent.setup();
    mountForwarding();
    await intoForwarding(user);
    await user.click(screen.getByRole("button", { name: "Show the Gmail steps" }));
    expect(screen.getByTestId("provider-steps-gmail")).toBeInTheDocument();
    expect(screen.queryByTestId("provider-caveat-gmail")).toBeNull();
  });

  /**
   * No provider is ever asked, so the declaration carries the registry's
   * conservative answer: expect a confirmation. A user offered a code reader
   * they did not need has lost one line of screen; one who needed it and was
   * not offered it is stuck. Nothing downstream trusts this value.
   */
  it("declares the forward without a provider ever being asked", async () => {
    const user = userEvent.setup();
    const onForwardingDeclared = vi.fn();
    mountForwarding({ onForwardingDeclared });
    await intoForwarding(user);
    await user.click(screen.getByRole("button", { name: /i have set up forwarding/i }));
    expect(onForwardingDeclared).toHaveBeenCalledWith(true);
  });
});

/**
 * The provider's held confirmation, surfaced where the user is.
 *
 * `SetupStatus` shows the same one-tap task on the home screen, but the person
 * who just made the rule is standing HERE, and the confirmation arrives while
 * this screen is up. Same words (imported from `SetupStatus`, not forked), same
 * pinned link, same fallback to held mail.
 */
describe("the held confirmation, as one tap on the forwarding screen", () => {
  /** The live Gmail confirmation's shape — the same body `verificationCode.test.ts` scans. */
  const CONFIRM_BODY = [
    "Return-Path: <forwarding-noreply@google.com>",
    "From: Gmail Team <forwarding-noreply@google.com>",
    "Subject: (#123456789) Gmail Forwarding Confirmation - Receive Mail from you@example.com",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "you@example.com has requested to automatically forward mail to your email address.",
    "",
    "Confirmation code: 123456789",
    "",
    "To allow it, click the link below:",
    "https://mail-settings.google.com/mail/vf-%5BANGjdJ8abcDEF123%5D-XyZ0",
    "",
  ].join("\r\n");
  const CONFIRM_URL = "https://mail-settings.google.com/mail/vf-%5BANGjdJ8abcDEF123%5D-XyZ0";

  /** A quarantine page as the wire sends it, holding one verified candidate. */
  const HELD_PAGE = {
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
        blob: Buffer.from(CONFIRM_BODY, "utf8").toString("base64"),
      },
    ],
    action_needed: 1,
    expiring_soon: 0,
  };

  it("renders the notice for a held candidate, and its action opens the pinned url", async () => {
    const user = userEvent.setup();
    const openUrl = vi.fn();
    const quarantineCalls: string[] = [];
    const doFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/v1/quarantine")) {
        quarantineCalls.push(url);
        return new Response(JSON.stringify(HELD_PAGE), { status: 200 });
      }
      return new Response("no route", { status: 404 });
    }) as unknown as typeof fetch;

    render(
      <MotionProvider>
        <Address
          client={{ sessionToken: "tok" }}
          phase="forwarding"
          known={ADDRESS}
          onIssued={vi.fn()}
          onForwardingDeclared={vi.fn()}
          copy={async () => {}}
          fetch={doFetch}
          openUrl={openUrl}
          onOpenHeldMail={vi.fn()}
        />
      </MotionProvider>,
    );

    // The same notice SetupStatus shows: same title, same body, the verified
    // domain verbatim as evidence — the copy imported, not forked.
    const notice = await screen.findByTestId("forwarding-confirmation");
    expect(notice.textContent).toContain(OPEN_CONFIRMATION_COPY.title);
    expect(notice.textContent).toContain(OPEN_CONFIRMATION_COPY.body);
    expect(screen.getByTestId("forwarding-confirmation-domain").textContent).toBe("google.com");
    // The blob was actually asked for — the link is read out of it.
    expect(quarantineCalls[0]).toContain("include_blob=1");

    await user.click(screen.getByRole("button", { name: OPEN_CONFIRMATION_COPY.action }));
    expect(openUrl).toHaveBeenCalledWith(CONFIRM_URL);
  });
});
