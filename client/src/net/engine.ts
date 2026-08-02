/**
 * The sync engine: chunked, yielding, resumable, one connection.
 *
 * # What it is, and what it deliberately is not
 *
 * It is the thing a screen calls. It owns the *sequencing* of a sync, the
 * progress a UI renders, the guard that stops five taps becoming five fetch
 * storms, and the repair that lets an interrupted sync carry on. It owns none
 * of the protocol: every chain check, every pin, every fold and every upload is
 * {@link Client}'s, called rather than reimplemented.
 *
 * That division is not stylistic. `client/README.md` lists three reasons the
 * Phase 1 client must not be grown into the product — it re-folds its whole log
 * per command, it keeps every verified row forever, and it holds its writer key
 * in a plain file — and all three are *store* choices that Task 5 replaced.
 * **None of them is the ordering**, which Phase 1's ledger records taking four
 * review rounds to settle. Reimplementing that here would re-open every one of
 * those bugs.
 *
 * # The canonical order: pull → verify → pin → fold → attest → push
 *
 * All six, `pin` included. A checkpoint built from unpinned heads claims genesis
 * for chains that are merely *un-pinned* rather than empty, and `observedHead()`
 * counts pinned per-blob hashes — so a device that correctly holds hashes
 * without bodies reports a false `chain_withheld` if pinning is skipped. That is
 * the defect Phase 1's Task 14 fix round 1 existed to close.
 *
 * In this engine the six expand to:
 *
 *  0. **resume** — {@link Client.reconcile} verifies and pins rows already on
 *     disk above the persisted cursor, so the pull below cannot be re-served
 *     rows the fold has already consumed.
 *  1. **pull** — {@link Client.pull}, which per page runs 2, 3 and a fold of its
 *     own and persists rows + cursor + heads in ONE transaction.
 *  2. **verify** — `verifyChain` against the pinned head (hot) or the pinned
 *     per-blob hashes (cold), before a single blob is opened, plus `checkAll`
 *     over the page. Inside `pull`.
 *  3. **pin** — the new head persisted with the rows and the cursor. Inside
 *     `pull`, and inside `reconcile` for the rows it heals.
 *  4. **fold** — {@link Client.materializeChunked}, `CHUNK_SIZE` rows at a time
 *     with a yield between chunks.
 *  5. **project** — {@link project} into SQLite, same chunk size, same yield.
 *     Task 8's own expansion puts the projection here, between the fold and the
 *     cursor's advance; it is not one of the canonical six because it writes a
 *     cache, not the log.
 *  6. **attest** — a `writer_checkpoint` naming one head per (roster writer ×
 *     stream), built from the heads step 3 pinned. Inside {@link Client.push}.
 *  7. **push** — the pending ops uploaded, then a self-sync so they are folded
 *     at the seqs the server assigned. {@link Client.push}.
 *
 * Steps 4 and 5 run a second time when step 7 actually uploaded something,
 * because that upload's trailing pull brought rows back that the projection
 * would otherwise not show until the next sync. Once, never in a loop.
 *
 * # The three mandatory rules, from the Phase 0 catastrophic run
 *
 * A device build reached >500 MB RSS, 0 FPS and froze after its second restore.
 * Three causes, three rules, each with a named regression test in
 * `engine.test.ts`:
 *
 *  1. **Chunk at {@link CHUNK_SIZE}, and yield between chunks.** The yield is
 *     the load-bearing half: chunking alone bounds one transaction, the yield is
 *     what lets the collector run. Note what it does *not* buy — Phase 0
 *     measured total `yieldMs` at 1.9–4.2 ms across a 58 s restore, so the JS
 *     thread was still blocked in multi-second slabs. Responsiveness comes from
 *     Task 1's async batch native API, not from here. `rssIsBoundedAcrossChunks`
 *     is therefore a *retention* measurement with a calibrated positive control,
 *     not a count of `setTimeout` calls: a call count proves somebody wrote a
 *     `setTimeout`, and nothing else.
 *  2. **One SQLite connection for the app's lifetime.** `openDatabaseSync` has
 *     no connection cache and Phase 0 leaked a native connection per press. See
 *     {@link sharedDriver}.
 *  3. **An `isRunning` guard.** The ~39-request / 144 MB fetch storm came from a
 *     user re-pressing a button on a frozen JS thread. {@link SyncEngine.sync}
 *     returns the in-flight promise rather than starting a second run.
 *
 * # Host imports
 *
 * None. `SqlDriver` is a type-only import, so this module is reachable from
 * Hermes; the app supplies `expoDriver`.
 */

import { Client, HardStopError, type PullReport } from "./client";
import type { Violation } from "../invariants/check";
import { ProjectionCancelled, ensureProjection, project, type ProjectReport } from "../replay/projection";
import type { State } from "../replay/state";
import type { SqlDriver } from "../store/driver";
import { STREAM_HOT, type Stream } from "../wire/blob";

/**
 * Rows folded, and rows projected, per chunk — and per yield.
 *
 * 250 is what the Phase 0 fix shipped with. It is repeated rather than imported
 * from `store/store.ts`'s `ROW_CHUNK` because the two are independently
 * tunable: that one is how much the *store* hands over at once, this one is how
 * much *work* happens between two turns of the event loop.
 */
export const CHUNK_SIZE = 250;

export type SyncPhase = "idle" | "pulling" | "folding" | "projecting" | "pushing" | "halted";

export interface SyncProgress {
  phase: SyncPhase;
  /** Rows the server delivered in this sync. */
  rowsPulled: number;
  /** Rows the fold expects to walk, once the fold has started. `null` before. */
  rowsTotal: number | null;
  /**
   * Ops folded so far in this sync.
   *
   * Which is every op in the log, because the fold still runs from genesis on
   * every sync. Task 9's snapshot is what makes this a delta; until then, a UI
   * that renders it as "N new" would be lying, and it is documented here rather
   * than renamed so the successor task has one place to change.
   */
  opsApplied: number;
  /** The chunk index within the active phase, 0 before the first. */
  chunk: number;
}

export interface SyncResult {
  pulled: number;
  applied: number;
  violations: Violation[];
  halted: boolean;
}

export interface SyncEngineOptions {
  chunkSize?: number;
  /**
   * What runs between chunks. Defaults to `setTimeout(…, 0)`, which is the
   * Phase 0 fix verbatim; overridable so a test can measure the *shape* of the
   * loop without a real timer, never so production can skip the yield.
   */
  yield?: () => Promise<void>;
}

export interface SyncOptions {
  stream?: Stream;
  /**
   * Run steps 6 and 7. Default `true`.
   *
   * `false` is a *read* refresh and is not free of consequence: a checkpoint is
   * how a newly enrolled peer stops hard-stopping `I11_roster_checkpoint`, and a
   * device that never pushes never writes one. Use it for a pull-to-refresh on a
   * screen, not as the app's only sync.
   */
  push?: boolean;
}

/** {@link SyncEngine.halt} was called, or a halt was already in force. */
export class SyncHaltedError extends Error {
  constructor(readonly reason: string) {
    super(`sync halted: ${reason}`);
    this.name = "SyncHaltedError";
  }
}

// ---------------------------------------------------------------------------
// Rule 2: one connection
// ---------------------------------------------------------------------------

const shared = new Map<string, SqlDriver>();

/**
 * The one handle for `key`, opening it on first use.
 *
 * `expo-sqlite`'s `openDatabaseSync` has no connection cache: every call is a
 * new native handle, and Phase 0 leaked one per button press. There is no
 * mechanism in the API that prevents that, so the mechanism is this — a module
 * that hands the same object back and a rule that nothing calls `expoDriver`
 * except through it.
 *
 * Keyed by database name rather than being a single slot, because a test
 * process legitimately opens several and the rule is *one per database*, not
 * one per process.
 */
export function sharedDriver(key: string, open: () => SqlDriver): SqlDriver {
  const have = shared.get(key);
  if (have !== undefined) return have;
  const made = open();
  shared.set(key, made);
  return made;
}

/** Closes and forgets one shared handle. For a test teardown and for sign-out. */
export function closeSharedDriver(key: string): void {
  const have = shared.get(key);
  if (have === undefined) return;
  shared.delete(key);
  have.close();
}

/** Closes and forgets every shared handle. */
export function closeSharedDrivers(): void {
  for (const key of [...shared.keys()]) closeSharedDriver(key);
}

/** Whether `key` currently holds an open handle. For assertions about leaks. */
export function sharedDriverIsOpen(key: string): boolean {
  return shared.has(key);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class SyncEngine {
  private readonly chunkSize: number;
  private readonly yieldToLoop: () => Promise<void>;
  private readonly watchers = new Set<(p: SyncProgress) => void>();
  private inFlight: Promise<SyncResult> | null = null;
  private haltReason: string | null = null;
  /** Set when {@link pullOrHeal} already pushed to clear an I11 deadlock. */
  private pushedToHeal = false;
  private p: SyncProgress = { phase: "idle", rowsPulled: 0, rowsTotal: null, opsApplied: 0, chunk: 0 };

  constructor(
    private readonly client: Client,
    private readonly db: SqlDriver,
    opts: SyncEngineOptions = {},
  ) {
    this.chunkSize = opts.chunkSize ?? CHUNK_SIZE;
    if (!Number.isInteger(this.chunkSize) || this.chunkSize <= 0) {
      throw new Error(`SyncEngine needs a positive integer chunk size, got ${String(opts.chunkSize)}`);
    }
    // The yield the Phase 0 fix shipped with. `setTimeout(…, 0)` rather than a
    // microtask: a resolved promise does NOT return to the event loop, so
    // `await Promise.resolve()` between chunks would satisfy every call-count
    // assertion while giving the runtime nothing.
    this.yieldToLoop =
      opts.yield ??
      ((): Promise<void> =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        }));
    ensureProjection(db);
  }

  /** A snapshot. Mutating it changes nothing; subscribe for updates. */
  get progress(): SyncProgress {
    return { ...this.p };
  }

  /** Whether a sync is running right now. Rule 3's state, readable by a button. */
  get running(): boolean {
    return this.inFlight !== null;
  }

  subscribe(fn: (p: SyncProgress) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  /**
   * Stops the sync in flight at its next chunk boundary, and refuses the next
   * one until {@link resume} clears it.
   *
   * Chunk-boundary rather than immediate, because the boundaries are exactly the
   * points at which the store is consistent: a page's rows, cursor and heads
   * land in one transaction, and a projection chunk is one transaction too.
   */
  halt(reason: string): void {
    this.haltReason = reason;
    this.publish({ phase: "halted" });
  }

  /** Clears a {@link halt}. The app's Integrity screen is what calls this. */
  resume(): void {
    if (this.haltReason === null) return;
    this.haltReason = null;
    this.publish({ phase: "idle" });
  }

  get halted(): string | null {
    return this.haltReason;
  }

  /**
   * Rule 3, the `isRunning` guard: a second call while one is running returns
   * the SAME promise rather than starting a second sync.
   *
   * Returning the in-flight promise rather than throwing or returning a no-op
   * result is what makes it invisible at the call site — five taps produce five
   * awaits on one page sequence, and every one of them resolves with the real
   * answer.
   */
  sync(opts: SyncOptions = {}): Promise<SyncResult> {
    const have = this.inFlight;
    if (have !== null) return have;
    const started = this.run(opts).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = started;
    return started;
  }

  // -- the run ------------------------------------------------------------

  private async run(opts: SyncOptions): Promise<SyncResult> {
    const stream = opts.stream ?? STREAM_HOT;
    const out: SyncResult = { pulled: 0, applied: 0, violations: [], halted: false };
    this.p = { phase: "idle", rowsPulled: 0, rowsTotal: null, opsApplied: 0, chunk: 0 };
    this.pushedToHeal = false;
    try {
      this.checkHalt();

      // 0. RESUME. Verify and pin whatever an interrupted run left on disk above
      //    the cursor, BEFORE asking the server for anything — otherwise the
      //    pull re-serves rows the fold has already consumed and the ordering
      //    guard refuses them (Task 5's `ReplayOrderError`).
      this.publish({ phase: "pulling" });
      this.client.reconcile(stream);

      // 1-3. PULL, which verifies and pins each page before it persists it.
      const report = await this.pullOrHeal(stream, opts);
      out.pulled = report.rows;
      out.violations = report.violations;
      this.publish({ rowsPulled: report.rows });
      this.checkHalt();

      // 4-5. FOLD, then PROJECT. Both chunked, both yielding.
      let folded = await this.fold();
      out.applied = folded.ops;
      await this.projectInto(folded.state);

      // 6-7. ATTEST, then PUSH.
      if (opts.push !== false && !this.pushedToHeal) {
        this.checkHalt();
        this.publish({ phase: "pushing", chunk: 0 });
        const pushed = await this.client.push();
        if (pushed.blobs > 0) {
          // The upload's trailing pull brought those rows back. Re-fold and
          // re-project ONCE so the projection is not a sync behind; not in a
          // loop, because a loop here would be a sync that never ends on an
          // account with a busy peer.
          const before = folded.rows;
          folded = await this.fold();
          out.applied = folded.ops;
          out.pulled += Math.max(0, folded.rows - before);
          await this.projectInto(folded.state);
        }
      }

      this.publish({ phase: "idle", chunk: 0 });
      return out;
    } catch (err) {
      // A hard stop is DATA, not a crash: `pull` persisted nothing over it, the
      // violations name what was wrong, and the caller's job is to show them.
      if (err instanceof HardStopError) {
        out.halted = true;
        out.violations = err.violations;
        this.haltReason = err.message;
        this.publish({ phase: "halted" });
        return out;
      }
      if (err instanceof SyncHaltedError) {
        out.halted = true;
        this.publish({ phase: "halted" });
        return out;
      }
      // Everything else propagates with the phase left at `halted`:
      // `UnknownNewerVersionError` (the app must be upgraded before it may fold
      // this log), `ChainBreakError`, `ProtocolError`, transport failures. None
      // of them has violations to render and none is repaired by retrying.
      this.publish({ phase: "halted" });
      throw err;
    }
  }

  /**
   * Steps 1-3, with the ONE repair a refused pull can have.
   *
   * # The I11 deadlock, and why the engine does not classify the stop itself
   *
   * A freshly enrolled second device hard-stops `I11_roster_checkpoint` on
   * every sync until some device writes a checkpoint naming it — and writing
   * that checkpoint is a PUSH, which the engine reaches only after a pull it
   * cannot complete. That is a deadlock, and Phase 1 spent a review round on the
   * escape: `push` proceeds over exactly one condition,
   * `VIOLATION_ROSTER_COVERAGE`, and over nothing else. Not over
   * `VIOLATION_CHAIN_WITHHELD` — a device being lied to has nothing
   * trustworthy to attest, and a checkpoint it wrote would replace the honest
   * one and launder the attack into a notice.
   *
   * **The engine deliberately does not re-decide that.** An allow-list copied
   * into a second place is two things that can disagree, and the one that
   * disagreed here is the defect above. So a refused pull is handed straight to
   * {@link Client.push}, which owns the rule: if the stop is the benign one it
   * writes the healing checkpoint and returns, and if it is anything else it
   * rethrows the same {@link HardStopError} and this halts on it. The engine's
   * policy is "ask the component that owns the policy", which is not a policy.
   *
   * `push: false` gets no repair, correctly: a read-only refresh must not
   * author an op, and a device in this state genuinely cannot sync until one
   * does.
   */
  private async pullOrHeal(stream: Stream, opts: SyncOptions): Promise<PullReport> {
    try {
      return await this.client.pull({ stream, limit: this.chunkSize });
    } catch (err) {
      if (!(err instanceof HardStopError) || opts.push === false) throw err;
      this.publish({ phase: "pushing", chunk: 0 });
      // Rethrows the stop unless `Client`'s allow-list forgives it.
      await this.client.push();
      this.pushedToHeal = true;
      this.publish({ phase: "pulling" });
      return await this.client.pull({ stream, limit: this.chunkSize });
    }
  }

  /** Step 4. `CHUNK_SIZE` rows per chunk, one yield between chunks. */
  private async fold(): Promise<{ state: State; ops: number; rows: number }> {
    this.publish({ phase: "folding", chunk: 0 });
    const got = await this.client.materializeChunked({
      chunkSize: this.chunkSize,
      // The engine wants a state and a count, never the op list. Asking for the
      // list would keep every inflated payload alive for the whole fold, which
      // is the retention `rssIsBoundedAcrossChunks` measures the absence of.
      keepOps: false,
      between: async (p) => {
        this.publish({ chunk: p.chunk, rowsTotal: p.total, opsApplied: p.ops });
        this.checkHalt();
        await this.yieldToLoop();
      },
    });
    this.publish({ chunk: got.chunks, rowsTotal: got.rows, opsApplied: got.opsApplied });
    return { state: got.state, ops: got.opsApplied, rows: got.rows };
  }

  /** Step 5. Same chunk size, same yield. */
  private async projectInto(state: State): Promise<ProjectReport> {
    this.publish({ phase: "projecting", chunk: 0 });
    try {
      const report = await project(this.db, state, {
        chunkSize: this.chunkSize,
        cancelled: () => this.haltReason !== null,
        between: async (chunk) => {
          this.publish({ chunk });
          await this.yieldToLoop();
        },
      });
      this.publish({ chunk: report.chunks });
      return report;
    } catch (err) {
      // An abandoned projection is a halt, not a fault. It left
      // `projection_meta.complete = 0` behind, so the tables read back as
      // unusable and the next sync rebuilds them — which is the whole reason
      // that flag exists.
      if (err instanceof ProjectionCancelled) throw new SyncHaltedError(this.haltReason ?? err.message);
      throw err;
    }
  }

  private checkHalt(): void {
    if (this.haltReason !== null) throw new SyncHaltedError(this.haltReason);
  }

  private publish(patch: Partial<SyncProgress>): void {
    this.p = { ...this.p, ...patch };
    const snapshot = this.progress;
    for (const w of this.watchers) w(snapshot);
  }
}
