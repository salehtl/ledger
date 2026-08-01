/**
 * The VALIDATOR mirror check.
 *
 * `agreement.test.ts` (Task 18) proves the two regex ENGINES read an accepted
 * pattern the same way. This file proves the two VALIDATORS agree about which
 * patterns are accepted at all, with the same reason codes — the other half of
 * the same contract, and the half that decides what a device does when it is
 * handed a template it should refuse.
 *
 * Why the client validates at all, when publishing already did: the template
 * arrives over the network, from a server the client does not get to audit, and
 * a pattern that reaches `new RegExp` is a pattern this device will run. The
 * dialect's cost rules exist because that device is a phone. A load-time check
 * that shares its reason codes with the publish-time one is the only way the
 * two can be shown to mean the same thing, and `conformance/dialect/patterns.json`
 * is where they are shown it.
 *
 * Every expectation here is LITERAL Go output read from that file. Nothing is
 * recomputed: a mirror that derives its own expectation is a mirror of itself.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  validatePattern,
  toJS,
  compile,
  groupNames,
  MAX_PATTERN_RUNES,
  MAX_CAPTURE_GROUPS,
  MAX_BOUND_PRODUCT,
  MAX_UNBOUNDED_PER_BRANCH,
  Reason,
} from "./dialect.ts";

const fixturePath = `${import.meta.dir}/../../../conformance/dialect/patterns.json`;

interface Rejected {
  code: string;
  pattern: string;
  js_pattern: string;
  flags: string[];
  codes: string[];
  js_syntax_error: boolean;
  why: string;
}
interface Accepted {
  name: string;
  pattern: string;
  js_pattern: string;
  flags: string[];
  group_names: string[];
}
interface Fixture {
  schema_version: number;
  limits: {
    max_pattern_runes: number;
    max_capture_groups: number;
    max_bound_product: number;
    max_unbounded_per_branch: number;
  };
  rejected: Rejected[];
  accepted: Accepted[];
  to_js: { pattern: string; js: string; why: string }[];
}

const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
const show = (s: string): string => JSON.stringify(s);

test("the fixture is present and non-trivial", () => {
  expect(fx.rejected.length).toBeGreaterThan(25);
  expect(fx.accepted.length).toBeGreaterThan(25);
});

// ---------------------------------------------------------------------------
// The cost bounds are part of the contract, not an implementation detail
// ---------------------------------------------------------------------------

test("the TypeScript limits are Go's limits", () => {
  expect(MAX_PATTERN_RUNES).toBe(fx.limits.max_pattern_runes);
  expect(MAX_CAPTURE_GROUPS).toBe(fx.limits.max_capture_groups);
  expect(MAX_BOUND_PRODUCT).toBe(fx.limits.max_bound_product);
  expect(MAX_UNBOUNDED_PER_BRANCH).toBe(fx.limits.max_unbounded_per_branch);
});

// ---------------------------------------------------------------------------
// Validator parity, both directions
// ---------------------------------------------------------------------------

for (const c of fx.rejected) {
  test(`rejects ${c.code}: ${show(c.pattern.length > 40 ? c.pattern.slice(0, 40) + "..." : c.pattern)}`, () => {
    const got = validatePattern(c.pattern, c.flags);
    // Same codes, same ORDER: Go emits them in scan order and a mirror that
    // reordered them would be a mirror that scanned differently.
    expect(got, `flags ${JSON.stringify(c.flags)} — ${c.why}`).toEqual(c.codes);
    // And the row's own code must be among them, which is what makes the
    // fixture's `code` field load-bearing rather than a label.
    expect(got).toContain(c.code);
  });
}

for (const c of fx.accepted) {
  test(`accepts ${c.name}`, () => {
    expect(validatePattern(c.pattern, c.flags)).toEqual([]);
  });
}

test("every accepted pattern actually compiles under the u flag", () => {
  // Stronger than parity: two validators can agree a pattern is legal while
  // JavaScript then refuses to compile it, and the device would have no
  // template at all rather than a wrong one.
  for (const p of fx.accepted) {
    expect(() => compile(p.pattern, p.flags ?? []), show(p.pattern)).not.toThrow();
  }
});

test("compile always sets the u flag, and that is what makes case folding match Go's", () => {
  // The one measured fact that makes the whole dialect work. Without `u`, `/k/i`
  // does NOT match U+212A (the Kelvin sign) while Go's `(?i)k` DOES; with `u`
  // both match. Every other rule is written assuming the two engines fold the
  // same way, so a compile that dropped the flag would make the fixture's
  // engine-parity claims quietly untrue rather than failing.
  expect(compile("k", []).flags).toBe("u");
  expect(compile("k", ["i"]).flags).toBe("iu");
  expect(compile("k", ["i"]).test("K")).toBe(true);
  expect(new RegExp("k", "i").test("K")).toBe(false);
  // And `u` is what turns a banned construct into a hard SyntaxError rather
  // than a silently different pattern: without it, `[[:alpha:]]` compiles as a
  // class of `[ : a l p h` followed by two literals.
  expect(() => new RegExp("^[[:alpha:]]+$", "u")).toThrow();
  expect(() => new RegExp("^[[:alpha:]]+$", "")).not.toThrow();
});

test("groupNames reproduces Go's SubexpNames for every accepted pattern", () => {
  for (const p of fx.accepted) {
    expect(groupNames(p.pattern), show(p.pattern)).toEqual(p.group_names);
  }
});

test("toJS reproduces Go's ToJS", () => {
  for (const c of fx.to_js) {
    expect(toJS(c.pattern), `${show(c.pattern)}: ${c.why}`).toBe(c.js);
  }
  for (const c of fx.accepted) {
    expect(toJS(c.pattern), show(c.pattern)).toBe(c.js_pattern);
  }
  for (const c of fx.rejected) {
    expect(toJS(c.pattern), show(c.pattern)).toBe(c.js_pattern);
  }
});

// ---------------------------------------------------------------------------
// The polynomial rule, which is the one the client has to care about
// ---------------------------------------------------------------------------

test("the polynomial backtracking shapes are refused", () => {
  // Go's RE2 cannot backtrack, so the SERVER never feels any of these. This
  // executor does. Measured in this engine (Bun 1.3.14, 2026-08-01) before the
  // rule existed: `[0-9]+[0-9]+[0-9]+[0-9]+z` against 400 characters took
  // 88,191 ms, and `[^\n]+X[^\n]+Y` against 8,000 took 31,680 ms.
  for (const p of [
    "[0-9]+[0-9]+z",
    "[0-9]+[0-9]+[0-9]+[0-9]+z",
    "[^\\n]+X[^\\n]+Y",
    "[^\\n]+X[^\\n]+Y[^\\n]+Z",
    "(?P<v>[0-9]+)[0-9]+z",
    "[0-9]{2,}[0-9]{3,}z",
    "(a+)(b+)",
    "(a+|b)c+",
  ]) {
    expect(validatePattern(p, []), show(p)).toContain(Reason.MultipleUnboundedQuantifiers);
  }
});

test("one unbounded quantifier per alternation branch is still expressible", () => {
  // The bound is per BRANCH because a backtracking engine explores one branch
  // at a time, and because every seed anchor this corpus needs has exactly one.
  for (const p of [
    "[0-9]{2,}z",
    "[0-9]+z|[a-z]+q",
    "(a+|b+)c",
    "المبلغ\\n(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\\.[0-9]{2})",
    "الدفع الى\\n(?P<v>[^\\n]+)",
    "رقم البطاقة\\n(?P<v>[^ \\n]+)",
    "بتاريخ (?P<d>[0-9]{2}-[0-9]{2}-[0-9]{4})",
    "(?P<amt>(?:[A-Z]{3} )?[0-9][0-9,]{0,24}\\.[0-9]{2})[ \\n]has been[ \\n](?:withdrawn|debited)[ \\n]from your account",
    "account ending with (?P<v>[0-9]{4})",
    "DEBIT$",
  ]) {
    expect(validatePattern(p, []), show(p)).toEqual([]);
  }
});

test("the sanctioned rewrite really is a rewrite", () => {
  // A ban whose replacement means something else is a ban that silently changes
  // what a template extracts. `[0-9]+[0-9]+` and `[0-9]{2,}` must agree.
  const banned = new RegExp("[0-9]+[0-9]+z", "u");
  const rewrite = compile("[0-9]{2,}z", []);
  for (const s of ["", "z", "1z", "12z", "123z", "a12z", "12za", "1", "12", "1 2z", "٢٥z"]) {
    expect(rewrite.test(s), `on ${show(s)}`).toBe(banned.test(s));
    const a = banned.exec(s);
    const b = rewrite.exec(s);
    expect(b?.[0] ?? null, `full match on ${show(s)}`).toBe(a?.[0] ?? null);
  }
});

// ---------------------------------------------------------------------------
// Shapes the fixture does not carry, checked against Go's documented behaviour
// ---------------------------------------------------------------------------

test("a pattern's rune length is counted in runes, not UTF-16 units", () => {
  // 512 astral runes is 1,024 UTF-16 code units. A mirror using .length would
  // refuse a pattern Go accepts, and the device would lose the template.
  const astral = "🏪".repeat(MAX_PATTERN_RUNES);
  expect(validatePattern(astral, [])).toEqual([]);
  expect(validatePattern("🏪".repeat(MAX_PATTERN_RUNES + 1), [])).toEqual([Reason.PatternTooLong]);
});

test("offsets are rune indices", () => {
  // The Arabic anchor is 6 runes and 12 bytes; Go reports 6.
  const errs = validatePattern("المبلغ\\s", []);
  expect(errs).toEqual([Reason.EscapePerlSpace]);
});

test("an empty flag list and a missing one are the same thing", () => {
  expect(validatePattern("a", [])).toEqual([]);
  expect(validatePattern("a", ["i"])).toEqual([]);
  expect(validatePattern("a", ["g"])).toEqual([Reason.FlagNotAllowed]);
});
