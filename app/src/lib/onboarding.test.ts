/**
 * The onboarding machine, and the one irreversible decision in the product.
 *
 * Two things here are worth more than the rest of the file:
 *
 *  1. **The step is derived, never stored.** Every test that names a resume
 *     point builds a `OnboardingFacts` from durable sources and asks where it
 *     lands — because that is exactly what a cold launch does. A machine that
 *     persisted a step counter would pass a transition table and still send a
 *     reinstalled device back through the home-currency picker.
 *  2. **The ops are folded by the real replay engine**, not compared against a
 *     hand-written object. `homeCurrencyOps` is one `payload` key away from
 *     producing an op that validates, uploads, and folds to nothing; the only
 *     check that can see that is `fold`.
 */

import { describe, expect, test } from "bun:test";

import {
  HALT_CHAIN_WITHHELD,
  HALT_NOT_VOUCHED_FOR,
  type Halt,
} from "@ledger/client/invariants/surface.ts";
import { HOME_IDENTITY_MICRO } from "@ledger/client/replay/fx.ts";
import { emptyState, fold, type LogEntry } from "@ledger/client/replay/replay.ts";
import type { State, Txn } from "@ledger/client/replay/state.ts";
import { memSecretStore } from "@ledger/client/store/store.ts";
import { SCHEMA_VERSION, validateOp, type Op, type OpType } from "@ledger/client/wire/op.ts";

import {
  AWAITING_VOUCH,
  COMMON_CURRENCIES,
  countFrozenSnapshots,
  decodeLocal,
  emptyFacts,
  encodeLocal,
  homeCurrencyLock,
  homeCurrencyOps,
  HOME_CURRENCY_RULE,
  LOCAL_RECORD_KEYS,
  loadLocalRecord,
  saveLocalRecord,
  onboardingGate,
  onboardingReducer,
  ONBOARDING_STEPS,
  pegIllustration,
  QUARANTINE_HELD,
  resumeFacts,
  screenFor,
  searchCurrencies,
  stepFor,
  USD_PEG_MICRO,
  confirmCopy,
  normalizeCurrency,
  type OnboardingFacts,
  type OnboardingPosition,
  type OpSpec,
} from "./onboarding.ts";

// ---------------------------------------------------------------------------
// Fact builders
// ---------------------------------------------------------------------------

/** Facts for a device that has completed everything up to and including `step`. */
function factsAt(step: OnboardingPosition): OnboardingFacts {
  const f = emptyFacts();
  const reached = (s: OnboardingPosition): boolean => {
    if (step === "signed_out") return false;
    return ONBOARDING_STEPS.indexOf(s as never) <= ONBOARDING_STEPS.indexOf(step as never);
  };
  return {
    ...f,
    hasSession: reached("signed_in"),
    accountId: reached("invited") ? "user-1" : null,
    bank: reached("bank_picked") ? "dib" : null,
    inboundAddress: reached("address_issued") ? "abc@in.example" : null,
    forwardingDeclared: reached("forwarding_configured"),
    firstMailConfirmedAt: reached("first_mail_confirmed") ? "2026-08-02T10:00:00.000Z" : null,
    homeCurrency: reached("home_currency_set") ? "AED" : null,
    finishedAt: reached("done") ? "2026-08-02T10:05:00.000Z" : null,
  };
}

function entry(spec: OpSpec, seq: bigint): LogEntry {
  const op: Op = {
    v: SCHEMA_VERSION,
    type: spec.type as OpType,
    op_id: `op-${seq}`,
    authored_at: "2026-08-02T10:00:00.000Z",
    parent_version: null,
    payload: spec.payload,
  };
  // `Client.emit` validates before the op reaches the pending batch, so an op
  // spec that cannot pass this can never be authored. Asserted rather than
  // assumed: a payload key typo produces a *valid* op that folds to nothing,
  // and only the fold below can see that — but a shape error should fail here,
  // where the message names the field.
  validateOp(op);
  return { op, seq, writer_id: "dev-a" };
}

function foldSpecs(specs: readonly OpSpec[]): State {
  return fold(
    specs.map((s, i) => entry(s, BigInt(i + 1))),
    emptyState(),
  );
}

function halt(kind: Halt["kind"], title = "t", body = "b"): Halt {
  return { kind, title, body, action: null, dismissable: false, syncStopped: true, violations: [] };
}

// ---------------------------------------------------------------------------
// Step 1 — the step machine
// ---------------------------------------------------------------------------

describe("stepFor", () => {
  test("a device with nothing on it is not in the machine at all", () => {
    expect(stepFor(emptyFacts())).toBe("signed_out");
  });

  test("every step in the plan's order is reachable, and lands on itself", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(stepFor(factsAt(step))).toBe(step);
    }
    // A fixture with one of something cannot tell "correct ordering" from "no
    // ordering", so this asserts the vocabulary too.
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

  test("a gap is never skipped, however much sits behind it", () => {
    // Everything true except the bank. A machine that took the highest true
    // milestone would answer "done" and drop the user into a product with no
    // inbound mail configured.
    const f = { ...factsAt("done"), bank: null };
    expect(stepFor(f)).toBe("invited");
  });

  test("losing the session takes the machine out of the flow entirely", () => {
    expect(stepFor({ ...factsAt("done"), hasSession: false })).toBe("signed_out");
  });

  test("a session with no confirmed account stops at signed_in", () => {
    expect(stepFor({ ...factsAt("done"), accountId: null })).toBe("signed_in");
  });
});

describe("resume points", () => {
  test("a force-quit at any step resumes at that step", () => {
    // A force-quit loses nothing but memory: every fact is read back from the
    // Keychain, the server or the log. So this is the identity property, and
    // it is the reason nothing here stores a step number.
    for (const step of ONBOARDING_STEPS) {
      const f = factsAt(step);
      const roundTripped = resumeFacts({
        hasSession: f.hasSession,
        accountId: f.accountId,
        inboundAddress: f.inboundAddress,
        firstMailConfirmedAt: f.firstMailConfirmedAt,
        homeCurrency: f.homeCurrency,
        local: encodeLocal(f),
      });
      expect(stepFor(roundTripped)).toBe(step);
    }
  });

  test("a reinstall never re-asks for the home currency", () => {
    // THE failure this whole design exists to prevent. A reinstall keeps the
    // log (home currency, first mail) and the server's facts (account,
    // address) and loses the device-local half (bank, forwarding, finished).
    // The prefix walk therefore sends the user back to the bank picker — and
    // must walk *past* the currency step, because a second `home_currency_set`
    // is an anomaly the log records forever.
    const complete = factsAt("done");
    const reinstalled = resumeFacts({
      hasSession: true,
      accountId: complete.accountId,
      inboundAddress: complete.inboundAddress,
      firstMailConfirmedAt: complete.firstMailConfirmedAt,
      homeCurrency: complete.homeCurrency,
      local: null,
    });
    expect(stepFor(reinstalled)).toBe("invited");
    expect(screenFor(stepFor(reinstalled))).toBe("bank");

    // Walk it forward through the device-local steps only, and check the
    // currency picker is never the screen.
    let f = reinstalled;
    const seen: string[] = [];
    for (const e of [
      { type: "bank_picked", bank: "dib" },
      { type: "forwarding_declared" },
      { type: "finished", at: "2026-08-02T11:00:00.000Z" },
    ] as const) {
      f = onboardingReducer(f, e);
      seen.push(screenFor(stepFor(f)));
    }
    expect(seen).not.toContain("home_currency");
    expect(stepFor(f)).toBe("done");
  });

  test("a reinstall before the currency was ever set does re-ask", () => {
    // The mirror of the test above. Without it, "never re-asks" would also
    // pass if the picker were unreachable for everyone.
    const f = resumeFacts({
      hasSession: true,
      accountId: "user-1",
      inboundAddress: "abc@in.example",
      firstMailConfirmedAt: "2026-08-02T10:00:00.000Z",
      homeCurrency: null,
      local: { bank: "dib", forwardingDeclared: true, finishedAt: null },
    });
    expect(screenFor(stepFor(f))).toBe("home_currency");
  });
});

describe("the local record", () => {
  test("carries exactly the device-local facts, and no currency", () => {
    // Spec §3.7: the home currency is log state, never a device setting. The
    // cheapest way to keep that true is a persisted record with nowhere to put
    // one, so this asserts the key set rather than the absence of one key.
    const f = factsAt("done");
    expect(Object.keys(encodeLocal(f)).sort()).toEqual([...LOCAL_RECORD_KEYS].sort());
    expect(JSON.stringify(encodeLocal(f))).not.toContain("AED");
  });

  test("resumeFacts takes the home currency from the log and nothing else", () => {
    const f = resumeFacts({
      hasSession: true,
      accountId: "user-1",
      inboundAddress: "a@b.c",
      firstMailConfirmedAt: "2026-08-02T10:00:00.000Z",
      homeCurrency: null,
      // A stale record from an older build that DID persist one.
      local: decodeLocal({ bank: "dib", forwardingDeclared: true, finishedAt: null, homeCurrency: "USD" }),
    });
    expect(f.homeCurrency).toBeNull();
  });

  test("round-trips through the one durable store this app has", () => {
    const secrets = memSecretStore();
    expect(loadLocalRecord(secrets)).toBeNull();
    saveLocalRecord(secrets, factsAt("done"));
    expect(loadLocalRecord(secrets)).toEqual({
      bank: "dib",
      forwardingDeclared: true,
      finishedAt: "2026-08-02T10:05:00.000Z",
    });
    // And what actually reaches the Keychain carries no currency, whatever the
    // in-memory facts held.
    expect(secrets.get("onboarding_local")).not.toContain("AED");
  });

  test("an unreadable stored record is re-derived, never half-read", () => {
    const secrets = memSecretStore();
    secrets.set("onboarding_local", "{not json");
    expect(loadLocalRecord(secrets)).toBeNull();
    secrets.set("onboarding_local", JSON.stringify({ bank: 7, forwardingDeclared: true, finishedAt: null }));
    expect(loadLocalRecord(secrets)).toBeNull();
    secrets.set("onboarding_local", "");
    expect(loadLocalRecord(secrets)).toBeNull();
  });

  test("a force-quit at any step is resumed from what was actually written", () => {
    // Step 1's resumability, end to end through the real persistence rather
    // than through an in-memory hand-off: the record on disk is the only thing
    // a cold launch has.
    for (const step of ONBOARDING_STEPS) {
      const secrets = memSecretStore();
      const before = factsAt(step);
      saveLocalRecord(secrets, before);
      const after = resumeFacts({
        hasSession: before.hasSession,
        accountId: before.accountId,
        inboundAddress: before.inboundAddress,
        firstMailConfirmedAt: before.firstMailConfirmedAt,
        homeCurrency: before.homeCurrency,
        local: loadLocalRecord(secrets),
      });
      expect(stepFor(after)).toBe(step);
    }
  });

  test("decodeLocal refuses junk rather than half-reading it", () => {
    expect(decodeLocal(null)).toBeNull();
    expect(decodeLocal("{}")).toBeNull();
    expect(decodeLocal({ bank: 7, forwardingDeclared: true, finishedAt: null })).toBeNull();
    expect(decodeLocal({ bank: null, forwardingDeclared: "yes", finishedAt: null })).toBeNull();
    expect(decodeLocal({ bank: null, forwardingDeclared: false, finishedAt: null })).toEqual({
      bank: null,
      forwardingDeclared: false,
      finishedAt: null,
    });
  });
});

describe("onboardingReducer", () => {
  test("every event moves exactly the fact it names", () => {
    let f = emptyFacts();
    f = onboardingReducer(f, { type: "session", hasSession: true });
    expect(stepFor(f)).toBe("signed_in");
    f = onboardingReducer(f, { type: "account_confirmed", accountId: "user-1" });
    expect(stepFor(f)).toBe("invited");
    f = onboardingReducer(f, { type: "bank_picked", bank: "dib" });
    expect(stepFor(f)).toBe("bank_picked");
    f = onboardingReducer(f, { type: "address_issued", address: "abc@in.example" });
    expect(stepFor(f)).toBe("address_issued");
    f = onboardingReducer(f, { type: "forwarding_declared" });
    expect(stepFor(f)).toBe("forwarding_configured");
    f = onboardingReducer(f, { type: "first_mail_confirmed", at: "2026-08-02T10:00:00.000Z" });
    expect(stepFor(f)).toBe("first_mail_confirmed");
    f = onboardingReducer(f, { type: "home_currency_set", currency: "AED" });
    expect(stepFor(f)).toBe("home_currency_set");
    f = onboardingReducer(f, { type: "finished", at: "2026-08-02T10:05:00.000Z" });
    expect(stepFor(f)).toBe("done");
  });

  test("a second home_currency_set is refused, and the first one stands", () => {
    // Plan Task 14 Step 4. The client refusal is the only thing between a
    // double-tap and a permanent `home_currency_reset` anomaly in the log.
    const f = onboardingReducer(factsAt("first_mail_confirmed"), { type: "home_currency_set", currency: "AED" });
    const again = onboardingReducer(f, { type: "home_currency_set", currency: "USD" });
    expect(again.homeCurrency).toBe("AED");
    // Same object: the refusal is a no-op, not a re-write that happens to land
    // on the same value.
    expect(again).toBe(f);
  });

  test("the currency is normalised on the way in", () => {
    const f = onboardingReducer(factsAt("first_mail_confirmed"), { type: "home_currency_set", currency: " aed " });
    expect(f.homeCurrency).toBe("AED");
  });

  test("an unusable currency code is refused rather than stored", () => {
    const base = factsAt("first_mail_confirmed");
    for (const bad of ["", "AE", "AEDX", "A1D", "  "]) {
      expect(onboardingReducer(base, { type: "home_currency_set", currency: bad })).toBe(base);
    }
  });

  test("signing out drops the session and the account, and nothing derived from the log", () => {
    const f = onboardingReducer(factsAt("done"), { type: "signed_out" });
    expect(f.hasSession).toBe(false);
    expect(f.accountId).toBeNull();
    expect(f.homeCurrency).toBe("AED");
    expect(stepFor(f)).toBe("signed_out");
  });

  test("account deletion clears everything, including the home currency", () => {
    // The only remedy the product offers for a wrong home currency. If this
    // left it behind, the remedy would not work.
    expect(onboardingReducer(factsAt("done"), { type: "account_deleted" })).toEqual(emptyFacts());
  });

  test("an event that names a fact already true is idempotent", () => {
    const f = factsAt("bank_picked");
    expect(onboardingReducer(f, { type: "session", hasSession: true })).toBe(f);
  });
});

describe("screenFor", () => {
  test("is total over every position, and no two steps share a screen", () => {
    const positions: OnboardingPosition[] = ["signed_out", ...ONBOARDING_STEPS];
    const screens = positions.map(screenFor);
    expect(screens).toEqual([
      "sign_in",
      "confirming",
      "bank",
      "address",
      "forwarding",
      "verification",
      "home_currency",
      "finish",
      "product",
    ]);
    expect(new Set(screens).size).toBe(screens.length);
  });
});

// ---------------------------------------------------------------------------
// The gate: a checkpoint wait is not a failure
// ---------------------------------------------------------------------------

describe("onboardingGate", () => {
  test("no halt is a clear gate", () => {
    expect(onboardingGate(null).kind).toBe("clear");
  });

  test("an un-vouched-for device is a wait, with its own words", () => {
    const g = onboardingGate(halt(HALT_NOT_VOUCHED_FOR));
    expect(g.kind).toBe("awaiting_vouch");
    if (g.kind !== "awaiting_vouch") throw new Error("unreachable");
    // The library's copy says "syncing has stopped", which is true and reads
    // as a fault to somebody who has been using the app for ninety seconds.
    expect(g.copy).toBe(AWAITING_VOUCH);
    expect(g.copy.body.toLowerCase()).not.toContain("stopped");
    expect(g.copy.body.toLowerCase()).not.toContain("error");
    expect(g.copy.action.length).toBeGreaterThan(0);
  });

  test("any other hard stop is handed on untouched", () => {
    const h = halt(HALT_CHAIN_WITHHELD);
    const g = onboardingGate(h);
    expect(g.kind).toBe("halted");
    if (g.kind !== "halted") throw new Error("unreachable");
    expect(g.halt).toBe(h);
  });

  test("classification reads the kind, never the words", () => {
    // `surface.ts` makes the same promise about `haltKindOf`, for the same
    // reason: a classifier that matched on prose changes meaning every time
    // somebody rewords a string.
    const reworded = halt(HALT_NOT_VOUCHED_FOR, "Something else entirely", "no matching phrases here");
    expect(onboardingGate(reworded).kind).toBe("awaiting_vouch");
    const disguised = halt(HALT_CHAIN_WITHHELD, AWAITING_VOUCH.title, AWAITING_VOUCH.body);
    expect(onboardingGate(disguised).kind).toBe("halted");
  });
});

describe("the quarantine copy", () => {
  test("names Google, says held, and never says failed", () => {
    const all = `${QUARANTINE_HELD.title} ${QUARANTINE_HELD.body}`.toLowerCase();
    expect(all).toContain("google");
    expect(all).toContain("held");
    expect(all).not.toContain("failed");
    expect(all).not.toContain("error");
    expect(all).not.toContain("problem with");
    // It has to say the state is permanent, or the user waits for it to clear.
    expect(QUARANTINE_HELD.body.toLowerCase()).toContain("stays");
  });
});

// ---------------------------------------------------------------------------
// Step 2 — the ops
// ---------------------------------------------------------------------------

describe("homeCurrencyOps", () => {
  test("AED seeds the USD peg, in that order", () => {
    const ops = homeCurrencyOps("AED");
    expect(ops.map((o) => o.type)).toEqual(["home_currency_set", "rate_set"]);
    expect(ops[0]?.payload).toEqual({ currency: "AED" });
    expect(ops[1]?.payload).toEqual({ currency: "USD", rate_micro: "3672500" });
  });

  test("every other home currency seeds nothing", () => {
    for (const ccy of ["USD", "GBP", "SAR", "INR"]) {
      expect(homeCurrencyOps(ccy).map((o) => o.type)).toEqual(["home_currency_set"]);
    }
  });

  test("the rate is a decimal string, not a JSON number", () => {
    // `parseMoney` refuses a number outright: JSON.parse of one is a float64,
    // and a rate that rounds is a rate that re-values every conversion.
    const rate = homeCurrencyOps("AED")[1]?.payload as { rate_micro: unknown };
    expect(typeof rate.rate_micro).toBe("string");
    expect(rate.rate_micro).toBe(USD_PEG_MICRO.toString(10));
  });

  test("the code is normalised before it reaches the payload", () => {
    expect(homeCurrencyOps(" aed ")[0]?.payload).toEqual({ currency: "AED" });
    expect(homeCurrencyOps(" aed ").length).toBe(2);
  });

  test("an unusable code produces no ops at all", () => {
    for (const bad of ["", "AE", "AEDX", "1ED"]) expect(homeCurrencyOps(bad)).toEqual([]);
  });
});

describe("the ops, folded by the real replay engine", () => {
  test("every currency the picker offers folds cleanly", () => {
    // Two of everything: AED takes the seeding branch, the rest do not, and
    // both are checked for anomalies rather than only for the happy value.
    for (const c of COMMON_CURRENCIES) {
      const s = foldSpecs(homeCurrencyOps(c.code));
      expect(s.homeCurrency).toBe(c.code);
      expect(s.anomalies).toEqual([]);
    }
    expect(COMMON_CURRENCIES.length).toBeGreaterThan(3);
  });

  test("AED lands the peg as a real rate head, beside its own identity", () => {
    const s = foldSpecs(homeCurrencyOps("AED"));
    expect(s.rates.get("USD")).toBe(USD_PEG_MICRO);
    // `onHomeCurrencySet` installs the home currency's implicit identity rate
    // (§3.7:124), so "AED is present" proves nothing about the peg on its own.
    expect(s.rates.get("AED")).toBe(HOME_IDENTITY_MICRO);
    expect([...s.rates.keys()].sort()).toEqual(["AED", "USD"]);
  });

  test("a non-AED home seeds no FOREIGN rate — only its own identity", () => {
    const s = foldSpecs(homeCurrencyOps("GBP"));
    expect([...s.rates.keys()]).toEqual(["GBP"]);
    expect(s.rates.get("GBP")).toBe(HOME_IDENTITY_MICRO);
    expect(s.rates.has("USD")).toBe(false);
  });

  test("a second home_currency_set reaching the log is a home_currency_reset anomaly", () => {
    // Plan Task 14 Step 4: the client refuses it, and if one arrives anyway —
    // from another device, or from a build without the refusal — replay records
    // it rather than silently re-denominating. Asserted here so a change to
    // that behaviour fails in the task that depends on it.
    const s = foldSpecs([...homeCurrencyOps("AED"), ...homeCurrencyOps("USD")]);
    expect(s.homeCurrency).toBe("AED");
    expect(s.anomalies.map((a) => a.kind)).toContain("home_currency_reset");
  });
});

// ---------------------------------------------------------------------------
// Step 3 — the confirmation, and the seam under it
// ---------------------------------------------------------------------------

describe("confirmCopy", () => {
  test("echoes the currency in every line a user reads", () => {
    const c = confirmCopy("SAR");
    expect(c.title).toContain("SAR");
    expect(c.acknowledgement).toContain("SAR");
    expect(c.confirm).toContain("SAR");
  });

  test("says there is no way to change it, and names account deletion", () => {
    const body = confirmCopy("AED").consequence.toLowerCase();
    expect(body).toContain("no way to change this");
    expect(body).toContain("delete your account");
  });

  test("never promises a settings screen that will not exist", () => {
    // The one sentence this task must not contain. Checked against every
    // currency, because the copy is templated and a leak could hide in one arm.
    for (const c of [...COMMON_CURRENCIES.map((x) => x.code), "ZZZ"]) {
      const all = Object.values(confirmCopy(c)).join(" ").toLowerCase();
      expect(all).not.toContain("change this later");
      expect(all).not.toContain("in settings");
    }
  });

  test("the peg illustration appears for AED only, and is arithmetic rather than prose", () => {
    expect(pegIllustration("AED")).toBe("USD 100.00 is recorded as AED 367.25");
    for (const ccy of ["USD", "GBP", "SAR"]) expect(pegIllustration(ccy)).toBeNull();
  });
});

describe("homeCurrencyLock — the seam for NEEDS-SALEH §5 option (a)", () => {
  test("the rule this build ships is the spec's immutable one", () => {
    // Flipping this constant alone is NOT enough to adopt the softer rule:
    // `replay.applyHomeCurrencySet` records a `home_currency_reset` anomaly for
    // the second op regardless, and the Go executor mirrors it. The constant is
    // the client half of the change and this test is the reminder.
    expect(HOME_CURRENCY_RULE).toBe("immutable");
  });

  test("unset is changeable under either rule", () => {
    expect(homeCurrencyLock(null, 0, "immutable").changeable).toBe(true);
    expect(homeCurrencyLock(null, 0, "mutable_until_frozen").changeable).toBe(true);
  });

  test("immutable locks the moment it is set, frozen snapshots or not", () => {
    expect(homeCurrencyLock("AED", 0, "immutable")).toEqual({ changeable: false, reason: "immutable" });
    expect(homeCurrencyLock("AED", 12, "immutable")).toEqual({ changeable: false, reason: "immutable" });
  });

  test("mutable_until_frozen keys on the frozen count, and only on that", () => {
    expect(homeCurrencyLock("AED", 0, "mutable_until_frozen")).toEqual({
      changeable: true,
      reason: "nothing_frozen_yet",
    });
    expect(homeCurrencyLock("AED", 1, "mutable_until_frozen")).toEqual({ changeable: false, reason: "frozen" });
  });
});

describe("countFrozenSnapshots", () => {
  function txn(id: string, home: bigint | null): Txn {
    return {
      id,
      ingest_id: "",
      amount_minor: 100n,
      currency: "USD",
      direction: "debit",
      posted_at: "2026-08-02T10:00:00.000Z",
      merchant_raw: "m",
      last4: "",
      category: null,
      needs_review: false,
      unparsed: false,
      amount_home_minor: home,
      version: 1,
      superseded_by: null,
      deleted: false,
    } as unknown as Txn;
  }

  test("counts the rows that actually carry a home amount", () => {
    const s = emptyState();
    s.txns.set("a", txn("a", null));
    s.txns.set("b", txn("b", 36725n));
    s.txns.set("c", txn("c", null));
    // Measured from the rows themselves, not inferred from `pendingByCurrency`
    // — which is maintained by a different code path and would make the count
    // agree with itself by construction.
    expect(countFrozenSnapshots(s)).toBe(1);
    expect(countFrozenSnapshots(emptyState())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The picker's data
// ---------------------------------------------------------------------------

describe("normalizeCurrency", () => {
  test("accepts three letters in any case, with surrounding space", () => {
    expect(normalizeCurrency("aed")).toBe("AED");
    expect(normalizeCurrency(" Usd\n")).toBe("USD");
  });

  test("refuses anything else, and never returns a partial code", () => {
    for (const bad of ["", " ", "AE", "AEDX", "A1D", "A D", "AE€"]) {
      expect(normalizeCurrency(bad)).toBeNull();
    }
  });
});

describe("searchCurrencies", () => {
  test("an empty query is the whole list, in its curated order", () => {
    expect(searchCurrencies("")).toEqual([...COMMON_CURRENCIES]);
    expect(COMMON_CURRENCIES[0]?.code).toBe("AED");
  });

  test("matches on code and on name, case-insensitively", () => {
    expect(searchCurrencies("aed").map((c) => c.code)).toEqual(["AED"]);
    expect(searchCurrencies("dirham").map((c) => c.code)).toContain("AED");
    expect(searchCurrencies("POUND").map((c) => c.code)).toContain("GBP");
  });

  test("an unlisted but valid code is offered rather than refused", () => {
    // The list is a convenience, not the vocabulary: replay accepts any ISO
    // alpha-3, and a beta user whose currency is missing must not be stuck.
    const r = searchCurrencies("zwl");
    expect(r.map((c) => c.code)).toEqual(["ZWL"]);
  });

  test("a query that matches nothing and is not a code is empty", () => {
    expect(searchCurrencies("qqqq")).toEqual([]);
  });

  test("the list has no duplicates and every code is well formed", () => {
    const codes = COMMON_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of COMMON_CURRENCIES) {
      expect(normalizeCurrency(c.code)).toBe(c.code);
      expect(c.name.length).toBeGreaterThan(0);
    }
  });
});
