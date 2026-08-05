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
 *   - **No clock and no `Date` at all.** Nothing here reads `Date.now()`, and —
 *     since Phase 2 Task 7 — nothing constructs a `Date` either. The weaker
 *     claim this bullet used to make covered only `Date.now()`, and it let a
 *     `new Date(ms).toISOString()` sit inside {@link fingerprint}, which is a
 *     value fork resolution and dedup compare. See {@link utcDay} for what that
 *     cost. `authored_at` is read only as a fork tiebreak, and only through
 *     `parseInstantMs`, which range-checks and computes arithmetically for the
 *     same reason.
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
 * The extraction tier that produced a transaction. The same closed set as Go's
 * `diag.TierTemplate` / `TierHeuristic` / `TierNone`.
 *
 * `"none"` does **not** mean `unparsed`. It means "no extraction tier produced
 * this row", which is also true of every op a *client* authors — a CSV import, a
 * manual entry — and those carry real money. Only {@link Txn.unparsed} says the
 * row is empty. The implication runs one way and one way only:
 * `unparsed ⟹ tier === "none"`, enforced on decode.
 */
export type ParseTier = "template" | "heuristic" | "none";

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
  /**
   * `""` **only** when {@link Txn.unparsed} — nothing was extracted, so there is
   * no direction, and the type says so rather than leaving a consumer to
   * discover it. Narrow with {@link countsTowardMoney} before treating it as a
   * sign; `I12_money_shape` rejects `""` on any row that is not unparsed.
   */
  direction: "debit" | "credit" | "";
  /** RFC3339 UTC, canonicalised on decode so the fingerprint day is stable. */
  posted_at: string;
  merchant_raw: string;
  last4: string;
  category: string | null;
  needs_review: boolean;
  /**
   * No tier extracted anything: this row is a message that arrived, not money
   * that moved. `amount_minor` is `0n`, `currency` and `direction` are `""`, and
   * `amount_home_minor` is null and stays null.
   *
   * # Why the row exists at all
   *
   * Spec §2's drop policy. The pipeline appends an op for every message it
   * accepts, resolved or not (`pipeline.go` step 7: *"nothing matched — still
   * appended, flagged unparsed"*), because a message that exists nowhere cannot
   * answer "my transactions stopped appearing". The review queue is where it
   * surfaces, joined to its cold-stream raw body by {@link Txn.ingest_id}, and a
   * later template fix supersedes it into a real transaction.
   *
   * # What every consumer owes it
   *
   * **Exclusion from money math**, via {@link countsTowardMoney} rather than by
   * re-deriving the rule. Treating one as a zero-amount debit is not a visible
   * error — it adds zero to a total — it is a row that silently joins the
   * transaction count, the direction split and the currency breakdown of a
   * budget it has no business being in.
   */
  unparsed: boolean;
  /** Which tier produced this row. See {@link ParseTier}: `"none"` is not `unparsed`. */
  tier: ParseTier;
  /**
   * Why the cascade gave up, when the pipeline says. Null on a parsed row, and
   * null on an unparsed one whose writer offered no reason — which is every one
   * of them today, since the Go pipeline does not yet emit this field.
   *
   * Constrained on decode to a short lower-snake token, never free text: this
   * rides in the HOT stream, which the cold stream exists to keep email bodies
   * out of. A reason that could carry a fragment of a message body would put
   * plaintext in the one lane designed not to hold it.
   */
  parse_error: string | null;
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
  /** Server-attested template origin; absent on schema-v1 transactions. */
  verified_origin_domain?: string | null;
  /** Durable v2 answer to the heuristic notice; absent/null means unanswered. */
  duplicate_disposition?: "same" | "different" | null;
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
  /** Canonical authored_at of the positional op that installed each explicit rate head. */
  rateUpdatedAt: Map<string, string>;
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
    rateUpdatedAt: new Map(),
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

/**
 * Reports whether a row carries money an aggregate may sum, count or bucket.
 *
 * The single place the rule lives, so that a total, a count, a direction split
 * and a currency breakdown cannot each answer it differently. It is a function
 * rather than a comment because "every aggregate excludes unparsed rows" is only
 * true if every aggregate calls the same thing.
 */
export function countsTowardMoney(t: Txn): boolean {
  return !t.unparsed;
}

/**
 * Files a live, unfrozen transaction under its currency for later conversion.
 *
 * An unparsed row is refused entry. Its currency is `""`, which `rate_set`
 * cannot name — `currencyOf` requires three letters — so the bucket it would sit
 * in is one no op in the vocabulary can ever drain, and it would grow with every
 * unresolved message for the life of the log. The guard lives here rather than at
 * the two call sites because the index's meaning is defined here.
 */
export function markPending(s: State, t: Txn): void {
  if (t.unparsed) return;
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
 * `last4|amount|direction|merchant|day`, and `unparsed|ingest_id` for a row that
 * has none of those.
 *
 * Three things about it are deliberate:
 *
 *   - **The day comes from the parsed instant, not from slicing the string.**
 *     `2026-06-05T22:00:00-04:00` is the 6th in UTC; a substring would read the
 *     5th and manufacture a collision one executor sees and the other does not.
 *     It is computed by {@link utcDay}, arithmetically, with no `Date`.
 *   - **An unparsed row is fingerprinted on its ingest id**, because the five
 *     fields above are empty for every one of them and would collapse the whole
 *     day's backlog into a single bucket. The two forms cannot collide: see the
 *     body.
 *   - **`|` is not escaped**, so a merchant containing a pipe can in principle
 *     collide with a different transaction. That is accepted rather than fixed
 *     because a fingerprint hit is only ever a *notice* — it never drops, merges
 *     or hides anything — so the cost of a false positive is one review item,
 *     while escaping would put a second string-mangling rule into the frozen
 *     cross-executor contract.
 */
export function fingerprint(t: Txn): string {
  // An unparsed row has nothing to fingerprint ON: last4, amount, direction and
  // merchant are all empty by construction, so the heuristic form collapses to
  // `||0|||day` and EVERY unresolved message on a given day becomes a possible
  // duplicate of every other. Phase 1's exit run produced 18 such anomalies from
  // a corpus of two distinct messages, which is what a review queue built on
  // this would show a user on their first week.
  //
  // The ingest id is the right discriminator and not merely a unique one: it is
  // the sha256 of the raw body, so it is exactly the identity dedup already keys
  // on (spec §3.3:67), and `liveByIngestID` guarantees at most one live row per
  // value — a second ingest of the same email is a `duplicate_ingest` anomaly
  // and a supersede retires its predecessor out of the index first. So this is
  // still the duplicate heuristic, applied to the only field an unparsed message
  // has, rather than a special case that opts out of it.
  //
  // The two forms occupy DISJOINT namespaces structurally: the parsed form emits
  // four separators unconditionally, so a two-segment value is unreachable from
  // it no matter what a merchant contains. That matters because `|` is not
  // escaped (below) — a discriminator that relied on a prefix no merchant
  // happens to spell would be a rule a user could break by typing.
  //
  // "The unparsed form emits exactly one separator" is the half of that argument
  // this line does not prove on its own, and it is not free: it holds because
  // `validateOp` in `wire/op.ts` requires `ingest_id` to be 64 LOWER-CASE HEX
  // characters on `txn_ingested` and `txn_superseded` (`isSHA256Hex`), and hex
  // cannot contain a `|`. Weaken that check to "a non-empty string" and an op
  // assembled in code with `ingest_id = "1|debit|ACME|2026-01-01"` lands in the
  // five-segment parsed namespace and collides with a real row. The dependency
  // is written out at the check itself; do not relax one without the other.
  if (t.unparsed) return `unparsed|${t.ingest_id}`;
  return `${t.last4}|${t.amount_minor}|${t.direction}|${t.merchant_raw}|${utcDay(parseInstantMs(t.posted_at))}`;
}

/**
 * The UTC calendar day of an epoch-millisecond instant, `YYYY-MM-DD`.
 *
 * # Why this is not `new Date(ms).toISOString().slice(0, 10)`
 *
 * That expression was inside {@link fingerprint}, which is inside the frozen
 * cross-executor contract, and it had two defects — one live, one waiting.
 *
 *   1. **It could crash the fold.** `posted_at` is stored canonicalised
 *      (`canonicalTime`), and the wire grammar admits a four-digit year with an
 *      offset up to ±23:59 — so `9999-12-31T23:59:59-23:59` canonicalises to
 *      ISO *expanded-year* form, `"+010000-01-01T23:58:59.000Z"`. `slice(0, 10)`
 *      then reads `"+010000-01"`, and the re-parse this function had to perform
 *      to get there threw `BlobDecodeError` — which is not a `PayloadError`, so
 *      it escaped `applyOp`'s catch and took down the whole fold. One legal
 *      message, one device that can never sync again.
 *   2. **It made a frozen value depend on a `Date` round trip.** `Date` is the
 *      one part of the runtime this codebase already refuses to trust across
 *      executors (see `parseInstantMs`, which range-checks and computes the
 *      instant arithmetically rather than letting `Date.parse` have a say). The
 *      second executor of this engine will be Hermes, and putting a `Date`
 *      construction inside the value fork resolution and dedup compare is the
 *      same bet, taken again, in the one function whose output must be identical
 *      everywhere.
 *
 * So: integer arithmetic, no `Date`, no allocation, total over every finite
 * input. The civil-from-days algorithm is Howard Hinnant's, shifted to a
 * March-based year so the leap day lands at the end of the cycle; it is exact
 * for the whole proleptic Gregorian calendar, and `replay.test.ts` pins it
 * against the expression it replaces across the range where that expression was
 * trustworthy at all.
 *
 * Years outside 0000-9999 are written with an explicit sign and six digits, the
 * ISO expanded form — a whole date rather than the truncated fragment the old
 * expression produced, and unambiguous against the four-digit form.
 */
export function utcDay(epochMs: number): string {
  const days = Math.floor(epochMs / 86_400_000);
  // Shift the era origin to 0000-03-01 so February is the last month of the
  // year and no leap-day special case is needed anywhere below.
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // day of era, 0..146096
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // 0..365, from March 1
  const mp = Math.floor((5 * doy + 2) / 153); // 0..11, March = 0
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${padYear(year)}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function padYear(y: number): string {
  if (y >= 0 && y <= 9999) return `${y}`.padStart(4, "0");
  const sign = y < 0 ? "-" : "+";
  return sign + `${Math.abs(y)}`.padStart(6, "0");
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
