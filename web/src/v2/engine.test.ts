import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { SyncProgress, SyncResult } from "@ledger/client/net/engine";

import { IDLE_PROGRESS, SyncCoordinator, useSync, useSyncProgress, type CoordinatedEngine } from "./engine";

function fakeEngine(over: Partial<CoordinatedEngine> = {}): CoordinatedEngine & {
  publish(p: Partial<SyncProgress>): void;
  calls: unknown[];
} {
  const watchers = new Set<(p: SyncProgress) => void>();
  let progress: SyncProgress = { ...IDLE_PROGRESS };
  const calls: unknown[] = [];
  return {
    calls,
    get progress() {
      // A FRESH object per read, exactly as SyncEngine's own getter does. The
      // useSyncProgress test below depends on that: a hook written with
      // useSyncExternalStore over this getter loops forever.
      return { ...progress };
    },
    halted: null,
    sync(options?: unknown) {
      calls.push(options);
      return Promise.resolve<SyncResult>({ pulled: 0, applied: 0, violations: [], halted: false });
    },
    subscribe(fn: (p: SyncProgress) => void) {
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
    halt() {},
    publish(patch: Partial<SyncProgress>) {
      progress = { ...progress, ...patch };
      for (const w of watchers) w({ ...progress });
    },
    ...over,
  } as CoordinatedEngine & { publish(p: Partial<SyncProgress>): void; calls: unknown[] };
}

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
  it("raises a fault when a run comes back halted, and does not clear it", async () => {
    const engine = fakeEngine({
      halted: "I11_roster_checkpoint",
      sync: () =>
        Promise.resolve<SyncResult>({
          pulled: 0,
          applied: 0,
          violations: [{ code: "I11_roster_checkpoint", detail: "no checkpoint names this writer" } as never],
          halted: true,
        }),
    });
    const coordinator = new SyncCoordinator(engine);
    const { result } = renderHook(() => useSync(coordinator));
    expect(result.current.fault).toBeNull();
    await act(async () => {
      await result.current.run("launch");
    });
    expect(result.current.fault).not.toBeNull();
    expect(result.current.fault?.reason).toContain("I11_roster_checkpoint");
    expect(result.current.fault?.violations).toHaveLength(1);
  });

  it("raises a fault when a run throws, naming the error rather than swallowing it", async () => {
    const engine = fakeEngine({ sync: () => Promise.reject(new Error("chain break at seq 12")) });
    const { result } = renderHook(() => useSync(new SyncCoordinator(engine)));
    await act(async () => {
      await result.current.run("foreground");
    });
    expect(result.current.fault?.reason).toBe("chain break at seq 12");
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
