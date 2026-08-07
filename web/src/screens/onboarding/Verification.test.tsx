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
}

function mount(over: Partial<Rig> = {}) {
  const rig: Rig = {
    items: [BANK_ITEM],
    logAt: null,
    reingest: { examined: 1, appended: 1, superseded: 0, unchanged: 0, failed: 0, remaining: 0 },
    confirmStatus: 200,
    confirmCalls: [],
    syncs: 0,
    ...over,
  };

  const doFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (v: unknown, status = 200): Response =>
      new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/api/v1/quarantine/confirm")) {
      const body = JSON.parse(String(init?.body)) as { domain: string; scope: string };
      rig.confirmCalls.push(body);
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

  it("surfaces a partial re-ingest and can continue the batch after the item has left the lane", async () => {
    const user = userEvent.setup();
    const { rig } = mount({
      reingest: { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining: 7 },
    });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    const partial = await screen.findByTestId("verification-partial");
    expect(partial.textContent).toMatch(/7 messages/);

    // The confirmed item is gone from the lane, so the notice is the ONLY thing
    // left that can offer to file the rest.
    rig.items = [];
    await user.click(within(partial).getByRole("button", { name: /file the rest/i }));

    await waitFor(() => {
      expect(rig.confirmCalls).toHaveLength(2);
    });
    expect(rig.confirmCalls[1]).toEqual({ domain: "dib.ae", scope: "inner" });
  });

  it("tells a rate-limited user to wait rather than to try again", async () => {
    const user = userEvent.setup();
    mount({ confirmStatus: 429 });

    await user.click(await screen.findByRole("button", { name: /this is my bank/i }));

    const message = await screen.findByTestId("verification-message");
    expect(message.textContent).toMatch(/wait about a minute/i);
    expect(message.textContent).not.toMatch(/try again/i);
  });

  it("refuses to offer trust for unauthenticated mail", async () => {
    mount({ items: [{ ...BANK_ITEM, attested: false, attested_by: "", inner_domain: "" }] });
    const button = await screen.findByRole("button", { name: /cannot trust unauthenticated mail/i });
    expect(button).toHaveProperty("disabled", true);
  });
});
