/**
 * The MIME subset the normalizer contract needs, reimplemented rather than
 * imported.
 *
 * No npm MIME library is used, deliberately: the point of the dual-executor
 * mandate is that the two implementations agree on THIS contract, not that they
 * agree on some library's interpretation of RFC 2045. Everything here is a
 * direct port of what the Go executor actually does, which is
 * github.com/emersion/go-message/textproto (itself a fork of Go's
 * mime/multipart and net/textproto) plus Go's mime and mime/quotedprintable.
 *
 * Where Go is lenient in a specific, documented way, the leniency is reproduced
 * and commented with the reason, because a strict decoder would throw exactly
 * where the server quietly passed text through.
 */

import { decodeSingleByte, decodeUTF8WHATWG, classifyCharset, classifyWordCharset } from "./charset.ts";
import { UnsupportedCharsetError } from "./charset.ts";

// ---------------------------------------------------------------------------
// Errors — each maps to a distinct branch of the Go normalizer
// ---------------------------------------------------------------------------

/**
 * The message header could not be parsed at all. Go's `message.Read` returns
 * this class of error and the normalizer answers with the stage-1 raw-body
 * fallback rather than dropping the message.
 */
export class MimeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MimeParseError";
  }
}

/**
 * A sub-part could not be produced: a malformed part header, an unterminated
 * multipart, an unknown charset or an unknown transfer encoding.
 *
 * This ABORTS the walk, which is not the same as skipping a leaf. Go's
 * `mr.NextPart()` returns these as errors and `walk` propagates them, so
 * anything already collected stands and, if nothing was, the message falls back
 * to the raw body. The asymmetry with the top-level entity — where an unknown
 * charset or encoding is tolerated — is Go's, and is reproduced here on purpose.
 */
export class WalkAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkAbortError";
  }
}

/**
 * A leaf's body could not be decoded: bad base64, an invalid quoted-printable
 * byte, an unterminated part body. The leaf is SKIPPED and its partial bytes
 * discarded; the walk continues.
 */
export class LeafDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeafDecodeError";
  }
}

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const TAB = 0x09;

const ascii = (b: Uint8Array): string => {
  let s = "";
  const CHUNK = 4096;
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, Math.min(i + CHUNK, b.length)));
  }
  return s;
};

/**
 * Reinterprets a byte-string (one character per byte, as `ascii` produces) as
 * UTF-8 text.
 *
 * Header field values are handled as BYTES all the way through, because that is
 * what Go does — a Go string is bytes, so `decodeWords` on a header carrying raw
 * 8-bit text yields proper UTF-8 without anything special happening. Decoding to
 * text too early would turn every such header into mojibake, one code point per
 * byte, and no corpus message would have shown it: all 7,002 have pure-ASCII or
 * RFC 2047-encoded Subject and From fields.
 */
const binaryToUTF8 = (s: string): string => decodeUTF8WHATWG(bytesOfASCII(s));

/**
 * Go's strings.Trim with the explicit cut set, applied to a BYTE string.
 *
 * Go trims runes, so it removes the two-byte encoding of U+00A0 and the
 * three-byte encoding of U+FEFF, and stops at any byte that is not the start of
 * one of the cut-set runes — a lone 0xA0 decodes to RuneError, which is not in
 * the set, so Go leaves it. Trimming the byte string by those exact sequences
 * reproduces that, where trimming it by CHARACTERS would strip a lone 0xA0 that
 * Go keeps.
 */
const BINARY_TRIM_SEQS = ["\t", "\n", "\u000b", "\f", "\r", " ", "\u00c2\u00a0", "\u00ef\u00bb\u00bf"];
function trimExplicitBinary(s: string): string {
  let start = 0;
  let end = s.length;
  outer: for (;;) {
    for (const q of BINARY_TRIM_SEQS) {
      if (s.startsWith(q, start) && start + q.length <= end) {
        start += q.length;
        continue outer;
      }
    }
    break;
  }
  outer2: for (;;) {
    for (const q of BINARY_TRIM_SEQS) {
      if (end - q.length >= start && s.startsWith(q, end - q.length)) {
        end -= q.length;
        continue outer2;
      }
    }
    break;
  }
  return s.slice(start, end);
}

const bytesOfASCII = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

const isSpaceByte = (b: number): boolean => b === SP || b === TAB;

function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  const last = hay.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const startsWithAt = (hay: Uint8Array, needle: Uint8Array, at: number): boolean => {
  if (at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) if (hay[at + j] !== needle[j]) return false;
  return true;
};

// ---------------------------------------------------------------------------
// Header parsing — a port of go-message/textproto.ReadHeader
// ---------------------------------------------------------------------------

export interface HeaderField {
  /** Lower-cased field name, for lookup. */
  readonly key: string;
  /** The unfolded value, with newlines and the spaces around them collapsed. */
  readonly value: string;
}

export interface ParsedHeader {
  readonly fields: readonly HeaderField[];
  /** Offset of the first body byte, i.e. just past the blank line. */
  readonly bodyStart: number;
}

/** Trailing/leading spaces and tabs only — go-message's `trim`, not Unicode. */
function trimSpaceTab(s: string): string {
  let i = 0;
  let n = s.length;
  while (i < n && (s[i] === " " || s[i] === "\t")) i++;
  while (n > i && (s[n - 1] === " " || s[n - 1] === "\t")) n--;
  return s.slice(i, n);
}

/**
 * Reads one line, returning it WITHOUT its terminator, exactly as bufio.ReadLine
 * does: the delimiter is `\n` and a single `\r` immediately before it is
 * dropped.
 *
 * The `eof` flag reports that the buffer ended without a `\n`. That distinction
 * is load-bearing: bufio.ReadLine clears the error whenever it returns any
 * bytes, so a final line with no newline is a normal line and the EOF surfaces
 * on the NEXT read. Getting this wrong makes a message whose header block is not
 * newline-terminated take the raw-body fallback in one executor and parse
 * cleanly in the other.
 */
function readLine(buf: Uint8Array, pos: number): { line: Uint8Array; next: number; eof: boolean } {
  if (pos >= buf.length) return { line: new Uint8Array(0), next: pos, eof: true };
  const nl = buf.indexOf(LF, pos);
  if (nl < 0) return { line: buf.subarray(pos), next: buf.length, eof: false };
  let end = nl;
  if (end > pos && buf[end - 1] === CR) end--;
  return { line: buf.subarray(pos, end), next: nl + 1, eof: false };
}

/** go-message's trimAroundNewlines: unfold, joining segments with one space. */
function trimAroundNewlines(v: string): string {
  let out = "";
  for (const rawSegment of v.split("\n")) {
    let l = rawSegment;
    if (l.endsWith("\r")) l = l.slice(0, -1);
    l = trimSpaceTab(l);
    if (l.length === 0) continue;
    if (out.length > 0) out += " ";
    out += l;
  }
  return out;
}

const validHeaderKeyByte = (c: number): boolean => c >= 33 && c <= 126 && c !== 0x3a;

/**
 * Parses a message or part header.
 *
 * Throws {@link MimeParseError} on exactly the conditions go-message rejects: a
 * header block whose first line is folded, a line with no colon, and a field
 * name containing a byte outside RFC 5322's `ftext`.
 */
export function readHeader(buf: Uint8Array, start: number): ParsedHeader {
  const fields: HeaderField[] = [];
  if (start < buf.length && isSpaceByte(buf[start]!)) {
    throw new MimeParseError("message: malformed MIME header initial line");
  }
  let pos = start;
  for (;;) {
    // readContinuedLineSlice: one line plus every following folded line.
    const first = readLine(buf, pos);
    if (first.eof) return { fields, bodyStart: buf.length };
    let kv = ascii(first.line) + "\r\n";
    let p = first.next;
    if (first.line.length === 0) return { fields, bodyStart: p }; // the blank line
    while (p < buf.length && isSpaceByte(buf[p]!)) {
      const cont = readLine(buf, p);
      if (cont.eof) break;
      kv += ascii(cont.line) + "\r\n";
      p = cont.next;
    }
    pos = p;

    const i = kv.indexOf(":");
    if (i < 0) throw new MimeParseError(`message: malformed MIME header line: ${kv}`);
    const keyRaw = trimSpaceTab(kv.slice(0, i));
    for (let k = 0; k < keyRaw.length; k++) {
      if (!validHeaderKeyByte(keyRaw.charCodeAt(k))) {
        throw new MimeParseError(`message: malformed MIME header key: ${keyRaw}`);
      }
    }
    // An empty key is skipped rather than rejected, as in go-message.
    if (keyRaw.length > 0) {
      fields.push({ key: keyRaw.toLowerCase(), value: trimAroundNewlines(kv.slice(i + 1)) });
    }
  }
}

/** The first field with this name, or "" — go-message's Header.Get. */
export function headerGet(h: ParsedHeader, name: string): string {
  const want = name.toLowerCase();
  for (const f of h.fields) if (f.key === want) return f.value;
  return "";
}

// ---------------------------------------------------------------------------
// Media type — a port of Go's mime.ParseMediaType, via go-message's wrapper
// ---------------------------------------------------------------------------

export interface MediaType {
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
}

const TSPECIALS = '()<>@,;:\\"/[]?=';
const isTokenChar = (c: string): boolean => {
  const b = c.charCodeAt(0);
  return b > 0x20 && b < 0x7f && !TSPECIALS.includes(c);
};

/**
 * Go's unicode.IsSpace, spelled out. Not `\s`: JavaScript's `\s` and Go's
 * unicode.IsSpace are close but not equal, and this runs on attacker-supplied
 * header text.
 */
const UNICODE_SPACE_RE = /^[\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;
const trimLeftUnicodeSpace = (s: string): string => s.replace(UNICODE_SPACE_RE, "");
const trimUnicodeSpace = (s: string): string =>
  trimLeftUnicodeSpace(s).replace(
    /[\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/,
    "",
  );

function consumeToken(s: string): [string, string] {
  let i = 0;
  while (i < s.length && isTokenChar(s[i]!)) i++;
  return [s.slice(0, i), s.slice(i)];
}

/**
 * Go's consumeValue. Failure is signalled the way Go signals it — an empty
 * value AND an unconsumed rest — because `filename=""` is a legitimate empty
 * value that must not be mistaken for a parse error.
 */
function consumeValue(v: string): [string, string] {
  if (v === "") return ["", ""];
  if (v[0] !== '"') return consumeToken(v);
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const r = v[i]!;
    if (r === '"') return [out, v.slice(i + 1)];
    // A backslash escapes ONLY a tspecial. MSIE sends unescaped Windows paths
    // ("C:\dev\go"), so an unnecessary backslash is a literal backslash.
    if (r === "\\" && i + 1 < v.length && TSPECIALS.includes(v[i + 1]!)) {
      out += v[i + 1]!;
      i++;
      continue;
    }
    if (r === "\n" || r === "\r") return ["", v];
    out += r;
  }
  return ["", v]; // no closing quote
}

/** Go's consumeMediaParam: returns null when it consumed nothing. */
function consumeMediaParam(v: string): [string, string, string] | null {
  let rest = trimLeftUnicodeSpace(v);
  if (!rest.startsWith(";")) return null;
  rest = trimLeftUnicodeSpace(rest.slice(1));
  let param: string;
  [param, rest] = consumeToken(rest);
  param = param.toLowerCase();
  if (param === "") return null;
  rest = trimLeftUnicodeSpace(rest);
  if (!rest.startsWith("=")) return null;
  rest = trimLeftUnicodeSpace(rest.slice(1));
  const [value, rest2] = consumeValue(rest);
  if (value === "" && rest2 === rest) return null;
  return [param, value, rest2];
}

/** RFC 2231 percent-unescaping; null on a malformed escape, as Go errors. */
function percentHexUnescape(s: string): string | null {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "%") {
      out += s[i]!;
      continue;
    }
    if (i + 2 >= s.length) return null;
    const hi = fromHexByte(s.charCodeAt(i + 1));
    const lo = fromHexByte(s.charCodeAt(i + 2));
    if (hi < 0 || lo < 0) return null;
    out += String.fromCharCode((hi << 4) | lo);
    i += 2;
  }
  return out;
}

/**
 * RFC 2231 extended value, `charset'lang'pct-encoded`.
 *
 * Go supports exactly three charsets here — us-ascii, utf-8 and the empty
 * string — and DROPS the parameter for anything else. Reproduced rather than
 * improved on: a parameter this executor kept and Go dropped would change which
 * leaf gets chosen.
 */
function decode2231Enc(v: string): string | null {
  const first = v.indexOf("'");
  if (first < 0) return null;
  const second = v.indexOf("'", first + 1);
  if (second < 0) return null;
  const charset = v.slice(0, first).toLowerCase();
  const encv = percentHexUnescape(v.slice(second + 1));
  if (encv === null) return null;
  if (charset === "us-ascii" || charset === "utf-8" || charset === "") return encv;
  return null;
}

/** Go's checkMediaTypeDisposition. */
function validMediaType(s: string): boolean {
  const [typ, rest] = consumeToken(s);
  if (typ === "") return false;
  if (rest === "") return true;
  if (!rest.startsWith("/")) return false;
  const [subtype, rest2] = consumeToken(rest.slice(1));
  if (subtype === "") return false;
  return rest2 === "";
}

/**
 * Parses a Content-Type value, a port of Go's mime.ParseMediaType as reached
 * through go-message's wrapper.
 *
 * Returns null wherever Go returns an error, which is not a detail: go-message
 * then hands the RAW field value back as the media type, so `Content-Type:
 * text/html (html); charset=utf-8` yields a type matching neither "text/html"
 * nor "text/plain" and the leaf is skipped.
 *
 * The tolerances are Go's and every one of them is load-bearing on real mail —
 * a TRAILING SEMICOLON is what three of the corpus's Apple-Mail forwards send
 * (`text/html; charset=utf-8;`), and rejecting it made this executor pick the
 * text/plain alternative where Go picked the HTML one.
 */
export function parseMediaType(v: string): MediaType | null {
  const semi = v.indexOf(";");
  const base = semi < 0 ? v : v.slice(0, semi);
  const mediatype = trimUnicodeSpace(base).toLowerCase();
  if (!validMediaType(mediatype)) return null;

  const params: Record<string, string> = {};
  // Parameters whose name contains "*" are RFC 2231 pieces, stitched at the end.
  const continuation: Record<string, Record<string, string>> = {};

  let rest = v.slice(base.length);
  while (rest.length > 0) {
    rest = trimLeftUnicodeSpace(rest);
    if (rest.length === 0) break;
    const p = consumeMediaParam(rest);
    if (p === null) {
      if (trimUnicodeSpace(rest) === ";") break; // a trailing semicolon is not an error
      return null;
    }
    const [key, value, after] = p;
    const star = key.indexOf("*");
    const pmap = star >= 0 ? (continuation[key.slice(0, star)] ??= {}) : params;
    const existing = pmap[key];
    if (existing !== undefined && existing !== value) return null; // duplicate with a different value
    pmap[key] = value;
    rest = after;
  }

  for (const [key, pieceMap] of Object.entries(continuation)) {
    const single = pieceMap[key + "*"];
    if (single !== undefined) {
      const dec = decode2231Enc(single);
      if (dec !== null) params[key] = dec;
      continue;
    }
    let buf = "";
    let valid = false;
    for (let n = 0; ; n++) {
      const simple = pieceMap[`${key}*${n}`];
      if (simple !== undefined) {
        valid = true;
        buf += simple;
        continue;
      }
      const encoded = pieceMap[`${key}*${n}*`];
      if (encoded === undefined) break;
      valid = true;
      if (n === 0) {
        const dec = decode2231Enc(encoded);
        if (dec !== null) buf += dec;
      } else {
        const dec = percentHexUnescape(encoded);
        if (dec !== null) buf += dec;
      }
    }
    if (valid) params[key] = buf;
  }

  // go-message RFC 2047-decodes every parameter value after parsing.
  for (const k of Object.keys(params)) params[k] = decodeWords(params[k]!);
  return { type: mediatype, params };
}

/**
 * The entity's media type and parameters.
 *
 * Two go-message behaviours are reproduced: a missing Content-Type defaults to
 * "text/plain" with NO parameters, and an unparseable one yields the raw field
 * value as the type.
 */
export function contentTypeOf(h: ParsedHeader): MediaType {
  const v = headerGet(h, "content-type");
  if (v === "") return { type: "text/plain", params: {} };
  return parseMediaType(v) ?? { type: v, params: {} };
}

// ---------------------------------------------------------------------------
// Content-Transfer-Encoding
// ---------------------------------------------------------------------------

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REVERSE = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/**
 * Strict base64, matching `base64.NewDecoder(base64.StdEncoding, …)` wrapped in
 * go-message's `whitespaceReplacingReader`.
 *
 * The wrapper rewrites every space and tab to LF before decoding, and the Go
 * decoder already ignores CR and LF, so the net rule is: skip all four ASCII
 * whitespace bytes anywhere in the payload, then decode strictly. RFC 2045
 * permits that whitespace and real mailers emit it — a base64 part with a
 * continuation indent must decode, not fail.
 *
 * Everything else is strict, because Go is: missing padding, a character
 * outside the alphabet, a truncated final quantum and any data after the
 * padding are all errors, and an undecodable leaf is discarded rather than
 * partially salvaged.
 */
export function decodeBase64(body: Uint8Array): Uint8Array {
  const clean = new Uint8Array(body.length);
  let n = 0;
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!;
    if (b === SP || b === TAB || b === CR || b === LF) continue;
    clean[n++] = b;
  }
  if (n % 4 !== 0) throw new LeafDecodeError("base64: input is not a whole number of quanta");
  const out = new Uint8Array((n / 4) * 3);
  let o = 0;
  for (let i = 0; i < n; i += 4) {
    const c0 = clean[i]!;
    const c1 = clean[i + 1]!;
    const c2 = clean[i + 2]!;
    const c3 = clean[i + 3]!;
    const v0 = B64_REVERSE[c0]!;
    const v1 = B64_REVERSE[c1]!;
    if (v0 < 0 || v1 < 0) throw new LeafDecodeError("base64: invalid character");
    const pad2 = c2 === 0x3d;
    const pad3 = c3 === 0x3d;
    if (pad2 && !pad3) throw new LeafDecodeError("base64: malformed padding");
    if ((pad2 || pad3) && i + 4 !== n) throw new LeafDecodeError("base64: data after padding");
    out[o++] = (v0 << 2) | (v1 >> 4);
    if (pad2) return out.subarray(0, o);
    const v2 = B64_REVERSE[c2]!;
    if (v2 < 0) throw new LeafDecodeError("base64: invalid character");
    out[o++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
    if (pad3) return out.subarray(0, o);
    const v3 = B64_REVERSE[c3]!;
    if (v3 < 0) throw new LeafDecodeError("base64: invalid character");
    out[o++] = ((v2 & 0x03) << 6) | v3;
  }
  return out.subarray(0, o);
}

const fromHexByte = (b: number): number => {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10; // Go accepts lower case too
  return -1;
};

/**
 * Quoted-printable, a line-for-line port of Go's mime/quotedprintable.Reader.
 *
 * Go documents four deliberate deviations from RFC 2045 and all four are load
 * bearing on real mail, so they are reproduced exactly:
 *
 *   1. `=` + LF is a soft line break, not just `=` + CRLF.
 *   2. A bare CR or LF not preceded by `=` passes through.
 *   3. A trailing `=` at end of input is silently dropped — but ONLY when the
 *      line has content before it. A line that is nothing but `=` at end of
 *      input is an error, and therefore discards the whole leaf.
 *   4. `=` not followed by two hex digits is a literal `=`, unless what follows
 *      is CR or LF, which is an error.
 *
 * Plus the whitespace rule that is easy to miss: trailing whitespace before a
 * HARD line break is stripped, and before a SOFT one it is preserved.
 */
export function decodeQuotedPrintable(body: Uint8Array): Uint8Array {
  const out: number[] = [];
  let pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf(LF, pos);
    const whole = nl < 0 ? body.subarray(pos) : body.subarray(pos, nl + 1);
    const atEOF = nl < 0;
    pos = nl < 0 ? body.length : nl + 1;

    const hasLF = whole.length > 0 && whole[whole.length - 1] === LF;
    const hasCR = whole.length > 1 && whole[whole.length - 2] === CR && hasLF;

    let end = whole.length;
    while (end > 0) {
      const c = whole[end - 1]!;
      if (c === LF || c === CR || c === SP || c === TAB) end--;
      else break;
    }
    let line = whole.subarray(0, end);
    let softBreak = false;

    if (line.length > 0 && line[line.length - 1] === 0x3d) {
      let tail = whole.subarray(end);
      let t = 0;
      while (t < tail.length && (tail[t] === SP || tail[t] === TAB)) t++;
      tail = tail.subarray(t);
      line = line.subarray(0, line.length - 1);
      const tailIsBreak =
        (tail.length >= 1 && tail[0] === LF) || (tail.length >= 2 && tail[0] === CR && tail[1] === LF);
      const trailingEqAtEOF = tail.length === 0 && line.length > 0 && atEOF;
      if (!tailIsBreak && !trailingEqAtEOF) {
        throw new LeafDecodeError("quotedprintable: invalid bytes after =");
      }
      softBreak = true;
    }

    // Emit this line's bytes.
    for (let i = 0; i < line.length; ) {
      const b = line[i]!;
      if (b === 0x3d) {
        const hi = i + 1 < line.length ? fromHexByte(line[i + 1]!) : -1;
        const lo = i + 2 < line.length ? fromHexByte(line[i + 2]!) : -1;
        if (hi >= 0 && lo >= 0) {
          out.push((hi << 4) | lo);
          i += 3;
          continue;
        }
        const nextByte = i + 1 < line.length ? line[i + 1]! : -1;
        if (line.length - i >= 2 && nextByte !== CR && nextByte !== LF) {
          out.push(0x3d); // literal =
          i += 1;
          continue;
        }
        throw new LeafDecodeError("quotedprintable: invalid = sequence");
      }
      if (b === TAB || b === CR || b === LF || b >= 0x80) {
        out.push(b);
        i += 1;
        continue;
      }
      if (b < SP || b > 0x7e) {
        throw new LeafDecodeError(`quotedprintable: invalid unescaped byte 0x${b.toString(16)} in body`);
      }
      out.push(b);
      i += 1;
    }

    if (!softBreak && hasLF) {
      if (hasCR) out.push(CR);
      out.push(LF);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Applies a Content-Transfer-Encoding.
 *
 * Returns null for an encoding Go does not handle, which is NOT the same as
 * failing: go-message reports an UnknownEncodingError and leaves the body
 * undecoded, and that error is tolerated on the top-level entity and fatal to a
 * sub-part.
 */
export function transferDecode(cte: string, body: Uint8Array): Uint8Array | null {
  const d = transferDecoderFor(cte);
  return d === null ? null : d(body);
}

/** The decoder for this encoding, or null when Go would report it unknown. */
export function transferDecoderFor(cte: string): ((b: Uint8Array) => Uint8Array) | null {
  // go-message lower-cases the raw field value and matches exactly; it does not
  // trim, but the header reader already removed surrounding whitespace.
  switch (cte.toLowerCase()) {
    case "quoted-printable":
      return decodeQuotedPrintable;
    case "base64":
      return decodeBase64;
    case "7bit":
    case "8bit":
    case "binary":
    case "":
      return (b) => b;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words — a port of Go's mime.WordDecoder
// ---------------------------------------------------------------------------

/**
 * Decodes one encoded-word's content bytes with the charset the word declares.
 *
 * Go's mime.WordDecoder handles utf-8, iso-8859-1 and us-ascii ITSELF and only
 * then falls back to the CharsetReader, and its three built-ins do not match
 * what the same three labels do at the body level:
 *
 *   - `iso-8859-1` here is TRUE Latin-1 (byte -> code point), always.
 *   - `us-ascii` here emits one U+FFFD PER BYTE >= 0x80, which is neither the
 *     body-level passthrough nor the WHATWG maximal-subpart rule.
 *
 * Returns null when the charset is unusable, which makes the whole field fall
 * back to its raw value.
 */
function convertWord(charset: string, content: Uint8Array): string | null {
  const cs = charset.toLowerCase();
  if (cs === "utf-8") return null; // handled by the byte-level caller
  if (cs === "iso-8859-1") {
    let s = "";
    for (const b of content) s += String.fromCharCode(b);
    return s;
  }
  if (cs === "us-ascii") {
    let s = "";
    for (const b of content) s += b >= 0x80 ? "�" : String.fromCharCode(b);
    return s;
  }
  // htmlindex ALONE, not the body path's four-step chain. norm's word decoder is
  // wired straight to htmlindex.Get, so "ansi_x3.110-1983" — an ISO-8859-1 alias
  // for a body — is simply unknown to a word, and so is every ianaindex-only
  // name. Using the body map here would decode words Go leaves raw.
  const c = classifyWordCharset(cs);
  switch (c.kind) {
    case "single-byte":
      return decodeSingleByte(c.table!, content);
    case "unsupported":
      throw new UnsupportedCharsetError(cs);
    default:
      // htmlindex fails, Go's DecodeHeader errors, and decodeWords keeps the
      // field's raw value.
      return null;
  }
}

function qDecode(text: string): Uint8Array | null {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5f) {
      out.push(SP);
      continue;
    }
    if (c === 0x3d) {
      if (i + 2 >= text.length) return null;
      const hi = fromHexByte(text.charCodeAt(i + 1));
      const lo = fromHexByte(text.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) return null;
      out.push((hi << 4) | lo);
      i += 2;
      continue;
    }
    if ((c <= 0x7e && c >= SP) || c === LF || c === CR || c === TAB) {
      out.push(c);
      continue;
    }
    return null;
  }
  return Uint8Array.from(out);
}

function bDecode(text: string): Uint8Array | null {
  // Go uses base64.StdEncoding.DecodeString here: strict, padding required, and
  // NO whitespace skipping — unlike the body decoder, which go-message wraps in
  // whitespaceReplacingReader. Whitespace is rejected explicitly rather than
  // left to decodeBase64, which would have skipped it.
  if (text.length % 4 !== 0) return null;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c !== 0x3d && B64_REVERSE[c] === undefined) return null;
    if (c !== 0x3d && B64_REVERSE[c]! < 0) return null;
  }
  try {
    return decodeBase64(bytesOfASCII(text));
  } catch {
    return null;
  }
}

const hasNonWhitespace = (s: string): boolean => [...s].some((c) => !" \t\n\r".includes(c));

/**
 * RFC 2047 decoding of a header field value, a port of
 * mime.WordDecoder.DecodeHeader.
 *
 * Adjacent encoded words join with NO separator — the corpus's ENBD alert
 * forward is exactly that shape, and inserting a space between the words breaks
 * the account last4 match. A word that fails to decode is left verbatim and
 * scanning continues after its `=?`.
 *
 * Output is assembled as BYTES and decoded once at the end. Go appends the raw
 * decoded bytes of a utf-8 word straight into the result string without
 * validating them, so a mislabelled word can leave a Go Subject holding invalid
 * UTF-8. A JavaScript string cannot represent that, so this executor
 * substitutes U+FFFD there — the one place the two cannot be bit-identical, and
 * it is recorded in the task report rather than hidden.
 */
export function decodeWords(raw: string): string {
  // Go's decodeWords trims BEFORE decoding and returns the trimmed value on the
  // failure path, so the trim is part of this function, not of its callers.
  const v = trimExplicitBinary(raw);
  if (v === "") return "";
  if (!v.includes("=?")) return binaryToUTF8(v);

  const out: number[] = [];
  const pushASCII = (s: string) => {
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  };
  const pushUTF8 = (s: string) => {
    for (const b of new TextEncoder().encode(s)) out.push(b);
  };

  let header = v;
  const firstIdx = header.indexOf("=?");
  pushASCII(header.slice(0, firstIdx));
  header = header.slice(firstIdx);

  let betweenWords = false;
  for (;;) {
    const start = header.indexOf("=?");
    if (start === -1) break;
    let cur = start + 2;

    const q = header.indexOf("?", cur);
    if (q === -1) break;
    const charset = header.slice(cur, q);
    cur = q + 1;

    if (header.length < cur + "Q??=".length) break;
    const encoding = header[cur]!;
    cur++;
    if (header[cur] !== "?") break;
    cur++;

    const j = header.indexOf("?=", cur);
    if (j === -1) break;
    const text = header.slice(cur, j);
    const end = j + 2;

    let content: Uint8Array | null;
    if (encoding === "B" || encoding === "b") content = bDecode(text);
    else if (encoding === "Q" || encoding === "q") content = qDecode(text);
    else content = null;

    if (content === null) {
      // Go writes the "=?" back out and rescans from just after it.
      betweenWords = false;
      pushASCII(header.slice(0, start + 2));
      header = header.slice(start + 2);
      continue;
    }

    if (start > 0 && (!betweenWords || hasNonWhitespace(header.slice(0, start)))) {
      pushASCII(header.slice(0, start));
    }

    if (charset.toLowerCase() === "utf-8") {
      for (const b of content) out.push(b);
    } else {
      const converted = convertWord(charset, content);
      if (converted === null) return binaryToUTF8(v); // undecodable charset: keep the raw field
      pushUTF8(converted);
    }

    header = header.slice(end);
    betweenWords = true;
  }
  if (header.length > 0) pushASCII(header);
  return decodeUTF8WHATWG(Uint8Array.from(out));
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+$/;

const isDotAtom = (s: string): boolean =>
  s.length > 0 && !s.startsWith(".") && !s.endsWith(".") && !s.includes("..") && s.split(".").every((p) => ATEXT.test(p));

/** A quoted-string local part, e.g. `"B, Alice"@example.com`. */
const isQuotedLocal = (s: string): boolean => s.length >= 2 && s.startsWith('"') && s.endsWith('"');

function isAddrSpec(s: string): boolean {
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!isDotAtom(local) && !isQuotedLocal(local)) return false;
  if (domain.startsWith("[") && domain.endsWith("]")) return true;
  return isDotAtom(domain);
}

/**
 * Splits an address list on top-level commas, respecting quoted strings,
 * comments and angle-addrs.
 */
function splitAddressList(v: string): string[] {
  const out: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let inQuote = false;
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (inQuote) {
      cur += c;
      if (c === "\\" && i + 1 < v.length) {
        i++;
        cur += v[i]!;
      } else if (c === '"') inQuote = false;
      continue;
    }
    switch (c) {
      case '"':
        inQuote = true;
        cur += c;
        break;
      case "<":
        depthAngle++;
        cur += c;
        break;
      case ">":
        if (depthAngle > 0) depthAngle--;
        cur += c;
        break;
      case "(":
        depthParen++;
        cur += c;
        break;
      case ")":
        if (depthParen > 0) depthParen--;
        cur += c;
        break;
      case ",":
        if (depthAngle === 0 && depthParen === 0) {
          out.push(cur);
          cur = "";
        } else cur += c;
        break;
      default:
        cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Extracts the addr-spec of a single mailbox, or null if it is not one. */
function parseMailbox(s: string): string | null {
  const t = s.trim();
  if (t === "") return null;
  const lt = t.lastIndexOf("<");
  if (lt >= 0) {
    const gt = t.indexOf(">", lt);
    if (gt < 0) return null;
    if (t.slice(gt + 1).trim() !== "") return null; // trailing junk: Go rejects it
    const addr = t.slice(lt + 1, gt).trim();
    return isAddrSpec(addr) ? addr : null;
  }
  return isAddrSpec(t) ? t : null;
}

/**
 * Reduces a From header to the bare address, which is what v1's IMAP ENVELOPE
 * supplied to the parse cascade.
 *
 * The cascade is Go's: an address list, then a single address, then a by-hand
 * angle-addr recovery, then the trimmed raw value. The last two steps are why a
 * junk From is never simply dropped.
 */
export function bareAddress(v: string, trim: (s: string) => string): string {
  const t = trim(v);
  if (t === "") return "";
  const parts = splitAddressList(t);
  const first = parts[0] === undefined ? null : parseMailbox(parts[0]);
  if (first !== null && parts.every((p) => parseMailbox(p) !== null)) return first;
  const single = parseMailbox(t);
  if (single !== null) return single;
  const i = t.lastIndexOf("<");
  if (i >= 0) {
    const j = t.indexOf(">", i);
    if (j > i) return trim(t.slice(i + 1, j));
  }
  return t;
}

// ---------------------------------------------------------------------------
// Entities and the multipart walk
// ---------------------------------------------------------------------------

export interface Entity {
  readonly header: ParsedHeader;
  readonly mediaType: string;
  readonly params: Readonly<Record<string, string>>;
  /**
   * The body with its transfer encoding and charset applied, or the thrower
   * that reproduces the error Go's reader would have raised at read time.
   */
  readonly text: () => string;
  /** Raw (still transfer-encoded) body bytes; the multipart walker needs these. */
  readonly rawBody: Uint8Array;
}

/**
 * Builds an entity from a header and its raw body, reproducing go-message's
 * `New` including WHICH errors it reports.
 *
 * Order matters and is Go's: the transfer encoding is applied first and only for
 * non-multipart entities (RFC 2045 forbids a CTE on multipart, real mailers send
 * one anyway and go-message ignores it), then the charset, and only for `text/*`
 * with an explicit charset parameter.
 *
 * The returned `error` is what NextPart would hand back. It is advisory at the
 * top level and fatal inside a multipart.
 */
export function newEntity(
  header: ParsedHeader,
  rawBody: Uint8Array,
): { entity: Entity; error: "unknown-encoding" | "unknown-charset" | null } {
  const { type, params } = contentTypeOf(header);
  let error: "unknown-encoding" | "unknown-charset" | null = null;

  // Whether a transfer decoder EXISTS is decided now, because that is what
  // go-message reports from New. Whether it SUCCEEDS is decided lazily, because
  // in Go that failure surfaces at ReadAll time — which is the difference
  // between a walk that aborts and a leaf that is skipped. Laziness is also what
  // keeps the walk from base64-decoding every inline image it passes.
  const cte = headerGet(header, "content-transfer-encoding");
  const isMultipart = type.startsWith("multipart/");
  if (!isMultipart && transferDecoderFor(cte) === null) error = "unknown-encoding";
  const decode = (): Uint8Array => {
    if (isMultipart || error === "unknown-encoding") return rawBody;
    return transferDecode(cte, rawBody) ?? rawBody;
  };

  let toText: () => string = () => decodeUTF8WHATWG(decode());
  if (type.startsWith("text/") && params["charset"] !== undefined) {
    const c = classifyCharset(params["charset"]);
    switch (c.kind) {
      case "single-byte": {
        const table = c.table!;
        toText = () => decodeSingleByte(table, decode());
        break;
      }
      case "unsupported":
        toText = () => {
          throw new UnsupportedCharsetError(params["charset"]!);
        };
        break;
      case "unresolved":
        // go-message reports the error AND leaves the body undecoded.
        error = "unknown-charset";
        break;
      case "passthrough":
        break;
    }
  }

  return { entity: { header, mediaType: type, params, text: toText, rawBody }, error };
}

/**
 * Iterates the parts of a multipart body, a port of
 * go-message/textproto.MultipartReader.
 *
 * Throws {@link WalkAbortError} exactly where Go's NextPart returns an error:
 * an empty boundary, a line that is neither a boundary nor a separator, a part
 * header that will not parse, and a body that runs to EOF without a terminating
 * boundary (Go turns that into io.ErrUnexpectedEOF, which discards the leaf AND
 * aborts the walk).
 */
export function* multipartParts(
  body: Uint8Array,
  boundary: string,
): Generator<{ header: ParsedHeader; rawBody: Uint8Array }> {
  if (boundary === "") throw new WalkAbortError("multipart: boundary is empty");
  const dashBoundary = bytesOfASCII("--" + boundary);
  const dashBoundaryDash = bytesOfASCII("--" + boundary + "--");
  let nl = bytesOfASCII("\r\n");
  let nlDashBoundary = bytesOfASCII("\r\n--" + boundary);

  let pos = 0;
  let partsRead = 0;
  let expectNewPart = false;

  const lineAt = (at: number): { raw: Uint8Array; next: number; sawLF: boolean } => {
    const idx = body.indexOf(LF, at);
    if (idx < 0) return { raw: body.subarray(at), next: body.length, sawLF: false };
    return { raw: body.subarray(at, idx + 1), next: idx + 1, sawLF: true };
  };

  const skipLWSP = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length && isSpaceByte(b[i]!)) i++;
    return b.subarray(i);
  };
  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);

  const isFinalBoundary = (line: Uint8Array): boolean => {
    if (!startsWithAt(line, dashBoundaryDash, 0)) return false;
    const rest = skipLWSP(line.subarray(dashBoundaryDash.length));
    return rest.length === 0 || eq(rest, nl);
  };
  const isBoundaryDelimiter = (line: Uint8Array): boolean => {
    if (!startsWithAt(line, dashBoundary, 0)) return false;
    const rest = skipLWSP(line.subarray(dashBoundary.length));
    // First part only: switch to bare-LF mode when the mail uses LF endings.
    if (partsRead === 0 && rest.length === 1 && rest[0] === LF) {
      nl = nl.subarray(1);
      nlDashBoundary = nlDashBoundary.subarray(1);
    }
    return eq(rest, nl);
  };

  // matchAfterPrefix: +1 EOF, 0 need more, -1 not a boundary. With the whole
  // buffer in hand there is no "need more", so 0 and +1 collapse.
  const boundaryMatchesAt = (at: number, prefix: Uint8Array): boolean => {
    if (!startsWithAt(body, prefix, at)) return false;
    const after = at + prefix.length;
    if (after === body.length) return true;
    const c = body[after]!;
    return c === SP || c === TAB || c === CR || c === LF || c === 0x2d;
  };

  for (;;) {
    const { raw: line, next, sawLF } = lineAt(pos);
    if (!sawLF && isFinalBoundary(line)) return;
    if (!sawLF && line.length === 0) throw new WalkAbortError("multipart: NextPart: EOF");
    if (!sawLF) throw new WalkAbortError("multipart: NextPart: unexpected EOF");
    pos = next;

    if (isBoundaryDelimiter(line)) {
      partsRead++;
      const header = readHeader(body, pos); // MimeParseError propagates as a walk abort
      let bodyStart = header.bodyStart;
      // Find where this part's body ends.
      let end = -1;
      if (bodyStart <= body.length && boundaryMatchesAt(bodyStart, dashBoundary)) {
        end = bodyStart; // a body that starts with the boundary is empty
      } else {
        for (let i = bodyStart; ; ) {
          const at = indexOfSeq(body, nlDashBoundary, i);
          if (at < 0) break;
          if (boundaryMatchesAt(at, nlDashBoundary)) {
            end = at;
            break;
          }
          i = at + 1;
        }
      }
      if (end < 0) {
        // Go: io.ErrUnexpectedEOF. The leaf is undecodable AND the walk aborts.
        throw new WalkAbortError("multipart: unterminated part body");
      }
      yield { header, rawBody: body.subarray(bodyStart, end) };
      pos = end;
      expectNewPart = false;
      continue;
    }

    if (isFinalBoundary(line)) return;
    if (expectNewPart) throw new WalkAbortError("multipart: expecting a new Part");
    if (partsRead === 0) continue; // preamble
    if (eq(line, nl)) {
      expectNewPart = true;
      continue;
    }
    throw new WalkAbortError("multipart: unexpected line");
  }
}

/** Everything after the first blank line, or the whole message when it has none. */
export function rawBodyAfterHeaders(raw: Uint8Array): Uint8Array {
  const crlf = indexOfSeq(raw, bytesOfASCII("\r\n\r\n"), 0);
  const lf = indexOfSeq(raw, bytesOfASCII("\n\n"), 0);
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return raw.subarray(crlf + 4);
  if (lf >= 0) return raw.subarray(lf + 2);
  return raw;
}

export { ascii as asciiOfBytes, bytesOfASCII, binaryToUTF8, trimExplicitBinary };
