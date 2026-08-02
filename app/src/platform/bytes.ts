/**
 * Hex, base64 and UTF-8 for Hermes — hand-rolled on purpose.
 *
 * The alternative is the `buffer` npm polyfill: ~50 KB of Hermes bundle and a
 * second `Uint8Array` subclass in the graph, to provide six functions that are
 * twenty lines each.
 *
 * Every function here is pinned by `platform.test.ts` against the same vectors
 * `client/src/platform.test.ts` pins `bunPlatform` against. The vectors are
 * chosen for the exact places a hand-rolled implementation drifts from
 * `Buffer`, and each is called out at its site below.
 */

const HEX_DIGITS = "0123456789abcdef";
const HEX_RE = /^[0-9a-f]*$/;

/** Lower-case hex. Chain hashes are lower-case hex on the wire. */
export function toHex(b: Uint8Array): string {
  // Built from a lookup table rather than `toString(16)`: `(0).toString(16)`
  // is `"0"`, one character, so a leading zero byte silently vanishes and
  // every subsequent hash comparison fails by one nibble.
  let out = "";
  for (let i = 0; i < b.length; i++) {
    const v = b[i] as number;
    out += HEX_DIGITS[v >> 4];
    out += HEX_DIGITS[v & 0x0f];
  }
  return out;
}

/**
 * Strict lower-case hex. Refuses anything else rather than truncating —
 * `Buffer.from("zz", "hex")` returns an empty buffer, which turns a corrupt
 * chain head into a silently empty read.
 */
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !HEX_RE.test(s)) throw new TypeError(`not lower-case hex: ${JSON.stringify(s)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (HEX_DIGITS.indexOf(s[i * 2] as string) << 4) | HEX_DIGITS.indexOf(s[i * 2 + 1] as string);
  }
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

// Reverse table. -1 marks "not a base64 character", so a stray byte is a
// refusal rather than a skipped character.
const B64_REVERSE = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 with padding — never base64url. 62 and 63 are `+` and `/`. */
export function toBase64(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    out += B64_ALPHABET[(n >> 18) & 63];
    out += B64_ALPHABET[(n >> 12) & 63];
    out += B64_ALPHABET[(n >> 6) & 63];
    out += B64_ALPHABET[n & 63];
  }
  const rem = b.length - i;
  if (rem === 1) {
    const n = (b[i] as number) << 16;
    out += B64_ALPHABET[(n >> 18) & 63];
    out += B64_ALPHABET[(n >> 12) & 63];
    out += "==";
  } else if (rem === 2) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8);
    out += B64_ALPHABET[(n >> 18) & 63];
    out += B64_ALPHABET[(n >> 12) & 63];
    out += B64_ALPHABET[(n >> 6) & 63];
    out += "=";
  }
  return out;
}

/**
 * Strict standard base64. Length must be a multiple of four, padding only at
 * the end, alphabet only `A-Za-z0-9+/`.
 *
 * The strictness is load-bearing: `client/src/wire/op.ts` decodes
 * attacker-influenced base64 and a lenient decoder (which is what `atob` and
 * `Buffer.from(s, "base64")` both are) accepts two different strings for one
 * byte sequence. Blob identity is the hash of those bytes.
 */
export function fromBase64(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !B64_RE.test(s)) throw new TypeError(`not standard base64: ${JSON.stringify(s)}`);
  if (s.length === 0) return new Uint8Array(0);

  let pad = 0;
  if (s.endsWith("==")) pad = 2;
  else if (s.endsWith("=")) pad = 1;

  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_REVERSE[s.charCodeAt(i)] as number;
    const b = B64_REVERSE[s.charCodeAt(i + 1)] as number;
    const c = i + 2 < s.length && s[i + 2] !== "=" ? (B64_REVERSE[s.charCodeAt(i + 2)] as number) : 0;
    const d = i + 3 < s.length && s[i + 3] !== "=" ? (B64_REVERSE[s.charCodeAt(i + 3)] as number) : 0;
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new TypeError(`not standard base64: ${JSON.stringify(s)}`);
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

const REPLACEMENT = 0xfffd;

/**
 * UTF-8 encode, WHATWG semantics: a lone surrogate becomes U+FFFD rather than
 * throwing or emitting CESU-8. That is what `TextEncoder` does, and the wire
 * format's byte length is computed from this.
 */
export function utf8Encode(s: string): Uint8Array {
  // Two passes: measure, then fill. One pass with a growing array costs more
  // on Hermes than reading the string twice, and this runs per header line of
  // every inbound message.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = codePointAt(s, i);
    if (cp.surrogatePair) i++;
    n += cp.value < 0x80 ? 1 : cp.value < 0x800 ? 2 : cp.value < 0x10000 ? 3 : 4;
  }

  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = codePointAt(s, i);
    if (cp.surrogatePair) i++;
    const v = cp.value;
    if (v < 0x80) {
      out[o++] = v;
    } else if (v < 0x800) {
      out[o++] = 0xc0 | (v >> 6);
      out[o++] = 0x80 | (v & 0x3f);
    } else if (v < 0x10000) {
      out[o++] = 0xe0 | (v >> 12);
      out[o++] = 0x80 | ((v >> 6) & 0x3f);
      out[o++] = 0x80 | (v & 0x3f);
    } else {
      out[o++] = 0xf0 | (v >> 18);
      out[o++] = 0x80 | ((v >> 12) & 0x3f);
      out[o++] = 0x80 | ((v >> 6) & 0x3f);
      out[o++] = 0x80 | (v & 0x3f);
    }
  }
  return out;
}

function codePointAt(s: string, i: number): { value: number; surrogatePair: boolean } {
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    if (next >= 0xdc00 && next <= 0xdfff) {
      return { value: (c - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000, surrogatePair: true };
    }
    return { value: REPLACEMENT, surrogatePair: false }; // lone high surrogate
  }
  if (c >= 0xdc00 && c <= 0xdfff) return { value: REPLACEMENT, surrogatePair: false }; // lone low surrogate
  return { value: c, surrogatePair: false };
}

/**
 * UTF-8 decode, WHATWG semantics, **BOM-stripping**.
 *
 * `TextDecoder`'s default is `ignoreBOM: false`, which — against everything the
 * option name suggests — means *strip* a leading BOM. A hand-rolled decoder
 * does the opposite by default, so this is the single most likely place for the
 * two implementations to disagree, and it is pinned by two tests: a leading BOM
 * is removed, a BOM that is not leading is kept as U+FEFF.
 *
 * Invalid bytes decode to U+FFFD rather than throwing (`fatal: false`), because
 * the corpus is real bank mail and `norm/` depends on lossy decoding.
 */
export function utf8Decode(b: Uint8Array): string {
  let i = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;

  // Accumulate in chunks: `String.fromCharCode.apply` blows the argument limit
  // past ~64k units, and `+=` per character is the slowest path on Hermes.
  let out = "";
  let units: number[] = [];
  const flush = () => {
    if (units.length === 0) return;
    out += String.fromCharCode.apply(null, units);
    units = [];
  };

  while (i < b.length) {
    const b0 = b[i] as number;
    let cp: number;
    let len: number;

    if (b0 < 0x80) {
      cp = b0;
      len = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      cp = b0 & 0x1f;
      len = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      cp = b0 & 0x0f;
      len = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      cp = b0 & 0x07;
      len = 4;
    } else {
      units.push(REPLACEMENT); // 0x80-0xc1 and 0xf5-0xff are never a lead byte
      i++;
      continue;
    }

    if (i + len > b.length) {
      units.push(REPLACEMENT);
      i++;
      continue;
    }

    let ok = true;
    for (let k = 1; k < len; k++) {
      const bk = b[i + k] as number;
      if ((bk & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (bk & 0x3f);
    }

    // Overlong, out-of-range and surrogate encodings are all invalid input,
    // not valid encodings of an odd code point.
    if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (len === 3 && cp < 0x800) || (len === 4 && cp < 0x10000)) {
      units.push(REPLACEMENT);
      i++;
      continue;
    }

    if (cp < 0x10000) {
      units.push(cp);
    } else {
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
    i += len;

    if (units.length >= 4096) flush();
  }

  flush();
  return out;
}
