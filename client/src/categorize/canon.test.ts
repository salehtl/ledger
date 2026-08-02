import { expect, test } from "bun:test";

import { canonical, foldCase, isGoSpace, runeLength, truncateRunes } from "./canon";

// ---------------------------------------------------------------------------
// The three places JavaScript's obvious one-liner disagrees with Go.
//
// Every test here is written so it FAILS against
// `s.trim().toLowerCase().replace(/\s+/g, " ")`. That is the point: a
// canonicalizer test that only checks "CARREFOUR" -> "carrefour" passes against
// any implementation anybody would write, including the wrong one.
//
// Every non-ASCII character below is written as an ESCAPE, never as a literal.
// A literal U+0085 is invisible in a diff, survives no round trip through a
// tool that normalizes whitespace, and - measured while writing this file -
// silently became an ordinary space, which made the test assert nothing at all.
// ---------------------------------------------------------------------------

const NEL = "\u0085"; // NEXT LINE: whitespace to Go, not in JavaScript's \s
const BOM = "\ufeff"; // ZWNBSP: in JavaScript's \s, not whitespace to Go
const NBSP = "\u00a0";

test("U+0085 is whitespace to Go, so it collapses like a space", () => {
  // `.replace(/\s+/g, " ")` leaves this one alone: JavaScript's \s does not
  // include U+0085. The server would have stored "carrefour hyper".
  expect(canonical(`carrefour${NEL}hyper`)).toBe("carrefour hyper");
  expect(isGoSpace(0x85)).toBe(true);
});

test("U+FEFF is NOT whitespace to Go, so it survives canonicalization", () => {
  // The mirror image: `.replace(/\s+/g, " ")` would collapse this and the
  // server, which kept it, would never match the device again.
  expect(canonical(`carrefour${BOM}hyper`)).toBe(`carrefour${BOM}hyper`);
  expect(isGoSpace(0xfeff)).toBe(false);
});

test("U+00A0 is whitespace to Go, and to JavaScript", () => {
  expect(canonical(`carrefour${NBSP}${NBSP}hyper`)).toBe("carrefour hyper");
  expect(isGoSpace(0xa0)).toBe(true);
});

test("U+0130 lower-cases to one code point, as Go does, not two as JavaScript does", () => {
  expect(foldCase("\u0130")).toBe("i");
  // The divergence this exists to prevent, stated as an assertion so a future
  // engine that "fixes" it becomes visible rather than silent.
  expect("\u0130".toLowerCase()).toBe("i\u0307");
  expect(foldCase("\u0130")).not.toBe("\u0130".toLowerCase());
});

test("a final sigma folds to sigma, as Go does, not to final-sigma as JavaScript does", () => {
  // Go's strings.ToLower has no context: every capital sigma becomes U+03C3.
  // JavaScript applies Unicode's Final_Sigma condition and produces U+03C2 at
  // the end of a word, so a merchant ending in a sigma would canonicalize
  // differently on the server and on the device.
  const odos = "\u039f\u0394\u039f\u03a3";
  expect(foldCase(odos)).toBe("\u03bf\u03b4\u03bf\u03c3");
  expect(odos.toLowerCase()).toBe("\u03bf\u03b4\u03bf\u03c2");
  expect(foldCase(odos)).not.toBe(odos.toLowerCase());
});

test("the Kelvin sign folds to k, which Go and this engine agree on", () => {
  expect(foldCase("\u212a")).toBe("k");
});

// ---------------------------------------------------------------------------
// Case and whitespace ONLY. The homoglyph split is deliberate.
// ---------------------------------------------------------------------------

test("canonicalization collapses runs of whitespace and trims", () => {
  expect(canonical("  CARREFOUR   Hyper\tMarket \n")).toBe("carrefour hyper market");
});

test("fullwidth, Cyrillic and dotted forms stay four different strings", () => {
  const latin = canonical("CARREFOUR");
  const fullwidth = canonical("\uff23\uff21\uff32\uff32\uff25\uff26\uff2f\uff35\uff32");
  const cyrillic = canonical("\u0421ARREFOUR"); // Cyrillic ES + Latin
  const dotted = canonical("carrefour.");
  expect(latin).toBe("carrefour");
  expect(new Set([latin, fullwidth, cyrillic, dotted]).size).toBe(4);
  // Fail-safe, and short of a normalization rather than absent: each one still
  // folds case within its own alphabet.
  expect(fullwidth).toBe("\uff43\uff41\uff52\uff52\uff45\uff46\uff4f\uff55\uff52");
  expect(cyrillic).toBe("\u0441arrefour");
});

test("an empty or whitespace-only string canonicalizes to the empty string", () => {
  expect(canonical(` \t\n${NEL}${NBSP}  `)).toBe("");
});

// ---------------------------------------------------------------------------
// Runes, not UTF-16 units.
// ---------------------------------------------------------------------------

test("runeLength counts code points, which String.length gets wrong", () => {
  const astral = "\u{1d400}\u{1d401}\u{1d402}"; // three code points, six UTF-16 units
  expect(runeLength(astral)).toBe(3);
  expect(astral.length).toBe(6);
});

test("truncateRunes never splits a surrogate pair", () => {
  const astral = "\u{1d400}\u{1d401}\u{1d402}";
  const cut = truncateRunes(astral, 2);
  expect(runeLength(cut)).toBe(2);
  expect(cut).toBe("\u{1d400}\u{1d401}");
  // A naive slice(0, 2) would cut inside the first pair and produce a lone
  // surrogate, which then never equals anything.
  expect(cut).not.toBe(astral.slice(0, 2));
});

test("truncateRunes returns the whole string when it is shorter than the bound", () => {
  expect(truncateRunes("carrefour", 512)).toBe("carrefour");
});
