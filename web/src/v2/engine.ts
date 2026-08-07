/**
 * The sync engine as the PWA drives it: one coordinator, three triggers, and
 * one fault that takes the whole screen.
 *
 * # The coordinator is a port, and deliberately thin
 *
 * {@link SyncCoordinator} is `app/src/sync/coordinator.ts` almost verbatim. It
 * holds no policy: {@link SyncEngine} already owns the `isRunning` guard that
 * turns five taps into one page sequence (rule 3 of its module doc), and a
 * coordinator that re-implemented debouncing on top would be a second guard
 * that can disagree with the first. What it adds is a *vocabulary* — a
 * {@link SyncTrigger} names why a sync is happening — so every call site in the
 * app goes through one door and a future per-trigger policy has somewhere to
 * live.
 *
 * Two deliberate additions over the native port:
 *
 *  - {@link SyncCoordinator.haltReason}, because the web gate has to render the
 *    reason and `CoordinatedEngine` otherwise had no way to say it.
 *  - {@link SyncStatus.fault} and {@link useSync}, because a browser tab has no
 *    equivalent of the native app's crash reporter: a rejected `sync()` with
 *    nobody awaiting it is an unhandled rejection in the console and a UI that
 *    looks like it is still loading.
 *
 * # Why `useSyncProgress` is not `useSyncExternalStore`
 *
 * `SyncEngine.progress` is `{ ...this.p }` — a FRESH object on every read, on
 * purpose, so a caller cannot mutate the engine's state. `useSyncExternalStore`
 * compares snapshots by `Object.is` and would therefore see a change on every
 * render and loop forever ("The result of getSnapshot should be cached").
 * Subscribing into `useState` keeps the identity that React needs pinned to the
 * events the engine actually published.
 *
 * # A halt is never a loading state
 *
 * `phase: "halted"` means the invariant checker found a chain break or a roster
 * problem, or the fold hit something it refuses to apply. It is the one sync
 * outcome that must never render as a spinner, and {@link useSync} raises it as
 * a {@link Halt} — see `BootGate.tsx`, which puts it full-screen and
 * non-dismissable.
 *
 * **The phase alone cannot make that call.** `SyncEngine` publishes the same
 * `halted` for a transport failure, so `halt.ts` classifies the throw first; a
 * sync that simply could not reach the server is not a verdict about anybody's
 * records. Round 1 of this task got that wrong in both directions at once — see
 * {@link SyncStatus.fault}.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SyncEngine, type SyncOptions, type SyncProgress, type SyncResult } from "@ledger/client/net/engine";
import type { Halt } from "@ledger/client/invariants/surface";

import { classifySyncFailure, haltFromViolations, HALT_WITHOUT_REASON } from "./halt";
import type { V2Handle } from "./session";

/** The shape a sync-less render still has to have. */
export const IDLE_PROGRESS: SyncProgress = {
  phase: "idle",
  rowsPulled: 0,
  rowsTotal: null,
  opsApplied: 0,
  chunk: 0,
};

export type SyncTrigger = "launch" | "foreground" | "refresh" | "notification" | "retry";

export interface CoordinatedEngine {
  readonly progress: SyncProgress;
  /** Non-null once a halt is in force. `SyncEngine.halted`. */
  readonly halted: string | null;
  sync(options?: SyncOptions): Promise<SyncResult>;
  subscribe(listener: (progress: SyncProgress) => void): () => void;
  halt(reason: string): void;
}

/** The only app-level entry point for synchronization triggers. */
export class SyncCoordinator {
  constructor(private readonly engine: CoordinatedEngine) {}

  get progress(): SyncProgress {
    return this.engine.progress;
  }

  get haltReason(): string | null {
    return this.engine.halted;
  }

  subscribe(listener: (progress: SyncProgress) => void): () => void {
    return this.engine.subscribe(listener);
  }

  run(_trigger: SyncTrigger, options?: SyncOptions): Promise<SyncResult> {
    // `sync()` and `sync(undefined)` are the same call to the engine, but not
    // to a test that asserts on the argument list, and the native port made
    // this distinction deliberately. Kept.
    return options === undefined ? this.engine.sync() : this.engine.sync(options);
  }

  halt(reason: string): void {
    this.engine.halt(reason);
  }
}

/**
 * The engine for a signed-in handle.
 *
 * Called **after** sign-in and never before: {@link V2Handle.client} is a
 * getter that hands back a NEW `Client` once a ceremony has adopted a session,
 * and `SyncEngine` reads it once in its constructor. An engine built at boot on
 * a signed-out handle would keep syncing as nobody for the rest of the tab's
 * life. `BootGate` is the only caller, and it only reaches this once the boot
 * state says there is a session.
 */
export function startEngine(h: V2Handle): SyncCoordinator {
  return new SyncCoordinator(new SyncEngine(h.client, h.driver));
}

/**
 * Field-by-field, because every snapshot is a fresh object.
 *
 * This is not a micro-optimisation, it is what stops a render loop: the engine
 * publishes a new object per event and a caller that rebuilds its coordinator
 * on every render (which is what `<Hook coordinator={new SyncCoordinator(…)} />`
 * does, and what an inline `startEngine(h)` in a component body would do) would
 * otherwise get effect → setState → render → new coordinator → effect, forever.
 * Bailing on an equal value breaks the cycle at the setState.
 */
function sameProgress(a: SyncProgress, b: SyncProgress): boolean {
  return (
    a.phase === b.phase &&
    a.rowsPulled === b.rowsPulled &&
    a.rowsTotal === b.rowsTotal &&
    a.opsApplied === b.opsApplied &&
    a.chunk === b.chunk
  );
}

/**
 * The engine's progress, re-rendered as it publishes.
 *
 * `null` is a legal argument and reports {@link IDLE_PROGRESS}: the gate
 * renders before an engine exists, and a hook that threw there would force
 * every caller to branch around it.
 */
export function useSyncProgress(coordinator: SyncCoordinator | null): SyncProgress {
  const [progress, setProgress] = useState<SyncProgress>(() => coordinator?.progress ?? IDLE_PROGRESS);

  useEffect(() => {
    const put = (next: SyncProgress): void => {
      setProgress((held) => (sameProgress(held, next) ? held : next));
    };
    if (coordinator === null) {
      put(IDLE_PROGRESS);
      return;
    }
    // Read once before subscribing: anything the engine published between the
    // render that captured the initial state and this effect would otherwise
    // be lost, and on a fast launch that is the entire first sync.
    put(coordinator.progress);
    return coordinator.subscribe(put);
  }, [coordinator]);

  return progress;
}

export interface SyncStatus {
  progress: SyncProgress;
  /**
   * Non-null once a sync stopped because the records did not check out. A
   * {@link Halt} rather than a string: it carries the violation CLASS and the
   * library's own copy, so a screen renders it rather than paraphrasing an
   * exception message.
   *
   * **Not dismissable, but not permanent either.** Round 1 of this task made it
   * sticky and unconditional, which meant one `visibilitychange` fired while
   * offline put up a wall no amount of coming back online could clear, on a tab
   * with no buttons on it. The rule that replaced it:
   *
   *  - a **successful** sync clears it, so recovery is automatic on the next
   *    trigger;
   *  - a **transport** failure neither sets nor clears it — being offline is
   *    not an integrity verdict in either direction;
   *  - a genuine halt sets `SyncEngine.haltReason`, and the engine then refuses
   *    every later sync, so a real halt re-asserts itself on its own and stays
   *    until `resume()`. The stickiness lives in the engine, where it belongs,
   *    rather than in a React `useState` nothing can reach.
   */
  fault: Halt | null;
  /** Never rejects. A failure becomes {@link SyncStatus.fault}, or is ignored. */
  run(trigger: SyncTrigger, options?: SyncOptions): Promise<void>;
  /** Drops the fault. For a caller that is re-running boot from the top. */
  clear(): void;
}

/**
 * Progress, faults, and the foreground trigger, for one coordinator.
 *
 * The `visibilitychange` listener lives here rather than in {@link startEngine}
 * so that React owns its teardown — `StrictMode` mounts every effect twice in
 * development, and a listener registered outside the effect system leaks one
 * subscription per mount.
 */
export function useSync(coordinator: SyncCoordinator | null): SyncStatus {
  const progress = useSyncProgress(coordinator);
  const [fault, setFault] = useState<Halt | null>(null);
  const clear = useCallback(() => {
    setFault(null);
  }, []);

  const run = useCallback(
    async (trigger: SyncTrigger, options?: SyncOptions): Promise<void> => {
      if (coordinator === null) return;
      try {
        const result = options === undefined ? await coordinator.run(trigger) : await coordinator.run(trigger, options);
        if (!result.halted) {
          // A sync that completed is the only thing that can say the previous
          // verdict no longer holds.
          setFault(null);
          return;
        }
        setFault(haltFromViolations(result.violations, coordinator.haltReason ?? HALT_WITHOUT_REASON));
      } catch (error) {
        // The engine has already published `phase: "halted"` and left the store
        // consistent at the last chunk boundary. What it cannot do is tell a
        // React tree, so this is the only place that error is observable — and
        // the only place that can tell "no network" from "the records did not
        // check out", which the phase alone cannot.
        const failure = classifySyncFailure(error, coordinator.haltReason);
        if (failure.kind === "offline") return;
        setFault(failure.halt);
      }
    },
    [coordinator],
  );

  // A ref so the listener effect does not re-register on every `run` identity
  // change, while still calling the current one.
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (coordinator === null) return;
    const onVisible = (): void => {
      if (document.visibilityState !== "visible") return;
      void runRef.current("foreground");
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [coordinator]);

  return useMemo(() => ({ progress, fault, run, clear }), [progress, fault, run, clear]);
}
