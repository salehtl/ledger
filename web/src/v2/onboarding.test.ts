import { describe, expect, it } from "vitest";

import { memSecretStore } from "@ledger/client/store/store";
import type { State, Txn } from "@ledger/client/replay/state";

import {
  ONBOARDING_STEPS,
  QUARANTINE_HELD,
  TRUST_ONLY_YOUR_BANK,
  decodeLocal,
  emptyFacts,
  encodeLocal,
  firstMailAt,
  loadLocalRecord,
  onboardingReducer,
  resumeFacts,
  saveLocalRecord,
  screenFor,
  stepFor,
  type OnboardingFacts,
} from "./onboarding";

function complete(over: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    hasSession: true,
    accountId: "u_1",
    bank: "dib",
    inboundAddress: "u-abc@in.sirdab.ae",
    forwardingDeclared: true,
    firstMailConfirmedAt: "2026-08-01T00:00:00Z",
    homeCurrency: "AED",
    finishedAt: "2026-08-02T00:00:00Z",
    ...over,
  };
}

describe("stepFor", () => {
  it("is signed_out with no session, whatever else is true", () => {
    expect(stepFor(complete({ hasSession: false }))).toBe("signed_out");
  });

  it("reaches done only when every milestone is met", () => {
    expect(stepFor(complete())).toBe("done");
    expect(stepFor(complete({ finishedAt: null }))).toBe("home_currency_set");
  });

  it("stops at a GAP rather than at the highest true milestone", () => {
    // A reinstall: the log's facts survive, the device-local ones do not. The
    // walk must stop at the bank, not skip to the currency — otherwise the
    // device lands in the product with no forwarding rule set up.
    const reinstalled = complete({ bank: null, forwardingDeclared: false, finishedAt: null });
    expect(stepFor(reinstalled)).toBe("invited");
  });

  it("walks the declared step order", () => {
    expect([...ONBOARDING_STEPS]).toEqual([
      "signed_in",
      "invited",
      "bank_picked",
      "address_issued",
      "forwarding_configured",
      "first_mail_confirmed",
      "home_currency_set",
      "done",
    ]);
  });

  it("has a screen for every position", () => {
    expect(screenFor("signed_out")).toBe("sign_in");
    expect(screenFor("done")).toBe("product");
    for (const step of ONBOARDING_STEPS) expect(typeof screenFor(step)).toBe("string");
  });
});

describe("onboardingReducer", () => {
  it("refuses a second home currency, by identity", () => {
    const set = onboardingReducer(emptyFacts(), { type: "home_currency_set", currency: "aed" });
    expect(set.homeCurrency).toBe("AED");
    expect(onboardingReducer(set, { type: "home_currency_set", currency: "USD" })).toBe(set);
  });

  it("refuses a malformed currency rather than storing a partial one", () => {
    const f = emptyFacts();
    expect(onboardingReducer(f, { type: "home_currency_set", currency: "AE" })).toBe(f);
  });

  it("signing out drops the session and the account and touches nothing from the log", () => {
    const after = onboardingReducer(complete(), { type: "signed_out" });
    expect(after.hasSession).toBe(false);
    expect(after.accountId).toBeNull();
    expect(after.homeCurrency).toBe("AED");
    expect(after.firstMailConfirmedAt).not.toBeNull();
  });

  it("account_deleted clears everything, including the one-shot currency", () => {
    expect(onboardingReducer(complete(), { type: "account_deleted" })).toEqual(emptyFacts());
  });

  it("returns the same object when an event changes nothing", () => {
    const f = complete();
    expect(onboardingReducer(f, { type: "forwarding_declared" })).toBe(f);
  });
});

describe("resumeFacts", () => {
  it("takes the home currency from the log and from nowhere else", () => {
    const f = resumeFacts({
      hasSession: true,
      accountId: "u_1",
      inboundAddress: null,
      firstMailConfirmedAt: null,
      homeCurrency: "SAR",
      // A record carrying a currency (an older build, a hand-edited value) is
      // ignored — the log is the only authority.
      local: { ...encodeLocal(complete()), homeCurrency: "USD" } as never,
    });
    expect(f.homeCurrency).toBe("SAR");
  });

  it("prefers the server's address and falls back to the cached one when offline", () => {
    const local = encodeLocal(complete());
    expect(
      resumeFacts({
        hasSession: true,
        accountId: "u_1",
        inboundAddress: "u-new@in.sirdab.ae",
        firstMailConfirmedAt: null,
        homeCurrency: null,
        local,
      }).inboundAddress,
    ).toBe("u-new@in.sirdab.ae");

    expect(
      resumeFacts({
        hasSession: true,
        accountId: "u_1",
        inboundAddress: null,
        firstMailConfirmedAt: null,
        homeCurrency: null,
        local,
      }).inboundAddress,
    ).toBe("u-abc@in.sirdab.ae");
  });

  it("does not send a finished device back through onboarding just because it is offline", () => {
    // The whole reason the address is cached: without it, one failed GET at
    // boot walks a fully set-up user back to the address step.
    const local = encodeLocal(complete());
    const f = resumeFacts({
      hasSession: true,
      accountId: "u_1",
      inboundAddress: null,
      firstMailConfirmedAt: "2026-08-01T00:00:00Z",
      homeCurrency: "AED",
      local,
    });
    expect(stepFor(f)).toBe("done");
  });
});

describe("the device-local record", () => {
  it("round-trips through the secret store", () => {
    const secrets = memSecretStore();
    saveLocalRecord(secrets, complete());
    expect(loadLocalRecord(secrets)).toEqual(encodeLocal(complete()));
  });

  it("reads back as null when nothing was ever written", () => {
    expect(loadLocalRecord(memSecretStore())).toBeNull();
  });

  it("refuses a partially-readable record rather than half-applying it", () => {
    expect(decodeLocal({ bank: "dib", forwardingDeclared: "yes", finishedAt: null })).toBeNull();
    expect(decodeLocal({ bank: 7, forwardingDeclared: true, finishedAt: null, inboundAddress: null })).toBeNull();
    expect(decodeLocal(null)).toBeNull();
    expect(decodeLocal("{}")).toBeNull();
  });

  it("survives unreadable JSON by re-deriving rather than throwing", () => {
    const secrets = memSecretStore();
    secrets.set("onboarding_local", "{not json");
    expect(loadLocalRecord(secrets)).toBeNull();
  });

  it("has no field for a home currency — §3.7 makes that log state", () => {
    expect(Object.keys(encodeLocal(complete())).sort()).toEqual([
      "bank",
      "finishedAt",
      "forwardingDeclared",
      "inboundAddress",
    ]);
  });
});

describe("firstMailAt", () => {
  const txn = (posted_at: string): Txn => ({ posted_at }) as unknown as Txn;

  it("is null for an empty log", () => {
    expect(firstMailAt({ txns: new Map() } as Pick<State, "txns">)).toBeNull();
  });

  it("is the EARLIEST posting, not the first inserted", () => {
    const txns = new Map<string, Txn>([
      ["b", txn("2026-08-04T00:00:00Z")],
      ["a", txn("2026-07-30T00:00:00Z")],
      ["c", txn("2026-09-01T00:00:00Z")],
    ]);
    expect(firstMailAt({ txns } as unknown as Pick<State, "txns">)).toBe("2026-07-30T00:00:00Z");
  });
});

/**
 * The warning that was deleted rather than generalised, and which the operator
 * then hit on the live deployment: a forwarded bank alert was refused with
 * "icloud.com is a forwarder, and trusting it as an outer origin would trust
 * everything relayed through it".
 *
 * The reasoning for deleting it — "the screen now offers to trust every row, so
 * the promise is no longer honoured" — was backwards. That button is why the
 * warning is needed MORE: on a provider-confirmation row `inner_domain` is empty,
 * so `trustRequest` asks for the PROVIDER'S domain in outer scope.
 */
describe("the held-mail trust warning", () => {
  it("says what pressing it on a provider's own confirmation would ask for", () => {
    const body = TRUST_ONLY_YOUR_BANK.body.toLowerCase();
    expect(TRUST_ONLY_YOUR_BANK.title).not.toBe("");
    expect(body).toMatch(/bank/);
    expect(body).toMatch(/mail provider/);
    // The consequence, not just the instruction: everything that provider relays.
    expect(body).toMatch(/everything/);
  });

  /**
   * It is true for ANY provider, so it names none — the defect the first version
   * had, and the reason it was deleted instead of widened.
   */
  it("names no provider, in either half of the copy", () => {
    for (const s of [TRUST_ONLY_YOUR_BANK.title, TRUST_ONLY_YOUR_BANK.body, QUARANTINE_HELD.body]) {
      expect(s.toLowerCase()).not.toMatch(/google|gmail|icloud|outlook|yahoo|proton/);
    }
  });

  /**
   * `Onboarding.test.tsx` asserts the direct-with-the-bank route's verification
   * screen never says "forwarding rule" — that user has none.
   */
  it("does not assume the user set up a forwarding rule", () => {
    expect(TRUST_ONLY_YOUR_BANK.body.toLowerCase()).not.toMatch(/forwarding rule/);
  });
});
