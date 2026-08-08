/**
 * The three configuration ops, end to end: wire, fold, state.
 *
 * They are the `home_currency_set` / `rate_set` shape — parent-free append-only
 * facts folded by position — so the tests here mirror the FX ones rather than
 * the versioned-entity ones. Record-level last-write-wins is forbidden for
 * transactions and splits (spec §3.3, because it breaks invariants across
 * records) and is correct for a keyed configuration value, where there is no
 * invariant across keys; `category_defined` therefore has no `parent_version`
 * and no fork resolution, and the last op naming an id is what that id means.
 *
 * The FIRST test in this file is the backwards-compatibility one, on purpose: a
 * log with no configuration ops must fold to exactly the state it folded to
 * before these ops existed, or the schema bump is not a no-op for data.
 */

import { expect, test } from "bun:test";
import { SCHEMA_VERSION, UnknownNewerVersionError, decodeBlobOps, encodeBlobOps, type Op, type OpType } from "../wire/op";
import { emptyState, serializeState, type State } from "./state";
import { applyOp, fold, type LogEntry } from "./replay";

let n = 0;

function op(type: OpType, payload: unknown, over: Partial<Op> = {}): Op {
  return {
    v: SCHEMA_VERSION,
    type,
    op_id: `cfg-${++n}`,
    authored_at: "2026-06-05T10:00:00Z",
    parent_version: null,
    payload,
    ...over,
  };
}

function entries(...ops: Op[]): LogEntry[] {
  return ops.map((o, i) => ({ op: o, seq: BigInt(i + 1), writer_id: "dev-a" }));
}

function foldOps(...ops: Op[]): State {
  return fold(entries(...ops));
}

const anomalyKinds = (s: State): string[] => s.anomalies.map((a) => a.kind);

// ---------------------------------------------------------------------------
// Backwards compatibility, first
// ---------------------------------------------------------------------------

test("an account with no configuration ops folds to today's defaults", () => {
  const s = foldOps(op("home_currency_set", { currency: "AED" }));
  expect([...s.banks]).toEqual([]);
  expect(s.budgetSplit).toBeNull();
  expect(s.categories.size).toBe(0);
  expect(s.anomalies).toEqual([]);
});

test("the empty state carries the configuration fields, so every consumer sees the same absence", () => {
  const s = emptyState();
  expect([...s.banks]).toEqual([]);
  expect(s.budgetSplit).toBeNull();
  expect([...s.categories]).toEqual([]);
});

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

test("each configuration op round-trips through the blob encoder", () => {
  const ops = [
    op("bank_declared", { bank: "dib", active: true }),
    op("budget_split_set", { need: 50, want: 30, saving: 20 }),
    op("category_defined", { id: "cat-1", name: "Groceries", kind: "spending", bucket: "need", color: "#88aa66", active: true }),
  ];
  const decoded = decodeBlobOps(encodeBlobOps(ops));
  expect(decoded.map((o) => o.type)).toEqual(["bank_declared", "budget_split_set", "category_defined"]);
  expect(decoded[2]!.payload).toEqual(ops[2]!.payload);
});

test("configuration ops are parent-free: an entity or a parent_version is refused by the wire", () => {
  for (const type of ["bank_declared", "budget_split_set", "category_defined"] as const) {
    expect(() => encodeBlobOps([op(type, {}, { entity: { kind: "config", id: "x" } })])).toThrow(/parent-free/);
    expect(() => encodeBlobOps([op(type, {}, { parent_version: 1 })])).toThrow(/parent-free/);
  }
});

test("configuration ops require schema v3, so an older client cannot read one as a v2-legal op", () => {
  for (const type of ["bank_declared", "budget_split_set", "category_defined"] as const) {
    expect(() => encodeBlobOps([op(type, {}, { v: 2 })])).toThrow(/requires schema v3/);
  }
});

// ---------------------------------------------------------------------------
// bank_declared
// ---------------------------------------------------------------------------

const bank = (b: string, active = true): Op => op("bank_declared", { bank: b, active });

test("bank_declared is last write per bank, and active:false retires one", () => {
  const s = foldOps(bank("dib"), bank("enbd"), bank("enbd", false));
  expect([...s.banks]).toEqual([
    ["dib", true],
    ["enbd", false],
  ]);
  expect(s.anomalies).toEqual([]);
});

/**
 * The reason this op is keyed rather than carrying the whole list. With a
 * `{banks: string[]}` replace, the second op below would drop "enbd" silently —
 * no fork (these are parent-free), no anomaly, and nothing for the user to see
 * beyond a bank they added going missing.
 */
test("two devices declaring different banks offline both survive", () => {
  const s = foldOps(bank("dib"), bank("enbd"), bank("adcb"));
  expect([...s.banks.keys()]).toEqual(["dib", "enbd", "adcb"]);
  expect([...s.banks.values()].every(Boolean)).toBe(true);
});

test("a malformed bank_declared is an invalid_payload anomaly and leaves the set alone", () => {
  for (const payload of [{}, { bank: "dib" }, { bank: "", active: true }, { bank: 7, active: true }, { bank: "dib", active: "yes" }, []]) {
    const s = foldOps(bank("dib"), op("bank_declared", payload));
    expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
    expect([...s.banks]).toEqual([["dib", true]]);
  }
});

// ---------------------------------------------------------------------------
// budget_split_set
// ---------------------------------------------------------------------------

test("budget_split_set replaces the split", () => {
  const s = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20 }), op("budget_split_set", { need: 60, want: 20, saving: 20 }));
  expect(s.budgetSplit).toEqual({ need: 60, want: 20, saving: 20 });
  expect(s.anomalies).toEqual([]);
});

test("a split that does not sum to 100 is an invalid_payload anomaly, never a normalisation", () => {
  const s = foldOps(op("budget_split_set", { need: 60, want: 30, saving: 20 }));
  expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
  expect(s.anomalies[0]!.detail).toContain("110");
  expect(s.budgetSplit).toBeNull();
});

test("split percentages are integers, and a fractional or negative one is refused", () => {
  for (const payload of [
    { need: 50.5, want: 29.5, saving: 20 },
    { need: -10, want: 60, saving: 50 },
    { need: "50", want: 30, saving: 20 },
    { need: 50, want: 30 },
    {},
  ]) {
    const s = foldOps(op("budget_split_set", payload));
    expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
    expect(s.budgetSplit).toBeNull();
  }
});

test("a valid split survives a later invalid one", () => {
  const s = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20 }), op("budget_split_set", { need: 1, want: 1, saving: 1 }));
  expect(s.budgetSplit).toEqual({ need: 50, want: 30, saving: 20 });
  expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
});

// ---------------------------------------------------------------------------
// budget_split_set's optional monthly total
//
// The FIRST test is the absent one, for the same reason the file's first test
// is: an account that never sets a total must fold exactly as it did before the
// field existed, or this is not an additive change.
// ---------------------------------------------------------------------------

test("a budget_split_set with no monthly total folds exactly as it did before the field existed", () => {
  const s = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20 }));
  expect(s.budgetSplit).toEqual({ need: 50, want: 30, saving: 20 });
  expect(s.budgetMonthlyTotal).toBeNull();
  expect(s.anomalies).toEqual([]);
  // Explicit null is the same statement as absence: "no total".
  const cleared = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20, monthly_total_minor: null }));
  expect(cleared.budgetMonthlyTotal).toBeNull();
  expect(cleared.anomalies).toEqual([]);
});

test("the empty state carries a null monthly total", () => {
  expect(emptyState().budgetMonthlyTotal).toBeNull();
});

test("a monthly total is minor units as a decimal string, folded to a bigint", () => {
  const s = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20, monthly_total_minor: "1200000" }));
  expect(s.budgetMonthlyTotal).toBe(1_200_000n);
  expect(s.anomalies).toEqual([]);
});

test("a monthly total above 2^53 minor units round-trips exactly", () => {
  const huge = "9007199254740993"; // 2^53 + 1, the smallest integer a float64 cannot hold
  const s = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20, monthly_total_minor: huge }));
  expect(s.budgetMonthlyTotal).toBe(BigInt(huge));
  expect(s.budgetMonthlyTotal?.toString(10)).toBe(huge);
  // The whole point: a `number` cannot hold this, so nothing on the path may be one.
  expect(Number(huge).toString()).not.toBe(huge);
  expect(serializeState(s)).toContain(`"budgetMonthlyTotal":"${huge}"`);
});

test("a monthly total that is a JSON number, negative, or not an integer is an invalid_payload anomaly", () => {
  for (const total of [1200000, "12.5", "", "-1", "1e6", " 12 ", "0x10", true] as unknown[]) {
    const s = foldOps(
      op("budget_split_set", { need: 50, want: 30, saving: 20 }),
      op("budget_split_set", { need: 60, want: 20, saving: 20, monthly_total_minor: total }),
    );
    expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
    // Refused whole: neither half of the rejected op took effect.
    expect(s.budgetSplit).toEqual({ need: 50, want: 30, saving: 20 });
    expect(s.budgetMonthlyTotal).toBeNull();
  }
});

test("a later split with no total clears the total, because one op carries the whole plan", () => {
  const s = foldOps(
    op("budget_split_set", { need: 50, want: 30, saving: 20, monthly_total_minor: "1200000" }),
    op("budget_split_set", { need: 60, want: 20, saving: 20 }),
  );
  expect(s.budgetSplit).toEqual({ need: 60, want: 20, saving: 20 });
  expect(s.budgetMonthlyTotal).toBeNull();
  expect(s.anomalies).toEqual([]);
});

test("zero is a total a user can state, and is not the same as no total", () => {
  const s = foldOps(op("budget_split_set", { need: 50, want: 30, saving: 20, monthly_total_minor: "0" }));
  expect(s.budgetMonthlyTotal).toBe(0n);
});

// ---------------------------------------------------------------------------
// category_defined
// ---------------------------------------------------------------------------

const cat = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "cat-1",
  name: "Groceries",
  kind: "spending",
  bucket: "need",
  color: "#88aa66",
  active: true,
  ...over,
});

test("category_defined is last write per id", () => {
  const s = foldOps(
    op("category_defined", cat()),
    op("category_defined", cat({ id: "cat-2", name: "Salary", kind: "income", bucket: null })),
    op("category_defined", cat({ name: "Food", bucket: "want" })),
  );
  expect(s.categories.get("cat-1")).toEqual({ id: "cat-1", name: "Food", kind: "spending", bucket: "want", color: "#88aa66", active: true });
  expect(s.categories.get("cat-2")).toEqual({ id: "cat-2", name: "Salary", kind: "income", bucket: null, color: "#88aa66", active: true });
  expect(s.anomalies).toEqual([]);
});

test("active:false retires a category rather than deleting it, so history stays readable", () => {
  const s = foldOps(op("category_defined", cat()), op("category_defined", cat({ active: false })));
  expect(s.categories.get("cat-1")?.active).toBe(false);
  expect(s.categories.get("cat-1")?.name).toBe("Groceries");
  expect(s.categories.size).toBe(1);
});

test("a spending category needs a bucket and the other kinds must not carry one", () => {
  const bad = [
    cat({ bucket: null }),
    cat({ bucket: undefined }),
    cat({ kind: "income", bucket: "need" }),
    cat({ kind: "excluded", bucket: "saving" }),
    cat({ kind: "spending", bucket: "misc" }),
  ];
  for (const payload of bad) {
    const s = foldOps(op("category_defined", payload));
    expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
    expect(s.categories.size).toBe(0);
  }
  for (const payload of [cat({ kind: "income", bucket: null }), cat({ kind: "excluded" })]) {
    const ok = foldOps(op("category_defined", { ...payload, bucket: null }));
    expect(ok.anomalies).toEqual([]);
    expect(ok.categories.get("cat-1")?.bucket).toBeNull();
  }
});

test("a category needs an id, a name, a known kind and an active flag", () => {
  for (const payload of [
    cat({ id: "" }),
    cat({ id: 7 }),
    cat({ name: "" }),
    cat({ kind: "spendy" }),
    cat({ active: "yes" }),
    cat({ color: 7 }),
    {},
  ]) {
    const s = foldOps(op("category_defined", payload));
    expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
    expect(s.categories.size).toBe(0);
  }
});

test("colour is optional: a writer that does not choose one leaves it null", () => {
  const { color: _color, ...rest } = cat();
  const s = foldOps(op("category_defined", rest));
  expect(s.anomalies).toEqual([]);
  expect(s.categories.get("cat-1")?.color).toBeNull();
});

test("an invalid redefinition leaves the previous definition standing", () => {
  const s = foldOps(op("category_defined", cat()), op("category_defined", cat({ kind: "nope" })));
  expect(s.categories.get("cat-1")?.kind).toBe("spending");
  expect(anomalyKinds(s)).toEqual(["invalid_payload"]);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("configuration is witnessed by serializeState, so a divergence in it is reported", () => {
  const a = foldOps(bank("dib"), op("budget_split_set", { need: 60, want: 20, saving: 20 }), op("category_defined", cat()));
  const b = foldOps(bank("dib"), op("budget_split_set", { need: 60, want: 20, saving: 20 }), op("category_defined", cat()));
  expect(serializeState(a)).toBe(serializeState(b));
  const c = foldOps(bank("enbd"), op("budget_split_set", { need: 60, want: 20, saving: 20 }), op("category_defined", cat()));
  expect(serializeState(c)).not.toBe(serializeState(a));
});

// ---------------------------------------------------------------------------
// What the bump costs a reader, and what it must not cost
// ---------------------------------------------------------------------------

/**
 * The trap behind stamping an op's version.
 *
 * A writer must stamp the LOWEST version at which its op folds — not the
 * build's ceiling, which charges every older reader a hard stop for ops that
 * need nothing new, and not the type's minimum alone, because a payload can
 * have a floor of its own. `verified_origin_domain` arrived at v2 and the fold
 * refuses it below that, so a v1-stamped op carrying it is not merely
 * over-permissive: the transaction becomes an anomaly and never appears.
 *
 * `internal/v2/ingest`'s `txnPayload.schemaVersion` is the rule that keeps this
 * unreachable from the pipeline; this test is why that rule exists.
 */
test("a txn payload's own version floor is above its type's minimum", () => {
  const payload = {
    amount_minor: "25000",
    currency: "AED",
    direction: "debit",
    posted_at: "2026-06-05T09:00:00Z",
    merchant_raw: "CARREFOUR",
    last4: "3701",
    verified_origin_domain: "bank.example",
  };
  const ingest = (v: number): Op =>
    op("txn_ingested", payload, { v, entity: { kind: "txn", id: "t1" }, ingest_id: "a".repeat(64) });

  const bad = fold(entries(ingest(1)));
  expect(anomalyKinds(bad)).toEqual(["invalid_payload"]);
  expect(bad.anomalies[0]!.detail).toContain("verified_origin_domain requires schema v2");
  expect(bad.txns.size).toBe(0);

  const good = fold(entries(ingest(2)));
  expect(good.anomalies).toEqual([]);
  expect(good.txns.get("t1")?.verified_origin_domain).toBe("bank.example");
});

// ---------------------------------------------------------------------------
// The hard stop the version bump trades on
// ---------------------------------------------------------------------------

test("a newer client's configuration op hard-stops an older reader instead of being skipped", () => {
  // The mechanism under test is `v > this build's SCHEMA_VERSION`, which is the
  // same comparison a v2 build makes against the v3 ops this task adds. It is
  // exercised one version above THIS build so it cannot silently stop being a
  // test the moment SchemaVersion moves again.
  const good = op("bank_declared", { bank: "dib", active: true });
  const newer = op("bank_declared", { bank: "enbd", active: true }, { v: SCHEMA_VERSION + 1 });
  const body = new TextEncoder().encode(JSON.stringify({ v: SCHEMA_VERSION + 1, kind: "ops", ops: [good, newer] }));

  // STOP, not skip: the whole blob is refused, including the op before it that
  // this build understands perfectly well.
  expect(() => decodeBlobOps(body)).toThrow(UnknownNewerVersionError);

  // And at the fold, where it must escape applyOp's catch-all rather than
  // becoming an anomaly.
  const s = emptyState();
  applyOp(s, { op: good, seq: 1n, writer_id: "dev-a" });
  expect([...s.banks]).toEqual([["dib", true]]);
  expect(() => applyOp(s, { op: newer, seq: 2n, writer_id: "dev-a" })).toThrow(UnknownNewerVersionError);
  expect([...s.banks]).toEqual([["dib", true]]);
  expect(s.anomalies).toEqual([]);
});
