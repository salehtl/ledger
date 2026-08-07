import { describe, expect, it } from "vitest";

import { ApiError, HardStopError, NetworkError, ProtocolError } from "@ledger/client/net/client";
import { HALT_TAMPERED, HALT_UNCERTIFIED, HALT_UPDATE_REQUIRED } from "@ledger/client/invariants/surface";

import { classifySyncFailure, haltFromReason, haltFromViolations, isUnreachable } from "./halt";

describe("isUnreachable", () => {
  it("recognises the fetch rejection of every engine we ship to", () => {
    // Chrome/Edge, Safari, Firefox. All three are a TypeError from `fetch`.
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
    ]) {
      expect(isUnreachable(new TypeError(message))).toBe(true);
    }
  });

  it("recognises Client's own wrapper and an aborted request", () => {
    expect(isUnreachable(new NetworkError("POST /sync: connect", null))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isUnreachable(abort)).toBe(true);
  });

  it("does not swallow a real bug that happens to be a TypeError", () => {
    expect(isUnreachable(new TypeError("x.map is not a function"))).toBe(false);
  });

  it("counts a server that answered but could not serve", () => {
    // It ANSWERED, so no transport error is raised — but "come back in a
    // moment" is not a statement about anybody's records.
    for (const status of [500, 502, 503, 504]) {
      expect(isUnreachable(new ApiError(status, "unavailable", "", String(status)))).toBe(true);
    }
  });

  it("counts a captive portal, which answers 200 with HTML", () => {
    // The most likely real-world trigger of a false integrity alarm: hotel or
    // airport wifi. `Client` raises ProtocolError when JSON.parse fails.
    expect(isUnreachable(new ProtocolError("expected JSON, got text/html"))).toBe(true);
  });

  it("does NOT count a 4xx, which is this app's own bug to answer for", () => {
    for (const status of [400, 403, 404, 409, 422]) {
      expect(isUnreachable(new ApiError(status, "bad_request", "", String(status)))).toBe(false);
    }
  });

  it("is false for an integrity failure", () => {
    const chain = new Error("chain break at seq 12");
    chain.name = "ChainBreakError";
    expect(isUnreachable(chain)).toBe(false);
    expect(isUnreachable(null)).toBe(false);
  });

  it("is false for EVERY named failure the sync path can raise", () => {
    // The dangerous direction: an integrity failure slipping into the
    // unreachable set would be shown as a network problem and the app would
    // stay up over data the engine refused. Enumerated rather than trusted.
    expect(isUnreachable(new HardStopError([{ id: "I3_chain", severity: "hard_stop", detail: "x" }]))).toBe(false);
    for (const name of [
      "ChainBreakError",
      "UnknownNewerVersionError",
      "SyncHaltedError",
      "ReplayOrderError",
      "ProjectionCancelled",
      "AuditAbandoned",
      "OutboxStalledError",
      "SnapshotBindingError",
      "SnapshotDecodeError",
      "BlobDecodeError",
      "InvalidEnvelopeError",
    ]) {
      const error = new Error("whatever");
      error.name = name;
      expect(isUnreachable(error), name).toBe(false);
    }
  });
});

describe("classifySyncFailure", () => {
  it("calls a cold offline launch OFFLINE, not an integrity halt", () => {
    // The round-1 critical, pinned: this exact error produced a wall claiming
    // the integrity check had not passed and that reopening would not help.
    const failure = classifySyncFailure(new TypeError("Failed to fetch"), null);
    expect(failure.kind).toBe("offline");
  });

  it("calls an expired session a SESSION answer, not an integrity failure", () => {
    // Round 3: a 401 after boot used to reach the halt arm and put up a wall
    // with no sign-in route, which no retry could clear because every retry
    // 401s again.
    const failure = classifySyncFailure(new ApiError(401, "unauthorized", "", "401"), null);
    expect(failure.kind).toBe("session");
    if (failure.kind !== "session") throw new Error("unreachable");
    expect(failure.status).toBe(401);
    expect(failure.wipe).toBe(false);
  });

  it("calls a deleted account a session answer that WIPES", () => {
    const failure = classifySyncFailure(new ApiError(410, "account_deleted", "", "410"), null);
    if (failure.kind !== "session") throw new Error("expected session");
    expect(failure.wipe).toBe(true);
  });

  it("does not wipe on a bare 410 — the code is required as well as the status", () => {
    const failure = classifySyncFailure(new ApiError(410, "gone", "", "410"), null);
    expect(failure.kind).toBe("halt");
  });

  it("puts a session answer ahead of a halt in force", () => {
    // A 401 says nothing about anybody's records, and walling it off is the
    // one outcome the user cannot escape.
    const failure = classifySyncFailure(new ApiError(401, "unauthorized", "", "401"), "I3_chain");
    expect(failure.kind).toBe("session");
  });

  it("calls a restarting server offline rather than an integrity failure", () => {
    expect(classifySyncFailure(new ApiError(503, "unavailable", "", "503"), null).kind).toBe("offline");
  });

  it("calls a captive portal offline rather than an integrity failure", () => {
    expect(classifySyncFailure(new ProtocolError("expected JSON, got text/html"), null).kind).toBe("offline");
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
