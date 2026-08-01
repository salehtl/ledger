/**
 * The materialized state a fold produces, and the two pure functions over it
 * that everything else depends on being identical across replicas:
 * {@link fingerprint} and {@link serializeState}.
 *
 * # What this file is for
 *
 * Spec §3.3 makes the op log the source of truth and this the *derived* view.
 * The whole design rests on one claim — **every replica folding the same log
 * reaches the same state** — so every field here has to be a deterministic
 * function of `(the ops, their seq order)` and nothing else. In particular:
 *
 *   - **No wall clock.** Nothing here reads `Date.now()`. `authored_at` is read
 *     only as a fork tiebreak, and only through `parseInstantMs`.
 *   - **No floats in money.** `amount_minor`, `amount_home_minor`, split parts
 *     and rate micros are `bigint`. A `number` is a bug — the FX intermediate
 *     product exceeds 2^53 long before the result does (spec §3.7:125).
 *   - **No iteration-order dependence that isn't pinned.** Where insertion order
 *     is load-bearing it is stated (see {@link State.byFingerprint}); where it
 *     is not, {@link serializeState} sorts so that a comparison of two states
 *     compares meaning rather than history.
 *
 * # `heads` is not in the plan's field list, and has to be
 *
 * Fork resolution compares the incoming op against *the op currently owning the
 * entity's head* — it needs that op's `authored_at` and `writer_id`, which no
 * materialized `Txn` or rule carries. Storing only `version` on the entity would
 * make the tiebreak unimplementable, so the head registry is explicit. It is
 * also what Task 13's `I9_version_contiguity` reads.
 */

import { compareUTF8, parseInstantMs } from "../wire/op";

/**
 * The implicit rate of the home currency against itself: 1.000000, in the
 * `rate_micro` units of spec §3.7:124. The home currency carries no rate row of
 * its own; this is the value `home_currency_set` installs.
 *
 * Task 12 owns `convert()` and re-exports this from `fx.ts`; it lives here
 * because the *rate head* is replay's business and the arithmetic is not.
 */
export const HOME_IDENTITY_MICRO = 1_000_000n;

/** One part of a split. Money is minor units, always. */
export interface Split {
  category: string;
  amount_minor: bigint;
}

/**
 * A transaction as the client shows it.
 *
 * `id` is the entity id (`op.entity.id`); `ingest_id` is the sha256 of the raw
 * body, which is what dedup keys on (spec §3.3:67) and what joins this row to
 * its cold-stream email.
 */
export interface Txn {
  id: string;
  ingest_id: string;
  amount_minor: bigint;
  currency: string;
  direction: "debit" | "credit";
  /** RFC3339 UTC, canonicalised on decode so the fingerprint day is stable. */
  posted_at: string;
  merchant_raw: string;
  last4: string;
  category: string | null;
  needs_review: boolean;
  /**
   * Derived from the WRITER the blob was attributed to, never from the payload.
   * Spec §3.3(b) requires the UI to distinguish server-ingested from
   * user-authored, and a payload field would let a client writer claim the
   * label; `writer_id` is AAD-bound and cannot be claimed.
   */
  provenance: "ingest" | "user";
  /** The frozen FX snapshot. Task 12 computes it; §3.7 forbids recomputing it. */
  amount_home_minor: bigint | null;
  splits: Split[];
  /** op_id of the `txn_superseded` that replaced this row, or null if live. */
  superseded_by: string | null;
  /**
   * Fingerprint heuristic (spec §3.3:67). A NOTICE — this row stays visible.
   *
   * **It is a snapshot of the answer at the moment this row was indexed, not a
   * live claim.** The row it points at can afterwards be edited into a different
   * fingerprint bucket, and nothing re-walks the rows pointing at it — so a
   * consumer must treat this as "was flagged against", never as "currently
   * shares a fingerprint with". Re-deriving it for every affected row on every
   * edit would be a scan, and the value of a duplicate *notice* does not justify
   * one. Task 13's `I14_forks_surfaced` reports it; it must not assert the
   * fingerprints still match.
   */
  possible_duplicate_of: string | null;
  version: number;
}

export interface Rule {
  pattern: string;
  match: string;
  category: string;
  priority: number;
  version: number;
}

/**
 * The current head of one versioned entity, plus the identity of the op that
 * owns it. The last three fields exist only for fork resolution.
 */
export interface EntityHead {
  kind: string;
  id: string;
  version: number;
  op_id: string;
  writer_id: string;
  /** Epoch ms. Compared as an INSTANT — never as a string (see op.ts). */
  authored_at_ms: number;
}

/**
 * A true concurrent fork that was resolved. Surfaced, never silent (spec
 * §3.3:66). `winner_op`/`loser_op` are op ids, so a notice is identical on every
 * replica regardless of which op happened to be uploaded first.
 */
export interface ForkNotice {
  entity: { kind: string; id: string };
  winner_op: string;
  loser_op: string;
  at_seq: bigint;
}

/**
 * Something the fold refused to do, recorded rather than dropped. Anomalies are
 * NOTICES: none of them stops a sync (spec §3.3:68 reserves hard stops for chain
 * breaks and unknown-newer versions).
 */
export interface Anomaly {
  kind: string;
  detail: string;
  at_seq: bigint;
}

/** A blob that could not be decoded, set aside with a visible warning. */
export interface Unreadable {
  writer_id: string;
  stream: string;
  writer_counter: bigint;
  seq: bigint;
  reason: string;
}

/** One entry of the latest `writer_checkpoint` seen (spec §3.3(c)). */
export interface CheckpointEntry {
  writer_id: string;
  stream: string;
  counter: bigint;
  hash: string;
}

export interface State {
  txns: Map<string, Txn>;
  /** ingest_id → txn id. At most one LIVE transaction per ingest id, always. */
  liveByIngestID: Map<string, string>;
  /**
   * fingerprint → live txn ids, **in fold order**. Order is load-bearing: the
   * duplicate notice names the first entry, so two replicas must build these
   * arrays identically. They do, because the fold order is `seq`.
   */
  byFingerprint: Map<string, string[]>;
  rules: Map<string, Rule>;
  homeCurrency: string | null;
  /**
   * The *head* rate per currency (spec §3.7:126). A key present with `null` is
   * a live `rate_unset` — meaningfully different from an absent key, which is
   * "no rate was ever set".
   */
  rates: Map<string, bigint | null>;
  /** currency → live txn ids whose snapshot is still null. Task 12 drains these. */
  pendingByCurrency: Map<string, Set<string>>;
  /** The heads from the LATEST `writer_checkpoint`; earlier ones are history. */
  checkpoints: CheckpointEntry[];
  forks: ForkNotice[];
  anomalies: Anomaly[];
  unreadable: Unreadable[];
  /**
   * `hot` is the highest `seq` the fold has been OFFERED — not the highest it
   * folded. A blob that could not be decoded still consumes its position, so the
   * cursor advances past it; otherwise a resuming client re-requests the same
   * unreadable blob forever, and — worse — a `seq` consumed by a set-aside blob
   * could be re-delivered later with different content and folded as if new.
   *
   * `cold` belongs to the sync layer: cold blobs are raw email bodies, not ops,
   * so replay never advances it (invariant I16 — a cold blob carrying state
   * would make every hot-only client silently wrong).
   */
  cursors: { hot: bigint; cold: bigint };
  /**
   * The op ids already applied AT `cursors.hot`, which is the idempotence guard
   * for a page delivered twice.
   *
   * The ordering guard alone cannot be it: every op in a blob shares one `seq`,
   * so the guard has to admit `seq === cursors.hot`, and a re-delivered page
   * would then re-apply — taking an entity to a version nothing authored and
   * forking it against itself. Bounded by one blob's op count, because it is
   * cleared the moment the cursor advances.
   */
  appliedAtCursor: Set<string>;
  /**
   * Entity head registry, keyed by {@link entityKey}.
   *
   * **This map is never pruned**, and a retired transaction keeps its entry
   * forever: an entity's version line has to stay contiguous for the life of the
   * log (Task 13's `I9_version_contiguity`), and a supersede does not end the
   * predecessor's version line — a `txn_categorized` authored offline against
   * the retired row still arrives and still has to resolve. So it grows with the
   * log, like the log. That is acceptable at beta scale for the same reason
   * replay itself is (spec §3.3:73 defers compaction to ~50k ops), and it is
   * recorded there as one of the things compaction would have to reclaim.
   */
  heads: Map<string, EntityHead>;
}

export function emptyState(): State {
  return {
    txns: new Map(),
    liveByIngestID: new Map(),
    byFingerprint: new Map(),
    rules: new Map(),
    homeCurrency: null,
    rates: new Map(),
    pendingByCurrency: new Map(),
    checkpoints: [],
    forks: [],
    anomalies: [],
    unreadable: [],
    cursors: { hot: 0n, cold: 0n },
    appliedAtCursor: new Set(),
    heads: new Map(),
  };
}

/**
 * The key an entity's head is filed under. NUL separates the two parts because
 * no entity kind or id can contain it, so `("txn", "a\u0000b")` and
 * `("txn\u0000a", "b")` cannot collide.
 */
export function entityKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

// ---------------------------------------------------------------------------
// The pending index
//
// `pendingByCurrency` is maintained by `replay.ts` (creates, supersedes, edits)
// and drained by `fx.ts` (backfill), so the two functions that define what it
// MEANS live here with the field rather than in either consumer. Its invariant —
// an id is in this index exactly when its row is live and its snapshot is null —
// is asserted over a whole sample log in `fx.test.ts`, rather than defended by
// re-checks at the freeze site that would silently paper over a break.
// ---------------------------------------------------------------------------

/** Files a live, unfrozen transaction under its currency for later conversion. */
export function markPending(s: State, t: Txn): void {
  if (t.amount_home_minor !== null) return;
  const set = s.pendingByCurrency.get(t.currency);
  if (set === undefined) s.pendingByCurrency.set(t.currency, new Set([t.id]));
  else set.add(t.id);
}

/** Takes a transaction out of the index, because it froze or stopped being live. */
export function clearPending(s: State, t: Txn): void {
  const set = s.pendingByCurrency.get(t.currency);
  if (set === undefined) return;
  set.delete(t.id);
  // Empty buckets are deleted rather than kept: a state's canonical form must
  // not depend on which keys happen to have been touched.
  if (set.size === 0) s.pendingByCurrency.delete(t.currency);
}

/**
 * The cross-source duplicate heuristic of spec §3.3:67 —
 * `last4|amount|direction|merchant|day`.
 *
 * Two things about it are deliberate:
 *
 *   - **The day comes from the parsed instant, not from slicing the string.**
 *     `2026-06-05T22:00:00-04:00` is the 6th in UTC; a substring would read the
 *     5th and manufacture a collision one executor sees and the other does not.
 *   - **`|` is not escaped**, so a merchant containing a pipe can in principle
 *     collide with a different transaction. That is accepted rather than fixed
 *     because a fingerprint hit is only ever a *notice* — it never drops, merges
 *     or hides anything — so the cost of a false positive is one review item,
 *     while escaping would put a second string-mangling rule into the frozen
 *     cross-executor contract.
 */
export function fingerprint(t: Txn): string {
  const day = new Date(parseInstantMs(t.posted_at)).toISOString().slice(0, 10);
  return `${t.last4}|${t.amount_minor}|${t.direction}|${t.merchant_raw}|${day}`;
}

/**
 * A canonical string form of a whole state, for equality assertions.
 *
 * This is what makes "two replicas converge" checkable rather than assertable.
 * `bigint` becomes a decimal string (`JSON.stringify` throws on it outright),
 * Map keys and object keys are sorted by UTF-8 bytes, and Sets are sorted.
 *
 * **Arrays are left in order on purpose.** `byFingerprint`'s arrays, `forks`,
 * `anomalies`, `unreadable` and `splits` are all sequences whose order *is*
 * meaning; sorting them would hide exactly the divergence this function exists
 * to catch.
 *
 * # What this witness does NOT cover — read before reusing it
 *
 * It compares *values*, so two things are invisible to it:
 *
 *   - **Set iteration order.** `pendingByCurrency`'s sets are sorted here, so
 *     reversing their insertion order is not reported. That is correct today
 *     and only because nothing derives an ordered answer from them — Task 12's
 *     backfill freezes every id in a set at the same rate, so the result does
 *     not depend on the order it walks them in. A consumer that ever makes an
 *     order-dependent decision from a Set must not rely on this to catch it.
 *   - **Map insertion-order POLICY.** Map keys are sorted here, and the
 *     chunk-stability tests that do pin key order compare two runs of the same
 *     code — so they catch chunking-dependence and not a policy change. The
 *     policy is pinned separately, by name, in `replay.test.ts`.
 *
 * # It is not sufficient as the cross-executor fixture on its own
 *
 * Spec §3.5 mandates two executors that fold the same log to the same state, and
 * this task nominated the sample log plus this function as the natural
 * conformance vector. That still holds for the *values* — but **Go randomizes
 * map iteration**, so a Go fold that derived any ordered answer from a map would
 * diverge run to run while this reported a match. This engine has exactly one
 * order-dependent answer, `possible_duplicate_of`, and it reads an explicit
 * ARRAY (`byFingerprint`) precisely so that order is data rather than iteration.
 * A Go port must mirror that: build the array in fold order, never range a map.
 * Anyone wiring up the conformance suite has to check that property directly —
 * this function cannot.
 */
export function serializeState(s: State): string {
  const witnessed: Record<string, unknown> = {};
  for (const k of Object.keys(s)) {
    if (!NOT_WITNESSED.has(k)) witnessed[k] = (s as unknown as Record<string, unknown>)[k];
  }
  return JSON.stringify(canonical(witnessed));
}

/**
 * The fields that are DELIVERY bookkeeping rather than materialized state, and
 * so are not part of the convergence claim.
 *
 * Only `appliedAtCursor`, and it earns the exception: it records which op ids
 * arrived at the current position, so two replicas that folded the same log
 * with the fork's two ops uploaded in opposite orders hold different values in
 * it *by construction* — the last op at the last position is a different op —
 * while agreeing on every transaction, rule, rate and notice. Witnessing it
 * would turn a correct convergence into a reported divergence.
 *
 * `cursors` is deliberately NOT here: it converges (both replicas end at the
 * same highest seq) and a disagreement about it is a real one.
 *
 * The list is pinned by a test, so a field added later cannot silently join it.
 */
const NOT_WITNESSED: ReadonlySet<string> = new Set(["appliedAtCursor"]);

/** The fields {@link serializeState} deliberately omits. Exported so it is testable. */
export function notWitnessed(): string[] {
  return [...NOT_WITNESSED];
}

function canonical(v: unknown): unknown {
  if (typeof v === "bigint") return `${v}`;
  if (v instanceof Map) {
    return [...v.entries()]
      .sort(([a], [b]) => compareUTF8(String(a), String(b)))
      .map(([k, x]) => [k, canonical(x)]);
  }
  if (v instanceof Set) return [...v].map(String).sort(compareUTF8);
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort(compareUTF8)) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}
