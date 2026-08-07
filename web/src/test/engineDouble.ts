/**
 * A `CoordinatedEngine` stand-in that publishes progress the way the REAL
 * `SyncEngine` does.
 *
 * # Why this exists, and why it is shared
 *
 * Round 1 of the boot-gate work shipped a bug that the whole suite was green
 * through, because every test double in the repo had the same blind spot: they
 * threw without publishing anything first. `SyncEngine.run` does the opposite —
 * it `publish({ phase: "halted" })` and THEN rethrows
 * (`client/src/net/engine.ts:401-406`), for a transport failure exactly as for
 * a chain break, and it leaves `p` on `halted` until the next run starts. A
 * double that skips the publish makes the phase permanently invisible to tests,
 * so any code reading `progress.phase` is unverified by construction.
 *
 * It lives here, in `src/test/`, rather than being copied into each spec, so
 * that fidelity is a property of one file somebody can be pointed at. **If
 * `SyncEngine.run`'s publish sequence changes, change it here in the same
 * commit.**
 *
 * The sequence modelled, from `run`:
 *
 *  1. every run publishes `pulling` before it does anything — which is what
 *     moves the phase OFF a previous `halted`;
 *  2. a clean run ends on `idle`;
 *  3. a `{ halted: true }` result and a THROW both end on `halted`, and the
 *     throw propagates afterwards.
 *
 * The publishes are attached with `.then` on the body's own promise, and that
 * promise is **returned unwrapped**. Wrapping it in an `async` function would
 * hand back a fresh promise per call and quietly break the coordinator's "five
 * taps join one promise" test, which asserts by identity. Attaching first also
 * gets the ordering right for free: this handler runs before the caller's, so
 * the publish lands before the throw is observed, exactly as in `run`.
 *
 * What it deliberately does NOT model is `SyncEngine`'s in-flight guard, so
 * every call reaches the body. That guard is the engine's own and is covered by
 * the engine's own suite; here, seeing every call is what lets a test assert
 * that no sync happened at all.
 */

import type { SyncOptions, SyncProgress, SyncResult } from "@ledger/client/net/engine";

import { IDLE_PROGRESS, type CoordinatedEngine } from "../v2/engine";

export interface EngineDouble extends CoordinatedEngine {
  /** Push progress from outside a run — an out-of-band `halt()`, say. */
  publish(patch: Partial<SyncProgress>): void;
  /** The options each `sync()` was called with, in order. */
  calls: unknown[];
}

export interface EngineDoubleOptions {
  /** The body of a sync. Defaults to a clean, empty result. */
  sync?: (options?: SyncOptions) => Promise<SyncResult>;
  /** `SyncEngine.halted`. Null for a transport failure — that is the point. */
  halted?: string | null;
}

export const CLEAN_SYNC: SyncResult = { pulled: 0, applied: 0, violations: [], halted: false };

export function fakeEngine(opts: EngineDoubleOptions = {}): EngineDouble {
  const watchers = new Set<(p: SyncProgress) => void>();
  const calls: unknown[] = [];
  let progress: SyncProgress = { ...IDLE_PROGRESS };

  const publish = (patch: Partial<SyncProgress>): void => {
    progress = { ...progress, ...patch };
    for (const w of watchers) w({ ...progress });
  };

  const body = opts.sync ?? (async () => CLEAN_SYNC);

  return {
    calls,
    publish,
    get progress() {
      // A FRESH object per read, exactly as `SyncEngine`'s own getter does.
      // Hooks that cache snapshots by identity loop forever on this, which is
      // the behaviour under test in `useSyncProgress`.
      return { ...progress };
    },
    get halted() {
      return opts.halted ?? null;
    },
    sync(options?: SyncOptions): Promise<SyncResult> {
      calls.push(options);
      // `run` publishes this before it does anything, which is what moves the
      // phase off a previous `halted`.
      publish({ phase: "pulling" });
      const running = body(options);
      running.then(
        (result) => {
          publish({ phase: result.halted ? "halted" : "idle" });
        },
        () => {
          // THE line this double exists for: halted is published, and only
          // then does the rejection reach the caller.
          publish({ phase: "halted" });
        },
      );
      return running;
    },
    subscribe(fn: (p: SyncProgress) => void) {
      watchers.add(fn);
      return () => {
        watchers.delete(fn);
      };
    },
    halt() {},
  };
}
