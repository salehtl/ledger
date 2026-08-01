/**
 * Charset resolution for the normalizer, stage 2.
 *
 * # Why this is not TextDecoder
 *
 * The written contract (docs/superpowers/specs/v2-normalizer-v1.md) says the two
 * executors must produce byte-identical output. The Go executor resolves a
 * declared charset label through github.com/emersion/go-message/charset, a
 * four-step chain — `ianaindex.MIME.Encoding(label)`, a retry with a `"cs"`
 * prefix, `htmlindex.Get(label)`, plus two hand-added quirks — and then decodes
 * with golang.org/x/text/encoding.
 *
 * The platform TextDecoder cannot stand in for that, and the reasons are
 * measured rather than assumed:
 *
 *   1. **Bun 1.3 does not implement windows-1256 at all.** `new
 *      TextDecoder("windows-1256")` throws. That is the corpus's only non-UTF-8
 *      charset — 110 of 7,002 messages, every one of them an Arabic DIB
 *      notification. Building on TextDecoder would have failed on real mail, not
 *      on a hypothetical.
 *   2. **Where both implement a label, they disagree.** TextDecoder follows the
 *      WHATWG index; x/text/encoding/charmap follows the Unicode consortium's
 *      mapping files. windows-1252 differs at 5 of 256 bytes (0x81, 0x8D, 0x8F,
 *      0x90, 0x9D are U+FFFD in Go and C1 controls in WHATWG); iso-8859-6
 *      differs at 32.
 *   3. **The label chains differ.** `iso-8859-1` resolves to TRUE Latin-1 in Go
 *      (via ianaindex) while TextDecoder maps it to windows-1252; `iso8859-1`,
 *      the same encoding without the hyphen, misses ianaindex and lands on the
 *      WHATWG table in BOTH. A conformance suite built on TextDecoder would have
 *      pinned that inconsistency as correct.
 *
 * So the tables in ./charset-tables.ts are GENERATED from the Go registry
 * itself, by internal/v2/norm TestWriteTwinArtifacts, and a Go freshness test
 * fails the build if they drift. Agreement is by construction, not by hope.
 *
 * # The four outcomes
 *
 * `classifyCharset` mirrors go-message's `charsetReader` dispatch exactly:
 *
 * | kind          | bytes                | error raised            |
 * |---------------|----------------------|-------------------------|
 * | passthrough   | undecoded to stage 3 | none                    |
 * | unresolved    | undecoded to stage 3 | UnknownCharsetError     |
 * | single-byte   | table-decoded        | none                    |
 * | unsupported   | (none)               | UnsupportedCharsetError |
 *
 * `passthrough` and `unresolved` produce the same text and differ only in the
 * error, which matters because that error is tolerated on the top-level entity
 * and fatal to a sub-part walk. See mime.ts.
 *
 * `unsupported` is the one place the two executors cannot be made identical:
 * Go decodes UTF-16, Shift_JIS, GB2312, Big5, EUC-* and ISO-2022-* with
 * stateful multi-byte codecs that TypeScript has no byte-identical equivalent
 * for. This executor THROWS for those rather than guessing. A loud,
 * deterministic failure on a message class the corpus contains ZERO of beats
 * silently emitting different bytes than the server did — which is the exact
 * failure this contract exists to prevent.
 */

import { classifyCharset, classifyWordCharset, type CharsetKind } from "./charset-tables.ts";

export { classifyCharset, classifyWordCharset, type CharsetKind };

/** Thrown for a charset Go decodes with a codec this executor cannot mirror. */
export class UnsupportedCharsetError extends Error {
  readonly label: string;
  constructor(label: string) {
    super(
      `norm: charset ${JSON.stringify(label)} is decoded by a stateful or multi-byte codec ` +
        `that the TypeScript normalizer cannot reproduce byte-identically; refusing to guess`,
    );
    this.name = "UnsupportedCharsetError";
    this.label = label;
  }
}

/**
 * The stage-3 decoder: UTF-8 with WHATWG error handling, one U+FFFD per maximal
 * subpart.
 *
 * `ignoreBOM: true` is not a typo and does not mean "strip the BOM" — it means
 * "do not treat a leading BOM specially", i.e. pass U+FEFF through as a
 * character. The contract requires that, because BOM removal belongs to the
 * stage-8 trim set, which removes U+FEFF wherever it lands rather than only at
 * the start. Verified against all eight vectors the spec pins.
 */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true, fatal: false });

/** Decodes bytes as UTF-8 with WHATWG substitution. Stage 3. */
export function decodeUTF8WHATWG(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** Decodes bytes through a generated 256-entry single-byte table. */
export function decodeSingleByte(table: string, bytes: Uint8Array): string {
  let out = "";
  // Chunked so a multi-megabyte body does not build a million-element array.
  const CHUNK = 4096;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    let piece = "";
    for (let i = start; i < end; i++) piece += table[bytes[i]!]!;
    out += piece;
  }
  return out;
}
