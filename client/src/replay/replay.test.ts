import { expect, test } from "bun:test";
import {
  UnknownNewerVersionError,
  encodeBlobOps,
  encodeCheckpointPayload,
  type CheckpointHead,
  type Op,
  type OpType,
} from "../wire/op";
import { emptyState, fingerprint, notWitnessed, serializeState, type State, type Txn } from "./state";
import { ReplayOrderError, applyOp, fold, foldBlobs, type LogEntry, type PositionedBlob } from "./replay";

// ---------------------------------------------------------------------------
// Builders
//
// Ops are built as real Op values that `validateOp` accepts — an ingest id is a
// 64-hex sha256, `authored_at` is RFC3339 UTC, money is a decimal STRING. A
// builder that quietly produced something the wire model rejects would test the
// anomaly path by accident and nothing else.
// ---------------------------------------------------------------------------

/** A 64-hex ingest id from a readable name, so tests can say "i1". */
const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

let opCounter = 0;
const nextOpID = (): string => `op-${++opCounter}`;

/** An op plus the writer its blob was attributed to. `seq` is added by {@link at}. */
interface Authored {
  op: Op;
  writer_id: string;
}

function at(seq: bigint, a: Authored): LogEntry {
  return { op: a.op, seq, writer_id: a.writer_id };
}

interface TxnFields {
  amount_minor?: string;
  currency?: string;
  direction?: string;
  posted_at?: string;
  merchant_raw?: string;
  last4?: string;
  category?: string | null;
  needs_review?: boolean;
}

function txnPayload(over: TxnFields): Record<string, unknown> {
  const p: Record<string, unknown> = {
    amount_minor: over.amount_minor ?? "25000",
    currency: over.currency ?? "AED",
    direction: over.direction ?? "debit",
    posted_at: over.posted_at ?? "2026-06-05T09:00:00Z",
    merchant_raw: over.merchant_raw ?? "CARREFOUR",
    last4: over.last4 ?? "3701",
  };
  if (over.category !== undefined) p["category"] = over.category;
  if (over.needs_review !== undefined) p["needs_review"] = over.needs_review;
  return p;
}

function mk(
  type: OpType,
  writer: string,
  authoredAt: string,
  rest: Partial<Op> & { payload: unknown },
): Authored {
  return {
    writer_id: writer,
    op: { v: 1, type, op_id: nextOpID(), authored_at: authoredAt, parent_version: null, ...rest },
  };
}

function ingested(
  ingest: string,
  txnId: string,
  over: TxnFields = {},
  writer = "ingest",
  authoredAt = "2026-06-05T09:00:05Z",
): Authored {
  return mk("txn_ingested", writer, authoredAt, {
    entity: { kind: "txn", id: txnId },
    ingest_id: ingestID(ingest),
    payload: txnPayload(over),
  });
}

function superseded(
  ingest: string,
  txnId: string,
  over: TxnFields = {},
  writer = "ingest",
  authoredAt = "2026-06-06T09:00:05Z",
): Authored {
  return mk("txn_superseded", writer, authoredAt, {
    entity: { kind: "txn", id: txnId },
    ingest_id: ingestID(ingest),
    payload: txnPayload(over),
  });
}

function categorized(
  txnId: string,
  parentVersion: number,
  category: string,
  writer = "dev-a",
  authoredAt = "2026-06-05T10:00:00Z",
): Authored {
  return mk("txn_categorized", writer, authoredAt, {
    entity: { kind: "txn", id: txnId },
    parent_version: parentVersion,
    payload: { category },
  });
}

function split(
  txnId: string,
  parentVersion: number,
  parts: [string, string][],
  writer = "dev-a",
  authoredAt = "2026-06-05T10:30:00Z",
): Authored {
  return mk("txn_split", writer, authoredAt, {
    entity: { kind: "txn", id: txnId },
    parent_version: parentVersion,
    payload: { parts: parts.map(([category, amount_minor]) => ({ category, amount_minor })) },
  });
}

function edited(
  txnId: string,
  parentVersion: number,
  patch: Record<string, unknown>,
  writer = "dev-a",
  authoredAt = "2026-06-05T11:00:00Z",
): Authored {
  return mk("txn_edited", writer, authoredAt, {
    entity: { kind: "txn", id: txnId },
    parent_version: parentVersion,
    payload: patch,
  });
}

function ruleAdded(
  ruleId: string,
  parentVersion: number | null,
  fields: { pattern: string; match?: string; category: string; priority?: number },
  writer = "dev-a",
  authoredAt = "2026-06-05T12:00:00Z",
): Authored {
  return mk("rule_added", writer, authoredAt, {
    entity: { kind: "rule", id: ruleId },
    parent_version: parentVersion,
    payload: {
      pattern: fields.pattern,
      match: fields.match ?? "contains",
      category: fields.category,
      priority: fields.priority ?? 100,
    },
  });
}

function homeCurrency(ccy: string, writer = "dev-a", authoredAt = "2026-01-01T00:00:00Z"): Authored {
  return mk("home_currency_set", writer, authoredAt, { payload: { currency: ccy } });
}

function rateSet(ccy: string, micro: string, writer = "dev-a", authoredAt = "2026-01-01T00:01:00Z"): Authored {
  return mk("rate_set", writer, authoredAt, { payload: { currency: ccy, rate_micro: micro } });
}

function rateUnset(ccy: string, writer = "dev-a", authoredAt = "2026-01-01T00:02:00Z"): Authored {
  return mk("rate_unset", writer, authoredAt, { payload: { currency: ccy } });
}

function checkpoint(heads: CheckpointHead[], writer = "dev-a", authoredAt = "2026-06-05T13:00:00Z"): Authored {
  return mk("writer_checkpoint", writer, authoredAt, { payload: encodeCheckpointPayload(heads) });
}

const head = (writerId: string, stream: string, counter: string, fill: string): CheckpointHead => ({
  writer_id: writerId,
  stream,
  counter,
  hash: fill.repeat(64),
});

const kinds = (s: State): string[] => s.anomalies.map((a) => a.kind);
const live = (s: State): Txn[] => [...s.txns.values()].filter((t) => t.superseded_by === null);

// ---------------------------------------------------------------------------
// Rule 1 — causality: a sequential edit is an ordinary edit
// ---------------------------------------------------------------------------

test("sequential re-categorization is an ordinary edit, not a fork", () => {
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "groceries", "dev-a", "2026-06-01T10:00:00Z")),
    at(3n, categorized("t1", 2, "dining", "dev-a", "2026-06-01T11:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.forks).toHaveLength(0);
  expect(s.txns.get("t1")!.version).toBe(3);
});

test("an edit naming a version beyond the head is recorded, never guessed at", () => {
  const s = fold([at(1n, ingested("i1", "t1")), at(2n, categorized("t1", 7, "dining"))]);
  expect(s.txns.get("t1")!.category).toBeNull();
  expect(kinds(s)).toContain("future_parent");
});

test("an edit against an entity that was never created is recorded, not invented", () => {
  // This is the shape a set-aside blob leaves behind: the create was unreadable,
  // the edit is not. Replay must not conjure the transaction from the edit.
  const s = fold([at(1n, categorized("ghost", 1, "dining"))]);
  expect(s.txns.size).toBe(0);
  expect(kinds(s)).toContain("unknown_entity");
});

test("a second create for the same entity is recorded and does not clobber the first", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { merchant_raw: "FIRST" })),
    at(2n, ingested("i2", "t1", { merchant_raw: "SECOND" })),
  ]);
  expect(s.txns.get("t1")!.merchant_raw).toBe("FIRST");
  expect(kinds(s)).toContain("duplicate_create");
});

test("an op may only address the entity kind its type owns", () => {
  // The head keyspace is (kind, id). An op that names the wrong kind would file
  // its head in one keyspace while editing a record in the other, and the two
  // versions would drift apart with nothing to notice.
  const bad = categorized("t1", 1, "dining");
  bad.op.entity = { kind: "rule", id: "t1" };
  const s = fold([at(1n, ingested("i1", "t1")), at(2n, bad)]);
  expect(s.txns.get("t1")!.category).toBeNull();
  expect(s.txns.get("t1")!.version).toBe(1);
  expect(kinds(s)).toContain("entity_kind_mismatch");
});

test("a rule and a transaction may share an id without touching each other", () => {
  const s = fold([
    at(1n, ingested("i1", "x", { merchant_raw: "TXN" })),
    at(2n, ruleAdded("x", null, { pattern: "P", category: "groceries" })),
    at(3n, ruleAdded("x", 1, { pattern: "P", category: "dining" })),
  ]);
  expect(s.txns.get("x")!.version).toBe(1);
  expect(s.rules.get("x")!.version).toBe(2);
  expect(s.rules.get("x")!.category).toBe("dining");
});

// ---------------------------------------------------------------------------
// Rule 2 — true forks resolve by authored_at, then writer_id, and are surfaced
// ---------------------------------------------------------------------------

test("two ops naming the same parent fork, resolve by later authored_at, and are surfaced", () => {
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "groceries", "dev-a", "2026-06-01T10:00:00Z")),
    at(3n, categorized("t1", 1, "dining", "dev-b", "2026-06-01T12:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.forks).toHaveLength(1);
  expect(s.forks[0]!.entity).toEqual({ kind: "txn", id: "t1" });
  expect(s.forks[0]!.at_seq).toBe(3n);
  expect(s.txns.get("t1")!.version).toBe(3);
});

test("the later-authored op wins even when it is the one already holding the head", () => {
  // The loser arrives second. Its payload must not land, the version must still
  // advance (it is a function of the total order), and the notice must still fire.
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "dining", "dev-b", "2026-06-01T12:00:00Z")),
    at(3n, categorized("t1", 1, "groceries", "dev-a", "2026-06-01T10:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.txns.get("t1")!.version).toBe(3);
  expect(s.forks).toHaveLength(1);
});

test("fork ties break on writer_id, deterministically in both orders", () => {
  const create = ingested("i1", "t1");
  const a = categorized("t1", 1, "x", "dev-a", "2026-06-01T10:00:00Z");
  const b = categorized("t1", 1, "y", "dev-b", "2026-06-01T10:00:00Z");

  const ab = fold([at(1n, create), at(2n, a), at(3n, b)]);
  const ba = fold([at(1n, create), at(2n, b), at(3n, a)]);

  expect(ab.txns.get("t1")!.category).toBe("y"); // dev-b > dev-a
  expect(ba.txns.get("t1")!.category).toBe("y");
  // Not merely "the same answer" — the same STATE, notices included.
  expect(serializeState(ab)).toBe(serializeState(ba));
});

test("writer_id is the tiebreak ONLY when the instants are equal", () => {
  const create = ingested("i1", "t1");
  // dev-a is lexicographically smaller but authored one millisecond later, so
  // the timestamp must decide and the writer must not get a vote.
  const a = categorized("t1", 1, "x", "dev-a", "2026-06-01T10:00:00.001Z");
  const b = categorized("t1", 1, "y", "dev-b", "2026-06-01T10:00:00.000Z");
  expect(fold([at(1n, create), at(2n, a), at(3n, b)]).txns.get("t1")!.category).toBe("x");
  expect(fold([at(1n, create), at(2n, b), at(3n, a)]).txns.get("t1")!.category).toBe("x");
});

test("sub-millisecond precision cannot smuggle in a different winner", () => {
  // Both instants truncate to the same millisecond on both executors, so this
  // IS an exact tie and the writer decides — comparing the raw STRINGS would
  // have made dev-a win here, which is the divergence op.ts's ms rule exists
  // to prevent.
  const create = ingested("i1", "t1");
  const a = categorized("t1", 1, "x", "dev-a", "2026-06-01T10:00:00.0009Z");
  const b = categorized("t1", 1, "y", "dev-b", "2026-06-01T10:00:00.0001Z");
  expect(fold([at(1n, create), at(2n, a), at(3n, b)]).txns.get("t1")!.category).toBe("y");
});

test("a fork tied on BOTH fields leaves the incumbent, so it resolves by seq", () => {
  // Reachable in practice: one offline device authoring two edits against the
  // same head inside one millisecond. Both named tiebreaks are exhausted, so the
  // total order is the only answer left — and the outcome is that the user's
  // LATER op is the one discarded. Deterministic, and deliberately not patched
  // with a third tiebreak spec §3.3:66 does not define.
  const create = ingested("i1", "t1");
  const first = categorized("t1", 1, "first", "dev-a", "2026-06-01T10:00:00Z");
  const second = categorized("t1", 1, "second", "dev-a", "2026-06-01T10:00:00Z");
  const s = fold([at(1n, create), at(2n, first), at(3n, second)]);
  expect(s.txns.get("t1")!.category).toBe("first");
  expect(s.txns.get("t1")!.version).toBe(3);
  expect(s.forks).toHaveLength(1);
  expect(s.forks[0]!.winner_op).toBe(first.op.op_id);
  // Swapping the seqs swaps the winner — that IS resolution by seq, stated.
  const swapped = fold([at(1n, create), at(2n, second), at(3n, first)]);
  expect(swapped.txns.get("t1")!.category).toBe("second");
});

test("parent_version 0 names a version that never existed, and is refused", () => {
  // Structurally the mirror of future_parent. Left alone it reads as
  // `parent < head.version`, i.e. a fork — so it could WIN, apply, bump the head
  // and emit a notice, with nothing saying the parent was fictional.
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "groceries", "dev-a", "2026-06-01T10:00:00Z")),
    at(3n, categorized("t1", 0, "hijack", "dev-z", "2026-06-01T23:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("groceries");
  expect(s.txns.get("t1")!.version).toBe(2);
  expect(s.forks).toHaveLength(0);
  expect(kinds(s)).toContain("nonexistent_parent");
});

test("a stale-parent op that is refused yields NO fork notice", () => {
  // So "every op naming a stale parent yields a notice" is not an invariant
  // Task 13 may assume; "every RESOLVED fork yields one" is.
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "1000" })),
    at(2n, categorized("t1", 1, "groceries")),
    at(3n, split("t1", 1, [["a", "600"], ["b", "300"]])), // stale parent AND a bad sum
  ]);
  expect(s.forks).toHaveLength(0);
  expect(kinds(s)).toContain("split_sum");
  expect(s.txns.get("t1")!.version).toBe(2);
});

test("fork resolution works on any versioned entity, not just transactions", () => {
  const s = fold([
    at(1n, ruleAdded("r1", null, { pattern: "CARREFOUR", category: "groceries" })),
    at(2n, ruleAdded("r1", 1, { pattern: "CARREFOUR", category: "dining" }, "dev-a", "2026-06-05T12:00:00Z")),
    at(3n, ruleAdded("r1", 1, { pattern: "CARREFOUR", category: "travel" }, "dev-b", "2026-06-05T12:30:00Z")),
  ]);
  expect(s.rules.get("r1")!.category).toBe("travel");
  expect(s.rules.get("r1")!.version).toBe(3);
  expect(s.forks).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Rule 3 — seq is the fold order; authored_at is the fork tiebreak only
// ---------------------------------------------------------------------------

test("the fold order is seq, never authored_at", () => {
  // Each edit names the head it was authored against, so all three apply
  // cleanly and the LAST BY SEQ wins — even though its authored_at is the
  // earliest of the three. A fold that sorted by authored_at would say "c".
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "a", "dev-a", "2026-06-03T10:00:00Z")),
    at(3n, categorized("t1", 2, "b", "dev-a", "2026-06-02T10:00:00Z")),
    at(4n, categorized("t1", 3, "c", "dev-a", "2026-06-01T10:00:00Z")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("c");
  expect(s.forks).toHaveLength(0);
});

test("applyOp refuses to go backwards, so a caller cannot fold out of order", () => {
  const s = emptyState();
  applyOp(s, at(5n, ingested("i1", "t1")));
  expect(() => applyOp(s, at(4n, categorized("t1", 1, "dining")))).toThrow(ReplayOrderError);
  expect(() => applyOp(s, at(0n, categorized("t1", 1, "dining")))).toThrow(ReplayOrderError);
});

test("a page delivered twice is not folded twice", () => {
  // The ordering guard has to admit seq === cursor, because a blob's ops share
  // one seq. Without an identity check the re-delivered edit would fork against
  // ITSELF: version 3, and a notice naming one op as both winner and loser.
  const create = ingested("i1", "t1");
  const edit = categorized("t1", 1, "dining");
  const s = fold([at(1n, create), at(2n, edit)]);
  fold([at(2n, edit)], s);
  expect(s.txns.get("t1")!.version).toBe(2);
  expect(s.forks).toHaveLength(0);
  expect(kinds(s)).toContain("duplicate_delivery");
});

test("re-delivering the ops at the cursor is idempotent; re-delivering from behind it throws", () => {
  // The two are different failures and get different answers. Ops AT the cursor
  // are the ambiguous case — a blob's ops share a seq, so the guard cannot
  // refuse them — and they are made idempotent. Ops BEHIND the cursor are
  // unambiguous: a caller resuming from `seq > cursor` never produces them, so
  // it is a sync-layer bug and stays loud.
  const create = ingested("i1", "t1");
  const a = categorized("t1", 1, "a");
  const b = categorized("t1", 2, "b");
  const page = [at(1n, create), at(2n, a), at(2n, b)];
  const s = fold(page);

  fold([at(2n, a), at(2n, b)], s); // the tail page again
  expect(s.txns.get("t1")!.version).toBe(3);
  expect(s.txns.get("t1")!.category).toBe("b");
  expect(s.forks).toHaveLength(0);
  expect(s.anomalies.filter((x) => x.kind === "duplicate_delivery")).toHaveLength(2);

  expect(() => fold(page, s)).toThrow(ReplayOrderError);
});

test("ops sharing one blob share one seq and apply in intra-blob order", () => {
  // A blob is one op_log row: every op in it carries the same seq, and the
  // total order is (seq, index within the blob).
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, categorized("t1", 1, "groceries")),
    at(2n, categorized("t1", 2, "dining")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.forks).toHaveLength(0);
});

test("arrival order does not matter: the same log delivered in any chunking folds identically", () => {
  const ops = sampleLog();
  const whole = fold(ops);
  for (const size of [1, 2, 3, 7, 31, 199, 1000]) {
    let chunked = emptyState();
    for (const chunk of chunksOf(ops, size)) chunked = fold(chunk, chunked);
    expect(serializeState(chunked)).toBe(serializeState(whole));
    // Serialization sorts map keys, so pin insertion order separately — it is
    // what `byFingerprint`'s "first live match" answer depends on.
    expect([...chunked.txns.keys()]).toEqual([...whole.txns.keys()]);
    expect([...chunked.liveByIngestID.keys()]).toEqual([...whole.liveByIngestID.keys()]);
  }
});

test("pages that arrive out of order fold identically once ordered by seq", () => {
  // The realistic out-of-order case is at the PAGE level: the sync layer holds
  // rows, not ops. Ordering them by seq is the whole discipline — and the round
  // trip through a real blob must not change the answer either.
  const blobs = asBlobs(sampleLog());
  const direct = fold(sampleLog());
  expect(serializeState(foldBlobs(blobs))).toBe(serializeState(direct));

  const shuffled = deterministicShuffle(blobs);
  expect(shuffled.map((b) => b.pos.seq)).not.toEqual(blobs.map((b) => b.pos.seq));
  const reordered = [...shuffled].sort((a, b) => (a.pos.seq < b.pos.seq ? -1 : a.pos.seq > b.pos.seq ? 1 : 0));
  expect(serializeState(foldBlobs(reordered))).toBe(serializeState(direct));
});

// ---------------------------------------------------------------------------
// Rule 4 — dedup by ingest identity
// ---------------------------------------------------------------------------

test("supersede keeps exactly one live transaction per ingest id", () => {
  const revision = superseded("i1", "t2", { amount_minor: "25900" });
  const s = fold([at(1n, ingested("i1", "t1", { amount_minor: "25000" })), at(2n, revision)]);
  expect(s.liveByIngestID.get(ingestID("i1"))).toBe("t2");
  expect(s.liveByIngestID.size).toBe(1);
  expect(live(s)).toHaveLength(1);
  expect(s.txns.get("t2")!.amount_minor).toBe(25900n);
  // superseded_by names the op that replaced it, so the UI can say what happened.
  expect(s.txns.get("t1")!.superseded_by).toBe(revision.op.op_id);
});

test("a repeated txn_ingested for one ingest id is an anomaly, never a second live row", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "25000" })),
    at(2n, ingested("i1", "t2", { amount_minor: "25000" })),
  ]);
  expect(kinds(s)).toContain("duplicate_ingest");
  expect(live(s)).toHaveLength(1);
  expect(s.txns.has("t2")).toBe(false);
  expect(s.liveByIngestID.get(ingestID("i1"))).toBe("t1");
});

test("a supersede whose original was never seen still lands, and says so", () => {
  const s = fold([at(1n, superseded("i9", "t9"))]);
  expect(live(s)).toHaveLength(1);
  expect(kinds(s)).toContain("supersede_without_origin");
});

test("supersede survives a chain of revisions with exactly one live row throughout", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "25000" })),
    at(2n, superseded("i1", "t2", { amount_minor: "25900" })),
    at(3n, superseded("i1", "t3", { amount_minor: "26000" })),
  ]);
  expect(s.liveByIngestID.get(ingestID("i1"))).toBe("t3");
  expect(live(s)).toHaveLength(1);
  expect(s.txns.get("t1")!.superseded_by).not.toBeNull();
  expect(s.txns.get("t2")!.superseded_by).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Rule 5 — supersede recomputes at its own position, never inherits
// ---------------------------------------------------------------------------

test("supersede does not inherit the predecessor's frozen home-currency amount", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD", amount_minor: "25000" })),
    // A "recompute at current rate" edit freezes a value onto t1 explicitly.
    at(3n, edited("t1", 1, { amount_home_minor: "91812" })),
    // The template fix corrects a mis-detected currency. The new row must be
    // computed at ITS OWN position — against the AED identity rate live there —
    // and not carry t1's USD-based number forward.
    at(4n, superseded("i1", "t2", { currency: "AED", amount_minor: "25000" })),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(91812n);
  expect(s.txns.get("t2")!.amount_home_minor).toBe(25000n);
  // The retired row is no longer a pending conversion target: leaving it there
  // would let a later rate_set freeze a number nothing displays.
  expect([...(s.pendingByCurrency.get("USD") ?? [])]).not.toContain("t1");
});

test("a currency-correcting supersede moves the row to the corrected currency's pending set", () => {
  // Neither currency has a rate here, so both rows are unfrozen and the only
  // question is which bucket the live one is filed under. (Correcting INTO the
  // home currency would freeze at the identity rate instead — see the FX tests.)
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD", amount_minor: "25000" })),
    at(3n, superseded("i1", "t2", { currency: "EUR", amount_minor: "25000" })),
  ]);
  expect(s.pendingByCurrency.get("USD")).toBeUndefined();
  expect([...s.pendingByCurrency.get("EUR")!]).toEqual(["t2"]);
});

// ---------------------------------------------------------------------------
// Rule 4b — fingerprint collisions are notices, never drops
// ---------------------------------------------------------------------------

test("a fingerprint collision becomes a review notice, never a discard", () => {
  const same = {
    last4: "3701",
    amount_minor: "25000",
    direction: "debit",
    merchant_raw: "CARREFOUR",
    posted_at: "2026-06-05T09:00:00Z",
  };
  const s = fold([
    at(1n, ingested("i1", "t1", same)),
    at(2n, ingested("i2", "t2", { ...same, posted_at: "2026-06-05T17:00:00Z" })),
  ]);
  expect(s.txns.size).toBe(2); // both live, nothing dropped
  expect(s.txns.get("t2")!.possible_duplicate_of).toBe("t1");
  expect(kinds(s)).toContain("possible_duplicate");
});

test("a three-way collision names the EARLIEST live match, not just any of them", () => {
  // Which row the notice points at is part of what the user sees, so it has to
  // be a function of the log rather than of iteration order.
  const same = { last4: "3701", amount_minor: "25000", merchant_raw: "CARREFOUR", posted_at: "2026-06-05T09:00:00Z" };
  const s = fold([
    at(1n, ingested("i1", "t1", same)),
    at(2n, ingested("i2", "t2", same)),
    at(3n, ingested("i3", "t3", same)),
  ]);
  expect(s.txns.get("t2")!.possible_duplicate_of).toBe("t1");
  expect(s.txns.get("t3")!.possible_duplicate_of).toBe("t1");
  expect(s.byFingerprint.get(fingerprint(s.txns.get("t1")!))).toEqual(["t1", "t2", "t3"]);
  // Retiring the earliest hands the answer to the next one, deterministically.
  const s2 = fold([at(4n, superseded("i1", "t4", { ...same, merchant_raw: "OTHER" }))], s);
  expect(s2.byFingerprint.get(fingerprint(s2.txns.get("t2")!))).toEqual(["t2", "t3"]);
});

test("possible_duplicate_of is a snapshot of the answer, not a live claim", () => {
  // The pointed-at row can afterwards be edited into a different bucket, and
  // nothing re-walks the rows pointing at it. Recorded rather than fixed: the
  // repair is a scan, and the value of a duplicate NOTICE does not justify one.
  // Task 13 must not read this field as "currently shares a fingerprint with".
  const same = { last4: "3701", amount_minor: "25000", merchant_raw: "CARREFOUR", posted_at: "2026-06-05T09:00:00Z" };
  const s = fold([
    at(1n, ingested("i1", "t1", same)),
    at(2n, ingested("i2", "t2", same)),
    at(3n, edited("t1", 1, { merchant_raw: "SOMEWHERE ELSE" })),
  ]);
  expect(s.txns.get("t2")!.possible_duplicate_of).toBe("t1");
  expect(fingerprint(s.txns.get("t1")!)).not.toBe(fingerprint(s.txns.get("t2")!));
});

test("a superseded transaction stops matching fingerprints", () => {
  // t1 superseded by t2 with identical fields must NOT flag t2 as its own duplicate.
  const s = fold([at(1n, ingested("i1", "t1")), at(2n, superseded("i1", "t2"))]);
  expect(s.txns.get("t2")!.possible_duplicate_of).toBeNull();
  expect(kinds(s)).not.toContain("possible_duplicate");
});

test("the fingerprint day comes from the parsed instant, not the string", () => {
  // 2026-06-05T22:00:00-04:00 is 2026-06-06 in UTC. Slicing the string would
  // read "2026-06-05" and produce a collision the other executor never sees.
  const s = fold([
    at(1n, ingested("i1", "t1", { posted_at: "2026-06-05T22:00:00-04:00" })),
    at(2n, ingested("i2", "t2", { posted_at: "2026-06-05T09:00:00Z" })),
  ]);
  expect(s.txns.get("t1")!.possible_duplicate_of).toBeNull();
  expect(s.txns.get("t2")!.possible_duplicate_of).toBeNull();
  expect(fingerprint(s.txns.get("t1")!)).toContain("2026-06-06");
  expect(fingerprint(s.txns.get("t2")!)).toContain("2026-06-05");
});

// ---------------------------------------------------------------------------
// Rule 5 (brief) — splits must sum
// ---------------------------------------------------------------------------

test("a split whose parts do not sum to the parent is refused and recorded", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "1000" })),
    at(2n, split("t1", 1, [["a", "600"], ["b", "300"]])),
  ]);
  expect(s.txns.get("t1")!.splits).toHaveLength(0);
  expect(kinds(s)).toContain("split_sum");
});

test("a refused split does not consume a version, so the corrected one applies cleanly", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "1000" })),
    at(2n, split("t1", 1, [["a", "600"], ["b", "300"]])),
    at(3n, split("t1", 1, [["a", "600"], ["b", "400"]])),
  ]);
  expect(s.txns.get("t1")!.splits).toEqual([
    { category: "a", amount_minor: 600n },
    { category: "b", amount_minor: 400n },
  ]);
  expect(s.txns.get("t1")!.version).toBe(2);
  expect(s.forks).toHaveLength(0);
});

test("a later split replaces the earlier one wholesale", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "1000" })),
    at(2n, split("t1", 1, [["a", "600"], ["b", "400"]])),
    at(3n, split("t1", 2, [["c", "1000"]])),
  ]);
  expect(s.txns.get("t1")!.splits).toEqual([{ category: "c", amount_minor: 1000n }]);
});

// ---------------------------------------------------------------------------
// Rule 6 (brief) — the latest writer_checkpoint replaces the earlier one
// ---------------------------------------------------------------------------

test("the latest writer_checkpoint replaces the earlier one", () => {
  const s = fold([
    at(1n, checkpoint([head("ingest", "hot", "4", "a"), head("dev-b", "hot", "2", "b")])),
    at(2n, checkpoint([head("ingest", "hot", "9", "c")])),
  ]);
  expect(s.checkpoints).toEqual([{ writer_id: "ingest", stream: "hot", counter: 9n, hash: "c".repeat(64) }]);
});

test("a checkpoint counter is a bigint, because it is a counter", () => {
  const big = "9007199254740993"; // 2^53 + 1
  const s = fold([at(1n, checkpoint([head("ingest", "hot", big, "a")]))]);
  expect(s.checkpoints[0]!.counter).toBe(9007199254740993n);
});

// ---------------------------------------------------------------------------
// Parent-free ops: rates and home currency fold by seq only (spec §3.7)
// ---------------------------------------------------------------------------

test("the head rate is positional: the last rate_set by seq wins, whatever its authored_at", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500", "dev-a", "2026-03-01T00:00:00Z")),
    at(3n, rateSet("USD", "3600000", "dev-b", "2026-01-01T00:00:00Z")),
  ]);
  expect(s.rates.get("USD")).toBe(3600000n);
  expect(s.forks).toHaveLength(0); // parent-free ops have no fork to arbitrate
});

test("rate_unset leaves a live null head, not a missing one", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, rateUnset("USD")),
  ]);
  expect(s.rates.has("USD")).toBe(true);
  expect(s.rates.get("USD")).toBeNull();
});

test("home_currency_set is one-shot; a second one is an anomaly, not a re-denomination", () => {
  const s = fold([at(1n, homeCurrency("AED")), at(2n, homeCurrency("USD"))]);
  expect(s.homeCurrency).toBe("AED");
  expect(kinds(s)).toContain("home_currency_reset");
});

test("a rate_set for the home currency is refused: the identity rate stands", () => {
  const s = fold([at(1n, homeCurrency("AED")), at(2n, rateSet("AED", "2000000"))]);
  expect(s.rates.get("AED")).toBe(1_000_000n);
  expect(kinds(s)).toContain("rate_set_for_home_currency");
});

test("a rate_unset for the home currency is refused: the identity rate is not destructible", () => {
  // The home currency's rate is implicit (§3.7:124), and unsetting it would be
  // UNRECOVERABLE: rate_set(H) is refused and home_currency_set is one-shot, so
  // no op in the vocabulary can put the identity back. Every home-currency
  // transaction from that position on would snapshot null forever.
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateUnset("AED")),
    at(3n, rateSet("AED", "2000000")),
    at(4n, ingested("i1", "t1", { currency: "AED", amount_minor: "10000" })),
  ]);
  expect(s.rates.get("AED")).toBe(1_000_000n);
  expect(kinds(s)).toContain("rate_unset_for_home_currency");
  // Still convertible at its own position, which is what Task 12 needs to be true.
  expect(s.rates.get(s.txns.get("t1")!.currency)).toBe(1_000_000n);
});

test("a rate_unset for any other currency still works", () => {
  const s = fold([at(1n, homeCurrency("AED")), at(2n, rateSet("USD", "3672500")), at(3n, rateUnset("USD"))]);
  expect(s.rates.get("USD")).toBeNull();
  expect(kinds(s)).not.toContain("rate_unset_for_home_currency");
});

test("a parent-free op carrying a parent_version is refused, not folded", () => {
  const bad = rateSet("USD", "3672500");
  bad.op.parent_version = 1;
  const s = fold([at(1n, bad)]);
  expect(s.rates.size).toBe(0);
  expect(kinds(s)).toContain("invalid_op");
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

test("txn_edited carries the home-currency amount verbatim, never a recompute instruction", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD" })),
    at(3n, edited("t1", 1, { amount_home_minor: "91812" })),
  ]);
  expect(s.txns.get("t1")!.amount_home_minor).toBe(91812n);
  expect(s.pendingByCurrency.get("USD")).toBeUndefined();
});

test("an edit that changes a fingerprint field reindexes it", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { merchant_raw: "CARREFOUR" })),
    at(2n, ingested("i2", "t2", { merchant_raw: "SPINNEYS" })),
    at(3n, edited("t2", 1, { merchant_raw: "CARREFOUR" })),
  ]);
  expect(s.txns.get("t2")!.possible_duplicate_of).toBe("t1");
  expect(s.byFingerprint.get(fingerprint(s.txns.get("t1")!))).toEqual(["t1", "t2"]);
});

test("an edit may not rewrite the parsed amount or currency — that is what supersede is for", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", { amount_minor: "25000", currency: "AED" })),
    at(2n, edited("t1", 1, { amount_minor: "9900", currency: "USD", merchant_raw: "FIXED" })),
  ]);
  expect(s.txns.get("t1")!.amount_minor).toBe(25000n);
  expect(s.txns.get("t1")!.currency).toBe("AED");
  expect(s.txns.get("t1")!.merchant_raw).toBe("FIXED"); // the rest of the edit still lands
  expect(kinds(s)).toContain("unsupported_edit_field");
});

test("an edit to a superseded row is applied but surfaced — a lost categorization is never silent", () => {
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, superseded("i1", "t2")),
    at(3n, categorized("t1", 1, "dining")),
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.txns.get("t2")!.category).toBeNull();
  expect(kinds(s)).toContain("edit_of_superseded");
});

// ---------------------------------------------------------------------------
// Payload hygiene
// ---------------------------------------------------------------------------

test("money on the wire is a decimal string and lands as a BigInt", () => {
  const s = fold([at(1n, ingested("i1", "t1", { amount_minor: "9007199254740993" }))]);
  expect(s.txns.get("t1")!.amount_minor).toBe(9007199254740993n);
  expect(typeof s.txns.get("t1")!.amount_minor).toBe("bigint");
});

test("a JSON-number amount is refused rather than folded as a float", () => {
  const bad = ingested("i1", "t1");
  (bad.op.payload as Record<string, unknown>)["amount_minor"] = 25000;
  const s = fold([at(1n, bad)]);
  expect(s.txns.size).toBe(0);
  expect(kinds(s)).toContain("invalid_payload");
});

test("a non-positive amount is refused", () => {
  const bad = ingested("i1", "t1", { amount_minor: "0" });
  const s = fold([at(1n, bad)]);
  expect(s.txns.size).toBe(0);
  expect(kinds(s)).toContain("invalid_payload");
});

test("a direction outside {debit, credit} is refused", () => {
  const s = fold([at(1n, ingested("i1", "t1", { direction: "refund" }))]);
  expect(s.txns.size).toBe(0);
  expect(kinds(s)).toContain("invalid_payload");
});

test("provenance comes from the writer the blob was attributed to, never the payload", () => {
  const s = fold([
    at(1n, ingested("i1", "t1", {}, "ingest")),
    at(2n, ingested("i2", "t2", {}, "dev-a")),
  ]);
  expect(s.txns.get("t1")!.provenance).toBe("ingest");
  expect(s.txns.get("t2")!.provenance).toBe("user");
});

// ---------------------------------------------------------------------------
// Rule 8 — unknown newer version hard-stops; an unopenable blob does not
// ---------------------------------------------------------------------------

test("an op from an unknown newer schema version hard-stops the fold", () => {
  const newer = ingested("i1", "t1");
  newer.op.v = 2;
  expect(() => fold([at(1n, newer)])).toThrow(UnknownNewerVersionError);
});

test("an unknown newer version inside a blob hard-stops, and does not become a set-aside", () => {
  const s = emptyState();
  const body = new TextEncoder().encode(`{"v":1,"kind":"ops","ops":[{"v":2,"type":"txn_ingested"}]}`);
  expect(() =>
    foldBlobs([{ pos: { writer_id: "ingest", stream: "hot", writer_counter: 1n, seq: 1n }, body }], s),
  ).toThrow(UnknownNewerVersionError);
  expect(s.unreadable).toHaveLength(0);
});

test("an unopenable blob is set aside with a warning and the rest of the log still folds", () => {
  const good = (n: number, a: Authored): PositionedBlob => ({
    pos: { writer_id: a.writer_id, stream: "hot", writer_counter: BigInt(n), seq: BigInt(n) },
    body: encodeBlobOps([a.op]),
  });
  const s = foldBlobs([
    good(1, ingested("i1", "t1")),
    { pos: { writer_id: "ingest", stream: "hot", writer_counter: 2n, seq: 2n }, body: new TextEncoder().encode("{not json") },
    good(3, ingested("i3", "t3")),
  ]);
  expect(s.txns.size).toBe(2);
  expect(s.unreadable).toHaveLength(1);
  expect(s.unreadable[0]).toMatchObject({ writer_id: "ingest", stream: "hot", writer_counter: 2n, seq: 2n });
  expect(s.unreadable[0]!.reason).not.toBe("");
});

test("a cold blob offered to the hot fold is set aside, not folded as state", () => {
  const body = new TextEncoder().encode(
    `{"v":1,"kind":"raw_body","ingest_id":"${"a".repeat(64)}","received_at":"2026-06-05T09:00:00Z","raw_base64":""}`,
  );
  const s = foldBlobs([{ pos: { writer_id: "ingest", stream: "cold", writer_counter: 1n, seq: 1n }, body }]);
  expect(s.txns.size).toBe(0);
  expect(s.unreadable).toHaveLength(1);
});

test("foldBlobs enforces one seq per blob, across calls as well as within one", () => {
  const s = emptyState();
  const blob = (seq: bigint, a: Authored): PositionedBlob => ({
    pos: { writer_id: a.writer_id, stream: "hot", writer_counter: seq, seq },
    body: encodeBlobOps([a.op]),
  });
  foldBlobs([blob(3n, ingested("i1", "t1"))], s);
  // Two blobs are two op_log rows, so they can never share a seq the way two
  // ops inside one blob do.
  expect(() => foldBlobs([blob(3n, ingested("i2", "t2"))], s)).toThrow(ReplayOrderError);
  expect(() => foldBlobs([blob(2n, ingested("i3", "t3"))], s)).toThrow(ReplayOrderError);
  expect(s.txns.size).toBe(1);
});

test("a set-aside blob still consumes its position, across calls", () => {
  // The set-aside path is rule 8's own path, so it is where the guard most has
  // to hold: a seq consumed by an unreadable blob must not be re-deliverable
  // later with different content, and a resuming client must not re-request it
  // forever.
  const s = emptyState();
  const bad: PositionedBlob = {
    pos: { writer_id: "ingest", stream: "hot", writer_counter: 5n, seq: 5n },
    body: new TextEncoder().encode("{not json"),
  };
  foldBlobs([bad], s);
  expect(s.cursors.hot).toBe(5n); // the cursor advanced past it
  expect(s.unreadable).toHaveLength(1);

  const good = (seq: bigint, a: Authored): PositionedBlob => ({
    pos: { writer_id: a.writer_id, stream: "hot", writer_counter: seq, seq },
    body: encodeBlobOps([a.op]),
  });
  expect(() => foldBlobs([good(3n, ingested("i2", "t2"))], s)).toThrow(ReplayOrderError);
  expect(() => foldBlobs([bad], s)).toThrow(ReplayOrderError);
  expect(s.txns.size).toBe(0);
});

test("foldBlobs applies every op in a blob at that blob's seq", () => {
  const create = ingested("i1", "t1");
  const cat = categorized("t1", 1, "dining");
  const s = foldBlobs([
    {
      pos: { writer_id: "dev-a", stream: "hot", writer_counter: 1n, seq: 7n },
      body: encodeBlobOps([create.op, cat.op]),
    },
  ]);
  expect(s.txns.get("t1")!.category).toBe("dining");
  expect(s.cursors.hot).toBe(7n);
});

// ---------------------------------------------------------------------------
// Rule 7 — prefix-monotone: incremental folding == a full re-fold from 0
// ---------------------------------------------------------------------------

test("fold is prefix-monotone: chunked folding equals a single fold", () => {
  const ops = sampleLog();
  const whole = fold(ops);
  let chunked = emptyState();
  for (const chunk of chunksOf(ops, 7)) chunked = fold(chunk, chunked);
  expect(serializeState(chunked)).toBe(serializeState(whole));
});

test("incremental application in seq order is equivalent to a full re-fold from 0, at EVERY prefix", () => {
  // The claim spec §3.7:134 makes is per-prefix, not just at the end: a device
  // that has synced k ops must hold exactly what a device restoring from
  // scratch would compute for those same k ops. Asserting only the final state
  // would pass even if an intermediate value were wrong and later overwritten.
  const ops = sampleLog();
  let incremental = emptyState();
  for (let k = 0; k < ops.length; k++) {
    incremental = fold([ops[k]!], incremental);
    const scratch = fold(ops.slice(0, k + 1));
    expect(serializeState(incremental)).toBe(serializeState(scratch));
  }
});

test("the sample log actually exercises the interesting paths", () => {
  // A determinism proof over a log with no forks, no supersedes and no
  // anomalies proves determinism of nothing in particular.
  const s = fold(sampleLog());
  expect(s.txns.size).toBeGreaterThan(30);
  expect(s.forks.filter((f) => f.entity.kind === "txn").length).toBeGreaterThan(3);
  expect(s.forks.filter((f) => f.entity.kind === "rule").length).toBeGreaterThan(0);
  expect(s.rules.size).toBeGreaterThan(2);
  expect(s.checkpoints.length).toBeGreaterThan(0);
  expect([...s.txns.values()].filter((t) => t.superseded_by !== null).length).toBeGreaterThan(3);
  expect([...s.txns.values()].filter((t) => t.splits.length > 0).length).toBeGreaterThan(3);
  expect([...s.txns.values()].filter((t) => t.possible_duplicate_of !== null).length).toBeGreaterThan(0);
  expect(new Set(kinds(s))).toEqual(
    new Set([
      "possible_duplicate",
      "split_sum",
      "duplicate_ingest",
      "duplicate_create",
      "unknown_entity",
      "future_parent",
      "supersede_without_origin",
      "edit_of_superseded",
      "rate_set_for_home_currency",
      "rate_unset_for_home_currency",
      "home_currency_reset",
      "nonexistent_parent",
    ]),
  );
  // The identity rate survived a rate_unset aimed at it — the property that
  // makes every home-currency transaction in this log convertible by Task 12.
  expect(s.rates.get("AED")).toBe(1_000_000n);
  // The invariant the whole dedup design exists for, checked over the whole log.
  expect([...s.liveByIngestID.values()].every((id) => s.txns.get(id)!.superseded_by === null)).toBe(true);
  const liveIngestIDs = live(s).map((t) => t.ingest_id);
  expect(new Set(liveIngestIDs).size).toBe(liveIngestIDs.length);
});

// ---------------------------------------------------------------------------
// What serializeState does and does not witness
// ---------------------------------------------------------------------------

test("map insertion order is a policy, pinned by name rather than by comparing two runs", () => {
  // serializeState SORTS map keys, and the chunk-stability tests that do pin key
  // order compare two runs of the same code — so they catch chunking-dependence
  // and would not catch a policy change (moving a retired row to the end, say).
  // The policy: `txns` is create order and a row never moves; `liveByIngestID`
  // is order of last (re)insertion, so a supersede moves its ingest id to the
  // end. Both are deterministic; both are stated here so a change is deliberate.
  const s = fold([
    at(1n, ingested("i1", "t1")),
    at(2n, ingested("i2", "t2")),
    at(3n, ingested("i3", "t3")),
    at(4n, superseded("i1", "t4")),
  ]);
  expect([...s.txns.keys()]).toEqual(["t1", "t2", "t3", "t4"]);
  expect([...s.liveByIngestID.keys()]).toEqual([ingestID("i2"), ingestID("i3"), ingestID("i1")]);
});

test("the witness covers every field of State except the one it names", () => {
  // `canonical()` walks keys generically, so this stays true as State grows —
  // which is the property that makes serializeState usable as a witness at all.
  // The single exclusion is pinned here so a field added later cannot quietly
  // join it and drop out of the convergence claim.
  const s = emptyState();
  expect(notWitnessed()).toEqual(["appliedAtCursor"]);
  const witnessed = Object.keys(s).filter((k) => !notWitnessed().includes(k));
  expect(Object.keys(JSON.parse(serializeState(s))).sort()).toEqual(witnessed.sort());
});

// ---------------------------------------------------------------------------
// The sample log
// ---------------------------------------------------------------------------

/**
 * Regroups a flat entry list into the blobs it came from: consecutive entries
 * sharing a `seq` are one op_log row, and one row has exactly one writer.
 */
function asBlobs(entries: LogEntry[]): PositionedBlob[] {
  const groups: LogEntry[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]!.seq === e.seq) {
      expect(last[0]!.writer_id).toBe(e.writer_id); // one blob, one writer
      last.push(e);
    } else {
      groups.push([e]);
    }
  }
  return groups.map((g, i) => ({
    pos: { writer_id: g[0]!.writer_id, stream: "hot", writer_counter: BigInt(i + 1), seq: g[0]!.seq },
    body: encodeBlobOps(g.map((e) => e.op)),
  }));
}

/** A fixed permutation, so "arrived out of order" is the same disorder every run. */
function deterministicShuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  const rand = rng(77);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function chunksOf<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** A deterministic LCG — the sample log must be the same log on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

let cachedSample: LogEntry[] | undefined;

/**
 * The sample log, built once and shared.
 *
 * It must be *the same log* on every call and in every run, and two things
 * would otherwise stop it being: `opCounter` is global (so the ids would depend
 * on which tests ran first) and rebuilding would mint new ones each time. So it
 * gets its own id namespace and is memoized — a "determinism" test comparing two
 * logs that merely look alike proves nothing.
 */
function sampleLog(): LogEntry[] {
  if (cachedSample === undefined) {
    const saved = opCounter;
    opCounter = 1_000_000;
    cachedSample = buildSampleLog();
    opCounter = saved;
  }
  return cachedSample;
}

/**
 * ~180 ops covering every branch the fold has: clean edits, true forks (both
 * outcomes), ties, supersedes, refused splits, duplicate ingests, orphan edits,
 * future parents, rate changes and checkpoints — plus batched ops that share a
 * seq, which is what a client-authored blob actually looks like.
 */
function buildSampleLog(): LogEntry[] {
  const rand = rng(20260801);
  const out: LogEntry[] = [];
  let seq = 0n;
  const emit = (a: Authored, batched = false): void => {
    if (!batched) seq += 1n;
    out.push(at(seq, a));
  };
  const writers = ["dev-a", "dev-b", "dev-c"];
  const currencies = ["AED", "USD", "EUR"];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  let clock = Date.UTC(2026, 5, 1, 0, 0, 0);
  const tick = (): string => {
    clock += Math.floor(rand() * 600_000);
    return new Date(clock).toISOString();
  };

  interface Tracked {
    id: string;
    ingest: string;
    version: number;
    amount: bigint;
  }
  const txns: Tracked[] = [];

  emit(homeCurrency("AED", "dev-a", tick()));
  emit(rateSet("USD", "3672500", "dev-a", tick()));
  emit(rateSet("EUR", "4000000", "dev-b", tick()));

  // 45 ingests. Merchants and last4 repeat on purpose, so fingerprint
  // collisions happen without being contrived.
  for (let i = 0; i < 45; i++) {
    const amount = BigInt(1000 + Math.floor(rand() * 40) * 100);
    const t: Tracked = { id: `t${i}`, ingest: `i${i}`, version: 1, amount };
    emit(
      ingested(
        t.ingest,
        t.id,
        {
          amount_minor: `${amount}`,
          currency: pick(currencies),
          merchant_raw: `M${i % 9}`,
          last4: `${3700 + (i % 4)}`,
          posted_at: `2026-06-${String(1 + (i % 20)).padStart(2, "0")}T09:00:00Z`,
        },
        "ingest",
        tick(),
      ),
      // Every fifth ingest shares its predecessor's seq: ingest blobs are
      // singletons in reality, but the fold must not care.
      i > 0 && i % 5 === 0,
    );
    txns.push(t);
  }

  for (let i = 0; i < 120; i++) {
    const t = pick(txns);
    const w = pick(writers);
    const roll = rand();
    if (roll < 0.42) {
      // Clean edit two times out of five, stale parent one time in five: the
      // stale ones are the true forks.
      const stale = rand() < 0.25 && t.version > 1;
      const parent = stale ? t.version - 1 : t.version;
      emit(categorized(t.id, parent, `c${Math.floor(rand() * 6)}`, w, tick()));
      t.version += 1;
    } else if (roll < 0.55) {
      const bad = rand() < 0.3;
      const half = t.amount / 2n;
      const rest = bad ? t.amount - half - 1n : t.amount - half;
      emit(split(t.id, t.version, [["a", `${half}`], ["b", `${rest}`]], w, tick()));
      if (!bad) t.version += 1;
    } else if (roll < 0.68) {
      emit(edited(t.id, t.version, { merchant_raw: `E${Math.floor(rand() * 5)}` }, w, tick()));
      t.version += 1;
    } else if (roll < 0.76) {
      // Two devices editing the same head at the same instant: the writer_id
      // tie. They are two blobs and therefore two seqs — a blob has exactly one
      // writer, so a tie between writers can never be a batch.
      const tie = tick();
      emit(categorized(t.id, t.version, "tie-a", "dev-a", tie));
      emit(categorized(t.id, t.version, "tie-b", "dev-b", tie));
      t.version += 2;
    } else if (roll < 0.83) {
      const id = `s${i}`;
      emit(superseded(t.ingest, id, { amount_minor: `${t.amount + 100n}`, currency: pick(currencies) }, "ingest", tick()));
      txns.push({ id, ingest: t.ingest, version: 1, amount: t.amount + 100n });
    } else if (roll < 0.90) {
      const id = `r${i % 5}`;
      const existing = out.some((x) => x.op.entity?.id === id);
      emit(ruleAdded(id, existing ? 1 : null, { pattern: `P${i % 7}`, category: `c${i % 5}` }, w, tick()));
    } else if (roll < 0.95) {
      emit(pick([rateSet(pick(currencies), `${3_000_000 + i * 1000}`, w, tick()), rateUnset(pick(currencies), w, tick())]));
    } else {
      emit(checkpoint([head("ingest", "hot", `${i}`, "a"), head(w, "hot", `${i}`, "b")], w, tick()));
    }
  }

  // The rare branches are emitted deliberately rather than left to the dice: a
  // determinism proof over a log that happens not to contain a supersede-without
  // -origin proves nothing about supersede-without-origin.
  const twin = { amount_minor: "31400", currency: "AED", merchant_raw: "TWIN", last4: "9999", posted_at: "2026-06-09T08:00:00Z" };
  emit(ingested("i-twin-a", "twin-a", twin, "ingest", tick()));
  emit(ingested("i-twin-b", "twin-b", { ...twin, posted_at: "2026-06-09T20:00:00Z" }, "ingest", tick())); // possible_duplicate

  const last = txns[txns.length - 1]!;
  emit(ingested(last.ingest, "dup-ingest", {}, "ingest", tick())); // duplicate_ingest
  emit(ingested("i-extra", last.id, {}, "ingest", tick())); // duplicate_create
  emit(categorized("ghost", 1, "dining", "dev-a", tick())); // unknown_entity
  emit(categorized(last.id, last.version + 5, "dining", "dev-a", tick())); // future_parent
  emit(categorized(last.id, 0, "zero", "dev-a", tick())); // nonexistent_parent
  emit(superseded("i-orphan", "orphan", {}, "ingest", tick())); // supersede_without_origin
  emit(rateSet("AED", "2000000", "dev-a", tick())); // rate_set_for_home_currency
  emit(rateUnset("AED", "dev-a", tick())); // rate_unset_for_home_currency
  emit(homeCurrency("USD", "dev-a", tick())); // home_currency_reset
  return out;
}

