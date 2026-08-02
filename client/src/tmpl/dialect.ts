/**
 * The client-side mirror of the template regex dialect (internal/v2/tmpl/dialect.go).
 *
 * # Why a second copy exists
 *
 * A published template is data: written once in an admin console, stored
 * server-side, shipped to every device, and then run by TWO independent regex
 * engines — Go's RE2 and this device's JavaScript. The dialect is the subset of
 * RE2 on which those two engines were MEASURED to agree, plus the cost rules
 * that keep matching cheap on a phone.
 *
 * The server gates at publish time. This gate runs at LOAD time, on the device,
 * because by then the pattern has crossed a network from a server this code
 * does not get to audit, and a pattern that reaches `new RegExp` is a pattern
 * this device will run. A hand-edited row, a substituted response or a
 * server-side regression is the threat; refusing to load is the response.
 *
 * # The contract
 *
 * Every rejection carries a stable REASON CODE, and this file must produce the
 * same codes in the same order as Go for the same pattern. That is not a claim,
 * it is a fixture: `conformance/dialect/patterns.json` carries Go's output for
 * every rule's rejected construct and its sanctioned rewrite, and
 * `dialect.test.ts` compares them mechanically. Treat the codes as a wire
 * format: add codes, never rename them.
 *
 * # Why it is a hand-written scanner
 *
 * The validator has to track character-class state (so `[.]` and `\.` are not
 * mistaken for a bare `.`) and group nesting with each group's quantifier (so
 * "unbounded inside quantified" can be decided at all). A regex over a regex
 * cannot do either. After the structural checks pass, the pattern is
 * additionally handed to `new RegExp(toJS(p), flags + "u")`, so a shape the
 * scanner does not model still cannot load — the mirror of Go handing it to
 * regexp.Compile.
 *
 * Offsets are RUNE indices, matching Go, which is why the scanner works on a
 * code-point array rather than on the UTF-16 string.
 */

// ---------------------------------------------------------------------------
// Cost bounds. Counted in RUNES, not UTF-16 units, so the Arabic anchors this
// corpus needs get the same limit in both languages.
// ---------------------------------------------------------------------------

/** Bounds the pattern text itself. */
export const MAX_PATTERN_RUNES = 512;
/** Bounds the submatch vector. */
export const MAX_CAPTURE_GROUPS = 8;
/** Bounds the product of `{n,m}` upper bounds along any one nesting path. */
export const MAX_BOUND_PRODUCT = 64;
/**
 * Bounds how many unbounded quantifiers may appear in one alternation branch.
 *
 * This is the rule that exists for THIS engine and not for Go's. RE2 does not
 * backtrack, so it is immune; a backtracking engine is O(n^k) for k unbounded
 * quantifiers that can consume the same characters. Measured in Bun 1.3.14:
 * `[0-9]+[0-9]+z` is 86 ms on 800 characters and
 * `[0-9]+[0-9]+[0-9]+[0-9]+z` is 88,191 ms on 400 — on attacker-writable
 * inbound mail. Separating them with a mandatory literal does not help
 * (`[^\n]+X[^\n]+Y` is 31,680 ms on 8,000), which is why the rule counts rather
 * than looking for adjacency. Two adjacent ones always collapse:
 * `[0-9]+[0-9]+` is `[0-9]{2,}`.
 */
export const MAX_UNBOUNDED_PER_BRANCH = 1;
/**
 * Bounds the BACKTRACKING WIDTH of one alternation branch: the number of
 * distinct ways the bounded quantifiers and alternations along it can carve up
 * the same input.
 *
 * This is the bound `MAX_BOUND_PRODUCT` is not. That one multiplies quantifier
 * UPPER bounds and so bounds how LONG a match can be; this one multiplies the
 * SIZE OF EACH CHOICE — `(hi - lo + 1)` per repetition, the branch count per
 * alternation — and so bounds how many times the engine can re-split the same
 * characters. Two patterns can score identically on the first and differ by
 * four orders of magnitude on the second, which is exactly how a multi-second
 * pattern passed a gate calibrated on the first. Measured in Bun 1.3.14 with
 * `re.exec(subject)` — unanchored, `subject = "a".repeat(512)`, so every row
 * FAILS to match, which is the case a backtracking engine pays for. Every one
 * of these passed the dialect before this bound existed:
 *
 *     width      pattern                              time
 *          1     (?:[a-z]{8}){8}z                      0.0 ms
 *         64     [a-z]{1,64}z                          0.0 ms
 *        256     (?:[a-z]{1,4}){4}z                    0.5 ms
 *      1,024     (?:[a-z]{1,4}){5}z                    2.2 ms
 *      4,096     (?:[a-z]{1,4}){6}z                    8.4 ms
 *     16,384     (?:[a-z]{1,4}){7}z                   39.2 ms
 *     65,536     (?:[a-z]{1,4}){8}z                  148.6 ms
 * 16,777,216     (?:[a-z0-9 ]{1,8}){8}z             2,178 ms
 * 16,777,216     [a-z]{1,8} x8, CONCATENATED        7,140 ms
 * 4.3 x 10^9     (?:(?:[a-z]{1,4}){4}){4}z          1,948 ms
 *
 * Rows 1 and 8 have the SAME bound product of 64 — 0.0 ms and 2.2 seconds — so
 * no tightening of that number could ever separate them. The LAST TWO ROWS are
 * why this bound exists as well as `nested_variable_repetition`: eight sibling
 * repetitions nest nothing and quantify no group, so no nesting rule can see
 * them, and they are the same explosion — 7.1 seconds on a 512-character body,
 * from a pattern published to every device.
 *
 * 1,024 is 5.1x the widest pattern this corpus ships — the ENBD credit anchor
 * `(?P<ccy>[A-Z]{3} )?(?P<amt>[0-9][0-9,]{0,24}\.[0-9]{2})[ \n]has been[ \n]
 * (?:credited|deposited)[ \n](?:in)?to your account` is exactly 200: an
 * optional three-letter currency (2), a `{0,24}` digit run (25), a two-way
 * alternation (2) and an optional `in` (2) — and 16x below the smallest
 * measured blow-up. It is also, independently, the widest pair
 * `MAX_BOUND_PRODUCT` still lets you write instead of collapsing:
 * `{1,a}{1,b}` collapses to `{2,a+b}`, and `a + b <= 64` maximises `a * b`
 * at `32 * 32`.
 *
 * An UNBOUNDED quantifier contributes 1 here rather than infinity. It is not
 * unbounded work — it is quadratic work, and it is bounded by
 * `MAX_UNBOUNDED_PER_BRANCH` instead. Counting it as infinite would refuse
 * `الدفع الى\n(?P<v>[^\n]+)`, which is a shipping seed.
 *
 * What this bound does NOT do is make an accepted pattern free. The widest one
 * it permits, `[0-9]{1,32}[0-9]{1,32}z`, costs 1,858 ms against 2,000,000
 * digits — `MaxBodyBytes`. That is the residual, it is linear in the body
 * rather than quadratic, and it is ~1,000x cheaper than the residual the
 * dialect already accepts for ONE unbounded quantifier (`[0-9]+z`, 17,935 ms
 * on 200,000 digits). Both are recorded in the spec's residual section.
 */
export const MAX_REPETITION_WIDTH = 1024;

/**
 * Reason codes. Identical strings to Go's, compared mechanically through
 * `conformance/dialect/patterns.json`.
 */
export const Reason = {
  EmptyPattern: "empty_pattern",
  PatternTooLong: "pattern_too_long",
  TooManyCaptureGroups: "too_many_capture_groups",
  EscapePerlSpace: "escape_perl_space",
  EscapeWordBoundary: "escape_word_boundary",
  EscapeUnicodeClass: "escape_unicode_class",
  EscapeUnicodeCodepoint: "escape_unicode_codepoint",
  EscapeTextAnchor: "escape_text_anchor",
  EscapeBackreference: "escape_backreference",
  EscapeNotAllowed: "escape_not_allowed",
  MalformedEscape: "malformed_escape",
  InlineFlags: "inline_flags",
  Lookaround: "lookaround",
  NamedGroupJSSyntax: "named_group_js_syntax",
  UnsupportedGroup: "unsupported_group",
  InvalidGroupName: "invalid_group_name",
  DuplicateGroupName: "duplicate_group_name",
  UnbalancedParen: "unbalanced_paren",
  BareDot: "bare_dot",
  GroupUnboundedQuantifier: "group_unbounded_quantifier",
  UnboundedInsideQuantifiedGroup: "unbounded_inside_quantified_group",
  MultipleUnboundedQuantifiers: "multiple_unbounded_quantifiers",
  NestedVariableRepetition: "nested_variable_repetition",
  RepetitionWidthTooLarge: "repetition_width_too_large",
  BoundProductTooLarge: "bound_product_too_large",
  MalformedRepetition: "malformed_repetition",
  EmptyCharClass: "empty_character_class",
  UnterminatedCharClass: "unterminated_character_class",
  ClassLiteralBracket: "class_literal_bracket",
  FlagNotAllowed: "flag_not_allowed",
  DuplicateFlag: "duplicate_flag",
  NotCompilable: "not_compilable",
} as const;

export type ReasonCode = (typeof Reason)[keyof typeof Reason];

/**
 * Every single-character escape MEASURED to mean the same thing in Go's RE2 and
 * in JavaScript compiled with `u`. A WHITELIST, not a blacklist: an escape
 * nobody thought about (`\a` is BEL in Go and a SyntaxError here) must fail
 * closed rather than fall through.
 */
const ESCAPE_WHITELIST = "nrtfv" + "dDwW" + "\\.+*?()[]{}|^$/";

/**
 * Allowed inside a character class and nowhere else. Under `u`, JavaScript's
 * IdentityEscape outside a class is restricted to the SyntaxCharacters and "/",
 * so `\-` at top level is a SyntaxError here while Go accepts it.
 */
const ESCAPE_CLASS_ONLY = "-";

const GROUP_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The ONE expression a stored pattern may be compiled with.
 *
 * The trailing `u` is not optional and is the whole reason the two engines fold
 * case the same way: `/k/i` does not match U+212A while Go's `(?i)k` does, and
 * `/k/iu` does. It is also what turns most of the banned escapes into hard
 * SyntaxErrors — a second, free layer of enforcement.
 */
export function compile(p: string, flags: string[]): RegExp {
  return new RegExp(toJS(p), flags.join("") + "u");
}

/**
 * Rewrites a stored pattern into the text JavaScript must compile:
 * `(?P<name>...)` becomes `(?<name>...)`. Nothing else changes, which is the
 * point — the published text is what both engines run.
 *
 * It is a scanner rather than a string replace because `\(` followed by `?P<`
 * is an escaped parenthesis, an optional quantifier and three literal
 * characters; a replace-all would turn that into a named group and silently
 * change what this engine matches.
 */
export function toJS(p: string): string {
  const r = [...p];
  let out = "";
  let inClass = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (c === "\\") {
      out += c;
      if (i + 1 < r.length) {
        i++;
        out += r[i]!;
      }
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      out += c;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += c;
    } else if (c === "(" && i + 3 < r.length && r[i + 1] === "?" && r[i + 2] === "P" && r[i + 3] === "<") {
      out += "(?<";
      i += 3;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * The named capture groups of a stored pattern, in order of appearance — the
 * mirror of Go's `GroupNames`, which reads `regexp.SubexpNames()`.
 *
 * It scans rather than matching `/\(\?<(\w+)>/g` against the rewritten text,
 * because `a\(?<v>` is an escaped paren followed by an optional quantifier and
 * four literals, and a naive match would report a group that neither engine
 * sees.
 */
export function groupNames(p: string): string[] {
  const r = [...p];
  const out: string[] = [];
  let inClass = false;
  for (let i = 0; i < r.length; i++) {
    const c = r[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && r[i + 1] === "?" && r[i + 2] === "P" && r[i + 3] === "<") {
      let j = i + 4;
      let name = "";
      while (j < r.length && r[j] !== ">") name += r[j++];
      if (j < r.length) out.push(name);
      i = j;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the scanner
// ---------------------------------------------------------------------------

/**
 * One group's accumulated state. All three fields propagate to the parent when
 * the group closes, which is what lets the three nesting rules be decided in a
 * single left-to-right pass.
 */
interface Frame {
  /** A `*`, `+` or `{n,}` appears somewhere inside, at any depth. Quantifying such a group is the `(a+)+` shape. */
  hasUnbounded: boolean;
  /** The largest product of `{n,m}` upper bounds along any path inside. A group's own quantifier multiplies it on the way out. */
  best: number;
  /** Unbounded quantifiers in the branch currently being scanned, including those contributed by closed child groups. */
  branchUnbounded: number;
  /** The largest `branchUnbounded` of any branch already ended at a `|`. */
  maxUnbounded: number;

  // The length and width accumulators below are what the two cost rules added
  // for the ReDoS hole read. They are kept per BRANCH and folded at every `|`,
  // for the same reason `branchUnbounded` is: a backtracking engine explores
  // one branch at a time, so `a|bcd` is two alternatives rather than a
  // four-rune atom.

  /** Match length in runes of the branch being scanned, saturating at {@link LEN_CAP}. */
  branchMin: number;
  branchMax: number;
  /** Folded across branches already ended at a `|`: the shortest and longest this group can match. */
  min: number;
  max: number;
  /** True once a branch has been folded, so `min` is a measurement rather than its initial value. */
  folded: boolean;
  /** The backtracking width of the branch being scanned: the product of every choice along it. */
  branchWidth: number;
  /** The SUM of the widths of the branches already ended at a `|` — alternatives add, they do not multiply. */
  width: number;
}

/**
 * The number of unbounded quantifiers in this group's most expensive branch.
 * Branches are independent — a backtracking engine explores one at a time — so
 * `a+|b+` costs what `a+` costs and counts as one, not two.
 */
function worstBranch(f: Frame): number {
  return Math.max(f.branchUnbounded, f.maxUnbounded);
}

/** Closes the branch at a `|` (or at the group's end), folding it into the frame's totals. */
function endBranch(f: Frame): void {
  f.maxUnbounded = worstBranch(f);
  f.branchUnbounded = 0;
  f.min = f.folded ? Math.min(f.min, f.branchMin) : f.branchMin;
  f.max = Math.max(f.max, f.branchMax);
  f.folded = true;
  f.width = satAdd(f.width, f.branchWidth);
  f.branchMin = 0;
  f.branchMax = 0;
  f.branchWidth = 1;
}

function newFrame(): Frame {
  return {
    hasUnbounded: false,
    best: 1,
    branchUnbounded: 0,
    maxUnbounded: 0,
    branchMin: 0,
    branchMax: 0,
    min: 0,
    max: 0,
    folded: false,
    branchWidth: 1,
    width: 0,
  };
}

/** A group whose contents can match more than one LENGTH is what makes repeating it explosive. */
function isVariable(f: Frame): boolean {
  return f.min !== f.max;
}

interface Quant {
  present: boolean;
  unbounded: boolean;
  min: number;
  max: number;
}

const NO_QUANT: Quant = { present: false, unbounded: false, min: 1, max: 1 };

class Scanner {
  readonly src: string[];
  readonly codes: string[] = [];
  private stack: Frame[] = [];
  private captures = 0;
  private names = new Set<string>();
  /** Each code is reported at most once per offset, so a 500-rune pattern with a systematic mistake yields a readable result rather than a wall. */
  private reported = new Set<string>();

  constructor(p: string) {
    this.src = [...p];
  }

  add(offset: number, code: string): void {
    const key = `${code}@${offset}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.codes.push(code);
  }

  /** Reports a code at most once per pattern, for the bounds that describe the whole pattern rather than a position in it. */
  addOnce(code: string): void {
    if (this.reported.has(`once:${code}`)) return;
    this.reported.add(`once:${code}`);
    this.codes.push(code);
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1]!;
  }

  checkFlags(flags: string[]): void {
    const seen = new Set<string>();
    for (const [i, f] of flags.entries()) {
      if (f !== "i") this.add(i, Reason.FlagNotAllowed);
      else if (seen.has(f)) this.add(i, Reason.DuplicateFlag);
      seen.add(f);
    }
  }

  scan(): void {
    if (this.src.length === 0) {
      this.add(0, Reason.EmptyPattern);
      return;
    }
    if (this.src.length > MAX_PATTERN_RUNES) {
      this.add(MAX_PATTERN_RUNES, Reason.PatternTooLong);
      return;
    }

    this.stack = [newFrame()];
    let i = 0;
    while (i < this.src.length) {
      const c = this.src[i]!;
      if (c === "\\") {
        i = this.quantify(this.escape(i, false), "simple", null);
      } else if (c === "[") {
        i = this.quantify(this.charClass(i), "simple", null);
      } else if (c === "(") {
        i = this.openGroup(i);
      } else if (c === ")") {
        if (this.stack.length === 1) {
          this.add(i, Reason.UnbalancedParen);
          i++;
          continue;
        }
        const child = this.stack.pop()!;
        endBranch(child);
        i = this.quantify(i + 1, "group", child);
      } else if (c === ".") {
        this.add(i, Reason.BareDot);
        i = this.quantify(i + 1, "simple", null);
      } else if (c === "*" || c === "+" || c === "?") {
        // Quantifiers are always consumed together with the atom they apply to,
        // so reaching one here means it applies to nothing (or to another
        // quantifier, i.e. a possessive form).
        this.add(i, Reason.MalformedRepetition);
        i++;
      } else if (c === "{") {
        this.add(i, Reason.MalformedRepetition);
        i++;
      } else if (c === "|") {
        endBranch(this.top());
        i++;
      } else if (c === "^" || c === "$") {
        i++;
      } else {
        i = this.quantify(i + 1, "simple", null);
      }
    }

    if (this.stack.length > 1) this.add(this.src.length, Reason.UnbalancedParen);
    const root = this.stack[0]!;
    endBranch(root);
    if (root.best > MAX_BOUND_PRODUCT) this.addOnce(Reason.BoundProductTooLarge);
    if (root.width > MAX_REPETITION_WIDTH) this.addOnce(Reason.RepetitionWidthTooLarge);
  }

  /**
   * Reads the quantifier (if any) at `next`, applies the three nesting rules,
   * folds the atom's cost into the enclosing frame, and returns the index just
   * past the quantifier.
   */
  private quantify(next: number, kind: "simple" | "group", child: Frame | null): number {
    const [q, after] = this.readQuant(next);
    const cur = this.top();

    const childBest = child ? child.best : 1;
    const childUnbounded = child ? child.hasUnbounded : false;

    if (q.present && kind === "group") {
      if (q.unbounded) this.add(next, Reason.GroupUnboundedQuantifier);
      else if (childUnbounded) this.add(next, Reason.UnboundedInsideQuantifiedGroup);
    }

    // The bounded analogue of `unbounded_inside_quantified_group`. A group that
    // can repeat MORE THAN ONCE re-splits its own contents on every repeat, so a
    // variable-length interior is raised to the power of the repeat count. `?`
    // and `{0,1}` are exempt because one repetition multiplies nothing — and
    // that exemption is load-bearing rather than a nicety: `([0-9]{1,4})?` is
    // this dialect's own sanctioned rewrite for `([0-9]+)?`, and a rule that
    // refused it would make the ban above inexpressible.
    if (child !== null && q.present && !q.unbounded && q.max >= 2 && isVariable(child)) {
      this.add(next, Reason.NestedVariableRepetition);
    }

    if (q.present && q.unbounded) cur.hasUnbounded = true;
    if (childUnbounded) cur.hasUnbounded = true;

    // The polynomial-backtracking bound. The atom contributes its own unbounded
    // quantifier plus, for a group, that group's most expensive branch — so
    // `(a+|b+)c+` counts two and `(a+|b+)c` counts one.
    let added = 0;
    if (q.present && q.unbounded) added++;
    if (child) added += worstBranch(child);
    if (added > 0) {
      cur.branchUnbounded += added;
      if (cur.branchUnbounded > MAX_UNBOUNDED_PER_BRANCH) {
        this.addOnce(Reason.MultipleUnboundedQuantifiers);
      }
    }

    let prod = childBest;
    if (q.present && !q.unbounded) prod = mulCapped(childBest, q.max);
    if (prod > cur.best) cur.best = prod;

    // Length and width. A simple atom is one rune wide and offers one choice;
    // a group carries whatever its own branches folded to.
    const atomMin = child ? child.min : 1;
    const atomMax = child ? child.max : 1;
    const atomWidth = child ? child.width : 1;

    let addMin = atomMin;
    let addMax = atomMax;
    let addWidth = atomWidth;
    if (q.present) {
      if (q.unbounded) {
        // Quadratic, not exponential, and already counted by
        // MAX_UNBOUNDED_PER_BRANCH. Its LENGTH is still unbounded, which is what
        // makes an enclosing group variable.
        addMin = satMul(q.min, atomMin);
        addMax = LEN_CAP;
      } else {
        addMin = satMul(q.min, atomMin);
        addMax = satMul(q.max, atomMax);
        // Repeating the atom `q.max` times re-splits its interior that many
        // times, and the repetition count is itself a choice.
        addWidth = satMul(satPow(atomWidth, q.max), q.max - q.min + 1);
      }
    }
    cur.branchMin = satAdd(cur.branchMin, addMin);
    cur.branchMax = satAdd(cur.branchMax, addMax);
    cur.branchWidth = satMul(cur.branchWidth, addWidth);
    return after;
  }

  /** Reads a quantifier at `i`, including its optional non-greedy `?` suffix. */
  private readQuant(i: number): [Quant, number] {
    if (i >= this.src.length) return [NO_QUANT, i];
    switch (this.src[i]) {
      case "*":
        return [{ present: true, unbounded: true, min: 0, max: 0 }, this.skipLazy(i + 1)];
      case "+":
        return [{ present: true, unbounded: true, min: 1, max: 0 }, this.skipLazy(i + 1)];
      case "?":
        return [{ present: true, unbounded: false, min: 0, max: 1 }, this.skipLazy(i + 1)];
      case "{":
        return this.readBraceQuant(i);
      default:
        return [NO_QUANT, i];
    }
  }

  private skipLazy(i: number): number {
    return i < this.src.length && this.src[i] === "?" ? i + 1 : i;
  }

  /**
   * Parses `{n}`, `{n,}` and `{n,m}`. Anything else is rejected: Go reads
   * `a{,3}` as five literal characters while JavaScript under `u` makes it a
   * SyntaxError, so the two engines do not agree on what it is.
   */
  private readBraceQuant(i: number): [Quant, number] {
    let j = i + 1;
    const start = j;
    while (j < this.src.length && isDigit(this.src[j]!)) j++;
    if (j === start) {
      this.add(i, Reason.MalformedRepetition);
      return [NO_QUANT, i + 1];
    }
    const lo = Number(this.src.slice(start, j).join(""));
    if (j < this.src.length && this.src[j] === "}") {
      return [{ present: true, unbounded: false, min: lo, max: lo }, this.skipLazy(j + 1)];
    }
    if (j >= this.src.length || this.src[j] !== ",") {
      this.add(i, Reason.MalformedRepetition);
      return [NO_QUANT, i + 1];
    }
    j++; // past ','
    const hiStart = j;
    while (j < this.src.length && isDigit(this.src[j]!)) j++;
    if (j >= this.src.length || this.src[j] !== "}") {
      this.add(i, Reason.MalformedRepetition);
      return [NO_QUANT, i + 1];
    }
    if (hiStart === j) return [{ present: true, unbounded: true, min: lo, max: 0 }, this.skipLazy(j + 1)]; // {n,}
    const hi = Number(this.src.slice(hiStart, j).join(""));
    if (hi < lo) {
      this.add(i, Reason.MalformedRepetition);
      return [NO_QUANT, this.skipLazy(j + 1)];
    }
    return [{ present: true, unbounded: false, min: lo, max: hi }, this.skipLazy(j + 1)];
  }

  /** Validates the escape starting at `i` (which points at the backslash). */
  private escape(i: number, inClass: boolean): number {
    if (i + 1 >= this.src.length) {
      this.add(i, Reason.MalformedEscape);
      return i + 1;
    }
    const c = this.src[i + 1]!;
    if (c === "s" || c === "S") {
      this.add(i, Reason.EscapePerlSpace);
    } else if (c === "b" || c === "B") {
      this.add(i, Reason.EscapeWordBoundary);
    } else if (c === "p" || c === "P") {
      this.add(i, Reason.EscapeUnicodeClass);
    } else if (c === "u") {
      this.add(i, Reason.EscapeUnicodeCodepoint);
    } else if (c === "x") {
      return this.hexEscape(i);
    } else if (c === "A" || c === "z" || c === "Z") {
      this.add(i, Reason.EscapeTextAnchor);
    } else if (c >= "0" && c <= "9") {
      this.add(i, Reason.EscapeBackreference);
    } else if (c === "k") {
      this.add(i, Reason.EscapeBackreference);
    } else if (ESCAPE_WHITELIST.includes(c)) {
      // measured identical in both engines
    } else if (inClass && ESCAPE_CLASS_ONLY.includes(c)) {
      // `\-` is a valid ClassEscape in JavaScript and only inside a class
    } else {
      this.add(i, Reason.EscapeNotAllowed);
    }
    return i + 2;
  }

  /** `\xHH` is one code point in both engines; `\x{...}` is a SyntaxError here. */
  private hexEscape(i: number): number {
    if (i + 2 < this.src.length && this.src[i + 2] === "{") {
      this.add(i, Reason.EscapeUnicodeCodepoint);
      for (let j = i + 2; j < this.src.length; j++) {
        if (this.src[j] === "}") return j + 1;
      }
      return this.src.length;
    }
    if (i + 3 >= this.src.length || !isHex(this.src[i + 2]!) || !isHex(this.src[i + 3]!)) {
      this.add(i, Reason.MalformedEscape);
      return i + 2;
    }
    return i + 4;
  }

  /** Validates the character class starting at `i` (which points at `[`). */
  private charClass(i: number): number {
    let j = i + 1;
    if (j < this.src.length && this.src[j] === "^") j++;
    if (j < this.src.length && this.src[j] === "]") {
      // Go rejects `[]` outright; JavaScript under `u` reads it as a class that
      // never matches. Neither is what an author meant.
      this.add(i, Reason.EmptyCharClass);
      return j + 1;
    }
    while (j < this.src.length) {
      const c = this.src[j]!;
      if (c === "\\") {
        j = this.escape(j, true);
      } else if (c === "[") {
        this.add(j, Reason.ClassLiteralBracket);
        j++;
      } else if (c === "]") {
        return j + 1;
      } else {
        j++;
      }
    }
    this.add(i, Reason.UnterminatedCharClass);
    return this.src.length;
  }

  /** Validates a group opener at `i`, pushes its frame, and returns the index just past the opener. */
  private openGroup(i: number): number {
    const push = (next: number): number => {
      this.stack.push(newFrame());
      return next;
    };
    const capture = (): void => {
      this.captures++;
      if (this.captures > MAX_CAPTURE_GROUPS) this.addOnce(Reason.TooManyCaptureGroups);
    };

    if (i + 1 >= this.src.length || this.src[i + 1] !== "?") {
      capture();
      return push(i + 1);
    }
    if (i + 2 >= this.src.length) {
      this.add(i, Reason.UnsupportedGroup);
      return push(i + 2);
    }

    switch (this.src[i + 2]) {
      case ":":
        return push(i + 3);
      case "=":
      case "!":
        this.add(i, Reason.Lookaround);
        return push(i + 3);
      case "<":
        if (i + 3 < this.src.length && (this.src[i + 3] === "=" || this.src[i + 3] === "!")) {
          this.add(i, Reason.Lookaround);
          return push(i + 4);
        }
        this.add(i, Reason.NamedGroupJSSyntax);
        return push(i + 3);
      case "P":
        if (i + 3 < this.src.length && this.src[i + 3] === "<") {
          capture();
          return push(this.groupName(i + 4));
        }
        this.add(i, Reason.UnsupportedGroup);
        return push(i + 3);
      case "#":
        this.add(i, Reason.UnsupportedGroup);
        return push(i + 3);
      default:
        this.add(i, Reason.InlineFlags);
        return push(i + 3);
    }
  }

  /** Validates the name starting at `i` (just past `(?P<`). */
  private groupName(i: number): number {
    let j = i;
    while (j < this.src.length && this.src[j] !== ">") j++;
    if (j >= this.src.length) {
      this.add(i, Reason.InvalidGroupName);
      return this.src.length;
    }
    const name = this.src.slice(i, j).join("");
    if (!GROUP_NAME_RE.test(name)) this.add(i, Reason.InvalidGroupName);
    if (this.names.has(name)) this.add(i, Reason.DuplicateGroupName);
    this.names.add(name);
    return j + 1;
  }
}

/**
 * Saturation caps for the length and width accumulators.
 *
 * Both are reported as a single yes/no, so the only thing an exact value would
 * buy over "past the cap" is an overflow: `a{99999}` nested ten deep is
 * 10^49 and `(?:(?:a{1,9}){9}){9}` is 9^81. `Number` would go to Infinity
 * rather than wrap, but Go's int WOULD wrap, and a wrapped product that lands
 * back under the limit is an accepted pattern. Saturating in both languages is
 * what keeps them the same function.
 */
const LEN_CAP = 1 << 30;
const WIDTH_CAP = MAX_REPETITION_WIDTH + 1;

function satAdd(a: number, b: number): number {
  const s = a + b;
  return s > LEN_CAP ? LEN_CAP : s;
}

function satMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  if (a > LEN_CAP / b) return LEN_CAP;
  return a * b;
}

/** `a^n`, saturating at {@link WIDTH_CAP}. `n` is a repeat count, so `a^0` is 1. */
function satPow(a: number, n: number): number {
  if (a <= 1) return a === 0 ? 0 : 1; // `a{99999}` on a fixed-width atom must not loop 99,999 times
  let out = 1;
  for (let k = 0; k < n; k++) {
    if (out > WIDTH_CAP / a) return WIDTH_CAP;
    out *= a;
    if (out > WIDTH_CAP) return WIDTH_CAP;
  }
  return out;
}

/** Keeps the running product from overflowing on a pattern that is rejected anyway (`a{99999}` nested ten deep). */
function mulCapped(a: number, b: number): number {
  if (a > MAX_BOUND_PRODUCT || b > MAX_BOUND_PRODUCT) return MAX_BOUND_PRODUCT + 1;
  const p = a * b;
  return p > MAX_BOUND_PRODUCT ? MAX_BOUND_PRODUCT + 1 : p;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

/**
 * Reports every way `p` (compiled with `flags`) violates the dialect, as reason
 * codes in scan order. An empty result means the pattern is safe to run here:
 * both engines were measured to agree on every construct it contains, and its
 * match cost is bounded.
 */
export function validatePattern(p: string, flags: string[]): string[] {
  const v = new Scanner(p);
  v.checkFlags(flags);
  v.scan();
  if (v.codes.length === 0) {
    // The scanner models the dialect, not the whole grammar. This engine's own
    // parser is the backstop for everything it does not model, such as a
    // reversed character-class range — the mirror of Go handing the pattern to
    // regexp.Compile.
    try {
      compile(p, flags);
    } catch {
      v.addOnce(Reason.NotCompilable);
    }
  }
  return v.codes;
}
