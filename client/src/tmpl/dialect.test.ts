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
import { createHash } from "node:crypto";
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
  MAX_REPETITION_WIDTH,
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
    max_repetition_width: number;
  };
  rejected: Rejected[];
  accepted: Accepted[];
  to_js: { pattern: string; js: string; why: string }[];
  corpus: {
    spec: string;
    size: number;
    sha256: string;
    checkpoints: { index: number; pattern: string; codes: string[] }[];
  };
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
  expect(MAX_REPETITION_WIDTH).toBe(fx.limits.max_repetition_width);
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

// ---------------------------------------------------------------------------
// Validator parity over a GENERATED corpus
//
// Everything above is a pattern somebody chose, and the person choosing them
// wrote both validators — so they agree wherever that person expected them to.
// This block enumerates a small grammar instead: 9,324 shapes, every verdict
// hashed, one number compared. It agrees only if the two implementations are
// the same FUNCTION, not the same intuition.
//
// It earned its place. A Go mutation that stopped an unbounded quantifier from
// making its enclosing group variable changed the reason codes of 1,816 of
// these patterns and survived the ENTIRE hand-written suite on both sides.
// ---------------------------------------------------------------------------

/**
 * A transliteration of `dialectCorpus()` in
 * `internal/v2/tmpl/conformance_test.go`. Plain loops over literal arrays, in
 * that order, because the digest is over the SEQUENCE — keep the two the same
 * edit for edit.
 */
function dialectCorpus(): string[] {
  const atoms = ["a", "[a-z]", "[^\\n]", "\\n", "م"];
  const quants = ["", "?", "*", "+", "{2}", "{1,4}", "{0,2}", "{2,}", "{1,32}"];

  const units: string[] = [];
  for (const a of atoms) for (const q of quants) units.push(a + q);

  const inner: string[] = [...units];
  for (const u of units.slice(0, 12)) {
    for (const v of units.slice(0, 12)) {
      inner.push(u + v);
      inner.push(u + "|" + v);
    }
  }
  const pats: string[] = [];
  for (const i of inner) {
    pats.push(i);
    for (const q of quants) {
      pats.push("(?:" + i + ")" + q);
      pats.push("(?:(?:" + i + ")" + q + "){2}");
      pats.push("x(?:" + i + ")" + q + "y");
    }
  }
  return pats;
}

test("the two validators agree on every pattern of a generated corpus", () => {
  const pats = dialectCorpus();
  expect(pats.length, "the generator drifted from Go's").toBe(fx.corpus.size);

  const h = createHash("sha256");
  const byIndex = new Map(fx.corpus.checkpoints.map((c) => [c.index, c]));
  const mismatches: string[] = [];
  for (let i = 0; i < pats.length; i++) {
    const p = pats[i]!;
    const codes = validatePattern(p, []);
    h.update(Buffer.from(`${p}\u0000${codes.join(",")}\n`, "utf8"));
    // Checkpoints are what make a hash failure diagnosable: they name a
    // pattern, and they are compared before the hash so the message is "this
    // pattern differs" rather than "something in 9,324 rows differs".
    const c = byIndex.get(i);
    if (c !== undefined) {
      expect(p, `checkpoint ${i}: the generator drifted from Go's`).toBe(c.pattern);
      if (codes.join(",") !== c.codes.join(",")) {
        mismatches.push(`  [${i}] ${show(p)}: Go says [${c.codes.join(", ")}], TS says [${codes.join(", ")}]`);
      }
    }
  }
  expect(mismatches.join("\n"), "checkpoint disagreement").toBe("");
  expect(
    h.digest("hex"),
    "the validators disagree on at least one of the 9,324 generated patterns, and no checkpoint " +
      "caught it. Regenerate Go's verdicts with\n" +
      "  LEDGER_WRITE_CONFORMANCE=1 go test ./internal/v2/tmpl/ -run TestWriteDialectConformanceFixtures\n" +
      "and compare against this generator pattern by pattern.",
  ).toBe(fx.corpus.sha256);
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
// The two BOUNDED cost rules
//
// These are the rules the CLIENT exists to be protected by: Go's RE2 does not
// backtrack, so every measurement below is one only this engine can feel, and
// `conformance/dialect/patterns.json` carries them as a contract precisely
// because the server cannot notice breaking them.
//
// The fixture already replays these patterns. This block is not redundant with
// it: the fixture is REGENERATED FROM GO, so a Go-side edit that dropped a row
// would take the TypeScript check with it silently. Stated here, a lost row is
// a failing test rather than a smaller file.
// ---------------------------------------------------------------------------

test("a variable-length repetition inside a repeated group is refused", () => {
  // Measured in Bun 1.3.14 with re.exec against "a".repeat(512) — a subject
  // that FAILS, which is what a backtracking engine pays for. Every one of
  // these was ACCEPTED by this validator before the rule existed.
  for (const p of [
    "(?:[a-z0-9 ]{1,8}){8}z", // 2,178 ms
    "(?:(?:[a-z]{1,4}){4}){4}z", // 1,948 ms, and 2,147 ms even ANCHORED
    "(?:[a-z0-9 ]{1,4}){8}z", // 131 ms
    "(?:a?){60}", // 1,094 ms on 60 characters: exponential needs no big input
    "(?:a|aa){30}", // 684 ms
    "(?:a|){40}", // 1,499 ms
    "(?P<v>[0-9]{1,4}){2}", // a capture group is a group
    "(?:[0-9]{1,4}){2,4}", // a RANGE on the outer group repeats too
    "(?:[0-9]{1,4}){0,2}", // ...including one that may repeat zero times
    "(?:a{1,4}?){4}", // lazy is the same shape
    "(?:(?:a|bcd)x){2}", // the variability is one level down
  ]) {
    expect(validatePattern(p, []), show(p)).toContain(Reason.NestedVariableRepetition);
  }
});

test("a group that repeats at MOST once is still expressible", () => {
  // Load-bearing rather than a nicety. `([0-9]{1,4})?` is this dialect's own
  // sanctioned rewrite for `([0-9]+)?`, so a rule that refused it would make
  // `unbounded_inside_quantified_group` inexpressible — and `(?P<ccy>[A-Z]{3} )?`
  // is in every amount anchor the seed set ships.
  for (const p of [
    "([0-9]{1,4})?",
    "([0-9]{1,4}){0,1}",
    "([0-9]{1,4}){1}",
    "(?:[a-z]{8}){8}", // fixed-width interior, same bound product as the first reject above
    "[a-z]{1,64}", // variable, but nothing repeats it
    "(?:ab|cd){8}", // an alternation of EQUAL lengths is fixed-width
    "[0-9]{4,16}", // the sanctioned rewrite for (?:[0-9]{1,4}){4}
    "\\(a{1,4}\\){4}", // an ESCAPED paren opens no group
    "(?:[a{1,4}]x){4}", // a quantifier-shaped run inside a class is literal text
  ]) {
    expect(validatePattern(p, []), show(p)).toEqual([]);
  }
});

test("the backtracking width of one branch is bounded", () => {
  for (const p of [
    // 7,140 ms on 512 characters. Eight siblings nest nothing and quantify no
    // group, so no NESTING rule can see this one — it is why the width bound
    // exists as well as the rule above.
    "[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}z",
    "[0-9]{1,64}[0-9]{1,64}z", // 8,711 ms at MaxBodyBytes
    "[0-9]{1,25}[0-9]{1,41}z", // 1,025: one over
    "a?a?a?a?a?a?a?a?a?a?a?bz", // 2,048, and not a group in sight
    "(?:a|bcd){20}", // an alternation is a choice too
  ]) {
    expect(validatePattern(p, []), show(p)).toContain(Reason.RepetitionWidthTooLarge);
  }
  for (const p of [
    "[0-9]{1,32}[0-9]{1,32}z", // exactly 1,024
    "[0-9]{1,25}[0-9]{1,40}z", // 1,000
    "a?a?a?a?a?a?a?a?a?a?bz", // 1,024: one fewer optional than the reject above
    "[0-9]{3,48}z", // the sanctioned rewrite
    // The widest pattern the seed set ships, at 200. Refusing it would mean no
    // ENBD credit alert parses at all.
    "(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\\.[0-9]{2})[ \\n]has been[ \\n](?:credited|deposited)[ \\n](?:in)?to your account",
    "الدفع الى\\n(?P<v>[^\\n]+)", // an UNBOUNDED quantifier counts 1, not infinity
  ]) {
    expect(validatePattern(p, []), show(p)).toEqual([]);
  }

  // Alternation branches ADD and concatenation MULTIPLIES: "the engine explores
  // one branch at a time" versus "the engine tries every combination". Two
  // branches of 625 sum to 1,250 and are refused; a mirror that took the MAX
  // would report 625 and accept, and one that MULTIPLIED would refuse the pair
  // below as 250,000.
  expect(validatePattern("x{0,24}x{0,24}|y{0,24}y{0,24}", [])).toContain(Reason.RepetitionWidthTooLarge);
  expect(validatePattern("x{0,24}x{0,19}|y{0,24}y{0,19}", [])).toEqual([]);
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
