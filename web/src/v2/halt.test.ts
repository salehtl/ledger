import { describe, expect, it } from "vitest";

import { NetworkError } from "@ledger/client/net/client";
import { HALT_TAMPERED, HALT_UNCERTIFIED, HALT_UPDATE_REQUIRED } from "@ledger/client/invariants/surface";

import { classifySyncFailure, haltFromReason, haltFromViolations, isTransportFailure } from "./halt";

describe("isTransportFailure", () => {
  it("recognises the fetch rejection of every engine we ship to", () => {
    // Chrome/Edge, Safari, Firefox. All three are a TypeError from `fetch`.
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(isTransportFailure(new TypeError(message))).toBe(true);
    }
  });

  it("recognises Client's own wrapper and an aborted request", () => {
    expect(isTransportFailure(new NetworkError("POST /sync: connect", null))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isTransportFailure(abort)).toBe(true);
  });

  it("does not swallow a real bug that happens to be a TypeError", () => {
    expect(isTransportFailure(new TypeError("x.map is not a function"))).toBe(false);
  });

  it("is false for an integrity failure", () => {
    const chain = new Error("chain break at seq 12");
    chain.name = "ChainBreakError";
    expect(isTransportFailure(chain)).toBe(false);
    expect(isTransportFailure(null)).toBe(false);
  });
});

describe("classifySyncFailure", () => {
  it("calls a cold offline launch OFFLINE, not an integrity halt", () => {
    // The round-1 critical, pinned: this exact error produced a wall claiming
    // the integrity check had not passed and that reopening would not help.
    const failure = classifySyncFailure(new TypeError("Failed to fetch"), null);
    expect(failure.kind).toBe("offline");
  });

  it("refuses to call anything offline while a halt is in force", () => {
    // Once halted, SyncEngine rejects the next sync with a SyncHaltedError, and
    // reporting that as "offline" would put the app back over untrusted data.
    const failure = classifySyncFailure(new TypeError("Failed to fetch"), "I3_chain");
    expect(failure.kind).toBe("halt");
  });

  it("names the CLASS of a chain break, in the library's words", () => {
    const chain = new Error("chain break at seq 12");
    chain.name = "ChainBreakError";
    const failure = classifySyncFailure(chain, null);
    if (failure.kind !== "halt") throw new Error("expected halt");
    expect(failure.halt.kind).toBe(HALT_TAMPERED);
    expect(failure.halt.title).toMatch(/doesn't match its own record/i);
    // And it never claims there is nothing to be done.
    expect(failure.halt.action).not.toBeNull();
  });

  it("routes a build that is too old to the update halt, not to tampering", () => {
    const old = new Error("op schema version 9 is newer than this build");
    old.name = "UnknownNewerVersionError";
    const failure = classifySyncFailure(old, null);
    if (failure.kind !== "halt") throw new Error("expected halt");
    expect(failure.halt.kind).toBe(HALT_UPDATE_REQUIRED);
  });

  it("files an unrecognised error as uncertified, whose copy is honest about not knowing", () => {
    const failure = classifySyncFailure(new Error("something nobody has seen"), null);
    if (failure.kind !== "halt") throw new Error("expected halt");
    expect(failure.halt.kind).toBe(HALT_UNCERTIFIED);
    expect(failure.halt.body).toMatch(/still readable/i);
  });

  it("never produces a halt that a screen could render as dismissable", () => {
    const failure = classifySyncFailure(new Error("x"), null);
    if (failure.kind !== "halt") throw new Error("expected halt");
    expect(failure.halt.dismissable).toBe(false);
    expect(failure.halt.syncStopped).toBe(true);
  });
});

describe("haltFromViolations", () => {
  it("classifies by the violation, not by the reason string", () => {
    const halt = haltFromViolations([{ id: "I3_chain", severity: "hard_stop", detail: "spliced" }], "whatever");
    expect(halt.kind).toBe(HALT_TAMPERED);
    expect(halt.violations).toHaveLength(1);
  });

  it("falls back to the reason when a halt carried no violations", () => {
    const halt = haltFromViolations([], "halted by the integrity screen");
    expect(halt.kind).toBe(HALT_UNCERTIFIED);
    expect(halt.violations[0]?.detail).toBe("halted by the integrity screen");
  });

  it("ranks update_required above a co-occurring tamper stop", () => {
    // HALT_ORDER's reason: a build that cannot read the newer half of the log
    // may be producing every other stop as a side effect.
    const halt = haltFromViolations(
      [
        { id: "I3_chain", severity: "hard_stop", detail: "spliced" },
        { id: "I6_schema_version", severity: "hard_stop", detail: "v9" },
      ],
      "",
    );
    expect(halt.kind).toBe(HALT_UPDATE_REQUIRED);
  });
});

describe("haltFromReason", () => {
  it("carries the reason as the detail rather than as the title", () => {
    const halt = haltFromReason("chain break at seq 12");
    expect(halt.title).not.toContain("seq 12");
    expect(halt.violations[0]?.detail).toBe("chain break at seq 12");
  });
});
