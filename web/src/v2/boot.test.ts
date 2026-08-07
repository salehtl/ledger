import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@ledger/client/net/client";
import type { SyncResult } from "@ledger/client/net/engine";
import type { State } from "@ledger/client/replay/state";
import { memSecretStore } from "@ledger/client/store/store";

import { boot, type BootDeps } from "./boot";
import { encodeLocal, loadLocalRecord, ONBOARDING_LOCAL_KEY } from "./onboarding";
import { EnrollmentError } from "./session";

const CLEAN: SyncResult = { pulled: 0, applied: 0, violations: [], halted: false };

function foldedState(over: Partial<Pick<State, "txns" | "homeCurrency">> = {}): Pick<
  State,
  "txns" | "homeCurrency"
> {
  return {
    txns: new Map([["t1", { posted_at: "2026-08-01T00:00:00Z" } as never]]),
    homeCurrency: "AED",
    ...over,
  } as Pick<State, "txns" | "homeCurrency">;
}

/** A device that has been all the way through onboarding on this browser. */
function settledSecrets() {
  const secrets = memSecretStore();
  secrets.set(
    ONBOARDING_LOCAL_KEY,
    JSON.stringify(
      encodeLocal({
        hasSession: true,
        accountId: "u_1",
        bank: "dib",
        inboundAddress: "u-abc@in.sirdab.ae",
        forwardingDeclared: true,
        firstMailConfirmedAt: "2026-08-01T00:00:00Z",
        homeCurrency: "AED",
        finishedAt: "2026-08-02T00:00:00Z",
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
    const state = await boot(deps({ secrets: memSecretStore(), address: async () => null }));
    expect(state.step).toBe("onboarding");
    if (state.step !== "onboarding") throw new Error("unreachable");
    expect(state.facts.bank).toBeNull();
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

  it("reports a hard stop as halted, with the engine's own reason and violations", async () => {
    const state = await boot(
      deps({
        haltReason: () => "I11_roster_checkpoint",
        sync: async () => ({
          pulled: 0,
          applied: 0,
          violations: [{ code: "I11_roster_checkpoint" } as never],
          halted: true,
        }),
      }),
    );
    expect(state.step).toBe("halted");
    if (state.step !== "halted") throw new Error("unreachable");
    expect(state.reason).toBe("I11_roster_checkpoint");
    expect(state.violations).toHaveLength(1);
  });

  it("still reports halted when the engine has no reason to give", async () => {
    const state = await boot(
      deps({ sync: async () => ({ pulled: 0, applied: 0, violations: [], halted: true }) }),
    );
    if (state.step !== "halted") throw new Error("expected halted");
    expect(state.reason).not.toBe("");
  });

  it("reports a thrown chain break as halted, never as a loading state or a fatal open", async () => {
    const state = await boot(deps({ sync: () => Promise.reject(new Error("chain break at seq 12")) }));
    expect(state.step).toBe("halted");
    if (state.step !== "halted") throw new Error("unreachable");
    expect(state.reason).toBe("chain break at seq 12");
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
