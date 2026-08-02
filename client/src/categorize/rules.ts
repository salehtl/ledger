/**
 * On-device categorization: user rules first, then the global dictionary, then
 * nothing. No network, no AI, no server round trip — spec §3.6 and the plan's
 * "no AI anywhere in the beta".
 *
 * # The order, and why every step of it is written down
 *
 * A merchant string resolves in exactly one pass:
 *
 *  1. **The user's own rules**, in priority order. A rule the user (or their
 *     review-queue confirmation) authored always beats the crowd, because the
 *     dictionary is other people's opinion about a merchant and the rule is
 *     this user's decision about it.
 *  2. **The published dictionary**, `contains` and `exact` only.
 *  3. **Uncategorized.** Which is a result, not a failure: the review queue is
 *     where an uncategorized transaction goes, and a wrong category is worse
 *     than an absent one.
 *
 * Within each tier the order is TOTAL and independent of iteration order —
 * see {@link comparePrepared}. That matters more than it looks: `State.rules` is
 * a `Map` and the projection's `rule` table has no `ORDER BY`, so a matcher that
 * walked either in natural order would produce a category that depended on
 * fold history on one device and on SQLite's page layout on another. Two
 * replicas of the same log would disagree about the same merchant.
 *
 * # `priority`: LOWER WINS
 *
 * v1's `internal/categorize` documents this at `categorize.go:19` ("ordered by
 * Priority (lower = higher priority)") and its own write-back path emits 100 for
 * a generated rule so that anything hand-written outranks it. v2 keeps the
 * convention rather than inverting it, because the operator's 212 seeded rules
 * and their muscle memory both assume it.
 *
 * # The 4-rune floor on `contains`, on the device
 *
 * `internal/v2/dict` refuses to publish a `contains` pattern shorter than four
 * runes, in Go and in a SQL CHECK, because `on -> charity` passes every gate the
 * crowd design has — three real users can honestly submit it — and then matches
 * AMAZON, NOON and TALABAT ONLINE on every device in the beta. Breadth is not
 * rarity, so the k threshold cannot see it.
 *
 * The floor is enforced AGAIN here, and not as a formality:
 *
 *   - A dictionary entry arrives over a network from a server this code does not
 *     get to audit. A hand-edited row or a substituted response is the threat;
 *     refusing to load it is the response. Same argument `tmpl/dialect.ts` makes
 *     for a published regex.
 *   - A USER rule is not validated by the server at all — `rule_added` is an
 *     opaque payload in an end-to-end blob, and `replay.ts` checks its shape and
 *     not its sense. So a two-rune `contains` rule can reach this device from
 *     the user's own other device, and it would silently swallow their whole
 *     transaction list. It is skipped and REPORTED (see {@link PreparedRules}),
 *     never applied and never silently dropped.
 *
 * {@link MIN_CONTAINS_RUNES} is pinned to Go's `dict.minContainsRunes` and to
 * the SQL literal in `00017_dict_key_epoch.sql` through
 * `conformance/dict/matching.json`, the same way the dialect's limits are.
 *
 * # Regex, and an engine nobody has measured
 *
 * The dictionary never carries a regex (§3.6 — a regex published to every device
 * is a fleet-wide execution surface). A USER rule may, so one is compiled here,
 * and only after `tmpl/dialect.ts` accepts it: no lookaround, no backreference,
 * at most {@link MAX_UNBOUNDED_PER_BRANCH} unbounded quantifier per alternation
 * branch, bounded repetition product.
 *
 * **Those limits were calibrated in Bun 1.3.14 and this code will run on
 * Hermes, which nobody has measured.** `dialect.ts` says so in as many words.
 * This module therefore does not rest its cost argument on them. It rests it on
 * {@link MAX_SUBJECT_RUNES}: a categorization subject is a MERCHANT NAME, not an
 * email body, and it is truncated to 512 code points before any pattern touches
 * it. Backtracking cost for k unbounded quantifiers that can consume the same
 * characters is O(n^(k+1)); the dialect holds k <= 1, so the bound is quadratic
 * in 512 — about 2.6e5 character comparisons in the worst case — in ANY
 * backtracking engine, without knowing anything about how fast that engine is.
 * The dialect's numbers were measured at n = 400..8,000 on attacker-writable
 * inbound mail, which is a different problem.
 *
 * What is genuinely unmeasured on Hermes, and is recorded rather than papered
 * over: whether Hermes AGREES with Bun and Go about what a given pattern
 * matches. `agreement.test.ts` already records one divergence in this family
 * (Bun's `/[a-z]/iu` does not match U+212A; Go, V8 and WebKit's does). A user
 * rule that lands on such a character can categorize differently on the CLI and
 * on the phone. Task 28's device run is where that gets measured; until then the
 * failure is a wrong-or-absent category on one device, never a hang.
 *
 * # Host imports
 *
 * None. `tmpl/dialect.ts` is pure and so is this; both reach Hermes.
 */

import { MAX_UNBOUNDED_PER_BRANCH, compile as compileRegex, validatePattern } from "../tmpl/dialect";
import { canonical, runeLength, truncateRunes } from "./canon";

/** How a pattern is matched. The dictionary may only ever use the first two. */
export type MatchKind = "exact" | "contains" | "regex";

const MATCH_KINDS: ReadonlySet<string> = new Set<MatchKind>(["exact", "contains", "regex"]);

/**
 * The floor on a `contains` pattern, in RUNES. Pinned to `dict.minContainsRunes`
 * and to the SQL CHECK by `conformance.test.ts`.
 *
 * Four is measured rather than guessed: the operator's own 212 seeded v1 rules
 * bottom out at exactly four characters, so it rejects nothing real.
 */
export const MIN_CONTAINS_RUNES = 4;

/** The floor on an `exact` pattern, which matches one string and nothing else. */
export const MIN_EXACT_RUNES = 2;

/** `dict.maxPatternRunes`. Applies to dictionary entries, which the server bounds. */
export const MAX_DICT_PATTERN_RUNES = 64;

/** `dict`'s category bounds, and `dict_entries_category_is_a_bounded_label`'s. */
export const MIN_CATEGORY_RUNES = 2;
export const MAX_CATEGORY_RUNES = 32;

/**
 * The ceiling on a user rule's pattern.
 *
 * Larger than the dictionary's, because a user's `exact` rule for a long
 * merchant line is legitimate and only ever runs on their own device. It is the
 * dialect's own pattern ceiling, so a regex rule cannot be bounded here more
 * loosely than the validator that accepts it.
 */
export const MAX_RULE_PATTERN_RUNES = 512;

/**
 * The bound every pattern is matched against, in RUNES — the load-bearing half
 * of the cost argument above, and the half that does not depend on which engine
 * this is.
 *
 * 512 is `tmpl/exec.ts`'s `MAX_CAPTURE_RUNES`, so a merchant produced by the
 * template tier is never truncated at all; the cap exists for a merchant a user
 * typed or an `txn_edited` op carried, which nothing else bounds.
 */
export const MAX_SUBJECT_RUNES = 512;

/**
 * The flags a user regex rule is compiled with: case-insensitive, and `u` (added
 * by `dialect.compile`, and not optional — it is what makes case folding agree
 * across engines).
 */
export const REGEX_FLAGS: readonly string[] = ["i"];

/** One of the user's own rules, as `replay.ts` materializes it. */
export interface UserRule {
  id: string;
  pattern: string;
  match: string;
  category: string;
  priority: number;
}

/** One published dictionary entry, as `GET /api/v1/dictionary` serves it. */
export interface DictEntry {
  pattern: string;
  match: string;
  category: string;
}

/**
 * Why a rule or entry is not being applied. Every one of these is REPORTED —
 * `PreparedRules.defects` — because a rule that quietly does nothing is a
 * support ticket that cannot be answered.
 */
export type DefectCode =
  | "empty_pattern"
  | "empty_category"
  | "contains_too_short"
  | "exact_too_short"
  | "pattern_too_long"
  | "pattern_not_alnum"
  | "pattern_unprintable"
  | "category_too_short"
  | "category_too_long"
  | "category_not_a_label"
  | "multiline"
  | "unknown_match"
  | "regex_not_allowed"
  | "regex_rejected"
  | "regex_nested_variable_repetition";

export interface Defect {
  /** The rule's entity id, or `pattern category` for a dictionary entry. */
  id: string;
  code: DefectCode;
  /** Dialect reason codes, when `code` is `regex_rejected`. */
  reasons?: string[];
}

/** A rule or entry that passed validation, with its pattern canonicalized. */
export interface Prepared {
  id: string;
  pattern: string;
  match: MatchKind;
  category: string;
  priority: number;
  re: RegExp | null;
}

/** The result of {@link prepare}: what will run, and what will not. */
export interface PreparedRules {
  rules: readonly Prepared[];
  entries: readonly Prepared[];
  defects: readonly Defect[];
}

/** What {@link categorize} decided, and what decided it. */
export type Decision =
  | { category: string; source: "rule"; id: string; pattern: string; match: MatchKind }
  | { category: string; source: "dictionary"; pattern: string; match: MatchKind }
  | { category: null; source: "none" };

const UNCATEGORIZED: Decision = { category: null, source: "none" };

/**
 * `^[a-z0-9][a-z0-9 _/&-]{0,31}$` — `dict_entries_category_is_a_bounded_label`,
 * verbatim. A dictionary category that does not fit it did not come from a
 * server running the schema this client was written against.
 */
const DICT_CATEGORY_RE = /^[a-z0-9][a-z0-9 _/&-]{0,31}$/;

/** Control, format, surrogate, private-use and unassigned — Go's `hasUnprintable`. */
const UNPRINTABLE_RE = /\p{C}/u;

/** At least one letter or digit — Go's `hasAlnum`, and the SQL `pattern ~ '[[:alnum:]]'`. */
const ALNUM_RE = /[\p{L}\p{N}]/u;

/**
 * Every rune Unicode says ends a line — Go's `hasLineBreak`, character for
 * character. Not just `\n`: U+0085, U+2028 and U+2029 break a rendered line
 * exactly as `\n` does, and all three are whitespace to `collapse`, so a
 * canonicalizer that ran first would join the halves rather than refuse them.
 */
const LINE_BREAK_RE = /[\n\r\v\f\u0085\u2028\u2029]/u;

function hasLineBreak(s: string): boolean {
  return LINE_BREAK_RE.test(s);
}

/**
 * Rejects a pattern containing a VARIABLE-LENGTH repetition inside a QUANTIFIED
 * GROUP — the one cost the dialect's bounds do not cover, measured rather than
 * argued.
 *
 * # Why this exists on top of `validatePattern`
 *
 * `tmpl/dialect.ts` bounds unbounded quantifiers (`MAX_UNBOUNDED_PER_BRANCH`)
 * and the product of `{n,m}` upper bounds along a nesting path
 * (`MAX_BOUND_PRODUCT` = 64). Neither bounds the number of ways a *bounded*
 * quantifier can split its input, and nesting one inside a repetition multiplies
 * that count. Measured here, in Bun 1.3.14, against a 512-rune subject — every
 * one of these is ACCEPTED by `validatePattern` today:
 *
 * | pattern                          | bound product | time      |
 * |----------------------------------|---------------|-----------|
 * | `^(?:[a-z]{8}){8}z$`             | 64            | 0.7 ms    |
 * | `^[a-z]{1,64}z$`                 | 64            | 1.0 ms    |
 * | `^(?:[a-z0-9 ]{1,4}){8}z$`       | 32            | 0.9 ms    |
 * | `^(?:[a-z0-9 ]{1,8}){8}z$`       | 64            | **216 ms**|
 * | `^(?:(?:[a-z]{1,4}){4}){4}z$`    | 64            | **6,327 ms** |
 *
 * A 216 ms match is 13 minutes across a 3,683-row re-categorization pass, and
 * the 6.3-second one is a frozen phone. The rows that are cheap and the rows
 * that are catastrophic have the SAME bound product, so no tightening of that
 * number separates them: what separates them is whether a variable-length
 * repetition sits inside a repetition.
 *
 * # Why it is here and not in the dialect
 *
 * `tmpl/dialect.ts` is a two-engine AGREEMENT contract with a Go mirror and a
 * committed conformance fixture; changing it changes what the server may
 * publish. This is a device-side COST policy for user-authored rules, which the
 * server never sees. If a later measurement shows templates need it too, it
 * moves — in both languages, with the fixture regenerated.
 *
 * # And what it does not claim
 *
 * The times above are Bun's. Hermes is a different engine and nobody has
 * measured it. This rule is structural, so it does not inherit those numbers —
 * "a variable repetition inside a repetition is exponential in the repeat count"
 * is a property of backtracking, not of a build — but the residual is real and
 * recorded: a pattern this accepts could still be slower on Hermes than on Bun.
 * Task 28's device run is where that is measured.
 */
export function nestedVariableRepetition(p: string): boolean {
  const r = [...p];
  const stack: Array<{ variable: boolean }> = [{ variable: false }];
  const top = (): { variable: boolean } => stack[stack.length - 1]!;
  let inClass = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (inClass) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c !== "]") continue;
      inClass = false;
      i = mark(r, i + 1, top());
      continue;
    }
    switch (c) {
      case "\\":
        i = mark(r, i + 2, top());
        continue;
      case "[":
        inClass = true;
        continue;
      case "(":
        stack.push({ variable: false });
        continue;
      case ")": {
        const frame = stack.pop() ?? { variable: false };
        const q = quantifierAt(r, i + 1);
        if (q === null) {
          // Not repeated: whatever variability it holds is still variability in
          // the enclosing scope, but it is not multiplied by anything.
          if (frame.variable) top().variable = true;
          continue;
        }
        // The group repeats, so everything variable inside it multiplies.
        if (frame.variable) return true;
        i = q.end;
        if (q.variable) top().variable = true;
        continue;
      }
      default:
        i = mark(r, i + 1, top());
        continue;
    }
  }
  return false;
}

/** Consumes a quantifier at `j`, recording variability, and returns the new index. */
function mark(r: readonly string[], j: number, frame: { variable: boolean }): number {
  const q = quantifierAt(r, j);
  if (q === null) return j - 1;
  if (q.variable) frame.variable = true;
  return q.end;
}

/**
 * Reads a quantifier starting at `j`, or null. `end` is the index of its last
 * character; `variable` is whether it can consume a RANGE of lengths, which is
 * what multiplies the search space.
 *
 * `validatePattern` has already rejected a malformed `{`, so an unparseable one
 * here is treated as a literal brace rather than guessed at.
 */
function quantifierAt(r: readonly string[], j: number): { end: number; variable: boolean } | null {
  const c = r[j];
  if (c === undefined) return null;
  const lazy = (end: number): number => (r[end + 1] === "?" ? end + 1 : end);
  if (c === "?" || c === "*" || c === "+") return { end: lazy(j), variable: true };
  if (c !== "{") return null;
  let k = j + 1;
  let lo = "";
  while (r[k] !== undefined && r[k]! >= "0" && r[k]! <= "9") lo += r[k++]!;
  if (lo === "") return null;
  if (r[k] === "}") return { end: lazy(k), variable: false };
  if (r[k] !== ",") return null;
  k++;
  let hi = "";
  while (r[k] !== undefined && r[k]! >= "0" && r[k]! <= "9") hi += r[k++]!;
  if (r[k] !== "}") return null;
  // `{n,}` is unbounded; `{n,m}` is variable when m > n.
  return { end: lazy(k), variable: hi === "" || Number(hi) > Number(lo) };
}

/**
 * Orders one tier of patterns TOTALLY, so that two devices folding the same log
 * pick the same rule.
 *
 * The order, and the argument for each step:
 *
 *  1. `priority` ascending — LOWER WINS, v1's convention. This is the only step
 *     the user controls, so it comes first.
 *  2. `exact`, then `contains`, then `regex`. The first two are a specificity
 *     ordering (an exact match is a strictly narrower claim than a substring
 *     one). Putting `regex` last is that plus a cost argument: the one match
 *     kind whose running time is not linear in the subject only runs when
 *     nothing cheaper matched.
 *  3. Longer pattern first. `carrefour hyper` is a more specific claim than
 *     `carrefour`, and the user should not have to encode that as a priority.
 *  4. Pattern, then category, then id, by code point. Arbitrary, and that is the
 *     point: it is a tiebreak that exists so the answer is never "whichever the
 *     Map yielded first". It never decides between two DIFFERENT categories that
 *     a user could have distinguished — steps 1-3 have already run.
 */
function comparePrepared(a: Prepared, b: Prepared): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ka = MATCH_ORDER[a.match];
  const kb = MATCH_ORDER[b.match];
  if (ka !== kb) return ka - kb;
  const la = runeLength(a.pattern);
  const lb = runeLength(b.pattern);
  if (la !== lb) return lb - la;
  const p = compareCodePoints(a.pattern, b.pattern);
  if (p !== 0) return p;
  const c = compareCodePoints(a.category, b.category);
  if (c !== 0) return c;
  return compareCodePoints(a.id, b.id);
}

const MATCH_ORDER: Record<MatchKind, number> = { exact: 0, contains: 1, regex: 2 };

/**
 * Compares by code point.
 *
 * Not `wire/op.ts`'s `compareUTF8`, which would drag the platform seam into a
 * module that has no other reason to touch it, and not `<` on strings, which is
 * UTF-16 order and therefore sorts an astral character before U+E000. Code point
 * order is the same on every JavaScript engine, which is all a tiebreak needs.
 */
function compareCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * Validates, canonicalizes, compiles and orders both tiers ONCE.
 *
 * Called once per pass over the transaction table, never per row: a 3,683-row
 * re-categorization that re-validated 212 rules per row would do 780,000
 * validations to answer 3,683 questions, and `validatePattern` is a scanner.
 */
export function prepare(rules: readonly UserRule[], entries: readonly DictEntry[]): PreparedRules {
  const defects: Defect[] = [];
  const out: Prepared[] = [];
  for (const r of rules) {
    const p = prepareRule(r, defects);
    if (p !== null) out.push(p);
  }
  const dict: Prepared[] = [];
  for (const e of entries) {
    const p = prepareEntry(e, defects);
    if (p !== null) dict.push(p);
  }
  out.sort(comparePrepared);
  dict.sort(comparePrepared);
  return { rules: out, entries: dict, defects };
}

function prepareRule(r: UserRule, defects: Defect[]): Prepared | null {
  const bad = (code: DefectCode, reasons?: string[]): null => {
    defects.push(reasons === undefined ? { id: r.id, code } : { id: r.id, code, reasons });
    return null;
  };
  if (!MATCH_KINDS.has(r.match)) return bad("unknown_match");
  const match = r.match as MatchKind;
  const category = canonical(r.category);
  if (category === "") return bad("empty_category");
  // A regex is matched against the canonical subject, so its own text is NOT
  // canonicalized — collapsing whitespace inside `[ ]{2}` would change what it
  // means. Case is handled by the `i` flag instead.
  if (match !== "regex" && hasLineBreak(r.pattern)) return bad("multiline");
  const pattern = match === "regex" ? r.pattern : canonical(r.pattern);
  if (pattern === "") return bad("empty_pattern");
  const n = runeLength(pattern);
  if (n > MAX_RULE_PATTERN_RUNES) return bad("pattern_too_long");
  if (match === "contains" && n < MIN_CONTAINS_RUNES) return bad("contains_too_short");
  if (match === "exact" && n < MIN_EXACT_RUNES) return bad("exact_too_short");
  let re: RegExp | null = null;
  if (match === "regex") {
    const reasons = validatePattern(pattern, [...REGEX_FLAGS]);
    if (reasons.length > 0) return bad("regex_rejected", reasons);
    if (nestedVariableRepetition(pattern)) return bad("regex_nested_variable_repetition");
    re = compileRegex(pattern, [...REGEX_FLAGS]);
  }
  return { id: r.id, pattern, match, category, priority: r.priority, re };
}

/**
 * The load-time gate on a dictionary entry — the mirror of `dict.Canonicalize`,
 * applied to bytes that arrived over a network.
 *
 * Every refusal here is a statement that the server did something the schema
 * says it cannot. They are counted and surfaced rather than logged, because a
 * device quietly discarding half the dictionary looks exactly like a dictionary
 * with nothing in it.
 *
 * It runs TWICE on the normal path — once in `dictionary.ts` as a delta is
 * applied, so a refused entry is never stored, and once from {@link prepare}, so
 * a row that reached the table some other way (a restored file, a build with an
 * older validator) still cannot match. The second is not redundant with the
 * first: one guards the network boundary and the other guards the disk.
 */
export function validateDictEntry(e: DictEntry): { entry: DictEntry } | { defect: Defect } {
  const id = `${e.match} ${e.pattern} -> ${e.category}`;
  const bad = (code: DefectCode): { defect: Defect } => ({ defect: { id, code } });
  if (e.match === "regex") return bad("regex_not_allowed");
  if (e.match !== "exact" && e.match !== "contains") return bad("unknown_match");
  // Checked on the RAW input, before collapsing, exactly as `dict.Canonicalize`
  // does: a merchant name is one line, and collapsing first would silently JOIN
  // a two-line paste into a valid-looking pattern instead of refusing it.
  if (hasLineBreak(e.pattern) || hasLineBreak(e.category)) return bad("multiline");
  const pattern = canonical(e.pattern);
  const category = canonical(e.category);
  if (pattern === "") return bad("empty_pattern");
  if (!ALNUM_RE.test(pattern)) return bad("pattern_not_alnum");
  if (UNPRINTABLE_RE.test(pattern)) return bad("pattern_unprintable");
  if (category === "") return bad("empty_category");
  const cn = runeLength(category);
  if (cn < MIN_CATEGORY_RUNES) return bad("category_too_short");
  if (cn > MAX_CATEGORY_RUNES) return bad("category_too_long");
  if (!DICT_CATEGORY_RE.test(category)) return bad("category_not_a_label");
  const n = runeLength(pattern);
  if (n > MAX_DICT_PATTERN_RUNES) return bad("pattern_too_long");
  if (e.match === "contains" && n < MIN_CONTAINS_RUNES) return bad("contains_too_short");
  if (e.match === "exact" && n < MIN_EXACT_RUNES) return bad("exact_too_short");
  return { entry: { pattern, match: e.match, category } };
}

function prepareEntry(e: DictEntry, defects: Defect[]): Prepared | null {
  const v = validateDictEntry(e);
  if ("defect" in v) {
    defects.push(v.defect);
    return null;
  }
  // Priority 0 for every entry: the dictionary tier is consulted only after
  // every user rule has failed, so entries are never ordered against rules.
  return {
    id: `${v.entry.match} ${v.entry.pattern}`,
    pattern: v.entry.pattern,
    match: v.entry.match as MatchKind,
    category: v.entry.category,
    priority: 0,
    re: null,
  };
}

/**
 * The subject a pattern is matched against: canonical, and bounded.
 *
 * Exported because the review queue wants to show the user the string their rule
 * will actually be tested against, and because a test that cannot see the bound
 * cannot check it.
 */
export function subjectOf(merchantRaw: string): string {
  return truncateRunes(canonical(merchantRaw), MAX_SUBJECT_RUNES);
}

/**
 * The `contains` / `exact` primitive, over two ALREADY-CANONICAL strings.
 *
 * Separated out because it is the one piece of this file the server also
 * computes: `dict.List`'s breadth preview runs `position(pattern IN other) > 0`
 * and `other = pattern` in SQL, and `conformance/dict/matching.json` carries
 * Postgres's verdict for every probe so the two can be compared mechanically. If
 * they diverge, the moderator's "what else would this match" preview is
 * describing a different matcher than the one on the phone.
 *
 * It canonicalizes nothing: both arguments are canonical by the time they reach
 * it, and a second fold here would hide a caller that forgot the first.
 */
export function matchesPattern(kind: "exact" | "contains", pattern: string, subject: string): boolean {
  return kind === "exact" ? subject === pattern : subject.includes(pattern);
}

/** Whether one prepared pattern matches an already-canonical subject. */
function hits(p: Prepared, subject: string): boolean {
  switch (p.match) {
    case "exact":
    case "contains":
      return matchesPattern(p.match, p.pattern, subject);
    case "regex":
      // `re` is non-null for every prepared regex; `prepareRule` returns null
      // rather than a rule it could not compile.
      return p.re !== null && p.re.test(subject);
  }
}

/**
 * Resolves one merchant string: user rules, then the dictionary, then nothing.
 *
 * `merchantRaw` is the raw field; canonicalization happens here so no caller can
 * forget it. An unparsed transaction has no merchant and must not reach this
 * function at all — see `dictionary.ts`'s candidate query, which excludes them
 * in SQL.
 */
export function categorize(merchantRaw: string, prepared: PreparedRules): Decision {
  const subject = subjectOf(merchantRaw);
  if (subject === "") return UNCATEGORIZED;
  for (const r of prepared.rules) {
    if (hits(r, subject)) {
      return { category: r.category, source: "rule", id: r.id, pattern: r.pattern, match: r.match };
    }
  }
  for (const e of prepared.entries) {
    if (hits(e, subject)) {
      return { category: e.category, source: "dictionary", pattern: e.pattern, match: e.match };
    }
  }
  return UNCATEGORIZED;
}

/**
 * Re-exported so a settings screen can state the dialect bound it is enforcing
 * without importing `tmpl/`, and so the Hermes note above has one obvious place
 * to be read from.
 */
export const REGEX_MAX_UNBOUNDED_PER_BRANCH = MAX_UNBOUNDED_PER_BRANCH;
