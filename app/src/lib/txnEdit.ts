/**
 * Editing a transaction — which is emitting an op, not mutating a row.
 *
 * # The distinction this file exists to enforce
 *
 * There is no `UPDATE txn SET …` anywhere. A user's correction is an op with a
 * parent version, appended to a log, folded on every device. Three consequences
 * shape everything below:
 *
 *  1. **The parent version is read at emit time, never remembered.** A screen
 *     that captured `version` when it opened and emitted against it minutes
 *     later would fork the entity against a sync that landed in between — a real
 *     fork, with a notice, for an edit nobody made concurrently. Every `commit*`
 *     here re-reads the row from the projection first.
 *  2. **`txn_edited` cannot change money.** `amount_minor`, `currency`,
 *     `direction`, `unparsed`, `tier` and `parse_error` are `PARSE_OWNED` in
 *     `replay.ts`: an edit naming one is *recorded as rejected* and the field
 *     does not move. So a correction to an amount is a **`txn_superseded`** — a
 *     new row for the same `ingest_id`, which retires the old one and recomputes
 *     its FX snapshot at its own log position (§3.7:129). {@link planTxnEdit}
 *     routes on exactly that, and the routing is the interesting part of the
 *     file.
 *  3. **Rescuing an unparsed row is that same supersede.** A message no tier
 *     could read has `amount_minor: 0n`, `currency: ""` and `direction: ""`, so
 *     *every* money field the user supplies is a change to a `PARSE_OWNED` one.
 *     A `txn_edited` would land, consume a version, change nothing, and report
 *     `unsupported_edit_field` — the silent-no-op shape §2 forbids. It is the
 *     row most in need of an edit path, and it is precisely the row a naive edit
 *     path fails on.
 *
 * # What the vocabulary cannot express, and is therefore refused
 *
 * **Un-splitting.** v1 had it: an empty split set returned the parent to the
 * review queue. Here `precheck` refuses a `txn_split` whose parts do not sum to
 * the parent, and an empty set sums to `0n`, so an "un-split" op would land as a
 * `split_sum` anomaly and change nothing. {@link planSplit} refuses it in the UI
 * with a reason rather than emitting an op that will be ignored. Recorded in the
 * task report as a gap in the op vocabulary, not papered over here.
 *
 * # Numeric entry is a string draft, all the way to the boundary
 *
 * Amounts arrive as the text the user typed and are converted exactly once, in
 * {@link planTxnEdit} / {@link planSplit}, by `parseAmountDraft`. No `Number()`
 * is reachable from anything in this file.
 */

import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import type { SqlDriver } from "@ledger/client/store/driver.ts";
import type { Txn } from "@ledger/client/replay/state.ts";
import { countsTowardMoney } from "@ledger/client/replay/state.ts";

import { isDayDraft, withDay } from "./format.ts";
import { MAX_MINOR, parseAmountDraft, sumMinor } from "./money.ts";
import { readTxn, type Direction } from "./transactions.ts";

/** Everything a detail screen can change. Absent means "leave it alone". */
export interface TxnEditDraft {
  merchant?: string;
  last4?: string;
  /** `YYYY-MM-DD`. The time of day is preserved — see {@link withDay}. */
  day?: string;
  category?: string | null;
  needsReview?: boolean;
  /** The text in the amount field, converted once, here. */
  amount?: string;
  currency?: string;
  direction?: Direction;
}

/** One line of the split editor. The amount is the user's text, not a number. */
export interface SplitDraftLine {
  category: string;
  amount: string;
}

/**
 * What an edit turns into.
 *
 * `rescue` is called out separately from `edit` because it is a different thing
 * to the user as well as to the log: the row gets a **new entity id**, so a
 * screen holding the old one has to follow it.
 */
export type EditPlan =
  | { kind: "noop" }
  | { kind: "invalid"; errors: string[] }
  | { kind: "edit"; op: OpSpec }
  | { kind: "rescue"; op: OpSpec; newId: string };

export type CommitResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; ops: OpSpec[]; newId: string | null }
  | { ok: false; errors: string[] };

/** What a commit needs: the projection to re-read from, and somewhere to queue. */
export interface EditDeps {
  db: SqlDriver;
  /** `Outbox.enqueue`. It validates and persists before it returns. */
  enqueue: (spec: OpSpec) => void;
  /** A fresh entity id for a supersede. `ulid` in the app; a counter in tests. */
  newId: () => string;
}

// ---------------------------------------------------------------------------
// Planning — pure
// ---------------------------------------------------------------------------

/**
 * Decides what op (if any) a draft means, against the row as it stands.
 *
 * Returns at most **one** op. Two ops for one user action would need the second
 * to name `version + 1`, a head this device is predicting rather than reading,
 * and a concurrent op arriving between them turns the prediction into a fork.
 * So a change that touches both a category and a merchant is one `txn_edited`
 * carrying both, and a change that touches only the category is the narrower
 * `txn_categorized`.
 */
export function planTxnEdit(current: Txn, draft: TxnEditDraft, newId: () => string): EditPlan {
  const errors: string[] = [];

  if (current.superseded_by !== null) {
    return {
      kind: "invalid",
      errors: ["This row was replaced when the message was re-read. Edit the row that replaced it."],
    };
  }

  // -- the fields an edit may carry -----------------------------------------
  const changes: Record<string, unknown> = {};

  if (draft.merchant !== undefined) {
    const merchant = draft.merchant.trim();
    if (merchant !== current.merchant_raw) changes["merchant_raw"] = merchant;
  }
  if (draft.last4 !== undefined) {
    const last4 = draft.last4.trim();
    if (!/^\d{0,4}$/.test(last4)) errors.push("Card digits are up to four digits, or blank.");
    else if (last4 !== current.last4) changes["last4"] = last4;
  }
  let postedAt: string | null = null;
  if (draft.day !== undefined) {
    if (!isDayDraft(draft.day)) errors.push("Choose a real date.");
    else {
      try {
        const next = withDay(current.posted_at, draft.day);
        if (next !== current.posted_at) postedAt = next;
      } catch {
        errors.push("That date is outside the range this ledger can record.");
      }
    }
  }
  if (postedAt !== null) changes["posted_at"] = postedAt;

  let category: string | null | undefined;
  if (draft.category !== undefined) {
    category = draft.category === null ? null : draft.category.trim() === "" ? null : draft.category.trim();
    if (category === current.category) category = undefined;
  }
  const needsReview = draft.needsReview !== undefined && draft.needsReview !== current.needs_review ? draft.needsReview : undefined;

  // -- the fields only a supersede may carry --------------------------------
  let amount: bigint | null = null;
  if (draft.amount !== undefined) {
    const parsed = parseAmountDraft(draft.amount);
    if (parsed.kind === "empty") errors.push("Enter an amount.");
    else if (parsed.kind === "invalid") errors.push(`That amount doesn't look right — ${parsed.reason}.`);
    else if (parsed.minor <= 0n) errors.push("An amount has to be more than zero.");
    else amount = parsed.minor;
  }
  let currency: string | null = null;
  if (draft.currency !== undefined) {
    const code = draft.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) errors.push("A currency is a three-letter code, like AED.");
    else currency = code;
  }
  const direction = draft.direction ?? null;
  if (draft.direction !== undefined && draft.direction !== "debit" && draft.direction !== "credit") {
    errors.push("Choose money in or money out.");
  }

  if (errors.length > 0) return { kind: "invalid", errors };

  const moneyChanged =
    (amount !== null && amount !== current.amount_minor) ||
    (currency !== null && currency !== current.currency) ||
    (direction !== null && direction !== current.direction);

  if (moneyChanged) {
    return planRescue(current, {
      amount,
      currency,
      direction,
      postedAt,
      merchant: typeof changes["merchant_raw"] === "string" ? (changes["merchant_raw"] as string) : null,
      last4: typeof changes["last4"] === "string" ? (changes["last4"] as string) : null,
      category,
      newId,
    });
  }

  // A row with no amount cannot be edited into one by a `txn_edited`, so an
  // attempt to fix everything EXCEPT the money on an unparsed row is allowed —
  // the merchant of an unreadable message is worth keeping — but it stays
  // unparsed, and the screen must not present it as a repair.
  if (category !== undefined) changes["category"] = category;
  if (needsReview !== undefined) changes["needs_review"] = needsReview;

  if (Object.keys(changes).length === 0) return { kind: "noop" };

  // The narrow op when the change is narrow: `txn_categorized` is what Task 19's
  // review deck emits, and what a rule write-back pairs with.
  const onlyCategorization = Object.keys(changes).every((k) => k === "category" || k === "needs_review");
  if (onlyCategorization) {
    return {
      kind: "edit",
      op: {
        type: "txn_categorized",
        entity: { kind: "txn", id: current.id },
        parentVersion: current.version,
        payload: {
          category: category === undefined ? current.category : category,
          needs_review: needsReview === undefined ? current.needs_review : needsReview,
        },
      },
    };
  }
  return {
    kind: "edit",
    op: {
      type: "txn_edited",
      entity: { kind: "txn", id: current.id },
      parentVersion: current.version,
      payload: changes,
    },
  };
}

interface RescueFields {
  amount: bigint | null;
  currency: string | null;
  direction: Direction | null;
  postedAt: string | null;
  merchant: string | null;
  last4: string | null;
  category: string | null | undefined;
  newId: () => string;
}

/**
 * The supersede: a new row for the same `ingest_id`.
 *
 * It is a CREATE — `parent_version: null` — with a new entity id, because that
 * is what `txn_superseded` is in the vocabulary: `createTxn` retires whatever is
 * live under the ingest id and files this one in its place. Reusing the old id
 * would be a `duplicate_create` anomaly and no new row at all.
 *
 * Nothing is inherited from the row being replaced except what is passed in
 * explicitly. In particular `amount_home_minor` is **not** carried: §3.7:129
 * says a supersede recomputes at its own position, and the fold does that as
 * soon as this op lands.
 */
function planRescue(current: Txn, f: RescueFields): EditPlan {
  const errors: string[] = [];
  const amount = f.amount ?? (current.amount_minor > 0n ? current.amount_minor : null);
  const currency = f.currency ?? (current.currency === "" ? null : current.currency);
  const direction = f.direction ?? (current.direction === "" ? null : current.direction);

  if (amount === null) errors.push("Enter an amount.");
  else if (amount > MAX_MINOR) errors.push("That amount is larger than this ledger can hold.");
  if (currency === null) errors.push("Choose a currency.");
  if (direction === null) errors.push("Choose money in or money out.");
  if (errors.length > 0) return { kind: "invalid", errors };

  const id = f.newId();
  if (id === "" || id === current.id) {
    // A supersede that reuses the id is a `duplicate_create` and produces no
    // row, so this is refused loudly rather than queued.
    return { kind: "invalid", errors: ["Could not allocate an id for the corrected transaction."] };
  }
  const category = f.category === undefined ? current.category : f.category;
  return {
    kind: "rescue",
    newId: id,
    op: {
      type: "txn_superseded",
      entity: { kind: "txn", id },
      parentVersion: null,
      ingestId: current.ingest_id,
      payload: {
        amount_minor: (amount as bigint).toString(10),
        currency: currency as string,
        direction: direction as Direction,
        posted_at: f.postedAt ?? current.posted_at,
        merchant_raw: f.merchant ?? current.merchant_raw,
        last4: f.last4 ?? current.last4,
        category,
        // The user just typed this row out; it does not need reviewing.
        needs_review: false,
        // A client-authored row: no extraction tier produced it, and it is NOT
        // unparsed — `tier: "none"` with `unparsed: false` is every op a client
        // writes (see `decodeTxnPayload`'s note on the converse).
        tier: "none",
        unparsed: false,
      },
    },
  };
}

export type SplitPlan = { kind: "invalid"; errors: string[] } | { kind: "split"; op: OpSpec };

/**
 * A split, checked against `I8_split_sum` before it is emitted.
 *
 * The sum check is here rather than only in `precheck` because a refusal in the
 * fold is invisible to the person who typed it: the op lands, consumes no
 * version, records a `split_sum` anomaly and changes nothing on the screen.
 * Catching it at the keyboard is the difference between "lines must add up" and
 * "nothing happened".
 */
export function planSplit(current: Txn, lines: readonly SplitDraftLine[]): SplitPlan {
  if (current.superseded_by !== null) {
    return { kind: "invalid", errors: ["This row was replaced when the message was re-read."] };
  }
  if (!countsTowardMoney(current)) {
    return { kind: "invalid", errors: ["There is no amount to split yet — add one first."] };
  }
  if (lines.length === 0) {
    // Not an omission: see the file header. An empty `parts` sums to 0n and the
    // fold refuses it, so offering "un-split" here would be offering a button
    // that does nothing.
    return { kind: "invalid", errors: ["A split needs at least one part. Splits can't be removed yet."] };
  }
  const errors: string[] = [];
  const parts: { category: string; amount_minor: string }[] = [];
  const amounts: bigint[] = [];
  for (const [i, line] of lines.entries()) {
    const category = line.category.trim();
    if (category === "") errors.push(`Part ${i + 1} needs a category.`);
    const parsed = parseAmountDraft(line.amount);
    if (parsed.kind !== "ok") errors.push(`Part ${i + 1} needs an amount.`);
    else if (parsed.minor <= 0n) errors.push(`Part ${i + 1} has to be more than zero.`);
    else {
      amounts.push(parsed.minor);
      parts.push({ category, amount_minor: parsed.minor.toString(10) });
    }
  }
  if (errors.length > 0) return { kind: "invalid", errors };
  const sum = sumMinor(amounts);
  if (sum !== current.amount_minor) {
    errors.push("The parts have to add up to the whole amount.");
    return { kind: "invalid", errors };
  }
  return {
    kind: "split",
    op: {
      type: "txn_split",
      entity: { kind: "txn", id: current.id },
      parentVersion: current.version,
      payload: { parts },
    },
  };
}

// ---------------------------------------------------------------------------
// Committing — re-reads the head, then queues
// ---------------------------------------------------------------------------

/**
 * Re-reads the row, plans against what it says NOW, and queues the result.
 *
 * The re-read is the whole point: Task 18 Step 3 says the head version comes
 * from the projection and a stale head must be re-read before emit, never
 * assumed. It is one indexed lookup by primary key.
 */
export function commitTxnEdit(deps: EditDeps, id: string, draft: TxnEditDraft): CommitResult {
  const current = readTxn(deps.db, id);
  if (current === null) return { ok: false, errors: ["That transaction is no longer on this device."] };
  const plan = planTxnEdit(current, draft, deps.newId);
  switch (plan.kind) {
    case "noop":
      return { ok: true, changed: false };
    case "invalid":
      return { ok: false, errors: plan.errors };
    case "edit":
      deps.enqueue(plan.op);
      return { ok: true, changed: true, ops: [plan.op], newId: null };
    case "rescue":
      deps.enqueue(plan.op);
      return { ok: true, changed: true, ops: [plan.op], newId: plan.newId };
  }
}

/** The narrow path the review deck and the category picker use. */
export function commitCategorize(deps: EditDeps, id: string, category: string | null, needsReview = false): CommitResult {
  return commitTxnEdit(deps, id, { category, needsReview });
}

export function commitSplit(deps: EditDeps, id: string, lines: readonly SplitDraftLine[]): CommitResult {
  const current = readTxn(deps.db, id);
  if (current === null) return { ok: false, errors: ["That transaction is no longer on this device."] };
  const plan = planSplit(current, lines);
  if (plan.kind === "invalid") return { ok: false, errors: plan.errors };
  deps.enqueue(plan.op);
  return { ok: true, changed: true, ops: [plan.op], newId: null };
}
