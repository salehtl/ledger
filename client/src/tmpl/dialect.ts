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
}

/**
 * The number of unbounded quantifiers in this group's most expensive branch.
 * Branches are independent — a backtracking engine explores one at a time — so
 * `a+|b+` costs what `a+` costs and counts as one, not two.
 */
function worstBranch(f: Frame): number {
  return Math.max(f.branchUnbounded, f.maxUnbounded);
}

interface Quant {
  present: boolean;
  unbounded: boolean;
  max: number;
}

const NO_QUANT: Quant = { present: false, unbounded: false, max: 0 };

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

    this.stack = [{ hasUnbounded: false, best: 1, branchUnbounded: 0, maxUnbounded: 0 }];
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
        const cur = this.top();
        cur.maxUnbounded = worstBranch(cur);
        cur.branchUnbounded = 0;
        i++;
      } else if (c === "^" || c === "$") {
        i++;
      } else {
        i = this.quantify(i + 1, "simple", null);
      }
    }

    if (this.stack.length > 1) this.add(this.src.length, Reason.UnbalancedParen);
    if (this.stack[0]!.best > MAX_BOUND_PRODUCT) this.addOnce(Reason.BoundProductTooLarge);
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
    return after;
  }

  /** Reads a quantifier at `i`, including its optional non-greedy `?` suffix. */
  private readQuant(i: number): [Quant, number] {
    if (i >= this.src.length) return [NO_QUANT, i];
    switch (this.src[i]) {
      case "*":
      case "+":
        return [{ present: true, unbounded: true, max: 0 }, this.skipLazy(i + 1)];
      case "?":
        return [{ present: true, unbounded: false, max: 1 }, this.skipLazy(i + 1)];
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
      return [{ present: true, unbounded: false, max: lo }, this.skipLazy(j + 1)];
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
    if (hiStart === j) return [{ present: true, unbounded: true, max: 0 }, this.skipLazy(j + 1)]; // {n,}
    const hi = Number(this.src.slice(hiStart, j).join(""));
    if (hi < lo) {
      this.add(i, Reason.MalformedRepetition);
      return [NO_QUANT, this.skipLazy(j + 1)];
    }
    return [{ present: true, unbounded: false, max: hi }, this.skipLazy(j + 1)];
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
      this.stack.push({ hasUnbounded: false, best: 1, branchUnbounded: 0, maxUnbounded: 0 });
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
