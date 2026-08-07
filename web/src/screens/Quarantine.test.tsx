/**
 * The trust decision, and the two things it must never get wrong.
 *
 * 1. A verified item shows the **verified signing domain** and offers the
 *    decision; an unattested one shows a prominent unauthenticated state and
 *    offers nothing (spec §3.2). Both halves are asserted, because a screen that
 *    only ever saw verified fixtures would pass while rendering the same thing
 *    for both.
 * 2. `Reingest.Remaining` is not discarded. One confirmation files a bounded
 *    batch, and the confirmed item leaves the lane — so dropping the number
 *    leaves mail the user has already vouched for held until it expires.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MotionProvider } from "../app/MotionProvider";
import { Quarantine } from "./Quarantine";

const VERIFIED = {
  id: "q1",
  ingest_id: "a".repeat(64),
  received_at: "2026-08-01T10:00:00Z",
  expires_at: "2026-08-31T10:00:00Z",
  warned_at: null,
  delete_after: null,
  outer_domain: "google.com",
  inner_domain: "dib.ae",
  attested: true,
  // The server constrains this to "direct_dkim" or "arc" (quarantine.go:119).
  // A fixture spelling it any other way pins a value production cannot produce.
  attested_by: "direct_dkim",
  dkim: "pass",
  arc: "pass",
  size_bucket: 2,
};

const UNVERIFIED = {
  ...VERIFIED,
  id: "q2",
  ingest_id: "b".repeat(64),
  inner_domain: "",
  outer_domain: "mailer.example",
  attested: false,
  attested_by: "",
  dkim: "fail",
  arc: "none",
  // Inside its warning window, so the deletion notice is on the glass.
  warned_at: "2026-08-05T10:00:00Z",
  delete_after: "2026-08-08T10:00:00Z",
};

const CLIENT = { sessionToken: "token" };
const NOW = Date.parse("2026-08-06T10:00:00Z");

function stub(handlers: { list?: unknown; confirm?: () => Response }) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/api/v1/quarantine/confirm")) {
      expect(init?.method).toBe("POST");
      return handlers.confirm?.() ?? new Response("{}");
    }
    return new Response(JSON.stringify(handlers.list ?? { items: [], action_needed: 0, expiring_soon: 0 }));
  });
}

function mount(doFetch: ReturnType<typeof stub>, sync?: () => Promise<void>) {
  return render(
    <MotionProvider>
      <Quarantine
        client={CLIENT}
        fetch={doFetch as unknown as typeof fetch}
        now={() => NOW}
        {...(sync === undefined ? {} : { sync })}
      />
    </MotionProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("the screen must use the injected fetch");
  });
});

describe("Quarantine", () => {
  it("shows the verified signing domain for an attested message", async () => {
    mount(stub({ list: { items: [VERIFIED], action_needed: 1, expiring_soon: 0 } }));
    // The INNER origin — the bank's own verified domain — not the forwarder it
    // arrived through, and not anything the message said about itself.
    expect(await screen.findByTestId("quarantine-basis-q1")).toHaveTextContent("dib.ae");
    expect(screen.getByText("Verification: direct_dkim")).toBeInTheDocument();
  });

  it("states the unauthenticated case rather than showing a domain", async () => {
    mount(stub({ list: { items: [UNVERIFIED], action_needed: 1, expiring_soon: 1 } }));
    const basis = await screen.findByTestId("quarantine-basis-q2");
    expect(basis).toHaveTextContent("Unauthenticated");
    expect(basis).not.toHaveTextContent("mailer.example");
    expect(basis.className).toContain("text-bad");
    // §2: nothing is dropped without a user-visible notice.
    expect(screen.getByText("Scheduled for deletion in 2 days")).toBeInTheDocument();
  });

  it("refuses an unverified: domain even when the item claims to be attested", async () => {
    const user = userEvent.setup();
    // `origin.Resolve` prefixes a domain nothing attested, because the envelope
    // `MAIL FROM` is a string the sender types. The Go side keeps `attested` and
    // the prefix consistent; this asserts the CLIENT refuses on its own, so the
    // claim on this screen does not depend on a rule three packages away.
    const spoofed = { ...VERIFIED, id: "q3", inner_domain: "", outer_domain: "unverified:dib.ae" };
    const doFetch = stub({ list: { items: [spoofed], action_needed: 1, expiring_soon: 0 } });
    mount(doFetch);
    const basis = await screen.findByTestId("quarantine-basis-q3");
    expect(basis).toHaveTextContent("Unauthenticated");
    expect(basis).not.toHaveTextContent("dib.ae");
    await user.click(screen.getByTestId("quarantine-row-q3"));
    expect(await screen.findByRole("button", { name: "Cannot trust unauthenticated mail" })).toBeDisabled();
    expect(doFetch.mock.calls.some(([u]) => String(u).includes("/confirm"))).toBe(false);
  });

  it("refuses an attested item that names no domain at all", async () => {
    // Not excluded by the Go validator. It used to render a blank name under
    // "Verified signing domain" beside a disabled button — a state the screen
    // could not explain, which is not a state a security surface may show.
    const nameless = { ...VERIFIED, id: "q4", inner_domain: "", outer_domain: "" };
    mount(stub({ list: { items: [nameless], action_needed: 1, expiring_soon: 0 } }));
    expect(await screen.findByTestId("quarantine-basis-q4")).toHaveTextContent("Unauthenticated");
  });

  it("refuses the decision for an unauthenticated sender", async () => {
    const user = userEvent.setup();
    const doFetch = stub({ list: { items: [UNVERIFIED], action_needed: 1, expiring_soon: 0 } });
    mount(doFetch);
    await user.click(await screen.findByTestId("quarantine-row-q2"));
    const button = await screen.findByRole("button", { name: "Cannot trust unauthenticated mail" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(doFetch.mock.calls.some(([u]) => String(u).includes("/confirm"))).toBe(false);
  });

  it("confirms the inner origin and syncs", async () => {
    const user = userEvent.setup();
    const sync = vi.fn(async () => undefined);
    const doFetch = stub({
      list: { items: [VERIFIED], action_needed: 1, expiring_soon: 0 },
      confirm: () =>
        new Response(
          JSON.stringify({
            domain: "dib.ae",
            scope: "inner",
            ingest_ids: [VERIFIED.ingest_id],
            reingest: { examined: 1, appended: 1, superseded: 0, unchanged: 0, failed: 0, remaining: 0 },
          }),
        ),
    });
    mount(doFetch, sync);
    await user.click(await screen.findByTestId("quarantine-row-q1"));
    await user.click(await screen.findByRole("button", { name: "Trust this sender" }));

    await waitFor(() => expect(sync).toHaveBeenCalled());
    const call = doFetch.mock.calls.find(([u]) => String(u).includes("/confirm"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ domain: "dib.ae", scope: "inner" });
    expect(await screen.findByTestId("quarantine-message")).toHaveTextContent("1 transaction filed");
  });

  it("does not report a partial re-ingest as done", async () => {
    const user = userEvent.setup();
    const doFetch = stub({
      list: { items: [VERIFIED], action_needed: 1, expiring_soon: 0 },
      confirm: () =>
        new Response(
          JSON.stringify({
            domain: "dib.ae",
            scope: "inner",
            ingest_ids: [VERIFIED.ingest_id],
            // The batch is bounded; three messages were not reached.
            reingest: { examined: 500, appended: 500, superseded: 0, unchanged: 0, failed: 0, remaining: 3 },
          }),
        ),
    });
    mount(doFetch);
    await user.click(await screen.findByTestId("quarantine-row-q1"));
    await user.click(await screen.findByRole("button", { name: "Trust this sender" }));
    expect(await screen.findByText("Some held mail is still waiting")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "File the rest" })).toBeEnabled();
  });

  it("shows the server's own words when the domain is a forwarder", async () => {
    const user = userEvent.setup();
    const doFetch = stub({
      list: { items: [VERIFIED], action_needed: 1, expiring_soon: 0 },
      confirm: () =>
        new Response(JSON.stringify({ error: "forwarder_domain", detail: "mail provider" }), { status: 409 }),
    });
    mount(doFetch);
    await user.click(await screen.findByTestId("quarantine-row-q1"));
    await user.click(await screen.findByRole("button", { name: "Trust this sender" }));
    expect(await screen.findByTestId("quarantine-message")).toHaveTextContent(/mail provider, not your bank/i);
  });
});
