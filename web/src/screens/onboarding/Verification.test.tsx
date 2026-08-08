/**
 * The verification step, which is the one screen in this flow carrying a state
 * machine — and which shipped with no test, which is exactly how it shipped
 * unable to advance.
 *
 * The bug these tests exist to keep dead: `firstMailAt()` was sampled ONCE,
 * synchronously after `confirmSender` returned. The re-ingested transaction
 * reaches the local log only via a sync pull, which has not happened at that
 * instant, so the read was `null` essentially always — while `reingest` had
 * already promoted the mail out of the lane, so the next poll dropped the item
 * and took the confirm button with it. The user was stranded permanently on
 * "Nothing from a bank has arrived yet".
 *
 * So the assertions are about TIME, not about one call: the log answers `null`
 * at confirm and a timestamp two polls later, and the screen has to be the thing
 * that notices.
 */

import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../../app/MotionProvider";
import { Verification } from "./Verification";

const BANK_ITEM = {
  id: "q1",
  ingest_id: "ab12",
  received_at: "2026-08-07T10:00:00Z",
  expires_at: "2026-09-06T10:00:00Z",
  outer_domain: "mail.dib.ae",
  inner_domain: "dib.ae",
  attested: true,
  attested_by: "DKIM d=dib.ae",
  dkim: "pass",
  arc: "none",
  size_bucket: 2,
};

interface Rig {
  /** What `GET /api/v1/quarantine` answers, mutable between polls. */
  items: unknown[];
  /** What the folded log says. `null` until a "sync" lands the transaction. */
  logAt: string | null;
  reingest: unknown;
  confirmStatus: number;
  confirmCalls: { domain: string; scope: string }[];
  syncs: number;
  /**
   * What the log starts saying, then what a confirm makes it say — because that
   * is the real sequence: the transaction does not exist until the confirm's
   * re-ingest has run and a pull has landed it.
   */
  logAtAfterConfirm: string | null;
}

function mount(over: Partial<Rig> = {}, props: { expectConfirmation?: boolean } = {}) {
  const rig: Rig = {
    items: [BANK_ITEM],
    logAt: null,
    reingest: { examined: 1, appended: 1, superseded: 0, unchanged: 0, failed: 0, remaining: 0 },
    confirmStatus: 200,
    confirmCalls: [],
    syncs: 0,
    logAtAfterConfirm: null,
    ...over,
  };

  const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/api/v1/quarantine/confirm")) {
      const body = JSON.parse(String(init?.body)) as { domain: string; scope: string };
      rig.confirmCalls.push(body);
      if (rig.logAtAfterConfirm !== null) rig.logAt = rig.logAtAfterConfirm;
      if (rig.confirmStatus !== 200) {
        return json({ error: "rate_limited", detail: "too many sender confirmations" }, rig.confirmStatus);
      }
      return json({ domain: body.domain, scope: body.scope, ingest_ids: ["ab12"], reingest: rig.reingest });
    }
    if (url.includes("/api/v1/quarantine")) {
      return json({ items: rig.items, removed: [], action_needed: rig.items.length, expiring_soon: 0, complete: true });
    }
    return new Response("no route", { status: 404 });
  });

  const onConfirmed = vi.fn();
  render(
    <MotionProvider>
      <Verification
        client={{ sessionToken: "tok" }}
        fetch={doFetch as unknown as typeof fetch}
        firstMailAt={() => rig.logAt}
        onConfirmed={onConfirmed}
        sync={async () => {
          rig.syncs += 1;
        }}
        pollMs={0}
        {...(props.expectConfirmation === undefined ? {} : { expectConfirmation: props.expectConfirmation })}
      />
    </MotionProvider>,
  );
  return { rig, onConfirmed, doFetch };
}

describe("Verification", () => {
  it("does not advance on a 200 alone — the log, not the confirm call, ends the step", async () => {
    const user = userEvent.setup();
    const { rig, onConfirmed } = mount({ logAt: null });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    await waitFor(() => {
      expect(rig.confirmCalls).toEqual([{ domain: "dib.ae", scope: "inner" }]);
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    // And it says so, rather than looking like nothing happened.
    expect(screen.getByTestId("verification-message").textContent).toMatch(/keep checking/i);
  });

  it("advances once the log yields a timestamp, even with the item gone from the lane", async () => {
    // The state the old code could never observe: `reingest` has promoted the
    // message out of quarantine, so there is no row and no confirm button left,
    // and the only evidence the step is done is in the folded log.
    const { rig, onConfirmed } = mount({ items: [], logAt: "2026-08-07T10:01:00Z" });

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledWith("2026-08-07T10:01:00Z");
    });
    expect(rig.syncs).toBeGreaterThan(0);
  });

  it("pulls before it reads, because only a pull can change the log's answer", async () => {
    const { rig } = mount({ logAt: null });
    await waitFor(() => {
      expect(rig.syncs).toBeGreaterThan(0);
    });
  });

  it("keeps watching on a timer, and fires onConfirmed exactly once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const rig: { logAt: string | null } = { logAt: null };
      const onConfirmed = vi.fn();
      const doFetch = vi.fn(
        async () =>
          new Response(JSON.stringify({ items: [], removed: [], action_needed: 0, expiring_soon: 0, complete: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      render(
        <MotionProvider>
          <Verification
            client={{ sessionToken: "tok" }}
            fetch={doFetch as unknown as typeof fetch}
            firstMailAt={() => rig.logAt}
            onConfirmed={onConfirmed}
            sync={async () => {}}
            pollMs={1000}
          />
        </MotionProvider>,
      );

      await vi.waitFor(() => {
        expect(screen.getByTestId("verification-no-bank-mail")).toBeTruthy();
      });
      expect(onConfirmed).not.toHaveBeenCalled();

      // The bank email finally lands, with nothing on screen having changed.
      rig.logAt = "2026-08-07T11:00:00Z";
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3200);
      });

      expect(onConfirmed).toHaveBeenCalledWith("2026-08-07T11:00:00Z");
      // Three more ticks passed; the latch is what keeps it at one.
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not advance past an unfiled remainder, even when the log says the step is done", async () => {
    const user = userEvent.setup();
    // The successful path: the transaction IS in the log, so round 1's code
    // would advance — unmounting the only control that can file the rest.
    const { rig, onConfirmed } = mount({
      logAt: null,
      logAtAfterConfirm: "2026-08-07T10:01:00Z",
      // Never drains: every round reports the same remainder.
      reingest: { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining: 7 },
    });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    await waitFor(() => {
      expect(screen.getByTestId("verification-partial")).toBeTruthy();
    });
    expect(onConfirmed).not.toHaveBeenCalled();
    // Bounded: a server that never makes progress does not get spun on.
    expect(rig.confirmCalls.length).toBeLessThanOrEqual(4);
    // The copy must promise only what a reload cannot falsify: the block lives
    // in component state, so "setup will wait here until they are filed" — what
    // this said — becomes untrue the moment the tab is reloaded.
    const notice = screen.getByTestId("verification-partial").textContent ?? "";
    expect(notice).toMatch(/keeps trying to file/i);
    expect(notice).not.toMatch(/wait here until/i);
    // Task 10: this is no longer the ONLY screen that can file it, so the copy
    // must not say so — Settings owns held mail now.
    expect(notice).not.toMatch(/only screen/i);
    expect(notice).toMatch(/settings/i);
  });

  it("hands an unfiled remainder to Settings and lets the user carry on", async () => {
    const user = userEvent.setup();
    const { onConfirmed } = mount({
      logAt: null,
      logAtAfterConfirm: "2026-08-07T10:01:00Z",
      // Never drains.
      reingest: { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining: 7 },
    });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));
    const partial = await screen.findByTestId("verification-partial");
    expect(onConfirmed).not.toHaveBeenCalled();

    // The handoff: setup does not dead-end on mail Settings can file. Pressing
    // this is the user being TOLD, which is why the block is released here and
    // not automatically — an auto-advance would unmount this notice in the same
    // frame it appeared, and the user would never have read it.
    await user.click(within(partial).getByRole("button", { name: /carry on/i }));
    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledWith("2026-08-07T10:01:00Z");
    });
  });

  it("drains the batch across rounds and only then advances", async () => {
    const user = userEvent.setup();
    const remainders = [12, 5, 0];
    const { rig, onConfirmed } = mount({ logAt: null, logAtAfterConfirm: "2026-08-07T10:01:00Z" });
    let round = 0;
    Object.defineProperty(rig, "reingest", {
      get() {
        const remaining = remainders[Math.min(round, remainders.length - 1)] ?? 0;
        round += 1;
        return { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining };
      },
    });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledWith("2026-08-07T10:01:00Z");
    });
    expect(rig.confirmCalls).toHaveLength(3);
    expect(screen.queryByTestId("verification-partial")).toBeNull();
  });

  it("surfaces a partial re-ingest and can continue the batch after the item has left the lane", async () => {
    const user = userEvent.setup();
    const { rig } = mount({
      reingest: { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining: 7 },
    });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    const partial = await screen.findByTestId("verification-partial");
    expect(partial.textContent).toMatch(/7 messages/);

    // The confirmed item is gone from the lane, so the notice is the ONLY thing
    // left that can offer to file the rest — and it is still on screen, which is
    // the whole point.
    rig.items = [];
    const before = rig.confirmCalls.length;
    await user.click(within(partial).getByRole("button", { name: /file the rest/i }));

    await waitFor(() => {
      expect(rig.confirmCalls.length).toBeGreaterThan(before);
    });
    // Always the server's normalized spelling, never the item's outer domain.
    expect(rig.confirmCalls.every((c) => c.domain === "dib.ae" && c.scope === "inner")).toBe(true);
  });

  it("keeps an outstanding remainder when a retry fails, rather than losing it", async () => {
    const user = userEvent.setup();
    const { rig, onConfirmed } = mount({
      logAt: null,
      logAtAfterConfirm: "2026-08-07T10:01:00Z",
      reingest: { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining: 7 },
    });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));
    const partial = await screen.findByTestId("verification-partial");
    expect(partial.textContent).toMatch(/7 messages/);

    // The retry is rate-limited on its FIRST round, so it learns nothing about
    // the remainder. Clearing it here would unblock the advance and lose the
    // mail — which is what a naively "symmetric" catch path would do.
    rig.items = [];
    rig.confirmStatus = 429;
    await user.click(within(partial).getByRole("button", { name: /file the rest/i }));

    await waitFor(() => {
      expect(screen.getByTestId("verification-message").textContent).toMatch(/wait about a minute/i);
    });
    expect(screen.getByTestId("verification-partial")).toBeTruthy();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("tells a rate-limited user to wait rather than to try again", async () => {
    const user = userEvent.setup();
    mount({ confirmStatus: 429 });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    const message = await screen.findByTestId("verification-message");
    expect(message.textContent).toMatch(/wait about a minute/i);
    expect(message.textContent).not.toMatch(/try again/i);
  });

  /**
   * The provider-agnostic rework. A confirmation from ANY verified provider can
   * be opened and read; the old code recognised Google alone, so a Fastmail user
   * sat on "Waiting for Google's confirmation" with the message already held.
   */
  it("lets the user open a held confirmation from any verified provider", async () => {
    const user = userEvent.setup();
    mount({
      items: [
        {
          ...BANK_ITEM,
          id: "q9",
          outer_domain: "fastmail.com",
          inner_domain: "",
          attested_by: "DKIM d=fastmail.com",
          blob: Buffer.from(
            ["Content-Type: text/plain; charset=UTF-8", "", "Confirmation code: 481516234", ""].join("\r\n"),
            "utf8",
          ).toString("base64"),
        },
      ],
    });

    // Listed by its VERIFIED signing domain, and openable — no code is read
    // until the user says this is the message they are waiting for.
    const item = await screen.findByTestId("verification-item-q9");
    expect(item.textContent).toContain("fastmail.com");
    expect(screen.queryByTestId("verification-code")).toBeNull();

    await user.click(within(item).getByRole("button", { name: /look for a confirmation code/i }));
    expect((await screen.findByTestId("verification-code")).textContent).toBe("481516234");
  });

  /**
   * The link the screen offers is pinned to the domain the SERVER verified —
   * `google.com` here — so a subdomain of it is offered and the two decoys in
   * the same body are not. Nothing about where this link may point comes out of
   * the message.
   */
  it("offers a link only on the message's own verified signing domain", async () => {
    const user = userEvent.setup();
    mount({
      items: [
        {
          ...BANK_ITEM,
          id: "q7",
          outer_domain: "google.com",
          inner_domain: "",
          attested_by: "DKIM d=google.com",
          blob: Buffer.from(
            [
              "Content-Type: text/plain; charset=UTF-8",
              "",
              "https://evil.example/mail/steal",
              "https://evil-google.com/mail/steal",
              "https://mail-settings.google.com/mail/vf-abc",
              "",
            ].join("\r\n"),
            "utf8",
          ).toString("base64"),
        },
      ],
    });

    const item = await screen.findByTestId("verification-item-q7");
    await user.click(within(item).getByRole("button", { name: /look for a confirmation code/i }));

    const link = await screen.findByTestId("verification-open-link");
    expect(link.getAttribute("href")).toBe("https://mail-settings.google.com/mail/vf-abc");
    // And the sentence names the verified domain, not a host read out of the body.
    expect(link.textContent).toContain("google.com");
    expect(link.textContent).not.toContain("evil");
  });

  /** Listed, so it is not a mystery — but never openable and never trustable. */
  it("lists unverified held mail without offering to read a code out of it", async () => {
    mount({
      items: [
        { ...BANK_ITEM, id: "q8", outer_domain: "unverified:fastmail.com", inner_domain: "", attested: false },
      ],
    });
    const item = await screen.findByTestId("verification-item-q8");
    expect(item.textContent).toContain("Unauthenticated");
    expect(item.textContent).not.toContain("fastmail.com");
    expect(within(item).queryByRole("button", { name: /look for a confirmation code/i })).toBeNull();
  });

  it("refuses to offer trust for unauthenticated mail", async () => {
    mount({ items: [{ ...BANK_ITEM, attested: false, attested_by: "", inner_domain: "" }] });
    const button = await screen.findByRole("button", { name: /cannot trust unauthenticated mail/i });
    expect(button).toHaveProperty("disabled", true);
  });

  /**
   * The finding the operator proved on the live deployment. On a provider's own
   * confirmation `inner_domain` is empty, so "This is my bank" asks to trust the
   * PROVIDER'S domain in outer scope — everything it relays. The server refuses
   * that, but a user who is not told why simply presses again.
   */
  it("warns what the trust button asks for, before the button", async () => {
    mount();
    const warning = await screen.findByTestId("verification-trust-warning");
    expect(warning.textContent?.toLowerCase()).toMatch(/mail provider/);
    expect(warning.textContent?.toLowerCase()).toMatch(/everything/);
    const button = screen.getByRole("button", { name: /this is my bank/i });
    expect(warning.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not warn about a button that is not on screen", async () => {
    mount({ items: [] });
    await screen.findByTestId("verification-no-bank-mail");
    expect(screen.queryByTestId("verification-trust-warning")).toBeNull();
  });

  /** No provider is named any more, because the screen serves all of them. */
  it("does not claim the held message is Google's", async () => {
    mount();
    await screen.findByTestId("verification");
    expect(screen.getByRole("heading", { level: 1 }).textContent).not.toMatch(/google|gmail/i);
  });
});

/**
 * The iCloud case, and the direct-with-the-bank case: there is no code, and a
 * screen that waits for one is a promise the flow cannot keep.
 */
describe("Verification when no confirmation code is expected", () => {
  const CONFIRMATION = {
    ...BANK_ITEM,
    id: "q5",
    outer_domain: "fastmail.com",
    inner_domain: "",
    attested_by: "DKIM d=fastmail.com",
    blob: Buffer.from(
      ["Content-Type: text/plain; charset=UTF-8", "", "Confirmation code: 481516234", ""].join("\r\n"),
      "utf8",
    ).toString("base64"),
  };

  it("waits for the first bank email and offers no code reader", async () => {
    mount({ items: [CONFIRMATION] }, { expectConfirmation: false });

    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/first bank email/i);
    const item = await screen.findByTestId("verification-item-q5");
    expect(within(item).queryByRole("button", { name: /look for a confirmation code/i })).toBeNull();
    // The message is still listed by its verified signing domain: it is held,
    // and pretending otherwise is how a user decides ledger has lost mail.
    expect(item.textContent).toContain("fastmail.com");
  });

  it("offers both when a confirmation IS expected", async () => {
    mount({ items: [CONFIRMATION] }, { expectConfirmation: true });
    const item = await screen.findByTestId("verification-item-q5");
    expect(within(item).getByRole("button", { name: /look for a confirmation code/i })).toBeTruthy();
  });

  /**
   * The gate does not move. A transaction in the log is the only
   * provider-agnostic proof that forwarding actually works, whichever route the
   * user took to arrange it.
   */
  it("still advances only on a transaction in the log", async () => {
    const { onConfirmed } = mount({ items: [], logAt: "2026-08-07T10:01:00Z" }, { expectConfirmation: false });
    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledWith("2026-08-07T10:01:00Z");
    });
  });

  it("does not advance without one, however sure the provider was", async () => {
    const { onConfirmed } = mount({ items: [], logAt: null }, { expectConfirmation: false });
    await screen.findByTestId("verification-no-bank-mail");
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  /**
   * Never a dead end: a provider we believed sends no code may send one anyway,
   * and the user who is holding it must not have to reinstall to read it.
   */
  it("lets a user who did get a code ask for the reader", async () => {
    const user = userEvent.setup();
    mount({ items: [CONFIRMATION] }, { expectConfirmation: false });

    await user.click(await screen.findByRole("button", { name: /did send a confirmation code/i }));
    const item = screen.getByTestId("verification-item-q5");
    await user.click(within(item).getByRole("button", { name: /look for a confirmation code/i }));
    expect((await screen.findByTestId("verification-code")).textContent).toBe("481516234");
  });

  /** The provider choice is copy. It cannot make anything more or less trusted. */
  it("changes nothing about what may be trusted", async () => {
    mount({ items: [{ ...BANK_ITEM, id: "q6", attested: false, attested_by: "", inner_domain: "" }] }, {
      expectConfirmation: false,
    });
    const button = await screen.findByRole("button", { name: /cannot trust unauthenticated mail/i });
    expect(button).toHaveProperty("disabled", true);
  });
});
