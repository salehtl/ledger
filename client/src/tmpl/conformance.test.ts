/**
 * The cross-executor conformance runner for the TEMPLATE EXECUTOR.
 *
 * Everything in conformance/templates/ was produced by the GO executor. This
 * file runs the TypeScript one over the same inputs and demands the same
 * answer, field by field. A disagreement fails `bun test`, which fails
 * scripts/v2-check.sh, which is this repository's build — that is what
 * "disagreement fails the build" means with no CI service.
 *
 * Two fixture families, and the distinction matters:
 *
 *   - `corpus-*.json` — 1,062 cases of REAL bank mail, sampled by even stride
 *     across three years of the operator's own v1 corpus and already normalized
 *     (norm.Result.Subject / norm.Result.Text), because the normalizer has its
 *     own conformance set and a template disagreement must not be confusable
 *     with a normalizer one.
 *   - `synthetic-*.json` — 102 hand-written cases for the classes the corpus
 *     contains ZERO of. Measured, not guessed: all 62 real ENBD messages are
 *     transfer advices rather than the alert format `enbd.alert.v1` was ported
 *     from, no corpus case produces an empty capture group, and real mail is
 *     well-formed while most of the conversion rules are about malformed input.
 *
 * Expectations are LITERAL — what Go produced — never derived by running some
 * shared helper over the input. A conformance harness that recomputes the
 * expectation cannot see a defect in the thing it is checking.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { execute, type Definition, type Extraction } from "./exec.ts";
import { validatePattern } from "./dialect.ts";

const dir = `${import.meta.dir}/../../../conformance/templates`;

interface Expect {
  matched: boolean;
  error: string;
  amount_minor: string;
  currency: string;
  direction: "debit" | "credit" | "";
  posted_at: string;
  merchant: string;
  last4: string;
  is_transfer: boolean;
  empty_groups: string[];
}
interface Case {
  name: string;
  source: string;
  subject_base64: string;
  normalized_body_base64: string;
  expect: Expect;
}
interface Fixture {
  template: string;
  kind: string;
  normalizer_version: number;
  definition: Definition;
  cases: Case[];
}

const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const fixtures: Fixture[] = files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Fixture);

test("the fixture set is present, and is both real and synthetic", () => {
  expect(files.length).toBeGreaterThan(5);
  const kinds = new Set(fixtures.map((f) => f.kind));
  expect(kinds.has("corpus")).toBe(true);
  expect(kinds.has("synthetic")).toBe(true);
  const cases = fixtures.reduce((n, f) => n + f.cases.length, 0);
  expect(cases).toBeGreaterThan(1000);
  // A set that matched nothing would agree perfectly and prove nothing.
  const matched = fixtures.reduce((n, f) => n + f.cases.filter((c) => c.expect.matched).length, 0);
  expect(matched).toBeGreaterThan(100);
});

test("every fixture definition passes the client-side dialect check", () => {
  // The load-time gate, exercised on the templates that actually ship. A
  // published template that this executor would refuse to load is a template
  // the device silently has no parser for.
  for (const f of fixtures) {
    for (const [i, x] of f.definition.extract.entries()) {
      for (const [j, p] of (x.patterns ?? []).entries()) {
        expect(validatePattern(p, x.flags ?? []), `${f.template} extract[${i}].patterns[${j}]`).toEqual([]);
      }
    }
  }
});

/** Renders an Extraction in the fixture's own shape, so a failure diffs cleanly. */
function asExpect(e: Extraction): Expect {
  return {
    matched: e.matched,
    error: e.error,
    amount_minor: e.amount_minor.toString(),
    currency: e.currency,
    direction: e.direction,
    posted_at: e.posted_at,
    merchant: e.merchant,
    last4: e.last4,
    is_transfer: e.is_transfer,
    empty_groups: e.empty_groups,
  };
}

for (const f of fixtures) {
  for (const c of f.cases) {
    test(`template conformance: ${c.name}`, () => {
      const got = execute(f.definition, fromB64(c.subject_base64), fromB64(c.normalized_body_base64));

      // The brief's assertions, kept verbatim and first, so a failure names the
      // field rather than dumping two objects.
      expect(got.matched, c.source).toBe(c.expect.matched);
      if (c.expect.matched) {
        expect(got.amount_minor).toBe(BigInt(c.expect.amount_minor));
        expect(got.currency).toBe(c.expect.currency);
        expect(got.direction).toBe(c.expect.direction);
        expect(got.posted_at).toBe(c.expect.posted_at);
        expect(got.merchant).toBe(c.expect.merchant);
        expect(got.last4).toBe(c.expect.last4);
        expect(got.empty_groups).toEqual(c.expect.empty_groups);
      }

      // And then everything, on every case. A template that does NOT match
      // still produces a partial extraction and a reason, and both are what the
      // diagnostics ledger stores: an executor that returned a zero extraction
      // where Go returned a partial one, or "no_match" where Go said
      // "missing_field", would pass the block above and be wrong in exactly the
      // way that matters — "unparsed, cause unknown" instead of a named field.
      expect(asExpect(got)).toEqual(c.expect);
    });
  }
}
