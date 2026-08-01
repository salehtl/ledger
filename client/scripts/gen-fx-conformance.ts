/**
 * Writes `conformance/fx/` — the cross-executor FX cases, and the op builders
 * both the cases and `fx.test.ts` are written with.
 *
 * # Why these are files rather than assertions
 *
 * Spec §3.5 mandates two executors that fold the same log to the same state, and
 * §3.7 makes FX the part of the fold where "the same state" is *the user's
 * money*. The Go replay executor does not exist yet (Phase 3), so these cases are
 * written for a reader that has not been born: every value that could be read two
 * ways is pinned, and nothing about the expectation depends on a mechanism that
 * behaves differently in Go.
 *
 * The rules that follow from that, all of them checked by the runner in
 * `fx.test.ts` and restated in the manifest so the Go side never has to infer
 * them:
 *
 *   - **Every integer is a decimal STRING** — `seq`, `amount_minor`,
 *     `rate_micro`, `at_seq` and every snapshot. A JSON number is a float64 in
 *     both languages and money is not a float64.
 *   - **`null` is a value, not an absence.** A null snapshot is "no rate existed
 *     at or after this row's position"; a null rate head is a live `rate_unset`,
 *     which is *not* the same as a currency with no rate row at all.
 *   - **`snapshots` names every transaction the fold materializes**, superseded
 *     rows included, so a case cannot pass by forgetting a row.
 *   - **`pending` ids are sorted by UTF-8 bytes.** The engine holds them in a
 *     `Set`; Go would hold them in a map. Neither has a defensible iteration
 *     order, so the artifact fixes one.
 *   - **`anomalies` is ordered by fold order**, which is a total order both
 *     executors share (`seq`, then position within the blob).
 *   - **Every case keeps `amount_minor × rate_micro` below 2^63 − 1.** This
 *     executor computes in `BigInt` and has no ceiling; a Go executor computing
 *     in `int64` does, and it wraps silently. The suite deliberately does not
 *     probe past that ceiling — a case that did would be asking the two
 *     executors to disagree. See the report for why this is worth knowing.
 *
 * # Freshness
 *
 * The committed JSON must be what this file produces today. `assertFXCasesAreFresh`
 * re-derives it in memory and `fx.test.ts` calls it on every run, so an edited
 * case that was never regenerated fails here rather than passing quietly.
 *
 *     cd client && bun run gen-fx-conformance
 *
 * # Why the op builders live in this file
 *
 * `fx.test.ts` and these cases must be written in one vocabulary: a builder that
 * quietly produced something `validateOp` rejects would test the anomaly path by
 * accident, and two copies of that vocabulary drift. `blob.test.ts` imports from
 * `gen-fixtures.ts` for the same reason.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import type { LogEntry } from "../src/replay/replay";
import type { Op, OpType } from "../src/wire/op";

export const FX_CONFORMANCE_DIR = `${import.meta.dir}/../../conformance/fx`;

/** A 64-hex ingest id from a readable name, so a case can say "i1". */
export const ingestID = (name: string): string => new Bun.CryptoHasher("sha256").update(name).digest("hex");

/**
 * One fixed instant for every op in this file.
 *
 * `authored_at` is the fork tiebreak and **nothing in FX reads it** (spec
 * §3.7:126). Giving every op the same instant is not laziness: it means a Go
 * executor that accidentally sorted by author time would produce the same answer
 * here and be caught elsewhere, and it removes the one field a reader might
 * mistake for the ordering signal. `seq` is the order.
 */
const AUTHORED_AT = "2026-06-05T10:00:00.000Z";

let opSerial = 0;
let opPrefix = "op";

/** Op ids are `${prefix}-${n}`; unique within a log, which is all replay needs. */
function nextOpID(): string {
  opSerial += 1;
  return `${opPrefix}-${opSerial}`;
}

/** An op plus the writer its blob was attributed to. `seq` is added by {@link at}. */
export interface Authored {
  op: Op;
  writer_id: string;
}

export function at(seq: bigint, a: Authored): LogEntry {
  return { op: a.op, seq, writer_id: a.writer_id };
}

export interface TxnFields {
  amount_minor?: string;
  currency?: string;
  direction?: string;
  posted_at?: string;
  merchant_raw?: string;
  last4?: string;
  category?: string | null;
}

function txnPayload(txnId: string, over: TxnFields): Record<string, unknown> {
  const p: Record<string, unknown> = {
    amount_minor: over.amount_minor ?? "10000",
    currency: over.currency ?? "AED",
    direction: over.direction ?? "debit",
    posted_at: over.posted_at ?? "2026-06-05T09:00:00Z",
    // Per-row by default, so two rows of the same amount on the same day do not
    // collide on the duplicate fingerprint (§3.3:67) and litter an FX case with
    // a notice that has nothing to do with FX. A case that WANTS the collision
    // sets merchant_raw itself.
    merchant_raw: over.merchant_raw ?? `M-${txnId}`,
    last4: over.last4 ?? "3701",
  };
  if (over.category !== undefined) p["category"] = over.category;
  return p;
}

function mk(type: OpType, writer: string, rest: Partial<Op> & { payload: unknown }): Authored {
  return {
    writer_id: writer,
    op: { v: 1, type, op_id: nextOpID(), authored_at: AUTHORED_AT, parent_version: null, ...rest },
  };
}

export function ingested(ingest: string, txnId: string, over: TxnFields = {}, writer = "ingest"): Authored {
  return mk("txn_ingested", writer, {
    entity: { kind: "txn", id: txnId },
    ingest_id: ingestID(ingest),
    payload: txnPayload(txnId, over),
  });
}

export function superseded(ingest: string, txnId: string, over: TxnFields = {}, writer = "ingest"): Authored {
  return mk("txn_superseded", writer, {
    entity: { kind: "txn", id: txnId },
    ingest_id: ingestID(ingest),
    payload: txnPayload(txnId, over),
  });
}

/**
 * The payload `internal/v2/ingest/pipeline.go` appends when no tier resolved a
 * message: zero money, no currency, no direction, `tier: "none"`.
 *
 * No conformance case uses it — an unparsed row has no currency, so it takes no
 * part in FX and pinning one would state a rule about a value that does not
 * exist. It is here because the sample log in `fx.test.ts` does use it, and the
 * builders and the cases have to stay one vocabulary.
 */
export function unparsedIngest(ingest: string, txnId: string, writer = "ingest"): Authored {
  return mk("txn_ingested", writer, {
    entity: { kind: "txn", id: txnId },
    ingest_id: ingestID(ingest),
    payload: {
      amount_minor: "0",
      currency: "",
      direction: "",
      posted_at: "2026-06-05T09:00:00Z",
      merchant_raw: "",
      last4: "",
      is_transfer: false,
      tier: "none",
      needs_review: true,
      unparsed: true,
      normalizer_version: 3,
    },
  });
}

export function edited(txnId: string, parentVersion: number, patch: Record<string, unknown>, writer = "dev-a"): Authored {
  return mk("txn_edited", writer, {
    entity: { kind: "txn", id: txnId },
    parent_version: parentVersion,
    payload: patch,
  });
}

export function categorized(txnId: string, parentVersion: number, category: string, writer = "dev-a"): Authored {
  return mk("txn_categorized", writer, {
    entity: { kind: "txn", id: txnId },
    parent_version: parentVersion,
    payload: { category },
  });
}

export function homeCurrency(ccy: string, writer = "dev-a"): Authored {
  return mk("home_currency_set", writer, { payload: { currency: ccy } });
}

export function rateSet(ccy: string, micro: string, writer = "dev-a"): Authored {
  return mk("rate_set", writer, { payload: { currency: ccy, rate_micro: micro } });
}

export function rateUnset(ccy: string, writer = "dev-a"): Authored {
  return mk("rate_unset", writer, { payload: { currency: ccy } });
}

// ---------------------------------------------------------------------------
// The case shape
// ---------------------------------------------------------------------------

export interface FXEntry {
  /** Decimal string. Two entries sharing a seq are two ops in one blob. */
  seq: string;
  writer_id: string;
  op: Op;
}

export interface FXExpect {
  home_currency: string | null;
  /** currency → head rate as a decimal string, or null for a live `rate_unset`. */
  rates: Record<string, string | null>;
  /** EVERY materialized txn id → its frozen snapshot, or null. */
  snapshots: Record<string, string | null>;
  /** currency → still-unfrozen live txn ids, sorted by UTF-8 bytes. */
  pending: Record<string, string[]>;
  anomalies: { kind: string; at_seq: string }[];
}

export interface FXCase {
  name: string;
  note: string;
  schema_version: number;
  entries: FXEntry[];
  expect: FXExpect;
}

interface CaseSpec {
  file: string;
  name: string;
  note: string;
  build: () => { entries: LogEntry[]; expect: FXExpect };
}

/** The home currency's implicit identity rate, as it appears in an expectation. */
const IDENTITY = "1000000";

/**
 * The USD/AED peg (v1 `internal/store/fx.go:33`), and the rate every "a rate
 * exists" case uses so the arithmetic is checkable by hand: 10000 fils of USD is
 * 10000 × 3672500 ÷ 1e6 = 36725 fils of AED, half-up.
 */
const PEG = "3672500";

function specs(): CaseSpec[] {
  return [
    {
      file: "01-unknown-rate-null-snapshot.json",
      name: "unknown-rate-null-snapshot",
      note: "A transaction whose currency has no rate is saved and shown in full with a null snapshot (§3.7:132). It is not dropped, not zeroed, and not guessed at. The two rows arrive in the order t2, t1 so that the pending list below is in SORTED order rather than arrival order — the one place this suite's ordering rule is load-bearing.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, ingested("i2", "t2", { currency: "USD" })),
          at(3n, ingested("i1", "t1", { currency: "USD" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: null, t2: null },
          pending: { USD: ["t1", "t2"] },
          anomalies: [],
        },
      }),
    },
    {
      file: "02-home-currency-backfills-earlier-rows.json",
      name: "home-currency-backfills-earlier-rows",
      note: "P is the smallest position >= pos(T) at which a head rate exists, so a home-currency row ingested BEFORE onboarding freezes at the identity rate the onboarding op installs. Without the backfill it would stay null forever.",
      build: () => ({
        entries: [at(1n, ingested("i1", "t1", { currency: "AED" })), at(2n, homeCurrency("AED"))],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: "10000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "03-rate-live-at-ingest-freezes-there.json",
      name: "rate-live-at-ingest-freezes-there",
      note: "The other side of the same rule: a rate that is already the head when the row arrives makes P = pos(T), so the row freezes at ingest rather than waiting for anything.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", PEG)),
          at(3n, ingested("i1", "t1", { currency: "USD" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: PEG },
          snapshots: { t1: "36725" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "04-later-rate-backfills-only-nulls.json",
      name: "later-rate-backfills-only-nulls",
      note: "A later rate_set backfills every still-null row of that currency and NOTHING else. t1 and t2 both freeze at the 3.6725 head; the 4.0 head at seq 5 reaches only t3, which is sequenced after it. An executor that re-froze at the final head would report 40000 for all three.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, ingested("i1", "t1", { currency: "USD" })),
          at(3n, rateSet("USD", PEG)),
          at(4n, ingested("i2", "t2", { currency: "USD" })),
          at(5n, rateSet("USD", "4000000")),
          at(6n, ingested("i3", "t3", { currency: "USD" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "4000000" },
          snapshots: { t1: "36725", t2: "36725", t3: "40000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "05-rate-unset-does-not-thaw.json",
      name: "rate-unset-does-not-thaw",
      note: "rate_unset makes later rows pending and leaves earlier freezes alone (§3.7:127). t2, ingested into the gap, waits for the NEXT rate and freezes at 5.0 — the smallest position >= its own at which a non-null head exists. A null head is a live fact, not a rate.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", PEG)),
          at(3n, ingested("i1", "t1", { currency: "USD" })),
          at(4n, rateUnset("USD")),
          at(5n, ingested("i2", "t2", { currency: "USD" })),
          at(6n, rateSet("USD", "5000000")),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "5000000" },
          snapshots: { t1: "36725", t2: "50000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "06-rate-set-for-home-currency-is-an-anomaly.json",
      name: "rate-set-for-home-currency-is-an-anomaly",
      note: "The home currency carries the implicit identity rate by construction (§3.7:124), so an op claiming a rate for it is an anomaly, not an instruction: applying it would silently re-denominate every later home-currency snapshot.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("AED", "2000000")),
          at(3n, ingested("i1", "t1", { currency: "AED" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: "10000" },
          pending: {},
          anomalies: [{ kind: "rate_set_for_home_currency", at_seq: "2" }],
        },
      }),
    },
    {
      file: "07-rate-unset-for-home-currency-is-an-anomaly.json",
      name: "rate-unset-for-home-currency-is-an-anomaly",
      note: "The symmetric refusal. Unsetting the identity would be unrecoverable — rate_set(H) is refused and home_currency_set is one-shot — so every home-currency row after it would snapshot null forever, which §3.7:133 forbids.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateUnset("AED")),
          at(3n, ingested("i1", "t1", { currency: "AED" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: "10000" },
          pending: {},
          anomalies: [{ kind: "rate_unset_for_home_currency", at_seq: "2" }],
        },
      }),
    },
    {
      file: "08-rate-set-before-home-currency-is-an-anomaly.json",
      name: "rate-set-before-home-currency-is-an-anomaly",
      note: "The same rule read from the other side of onboarding. A rate for the currency that later becomes home really did apply to rows sequenced before the onboarding op — t1 is frozen at 2.0 and stays there, because §3.7 never rewrites a frozen snapshot — so the identity takes over from seq 3 and the two-basis split is SURFACED rather than left to be discovered in a total.",
      build: () => ({
        entries: [
          at(1n, rateSet("AED", "2000000")),
          at(2n, ingested("i1", "t1", { currency: "AED" })),
          at(3n, homeCurrency("AED")),
          at(4n, ingested("i2", "t2", { currency: "AED" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: "20000", t2: "10000" },
          pending: {},
          anomalies: [{ kind: "rate_set_before_home_currency", at_seq: "3" }],
        },
      }),
    },
    {
      file: "09-supersede-recomputes-at-its-own-position.json",
      name: "supersede-recomputes-at-its-own-position",
      note: "A template fix that corrects a mis-detected currency (§3.2's heuristic tier is AED-shaped). The new row is computed at ITS OWN position — AED identity — and never inherits t1's USD-based number. t1 keeps the snapshot it froze at, because a supersede is a new value at a new position, not a rewrite of an old one.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", PEG)),
          at(3n, ingested("i1", "t1", { currency: "USD" })),
          at(4n, rateSet("USD", "4000000")),
          at(5n, superseded("i1", "t2", { currency: "AED" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "4000000" },
          snapshots: { t1: "36725", t2: "10000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "10-superseded-row-is-not-backfilled.json",
      name: "superseded-row-is-not-backfilled",
      note: "t1 was still pending when it was superseded, so it leaves the pending index with it: a retired row is not a live transaction, and a later rate_set that froze a number onto it would be freezing a number nothing displays and every re-fold recomputes differently.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, ingested("i1", "t1", { currency: "USD" })),
          at(3n, superseded("i1", "t2", { currency: "AED" })),
          at(4n, rateSet("USD", PEG)),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: PEG },
          snapshots: { t1: null, t2: "10000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "11-supersede-into-a-rated-currency-freezes.json",
      name: "supersede-into-a-rated-currency-freezes",
      note: "The other half of 'recomputes at its own position': a supersede must not be left permanently null either. t1 was pending in a currency with no rate; the corrected row lands in one that has a live head and freezes on the spot.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("EUR", "4000000")),
          at(3n, ingested("i1", "t1", { currency: "USD" })),
          at(4n, superseded("i1", "t2", { currency: "EUR" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, EUR: "4000000" },
          snapshots: { t1: null, t2: "40000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "12-recompute-carries-the-value.json",
      name: "recompute-carries-the-value",
      note: "The 'recompute at current rate' action of §3.7:137 is a txn_edited that CARRIES the number, never an instruction to recompute later — replay stays a pure function of logged data. Setting it back to null re-arms the row for backfill, which the rate_set at seq 6 then performs.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", PEG)),
          at(3n, ingested("i1", "t1", { currency: "USD" })),
          at(4n, edited("t1", 1, { amount_home_minor: "40000" })),
          at(5n, edited("t1", 2, { amount_home_minor: null })),
          at(6n, rateSet("USD", "5000000")),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "5000000" },
          snapshots: { t1: "50000" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "13-bigint-intermediate-exceeds-a-double.json",
      name: "bigint-intermediate-exceeds-a-double",
      note: "amount_minor x rate_micro is 91815912878499999, past 2^53, and the exact result sits one unit below a half-up boundary. An executor that multiplies in float64 rounds the product UP to ...500000 and reports 91815912879 — one fil too many, from a number that looks entirely plausible. The product stays below 2^63-1 so an int64 executor gets the same answer this one does.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", "3672501")),
          at(3n, ingested("i1", "t1", { currency: "USD", amount_minor: "25000922499" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "3672501" },
          snapshots: { t1: "91815912878" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "14-identity-is-exact-past-2-53.json",
      name: "identity-is-exact-past-2-53",
      note: "A home-currency row large enough that amount x 1000000 (9007199254740000000) is past 2^53 and NOT exactly representable — float64 puts the product at ...739999744, low by 256 — and the answer must still be the amount itself, digit for digit. Note what this does NOT pin: the 256 is six orders of magnitude below the 1000000 divisor, so the quotient survives it and a float64 executor passes this case. No identity-rate case can be a float64 guard, because diverging needs a product error above 500000, i.e. a double spacing of 1e6, i.e. a product past 2^72 — far above the 2^63-1 an int64 executor can hold at all. Cases 13 and 17 are the float64 guards; this one pins exactness at scale and the int64 bound.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, ingested("i1", "t1", { currency: "AED", amount_minor: "9007199254740" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: "9007199254740" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "15-half-up-rounding-boundaries.json",
      name: "half-up-rounding-boundaries",
      note: "Half-up at the boundary, in both directions, through the real fold: 1 x 1.500000 rounds to 2 and 1 x 1.499999 rounds to 1. Truncating division is half-up here only because amounts are positive by invariant (direction carries the sign), which convert() asserts rather than assumes.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", "1500000")),
          at(3n, rateSet("EUR", "1499999")),
          at(4n, ingested("i1", "t1", { currency: "USD", amount_minor: "1" })),
          at(5n, ingested("i2", "t2", { currency: "EUR", amount_minor: "1" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "1500000", EUR: "1499999" },
          snapshots: { t1: "2", t2: "1" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "16-two-ops-in-one-blob.json",
      name: "two-ops-in-one-blob",
      note: "A client-authored blob carries several ops at ONE seq, so the order inside a blob is part of the total order. The rate_set and the ingest below share seq 2 with the rate first: the row freezes at ingest. Read the other way round it would be pending, so an executor that sorted by seq alone and lost intra-blob order would diverge here and nowhere else.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", PEG)),
          at(2n, ingested("i1", "t1", { currency: "USD" }, "dev-a")),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: PEG },
          snapshots: { t1: "36725" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "17-float-divergence-at-the-int64-ceiling.json",
      name: "float-divergence-at-the-int64-ceiling",
      note: "The second float64 guard, at the far end of the magnitude range from case 13: the product is 9223368456845499999, which leaves 3580008775808 of headroom below 2^63-1 even after the +500000 — so an int64 executor computes it exactly and one built on float64 rounds the product up by 417, crosses the half-up boundary and reports 9223368456846. This is the largest conversion this suite asks any executor to perform, and it is deliberately just inside the ceiling: one rung higher and the two mandated executors would be required to disagree.",
      build: () => ({
        entries: [
          at(1n, homeCurrency("AED")),
          at(2n, rateSet("USD", "3672501")),
          at(3n, ingested("i1", "t1", { currency: "USD", amount_minor: "2511467922499" })),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY, USD: "3672501" },
          snapshots: { t1: "9223368456845" },
          pending: {},
          anomalies: [],
        },
      }),
    },
    {
      file: "18-pre-onboarding-rate-then-unset-then-onboarding.json",
      name: "pre-onboarding-rate-then-unset-then-onboarding",
      note: "The shape that carries BOTH halves of the pre-onboarding problem at once, and which no other case reaches: a rate for the currency that becomes home, a row frozen against it, that rate then unset, a second row left pending, and only then the onboarding op — which installs the identity, backfills the pending row and raises the anomaly. t1 keeps its 2.0 basis and t2 gets the identity, so the two-basis split the anomaly reports is visible in the snapshots themselves. The anomaly fires on a NULL head, which is why the guard keys on 'a rate head exists' rather than on 'a non-null rate head exists'.",
      build: () => ({
        entries: [
          at(1n, rateSet("AED", "2000000")),
          at(2n, ingested("i1", "t1", { currency: "AED" })),
          at(3n, rateUnset("AED")),
          at(4n, ingested("i2", "t2", { currency: "AED" })),
          at(5n, homeCurrency("AED")),
        ],
        expect: {
          home_currency: "AED",
          rates: { AED: IDENTITY },
          snapshots: { t1: "20000", t2: "10000" },
          pending: {},
          anomalies: [{ kind: "rate_set_before_home_currency", at_seq: "5" }],
        },
      }),
    },
  ];
}

/** Builds every case, with per-case op ids so one case's edits cannot renumber another's. */
export function buildCases(): FXCase[] {
  const savedSerial = opSerial;
  const savedPrefix = opPrefix;
  const out = specs().map((spec) => {
    opPrefix = spec.name;
    opSerial = 0;
    const { entries, expect } = spec.build();
    return {
      name: spec.name,
      note: spec.note,
      schema_version: 1,
      entries: entries.map((e) => ({ seq: `${e.seq}`, writer_id: e.writer_id, op: e.op })),
      expect,
    };
  });
  opSerial = savedSerial;
  opPrefix = savedPrefix;
  return out;
}

const MANIFEST_NOTE =
  "Written by client/scripts/gen-fx-conformance.ts. Regenerate with `cd client && bun run gen-fx-conformance`; do not hand-edit. " +
  "Every case is a complete log: fold `entries` in seq order (entries sharing a seq are one blob, applied in array order) and compare against `expect`. " +
  "Every integer is a decimal string, including seq. null is a value: a null snapshot means no rate existed at or after that row's position, and a null rate head is a live rate_unset, which is not the same as a currency with no rate at all. " +
  "`snapshots` names every transaction the fold materializes, superseded rows included. `pending` lists still-unfrozen live ids sorted by UTF-8 bytes, because the engine holds them in a set and Go would hold them in a map. `anomalies` is in fold order. " +
  "The home currency APPEARS IN `rates` carrying the identity 1000000, though spec §3.7:125 says it carries no rate row: the identity is materialized as a head so that head_rate(home, P) is one lookup rather than a special case at every call site. Every case encodes that literally, so an executor that keeps the identity implicit must add it before comparing. " +
  "Every case keeps amount_minor x rate_micro (plus the +500000) below 2^63-1 so an int64 executor can consume it unchanged; case 17 sits deliberately close to that ceiling and is the largest conversion here.";

function build(): { manifest: string; files: { file: string; text: string }[] } {
  const cases = buildCases();
  const specList = specs();
  const files = cases.map((c, i) => ({
    file: specList[i]!.file,
    text: JSON.stringify(c, null, 2) + "\n",
  }));
  const manifest =
    JSON.stringify(
      {
        note: MANIFEST_NOTE,
        schema_version: 1,
        conversion: "(amount_minor * rate_micro + 500000) / 1000000, truncating — half-up because amounts are positive",
        home_identity_micro: "1000000",
        cases: cases.map((c, i) => ({ file: specList[i]!.file, name: c.name, note: c.note })),
      },
      null,
      2,
    ) + "\n";
  return { manifest, files };
}

/**
 * Fails if the committed cases are not what this file produces now.
 *
 * A conformance artifact that has drifted from the code that authored it is
 * worse than none: the runner still passes (it folds the committed bytes), and
 * the Go executor is then checked against a case nobody meant to write.
 */
export async function assertFXCasesAreFresh(): Promise<void> {
  const { manifest, files } = build();
  const fix = "regenerate with `cd client && bun run gen-fx-conformance`";
  const onDisk = await Bun.file(`${FX_CONFORMANCE_DIR}/manifest.json`).text();
  if (onDisk !== manifest) throw new Error(`conformance/fx/manifest.json is stale: ${fix}`);
  for (const f of files) {
    const committed = await Bun.file(`${FX_CONFORMANCE_DIR}/${f.file}`).text();
    if (committed !== f.text) throw new Error(`conformance/fx/${f.file} is not what this executor writes: ${fix}`);
  }
  // A case deleted from `specs()` leaves its file behind, and the runner would
  // keep replaying an expectation nothing generates any more.
  const present = (await readdir(FX_CONFORMANCE_DIR)).filter((n) => n.endsWith(".json") && n !== "manifest.json").sort();
  const want = files.map((f) => f.file).sort();
  if (present.join(",") !== want.join(",")) {
    throw new Error(`conformance/fx holds [${present.join(", ")}], this executor writes [${want.join(", ")}]: ${fix}`);
  }
}

if (import.meta.main) {
  const { manifest, files } = build();
  await mkdir(FX_CONFORMANCE_DIR, { recursive: true });
  for (const f of files) {
    await writeFile(`${FX_CONFORMANCE_DIR}/${f.file}`, f.text);
    console.log(`wrote ${f.file}`);
  }
  await writeFile(`${FX_CONFORMANCE_DIR}/manifest.json`, manifest);
  console.log(`wrote manifest.json (${files.length} cases)`);
}
