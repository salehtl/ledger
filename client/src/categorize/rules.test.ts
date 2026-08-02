import { expect, test } from "bun:test";

import {
  MAX_SUBJECT_RUNES,
  MIN_CONTAINS_RUNES,
  MIN_EXACT_RUNES,
  type DictEntry,
  type UserRule,
  categorize,
  nestedVariableRepetition,
  prepare,
  subjectOf,
  validateDictEntry,
} from "./rules";
import { validatePattern } from "../tmpl/dialect";

// ---------------------------------------------------------------------------
// Fixtures.
//
// Every precedence fixture below has AT LEAST TWO competing entries that BOTH
// match the subject and disagree about the category. A fixture with one rule
// cannot tell correct precedence from no precedence at all: the single rule
// wins under every possible ordering, including none.
//
// And every "A beats B" test is paired with a control that removes A and
// asserts B then wins. Without the control, "A beats B" also passes when B was
// never capable of matching in the first place — which is the same test as
// "the matcher returned A", and proves nothing about the order.
// ---------------------------------------------------------------------------

let n = 0;
function rule(r: Partial<UserRule> & { pattern: string; category: string }): UserRule {
  return { id: `r${++n}`, match: "contains", priority: 50, ...r };
}

const none = { category: null, source: "none" } as const;

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

test("priority decides between two rules that both match: LOWER number wins", () => {
  const a = rule({ pattern: "carrefour", category: "groceries", priority: 10 });
  const b = rule({ pattern: "carrefour", category: "shopping", priority: 100 });
  expect(categorize("CARREFOUR HYPER", prepare([a, b], [])).category).toBe("groceries");

  // The same two rules with the priorities SWAPPED must give the other answer.
  // This is what distinguishes "priority is read" from "the first array element
  // is returned": both arrangements below have `a` first.
  const a2 = { ...a, priority: 100 };
  const b2 = { ...b, priority: 10 };
  expect(categorize("CARREFOUR HYPER", prepare([a2, b2], [])).category).toBe("shopping");
});

test("the answer does not depend on the order the rules arrive in", () => {
  const a = rule({ pattern: "carrefour", category: "groceries", priority: 10 });
  const b = rule({ pattern: "carrefour", category: "shopping", priority: 100 });
  // `State.rules` is a Map and the projection's `rule` table has no ORDER BY,
  // so this is the property that stops two devices disagreeing.
  expect(categorize("CARREFOUR", prepare([a, b], [])).category).toBe("groceries");
  expect(categorize("CARREFOUR", prepare([b, a], [])).category).toBe("groceries");
});

test("a lower-priority rule still applies when the higher-priority one does not match", () => {
  const a = rule({ pattern: "carrefour", category: "groceries", priority: 10 });
  const b = rule({ pattern: "noon", category: "shopping", priority: 100 });
  expect(categorize("NOON.COM", prepare([a, b], [])).category).toBe("shopping");
});

// ---------------------------------------------------------------------------
// Match kind, at equal priority
// ---------------------------------------------------------------------------

test("at equal priority an exact rule beats a contains rule, and the contains rule was live", () => {
  const exact = rule({ pattern: "carrefour", category: "groceries", match: "exact" });
  const contains = rule({ pattern: "carre", category: "shopping", match: "contains" });
  expect(categorize("Carrefour", prepare([exact, contains], [])).category).toBe("groceries");
  // Control: with the exact rule gone, the contains rule matches the same
  // subject. Without this the assertion above is satisfied by a `contains`
  // implementation that never matches anything.
  expect(categorize("Carrefour", prepare([contains], [])).category).toBe("shopping");
});

test("at equal priority a contains rule beats a regex rule, and the regex rule was live", () => {
  const contains = rule({ pattern: "carrefour", category: "groceries", match: "contains" });
  const re = rule({ pattern: "^carre", category: "shopping", match: "regex" });
  expect(categorize("Carrefour Hyper", prepare([contains, re], [])).category).toBe("groceries");
  expect(categorize("Carrefour Hyper", prepare([re], [])).category).toBe("shopping");
});

test("a regex rule is matched case-insensitively against the canonical subject", () => {
  const re = rule({ pattern: "^carrefour (hyper|market)$", category: "groceries", match: "regex" });
  const p = prepare([re], []);
  expect(categorize("  CARREFOUR   Hyper ", p).category).toBe("groceries");
  expect(categorize("CARREFOUR CITY", p)).toEqual(none);
});

test("priority outranks match kind: a low-priority contains beats a high-priority exact", () => {
  const contains = rule({ pattern: "carrefour", category: "groceries", match: "contains", priority: 1 });
  const exact = rule({ pattern: "carrefour", category: "shopping", match: "exact", priority: 2 });
  expect(categorize("carrefour", prepare([contains, exact], [])).category).toBe("groceries");
  // Control: at the SAME priority the exact rule wins, so the assertion above
  // measures priority and not a fixed preference for `contains`.
  expect(categorize("carrefour", prepare([{ ...contains, priority: 2 }, exact], [])).category).toBe("shopping");
});

// ---------------------------------------------------------------------------
// Specificity and the deterministic tiebreak
// ---------------------------------------------------------------------------

test("at equal priority and kind the longer pattern wins, both ways round", () => {
  const long = rule({ pattern: "carrefour hyper", category: "groceries" });
  const short = rule({ pattern: "carrefour", category: "shopping" });
  expect(categorize("CARREFOUR HYPER MARKET", prepare([long, short], [])).category).toBe("groceries");
  // Swap which pattern carries which category: if the matcher were returning a
  // fixed array position rather than comparing lengths, one of these two fails.
  const long2 = { ...long, category: "shopping" };
  const short2 = { ...short, category: "groceries" };
  expect(categorize("CARREFOUR HYPER MARKET", prepare([short2, long2], [])).category).toBe("shopping");
});

test("pattern length is counted in RUNES, so an astral pattern is not double-counted", () => {
  // Four astral code points are eight UTF-16 units. A comparator using
  // String.length would rank this above a nine-character ASCII pattern.
  const astral = rule({ pattern: "\u{1d400}\u{1d401}\u{1d402}\u{1d403}", category: "shopping" });
  const ascii = rule({ pattern: "carrefour", category: "groceries" });
  const subject = `CARREFOUR \u{1d400}\u{1d401}\u{1d402}\u{1d403}`;
  expect(categorize(subject, prepare([astral, ascii], [])).category).toBe("groceries");
});

test("a full tie is broken deterministically, and the same way whatever the input order", () => {
  // Same priority, same kind, same length, different category: nothing above
  // this point can decide, so the tiebreak is what makes two devices agree.
  const a = rule({ pattern: "aaaacorp", category: "groceries" });
  const b = rule({ pattern: "bbbbcorp", category: "shopping" });
  const subject = "AAAACORP BBBBCORP";
  const first = categorize(subject, prepare([a, b], []));
  const second = categorize(subject, prepare([b, a], []));
  expect(first).toEqual(second);
  expect(first.category).toBe("groceries");
});

// ---------------------------------------------------------------------------
// The tiers: user rules, then the dictionary
// ---------------------------------------------------------------------------

test("a user rule beats the dictionary, and the dictionary entry was live", () => {
  const mine = rule({ pattern: "amazon", category: "gifts" });
  const dict: DictEntry[] = [{ pattern: "amazon", match: "contains", category: "shopping" }];
  const withRule = categorize("AMAZON.AE", prepare([mine], dict));
  expect(withRule).toEqual({ category: "gifts", source: "rule", id: mine.id, pattern: "amazon", match: "contains" });
  // Control: the same dictionary entry resolves the same merchant on its own.
  expect(categorize("AMAZON.AE", prepare([], dict))).toEqual({
    category: "shopping",
    source: "dictionary",
    pattern: "amazon",
    match: "contains",
  });
});

test("a user rule at the WORST priority still beats the dictionary", () => {
  // The tiers are not merged and sorted together: the dictionary is consulted
  // only after every user rule has failed, whatever priority they carry.
  const mine = rule({ pattern: "amazon", category: "gifts", priority: 9999 });
  const dict: DictEntry[] = [{ pattern: "amazon", match: "contains", category: "shopping" }];
  expect(categorize("AMAZON.AE", prepare([mine], dict)).category).toBe("gifts");
});

test("two dictionary entries that both match are ordered by the same rules", () => {
  const dict: DictEntry[] = [
    { pattern: "amazon", match: "contains", category: "shopping" },
    { pattern: "amazon ae", match: "contains", category: "groceries" },
  ];
  expect(categorize("AMAZON AE STORE", prepare([], dict)).category).toBe("groceries");
  expect(categorize("AMAZON UK STORE", prepare([], dict)).category).toBe("shopping");
});

test("nothing matching is a result, not a failure", () => {
  const dict: DictEntry[] = [{ pattern: "amazon", match: "contains", category: "shopping" }];
  expect(categorize("DR ALIA CLINIC", prepare([rule({ pattern: "noon", category: "x" })], dict))).toEqual(none);
});

test("an empty merchant never matches, even a rule that would contains-match everything", () => {
  // v1's lesson (categorize.go:100): one blank pattern silently categorizes the
  // entire table. Here the pattern is legal and the SUBJECT is empty.
  expect(categorize("   ", prepare([rule({ pattern: "corp", category: "x" })], []))).toEqual(none);
});

// ---------------------------------------------------------------------------
// The 4-rune floor on `contains`
// ---------------------------------------------------------------------------

test("MIN_CONTAINS_RUNES is 4 and MIN_EXACT_RUNES is 2", () => {
  // Pinned to Go and to the SQL literal by conformance.test.ts; asserted here
  // too so a change to the constant fails the unit suite as well as the gate.
  expect(MIN_CONTAINS_RUNES).toBe(4);
  expect(MIN_EXACT_RUNES).toBe(2);
});

test("the published short pattern `on -> charity` cannot contains-match AMAZON, NOON or TALABAT ONLINE", () => {
  // The exact scenario 00017_dict_key_epoch.sql describes: three real users can
  // honestly submit `on`, so the k threshold never sees it. Only the floor does.
  const dict: DictEntry[] = [{ pattern: "on", match: "contains", category: "charity" }];
  const p = prepare([], dict);
  for (const merchant of ["AMAZON", "NOON", "TALABAT ONLINE"]) {
    expect(categorize(merchant, p)).toEqual(none);
  }
  expect(p.defects.map((d) => d.code)).toEqual(["contains_too_short"]);
});

test("the floor is on `contains` only: a two-rune EXACT entry is legal and matches", () => {
  // Without this the test above is also satisfied by "short patterns never
  // work", which is a different and wrong rule.
  const dict: DictEntry[] = [{ pattern: "on", match: "exact", category: "charity" }];
  const p = prepare([], dict);
  expect(p.defects).toEqual([]);
  expect(categorize("ON", p).category).toBe("charity");
  expect(categorize("NOON", p)).toEqual(none);
});

test("a three-rune contains pattern is refused and a four-rune one is not", () => {
  const three = prepare([], [{ pattern: "noo", match: "contains", category: "shopping" }]);
  expect(three.defects.map((d) => d.code)).toEqual(["contains_too_short"]);
  const four = prepare([], [{ pattern: "noon", match: "contains", category: "shopping" }]);
  expect(four.defects).toEqual([]);
  expect(categorize("NOON.COM", four).category).toBe("shopping");
});

test("the floor counts RUNES: three astral characters are refused, four are not", () => {
  // Three astral code points are six UTF-16 units, so a floor written against
  // String.length would accept this one.
  const three = prepare([], [{ pattern: "\u{1d400}\u{1d401}\u{1d402}", match: "contains", category: "shopping" }]);
  expect(three.defects.map((d) => d.code)).toEqual(["contains_too_short"]);
  const four = prepare(
    [],
    [{ pattern: "\u{1d400}\u{1d401}\u{1d402}\u{1d403}", match: "contains", category: "shopping" }],
  );
  expect(four.defects).toEqual([]);
});

test("the floor applies to the USER's own rules, which no server ever validated", () => {
  // `rule_added` is an opaque payload inside an end-to-end blob; replay checks
  // its shape and not its sense, so a two-rune contains rule can arrive from
  // the user's other device and swallow their whole transaction list.
  const short = rule({ pattern: "on", category: "charity", priority: 1 });
  const real = rule({ pattern: "noon", category: "shopping", priority: 50 });
  const p = prepare([short, real], []);
  expect(p.defects).toEqual([{ id: short.id, code: "contains_too_short" }]);
  // Skipped, not applied - and the OTHER rule still works, so this is a
  // targeted refusal rather than a matcher that gave up.
  expect(categorize("NOON.COM", p).category).toBe("shopping");
  expect(categorize("AMAZON", p)).toEqual(none);
});

test("a refused rule is reported rather than dropped", () => {
  const p = prepare(
    [
      rule({ pattern: "on", category: "charity" }),
      rule({ pattern: "x", category: "y", match: "exact" }),
      rule({ pattern: "carrefour", category: "", match: "contains" }),
      rule({ pattern: "carrefour", category: "groceries", match: "sometimes" }),
    ],
    [],
  );
  expect(p.rules).toHaveLength(0);
  expect(p.defects.map((d) => d.code).sort()).toEqual([
    "contains_too_short",
    "empty_category",
    "exact_too_short",
    "unknown_match",
  ]);
});

// ---------------------------------------------------------------------------
// The dictionary's load-time gate
// ---------------------------------------------------------------------------

test("a dictionary entry claiming `regex` is refused, whatever it would have matched", () => {
  // Spec 3.6: a regex published to every device is a fleet-wide execution
  // surface, and the server's own schema has no such value. One arriving anyway
  // means the response did not come from that schema.
  const p = prepare([], [{ pattern: "^carrefour", match: "regex", category: "groceries" }]);
  expect(p.entries).toHaveLength(0);
  expect(p.defects.map((d) => d.code)).toEqual(["regex_not_allowed"]);
  expect(categorize("CARREFOUR", p)).toEqual(none);
});

test("the dictionary gate mirrors dict.Canonicalize's other refusals", () => {
  const cases: Array<[DictEntry, string]> = [
    [{ pattern: "----", match: "contains", category: "groceries" }, "pattern_not_alnum"],
    [{ pattern: "carre four", match: "contains", category: "groceries" }, "pattern_unprintable"],
    [{ pattern: "x".repeat(65), match: "contains", category: "groceries" }, "pattern_too_long"],
    [{ pattern: "carrefour", match: "contains", category: "Groceries & Fresh!" }, "category_not_a_label"],
    [{ pattern: "carrefour", match: "contains", category: "" }, "empty_category"],
    [{ pattern: "   ", match: "contains", category: "groceries" }, "empty_pattern"],
    [{ pattern: "carrefour", match: "starts_with", category: "groceries" }, "unknown_match"],
  ];
  for (const [entry, code] of cases) {
    const v = validateDictEntry(entry);
    expect("defect" in v ? v.defect.code : "accepted").toBe(code);
  }
  // A control, so the list above is not passing because the gate refuses
  // everything: the canonical form of a legal entry comes back canonicalized.
  expect(validateDictEntry({ pattern: "  CARREFOUR  Hyper ", match: "contains", category: "Groceries" })).toEqual({
    entry: { pattern: "carrefour hyper", match: "contains", category: "groceries" },
  });
});

test("homoglyph patterns do not match their look-alikes in either direction", () => {
  const dict: DictEntry[] = [
    { pattern: "carrefour", match: "contains", category: "groceries" },
    { pattern: "\uff43\uff41\uff52\uff52\uff45\uff46\uff4f\uff55\uff52", match: "contains", category: "shopping" },
  ];
  const p = prepare([], dict);
  expect(categorize("CARREFOUR", p).category).toBe("groceries");
  expect(categorize("\uff23\uff21\uff32\uff32\uff25\uff26\uff2f\uff35\uff32", p).category).toBe("shopping");
  expect(categorize("\u0421ARREFOUR", p)).toEqual(none);
});

// ---------------------------------------------------------------------------
// Regex: the dialect gate, and the bound that does not depend on the engine
// ---------------------------------------------------------------------------

test("a regex rule with two unbounded quantifiers in one branch is refused with its reason codes", () => {
  const bad = rule({ pattern: "[0-9]+[0-9]+z", category: "x", match: "regex" });
  const p = prepare([bad], []);
  expect(p.rules).toHaveLength(0);
  expect(p.defects[0]?.code).toBe("regex_rejected");
  expect(p.defects[0]?.reasons).toContain("multiple_unbounded_quantifiers");
});

test("a regex rule using lookaround or a backreference is refused", () => {
  for (const pattern of ["(?=carrefour)x", "(carre)\\1"]) {
    const p = prepare([rule({ pattern, category: "x", match: "regex" })], []);
    expect(p.rules).toHaveLength(0);
    expect(p.defects[0]?.code).toBe("regex_rejected");
  }
});

test("a legal regex rule still runs, so the gate is not refusing everything", () => {
  const p = prepare([rule({ pattern: "carrefour [0-9]{1,4}", category: "groceries", match: "regex" })], []);
  expect(p.defects).toEqual([]);
  expect(categorize("CARREFOUR 1234", p).category).toBe("groceries");
});

test("the subject is bounded to MAX_SUBJECT_RUNES before any pattern touches it", () => {
  // The cost argument for running a regex on an engine nobody has measured is
  // this bound, not the dialect's Bun-calibrated limits. If the truncation goes
  // away this test fails, because the needle past the bound starts matching.
  const p = prepare([rule({ pattern: "needle", category: "found" })], []);
  const past = "a".repeat(MAX_SUBJECT_RUNES) + " needle";
  const within = "a".repeat(MAX_SUBJECT_RUNES - 20) + " needle";
  expect(categorize(past, p)).toEqual(none);
  expect(categorize(within, p).category).toBe("found");
  expect(subjectOf(past).length).toBe(MAX_SUBJECT_RUNES);
});

test("a legal regex runs against a full-length subject", () => {
  // 0.7 ms in Bun 1.3.14 at n = 512 (recorded, not asserted: a wall-clock
  // ceiling in this suite fails on a busy box and measures the box rather than
  // the code -- the cost policy is asserted structurally below instead).
  const p = prepare([rule({ pattern: "(?:[a-z]{8}){8}[a-z]+z", category: "x", match: "regex" })], []);
  expect(p.defects).toEqual([]);
  expect(categorize("a".repeat(MAX_SUBJECT_RUNES), p)).toEqual(none);
  expect(categorize("a".repeat(70) + "z", p).category).toBe("x");
});

// ---------------------------------------------------------------------------
// The cost rule the dialect does not cover
// ---------------------------------------------------------------------------

test("a variable repetition inside a quantified group is refused, with the cheap shapes kept", () => {
  // Measured in Bun 1.3.14 at a 512-rune subject: the two refused patterns take
  // 216 ms and 6,327 ms, the four accepted ones 0.7-4.0 ms. All six pass
  // `validatePattern`, and the refused pair have the SAME bound product (64) as
  // two of the accepted ones, so no tightening of that number separates them.
  const refused = ["^(?:[a-z0-9 ]{1,8}){8}z$", "^(?:(?:[a-z]{1,4}){4}){4}z$"];
  for (const pattern of refused) {
    expect(validatePattern(pattern, ["i"])).toEqual([]); // the dialect accepts it
    expect(nestedVariableRepetition(pattern)).toBe(true);
    const p = prepare([rule({ pattern, category: "x", match: "regex" })], []);
    expect(p.rules).toHaveLength(0);
    expect(p.defects[0]?.code).toBe("regex_nested_variable_repetition");
  }
  const accepted = ["^(?:[a-z]{8}){8}z$", "^[a-z]{1,64}z$", "carrefour [0-9]{1,4}", "^carrefour (hyper|market)$"];
  for (const pattern of accepted) {
    expect(nestedVariableRepetition(pattern)).toBe(false);
    const p = prepare([rule({ pattern, category: "x", match: "regex" })], []);
    expect(p.defects).toEqual([]);
    expect(p.rules).toHaveLength(1);
  }
});

test("the cost scanner is not fooled by escapes or character classes", () => {
  // `\(` is a literal parenthesis and `[{]` is a literal brace: neither opens a
  // group nor starts a quantifier, so neither may be read as one.
  expect(nestedVariableRepetition("\\(a{1,4}\\){4}")).toBe(false);
  expect(nestedVariableRepetition("[{]{1,4}")).toBe(false);
  expect(nestedVariableRepetition("[\\]a]{1,4}")).toBe(false);
  // A quantifier-shaped run INSIDE a class is literal text, not a quantifier:
  // read as one, this pattern looks like a variable repetition inside a
  // quantified group and would be refused for nothing.
  expect(nestedVariableRepetition("(?:[a{1,4}]x){4}")).toBe(false);
  // ...and a parenthesis inside a class does not close a group.
  expect(nestedVariableRepetition("[)]{1,4}")).toBe(false);
  expect(nestedVariableRepetition("(?:[)]{1,4}x){4}")).toBe(true);
  // ...and a class WITH a variable quantifier inside a quantified group is
  // still caught, so the class handling has not disabled the check.
  expect(nestedVariableRepetition("(?:[\\]a]{1,4}){4}")).toBe(true);
  // A lazy quantifier is the same shape.
  expect(nestedVariableRepetition("(?:a{1,4}?){4}")).toBe(true);
  // A fixed repetition of a fixed repetition is not variable at all.
  expect(nestedVariableRepetition("(?:a{4}){4}")).toBe(false);
});

test("the catastrophic pattern cannot cost a pass anything, because it never runs", () => {
  // Measured at 6,327 ms for ONE match in Bun 1.3.14 -- and 5,986 ms against a
  // 32-rune subject, so the blowup is in the repeat structure and shrinking the
  // subject does not tame it. The pattern is therefore never compiled and never
  // run, which is asserted structurally: timing it here would put a
  // six-second regex in the suite to prove it is not there.
  const p = prepare([rule({ pattern: "^(?:(?:[a-z]{1,4}){4}){4}z$", category: "x", match: "regex" })], []);
  expect(p.rules).toHaveLength(0);
  expect(p.defects[0]?.code).toBe("regex_nested_variable_repetition");
  expect(categorize("a".repeat(MAX_SUBJECT_RUNES), p)).toEqual(none);
});
