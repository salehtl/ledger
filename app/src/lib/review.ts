/**
 * The review queue's decisions, as pure functions.
 *
 * This screen is not an edge case. Every DIB message currently lands in
 * `needs_review` — DKIM does not cover `Content-Type`, so the headers that say
 * how to decode the body are unsigned and the pipeline refuses to auto-trust
 * the decode (`ingest/pipeline.go`, `unsignedDecoding`). A DIB user therefore
 * confirms **every transaction by hand**, several times a day, for as long as
 * that stays true (item 0 of `docs/superpowers/NEEDS-SALEH.md` is the pending
 * product decision). So everything here is written for volume and repetition:
 * one keystroke-free confirm, a category grid ordered by what this user
 * actually uses, and a rule write-back so the same merchant is never asked
 * about twice.
 *
 * # Why so much of it is a pure function
 *
 * The same reason `frontend/src/lib/` exists in v1: a gesture threshold, a
 * lane assignment and an op payload are decisions, and a decision tested
 * through a rendered component is a decision tested through three layers of
 * things that can be wrong instead. `bun test` runs this file's whole suite in
 * milliseconds and never renders anything.
 *
 * The SQL half lives in `app/src/db/reviewQueue.ts`, which is tested against a
 * real SQLite database holding a real projection of a real fold.
 */

import { runeLength } from "@ledger/client/categorize/canon.ts";
import { MAX_CATEGORY_RUNES, MIN_CATEGORY_RUNES, MIN_EXACT_RUNES, subjectOf } from "@ledger/client/categorize/rules.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { countsTowardMoney, type ForkNotice, type Rule, type Txn } from "@ledger/client/replay/state.ts";
import type { Op } from "@ledger/client/wire/op.ts";

// ---------------------------------------------------------------------------
// 1. Why a row is here
// ---------------------------------------------------------------------------

/**
 * The four reasons a row can be in this queue, which are **four different
 * things** even though a user sees one "needs review" badge for all of them.
 *
 * The hot payload carries `tier`, `needs_review` and `unparsed` and nothing
 * else about why (`ingest/pipeline.go`'s `txnPayload`), so this is the finest
 * distinction the wire supports today. Where that is coarser than the truth it
 * is said out loud in {@link REVIEW_REASON_COPY} rather than papered over:
 * `unsigned_headers` covers both of `pipeline.go`'s reasons for flagging a
 * template-tier row (`unsignedDecoding` and `unattestedForward`) and the client
 * genuinely cannot tell which one fired. A `review_reason` token on the payload
 * would fix that; it is recorded in the task report as the one change that
 * would let this screen be more precise.
 */
export type ReviewReason =
  /** No tier extracted anything. There is no amount to check — only a message. */
  | "unreadable"
  /**
   * The heuristic tier read it. Spec §3.2 makes every heuristic result a review
   * item unconditionally: the tier is UAE/AED-shaped and would otherwise walk
   * foreign and promotional mail into a ledger.
   */
  | "pattern_guess"
  /**
   * A template read it, and the *authentication* was incomplete: the signature
   * did not cover the decoding headers, or the forward carried no attestation.
   * The numbers are usually right. This is the DIB case, and today it is
   * every DIB message.
   */
  | "unsigned_headers"
  /**
   * Neither a tier nor the pipeline: a row this device authored — a CSV import
   * or a manual entry — that asked to be reviewed. `tier: "none"` with
   * `unparsed: false` is exactly that shape, and it is NOT unparsed.
   */
  | "entered";

/**
 * Why one row is in the queue.
 *
 * The order of the tests is the point. `unparsed` is checked first because it
 * is the only field that means "there is nothing here" — `tier === "none"` does
 * **not** imply it (`state.ts`: every client-authored op reads as `"none"` and
 * carries real money), and reading the tier first would file every CSV import
 * under "we couldn't read this".
 */
export function reasonOf(t: Txn): ReviewReason {
  if (t.unparsed) return "unreadable";
  if (t.tier === "heuristic") return "pattern_guess";
  if (t.tier === "template") return "unsigned_headers";
  return "entered";
}

/** What the user is told, per reason. */
export interface ReasonCopy {
  /** One line, on the card. */
  title: string;
  /** Two sentences at most, under the title. */
  detail: string;
  /** Expanded on demand — the honest, technical version. */
  more: string;
  /**
   * `check` — look at the numbers; `enter` — there are no numbers, type them.
   * Drives which card body renders, so a new reason cannot silently render as
   * a blank card.
   */
  action: "check" | "enter";
}

/**
 * The copy, in one place, because these three sentences are the whole
 * difference between an honest screen and an alarming one.
 *
 * Two rules held here deliberately:
 *
 *  - **Nothing claims an attack.** `unsigned_headers` is the common case — every
 *    DIB message — and describing the common case as a possible forgery trains
 *    a user to confirm without reading, which is the one outcome that makes the
 *    flag worthless. It states what is and is not proven, and says the numbers
 *    are usually right, because they are.
 *  - **Nothing claims certainty we do not have.** The copy does not say *which*
 *    of the two authentication gaps fired, because the payload does not say.
 */
export const REVIEW_REASON_COPY: Record<ReviewReason, ReasonCopy> = {
  unreadable: {
    title: "We couldn't read this one",
    detail: "The message arrived and is kept in full, but no amount, merchant or date was found in it. Nothing has been added to your totals.",
    more:
      "No template matched this sender and the fallback pattern found no money in the text. The message itself is stored, so a later template fix can turn it into a real transaction on its own — or you can type it in now.",
    action: "enter",
  },
  pattern_guess: {
    title: "Read by a general pattern",
    detail: "No template covers this sender yet, so the amount and merchant were pulled out by a generic rule. Worth a glance before it counts.",
    more:
      "The fallback reader looks for UAE-shaped amounts and merchant lines. It is right often enough to be useful and wrong often enough that nothing it produces is ever trusted automatically.",
    action: "check",
  },
  unsigned_headers: {
    title: "Signed, but not the encoding",
    detail: "Your bank signed this message, but not the headers that say how the text is encoded. The details are usually right — a quick look is all this needs.",
    more:
      "DKIM lets a sender choose which headers its signature covers, and this sender left out the ones that decide how the body is decoded — or the message was forwarded without an attestation of that hop. The template read it normally; what is unproven is that the bytes were meant to be read the way we read them.",
    action: "check",
  },
  entered: {
    title: "Added by you",
    detail: "This came from an import or a manual entry rather than from an email, and it was left for review.",
    more: "Rows this device authored are marked as yours rather than as the server's; nothing about the sender was checked, because there is no sender.",
    action: "check",
  },
};

// ---------------------------------------------------------------------------
// 2. Lanes
// ---------------------------------------------------------------------------

/**
 * The four lanes, in the order the plan puts them: by how much the user can
 * actually do about them.
 */
export type Lane = "needs_review" | "unparsed" | "duplicate" | "forks";

export const LANES: readonly Lane[] = ["needs_review", "unparsed", "duplicate", "forks"];

export const LANE_TITLE: Record<Lane, string> = {
  needs_review: "To confirm",
  unparsed: "Couldn't read",
  duplicate: "Possible duplicates",
  forks: "Resolved edits",
};

/**
 * Which lane a transaction belongs to, or `null` if it is not a review item.
 *
 * **Lanes are disjoint**, and the precedence is not arbitrary:
 *
 *  1. A superseded row is nothing at all. It has been replaced — by a template
 *     fix, or by the user typing it in — and asking about it again would ask
 *     about a row that no longer represents anything.
 *  2. `unparsed` outranks everything else, because the question is different in
 *     kind: there is no amount to confirm, so a card offering "confirm" would
 *     confirm nothing.
 *  3. A duplicate notice outranks a plain review flag, because "is this the
 *     same purchase twice" has to be answered before "what category is it" is
 *     even a sensible question. A row that is both leaves the duplicate lane
 *     when the notice is dismissed and reappears under `needs_review`, which is
 *     the behaviour a test pins.
 *
 * Note what precedence 2 and 3 cannot collide over: since Task 7 an unparsed
 * row fingerprints on `unparsed|<ingest_id>`, and `liveByIngestID` allows one
 * live row per ingest id — so no unparsed row can ever be flagged as a
 * duplicate of another. Before that fix they ALL collided on `||0|||day` and
 * Phase 1's exit run produced 18 duplicate notices from two messages.
 */
export function laneOf(t: Txn): Lane | null {
  if (t.superseded_by !== null) return null;
  if (t.unparsed) return "unparsed";
  if (t.possible_duplicate_of !== null && (t.duplicate_disposition ?? null) === null) return "duplicate";
  if (t.needs_review) return "needs_review";
  return null;
}

// ---------------------------------------------------------------------------
// 3. Item identity — the fingerprint collapse must not come back
// ---------------------------------------------------------------------------

/**
 * The key a queue item is tracked by: dismissals, list keys, undo, everything.
 *
 * **It is the entity id and nothing else.** That is the whole defence against
 * re-creating the collapse Task 7 fixed one layer down. Every unparsed row has
 * the same amount (`0`), the same currency (`""`), the same direction (`""`),
 * the same (empty) merchant and, for a day's backlog, the same day — so ANY key
 * built from what the user can see would make every unparsed message of a day
 * one item. The user would answer one card and silently lose the rest.
 *
 * Entity ids are ULIDs assigned per op and are stable across a projection
 * rebuild (the projection is a pure function of the log), so this is both
 * unique and durable.
 */
export function itemKey(t: Txn): string {
  return `txn:${t.id}`;
}

/**
 * The key for one duplicate *notice*, which is a pair rather than a row.
 *
 * Ordered as `(flagged-against, flagged)` rather than sorted, because that is
 * the direction the notice was recorded in and the pair `(A,B)` is the same
 * notice however it is displayed. Both ids are in it: a row flagged against two
 * different earlier rows across a re-fold is two notices, not one.
 */
export function duplicateKey(t: Txn): string {
  return `dup:${t.possible_duplicate_of ?? ""}:${t.id}`;
}

/**
 * The key for a fork notice.
 *
 * Op ids, not the row index: `fork_notice.idx` is assigned by the projection
 * writer and would renumber on a rebuild, which would resurrect every notice
 * the user had dismissed. Op ids are the log's own identifiers and do not move.
 */
export function forkKey(f: ForkNotice): string {
  return `fork:${f.winner_op}:${f.loser_op}`;
}

/** One card in the deck. */
export interface ReviewItem {
  key: string;
  lane: Lane;
  reason: ReviewReason;
  txn: Txn;
  /**
   * The duplicate lane's other row, when it is still live. `null` means the row
   * this one was flagged against has since been superseded or is outside the
   * projection — the notice still shows, because `possible_duplicate_of` is a
   * snapshot of an answer and not a live claim (`state.ts`), and hiding it
   * would be the silent drop §3.3 forbids.
   */
  counterpart: Txn | null;
}

/** One resolved-fork card. */
export interface ForkItem {
  key: string;
  notice: ForkNotice;
}

// ---------------------------------------------------------------------------
// 4. Money, through the one predicate
// ---------------------------------------------------------------------------

/** What the queue header states about the money sitting in it. */
export interface ReviewMoney {
  /** Items whose amount an aggregate may sum. */
  counted: number;
  /** Items excluded because they carry no money at all. */
  excluded: number;
  /** Sum of the frozen home-currency snapshots of the counted items. */
  totalHomeMinor: bigint;
  /**
   * Counted items whose FX snapshot is still null — no rate head existed for
   * their currency at their position. They are in `counted` and NOT in
   * `totalHomeMinor`, so a screen that prints the total without printing this
   * is printing a number that is quietly short.
   */
  awaitingRate: number;
}

/**
 * Summarises a set of review rows for the queue header.
 *
 * The exclusion runs through {@link countsTowardMoney} rather than through a
 * local `!t.unparsed`, and that is the entire point of the function existing in
 * the library: `state.ts` says the rule is only true if every aggregate calls
 * the same thing, and this is one of the aggregates. An unparsed row adds `0`
 * to a sum, so getting this wrong is invisible in the total — it shows up as a
 * *count*, which is why the count is reported separately and asserted.
 */
export function reviewMoney(rows: Iterable<Txn>): ReviewMoney {
  let counted = 0;
  let excluded = 0;
  let awaitingRate = 0;
  let totalHomeMinor = 0n;
  for (const t of rows) {
    if (!countsTowardMoney(t)) {
      excluded++;
      continue;
    }
    counted++;
    if (t.amount_home_minor === null) awaitingRate++;
    else totalHomeMinor += t.amount_home_minor;
  }
  return { counted, excluded, totalHomeMinor, awaitingRate };
}

// ---------------------------------------------------------------------------
// 5. The gesture, as a decision
// ---------------------------------------------------------------------------

/** Travel past which a release commits, in points. */
export const COMMIT_PX = 96;
/** Points per second past which a release commits regardless of distance. */
export const COMMIT_VELOCITY = 0.5;
/**
 * A flick still needs enough travel to read as intentional. v1's harness found
 * that without a distance floor a fast tap registers as a swipe, which on this
 * screen would confirm a transaction the user only meant to look at.
 */
export const FLICK_MIN_PX = 24;
/**
 * How far off-axis a gesture may stray and still count. A card in a scrollable
 * list must not confirm because the user scrolled diagonally.
 */
export const AXIS_RATIO = 1.4;

export interface Gesture {
  /** Horizontal travel in points; right is positive. */
  dx: number;
  /** Vertical travel in points; down is positive. */
  dy: number;
  /** Horizontal velocity in points per millisecond, as React Native reports it. */
  vx: number;
}

export type SwipeOutcome = "confirm" | "skip" | "none";

/**
 * What a released drag means.
 *
 * Right confirms, left skips. Confirm is the right-hand direction because it is
 * the one a right-handed thumb makes most easily and it is the action this
 * queue asks for dozens of times a day; skip is the reversible one, so putting
 * it on the awkward side costs nothing.
 *
 * **This is a decision, not an animation.** React Native's `PanResponder` hands
 * the component `(dx, dy, vx)`; the component asks this what they mean. jsdom
 * cannot drive a real gesture, so the decision is what gets tested and the
 * gesture itself is unverified until it runs on a device — recorded as such in
 * the task report rather than implied to be covered.
 */
export function swipeOutcome(g: Gesture): SwipeOutcome {
  const far = Math.abs(g.dx) >= COMMIT_PX;
  const flicked = Math.abs(g.vx) >= COMMIT_VELOCITY && Math.abs(g.dx) >= FLICK_MIN_PX;
  if (!far && !flicked) return "none";
  // Off-axis check last: a drag that travelled further vertically than
  // horizontally is a scroll, however fast it was.
  if (Math.abs(g.dy) > Math.abs(g.dx) / AXIS_RATIO) return "none";
  return g.dx > 0 ? "confirm" : "skip";
}

// ---------------------------------------------------------------------------
// 6. Numeric entry: a string draft, converted once
// ---------------------------------------------------------------------------

/** The result of reading an amount field. */
export type AmountDraft = { ok: true; minor: bigint } | { ok: false; error: string };

/**
 * Reads a typed amount into minor units.
 *
 * **`Number()` appears nowhere in this function and must not.** `Number("") ===
 * 0`, which in v1 made a cleared field spring back to `0` and become
 * un-emptiable; here it would additionally mean a user who cleared the field
 * and hit save wrote a zero-amount transaction to an append-only log. The draft
 * stays a string until it is committed, and it is committed as `bigint`.
 *
 * An empty draft is an ERROR, never a zero — that distinction is the whole bug.
 */
export function parseAmountDraft(draft: string, exponent = 2): AmountDraft {
  const s = draft.trim();
  if (s === "") return { ok: false, error: "Enter an amount" };
  if (!/^[0-9]*\.?[0-9]*$/.test(s) || s === ".") {
    return { ok: false, error: "Digits and one decimal point only" };
  }
  const dot = s.indexOf(".");
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? "" : s.slice(dot + 1);
  if (frac.length > exponent) {
    return { ok: false, error: exponent === 0 ? "This currency has no fils" : `At most ${exponent} decimal places` };
  }
  const minor = BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(exponent) + BigInt(frac === "" ? "0" : frac.padEnd(exponent, "0"));
  if (minor <= 0n) return { ok: false, error: "An amount has to be more than zero" };
  return { ok: true, minor };
}

/** ISO-4217 shape, upper-cased. The wire refuses anything else. */
export function normalizeCurrencyDraft(draft: string): string | null {
  const s = draft.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// 7. Versions — the self-fork this screen would otherwise ship
// ---------------------------------------------------------------------------

/**
 * The `parent_version` the next op for `entityId` must name.
 *
 * # Why the projection's version is not the answer
 *
 * A queue like this one is used offline and in bursts. The projection only
 * moves when a fold runs, and a fold only runs after a push and a pull — so
 * every op the user authors in a session sees the SAME projected version. Two
 * ops naming the same parent are, by `replay.ts`'s definition, a true
 * concurrent fork: the second is resolved against the first by author
 * timestamp, and inside one millisecond (or on a tie) *the user's later op is
 * the one discarded*. A confirm followed by an undo would drop the undo, and
 * the queue would show a fork notice for a fork the user never made.
 *
 * So the next parent is the highest version the log will hold once everything
 * already queued has been folded: each pending op naming parent `P` produces
 * version `P + 1`.
 *
 * A create (`parent_version: null`) among the pending ops is not counted — it
 * produces version 1 for a *different* entity id, and this is only ever asked
 * about an entity that already exists.
 */
export function nextParentVersion(entityId: string, projectedVersion: number, pending: readonly Op[]): number {
  let v = projectedVersion;
  for (const op of pending) {
    if (op.entity?.id !== entityId) continue;
    if (op.parent_version === null) continue;
    if (op.parent_version + 1 > v) v = op.parent_version + 1;
  }
  return v;
}

// ---------------------------------------------------------------------------
// 8. The ops an answer produces
// ---------------------------------------------------------------------------

/** A category, as the queue will emit it. */
export function categoryIsUsable(category: string): boolean {
  const n = runeLength(category.trim());
  return n >= MIN_CATEGORY_RUNES && n <= MAX_CATEGORY_RUNES;
}

/**
 * The pattern a rule write-back would use, or `null` when the merchant string
 * cannot carry one.
 *
 * `subjectOf` is `categorize/rules.ts`'s own canonicaliser — exported there
 * explicitly so that this screen can show the user the string their rule will
 * actually be tested against, rather than a prettier one that would match
 * differently.
 *
 * `exact` rather than `contains`: a `contains` rule written from one card
 * silently re-categorises every merchant whose name contains this one, and a
 * user confirming a card is answering about a merchant, not writing a policy.
 * Task 20 owns matching; a `contains` rule remains something a user can write
 * deliberately in settings.
 */
export function ruleTargetOf(merchantRaw: string): string | null {
  const subject = subjectOf(merchantRaw);
  if (runeLength(subject) < MIN_EXACT_RUNES) return null;
  return subject;
}

export interface ConfirmArgs {
  txn: Txn;
  /** `null` confirms the row as it stands without setting a category. */
  category: string | null;
  /** The version the projection currently holds for this row. */
  projectedVersion: number;
  /** Ops already queued on this device, for {@link nextParentVersion}. */
  pending: readonly Op[];
  /**
   * Every rule already materialised, so a merchant confirmed twice does not
   * write the same rule twice. Keyed as the projection keys them.
   */
  rules: Iterable<Rule>;
  /** A ULID source. Injected so a test can pin ids. */
  newID: () => string;
}

/**
 * What confirming one card emits: the categorisation, and — first time only —
 * the rule that means this merchant is never asked about again.
 *
 * Returned as a list and enqueued together so that ONE flush carries both. The
 * plan asks for exactly that, and the reason is not tidiness: an app killed
 * between two flushes would leave a categorised transaction with no rule, and
 * the next message from the same merchant would ask the user the same question
 * they already answered.
 *
 * `txn_categorized` carries `needs_review: false` and that is what clears the
 * flag — there is no separate "confirmed" op, and adding a `txn_edited` to do
 * it would be a second op consuming a second version for one user action.
 */
export function confirmOps(args: ConfirmArgs): OpSpec[] {
  const { txn, category, projectedVersion, pending, newID } = args;
  const parent = nextParentVersion(txn.id, projectedVersion, pending);
  const specs: OpSpec[] = [
    {
      type: "txn_categorized",
      entity: { kind: "txn", id: txn.id },
      parentVersion: parent,
      payload: { category, needs_review: false },
    },
  ];
  if (category === null || !categoryIsUsable(category)) return specs;
  const pattern = ruleTargetOf(txn.merchant_raw);
  if (pattern === null) return specs;
  for (const r of args.rules) {
    if (r.match === "exact" && r.pattern === pattern && r.category === category) return specs;
  }
  specs.push({
    type: "rule_added",
    entity: { kind: "rule", id: newID() },
    parentVersion: null,
    payload: { pattern, match: "exact", category, priority: 0 },
  });
  return specs;
}

export interface UndoConfirmArgs {
  txn: Txn;
  projectedVersion: number;
  pending: readonly Op[];
}

/**
 * Undoing a confirm.
 *
 * The log is append-only, so this is a compensating op rather than a deletion:
 * the row goes back to the category it had and back to `needs_review`, and both
 * ops stay in the log forever. That is the honest model and it is also the only
 * one available — nothing in the op vocabulary removes an op.
 *
 * The rule write-back is deliberately NOT undone. A user who said "this
 * merchant is Groceries" and then corrected the *transaction* has not
 * necessarily retracted the merchant rule, and silently deleting a rule they
 * would then have to rediscover is worse than leaving one they can edit.
 */
export function undoConfirmOps(args: UndoConfirmArgs): OpSpec[] {
  const { txn, projectedVersion, pending } = args;
  return [
    {
      type: "txn_categorized",
      entity: { kind: "txn", id: txn.id },
      parentVersion: nextParentVersion(txn.id, projectedVersion, pending),
      payload: { category: txn.category, needs_review: true },
    },
  ];
}

export interface ManualEntryArgs {
  /** The unparsed row being replaced. Its ingest id is what ties the two together. */
  txn: Txn;
  amountMinor: bigint;
  currency: string;
  direction: "debit" | "credit";
  /** RFC3339. Defaults to the unparsed row's own `posted_at` in the UI. */
  postedAt: string;
  merchantRaw: string;
  last4: string;
  category: string | null;
  newID: () => string;
}

/**
 * Typing in a message no tier could read.
 *
 * # Why this is a supersede and not an edit
 *
 * `txn_edited` may not touch `amount_minor`, `currency`, `direction`,
 * `unparsed`, `tier` or `parse_error` — `replay.ts`'s `PARSE_OWNED` list, and
 * an edit that named one is recorded as an `unsupported_edit_field` anomaly
 * rather than applied. Those fields come from reading the message, and
 * re-reading a message is what `txn_superseded` is for. It is also the only op
 * that recomputes the FX snapshot at its own log position, which a row acquiring
 * an amount for the first time obviously needs.
 *
 * So the user's entry re-creates the transaction under a NEW entity id carrying
 * the SAME `ingest_id`: replay retires the unparsed row (`liveByIngestID` holds
 * one live row per ingest id) and the new row takes its place, with the
 * original still in the log and still inspectable. The provenance of the new
 * row is `user`, derived from the writer this device signs with — the §3.3(b)
 * distinction the transactions screen shows, and one a payload field could not
 * be trusted to make.
 *
 * `unparsed` is left off the payload entirely: a row carrying an amount is not
 * unparsed, and `decodeTxnPayload` enforces the biconditional in both
 * directions, so an entry that tried to claim both would be refused as an
 * `invalid_payload` anomaly rather than folded.
 */
export function manualEntryOps(args: ManualEntryArgs): OpSpec[] {
  if (args.amountMinor <= 0n) throw new Error("a manual entry needs a positive amount");
  if (!/^[A-Z]{3}$/.test(args.currency)) throw new Error(`currency ${JSON.stringify(args.currency)} is not ISO-4217 alpha-3`);
  if (args.txn.ingest_id === "") throw new Error("the row being superseded carries no ingest id");
  return [
    {
      type: "txn_superseded",
      entity: { kind: "txn", id: args.newID() },
      parentVersion: null,
      ingestId: args.txn.ingest_id,
      payload: {
        amount_minor: args.amountMinor.toString(10),
        currency: args.currency,
        direction: args.direction,
        posted_at: args.postedAt,
        merchant_raw: args.merchantRaw,
        last4: args.last4,
        category: args.category,
        needs_review: false,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 9. What is already answered but not yet folded
// ---------------------------------------------------------------------------

/** Entities and messages that an already-queued op has settled. */
export interface Settlement {
  entityIDs: ReadonlySet<string>;
  ingestIDs: ReadonlySet<string>;
}

/**
 * Which rows the outbox has already answered.
 *
 * # The bug this exists to prevent
 *
 * The queue reads the *projection*, and the projection only moves when a fold
 * runs — which happens after a push and a pull. So for the whole of an offline
 * session, every row the user has confirmed is still `needs_review = 1` in
 * SQLite, and the next refresh puts all of them back on the deck. A user
 * confirming thirty transactions on a plane would be handed the same thirty
 * again.
 *
 * # Why it is derived from the outbox rather than remembered
 *
 * A `Set` of "cards I have dealt with" in component state is lost when the app
 * is killed, and the ops are not — `Client.emit` commits before it returns. The
 * two would then disagree exactly when it matters: after a crash mid-session.
 * The outbox is the durable record of what the user has answered, so it is the
 * thing to ask.
 *
 * A manual entry is matched by **ingest id** rather than by entity id, because
 * `txn_superseded` creates a *new* entity: the row the user typed over is a
 * different id from the row that replaces it, and only the ingest id ties them
 * together.
 */
export function settledBy(pending: readonly Op[]): Settlement {
  const entityIDs = new Set<string>();
  const ingestIDs = new Set<string>();
  for (const op of pending) {
    if (op.type === "txn_categorized" || op.type === "txn_edited" || op.type === "txn_split") {
      if (op.entity !== undefined) entityIDs.add(op.entity.id);
    } else if (op.type === "txn_superseded") {
      if (op.ingest_id !== undefined && op.ingest_id !== "") ingestIDs.add(op.ingest_id);
    }
  }
  return { entityIDs, ingestIDs };
}

/** Whether a row has an answer already queued. */
export function isSettled(t: Txn, s: Settlement): boolean {
  return s.entityIDs.has(t.id) || s.ingestIDs.has(t.ingest_id);
}

// ---------------------------------------------------------------------------
// 10. Dismissals — what the log cannot say
// ---------------------------------------------------------------------------

/**
 * A user's answer to a notice that the op log has no way to record.
 *
 * Duplicate answers are durable in schema v2 via `txn_duplicate_disposition`.
 * The local disposition table remains useful for immediate UX and the other
 * notice kinds, but it is not the authority for a duplicate answer.
 */
export type Disposition =
  /** Unparsed lane: the message was not a financial transaction. */
  | "not_transaction"
  /** Duplicate lane: "these are different purchases". */
  | "not_duplicate"
  /** Duplicate lane: "yes, this is the same purchase twice". Both rows stay live. */
  | "duplicate_confirmed"
  /** Fork lane: the user has read the notice. */
  | "acknowledged";

export const DISPOSITION_KINDS: readonly Disposition[] = ["not_transaction", "not_duplicate", "duplicate_confirmed", "acknowledged"];

export function isDisposition(s: string): s is Disposition {
  return (DISPOSITION_KINDS as readonly string[]).includes(s);
}

/** A cross-device dismissal (or undo) of the duplicate notice itself. */
export function duplicateDispositionOp(args: {
  txn: Txn;
  projectedVersion: number;
  pending: readonly Op[];
  disposition: "same" | "different" | null;
}): OpSpec {
  if (args.txn.possible_duplicate_of === null) throw new Error("duplicate disposition requires a counterpart");
  return {
    type: "txn_duplicate_disposition",
    entity: { kind: "txn", id: args.txn.id },
    parentVersion: nextParentVersion(args.txn.id, args.projectedVersion, args.pending),
    payload: { other_txn_id: args.txn.possible_duplicate_of, disposition: args.disposition },
  };
}
