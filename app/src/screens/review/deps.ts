/**
 * What the review queue needs from the rest of the app, as four interfaces it
 * can be handed — and, today, as four things that may legitimately be absent.
 *
 * # Why every dependency is nullable
 *
 * The sign-in screen established the convention this file follows: *a
 * dependency the build does not have is rendered, disabled, with the reason on
 * it.* Two of these do not exist yet:
 *
 *  - {@link RawMessageSource} — nothing in this repo can turn an `ingest_id`
 *    into raw text. Cold bodies live in the cold stream, `Client` exposes no
 *    lookup by ingest id, and building one here would duplicate Task 10's
 *    verified lazy window and Task 24's reprocessing reader. The contract is
 *    defined so those tasks have something to satisfy; until then the unparsed
 *    card says the message is not on this device rather than pretending.
 *  - {@link DictionarySubmitter} — `POST /api/v1/dictionary/submissions` does
 *    not exist (Task 20 Step 3 adds it). The opt-in is rendered off and
 *    disabled with that as its reason, because an opt-in that silently posted
 *    nowhere would be a consent dialog for a thing that does not happen.
 *
 * The other two — the store and the writer — exist but are constructed by Task
 * 8's engine, which the navigator does not yet hold.
 */

import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import type { Op } from "@ledger/client/wire/op.ts";

import type { ReviewSource } from "../../db/reviewQueue.ts";

/**
 * The part of `Outbox` this screen uses. `Outbox` satisfies it structurally,
 * which is the point: the screen depends on three members rather than on a
 * class, so a test drives it without a client, a chain or a network.
 */
export interface ReviewWriter {
  /** Ops authored on this device that the server does not hold yet. */
  readonly pending: readonly Op[];
  /** Durable before it returns: `Client.emit` commits. */
  enqueue(spec: OpSpec): Op;
  /** Durable as one batch: either every op is queued or none is. */
  enqueueMany(specs: readonly OpSpec[]): Op[];
  /**
   * Re-entrant-safe by contract — `Outbox.flush` joins an in-flight call rather
   * than starting a second page sequence. That is what lets this screen flush
   * after every card without re-creating Phase 0's fetch storm.
   */
  flush(): Promise<unknown>;
}

/** One raw message, as the unparsed card shows it. */
export interface RawMessage {
  /** RFC3339, from the cold record. */
  receivedAt: string;
  /** The decoded body text. Never rendered as HTML. */
  text: string;
}

/**
 * The cold-stream lookup the unparsed lane needs.
 *
 * A user reconstructing a transaction from a message no parser could read is
 * doing the hardest thing this app asks of anyone, and doing it without the
 * message in front of them is not reasonable. `null` from `read` means the
 * cold window does not hold this body — the honest answer, and the card offers
 * to fetch it rather than showing an empty box.
 */
export interface RawMessageSource {
  read(ingestID: string): Promise<RawMessage | null>;
}

/** The opt-in submission of a merchant→category pattern to the global dictionary. */
export interface DictionarySubmitter {
  submit(entry: { pattern: string; match: "exact" | "contains"; category: string }): Promise<void>;
}

export interface ReviewDeps {
  source: ReviewSource | null;
  writer: ReviewWriter | null;
  raw: RawMessageSource | null;
  dictionary: DictionarySubmitter | null;
  /** A ULID source for new entity ids. Injected so a test can pin them. */
  newID: () => string;
}
