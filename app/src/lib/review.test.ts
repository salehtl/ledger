/**
 * The review queue's decisions.
 *
 * Two things are worth knowing before reading:
 *
 *  - **The op builders are folded, not inspected.** Asserting the shape of an
 *    object my own function built proves that my function agrees with itself.
 *    Every builder here is run through `validateOp` and then through the real
 *    `fold`, so what is checked is that the LOG accepts it and the state moves —
 *    which is what "the confirm worked" actually means.
 *  - **Two of everything.** A fixture with one unparsed row cannot tell correct
 *    keying apart from no keying at all, and the defect this screen is most
 *    exposed to is precisely a collapse of many rows into one.
 */

import { describe, expect, test } from "bun:test";

import { emptyState, type ForkNotice, type Rule, type Txn } from "@ledger/client/replay/state.ts";
import { fold, type LogEntry } from "@ledger/client/replay/replay.ts";
import { SCHEMA_VERSION, validateOp, type Op } from "@ledger/client/wire/op.ts";
import type { OpSpec } from "@ledger/client/outbox/outbox.ts";

import {
  confirmOps,
  duplicateDispositionOp,
  duplicateKey,
  forkKey,
  itemKey,
  laneOf,
  LANES,
  manualEntryOps,
  nextParentVersion,
  normalizeCurrencyDraft,
  parseAmountDraft,
  reasonOf,
  REVIEW_REASON_COPY,
  reviewMoney,
  ruleTargetOf,
  isSettled,
  settledBy,
  swipeOutcome,
  undoConfirmOps,
  type ReviewReason,
} from "./review.ts";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const INGEST_WRITER = "ingest";
const DEVICE_WRITER = "dev-a";

const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

function txn(over: Partial<Txn> = {}): Txn {
  return {
    id: "t1",
    ingest_id: ingestID("i1"),
    amount_minor: 25_000n,
    currency: "AED",
    direction: "debit",
    posted_at: "2026-06-05T09:00:00.000Z",
    merchant_raw: "CARREFOUR HYPERMARKET DUBAI",
    last4: "3701",
    category: null,
    needs_review: true,
    unparsed: false,
    tier: "template",
    parse_error: null,
    provenance: "ingest",
    amount_home_minor: 25_000n,
    splits: [],
    superseded_by: null,
    possible_duplicate_of: null,
    version: 1,
    ...over,
  };
}

/** A row shaped exactly as `pipeline.go` writes one no tier resolved. */
function unparsed(over: Partial<Txn> = {}): Txn {
  return txn({
    amount_minor: 0n,
    currency: "",
    direction: "",
    merchant_raw: "",
    last4: "",
    unparsed: true,
    tier: "none",
    amount_home_minor: null,
    ...over,
  });
}

let opCounter = 0;
const nextOpID = (): string => `op-${++opCounter}`;

/**
 * The op `Client.emit` would build from a spec. Transcribed from
 * `net/client.ts` rather than paraphrased: a helper that produced a shape the
 * client never emits would test a wire format nobody writes.
 */
function opOf(spec: OpSpec, authoredAt = "2026-06-06T10:00:00.000Z"): Op {
  const op: Op = {
    v: SCHEMA_VERSION,
    type: spec.type as Op["type"],
    op_id: nextOpID(),
    authored_at: authoredAt,
    parent_version: spec.parentVersion ?? null,
    payload: spec.payload,
  };
  if (spec.entity !== undefined) op.entity = spec.entity;
  if (spec.ingestId !== undefined && spec.ingestId !== "") op.ingest_id = spec.ingestId;
  validateOp(op);
  return op;
}

let seqCounter = 0n;
function entry(op: Op, writer = DEVICE_WRITER): LogEntry {
  seqCounter += 1n;
  return { op, seq: seqCounter, writer_id: writer };
}

/** An ingest op for an unparsed message, as the pipeline appends it. */
function unparsedIngest(name: string, id: string, postedAt = "2026-06-05T09:00:00Z"): Op {
  return opOf({
    type: "txn_ingested",
    entity: { kind: "txn", id },
    parentVersion: null,
    ingestId: ingestID(name),
    payload: {
      amount_minor: "0",
      currency: "",
      direction: "",
      posted_at: postedAt,
      merchant_raw: "",
      last4: "",
      is_transfer: false,
      tier: "none",
      needs_review: true,
      unparsed: true,
      normalizer_version: 1,
    },
  });
}

function parsedIngest(name: string, id: string, over: Record<string, unknown> = {}): Op {
  return opOf({
    type: "txn_ingested",
    entity: { kind: "txn", id },
    parentVersion: null,
    ingestId: ingestID(name),
    payload: {
      amount_minor: "25000",
      currency: "AED",
      direction: "debit",
      posted_at: "2026-06-05T09:00:00Z",
      merchant_raw: "CARREFOUR",
      last4: "3701",
      tier: "template",
      needs_review: true,
      ...over,
    },
  });
}

// ---------------------------------------------------------------------------
// Why a row is here
// ---------------------------------------------------------------------------

describe("reasonOf tells the three review reasons apart", () => {
  test("an unparsed row is unreadable, whatever else it says", () => {
    expect(reasonOf(unparsed())).toBe("unreadable");
  });

  test("a heuristic-tier row is a pattern guess", () => {
    expect(reasonOf(txn({ tier: "heuristic" }))).toBe("pattern_guess");
  });

  test("a template-tier row flagged for review is the unsigned-headers case", () => {
    // The DIB shape: the template read it fine, the amount is real, and what is
    // missing is signature coverage of the decoding headers.
    expect(reasonOf(txn({ tier: "template", needs_review: true, amount_minor: 12_345n }))).toBe("unsigned_headers");
  });

  test('tier "none" without unparsed is an entry, NOT an unreadable message', () => {
    // The trap Task 7 names explicitly: every client-authored op reads as
    // tier "none" and carries real money. Reading the tier before `unparsed`
    // would file every CSV import under "we couldn't read this".
    const imported = txn({ tier: "none", unparsed: false, provenance: "user", amount_minor: 9_900n });
    expect(reasonOf(imported)).toBe("entered");
  });

  test("the three reasons a user actually meets are three different sentences", () => {
    const met: ReviewReason[] = ["pattern_guess", "unreadable", "unsigned_headers"];
    const titles = met.map((r) => REVIEW_REASON_COPY[r].title);
    expect(new Set(titles).size).toBe(3);
    const details = met.map((r) => REVIEW_REASON_COPY[r].detail);
    expect(new Set(details).size).toBe(3);
  });

  test("every reason has copy, so a new one cannot render a blank card", () => {
    const reasons: ReviewReason[] = ["unreadable", "pattern_guess", "unsigned_headers", "entered"];
    for (const r of reasons) {
      const c = REVIEW_REASON_COPY[r];
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.detail.length).toBeGreaterThan(0);
      expect(c.more.length).toBeGreaterThan(0);
    }
  });

  test("the common case is not described as an attack", () => {
    // `unsigned_headers` is EVERY DIB message today. Copy that cried forgery on
    // the common case would train the user to confirm without reading, which
    // costs the flag its entire value.
    const c = REVIEW_REASON_COPY.unsigned_headers;
    const text = `${c.title} ${c.detail} ${c.more}`.toLowerCase();
    for (const word of ["attack", "fraud", "forged", "tamper", "malicious", "danger"]) {
      expect(text).not.toContain(word);
    }
    // But it must not claim the decode is proven either.
    expect(text).toContain("unproven");
  });

  test("only the unreadable card asks the user to type", () => {
    expect(REVIEW_REASON_COPY.unreadable.action).toBe("enter");
    expect(REVIEW_REASON_COPY.pattern_guess.action).toBe("check");
    expect(REVIEW_REASON_COPY.unsigned_headers.action).toBe("check");
  });
});

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

describe("laneOf", () => {
  test("a superseded row is in no lane", () => {
    expect(laneOf(txn({ superseded_by: "op-9" }))).toBeNull();
    expect(laneOf(unparsed({ superseded_by: "op-9" }))).toBeNull();
  });

  test("an unparsed row is in the unparsed lane even though it also needs review", () => {
    const u = unparsed({ needs_review: true });
    expect(u.needs_review).toBe(true);
    expect(laneOf(u)).toBe("unparsed");
  });

  test("a duplicate notice outranks a plain review flag", () => {
    expect(laneOf(txn({ needs_review: true, possible_duplicate_of: "t0" }))).toBe("duplicate");
  });

  test("a settled row is in no lane", () => {
    expect(laneOf(txn({ needs_review: false, category: "Groceries" }))).toBeNull();
  });

  test("the lanes are the four the plan names, in its order", () => {
    expect(LANES).toEqual(["needs_review", "unparsed", "duplicate", "forks"]);
  });
});

// ---------------------------------------------------------------------------
// Identity — the collapse must not come back
// ---------------------------------------------------------------------------

describe("item keys do not resurrect the fingerprint collapse", () => {
  test("two unparsed rows that are identical in every visible field are two items", () => {
    // This is Phase 1's exit-run defect in the shape the QUEUE could re-create:
    // amount, currency, direction, merchant and day are equal by construction
    // for every unparsed row, so a key built from any of them collapses a day's
    // backlog into one card and silently loses the rest.
    const a = unparsed({ id: "t1", ingest_id: ingestID("a") });
    const b = unparsed({ id: "t2", ingest_id: ingestID("b") });
    expect(a.amount_minor).toBe(b.amount_minor);
    expect(a.currency).toBe(b.currency);
    expect(a.direction).toBe(b.direction);
    expect(a.merchant_raw).toBe(b.merchant_raw);
    expect(a.posted_at).toBe(b.posted_at);
    expect(itemKey(a)).not.toBe(itemKey(b));
    expect(new Set([itemKey(a), itemKey(b)]).size).toBe(2);
  });

  test("an item key is stable for the same row", () => {
    expect(itemKey(txn({ id: "t7" }))).toBe(itemKey(txn({ id: "t7", category: "Groceries", version: 4 })));
  });

  test("a duplicate key names both rows, so two notices against one row are two items", () => {
    const first = txn({ id: "t3", possible_duplicate_of: "t1" });
    const second = txn({ id: "t4", possible_duplicate_of: "t1" });
    expect(duplicateKey(first)).not.toBe(duplicateKey(second));
    expect(duplicateKey(first)).toContain("t1");
    expect(duplicateKey(first)).toContain("t3");
  });

  test("a fork key is built from op ids, which a projection rebuild does not renumber", () => {
    const f: ForkNotice = { entity: { kind: "txn", id: "t1" }, winner_op: "op-a", loser_op: "op-b", at_seq: 9n };
    expect(forkKey(f)).toBe("fork:op-a:op-b");
    const swapped: ForkNotice = { ...f, winner_op: "op-b", loser_op: "op-a" };
    expect(forkKey(swapped)).not.toBe(forkKey(f));
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe("reviewMoney runs every aggregate through countsTowardMoney", () => {
  test("unparsed rows are counted as excluded, not as zero-amount transactions", () => {
    // The failure this guards is invisible in the TOTAL — an unparsed row adds
    // 0 — and visible only in the count, which is why the count is asserted.
    const m = reviewMoney([txn({ amount_home_minor: 25_000n }), unparsed({ id: "t2" }), unparsed({ id: "t3" })]);
    expect(m.counted).toBe(1);
    expect(m.excluded).toBe(2);
    expect(m.totalHomeMinor).toBe(25_000n);
  });

  test("a row awaiting a rate is counted but not summed, and says so", () => {
    const m = reviewMoney([txn({ amount_home_minor: null }), txn({ id: "t2", amount_home_minor: 100n })]);
    expect(m.counted).toBe(2);
    expect(m.awaitingRate).toBe(1);
    expect(m.totalHomeMinor).toBe(100n);
  });

  test("money stays bigint past 2^53", () => {
    const big = 9_007_199_254_740_993n;
    const m = reviewMoney([txn({ amount_home_minor: big }), txn({ id: "t2", amount_home_minor: 1n })]);
    expect(m.totalHomeMinor).toBe(big + 1n);
  });

  test("an empty queue is zero of everything", () => {
    expect(reviewMoney([])).toEqual({ counted: 0, excluded: 0, totalHomeMinor: 0n, awaitingRate: 0 });
  });
});

// ---------------------------------------------------------------------------
// The gesture decision
// ---------------------------------------------------------------------------

describe("swipeOutcome", () => {
  test("a long drag right confirms; a long drag left skips", () => {
    expect(swipeOutcome({ dx: 120, dy: 4, vx: 0.1 })).toBe("confirm");
    expect(swipeOutcome({ dx: -120, dy: 4, vx: -0.1 })).toBe("skip");
  });

  test("a short slow drag does nothing", () => {
    expect(swipeOutcome({ dx: 30, dy: 0, vx: 0.05 })).toBe("none");
  });

  test("a flick commits on velocity, but still needs travel", () => {
    expect(swipeOutcome({ dx: 40, dy: 0, vx: 0.9 })).toBe("confirm");
    expect(swipeOutcome({ dx: 6, dy: 0, vx: 3 })).toBe("none");
  });

  test("a diagonal scroll does not confirm a transaction", () => {
    expect(swipeOutcome({ dx: 120, dy: 200, vx: 0.6 })).toBe("none");
  });

  test("the thresholds are a boundary, not a range", () => {
    expect(swipeOutcome({ dx: 95, dy: 0, vx: 0 })).toBe("none");
    expect(swipeOutcome({ dx: 96, dy: 0, vx: 0 })).toBe("confirm");
  });
});

// ---------------------------------------------------------------------------
// The string draft
// ---------------------------------------------------------------------------

describe("parseAmountDraft never turns an empty field into zero", () => {
  test("empty is an error, not 0", () => {
    // `Number("") === 0` is the v1 springback bug. Here it would additionally
    // write a zero-amount transaction into an append-only log.
    const r = parseAmountDraft("");
    expect(r.ok).toBe(false);
    expect(parseAmountDraft("   ").ok).toBe(false);
  });

  test("whole and fractional amounts convert to minor units", () => {
    expect(parseAmountDraft("12.34")).toEqual({ ok: true, minor: 1234n });
    expect(parseAmountDraft("12.3")).toEqual({ ok: true, minor: 1230n });
    expect(parseAmountDraft("12")).toEqual({ ok: true, minor: 1200n });
    expect(parseAmountDraft("0.05")).toEqual({ ok: true, minor: 5n });
    expect(parseAmountDraft(".5")).toEqual({ ok: true, minor: 50n });
    expect(parseAmountDraft("12.")).toEqual({ ok: true, minor: 1200n });
  });

  test("a mid-typing draft that is not yet a number is an error, not a silent 0", () => {
    expect(parseAmountDraft(".").ok).toBe(false);
    expect(parseAmountDraft("1.2.3").ok).toBe(false);
    expect(parseAmountDraft("12a").ok).toBe(false);
    expect(parseAmountDraft("-5").ok).toBe(false);
  });

  test("zero is refused: amounts are always positive", () => {
    expect(parseAmountDraft("0").ok).toBe(false);
    expect(parseAmountDraft("0.00").ok).toBe(false);
  });

  test("too many decimals is refused rather than rounded", () => {
    expect(parseAmountDraft("12.345").ok).toBe(false);
    expect(parseAmountDraft("100", 0)).toEqual({ ok: true, minor: 100n });
    expect(parseAmountDraft("100.5", 0).ok).toBe(false);
  });

  test("a value past 2^53 is exact", () => {
    const r = parseAmountDraft("90071992547409.93");
    expect(r.ok && r.minor).toBe(9_007_199_254_740_993n);
  });

  test("currency drafts normalise or refuse", () => {
    expect(normalizeCurrencyDraft(" aed ")).toBe("AED");
    expect(normalizeCurrencyDraft("AE")).toBeNull();
    expect(normalizeCurrencyDraft("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

describe("nextParentVersion keeps a burst of confirms from forking against itself", () => {
  const pendingFor = (id: string, parents: (number | null)[]): Op[] =>
    parents.map((p) => opOf({ type: "txn_categorized", entity: { kind: "txn", id }, parentVersion: p, payload: { category: "X", needs_review: false } }));

  test("with nothing queued it is the projected version", () => {
    expect(nextParentVersion("t1", 3, [])).toBe(3);
  });

  test("each queued op for the same row advances it", () => {
    expect(nextParentVersion("t1", 3, pendingFor("t1", [3]))).toBe(4);
    expect(nextParentVersion("t1", 3, pendingFor("t1", [3, 4]))).toBe(5);
  });

  test("ops for other rows do not", () => {
    expect(nextParentVersion("t1", 3, pendingFor("t2", [3, 4, 5]))).toBe(3);
  });

  test("a create among the pending ops does not", () => {
    const creates = [opOf({ type: "rule_added", entity: { kind: "rule", id: "r1" }, parentVersion: null, payload: { pattern: "abcd", match: "exact", category: "X", priority: 0 } })];
    expect(nextParentVersion("t1", 2, creates)).toBe(2);
  });

  test("two confirms on one row, folded, do not produce a fork", () => {
    // The property, measured rather than argued: build the state, confirm
    // twice without a sync in between, fold both, and read the fork list.
    let s = fold([entry(parsedIngest("m1", "t1"), INGEST_WRITER)], emptyState());
    const first = confirmOps({ txn: s.txns.get("t1")!, category: "Groceries", projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    const firstOps = first.map((sp) => opOf(sp, "2026-06-06T10:00:00.000Z"));
    const second = confirmOps({
      txn: s.txns.get("t1")!,
      category: "Dining",
      projectedVersion: 1,
      pending: firstOps,
      rules: [],
      newID: () => "r2",
    });
    const secondOps = second.map((sp) => opOf(sp, "2026-06-06T10:00:00.000Z"));
    s = fold([...firstOps, ...secondOps].map((o) => entry(o)), s);
    expect(s.forks).toEqual([]);
    expect(s.anomalies).toEqual([]);
    expect(s.txns.get("t1")!.category).toBe("Dining");
  });

  test("...and the same two confirms WITHOUT the guard do fork", () => {
    // The negative control. Both ops name parent 1 — which is exactly what a
    // screen reading `txn.version` straight from the projection would emit —
    // and the second is resolved as a concurrent fork against the first.
    let s = fold([entry(parsedIngest("m2", "t1"), INGEST_WRITER)], emptyState());
    const a = opOf({ type: "txn_categorized", entity: { kind: "txn", id: "t1" }, parentVersion: 1, payload: { category: "Groceries", needs_review: false } });
    const b = opOf({ type: "txn_categorized", entity: { kind: "txn", id: "t1" }, parentVersion: 1, payload: { category: "Dining", needs_review: false } });
    s = fold([entry(a), entry(b)], s);
    expect(s.forks.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The ops an answer produces
// ---------------------------------------------------------------------------

describe("confirmOps", () => {
  const rule = (over: Partial<Rule> = {}): Rule => ({ pattern: "carrefour hypermarket dubai", match: "exact", category: "Groceries", priority: 0, version: 1, ...over });

  test("a confirm emits the categorisation and the rule together", () => {
    const specs = confirmOps({ txn: txn(), category: "Groceries", projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized", "rule_added"]);
  });

  test("both ops fold: the row is categorised, unflagged, and the rule exists", () => {
    let s = fold([entry(parsedIngest("m3", "t1"), INGEST_WRITER)], emptyState());
    const specs = confirmOps({ txn: s.txns.get("t1")!, category: "Groceries", projectedVersion: 1, pending: [], rules: s.rules.values(), newID: () => "r1" });
    s = fold(specs.map((sp) => entry(opOf(sp))), s);
    const t = s.txns.get("t1")!;
    expect(t.category).toBe("Groceries");
    expect(t.needs_review).toBe(false);
    expect(s.rules.get("r1")).toEqual({ pattern: "carrefour", match: "exact", category: "Groceries", priority: 0, version: 1 });
    expect(s.anomalies).toEqual([]);
  });

  test("the same merchant confirmed twice writes one rule, not two", () => {
    const specs = confirmOps({ txn: txn(), category: "Groceries", projectedVersion: 2, pending: [], rules: [rule()], newID: () => "r2" });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized"]);
  });

  test("a rule for the same merchant but a different category is still written", () => {
    const specs = confirmOps({ txn: txn(), category: "Dining", projectedVersion: 2, pending: [], rules: [rule()], newID: () => "r2" });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized", "rule_added"]);
  });

  test("confirming without a category writes no rule", () => {
    const specs = confirmOps({ txn: txn(), category: null, projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized"]);
    expect(specs[0]!.payload).toEqual({ category: null, needs_review: false });
  });

  test("a merchant too short to make a pattern writes no rule", () => {
    expect(ruleTargetOf("A")).toBeNull();
    const specs = confirmOps({ txn: txn({ merchant_raw: "A" }), category: "Groceries", projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized"]);
  });

  test("an unparsed row can still be confirmed into a category without a rule", () => {
    // Its merchant is empty, so there is nothing to write a rule about; the
    // categorisation itself must still be emittable.
    const specs = confirmOps({ txn: unparsed(), category: "Groceries", projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    expect(specs.map((s) => s.type)).toEqual(["txn_categorized"]);
  });

  test("the pattern is the canonical subject the matcher will actually test", () => {
    expect(ruleTargetOf("  CARREFOUR   Hypermarket ")).toBe("carrefour hypermarket");
  });
});

describe("duplicateDispositionOp", () => {
  test("dismissal and undo are durable edits while both transaction rows remain live", () => {
    let s = fold([
      entry(parsedIngest("dup-a", "dup-a"), INGEST_WRITER),
      entry(parsedIngest("dup-b", "dup-b"), INGEST_WRITER),
    ]);
    const marked = s.txns.get("dup-b")!;
    expect(marked.possible_duplicate_of).toBe("dup-a");
    const original = { ...marked };

    const dismiss = duplicateDispositionOp({ txn: marked, projectedVersion: marked.version, pending: [], disposition: "same" });
    s = fold([entry(opOf(dismiss))], s);
    expect(s.txns.get("dup-b")?.possible_duplicate_of).toBe("dup-a");
    expect(s.txns.get("dup-b")?.duplicate_disposition).toBe("same");
    expect([...s.txns.values()].filter((t) => t.superseded_by === null)).toHaveLength(2);

    const undo = duplicateDispositionOp({ txn: original, projectedVersion: 1, pending: [opOf(dismiss)], disposition: null });
    expect([dismiss.parentVersion, undo.parentVersion]).toEqual([1, 2]);
    s = fold([entry(opOf(undo, "2026-06-06T10:01:00.000Z"))], s);
    expect(s.txns.get("dup-b")?.possible_duplicate_of).toBe("dup-a");
    expect(s.txns.get("dup-b")?.duplicate_disposition).toBeNull();
    expect(s.forks).toHaveLength(0);
  });
});

describe("undoConfirmOps", () => {
  test("undo puts the row back and does not delete anything", () => {
    let s = fold([entry(parsedIngest("m4", "t1", { category: "Dining" }), INGEST_WRITER)], emptyState());
    const before = s.txns.get("t1")!;
    const confirm = confirmOps({ txn: before, category: "Groceries", projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    const confirmOpsBuilt = confirm.map((sp) => opOf(sp));
    const undo = undoConfirmOps({ txn: before, projectedVersion: 1, pending: confirmOpsBuilt });
    const undoOps = undo.map((sp) => opOf(sp));
    s = fold([...confirmOpsBuilt, ...undoOps].map((o) => entry(o)), s);
    const after = s.txns.get("t1")!;
    expect(after.category).toBe("Dining");
    expect(after.needs_review).toBe(true);
    // The rule survives the undo: the user retracted a transaction's category,
    // not their statement about the merchant.
    expect(s.rules.size).toBe(1);
    expect(s.forks).toEqual([]);
  });
});

describe("settledBy keeps an offline session from re-asking what it just asked", () => {
  test("a queued confirm settles its row", () => {
    const specs = confirmOps({ txn: txn(), category: "Groceries", projectedVersion: 1, pending: [], rules: [], newID: () => "r1" });
    const s = settledBy(specs.map((sp) => opOf(sp)));
    expect(isSettled(txn(), s)).toBe(true);
    expect(isSettled(txn({ id: "t2" }), s)).toBe(false);
  });

  test("a queued manual entry settles the row it replaces, which has a DIFFERENT id", () => {
    // `txn_superseded` creates a new entity; only the ingest id ties the two
    // rows together, so matching on entity id alone would leave the unparsed
    // card on the deck after the user had typed it in.
    const u = unparsed({ id: "t1" });
    const specs = manualEntryOps({
      txn: u,
      amountMinor: 100n,
      currency: "AED",
      direction: "debit",
      postedAt: "2026-06-05T09:00:00Z",
      merchantRaw: "X",
      last4: "",
      category: null,
      newID: () => "t1b",
    });
    const s = settledBy(specs.map((sp) => opOf(sp)));
    expect(s.entityIDs.has("t1")).toBe(false);
    expect(isSettled(u, s)).toBe(true);
  });

  test("a rule write-back settles nothing on its own", () => {
    const rule = opOf({ type: "rule_added", entity: { kind: "rule", id: "r1" }, parentVersion: null, payload: { pattern: "abcd", match: "exact", category: "X", priority: 0 } });
    const s = settledBy([rule]);
    expect(s.entityIDs.size).toBe(0);
    expect(s.ingestIDs.size).toBe(0);
  });

  test("an empty outbox settles nothing", () => {
    expect(isSettled(txn(), settledBy([]))).toBe(false);
  });
});

describe("manualEntryOps", () => {
  test("typing in an unparsed message supersedes it into a real transaction", () => {
    let s = fold([entry(unparsedIngest("u1", "t1"), INGEST_WRITER)], emptyState());
    expect(s.txns.get("t1")!.unparsed).toBe(true);

    const specs = manualEntryOps({
      txn: s.txns.get("t1")!,
      amountMinor: 4_250n,
      currency: "AED",
      direction: "debit",
      postedAt: "2026-06-05T09:00:00Z",
      merchantRaw: "SPINNEYS",
      last4: "3701",
      category: "Groceries",
      newID: () => "t1b",
    });
    s = fold(specs.map((sp) => entry(opOf(sp))), s);

    const old = s.txns.get("t1")!;
    const fresh = s.txns.get("t1b")!;
    expect(old.superseded_by).not.toBeNull();
    expect(fresh.unparsed).toBe(false);
    expect(fresh.amount_minor).toBe(4_250n);
    expect(fresh.currency).toBe("AED");
    expect(fresh.direction).toBe("debit");
    expect(fresh.needs_review).toBe(false);
    // Derived from the WRITER, never from the payload (spec §3.3(b)).
    expect(fresh.provenance).toBe("user");
    expect(old.ingest_id).toBe(fresh.ingest_id);
    expect(s.anomalies).toEqual([]);
  });

  test("the superseded row leaves every live index, so it stops being a queue item", () => {
    let s = fold([entry(unparsedIngest("u2", "t1"), INGEST_WRITER)], emptyState());
    const specs = manualEntryOps({
      txn: s.txns.get("t1")!,
      amountMinor: 100n,
      currency: "AED",
      direction: "credit",
      postedAt: "2026-06-05T09:00:00Z",
      merchantRaw: "",
      last4: "",
      category: null,
      newID: () => "t1b",
    });
    s = fold(specs.map((sp) => entry(opOf(sp))), s);
    expect(laneOf(s.txns.get("t1")!)).toBeNull();
    expect(laneOf(s.txns.get("t1b")!)).toBeNull();
  });

  test("a zero or negative amount is refused before it reaches the log", () => {
    const base = {
      txn: unparsed(),
      currency: "AED",
      direction: "debit" as const,
      postedAt: "2026-06-05T09:00:00Z",
      merchantRaw: "X",
      last4: "",
      category: null,
      newID: () => "t2",
    };
    expect(() => manualEntryOps({ ...base, amountMinor: 0n })).toThrow();
    expect(() => manualEntryOps({ ...base, amountMinor: -1n })).toThrow();
    expect(() => manualEntryOps({ ...base, amountMinor: 1n, currency: "aed" })).toThrow();
  });

  test("the payload never claims unparsed, so the biconditional cannot be violated", () => {
    const specs = manualEntryOps({
      txn: unparsed(),
      amountMinor: 1n,
      currency: "AED",
      direction: "debit",
      postedAt: "2026-06-05T09:00:00Z",
      merchantRaw: "X",
      last4: "",
      category: null,
      newID: () => "t2",
    });
    expect(Object.keys(specs[0]!.payload as object)).not.toContain("unparsed");
    expect(Object.keys(specs[0]!.payload as object)).not.toContain("tier");
  });
});
