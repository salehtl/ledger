/**
 * Canonicalization for categorization — the device half of
 * `internal/v2/dict.Canonicalize`.
 *
 * # Why this is not `s.trim().toLowerCase().replace(/\s+/g, " ")`
 *
 * The server canonicalizes every dictionary pattern with Go's
 * `strings.ToLower(strings.Join(strings.Fields(s), " "))` and then ships the
 * result to every device. This file has to produce the SAME bytes from the same
 * input, because a pattern the server stored one way and a merchant this device
 * folds another way do not match, and nothing anywhere reports that they should
 * have. The obvious one-liner disagrees with Go on three inputs that occur in
 * real bank mail:
 *
 *   - **U+0085 (NEL)** is whitespace to Go's `unicode.IsSpace` and is NOT in
 *     JavaScript's `\s`. A merchant containing one would keep it here and lose
 *     it there.
 *   - **U+FEFF (BOM/ZWNBSP)** is the mirror image: `\s` matches it, Go's
 *     `IsSpace` does not. A BOM pasted into a pattern survives on the server and
 *     would vanish here.
 *   - **U+0130 (İ)** lower-cases to TWO code points in JavaScript (`i` +
 *     U+0307) and to one (`i`) in Go, because `String.prototype.toLowerCase`
 *     implements Unicode's full case mapping and `strings.ToLower` implements
 *     the simple one. Same family: `Σ` at the end of a word becomes `ς` under
 *     JavaScript's Final_Sigma rule and `σ` in Go.
 *
 * So the whitespace set is written out as Go's, and case folding runs one code
 * point at a time — which is what removes the Final_Sigma context — with the
 * single expanding mapping collapsed back to its first code point.
 * `conformance/dict/matching.json` carries Go's own output for every one of
 * these and `conformance.test.ts` compares them, so this is a measured claim
 * rather than a careful reading of two standards.
 *
 * # What canonicalization is NOT allowed to become
 *
 * **Case and whitespace only.** Fullwidth `ＣＡＲＲＥＦＯＵＲ`, a Cyrillic-С
 * homoglyph and `carrefour.` are three different strings and stay three
 * different strings. That is deliberate on the server (spec §3.6: the k
 * threshold splits rather than merges, so nothing publishes that otherwise
 * would not) and it has to stay deliberate here, because an NFKC fold added on
 * ONE side is not a normalization, it is a divergence. If it ever arrives it
 * arrives in both languages, in one commit, with the conformance fixture
 * regenerated.
 *
 * # Host imports
 *
 * None. This module is reachable from Hermes and pulls in no Bun API.
 */

/**
 * Go's `unicode.IsSpace`, as a set rather than as a regex.
 *
 * The Latin-1 half is `unicode.IsSpace`'s own fast path verbatim; the rest is
 * `unicode.White_Space` minus Latin-1. Pinned by `conformance.test.ts` against
 * Go's verdict for every code point in the fixture's probe set — including the
 * two JavaScript disagrees about.
 */
const SPACE: ReadonlySet<number> = new Set<number>([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Whether `cp` is whitespace to Go. */
export function isGoSpace(cp: number): boolean {
  return SPACE.has(cp);
}

/**
 * One code point, lower-cased the way Go's `strings.ToLower` lower-cases it.
 *
 * Called per code point on purpose: JavaScript's full case mapping is
 * context-sensitive (`ΟΔΟΣ` → `οδος`, `ΣΟ` → `σο`) and Go's is not, so folding
 * the string as a whole would diverge on any word ending in a sigma. A single
 * code point has no context, so the two agree — except for the one mapping that
 * expands, which is collapsed here.
 */
function lowerCodePoint(cp: number): string {
  // ASCII, which is every character in almost every merchant string, without
  // allocating or consulting a Unicode table.
  if (cp < 0x80) {
    return String.fromCharCode(cp >= 0x41 && cp <= 0x5a ? cp + 0x20 : cp);
  }
  const lower = String.fromCodePoint(cp).toLowerCase();
  const cps = [...lower];
  if (cps.length === 1) return lower;
  // The full case mapping expanded one code point into several — U+0130 is the
  // only unconditional case of it in Unicode, and Go maps it to the first of
  // them. Taking the first code point is the general form of that rule rather
  // than a special case for one character, so a future addition to
  // SpecialCasing.txt fails toward Go's shape instead of silently diverging.
  return cps[0]!;
}

/**
 * `strings.ToLower`, code point by code point.
 *
 * Exported for the conformance test, which compares it against Go's output for
 * a probe set; production callers want {@link canonical}.
 */
export function foldCase(s: string): string {
  // Fast path: an all-ASCII string cannot contain any of the divergences above.
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return s.toLowerCase();
  let out = "";
  for (const ch of s) out += lowerCodePoint(ch.codePointAt(0)!);
  return out;
}

/**
 * The storable, matchable form of a merchant string or a pattern: lower-cased,
 * trimmed, and every run of Go-whitespace collapsed to one space.
 *
 * Byte-identical to `dict.Canonicalize`'s `collapse` for every input in the
 * conformance fixture. Both the pattern and the subject go through it, so a
 * pattern that was canonicalized on the server matches a merchant that was
 * canonicalized here.
 */
export function canonical(s: string): string {
  const words: string[] = [];
  let word = "";
  for (const ch of s) {
    if (isGoSpace(ch.codePointAt(0)!)) {
      if (word !== "") {
        words.push(word);
        word = "";
      }
      continue;
    }
    word += ch;
  }
  if (word !== "") words.push(word);
  return foldCase(words.join(" "));
}

/** Length in code points — never `String.length`, which counts UTF-16 units. */
export function runeLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * Truncates `s` to at most `n` code points, never splitting a surrogate pair.
 *
 * Used to bound what a regex rule is ever run against; see
 * {@link MAX_SUBJECT_RUNES} in `rules.ts` for why that bound is the load-bearing
 * part of the cost argument on an engine nobody has measured.
 */
export function truncateRunes(s: string, n: number): string {
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i >= n) break;
    out += ch;
    i++;
  }
  return out;
}
