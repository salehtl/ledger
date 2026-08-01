/**
 * The cost regression net for the shipping templates.
 *
 * The dialect (`dialect.ts`) bounds the SHAPE of a pattern. It cannot bound
 * what a particular pattern costs on a particular body, and the gap between
 * those two is not academic: `MAX_UNBOUNDED_PER_BRANCH` lets a pattern keep one
 * unbounded quantifier, one unbounded quantifier is quadratic in a backtracking
 * engine when the match fails, and `MAX_BODY_BYTES` is 2,000,000.
 *
 * What keeps a real template cheap is a property of the TEMPLATE: either a
 * mandatory literal prefix, so the engine's prefix scan discards nearly every
 * start position, or a bounded run so each start position is cheap. Measured on
 * this build, Bun 1.3.14, 2026-08-01:
 *
 *   الدفع الى\n(?P<v>[^\n]+)                       "الدفع الى\n"+"x"×1,000,000       1.8 ms
 *   المبلغ\n…(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})   "المبلغ\n"+"1,"×500,000          3.5 ms
 *   (?P<amt>…[0-9][0-9,]*\.[0-9]{2})[ \n]has been…  "AED "+"1,"×500,000        333,859 ms
 *
 * That third row is the ENBD alert anchor as v1 wrote it, and it is why this
 * file exists. It has no mandatory leading literal — the first thing it must
 * match is `[0-9]` — so the engine tries every digit in the body and the
 * unbounded `[0-9,]*` backtracks the whole remaining run at each one. Five and
 * a half minutes, on the user's phone, from one message. Go's RE2 finishes it
 * in microseconds, so no server-side test could ever have found it.
 *
 * The fix was to bound the run: `[0-9,]{0,24}` covers every amount an int64 can
 * hold (2^63-1 minor units is `92,233,720,368,547,758.07`, 22 characters before
 * the point) and one larger is a conversion failure either way. Same 1 MB body:
 * 15.6 ms, and the full 13,798-row corpus produces byte-identical extractions
 * before and after.
 *
 * A time budget in a test is normally a bad idea. Here the two sides of the
 * line differ by four orders of magnitude, so the budget is 2 seconds against a
 * measured 20 ms — 100x of headroom on a passing run and 5,000x on the failure
 * it exists to catch.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { compileDefinition, type Definition } from "./exec.ts";

const dir = `${import.meta.dir}/../../../conformance/templates`;

// Keyed by FILE, not by template id. Two files can carry the same template —
// `corpus-enbd.alert.v1.json` and `synthetic-enbd-alert.json` both carry
// `enbd.alert.v1` — and a Map keyed by id would silently keep whichever
// readdir returned last, checking one copy and skipping the other. That is not
// hypothetical: it is what this file did until a deliberately reverted pattern
// failed to fail.
const definitions = new Map<string, Definition>();
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const fx = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as { template: string; definition: Definition };
  definitions.set(f, fx.definition);
}

/**
 * Bodies chosen to be the WORST case for each anchor shape rather than to look
 * like mail: a long digit-and-comma run for the amount anchors, a long single
 * line for the merchant anchors, and the anchors themselves repeated so the
 * prefix scan cannot discard every start position.
 */
const N = 200_000;
const hostile: [string, string][] = [
  ["digits and commas", "1,".repeat(N / 2)],
  ["digits after a currency word", "AED " + "1,".repeat(N / 2)],
  ["one enormous line", "x".repeat(N)],
  ["zeros then a decimal point", "0".repeat(N) + ".00"],
  ["the DIB amount anchor then a run", "المبلغ\n" + "1,".repeat(N / 2)],
  ["the DIB amount anchor repeated", "المبلغ\n1,".repeat(N / 20)],
  ["the DIB merchant anchor repeated", "الدفع الى\n".repeat(N / 20)],
  ["the ENBD verb, never completed", "AED 1.00 has been ".repeat(N / 40)],
  ["newlines only", "\n".repeat(N)],
  ["a near-miss subject line", "account ending with ".repeat(N / 40)],
];

const BUDGET_MS = 2_000;

/**
 * A plausible subject, NOT the hostile body.
 *
 * Passing the same 200,000-character string as both arguments is what the first
 * version of this file did, and it made every assertion below inert: the body is
 * bounded at 2,000,000 bytes but the SUBJECT is bounded at 64,000, so `execute`
 * returned `too_large` before it compiled a single match. The test passed in
 * 70 ms against a pattern that really took 14 seconds. A budget test that never
 * reaches the code it budgets is worse than no test, because it reads as
 * evidence.
 */
const SUBJECT = "Transaction advice for your account ending with 3701";

/** Hostile but UNDER the subject bound, so the subject-sourced anchors are exercised too. */
const hostileSubject = "account ending with ".repeat(3_000);

for (const [file, definition] of definitions) {
  test(`no hostile body is super-linear against ${file}`, () => {
    const c = compileDefinition(definition);
    const runs: [string, string, string][] = hostile.map(([n, b]) => [n, SUBJECT, b]);
    runs.push(["a hostile subject", hostileSubject, "AED 1.00"]);
    for (const [name, subject, body] of runs) {
      // Guard the guard: an input over a bound short-circuits, and a
      // short-circuit is not a measurement.
      expect(body.length, `${name}: body must be under MAX_BODY_BYTES`).toBeLessThan(2_000_000);
      expect(subject.length, `${name}: subject must be under MAX_SUBJECT_BYTES`).toBeLessThan(64_000);
      const t0 = performance.now();
      const got = c.execute(subject, body);
      const ms = performance.now() - t0;
      expect(got.error, `${name}: the executor refused the input instead of matching it`).not.toBe("too_large");
      expect(
        ms,
        `${file} took ${ms.toFixed(0)} ms on ${name} (${body.length} chars). ` +
          `MAX_BODY_BYTES is 2,000,000, so this is 10x short of the largest message the executor accepts. ` +
          `Look for an unbounded quantifier with no mandatory literal in front of it.`,
      ).toBeLessThan(BUDGET_MS);
    }
  });
}

test("every seed amount anchor has a BOUNDED digit run", () => {
  // The structural statement behind the timings above, so a future edit that
  // reintroduces `[0-9,]*` fails on the reason rather than on a stopwatch.
  let checked = 0;
  for (const [file, definition] of definitions) {
    for (const x of definition.extract) {
      if (x.type !== "amount") continue;
      for (const p of x.patterns ?? []) {
        expect(
          p.includes("[0-9,]*"),
          `${file}: ${p} — an unbounded digit-and-comma run made the ENBD anchor take 333,859 ms ` +
            `on a 1 MB body. Write [0-9,]{0,24}: it covers every amount an int64 can hold.`,
        ).toBe(false);
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(5);
});
