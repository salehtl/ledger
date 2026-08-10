/**
 * The one seam through which this app appends to its own log.
 *
 * # Why an `Outbox` and not `client.emitMany` directly
 *
 * `Client.emitMany` validates and persists, which is the durable half; what it
 * does not do is drain. `Outbox.flush` is the page loop that turns a queue into
 * uploads, and it is re-entrant-safe and latches on the errors that must never
 * be blind-retried (a peer's chain withheld, a break in this device's own
 * chain). A screen calling `client.push()` in a loop would be a second, worse
 * copy of that policy.
 *
 * # One outbox per handle, for the tab's lifetime
 *
 * The same argument `BootGate` makes about the engine: `Outbox` holds the
 * in-flight promise that makes a second `flush()` join the first rather than
 * start a second page sequence, and an outbox rebuilt on every render would lose
 * it — two decks' worth of confirmations would push concurrently, both reading
 * the same head. The `WeakMap` is keyed on the handle so a signed-out handle's
 * outbox is collectable with it.
 *
 * # The card leaves the deck on ENQUEUE, not on flush
 *
 * `Client.emit` commits the op before it returns, so the user's answer is
 * durable the moment they give it. {@link Writer.enqueueMany} is therefore
 * synchronous and {@link Writer.flush} is fire-and-forget from the caller's
 * point of view: waiting for the network before advancing the deck would make a
 * queue that is used on a plane unusable, and waiting for the *fold* would be
 * worse — the projection does not move until a sync, so the row would sit there
 * still flagged.
 */

import { useMemo } from "react";

import { Outbox, type OpSpec } from "@ledger/client/outbox/outbox";
import type { Op } from "@ledger/client/wire/op";

import { useV2 } from "./BootGate";
import type { V2Handle } from "./session";

/**
 * What a screen needs in order to author.
 *
 * Narrower than `Outbox` on purpose: a screen has no business clearing a latched
 * halt or reading the blob packer's opinion, and a test double for three methods
 * is a test double somebody will actually write.
 */
export interface Writer {
  /** Ops authored on this device that the server does not hold yet. */
  readonly pending: readonly Op[];
  /** Queues a logical group with one durable write, or queues none of it. */
  enqueueMany(specs: readonly OpSpec[]): void;
  /** Drains the queue. Rejects on a real failure; the ops stay queued. */
  flush(): Promise<void>;
}

const outboxes = new WeakMap<V2Handle, Outbox>();

function outboxFor(handle: V2Handle): Outbox {
  const held = outboxes.get(handle);
  if (held !== undefined) return held;
  const made = new Outbox(handle.client);
  outboxes.set(handle, made);
  return made;
}

function writerFor(handle: V2Handle): Writer {
  const outbox = outboxFor(handle);
  return {
    get pending(): readonly Op[] {
      return outbox.pending;
    },
    enqueueMany: (specs) => void outbox.enqueueMany(specs),
    flush: async () => void (await outbox.flush()),
  };
}

/**
 * The writer for this device, or `null` with no v2 runtime.
 *
 * `injected` is the test seam. `null` is the disconnected state and never a
 * fallback: a screen that answered a missing runtime by POSTing to a v1 route
 * would not fail, it would write to a different database over a different
 * protocol and every test would pass. There is no such path from here.
 */
export function useWriter(injected?: Writer): Writer | null {
  const runtime = useV2();
  const handle = runtime?.handle ?? null;
  return useMemo(() => {
    if (injected !== undefined) return injected;
    return handle === null ? null : writerFor(handle);
  }, [injected, handle]);
}
