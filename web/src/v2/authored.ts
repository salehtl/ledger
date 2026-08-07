/**
 * What this device has authored, for as long as its writer lives.
 *
 * # The window this exists to cover
 *
 * `Outbox.flush` calls `Client.push()`, and `client.ts` strips the sent ops from
 * `st.pending` the moment the server acks them. **Nothing on that path pulls or
 * projects** — only `net/engine.ts` projects, and it runs on launch, on
 * `visibilitychange` and on pull-to-refresh. So between the push ack and the
 * next full sync the outbox is EMPTY while the projection is still stale, and
 * anything derived purely from `pending` disappears in that window.
 *
 * For the review deck that is harmless: the card is already off the pile. For a
 * *list* it is the whole bug. The row a user has just categorised reverts to
 * "Uncategorized" seconds after a successful push, the rule switch comes back
 * defaulted on because the row reads uncategorised again, and a user who sees no
 * change answers a second time — which writes a second, contradicting,
 * permanent `exact` rule for that merchant. Online is the normal path, so this
 * is the common case, not an edge one.
 *
 * # Why a store and not a longer-lived derivation
 *
 * There is no other record. Once pushed, the op lives on the server and in the
 * log this device has not folded yet; `pending` is gone and the projection does
 * not know. Folding this device's own ops locally on emit would also close it,
 * but that is a change to the engine's projection path and to what "the
 * projection is a pure function of the log" means; this is a screen-level memory
 * of what the screen itself did.
 *
 * # It expires, so it cannot outlive its evidence
 *
 * Every answer carries the version its op produces, and
 * `withPendingCategory` stops applying it once the projected row is at or past
 * that version — at which point the fold has happened and the projection is the
 * truth, including when a peer's op won the fork and the answer shown is not the
 * one this device asked for. The rules do not expire and do not need to: a
 * `rule_added` is permanent, so "this merchant already has a rule" only ever
 * becomes MORE true.
 *
 * Keyed on the `Writer` in a `WeakMap`, exactly as `outboxFor` is keyed on the
 * handle: it survives the screen unmounting (a user switching tabs and coming
 * back must not be told "Uncategorized" again), it is per-signed-in-handle, and
 * it is collectable with the writer rather than living forever in a module.
 */

import type { OpSpec } from "@ledger/client/outbox/outbox";
import type { Rule } from "@ledger/client/replay/state";

import type { PendingAnswer } from "./sources/review";
import type { Writer } from "./writer";

export interface Authored {
  /** The last answer this device gave for a transaction, by transaction id. */
  answers: Map<string, PendingAnswer>;
  /** Every rule this device has queued, in {@link Rule} shape. */
  rules: Rule[];
}

const stores = new WeakMap<Writer, Authored>();

export function authoredBy(writer: Writer): Authored {
  const held = stores.get(writer);
  if (held !== undefined) return held;
  const made: Authored = { answers: new Map(), rules: [] };
  stores.set(writer, made);
  return made;
}

/**
 * Records what one enqueued group claims.
 *
 * Read off the {@link OpSpec}s that were actually enqueued rather than off the
 * screen's own variables, so the memory cannot say something different from the
 * ops — including when `categorizeOps` decided to drop the rule.
 */
export function recordAuthored(store: Authored, txnID: string, specs: readonly OpSpec[]): void {
  for (const spec of specs) {
    if (spec.type === "txn_categorized") {
      const p = spec.payload as { category?: unknown; needs_review?: unknown };
      store.answers.set(txnID, {
        category: typeof p.category === "string" ? p.category : null,
        needs_review: p.needs_review === true,
        version: spec.parentVersion === null || spec.parentVersion === undefined ? null : spec.parentVersion + 1,
      });
    } else if (spec.type === "rule_added") {
      const p = spec.payload as { pattern?: unknown; match?: unknown; category?: unknown; priority?: unknown };
      if (typeof p.pattern !== "string" || typeof p.match !== "string" || typeof p.category !== "string") continue;
      store.rules.push({
        pattern: p.pattern,
        match: p.match,
        category: p.category,
        priority: typeof p.priority === "number" ? p.priority : 0,
        version: 0,
      });
    }
  }
}
