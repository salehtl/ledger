/**
 * The device half of the dictionary's dual-executor contract.
 *
 * `conformance/dict/matching.json` is written by Go
 * (`internal/v2/dict.TestWriteDictConformanceFixtures`) and carries four things
 * this file checks the device against:
 *
 *  - the LIMITS both sides hard-code, including the 4-rune `contains` floor,
 *    which Go already pins to its SQL CHECK. That chain is what makes the floor
 *    one number rather than three: SQL <-> Go <-> here.
 *  - `unicode.IsSpace` and `strings.ToLower`, probed a code point at a time.
 *  - `dict.Canonicalize`'s verdict and output for whole entries.
 *  - `contains`/`exact` verdicts computed by POSTGRES with the expression the
 *    moderation queue's breadth preview uses.
 *
 * A failure here is not a test bug by default. It means a merchant string
 * canonicalizes differently on the server and on the phone, which shows up in
 * production as a published pattern that silently never matches.
 */

import { expect, test } from "bun:test";

import { canonical, foldCase, isGoSpace } from "./canon";
import {
  MAX_CATEGORY_RUNES,
  MAX_DICT_PATTERN_RUNES,
  MIN_CATEGORY_RUNES,
  MIN_CONTAINS_RUNES,
  MIN_EXACT_RUNES,
  matchesPattern,
  validateDictEntry,
} from "./rules";

interface Fixture {
  limits: {
    k: number;
    min_contains_runes: number;
    min_pattern_runes: number;
    max_pattern_runes: number;
    min_category_runes: number;
    max_category_runes: number;
  };
  space: Array<{ name: string; cp: number; is_space: boolean }>;
  lower: Array<{ name: string; input_base64: string; lower_base64: string }>;
  canonical: Array<{
    name: string;
    pattern_base64: string;
    match: string;
    category_base64: string;
    ok: boolean;
    canonical_pattern_base64: string;
    canonical_match: string;
    canonical_category: string;
  }>;
  match: Array<{ name: string; match: string; pattern_base64: string; subject_base64: string; matched: boolean }>;
}

const fixturePath = `${import.meta.dir}/../../../conformance/dict/matching.json`;
const fx = (await Bun.file(fixturePath).json()) as Fixture;

const dec = (b64: string): string => Buffer.from(b64, "base64").toString("utf8");

test("the fixture is present and not empty", () => {
  // A conformance runner that silently passes on a missing corpus is the
  // failure mode fixtures exist to prevent.
  expect(fx.space.length).toBeGreaterThan(10);
  expect(fx.lower.length).toBeGreaterThan(5);
  expect(fx.canonical.length).toBeGreaterThan(20);
  expect(fx.match.length).toBeGreaterThan(10);
});

test("the limits this device enforces are the ones Go publishes at", () => {
  expect(MIN_CONTAINS_RUNES).toBe(fx.limits.min_contains_runes);
  expect(MIN_EXACT_RUNES).toBe(fx.limits.min_pattern_runes);
  expect(MAX_DICT_PATTERN_RUNES).toBe(fx.limits.max_pattern_runes);
  expect(MIN_CATEGORY_RUNES).toBe(fx.limits.min_category_runes);
  expect(MAX_CATEGORY_RUNES).toBe(fx.limits.max_category_runes);
  // The number in the middle of the chain, stated once more so a reader of this
  // file does not have to open two others to learn it.
  expect(fx.limits.min_contains_runes).toBe(4);
});

test("isGoSpace agrees with unicode.IsSpace on every probe", () => {
  const disagreed: string[] = [];
  for (const c of fx.space) {
    if (isGoSpace(c.cp) !== c.is_space) disagreed.push(`${c.name} (U+${c.cp.toString(16).toUpperCase()})`);
  }
  expect(disagreed).toEqual([]);
  // The two the naive `\s` gets wrong, named so that trimming the probe set
  // cannot quietly remove them.
  expect(fx.space.some((c) => c.cp === 0x85 && c.is_space)).toBe(true);
  expect(fx.space.some((c) => c.cp === 0xfeff && !c.is_space)).toBe(true);
});

test("foldCase agrees with strings.ToLower on every probe", () => {
  const disagreed: Array<[string, string, string]> = [];
  for (const c of fx.lower) {
    const got = foldCase(dec(c.input_base64));
    const want = dec(c.lower_base64);
    if (got !== want) disagreed.push([c.name, got, want]);
  }
  expect(disagreed).toEqual([]);
  // And the same probes through String.prototype.toLowerCase must NOT all
  // agree, or this test is measuring nothing that the one-liner would fail.
  const naiveDisagreements = fx.lower.filter((c) => dec(c.input_base64).toLowerCase() !== dec(c.lower_base64));
  expect(naiveDisagreements.length).toBeGreaterThan(0);
});

test("the device's load gate reaches the same verdict as dict.Canonicalize", () => {
  const disagreed: Array<{ name: string; go: boolean; device: boolean }> = [];
  for (const c of fx.canonical) {
    if (c.match === "") continue; // see the test below
    const v = validateDictEntry({ pattern: dec(c.pattern_base64), match: c.match, category: dec(c.category_base64) });
    const accepted = "entry" in v;
    if (accepted !== c.ok) disagreed.push({ name: c.name, go: c.ok, device: accepted });
  }
  expect(disagreed).toEqual([]);
});

test("an accepted entry canonicalizes to the same bytes on both sides", () => {
  const disagreed: Array<{ name: string; go: string; device: string }> = [];
  for (const c of fx.canonical) {
    if (!c.ok || c.match === "") continue;
    const v = validateDictEntry({ pattern: dec(c.pattern_base64), match: c.match, category: dec(c.category_base64) });
    if (!("entry" in v)) continue; // the verdict test above owns this case
    const want = dec(c.canonical_pattern_base64);
    if (v.entry.pattern !== want) disagreed.push({ name: c.name, go: want, device: v.entry.pattern });
    expect(v.entry.category).toBe(c.canonical_category);
    expect(v.entry.match).toBe(c.canonical_match);
  }
  expect(disagreed).toEqual([]);
  // The probes have to include some that are NOT already canonical, or the
  // comparison is between two identity functions.
  const changed = fx.canonical.filter((c) => c.ok && c.match !== "" && c.canonical_pattern_base64 !== c.pattern_base64);
  expect(changed.length).toBeGreaterThan(3);
});

test("a blank match type is a DELIBERATE divergence: Go defaults it, the device refuses it", () => {
  // dict.Canonicalize is the WRITE path and accepts a caller that omitted the
  // field, defaulting to `contains`. This device is a READ path over a column
  // that is NOT NULL with a CHECK in ('contains','exact'), so a blank one did
  // not come from that schema and is refused rather than guessed at. Asserted
  // rather than skipped, so it stays a decision instead of becoming a gap.
  const blank = fx.canonical.filter((c) => c.match === "");
  expect(blank.length).toBeGreaterThan(0);
  for (const c of blank) {
    expect(c.ok).toBe(true);
    const v = validateDictEntry({ pattern: dec(c.pattern_base64), match: "", category: dec(c.category_base64) });
    expect("defect" in v && v.defect.code).toBe("unknown_match");
  }
});

test("the device's contains/exact primitive agrees with the server's SQL", () => {
  const disagreed: Array<{ name: string; sql: boolean; device: boolean }> = [];
  for (const c of fx.match) {
    const kind = c.match === "exact" ? "exact" : "contains";
    const got = matchesPattern(kind, dec(c.pattern_base64), dec(c.subject_base64));
    if (got !== c.matched) disagreed.push({ name: c.name, sql: c.matched, device: got });
  }
  expect(disagreed).toEqual([]);
  // Both verdicts have to be present, or "agrees" is satisfied by a matcher
  // that always returns the same answer.
  expect(fx.match.some((c) => c.matched)).toBe(true);
  expect(fx.match.some((c) => !c.matched)).toBe(true);
});

test("the short published pattern matches on the server too, which is why the floor exists", () => {
  // The floor is not a matching rule, it is a PUBLICATION rule. `on` really does
  // contains-match all three of these in SQL — the fixture says so — and the
  // only thing standing between that and every device is the 4-rune bound.
  const shorts = fx.match.filter((c) => c.name.startsWith("the short pattern"));
  expect(shorts.length).toBe(3);
  for (const c of shorts) {
    expect(c.matched).toBe(true);
    expect(matchesPattern("contains", dec(c.pattern_base64), dec(c.subject_base64))).toBe(true);
  }
  // ...and the gate refuses to store it, so the matcher above never sees it.
  const v = validateDictEntry({ pattern: "on", match: "contains", category: "charity" });
  expect("defect" in v && v.defect.code).toBe("contains_too_short");
});

test("canonicalizing a merchant on this device produces what the server stored for it", () => {
  // The end-to-end claim the sections above decompose: for every accepted
  // entry, folding the ORIGINAL pattern text here lands on the server's stored
  // form. This is the property a mis-canonicalization actually breaks.
  for (const c of fx.canonical) {
    if (!c.ok || c.match === "") continue;
    expect(canonical(dec(c.pattern_base64))).toBe(dec(c.canonical_pattern_base64));
  }
});
