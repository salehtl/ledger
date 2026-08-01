import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  assertFXCasesAreFresh,
  at,
  categorized,
  edited,
  homeCurrency,
  ingested,
  rateSet,
  rateUnset,
  superseded,
  unparsedIngest,
  FX_CONFORMANCE_DIR,
  type Authored,
  type FXCase,
} from "../../scripts/gen-fx-conformance";
import { compareUTF8, encodeBlobOps } from "../wire/op";
import { fold, foldBlobs, type LogEntry, type PositionedBlob } from "./replay";
import { emptyState, serializeState, type State } from "./state";
import { HOME_IDENTITY_MICRO, convert } from "./fx";

// ---------------------------------------------------------------------------
// Readers. Each returns the SAME shape the conformance cases pin, so a unit
// test and a cross-executor case are two views of one expectation.
// ---------------------------------------------------------------------------

const snapshotsOf = (s: State): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (const [id, t] of s.txns) out[id] = t.amount_home_minor === null ? null : `${t.amount_home_minor}`;
  return out;
};

const pendingOf = (s: State): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  // compareUTF8, not the default sort: the manifest promises the Go reader UTF-8
  // BYTE order, and JavaScript's default compares UTF-16 code units — the two
  // disagree for any id containing a character above U+FFFF. Ids are ASCII
  // today, which is exactly why the wrong comparator here would never be caught.
  for (const [ccy, ids] of s.pendingByCurrency) out[ccy] = [...ids].sort(compareUTF8);
  return out;
};

const ratesOf = (s: State): Record<string, string | null> => {
  const out: Record<string, string | null> = {};
  for (const [ccy, micro] of s.rates) out[ccy] = micro === null ? null : `${micro}`;
  return out;
};

const kinds = (s: State): string[] => s.anomalies.map((a) => a.kind);
const snap = (s: State, id: string): bigint | null => s.txns.get(id)!.amount_home_minor;

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

test("BigInt is required because the INTERMEDIATE product overflows a double", () => {
  // The hazard is amount*rate, not the result: 25 billion fils at the USD peg is
  // a 9.18e16 product and a 9.18e10 answer, and only the first is past 2^53.
  const amount = 25_000_000_000n;
  const rate = 3_672_500n;
  expect(Number(amount * rate)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  expect(convert(amount, rate)).toBe(91_812_500_000n);

  // The plan's version of this test then asserted that the float path DIFFERS on
  // that pair. It does not: 91812500000000000 is 918125 x 10^11, divisible by
  // 2^11, and the spacing of doubles at 9.18e16 is 16 — so the product happens to
  // be exactly representable and both paths agree. "Past 2^53" does not imply
  // "wrong"; it implies "no longer guaranteed right", which is a different claim
  // and needs a pair that actually lands between two doubles.
  expect(Number(amount) * Number(rate)).toBe(Number(amount * rate));
});

test("the float path is measurably wrong once the product lands between two doubles", () => {
  // Chosen so the exact product ends in ...499999: one unit BELOW the half-up
  // boundary. The nearest double is ...500000, so a float64 executor rounds up,
  // crosses the boundary and reports one fil too many — a number that looks
  // entirely plausible next to the right one.
  const amount = 25_000_922_499n;
  const rate = 3_672_501n;
  const exact = amount * rate;
  expect(exact).toBe(91_815_912_878_499_999n);
  expect(BigInt(Number(amount) * Number(rate)) - exact).toBe(1n);

  expect(convert(amount, rate)).toBe(91_815_912_878n);
  const naive = Math.floor((Number(amount) * Number(rate) + 500_000) / 1_000_000);
  expect(naive).toBe(91_815_912_879); // one fil too many, from the intermediate alone
  expect(BigInt(naive)).not.toBe(convert(amount, rate));
});

test("half-up rounding matches Go's ConvertToAEDFils", () => {
  expect(convert(1n, 1_500_000n)).toBe(2n); // exactly .5 rounds up
  expect(convert(1n, 1_499_999n)).toBe(1n); // a hair under stays down
  expect(convert(1n, 1_500_001n)).toBe(2n);
  expect(convert(10_000n, 3_672_500n)).toBe(36_725n); // the USD peg, 100.00 USD
  expect(convert(1n, 1n)).toBe(0n); // rounds to nothing, and says so rather than 1
});

test("the identity rate is exactly the amount, at any magnitude", () => {
  for (const a of [1n, 25_000n, 9_007_199_254_740_993n, 10n ** 30n]) {
    expect(convert(a, HOME_IDENTITY_MICRO)).toBe(a);
  }
});

test("convert asserts the positivity it depends on rather than assuming it", () => {
  // Truncating division is half-up ONLY for non-negative operands: BigInt
  // truncates toward zero, so -1.5 would become -1, i.e. half-up away from the
  // rule. Amounts are positive by invariant (direction carries the sign) — this
  // is the assertion that the invariant is still true when it gets here.
  expect(() => convert(-1n, 1_000_000n)).toThrow(/positive/);
  expect(() => convert(1n, -1_000_000n)).toThrow(/positive/);
  expect(convert(0n, 3_672_500n)).toBe(0n); // zero is not negative, and converts
});

// ---------------------------------------------------------------------------
// P — the position a snapshot is computed at (spec §3.7:133)
// ---------------------------------------------------------------------------

test("a transaction with no rate stays visible with a null snapshot", () => {
  const s = fold([at(1n, homeCurrency("AED")), at(2n, ingested("i1", "t1", { currency: "USD" }))]);
  expect(snap(s, "t1")).toBeNull();
  expect(s.txns.get("t1")!.amount_minor).toBe(10_000n); // shown in full, in its own currency
  expect(pendingOf(s)).toEqual({ USD: ["t1"] });
});

test("a rate live at the transaction's own position freezes it there: P = pos(T)", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(pendingOf(s)).toEqual({});
});

test("a rate arriving after the transaction backfills it: P > pos(T)", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD" })),
    at(3n, rateSet("USD", "3672500")),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(pendingOf(s)).toEqual({});
});

test("home_currency_set backfills home-currency transactions ingested before it", () => {
  // Without this the row would stay null forever: no rate_set(AED) can ever
  // reach it (that is an anomaly), so its P would never exist.
  const s = fold([at(1n, ingested("i1", "t1", { currency: "AED" })), at(2n, homeCurrency("AED"))]);
  expect(snap(s, "t1")).toBe(10_000n);
  expect(pendingOf(s)).toEqual({});
});

test("a later rate_set backfills only the still-null transactions", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD" })),
    at(3n, rateSet("USD", "3672500")),
    at(4n, ingested("i2", "t2", { currency: "USD" })),
    at(5n, rateSet("USD", "4000000")),
    at(6n, ingested("i3", "t3", { currency: "USD" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n); // backfilled at seq 3
  expect(snap(s, "t2")).toBe(36_725n); // frozen at seq 4, against the seq-3 head
  expect(snap(s, "t3")).toBe(40_000n); // the seq-5 head reaches forward only
});

test("the head at P is used, never the latest head in the log", () => {
  // The single-assertion form of the rule, stated so a regression names itself:
  // an executor that froze against the FINAL head would report 40000 here.
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, rateSet("USD", "4000000")),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
});

test("rate_unset leaves earlier freezes alone and makes later transactions pending", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, rateUnset("USD")),
    at(5n, ingested("i2", "t2", { currency: "USD" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(snap(s, "t2")).toBeNull();
  expect(ratesOf(s)).toEqual({ AED: "1000000", USD: null });
  expect(pendingOf(s)).toEqual({ USD: ["t2"] });
});

test("a null head is not a rate: a row ingested into an unset gap waits for the next real one", () => {
  // "P is the smallest position >= pos(T) at which a head rate EXISTS" has to
  // read "exists and is non-null", or a row after an unset would convert against
  // nothing. So t2 skips the unset entirely and freezes at the seq-6 rate.
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, rateUnset("USD")),
    at(5n, ingested("i2", "t2", { currency: "USD" })),
    at(6n, rateSet("USD", "5000000")),
  ]);
  expect(snap(s, "t1")).toBe(36_725n); // untouched by both later ops
  expect(snap(s, "t2")).toBe(50_000n);
});

test("a rate_unset does not thaw a row that is already frozen", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, rateUnset("USD")),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(pendingOf(s)).toEqual({});
});

// ---------------------------------------------------------------------------
// The home currency
// ---------------------------------------------------------------------------

test("a rate_set for the home currency is an anomaly, not a re-denomination", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("AED", "2000000")),
    at(3n, ingested("i1", "t1", { currency: "AED" })),
  ]);
  expect(snap(s, "t1")).toBe(10_000n); // identity, unchanged
  expect(kinds(s)).toContain("rate_set_for_home_currency");
});

test("the home currency's identity survives a rate_unset aimed at it", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateUnset("AED")),
    at(3n, ingested("i1", "t1", { currency: "AED" })),
  ]);
  expect(snap(s, "t1")).toBe(10_000n);
  expect(kinds(s)).toContain("rate_unset_for_home_currency");
});

test("a rate for the currency that later becomes home is an anomaly on that side too", () => {
  // The mirror of rate_set_for_home_currency across the onboarding op. The rate
  // really did apply to t1 — §3.7 never rewrites a frozen snapshot, so it keeps
  // its 2.0 basis — which means the log now holds two home-currency bases. That
  // is exactly the silent re-denomination the other guard exists to prevent, so
  // it is surfaced here rather than left to be noticed in a total.
  const s = fold([
    at(1n, rateSet("AED", "2000000")),
    at(2n, ingested("i1", "t1", { currency: "AED" })),
    at(3n, homeCurrency("AED")),
    at(4n, ingested("i2", "t2", { currency: "AED" })),
  ]);
  expect(snap(s, "t1")).toBe(20_000n); // frozen before onboarding, and left alone
  expect(snap(s, "t2")).toBe(10_000n); // identity from seq 3 on
  expect(ratesOf(s)).toEqual({ AED: "1000000" });
  expect(kinds(s)).toEqual(["rate_set_before_home_currency"]);
  expect(s.anomalies[0]!.at_seq).toBe(3n); // recorded at the onboarding op, which is where it is knowable
});

test("a pre-onboarding rate, an unset, and a row still pending at onboarding, in one log", () => {
  // The combined shape. The earlier claim that no single log can carry both a
  // pre-onboarding rate head and a home-currency row still pending at onboarding
  // was wrong: an unset in between produces exactly that, and it is the case
  // where the anomaly fires on a NULL head — which is why the guard keys on "a
  // rate head exists" rather than on "a non-null rate head exists".
  const s = fold([
    at(1n, rateSet("AED", "2000000")),
    at(2n, ingested("i1", "t1", { currency: "AED" })), // freezes at the 2.0 basis
    at(3n, rateUnset("AED")), // AED is not home yet, so this is an ordinary unset
    at(4n, ingested("i2", "t2", { currency: "AED" })), // pending: the head is null
    at(5n, homeCurrency("AED")),
  ]);
  expect(snap(s, "t1")).toBe(20_000n); // kept, per §3.7's no-rewrite rule
  expect(snap(s, "t2")).toBe(10_000n); // backfilled by the onboarding op
  expect(pendingOf(s)).toEqual({});
  expect(kinds(s)).toEqual(["rate_set_before_home_currency"]);
  expect(s.anomalies[0]!.detail).toContain("unset"); // the head it names really was null
});

test("a rate for a foreign currency before onboarding is ordinary, not an anomaly", () => {
  // The guard must key on the currency being adopted as home, not on ordering.
  const s = fold([
    at(1n, rateSet("USD", "3672500")),
    at(2n, ingested("i1", "t1", { currency: "USD" })),
    at(3n, homeCurrency("AED")),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(kinds(s)).toEqual([]);
});

test("a second home_currency_set is ignored, and does not re-backfill anything", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD" })),
    at(3n, homeCurrency("USD")),
  ]);
  expect(s.homeCurrency).toBe("AED");
  expect(snap(s, "t1")).toBeNull(); // USD is still a foreign currency with no rate
  expect(kinds(s)).toEqual(["home_currency_reset"]);
});

// ---------------------------------------------------------------------------
// Supersede recomputes at its own position (spec §3.7:129)
// ---------------------------------------------------------------------------

test("a supersede recomputes at its own position and never inherits", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, rateSet("USD", "4000000")),
    // The template fix: it was AED all along.
    at(5n, superseded("i1", "t2", { currency: "AED" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(snap(s, "t2")).toBe(10_000n); // AED identity, not inherited and not 40000
});

test("a supersede into a currency with a live rate freezes immediately, never permanently null", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("EUR", "4000000")),
    at(3n, ingested("i1", "t1", { currency: "USD" })), // pending: no USD rate
    at(4n, superseded("i1", "t2", { currency: "EUR" })),
  ]);
  expect(snap(s, "t1")).toBeNull();
  expect(snap(s, "t2")).toBe(40_000n);
  expect(pendingOf(s)).toEqual({}); // t1 left the index when it was retired
});

test("a superseded pending transaction is not backfilled by a later rate_set", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "USD" })),
    at(3n, superseded("i1", "t2", { currency: "AED" })),
    at(4n, rateSet("USD", "3672500")),
  ]);
  expect(snap(s, "t1")).toBeNull(); // retired, and left alone
  expect(snap(s, "t2")).toBe(10_000n);
});

test("a supersede with no origin still gets a snapshot at its own position", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, superseded("i-orphan", "t1", { currency: "USD" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(kinds(s)).toContain("supersede_without_origin");
});

test("a supersede changing only the amount recomputes at the head live at its position", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD", amount_minor: "10000" })),
    at(4n, rateSet("USD", "4000000")),
    at(5n, superseded("i1", "t2", { currency: "USD", amount_minor: "12000" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
  expect(snap(s, "t2")).toBe(48_000n); // 12000 at the seq-4 head, not the seq-2 one
});

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

test("a recompute edit carries the value, and a null re-arms the row for backfill", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, edited("t1", 1, { amount_home_minor: "40000" })),
  ]);
  expect(snap(s, "t1")).toBe(40_000n);
  expect(pendingOf(s)).toEqual({});

  fold([at(5n, edited("t1", 2, { amount_home_minor: null })), at(6n, rateSet("USD", "5000000"))], s);
  expect(snap(s, "t1")).toBe(50_000n);
});

test("an explicit null on a HOME-currency row re-arms a bucket nothing can ever drain", () => {
  // Recorded rather than fixed, and pinned here so it is a decision. A carrying
  // edit may null any row's snapshot (§3.7:137), including a home-currency one —
  // and `pendingByCurrency[H]` is the one bucket no `rate_set` can drain, since
  // a rate for the home currency is refused and `home_currency_set` is one-shot.
  // The state is deterministic, visible, and repairable only by a later carrying
  // edit. Raising an anomaly at the edit was considered and rejected: the edit is
  // legal, the damage is self-inflicted and recoverable, and inventing an anomaly
  // kind changes the frozen cross-executor vocabulary for it.
  //
  // Task 13 and any missing-rates UI must NOT read this as "the home currency
  // needs a rate" — there is no rate to add, and offering one leads to an op that
  // is itself an anomaly.
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, ingested("i1", "t1", { currency: "AED" })),
    at(3n, edited("t1", 1, { amount_home_minor: null })),
    at(4n, rateSet("AED", "2000000")), // refused, so it backfills nothing
  ]);
  expect(snap(s, "t1")).toBeNull();
  expect(pendingOf(s)).toEqual({ AED: ["t1"] });
  expect(kinds(s)).toEqual(["rate_set_for_home_currency"]);

  fold([at(5n, edited("t1", 2, { amount_home_minor: "10000" }))], s);
  expect(snap(s, "t1")).toBe(10_000n);
  expect(pendingOf(s)).toEqual({});
});

test("an ordinary edit does not disturb a frozen snapshot", () => {
  const s = fold([
    at(1n, homeCurrency("AED")),
    at(2n, rateSet("USD", "3672500")),
    at(3n, ingested("i1", "t1", { currency: "USD" })),
    at(4n, categorized("t1", 1, "groceries")),
    at(5n, edited("t1", 2, { merchant_raw: "SPINNEYS" })),
  ]);
  expect(snap(s, "t1")).toBe(36_725n);
});

// ---------------------------------------------------------------------------
// Prefix-monotonicity (spec §3.3:64, §3.7:134)
// ---------------------------------------------------------------------------

test("snapshots are identical whether the log is synced in one chunk or ten", () => {
  const ops = fxSampleOps();
  const whole = fold(ops);
  for (const size of [1, 3, 7, 10, 50, 997]) {
    let inc = emptyState();
    for (const chunk of chunksOf(ops, size)) inc = fold(chunk, inc);
    expect(snapshotsOf(inc)).toEqual(snapshotsOf(whole));
    expect(serializeState(inc)).toBe(serializeState(whole));
  }
});

test("incremental application in seq order equals a full re-fold from 0, at EVERY prefix", () => {
  // The claim §3.7:134 makes is per-prefix, not just at the end: a device that
  // has synced k ops must hold exactly what a device restoring from scratch
  // computes for those same k. Asserting only the final state would pass even
  // with an intermediate snapshot that was wrong and later overwritten — which
  // is precisely how an end-of-fold freeze would look.
  const ops = fxSampleOps();
  let incremental = emptyState();
  for (let k = 0; k < ops.length; k++) {
    incremental = fold([ops[k]!], incremental);
    const scratch = fold(ops.slice(0, k + 1));
    expect(snapshotsOf(incremental)).toEqual(snapshotsOf(scratch));
    expect(serializeState(incremental)).toBe(serializeState(scratch));
  }
});

test("a snapshot's only transition is null to value, and only an op that carries one may change it", () => {
  // The property that makes "compute once, freeze" safe on a device syncing in
  // chunks. Extending the prefix may FILL a snapshot; nothing in the fold may
  // rewrite one that is already filled. The single exception is a txn_edited
  // that carries amount_home_minor explicitly, which is a logged decision by the
  // user (§3.7:137) rather than a re-derivation, and it must be the op being
  // applied and name that very row.
  const ops = fxSampleOps();
  const s = emptyState();
  const frozen = new Map<string, bigint>();
  let backfilled = 0;
  let frozenAtCreate = 0;
  let rewrittenByEdit = 0;

  for (const e of ops) {
    fold([e], s);
    const carries =
      e.op.type === "txn_edited" && (e.op.payload as Record<string, unknown>)["amount_home_minor"] !== undefined;
    const target = e.op.entity?.id;
    for (const [id, t] of s.txns) {
      const before = frozen.get(id);
      const explicit = carries && target === id;
      if (t.amount_home_minor !== null) {
        if (before === undefined) {
          if (e.op.entity?.id === id && (e.op.type === "txn_ingested" || e.op.type === "txn_superseded")) frozenAtCreate++;
          else if (!explicit) backfilled++;
        } else if (before !== t.amount_home_minor) {
          expect({ id, at: e.op.type, explicit }).toEqual({ id, at: e.op.type, explicit: true });
          rewrittenByEdit++;
        }
        frozen.set(id, t.amount_home_minor);
      } else if (before !== undefined) {
        // A frozen value went back to null. Only an explicit edit may do that.
        expect({ id, at: e.op.type, explicit }).toEqual({ id, at: e.op.type, explicit: true });
        frozen.delete(id);
      }
    }
  }

  // A monotonicity proof over a log where nothing was ever backfilled proves
  // nothing about backfill.
  expect(frozenAtCreate).toBeGreaterThan(20);
  expect(backfilled).toBeGreaterThan(5);
  expect(rewrittenByEdit).toBeGreaterThan(2);
});

test("the FX sample log actually exercises the interesting paths", () => {
  const s = fold(fxSampleOps());
  const txns = [...s.txns.values()];
  expect(txns.length).toBeGreaterThan(60);
  expect(txns.filter((t) => t.amount_home_minor !== null).length).toBeGreaterThan(40);
  expect(txns.filter((t) => t.amount_home_minor === null && t.superseded_by === null).length).toBeGreaterThan(2);
  expect(txns.filter((t) => t.superseded_by !== null).length).toBeGreaterThan(5);
  expect(new Set(txns.filter((t) => !t.unparsed).map((t) => t.currency)).size).toBe(4);
  expect([...s.rates.values()].filter((r) => r === null).length).toBeGreaterThan(0); // a live unset
  expect(kinds(s)).toContain("rate_set_for_home_currency");
  // Every live row is either frozen or in the pending index, and no frozen row
  // is in it: the index the backfill drains is exact at the end of the log.
  const indexed = new Set([...s.pendingByCurrency.values()].flatMap((ids) => [...ids]));
  for (const t of txns) {
    if (t.superseded_by !== null) expect(indexed.has(t.id)).toBe(false);
    // An unparsed row is live with a null snapshot and still does not belong
    // here: its currency is "", which no `rate_set` can name, so it would sit in
    // a bucket nothing can ever drain.
    else if (t.unparsed) expect(indexed.has(t.id)).toBe(false);
    else expect(indexed.has(t.id)).toBe(t.amount_home_minor === null);
  }
  // The unparsed branch above is reached, and by more than one row: a branch no
  // fixture exercises is an assertion about nothing.
  expect(txns.filter((t) => t.unparsed && t.superseded_by === null)).toHaveLength(2);
  expect(s.pendingByCurrency.has("")).toBe(false);
});

// ---------------------------------------------------------------------------
// The cross-executor cases (conformance/fx)
// ---------------------------------------------------------------------------

const caseFiles = readdirSync(FX_CONFORMANCE_DIR)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .sort();

test("the conformance directory is not empty and is not a fossil", async () => {
  expect(caseFiles.length).toBeGreaterThanOrEqual(10);
  await assertFXCasesAreFresh();
});

for (const file of caseFiles) {
  const c = JSON.parse(readFileSync(`${FX_CONFORMANCE_DIR}/${file}`, "utf8")) as FXCase;
  test(`fx conformance: ${c.name}`, () => {
    // Through the wire encoder, not around it: a case whose ops this executor
    // cannot encode and decode is not a case the Go executor could read either,
    // and that failure would otherwise surface only in Phase 3.
    const s = foldBlobs(asBlobs(c.entries.map((e) => ({ op: e.op, seq: BigInt(e.seq), writer_id: e.writer_id }))));
    expect(s.homeCurrency).toBe(c.expect.home_currency);
    expect(snapshotsOf(s)).toEqual(c.expect.snapshots);
    expect(ratesOf(s)).toEqual(c.expect.rates);
    expect(pendingOf(s)).toEqual(c.expect.pending);
    expect(s.anomalies.map((a) => ({ kind: a.kind, at_seq: `${a.at_seq}` }))).toEqual(c.expect.anomalies);
  });
}

// ---------------------------------------------------------------------------
// The sample log
// ---------------------------------------------------------------------------

/** Regroups a flat entry list into blobs: consecutive entries sharing a seq are one row. */
function asBlobs(entries: LogEntry[]): PositionedBlob[] {
  const groups: LogEntry[][] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0]!.seq === e.seq) {
      expect(last[0]!.writer_id).toBe(e.writer_id); // one blob, one writer, one seq
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

/** Built once and shared: a determinism test over two logs that merely look alike proves nothing. */
function fxSampleOps(): LogEntry[] {
  if (cachedSample === undefined) cachedSample = buildFXSampleLog();
  return cachedSample;
}

/**
 * ~300 ops over four currencies, shaped around the FX branches specifically:
 * rows ingested before onboarding, rows that wait for a rate, rates set and
 * unset and set again, supersedes that change currency, explicit recompute
 * edits (including back to null), ops batched into one blob, and a rate_set
 * aimed at the home currency.
 *
 * GBP deliberately never gets a rate, so the log ends with live rows that are
 * still — correctly — unconverted.
 */
function buildFXSampleLog(): LogEntry[] {
  const rand = rng(20260801);
  const out: LogEntry[] = [];
  let seq = 0n;
  const emit = (a: Authored, batched = false): void => {
    if (!batched) seq += 1n;
    out.push(at(seq, a));
  };
  const currencies = ["AED", "USD", "EUR", "GBP"];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  interface Tracked {
    id: string;
    ingest: string;
    currency: string;
    amount: bigint;
    version: number;
  }
  const txns: Tracked[] = [];
  let n = 0;

  const ingest = (currency: string, batched = false): Tracked => {
    n += 1;
    const t: Tracked = {
      id: `t${n}`,
      ingest: `i${n}`,
      currency,
      amount: BigInt(1000 + Math.floor(rand() * 500) * 100),
      version: 1,
    };
    emit(
      ingested(t.ingest, t.id, {
        currency,
        amount_minor: `${t.amount}`,
        merchant_raw: `M${n % 7}`,
        last4: `${3700 + (n % 4)}`,
        posted_at: `2026-06-${String(1 + (n % 20)).padStart(2, "0")}T09:00:00Z`,
      }),
      batched,
    );
    txns.push(t);
    return t;
  };

  // Eight rows BEFORE onboarding, one per currency twice over: the AED ones can
  // only ever be converted by the backfill home_currency_set performs.
  for (let i = 0; i < 8; i++) ingest(currencies[i % 4]!);
  emit(homeCurrency("AED"));
  emit(rateSet("USD", "3672500"));

  for (let i = 0; i < 290; i++) {
    const roll = rand();
    if (roll < 0.42) {
      // Every seventh ingest shares its predecessor's seq: one blob, two ops.
      ingest(pick(currencies), i % 7 === 6);
    } else if (roll < 0.6) {
      emit(rateSet(pick(["USD", "EUR"]), `${500_000 + Math.floor(rand() * 8_000_000)}`, pick(["dev-a", "dev-b"])));
    } else if (roll < 0.67) {
      emit(rateUnset(pick(["USD", "EUR"])));
    } else if (roll < 0.79) {
      const t = pick(txns);
      n += 1;
      const currency = rand() < 0.4 ? pick(currencies) : t.currency;
      const amount = t.amount + 100n;
      emit(superseded(t.ingest, `s${n}`, { currency, amount_minor: `${amount}` }));
      txns.push({ id: `s${n}`, ingest: t.ingest, currency, amount, version: 1 });
    } else if (roll < 0.88) {
      const t = pick(txns);
      const value = rand() < 0.3 ? null : `${1000n + BigInt(Math.floor(rand() * 90_000))}`;
      emit(edited(t.id, t.version, { amount_home_minor: value }, "dev-b"));
      t.version += 1;
    } else if (roll < 0.97) {
      const t = pick(txns);
      emit(categorized(t.id, t.version, `c${Math.floor(rand() * 5)}`, "dev-a"));
      t.version += 1;
    } else {
      emit(rateSet("AED", `${2_000_000 + i}`)); // refused: rate_set_for_home_currency
    }
  }

  // The log ends on a live unset with rows sequenced after it, so the final
  // state carries both a null rate head and rows that are correctly unconverted
  // — a shape the dice cannot be relied on to produce at the end.
  emit(rateUnset("EUR"));
  ingest("EUR");
  ingest("GBP");
  // Three unparsed messages, one BEFORE any of the rate traffic above would have
  // reached them if they had a currency at all. They belong in an FX log
  // precisely because they have no part in FX: the prefix-monotonicity and
  // incremental-equality proofs above are what would catch a pending index that
  // grew a "" bucket at some intermediate position and drained it later.
  emit(unparsedIngest("u1", "u1"));
  emit(unparsedIngest("u2", "u2"));
  emit(unparsedIngest("u3", "u3"));
  emit(superseded("u2", "u2-fixed", { currency: "USD", amount_minor: "7700" }));
  return out;
}
