import { describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "@ledger/client/net/client";
import { HALT_TAMPERED, HALT_UNCERTIFIED } from "@ledger/client/invariants/surface";
import type { SyncResult } from "@ledger/client/net/engine";
import type { State } from "@ledger/client/replay/state";
import { memSecretStore } from "@ledger/client/store/store";

import { boot, type BootDeps } from "./boot";
import { encodeLocal, loadLocalRecord, ONBOARDING_LOCAL_KEY } from "./onboarding";
import { EnrollmentError } from "./session";

const CLEAN: SyncResult = { pulled: 0, applied: 0, violations: [], halted: false };

function foldedState(over: Partial<Pick<State, "txns" | "homeCurrency" | "banks">> = {}): Pick<
  State,
  "txns" | "homeCurrency" | "banks"
> {
  return {
    txns: new Map([["t1", { posted_at: "2026-08-01T00:00:00Z" } as never]]),
    homeCurrency: "AED",
    // The declared banks are LOG state, exactly as the home currency is. This
    // is the whole of what device B inherits about them.
    banks: new Map([["dib", true]]),
    ...over,
  } as Pick<State, "txns" | "homeCurrency" | "banks">;
}

/**
 * A device that has been all the way through onboarding on this browser.
 *
 * The record is one field wide now — the address, and only as a resume hint.
 * Everything else about setup comes from the log or the server, which is what
 * makes {@link settledSecrets} and {@link memSecretStore} interchangeable for
 * an account that is actually set up.
 */
function settledSecrets() {
  const secrets = memSecretStore();
  secrets.set(
    ONBOARDING_LOCAL_KEY,
    JSON.stringify(
      encodeLocal({
        hasSession: true,
        accountId: "u_1",
        keysReady: true,
        banks: ["dib"],
        inboundAddress: "u-abc@in.sirdab.ae",
        forwardingDeclared: true,
        firstMailConfirmedAt: "2026-08-01T00:00:00Z",
        homeCurrency: "AED",
        setupSeen: true,
      }),
    ),
  );
  return secrets;
}

function deps(over: Partial<BootDeps> = {}): BootDeps & { order: string[] } {
  const order: string[] = [];
  const base: BootDeps = {
    signedIn: () => true,
    userId: () => "u_1",
    enrol: async () => {
      order.push("enrol");
    },
    sync: async () => {
      order.push("sync");
      return CLEAN;
    },
    haltReason: () => null,
    state: () => foldedState(),
    address: async () => {
      order.push("address");
      return "u-abc@in.sirdab.ae";
    },
    keysReady: async () => {
      order.push("keysReady");
      return true;
    },
    secrets: settledSecrets(),
    wipe: async () => {
      order.push("wipe");
    },
    clearSession: () => {
      order.push("clearSession");
    },
  };
  return Object.assign(base, over, { order });
}

describe("boot", () => {
  it("is signed_out with no session, and asks the server nothing", async () => {
    const d = deps({ signedIn: () => false });
    expect(await boot(d)).toEqual({ step: "signed_out" });
    expect(d.order).toEqual([]);
  });

  it("reaches ready for a device that has finished onboarding", async () => {
    const state = await boot(deps());
    expect(state.step).toBe("ready");
    if (state.step !== "ready") throw new Error("unreachable");
    expect(state.userId).toBe("u_1");
    expect(state.facts.homeCurrency).toBe("AED");
  });

  it("enrols BEFORE the first sync — the sync is the first thing that reads writerId", async () => {
    const d = deps();
    await boot(d);
    expect(d.order.indexOf("enrol")).toBeLessThan(d.order.indexOf("sync"));
  });

  it("routes an incomplete device to onboarding with the facts it has", async () => {
    // No address could be minted, so the walk stops there — but the facts the
    // LOG carries come through regardless of what this device remembers.
    const state = await boot(deps({ secrets: memSecretStore(), address: async () => null }));
    expect(state.step).toBe("onboarding");
    if (state.step !== "onboarding") throw new Error("unreachable");
    expect(state.facts.banks).toEqual(["dib"]);
    expect(state.facts.inboundAddress).toBeNull();
    expect(state.facts.homeCurrency).toBe("AED");
  });

  // -- the half-signed-in repair -------------------------------------------

  it("REPAIRS a device left signed in with no writer: enrolment runs at boot and the app becomes usable", async () => {
    // Exactly the state Task 5's `ceremony` can strand a user in — the session
    // was persisted, then the network dropped before `POST /writers/challenge`.
    // Nothing in `initV2` fixes it, so `boot` has to.
    let enrolled = false;
    const d = deps({
      enrol: async () => {
        enrolled = true;
      },
    });
    const state = await boot(d);
    expect(enrolled).toBe(true);
    expect(state.step).toBe("ready");
  });

  it("stops at a visible, retryable wall when the repair itself fails", async () => {
    const d = deps({
      enrol: () => Promise.reject(new EnrollmentError("offline", "no connection")),
    });
    const state = await boot(d);
    expect(state.step).toBe("unenrolled");
    if (state.step !== "unenrolled") throw new Error("unreachable");
    expect(state.copy.retry).toBe(true);
    expect(state.copy.title).toMatch(/could not finish setting up/i);
    // And it never proceeds to a sync that would fail on "no writer selected".
    expect(d.order).not.toContain("sync");
  });

  it("says so honestly, and does not offer a retry, when the server refused this device", async () => {
    const state = await boot(deps({ enrol: () => Promise.reject(new EnrollmentError("rejected", "403")) }));
    if (state.step !== "unenrolled") throw new Error("expected unenrolled");
    expect(state.copy.retry).toBe(false);
  });

  it("treats a 401 raised while enrolling as a session answer, not an enrolment one", async () => {
    // `ensureDeviceWriter` lets 401/410 past unwrapped precisely so this works.
    const d = deps({ enrol: () => Promise.reject(new ApiError(401, "unauthorized", "", "401")) });
    expect(await boot(d)).toEqual({ step: "signed_out" });
    expect(d.order).toContain("clearSession");
  });

  it("refuses to report signed_out when the wipe did not complete", async () => {
    // A half-wipe leaves the deleted account's log under the same fixed
    // database name. Reporting signed_out would land the browser on a
    // clean-looking sign-in over it.
    const d = deps({
      enrol: () => Promise.reject(new ApiError(410, "account_deleted", "", "410")),
      wipe: () => Promise.reject(new Error("another ledger tab still has the local database open")),
    });
    const state = await boot(d);
    expect(state.step).toBe("fatal");
    if (state.step !== "fatal") throw new Error("unreachable");
    expect(state.error.message).toMatch(/could not finish removing its data/i);
    expect(state.error.message).toMatch(/another ledger tab/i);
  });

  it("wipes local data on 410 account_deleted, and on nothing else", async () => {
    const gone = deps({ enrol: () => Promise.reject(new ApiError(410, "account_deleted", "", "410")) });
    expect(await boot(gone)).toEqual({ step: "signed_out" });
    expect(gone.order).toContain("wipe");

    // A bare 410 without the code must NOT wipe: a body is the part an
    // intermediary can most easily rewrite.
    const bare = deps({ enrol: () => Promise.reject(new ApiError(410, "gone", "", "410")) });
    const state = await boot(bare);
    expect(bare.order).not.toContain("wipe");
    expect(state.step).toBe("fatal");
  });

  // -- halts ----------------------------------------------------------------

  it("reports a hard stop as halted, classified by its violation", async () => {
    const state = await boot(
      deps({
        haltReason: () => "I3_chain",
        sync: async () => ({
          pulled: 0,
          applied: 0,
          violations: [{ id: "I3_chain", severity: "hard_stop", detail: "spliced at seq 12" } as never],
          halted: true,
        }),
      }),
    );
    expect(state.step).toBe("halted");
    if (state.step !== "halted") throw new Error("unreachable");
    expect(state.halt.kind).toBe(HALT_TAMPERED);
    expect(state.halt.violations).toHaveLength(1);
    expect(state.halt.dismissable).toBe(false);
  });

  it("still reports halted when the engine has no violation to give", async () => {
    const state = await boot(
      deps({ sync: async () => ({ pulled: 0, applied: 0, violations: [], halted: true }) }),
    );
    if (state.step !== "halted") throw new Error("expected halted");
    expect(state.halt.kind).toBe(HALT_UNCERTIFIED);
  });

  it("reports a thrown chain break as halted, never as a loading state or a fatal open", async () => {
    const broken = new Error("chain break at seq 12");
    broken.name = "ChainBreakError";
    const state = await boot(deps({ sync: () => Promise.reject(broken) }));
    expect(state.step).toBe("halted");
    if (state.step !== "halted") throw new Error("unreachable");
    expect(state.halt.kind).toBe(HALT_TAMPERED);
    expect(state.halt.violations[0]?.detail).toContain("seq 12");
  });

  // -- offline is not a halt (round-1 critical 1) ---------------------------

  it("OPENS THE APP when the launch sync could not reach the server", async () => {
    // The round-1 defect, pinned. `SyncEngine` rethrows a transport failure
    // with phase "halted", and boot used to render that as an integrity wall
    // claiming the check had not passed and that reopening would not help.
    // Both false: the projection is local and fully readable.
    const state = await boot(deps({ sync: () => Promise.reject(new TypeError("Failed to fetch")) }));
    expect(state.step).toBe("ready");
    if (state.step !== "ready") throw new Error("unreachable");
    expect(state.offline).toBe(true);
    expect(state.facts.homeCurrency).toBe("AED");
  });

  it("treats Client's own NetworkError the same way", async () => {
    const state = await boot(deps({ sync: () => Promise.reject(new NetworkError("POST /sync", null)) }));
    expect(state.step).toBe("ready");
  });

  it("records a reachable server as not offline", async () => {
    const state = await boot(deps());
    if (state.step !== "ready") throw new Error("expected ready");
    expect(state.offline).toBe(false);
  });

  it("still halts on a transport failure once a halt is already in force", async () => {
    // A halted engine refuses the next sync outright; reporting that refusal as
    // "offline" would put the app back over data it has stopped standing behind.
    const state = await boot(
      deps({ haltReason: () => "I3_chain", sync: () => Promise.reject(new TypeError("Failed to fetch")) }),
    );
    expect(state.step).toBe("halted");
  });

  it("SAYS SO rather than restarting onboarding when it is offline and setup cannot be read", async () => {
    // This reverses an earlier behaviour deliberately. When the device-local
    // record was the source of truth for setup, "offline with nothing local"
    // meant "a new device", and onboarding was the right answer. Configuration
    // now lives in the log, so the same situation means "ledger could not fetch
    // this account's setup" — and walking a working account back to the address
    // step looks exactly like data loss.
    const state = await boot(
      deps({
        secrets: memSecretStore(),
        address: async () => null,
        state: () => ({ txns: new Map(), homeCurrency: null, banks: new Map() }) as never,
        sync: () => Promise.reject(new TypeError("Failed to fetch")),
      }),
    );
    expect(state.step).toBe("config_unavailable");
  });

  it("does not wall a device that IS set up just because it is offline", async () => {
    const state = await boot(
      deps({ secrets: memSecretStore(), sync: () => Promise.reject(new TypeError("Failed to fetch")) }),
    );
    expect(state.step).toBe("ready");
  });

  // -- a second device ------------------------------------------------------

  /**
   * THE TEST THAT MATTERS.
   *
   * Device A finished onboarding. Device B is this browser: signed in, enrolled,
   * and holding NOTHING locally — no onboarding record at all. It must land in
   * the product on the same address and the same banks, because every one of
   * those facts is in the log or on the server. Anything else is a working
   * account being asked to set itself up again.
   */
  it("lands a SECOND DEVICE with empty local storage straight in the app, with the same address and banks", async () => {
    const state = await boot(
      deps({
        secrets: memSecretStore(),
        state: () => foldedState({ banks: new Map([["dib", true], ["enbd", true], ["adcb", false]]) }),
      }),
    );
    expect(state.step).toBe("ready");
    if (state.step !== "ready") throw new Error("unreachable");
    expect(state.facts.inboundAddress).toBe("u-abc@in.sirdab.ae");
    // The retired one is not inherited as declared — `active: false` is the
    // user's removal, and it has to survive the trip to a new device.
    expect([...state.facts.banks]).toEqual(["dib", "enbd"]);
  });

  it("routes a second device to onboarding only where the LOG is genuinely short of a fact", async () => {
    // Not a device-local question: the account has no bank declared anywhere, so
    // the bank step is the honest answer even on a device that has synced.
    const state = await boot(
      deps({ secrets: memSecretStore(), state: () => foldedState({ banks: new Map() }) }),
    );
    expect(state.step).toBe("onboarding");
    if (state.step !== "onboarding") throw new Error("unreachable");
    expect(state.facts.banks).toEqual([]);
  });

  // -- the address ----------------------------------------------------------

  it("does not walk a settled device back through onboarding when the address read fails", async () => {
    const state = await boot(deps({ address: () => Promise.reject(new Error("offline")) }));
    expect(state.step).toBe("ready");
    if (state.step !== "ready") throw new Error("unreachable");
    expect(state.facts.inboundAddress).toBe("u-abc@in.sirdab.ae");
  });

  it("caches a freshly minted address so the NEXT offline boot resumes correctly", async () => {
    const secrets = memSecretStore();
    await boot(deps({ secrets, address: async () => "u-new@in.sirdab.ae" }));
    expect(loadLocalRecord(secrets)?.inboundAddress).toBe("u-new@in.sirdab.ae");
  });

  it("still honours a 401 from the address read", async () => {
    const d = deps({ address: () => Promise.reject(new ApiError(401, "unauthorized", "", "401")) });
    expect(await boot(d)).toEqual({ step: "signed_out" });
  });

  // -- fatals ---------------------------------------------------------------

  it("is fatal, not a crash, when the client cannot say who it is", async () => {
    const state = await boot(
      deps({
        userId: () => {
          throw new Error("no session");
        },
      }),
    );
    expect(state.step).toBe("fatal");
  });

  it("never rejects, whatever the deps do", async () => {
    const spy = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(boot(deps({ state: spy as never }))).resolves.toMatchObject({ step: "fatal" });
  });
});
