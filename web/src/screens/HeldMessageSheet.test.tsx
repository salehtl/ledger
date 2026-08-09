/**
 * The one screen in the app that renders attacker-controlled text.
 *
 * Anyone who learns a user's inbound address can put a string on this panel, so
 * the tests below are about containment rather than about layout: the body
 * creates no elements, the heading is a verification state and not the sender's
 * letterhead, and confirming writes one transaction op and never an allowlist
 * row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { OpSpec } from "@ledger/client/outbox/outbox";
import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";

import { MotionProvider } from "../app/MotionProvider";
import type { QuarantineItem } from "../v2/onboardingIO";
import type { Prefill } from "../v2/sources/heldMessage";
import type { Writer } from "../v2/writer";
import { claimLine, HeldMessageSheet } from "./HeldMessageSheet";

const ITEM: QuarantineItem = {
  id: "q1",
  ingestId: "a".repeat(64),
  receivedAt: "2026-08-03T10:00:00Z",
  expiresAt: "2026-09-02T10:00:00Z",
  warnedAt: null,
  deleteAfter: null,
  outerDomain: "gmail.com",
  innerDomain: "dib.ae",
  attested: false,
  attestedBy: "",
  dkim: "pass",
  arc: "none",
  sizeBucket: 2,
};

const FILLED: Prefill = {
  body: "You spent AED 125.00 at CARREFOUR MALL.",
  subject: "Transaction alert",
  claimedFrom: "alerts@dib.ae",
  draft: { amount: "125.00", currency: "AED", direction: "debit", merchant: "CARREFOUR MALL", date: "2026-08-03", category: null },
  templateId: "dib.card.v1",
  reason: "Filled in from the message below. Check every field before you add it.",
};

const EMPTY: Prefill = {
  body: "Some words from a bank ledger has no reader for.",
  subject: "Alert",
  claimedFrom: "alerts@unknown.test",
  draft: null,
  templateId: null,
  reason: "ledger has no reader for this sender, so nothing was filled in. The message is below — copy the details across.",
};

interface Recorder extends Writer {
  queued: OpSpec[];
}

function recorder(): Recorder {
  const queued: OpSpec[] = [];
  return { queued, pending: [], enqueueMany: (specs) => void queued.push(...specs), flush: async () => undefined };
}

function mount(prefill: Prefill | null, writer: Writer, onAdded = () => undefined) {
  return render(
    <MotionProvider>
      <HeldMessageSheet
        item={ITEM}
        prefill={prefill}
        homeCurrency="AED"
        categories={["groceries", "eating out"]}
        currencies={["AED"]}
        writer={writer}
        onClose={() => undefined}
        onAdded={onAdded}
      />
    </MotionProvider>,
  );
}

beforeEach(() => {
  setPlatform(webPlatform);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("reviewing a held message must never reach the network");
    }),
  );
});

describe("a hostile message body", () => {
  it("renders as characters, never as markup", () => {
    const hostile: Prefill = {
      ...EMPTY,
      subject: "<img src=x onerror=alert(1)>",
      body: '<script>alert("xss")</script><img src=x onerror="alert(1)"><a href="https://evil.test">Click here</a>',
    };
    const { container } = mount(hostile, recorder());

    const body = screen.getByTestId("held-body");
    // The tags are TEXT. Not stripped, not rendered — visible, which is what
    // tells a user the message contained them.
    expect(body).toHaveTextContent("<script>");
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("a")).toBeNull();
    expect(body.innerHTML).not.toContain("<script");
    // Nowhere else on the panel either — the subject goes through the same path.
    expect(container.querySelectorAll("script, img, iframe, object, embed")).toHaveLength(0);
    expect(screen.getByTestId("held-subject")).toHaveTextContent("<img src=x onerror=alert(1)>");
  });

  it("leads with the verification state, not with the sender's name", () => {
    mount(EMPTY, recorder());
    const claim = screen.getByTestId("held-claim");
    expect(claim).toHaveTextContent("Unverified.");
    expect(claim).toHaveTextContent("Claims to be from dib.ae");
    expect(claim).toHaveTextContent("Nothing checked this.");
    expect(claim.className).toContain("text-bad");
  });

  it("keeps the server's own unverified prefix rather than tidying it away", () => {
    expect(claimLine({ ...ITEM, innerDomain: "", outerDomain: "unverified:bank.test" })).toContain("unverified:bank.test");
    expect(claimLine({ ...ITEM, innerDomain: "", outerDomain: "" })).toContain("names no sender");
  });
});

describe("what the panel promises", () => {
  it("says nothing was filled in when no template matched, and offers an empty form", () => {
    mount(EMPTY, recorder());
    expect(screen.getByTestId("held-reason")).toHaveTextContent("nothing was filled in");
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    expect(screen.getByLabelText("Merchant")).toHaveValue("");
  });

  it("prefills from a template that did match, and asks the user to check it", () => {
    mount(FILLED, recorder());
    expect(screen.getByLabelText("Amount")).toHaveValue("125.00");
    expect(screen.getByLabelText("Merchant")).toHaveValue("CARREFOUR MALL");
    expect(screen.getByTestId("held-reason")).toHaveTextContent("Check every field");
  });

  it("says the message stays held and no money moves", () => {
    mount(FILLED, recorder());
    expect(screen.getByText(/moves no money/)).toBeInTheDocument();
    expect(screen.getByText(/does not trust this sender/)).toBeInTheDocument();
  });
});

describe("confirming", () => {
  it("authors exactly one txn_ingested carrying the reviewed marker", async () => {
    const writer = recorder();
    let added = 0;
    mount(FILLED, writer, () => {
      added += 1;
    });

    await userEvent.click(screen.getByTestId("held-add"));
    await waitFor(() => expect(writer.queued).toHaveLength(1));

    const spec = writer.queued[0]!;
    expect(spec.type).toBe("txn_ingested");
    expect(spec.ingestId).toMatch(/^[0-9a-f]{64}$/);
    const payload = spec.payload as Record<string, unknown>;
    expect(payload["entry_method"]).toBe("reviewed_forward");
    expect(payload["amount_minor"]).toBe("12500");
    expect(payload).not.toHaveProperty("verified_origin_domain");
    expect(added).toBe(1);
  });

  it("writes no allowlist row and calls no confirm endpoint", async () => {
    const writer = recorder();
    mount(FILLED, writer);
    await userEvent.click(screen.getByTestId("held-add"));
    await waitFor(() => expect(writer.queued).toHaveLength(1));

    // `fetch` throws on any call, so a promotion would have failed the test
    // already; asserted explicitly because it is the invariant of the lane.
    expect(writer.queued.every((s) => s.type === "txn_ingested")).toBe(true);
    expect(writer.queued.some((s) => JSON.stringify(s).includes("allowlist"))).toBe(false);
  });

  it("refuses an empty form in words rather than authoring a hollow op", async () => {
    const writer = recorder();
    mount(EMPTY, writer);
    await userEvent.click(screen.getByTestId("held-add"));
    expect(await screen.findByTestId("held-error")).toHaveTextContent("How much was it?");
    expect(writer.queued).toHaveLength(0);
  });

  it("cannot be confirmed before the message has been read", () => {
    mount(null, recorder());
    expect(screen.getByTestId("held-add")).toBeDisabled();
  });
});
