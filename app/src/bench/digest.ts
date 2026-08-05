/**
 * The correctness check's digest, in TypeScript.
 *
 * The Go twin is `digestMonth` in `cmd/gen-phase2-corpus/manifest.go`, and the
 * two are pinned against each other by `check.self_test` in every generated
 * manifest — fabricated inputs and the digest Go produced for them, recomputed
 * here in `digest.test.ts`. That is the dual-executor contract applied to the one
 * thing that would otherwise fail silently: if the two disagreed, Task 28 would
 * report a mismatch that looked exactly like a fold bug.
 *
 * # Why a digest and not the totals
 *
 * A monthly need/want/saving total is a real AED amount, and the Phase 2 plan's
 * Global Constraints forbid committing one. It is also small enough to guess at,
 * so the digest is SALTED — the salt is committed because it is not a secret, it
 * exists so the digest is not a rainbow-table lookup of a four-figure number.
 *
 * # The preimage
 *
 * ```
 * sha256( salt_bytes
 *       || utf8(month)
 *       || for each bucket, sorted by byte order:
 *            0x1F || utf8(bucket) || 0x1F || utf8(decimal minor-unit total) )
 * ```
 *
 * The 0x1F separators are a strengthening of the plan's formula, which wrote
 * plain concatenation: without them ("ab","c") and ("a","bc") hash identically,
 * so two different months of spending could produce the same "correct" digest.
 */

import { sha256 } from "@noble/hashes/sha2.js";

/** ASCII unit separator. No month, bucket name or decimal string contains it. */
const SEP = 0x1f;

const encoder = new TextEncoder();

/** One month's bucket totals, in MINOR UNITS as decimal strings. */
export type BucketTotals = Map<string, bigint>;

/**
 * The digest of one month.
 *
 * Totals are `bigint` and are rendered with `toString(10)`. Never `Number`: this
 * is a money path, `Number` starts lying at 2^53, and a digest computed over a
 * rounded total would disagree with Go's for reasons nobody would find.
 */
export function digestMonth(salt: Uint8Array, month: string, totals: BucketTotals): string {
  const parts: Uint8Array[] = [salt, encoder.encode(month)];
  const buckets = [...totals.keys()].sort(compareByteOrder);
  for (const b of buckets) {
    parts.push(new Uint8Array([SEP]), encoder.encode(b), new Uint8Array([SEP]), encoder.encode(totals.get(b)!.toString(10)));
  }
  return toHex(sha256(concat(parts)));
}

/**
 * Byte order, not locale order.
 *
 * `Array.prototype.sort()`'s default is UTF-16 code-unit order, which agrees with
 * Go's byte order for ASCII bucket names and diverges above U+FFFF. The bucket
 * vocabulary is ASCII, so this is belt and braces — but the divergence would be
 * a silent wrong digest, and this project's rule is that a coincidence gets
 * written down rather than relied on.
 */
function compareByteOrder(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Spec §3.7's conversion, verbatim. Half-up, `bigint` only, never a float. */
export function convertHalfUp(amountMinor: bigint, rateMicro: bigint): bigint {
  return (amountMinor * rateMicro + 500_000n) / 1_000_000n;
}

export interface MonthDigests {
  blind: string;
  home: string;
}

/**
 * What the device computes from its own materialized state, for comparison with
 * the manifest.
 *
 * `blind` is the currency-blind sum of confirmed debits; `home` is the same
 * amounts converted at the head rate. Rows with no head rate are EXCLUDED and
 * counted, which is what `check.home_null_count` in the manifest is for — "the
 * device's total is lower" becomes a checkable fact instead of a mystery.
 */
export interface DeviceRow {
  month: string;
  bucket: string;
  amountMinor: bigint;
  amountHomeMinor: bigint | null;
  direction: string;
  needsReview: boolean;
}

export function digestsFromRows(
  salt: Uint8Array,
  rows: DeviceRow[],
): { months: Record<string, MonthDigests>; homeNullCount: number } {
  const blind = new Map<string, BucketTotals>();
  const home = new Map<string, BucketTotals>();
  let homeNullCount = 0;

  const bump = (m: Map<string, BucketTotals>, month: string, bucket: string, v: bigint) => {
    let t = m.get(month);
    if (t === undefined) {
      t = new Map();
      m.set(month, t);
    }
    t.set(bucket, (t.get(bucket) ?? 0n) + v);
  };

  for (const r of rows) {
    if (r.direction !== "debit" || r.needsReview) continue;
    bump(blind, r.month, r.bucket, r.amountMinor);
    if (r.amountHomeMinor === null) {
      homeNullCount++;
      continue;
    }
    bump(home, r.month, r.bucket, r.amountHomeMinor);
  }

  const months: Record<string, MonthDigests> = {};
  for (const month of blind.keys()) {
    months[month] = {
      blind: digestMonth(salt, month, blind.get(month) ?? new Map()),
      home: digestMonth(salt, month, home.get(month) ?? new Map()),
    };
  }
  return { months, homeNullCount };
}

export interface DigestComparison {
  month: string;
  kind: "blind" | "home";
  expected: string;
  actual: string | undefined;
  ok: boolean;
}

/**
 * Compares against the manifest, and REPORTS A MISSING MONTH AS A FAILURE.
 *
 * A comparison that only walks the months the device happened to produce is the
 * "true by construction" shape: a device that materialized nothing at all would
 * compare zero months and pass. So the expected set drives the loop, and every
 * month the device is missing shows up with `actual: undefined`.
 */
export function compareDigests(
  expected: Record<string, MonthDigests | Record<string, string>>,
  actual: Record<string, MonthDigests>,
): DigestComparison[] {
  const out: DigestComparison[] = [];
  for (const month of Object.keys(expected).sort()) {
    for (const kind of ["blind", "home"] as const) {
      const want = (expected[month] as Record<string, string>)[kind]!;
      const got = actual[month]?.[kind];
      out.push({ month, kind, expected: want, actual: got, ok: got === want });
    }
  }
  return out;
}
