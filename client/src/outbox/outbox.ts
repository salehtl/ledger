/**
 * The offline outbox: the queue an op sits in between "the user tapped save"
 * and "the server holds it".
 *
 * # There is only one queue, and it is `client_state.pending`
 *
 * A second durable queue beside it would be two writes where one is needed, and
 * a crash between them either loses an op or applies it twice. `Client.emit`
 * appends to `pending` and commits in one call, so an op is durable the instant
 * it is authored; this class adds the things a phone needs on top of that and
 * stores nothing of its own:
 *
 *  - **paging.** `POST /api/v1/sync` claims at most `MAX_UPLOAD_BLOBS` (8)
 *    positions, and a week of offline edits can exceed that. `Client.push`
 *    sends one page and reports `remaining`; {@link Outbox.flush} is the loop
 *    over pages, with a progress guarantee so a server that accepts a page
 *    without advancing cannot spin it forever.
 *  - **one flush at a time.** Phase 0's ~39-request / 144 MB fetch storm came
 *    from a user re-pressing a button on a frozen JS thread. A second
 *    {@link Outbox.flush} while one is running joins the first.
 *  - **a latch on hard stops.** A chain break or a withheld chain means the log
 *    this device would append to is not the log it verified. Retrying that is
 *    worse than useless — the plan's words are "surface it as a hard stop, never
 *    retry blindly" — so the failure is remembered and every later flush throws
 *    it back without touching the network until {@link Outbox.clearHalt}.
 *
 * # What it deliberately does NOT do
 *
 * No timers, no exponential backoff, no connectivity listener. Deciding *when*
 * to flush belongs to the app (foreground, `NetInfo`, a pull-to-refresh); this
 * is the part that has to be right about ordering and durability, and mixing a
 * scheduler into it would make those tests about time. The ordering itself —
 * `pull → verify → pin → fold → attest → push` — lives in `Client.push` and is
 * not reimplemented here; Phase 1 spent four review rounds settling it.
 */

import { HardStopError, NetworkError, type PushReport } from "../net/client";
import { ChainBreakError } from "../wire/chain";
import type { EntityRef, Op } from "../wire/op";

/** Why a flush stopped. */
export type FlushStop = "drained" | "offline";

export interface FlushResult {
  /** Ops the server is holding as a result of this flush. */
  sent: number;
  /** Blobs uploaded across every page. */
  blobs: number;
  /** Pages — i.e. `POST /api/v1/sync` batches — this flush completed. */
  pages: number;
  /** Ops still queued when it stopped. */
  queued: number;
  stopped: FlushStop;
  /**
   * The network failure that ended an `offline` flush, for logging. It is not
   * a halt: the ops are still queued and the next flush resends them.
   */
  offlineCause: Error | null;
}

/**
 * A flush that neither drained the outbox nor moved it.
 *
 * The same shape as the cold stream's non-advancing-cursor guard, and it exists
 * for the same reason: a loop whose exit condition depends on a remote party
 * needs a progress assertion, or a server that answers "accepted, 12 remaining"
 * forever holds the device in it.
 */
export class OutboxStalledError extends Error {
  override readonly name = "OutboxStalledError";
  constructor(queued: number) {
    super(`the outbox still holds ${queued} op(s) after a page that uploaded nothing and settled nothing`);
  }
}

/** What `Client.emit` takes. Re-stated so callers need not import the client. */
export interface OpSpec {
  type: string;
  payload: unknown;
  entity?: EntityRef;
  parentVersion?: number | null;
  ingestId?: string;
}

/**
 * The part of `Client` an outbox uses. `Client` satisfies it structurally and
 * is what production passes.
 *
 * It exists so the loop's progress guarantee can be tested against a pusher
 * that reports progress it did not make — which the real client cannot be made
 * to do, precisely because it is correct. A guard whose failing case is
 * unreachable in every test is a guard nobody has seen work.
 */
export interface Pusher {
  readonly pending: readonly Op[];
  emit(spec: OpSpec): Op;
  emitMany(specs: readonly OpSpec[]): Op[];
  push(): Promise<PushReport>;
}

export class Outbox {
  private running: Promise<FlushResult> | null = null;
  private halt: Error | null = null;

  constructor(private readonly client: Pusher) {}

  /** Ops authored on this device that the server does not hold yet. */
  get queued(): number {
    return this.client.pending.length;
  }

  /** The queue itself, for a "3 changes waiting" badge. */
  get pending(): readonly Op[] {
    return this.client.pending;
  }

  /** The hard stop this outbox is latched on, or null. */
  get halted(): Error | null {
    return this.halt;
  }

  /**
   * Queues an op. It is validated and persisted before this returns, so an op
   * the user has seen accepted survives the app being killed on the next line.
   */
  enqueue(spec: OpSpec): Op {
    return this.client.emit(spec);
  }

  /** Queues a logical group with one durable write, or queues none of it. */
  enqueueMany(specs: readonly OpSpec[]): Op[] {
    return this.client.emitMany(specs);
  }

  /**
   * Clears a latched hard stop so the next flush tries again.
   *
   * Explicit because the situations that latch it — a peer's chain withheld, a
   * break in this device's own chain — are not fixed by waiting, and a client
   * that cleared them on a timer would turn a permanent warning into a flicker.
   */
  clearHalt(): void {
    this.halt = null;
  }

  /**
   * Drains the outbox, one upload's worth of blobs at a time.
   *
   * Re-entrant-safe: a call made while one is running returns the in-flight
   * promise rather than starting a second page sequence.
   */
  flush(): Promise<FlushResult> {
    if (this.running !== null) return this.running;
    const run = this.drain().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  private async drain(): Promise<FlushResult> {
    if (this.halt !== null) throw this.halt;
    let sent = 0;
    let blobs = 0;
    let pages = 0;
    for (;;) {
      const before = this.queued;
      // A push with an empty outbox still syncs and may still owe a checkpoint
      // (the roster grew while this device was offline), so the loop is entered
      // at least once rather than short-circuited on `queued === 0`.
      let report: PushReport;
      try {
        report = await this.client.push();
      } catch (err) {
        // An ALLOW-list, and only one entry: a request that never got an answer
        // is "not right now". The ops stay queued and the in-flight record
        // decides, on the next attempt, whether the batch this one may have
        // delivered actually landed.
        //
        // A deny-list here — "offline unless it is one of the errors I thought
        // of" — is the shape that swallowed the client's own determinism check
        // as a connectivity blip in this file's first draft. Everything that is
        // not a NetworkError propagates, and the ones that must never be
        // retried also latch.
        if (err instanceof NetworkError) {
          return { sent, blobs, pages, queued: this.queued, stopped: "offline", offlineCause: err };
        }
        if (neverRetry(err)) this.halt = err;
        throw err;
      }
      pages += 1;
      sent += report.ops;
      blobs += report.blobs;
      if (report.remaining === 0) break;
      // Measured against the queue depth this page started from, not against
      // the page's own report — a report is the pusher's account of itself,
      // and this has to be the property the loop actually depends on.
      if (this.queued >= before) throw new OutboxStalledError(this.queued);
    }
    return { sent, blobs, pages, queued: this.queued, stopped: "drained", offlineCause: null };
  }
}

/**
 * The failures a flush must never retry, so they latch.
 *
 * `ChainBreakError` is the chain's — raised by `verifyChain`, by the client's
 * reconciliation when the server's head disagrees with what this device
 * recorded sending, and by the `409 chain_break` an upload can come back with.
 * `HardStopError` carries the invariant checker's stops.
 *
 * Both mean the log ahead is not the log behind. Retrying into it is how an
 * honest attestation gets replaced by one claiming genesis.
 */
function neverRetry(err: unknown): err is Error {
  return err instanceof ChainBreakError || err instanceof HardStopError;
}
