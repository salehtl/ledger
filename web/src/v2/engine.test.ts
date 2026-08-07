import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { SyncResult } from "@ledger/client/net/engine";

import { ApiError } from "@ledger/client/net/client";
import { HALT_TAMPERED, HALT_UNCERTIFIED } from "@ledger/client/invariants/surface";

// The shared double, which publishes `halted` BEFORE it rethrows exactly as
// `SyncEngine.run` does. Round 1's local rig did not, and a bug lived in that
// gap — see `src/test/engineDouble.ts`.
import { fakeEngine } from "../test/engineDouble";
import { IDLE_PROGRESS, SyncCoordinator, useSync, useSyncProgress } from "./engine";

describe("SyncCoordinator", () => {
  it("joins every trigger kind onto the engine's one in-flight promise", () => {
    let calls = 0;
    let resolve!: (r: SyncResult) => void;
    const pending = new Promise<SyncResult>((done) => {
      resolve = done;
    });
    const engine = fakeEngine({
      sync: () => {
        if (calls === 0) calls++;
        return pending;
      },
    });
    const coordinator = new SyncCoordinator(engine);
    const runs = (["launch", "foreground", "refresh", "notification", "retry"] as const).map((t) =>
      coordinator.run(t),
    );
    expect(runs.every((r) => r === pending)).toBe(true);
    expect(calls).toBe(1);
    resolve({ pulled: 0, applied: 0, violations: [], halted: false });
  });

  it("forwards a trigger's sync options unchanged, by identity", async () => {
    const engine = fakeEngine();
    const coordinator = new SyncCoordinator(engine);
    const options = { stream: "cold" as const, push: false };
    await coordinator.run("refresh", options);
    expect(engine.calls).toEqual([options]);
    expect(engine.calls[0]).toBe(options);
  });

  it("calls sync() with no argument at all when the trigger carries no options", async () => {
    const engine = fakeEngine();
    await new SyncCoordinator(engine).run("launch");
    expect(engine.calls).toEqual([undefined]);
  });

  it("passes the engine's halt reason through", () => {
    const coordinator = new SyncCoordinator(fakeEngine({ halted: "chain break at seq 12" }));
    expect(coordinator.haltReason).toBe("chain break at seq 12");
  });

  it("stamps the time a sync COMPLETED, so Settings can say when the ledger last moved", async () => {
    const coordinator = new SyncCoordinator(fakeEngine(), () => 1_700_000_000_000);
    expect(coordinator.lastCompletedAt).toBeNull();
    await coordinator.run("launch");
    expect(coordinator.lastCompletedAt).toBe(1_700_000_000_000);
  });

  it("does not stamp a halted sync — a run that stopped is not a run that landed", async () => {
    const halted: SyncResult = { pulled: 0, applied: 0, violations: [], halted: true };
    const coordinator = new SyncCoordinator(fakeEngine({ sync: async () => halted }), () => 1);
    await coordinator.run("launch");
    expect(coordinator.lastCompletedAt).toBeNull();
  });

  it("does not stamp a sync that threw, and does not raise an unhandled rejection", async () => {
    const coordinator = new SyncCoordinator(
      fakeEngine({ sync: () => Promise.reject(new Error("offline")) }),
      () => 1,
    );
    await expect(coordinator.run("launch")).rejects.toThrow("offline");
    expect(coordinator.lastCompletedAt).toBeNull();
  });
});

describe("useSyncProgress", () => {
  it("re-renders on a progress event", () => {
    const engine = fakeEngine();
    const coordinator = new SyncCoordinator(engine);
    const { result } = renderHook(() => useSyncProgress(coordinator));
    expect(result.current.phase).toBe("idle");
    act(() => {
      engine.publish({ phase: "folding", opsApplied: 42 });
    });
    expect(result.current.phase).toBe("folding");
    expect(result.current.opsApplied).toBe(42);
  });

  it("picks up progress published before the subscription landed", () => {
    const engine = fakeEngine();
    engine.publish({ phase: "pulling", rowsPulled: 7 });
    const { result } = renderHook(() => useSyncProgress(new SyncCoordinator(engine)));
    expect(result.current).toMatchObject({ phase: "pulling", rowsPulled: 7 });
  });

  it("unsubscribes on unmount", () => {
    const engine = fakeEngine();
    const { unmount } = renderHook(() => useSyncProgress(new SyncCoordinator(engine)));
    unmount();
    // No listener left, so publishing must not reach a torn-down component —
    // which React would report as a warning rather than a failure, so assert
    // the subscription bookkeeping directly.
    expect(() => {
      engine.publish({ phase: "idle" });
    }).not.toThrow();
  });

  it("reports idle for a null coordinator, so a pre-boot render has a shape", () => {
    const { result } = renderHook(() => useSyncProgress(null));
    expect(result.current).toEqual(IDLE_PROGRESS);
  });
});

describe("useSync", () => {
  it("republishes the coordinator's last-completed stamp, so a screen re-renders when it moves", async () => {
    const coordinator = new SyncCoordinator(fakeEngine(), () => 1_700_000_000_000);
    const { result } = renderHook(() => useSync(coordinator));
    expect(result.current.lastCompletedAt).toBeNull();
    await act(async () => {
      await result.current.run("refresh");
    });
    expect(result.current.lastCompletedAt).toBe(1_700_000_000_000);
  });

  it("raises a fault when a run comes back halted, classified by its violation", async () => {
    const engine = fakeEngine({
      halted: "I3_chain",
      sync: () =>
        Promise.resolve<SyncResult>({
          pulled: 0,
          applied: 0,
          violations: [{ id: "I3_chain", severity: "hard_stop", detail: "spliced" } as never],
          halted: true,
        }),
    });
    const coordinator = new SyncCoordinator(engine);
    const { result } = renderHook(() => useSync(coordinator));
    expect(result.current.fault).toBeNull();
    await act(async () => {
      await result.current.run("launch");
    });
    expect(result.current.fault?.kind).toBe(HALT_TAMPERED);
    expect(result.current.fault?.violations).toHaveLength(1);
  });

  it("raises a fault when a run throws an integrity failure", async () => {
    const broken = new Error("chain break at seq 12");
    broken.name = "ChainBreakError";
    const engine = fakeEngine({ sync: () => Promise.reject(broken) });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine)));
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault?.kind).toBe(HALT_TAMPERED);
  });

  // -- round-1 critical 2: a fault must not be permanent --------------------

  it("does NOT raise a fault when the run simply could not reach the server", async () => {
    const engine = fakeEngine({ sync: () => Promise.reject(new TypeError("Failed to fetch")) });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine)));
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).toBeNull();
    // And the engine HAS left the phase on `halted`, because that is what the
    // real one does before rethrowing. Anything reading the phase alone would
    // conclude the records failed a check; the fault is null precisely so it
    // cannot. This assertion is the tripwire for round 2's NEW-1.
    expect(result.current.progress.phase).toBe("halted");
  });

  it("clears the fault once a sync completes, so coming back online recovers", async () => {
    let halted = true;
    const engine = fakeEngine({
      sync: () =>
        Promise.resolve<SyncResult>(
          halted
            ? { pulled: 0, applied: 0, violations: [], halted: true }
            : { pulled: 0, applied: 0, violations: [], halted: false },
        ),
    });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine)));
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault?.kind).toBe(HALT_UNCERTIFIED);

    halted = false;
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).toBeNull();
  });

  it("does not let an offline blip clear a fault that is already standing", async () => {
    let mode: "halt" | "offline" = "halt";
    const engine = fakeEngine({
      sync: () =>
        mode === "halt"
          ? Promise.resolve<SyncResult>({ pulled: 0, applied: 0, violations: [], halted: true })
          : Promise.reject(new TypeError("Failed to fetch")),
    });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine)));
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).not.toBeNull();

    mode = "offline";
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).not.toBeNull();
  });

  it("reports an expired session to the caller instead of raising a wall", async () => {
    const engine = fakeEngine({ sync: () => Promise.reject(new ApiError(401, "unauthorized", "", "401")) });
    const seen: { status: number; wipe: boolean }[] = [];
    const { result } = renderHook(() =>
      useSync(new SyncCoordinator(engine), { onSessionEnded: (f) => seen.push(f) }),
    );
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).toBeNull();
    expect(seen).toEqual([{ status: 401, wipe: false }]);
  });

  it("reports a deleted account as a session answer that wipes", async () => {
    const engine = fakeEngine({ sync: () => Promise.reject(new ApiError(410, "account_deleted", "", "410")) });
    const seen: { status: number; wipe: boolean }[] = [];
    const { result } = renderHook(() =>
      useSync(new SyncCoordinator(engine), { onSessionEnded: (f) => seen.push(f) }),
    );
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).toBeNull();
    expect(seen).toEqual([{ status: 410, wipe: true }]);
  });

  it("clears a standing fault when the session turns out to be the problem", async () => {
    let mode: "halt" | "expired" = "halt";
    const engine = fakeEngine({
      sync: () =>
        mode === "halt"
          ? Promise.resolve<SyncResult>({ pulled: 0, applied: 0, violations: [], halted: true })
          : Promise.reject(new ApiError(401, "unauthorized", "", "401")),
    });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine), { onSessionEnded: () => {} }));
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault).not.toBeNull();

    mode = "expired";
    await act(async () => {
      await result.current.run("foreground");
    });
    // The wall must come down: the caller is about to route to sign-in, and a
    // halt left standing would render over it.
    expect(result.current.fault).toBeNull();
  });

  it("clear() drops the fault, for a caller re-running boot from the top", async () => {
    const engine = fakeEngine({
      sync: () => Promise.resolve<SyncResult>({ pulled: 0, applied: 0, violations: [], halted: true }),
    });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine)));
    await act(async () => {
      await result.current.run("launch");
    });
    expect(result.current.fault).not.toBeNull();
    act(() => {
      result.current.clear();
    });
    expect(result.current.fault).toBeNull();
  });

  it("runs a foreground sync when the document becomes visible, and not when it hides", async () => {
    const engine = fakeEngine();
    const coordinator = new SyncCoordinator(engine);
    renderHook(() => useSync(coordinator));

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(engine.calls).toHaveLength(0);

    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(engine.calls).toHaveLength(1);
  });

  it("stops listening for visibility once unmounted", async () => {
    const engine = fakeEngine();
    const { unmount } = renderHook(() => useSync(new SyncCoordinator(engine)));
    unmount();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(engine.calls).toHaveLength(0);
  });
});
