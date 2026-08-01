/**
 * Unit vectors for the TypeScript normalizer.
 *
 * The conformance runner (conformance.test.ts) proves this executor agrees with
 * the Go one over real bank mail. This file pins the clauses of the contract
 * that no end-to-end fixture can reach, and every test here earned its place:
 * each one corresponds to a mutation that survived BOTH the 7,002-message
 * corpus and the whole fixture set.
 *
 * The clearest example is the stage-3 BOM rule. "A leading BOM is not stripped"
 * is unobservable end to end, because stage 8's trim set removes U+FEFF
 * wherever it lands — so a normalizer that stripped it at stage 3 would pass
 * every fixture and the entire corpus. It is still wrong, and it would become
 * visible the day the trim set changes.
 */

import { describe, expect, test } from "bun:test";

import { decodeSingleByte, decodeUTF8WHATWG, classifyCharset, UnsupportedCharsetError } from "./charset.ts";
import {
  bareAddress,
  decodeBase64,
  decodeQuotedPrintable,
  decodeWords,
  LeafDecodeError,
  MimeParseError,
  parseMediaType,
  readHeader,
} from "./mime.ts";
import { normalize } from "./norm.ts";
import { parseForwardDate, trimExplicit, unwrapForward } from "./unwrap.ts";

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/**
 * TextDecoder with a runtime-supplied label.
 *
 * Bun's own type definitions restrict the argument to a union of the labels it
 * implements, and "windows-1256" is not in it — which is the same fact these
 * tests are about, showing up at the type level.
 */
const textDecoder = (label: string): TextDecoder =>
  new (TextDecoder as unknown as { new (l: string): TextDecoder })(label);

const cps = (s: string): string[] => [...s].map((c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"));

// ---------------------------------------------------------------------------
// Stage 3: the WHATWG UTF-8 decoder
// ---------------------------------------------------------------------------

describe("stage 3 — WHATWG UTF-8 substitution", () => {
  // The eight vectors the spec pins, byte for byte. One U+FFFD per MAXIMAL
  // SUBPART: deliberately not Go's strings.ToValidUTF8 (one per contiguous
  // invalid run) and not a DecodeRune loop (one per byte).
  const vectors: [string, Uint8Array, string[]][] = [
    ["truncated 3-byte", bytes(0x41, 0xe2, 0x82), ["U+0041", "U+FFFD"]],
    ["truncated 4-byte", bytes(0x41, 0xf0, 0x9f, 0x92), ["U+0041", "U+FFFD"]],
    ["truncated then ascii", bytes(0xe2, 0x82, 0x41, 0x42), ["U+FFFD", "U+0041", "U+0042"]],
    ["bare continuation", bytes(0x41, 0x80, 0x42), ["U+0041", "U+FFFD", "U+0042"]],
    ["overlong", bytes(0x41, 0xc0, 0x80, 0x42), ["U+0041", "U+FFFD", "U+FFFD", "U+0042"]],
    ["surrogate", bytes(0x41, 0xed, 0xa0, 0x80, 0x42), ["U+0041", "U+FFFD", "U+FFFD", "U+FFFD", "U+0042"]],
    ["out of range", bytes(0x41, 0xf5, 0x80, 0x80, 0x80, 0x42), ["U+0041", "U+FFFD", "U+FFFD", "U+FFFD", "U+FFFD", "U+0042"]],
  ];
  for (const [name, input, want] of vectors) {
    test(name, () => expect(cps(decodeUTF8WHATWG(input))).toEqual(want));
  }

  test("a leading BOM is passed through, never stripped", () => {
    // BOM removal belongs to the stage-8 trim set, which removes U+FEFF
    // WHEREVER it lands rather than only at the start. Stripping it here would
    // be invisible in every fixture and in all 7,002 corpus messages, because
    // stage 8 removes it either way — and would silently change behaviour the
    // moment the trim set is revised.
    expect(cps(decodeUTF8WHATWG(bytes(0xef, 0xbb, 0xbf, 0x41)))).toEqual(["U+FEFF", "U+0041"]);
  });
});

// ---------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------

describe("stage 2 — charset resolution", () => {
  test("windows-1256, the corpus's only legacy charset, decodes from the table", () => {
    const c = classifyCharset("windows-1256");
    expect(c.kind).toBe("single-byte");
    // The Arabic word the DIB notifications open with.
    expect(decodeSingleByte(c.table!, bytes(0xc7, 0xe1, 0xda, 0xd1, 0xc8, 0xed))).toBe("العربي");
  });

  test("Bun's TextDecoder cannot do this, which is why the tables exist", () => {
    // Not a hypothetical: this is the corpus's only non-UTF-8 charset, 110 of
    // 7,002 messages. Building the charset layer on TextDecoder would have
    // failed on real mail.
    expect(() => textDecoder("windows-1256")).toThrow();
  });

  test("iso-8859-1 is TRUE Latin-1 here and windows-1252 in TextDecoder", () => {
    // Go reaches iso-8859-1 through ianaindex, which gives real Latin-1; the
    // WHATWG table that TextDecoder implements maps the label to windows-1252.
    // 0x80 is the tell: U+0080 in Latin-1, U+20AC in windows-1252.
    const latin1 = classifyCharset("iso-8859-1");
    expect(decodeSingleByte(latin1.table!, bytes(0x80))).toBe("");
    expect(textDecoder("iso-8859-1").decode(bytes(0x80))).toBe("€");
  });

  test("the same encoding without the hyphen resolves differently", () => {
    // iso8859-1 misses ianaindex and falls through to the WHATWG table, so it
    // IS windows-1252. Reproducing Go's inconsistency is the job; fixing it
    // would be a divergence.
    expect(decodeSingleByte(classifyCharset("iso8859-1").table!, bytes(0x80))).toBe("€");
  });

  test("utf-8 and us-ascii are short-circuited, not decoded", () => {
    expect(classifyCharset("utf-8").kind).toBe("passthrough");
    expect(classifyCharset("US-ASCII").kind).toBe("passthrough");
  });

  test("an unresolvable label is 'unresolved', not silently utf-8", () => {
    // The two produce the same text, but only "unresolved" also carries the
    // error that aborts a sub-part walk. Defaulting to the quieter one would
    // disagree with Go on every message with an exotic charset in a sub-part.
    expect(classifyCharset("x-nope").kind).toBe("unresolved");
    expect(classifyCharset("never-heard-of-it").kind).toBe("unresolved");
  });

  test("a multi-byte charset throws rather than guessing", () => {
    expect(classifyCharset("utf-16").kind).toBe("unsupported");
    expect(classifyCharset("shift_jis").kind).toBe("unsupported");
    const raw = utf8("From: a@b.c\r\nContent-Type: text/plain; charset=utf-16\r\n\r\nhi\r\n");
    expect(() => normalize(1, raw, "2026-08-01T00:00:00Z")).toThrow(UnsupportedCharsetError);
  });
});

// ---------------------------------------------------------------------------
// Transfer encodings
// ---------------------------------------------------------------------------

describe("base64", () => {
  test("skips every ASCII whitespace byte, anywhere", () => {
    const want = "Hello world";
    for (const payload of ["SGVsbG8gd29ybGQ=", "SGVsbG8g d29ybGQ=", "SGVsbG8g\td29ybGQ=", "SGVsbG8g\r\n  d29ybGQ="]) {
      expect(new TextDecoder().decode(decodeBase64(utf8(payload)))).toBe(want);
    }
  });
  test("is otherwise strict: padding, alphabet, length, trailing data", () => {
    for (const bad of ["SGVsbG8gd29ybGQ", "SGVsbG8*d29ybGQ=", "SGVsbG8gd29ybG", "SGVsbG8=extra"]) {
      expect(() => decodeBase64(utf8(bad))).toThrow(LeafDecodeError);
    }
  });
});

describe("quoted-printable — Go's documented leniency", () => {
  const dec = (s: string): string => new TextDecoder().decode(decodeQuotedPrintable(utf8(s)));
  test("= CRLF and = LF are both soft breaks", () => {
    expect(dec("AAA=\r\nBBB")).toBe("AAABBB");
    expect(dec("AAA=\nBBB")).toBe("AAABBB");
  });
  test("= not followed by two hex digits is a literal =", () => {
    expect(dec("A=ZZB\r\n")).toBe("A=ZZB\r\n");
    expect(dec("x=4")).toBe("x=4");
  });
  test("a trailing = at end of input is dropped, but a bare = line is fatal", () => {
    expect(dec("AB=")).toBe("AB");
    expect(() => decodeQuotedPrintable(utf8("AB\r\n="))).toThrow(LeafDecodeError);
  });
  test("whitespace is stripped before a HARD break and kept before a SOFT one", () => {
    expect(dec("A  \r\nB")).toBe("A\r\nB");
    expect(dec("A  =\r\nB")).toBe("A  B");
    expect(dec("A=  \r\nB")).toBe("AB");
  });
  test("hex is case-insensitive and raw high bytes pass through", () => {
    expect(dec("x=c3=a9y")).toBe("xéy");
    expect(dec("x=C3=A9y")).toBe("xéy");
    expect(new TextDecoder().decode(decodeQuotedPrintable(bytes(0x78, 0xc3, 0xa9, 0x79)))).toBe("xéy");
  });
  test("an unescaped control byte or DEL discards the leaf", () => {
    expect(() => decodeQuotedPrintable(bytes(0x78, 0x01, 0x79))).toThrow(LeafDecodeError);
    expect(() => decodeQuotedPrintable(bytes(0x78, 0x7f, 0x79))).toThrow(LeafDecodeError);
  });
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe("headers", () => {
  test("a folded line joins with exactly one space", () => {
    const h = readHeader(utf8("Subject: One\r\n  Two\r\n\r\nbody"), 0);
    expect(h.fields).toEqual([{ key: "subject", value: "One Two" }]);
  });
  test("the first field of a name wins", () => {
    const h = readHeader(utf8("Subject: First\r\nSubject: Second\r\n\r\n"), 0);
    expect(h.fields[0]!.value).toBe("First");
  });
  test("a folded FIRST line, a colonless line and a bad key byte are all fatal", () => {
    expect(() => readHeader(utf8(" leading\r\nFrom: a@b.c\r\n\r\n"), 0)).toThrow(MimeParseError);
    expect(() => readHeader(utf8("From: a@b.c\r\nNOCOLON\r\n\r\n"), 0)).toThrow(MimeParseError);
    expect(() => readHeader(utf8("From: a@b.c\r\nBad Key: v\r\n\r\n"), 0)).toThrow(MimeParseError);
  });

  test("adjacent RFC 2047 words join with NO separator", () => {
    // The corpus's ENBD alert forward is exactly this shape. A space here
    // breaks the account last4 match.
    expect(decodeWords("=?utf-8?B?QUJD?= =?utf-8?B?REVG?=")).toBe("ABCDEF");
  });
  test("an undecodable word leaves the field at its raw value", () => {
    expect(decodeWords("=?x-nope?B?QUJD?=")).toBe("=?x-nope?B?QUJD?=");
    expect(decodeWords("=?utf-8?B?!!!?=")).toBe("=?utf-8?B?!!!?=");
  });
  test("the word decoder's iso-8859-1 is Latin-1 and its us-ascii is per-byte U+FFFD", () => {
    // Neither matches what the same label does at the BODY level, because Go's
    // mime.WordDecoder handles these three charsets itself.
    expect(decodeWords("=?iso-8859-1?Q?a=E9b?=")).toBe("aéb");
    expect(cps(decodeWords("=?us-ascii?B?YcO/Yg==?="))).toEqual(["U+0061", "U+FFFD", "U+FFFD", "U+0062"]);
  });

  test("From is reduced to the bare address, and junk is kept rather than dropped", () => {
    const b = (v: string) => bareAddress(v, trimExplicit);
    expect(b("Alice B <a@b.c>")).toBe("a@b.c");
    expect(b('"B, Alice" <a@b.c>')).toBe("a@b.c");
    expect(b("a@b.c, d@e.f")).toBe("a@b.c");
    expect(b("<a@b.c>")).toBe("a@b.c");
    expect(b("junk <a@b.c> junk")).toBe("a@b.c");
    expect(b("not an address")).toBe("not an address");
    expect(b("")).toBe("");
  });

  test("a trailing semicolon in Content-Type is tolerated", () => {
    // Three of the corpus's Apple-Mail forwards send `text/html; charset=utf-8;`.
    // Rejecting it made this executor choose the text/plain alternative where Go
    // chose the HTML one — the first real defect the conformance suite caught.
    expect(parseMediaType("text/html; charset=utf-8;")).toEqual({ type: "text/html", params: { charset: "utf-8" } });
  });
  test("a Content-Type Go rejects yields null, so the leaf is skipped", () => {
    expect(parseMediaType("text/html (html); charset=utf-8")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stage 8: the explicit trim set
// ---------------------------------------------------------------------------

describe("stage 8 — the explicit trim set", () => {
  test("trims exactly the eight named characters", () => {
    expect(trimExplicit("\u000a\u0009 \u00a0\ufeffX\ufeff\u00a0 \u000d")).toBe("X");
  });
  test("does NOT trim what Go's TrimSpace and JS's trim would", () => {
    // Both directions occur in the real corpus: a lone U+FEFF line that v1 keeps
    // and v2 drops (ids 2554, 6853, 6854), and U+200A lines that v1 drops and v2
    // keeps (id 6859).
    //
    // The three sets genuinely differ from each other, which is the whole reason
    // this contract names its own: U+0085 is trimmed by Go and not by JavaScript,
    // and the U+2000 block is trimmed by both. Neither is in the contract.
    for (const keep of ["\u0085", "\u200a", "\u202f", "\u2000", "\u205f"]) {
      expect(trimExplicit(keep + "X" + keep)).toBe(keep + "X" + keep);
    }
    // What String.prototype.trim would have done instead, spelled out so the
    // difference is a fact in the suite rather than a claim in a comment.
    expect(("\u200aX\u200a").trim()).toBe("X");
    expect(("\u202fX\u202f").trim()).toBe("X");
    expect(("\u0085X\u0085").trim()).toBe("\u0085X\u0085"); // JS leaves it; Go's TrimSpace does not
    expect(("\ufeffX\ufeff").trim()).toBe("X"); // and JS strips U+FEFF, which the contract also does
  });
});

// ---------------------------------------------------------------------------
// Stage 6: entity decoding
// ---------------------------------------------------------------------------

test("stage 6 — entities decode in ONE pass that never rescans", () => {
  // `&amp;lt;` must become `&lt;` and STOP. Six chained replaces produce `<`,
  // because the second pass sees the `&` the first one emitted. No corpus
  // message contains a nested entity, so only this test stands between the
  // contract and that bug.
  const raw = utf8("From: a@b.c\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>&amp;lt; &amp;amp; &copy;</p>\r\n");
  expect(normalize(1, raw, "2026-08-01T00:00:00Z").text).toBe("&lt; &amp; &copy;");
});

// ---------------------------------------------------------------------------
// Stage 10
// ---------------------------------------------------------------------------

describe("stage 10 — forward unwrapping", () => {
  test("a marker with no recoverable headers still sets forwarded", () => {
    const f = unwrapForward("outer@x.y", "Fwd: Subj", "Begin forwarded message:\n> From: inner@a.b\n> body");
    expect(f.found).toBe(true);
    expect(f.from).toBe("outer@x.y"); // ">" is not whitespace, so nothing matched
    expect(f.subject).toBe("Subj");
    expect(f.body).toBe("Begin forwarded message:\n> From: inner@a.b\n> body");
  });
  test("Gmail's same-line and Apple's next-line layouts both recover", () => {
    const gmail = unwrapForward("o@x.y", "Fwd: S", "---------- Forwarded message ---------\nFrom: i@a.b\nSubject: Inner\n\nBODY");
    expect(gmail.from).toBe("i@a.b");
    expect(gmail.subject).toBe("Inner");
    expect(gmail.body).toBe("BODY");
    const apple = unwrapForward("o@x.y", "Fwd: S", "Begin forwarded message:\nFrom:\ni@a.b\nSubject:\nInner\n\nBODY");
    expect(apple.from).toBe("i@a.b");
    expect(apple.subject).toBe("Inner");
    expect(apple.body).toBe("BODY");
  });
});

describe("forward dates — explicit layouts, never Date.parse", () => {
  const iso = (d: Date | null) => (d === null ? null : d.toISOString());
  test("the four closed layouts, read as naive UTC", () => {
    expect(iso(parseForwardDate("Jun 21, 2026 at 12:29 PM"))).toBe("2026-06-21T12:29:00.000Z");
    expect(iso(parseForwardDate("Sun, Jun 21, 2026 at 12:29 PM"))).toBe("2026-06-21T12:29:00.000Z");
    expect(iso(parseForwardDate("21 June 2026 at 16:11:02"))).toBe("2026-06-21T16:11:02.000Z");
    expect(iso(parseForwardDate("21 June 2026 at 16:11"))).toBe("2026-06-21T16:11:00.000Z");
  });
  test("a trailing zone token is dropped by the retry", () => {
    expect(iso(parseForwardDate("21 June 2026 at 16:11:02 GST"))).toBe("2026-06-21T16:11:02.000Z");
    expect(iso(parseForwardDate("Jun 21, 2026 at 12:29 PM GMT+4"))).toBe("2026-06-21T12:29:00.000Z");
  });
  test("U+202F before AM/PM is normalized, and AM/PM must be upper case", () => {
    expect(iso(parseForwardDate("Jun 21, 2026 at 12:29 PM"))).toBe("2026-06-21T12:29:00.000Z");
    expect(parseForwardDate("Jun 21, 2026 at 12:29 pm")).toBeNull();
  });
  test("K2 — the iOS 12-hour-WITH-seconds shape does not parse", () => {
    // Ported defect, not an oversight: three corpus messages date to their
    // arrival time because of it, v1 does the same, and adding the layout is a
    // version bump. Asserting the broken behaviour is what stops it being
    // "fixed" by accident.
    expect(parseForwardDate("18 June 2026 at 7:33:38 PM GST")).toBeNull();
  });
  test("shapes Date.parse would accept and these layouts must not", () => {
    expect(parseForwardDate("2026-07-24T16:11:00Z")).toBeNull();
    expect(parseForwardDate("Jul 24, 2026 4:11 PM")).toBeNull();
    expect(parseForwardDate("July 24, 2026")).toBeNull();
  });
  test("out-of-range fields are rejected the way Go's time.Parse rejects them", () => {
    expect(parseForwardDate("Feb 30, 2026 at 1:00 PM")).toBeNull();
    expect(parseForwardDate("21 June 2026 at 16:61")).toBeNull();
    expect(parseForwardDate("Xyz 21, 2026 at 12:29 PM")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The one class where bit-identity is impossible
// ---------------------------------------------------------------------------

describe("invalid UTF-8 in a header — the documented divergence", () => {
  // Go's Result.Subject and Result.From are Go strings, which are BYTES: an
  // RFC 2047 word labelled utf-8 whose payload is not UTF-8, or a raw 8-bit
  // header, leaves invalid UTF-8 sitting in the result verbatim. Measured, not
  // assumed — `Subject: =?utf-8?B?QcMoQg==?=` gives Go the bytes 41 c3 28 42.
  //
  // A JavaScript string cannot hold those bytes at all, so this executor
  // applies the stage-3 WHATWG substitution and emits U+FFFD. That is a
  // STRUCTURAL limit of the interface, not a defect to be fixed: `subject` is
  // typed `string`, and no string can carry them.
  //
  // The bound is narrow and checked: it cannot touch `text` (stage 3 guarantees
  // valid UTF-8 on every path, including the raw fallback), and the full-corpus
  // diff compares both header fields on all 7,002 messages and finds zero
  // differences, so no real message reaches it.
  const at = "2026-08-01T00:00:00Z";

  test("an invalid utf-8 encoded word becomes U+FFFD here and stays raw in Go", () => {
    const word = Buffer.from(Uint8Array.from([0x41, 0xc3, 0x28, 0x42])).toString("base64");
    const raw = utf8(`From: a@b.c\r\nSubject: =?utf-8?B?${word}?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n`);
    // Go: 41 c3 28 42. Here: A, U+FFFD, (, B.
    expect(cps(normalize(1, raw, at).subject)).toEqual(["U+0041", "U+FFFD", "U+0028", "U+0042"]);
  });

  test("a raw 8-bit header with invalid bytes does the same", () => {
    const raw = Uint8Array.from([
      ...utf8("From: a@b.c\r\nSubject: A"),
      0xff,
      ...utf8("B\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n"),
    ]);
    // Go: 41 ff 42.
    expect(cps(normalize(1, raw, at).subject)).toEqual(["U+0041", "U+FFFD", "U+0042"]);
  });

  test("but a VALID 8-bit header round-trips exactly, which is the common case", () => {
    const raw = utf8("From: a@b.c\r\nSubject: مرحبا DIB\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n");
    expect(normalize(1, raw, at).subject).toBe("مرحبا DIB");
  });

  test("text is never affected: stage 3 makes it valid UTF-8 on every path", () => {
    const raw = Uint8Array.from([
      ...utf8("From: a@b.c\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nA"),
      0xff,
      ...utf8("B\r\n"),
    ]);
    expect(cps(normalize(1, raw, at).text)).toEqual(["U+0041", "U+FFFD", "U+0042"]);
  });
});
