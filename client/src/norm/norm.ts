/**
 * The v2 normalizer, TypeScript executor.
 *
 * This is the twin of internal/v2/norm. The two must produce BYTE-IDENTICAL
 * output for the same input, because a template match made on the client and a
 * template match made on the server have to be the same match. The written
 * contract is docs/superpowers/specs/v2-normalizer-v1.md; the fixtures that
 * hold the two executors together are conformance/normalizer/*.json.
 *
 * Every decision here that could plausibly differ between Go and JavaScript is
 * named and pinned rather than left to a platform default:
 *
 *   - The trim set is written out (unwrap.ts), never String.prototype.trim.
 *   - `\s` appears in no regex in this directory. Go's RE2 `\s` is five ASCII
 *     characters; JavaScript's includes U+00A0, U+FEFF and the whole U+2000
 *     block.
 *   - Entity decoding is ONE left-to-right pass, not six chained replaces.
 *   - Charsets come from tables generated from the Go registry, not from
 *     TextDecoder, which cannot decode the corpus's only legacy charset.
 *   - Forward dates are matched against explicit patterns, never Date.parse.
 *
 * # Trust
 *
 * `subject` and `from` are CONTENT, not identity. For an inline forward they
 * are read out of the forwarded header block, which is body text anyone can
 * author. Trust decisions read the cryptographically verified signing domain
 * from the ARC/DKIM verifier and nothing from this module.
 */

import { decodeUTF8WHATWG, UnsupportedCharsetError } from "./charset.ts";
import {
  bareAddress,
  decodeWords,
  headerGet,
  MimeParseError,
  multipartParts,
  newEntity,
  rawBodyAfterHeaders,
  readHeader,
  trimExplicitBinary,
  WalkAbortError,
  asciiOfBytes,
  type Entity,
  type ParsedHeader,
} from "./mime.ts";
import { parseForwardDate, trimExplicit, unwrapForward } from "./unwrap.ts";

export { UnsupportedCharsetError } from "./charset.ts";
export { trimExplicit } from "./unwrap.ts";

/** The newest normalizer algorithm. */
export const CURRENT_VERSION = 1;

/**
 * Every normalizer version this build can run, oldest first.
 *
 * Old versions are never removed: a transaction normalized at v1 must stay
 * reproducible after v2 ships, or its template match cannot be re-verified.
 */
export function versions(): number[] {
  return [1];
}

export type PartUsed = "html" | "plain" | "raw";
export type DateSource = "forward_header" | "received";

/** Thrown for a version this build cannot run. */
export class UnknownVersionError extends Error {
  constructor(version: number) {
    super(`norm: unknown normalizer version: ${version} (supported: ${versions().join(", ")})`);
    this.name = "UnknownVersionError";
  }
}

/** Thrown when a well-formed message carries neither a text/html nor text/plain leaf. */
export class NoTextPartError extends Error {
  constructor() {
    super("norm: no text/html or text/plain part found");
    this.name = "NoTextPartError";
  }
}

export interface NormalizeResult {
  /** The normalized, unwrapped body templates match against. */
  readonly text: string;
  readonly partUsed: PartUsed;
  /** The chosen leaf's DECLARED charset, lower-cased and trimmed; "" when none. */
  readonly charset: string;
  /** EFFECTIVE subject — inner when forwarded. Content, never identity. */
  readonly subject: string;
  /** EFFECTIVE From — inner when forwarded. CONTENT ONLY, never trust. */
  readonly from: string;
  /** A forward MARKER line was found. Not that headers were recovered. */
  readonly forwarded: boolean;
  /** RFC 3339 UTC. The inner forwarded Date when parseable, else receivedAt. */
  readonly emailDate: string;
  readonly dateSource: DateSource;
}

// ---------------------------------------------------------------------------
// Stages 1-4: MIME walk, transfer decoding, charset, UTF-8 validation, choice
// ---------------------------------------------------------------------------

interface Extracted {
  body: string;
  part: PartUsed;
  charset: string;
  subject: string;
  from: string;
}

/** Collects the first non-empty text/html and text/plain leaves, depth first. */
class Walker {
  html = "";
  plain = "";
  htmlCharset = "";
  plainCharset = "";

  /** Returns the error that aborted the walk, or null. */
  walk(e: Entity): Error | null {
    if (e.mediaType.startsWith("multipart/")) {
      const boundary = e.params["boundary"] ?? "";
      try {
        for (const { header, rawBody } of multipartParts(e.rawBody, boundary)) {
          const { entity, error } = newEntity(header, rawBody);
          if (error !== null) {
            // Go surfaces an unknown charset or encoding on a SUB-PART as an
            // error out of NextPart, which aborts the walk. On the top-level
            // entity the same condition is ignored. Reproduced, not fixed.
            return new WalkAbortError(`norm: next part: ${error}`);
          }
          const err = this.walk(entity);
          if (err !== null) return err;
        }
      } catch (err) {
        if (err instanceof WalkAbortError || err instanceof MimeParseError) {
          return err;
        }
        throw err;
      }
      return null;
    }

    if (e.mediaType !== "text/html" && e.mediaType !== "text/plain") return null;

    let text: string;
    try {
      text = e.text();
    } catch (err) {
      if (err instanceof UnsupportedCharsetError) throw err;
      // An undecodable leaf (bad base64, an invalid quoted-printable byte) is
      // SKIPPED, not fatal, and its partial bytes are discarded.
      return null;
    }
    const cs = trimExplicit(e.params["charset"] ?? "").toLowerCase();
    if (e.mediaType === "text/html") {
      if (this.html === "") {
        this.html = text;
        this.htmlCharset = cs;
      }
    } else if (this.plain === "") {
      this.plain = text;
      this.plainCharset = cs;
    }
    return null;
  }
}

/** Stages 1-4. */
function extract(raw: Uint8Array): Extracted {
  let header: ParsedHeader;
  try {
    header = readHeader(raw, 0);
  } catch (err) {
    if (!(err instanceof MimeParseError)) throw err;
    // Stage 1: unrecoverable MIME parse error. v1 gives up here and the message
    // becomes `unparsed` with NO body recorded at all; the drop policy makes
    // that unacceptable, so v2 falls back to the raw body.
    return rawFallback(raw);
  }

  const subject = decodeWords(headerGet(header, "subject"));
  const from = bareAddress(decodeWords(headerGet(header, "from")), trimExplicit);

  const { entity } = newEntity(header, raw.subarray(header.bodyStart));
  const walker = new Walker();
  const werr = walker.walk(entity);

  if (walker.html !== "") {
    return { body: walker.html, part: "html", charset: walker.htmlCharset, subject, from };
  }
  if (walker.plain !== "") {
    return { body: walker.plain, part: "plain", charset: walker.plainCharset, subject, from };
  }
  if (werr !== null) {
    // The tree broke apart before any text leaf was reached. Same reasoning as
    // stage 1: record the raw body rather than nothing.
    return rawFallback(raw);
  }
  throw new NoTextPartError();
}

function rawFallback(raw: Uint8Array): Extracted {
  const { subject, from } = scanRawHeaders(raw);
  return { body: decodeUTF8WHATWG(rawBodyAfterHeaders(raw)), part: "raw", charset: "", subject, from };
}

/**
 * Recovers Subject and From from a message whose MIME structure did not parse.
 *
 * Used ONLY on the raw-fallback path. Folding is undone by joining a
 * continuation line to its predecessor with a single U+0020 after trimming,
 * which keeps adjacent RFC 2047 words adjacent.
 */
function scanRawHeaders(raw: Uint8Array): { subject: string; from: string } {
  const body = rawBodyAfterHeaders(raw);
  const head = body.length < raw.length ? raw.subarray(0, raw.length - body.length) : raw;
  // Byte string, not decoded text: decodeWords below owns the UTF-8 conversion,
  // exactly as it does on the parsed-header path.
  const s = asciiOfBytes(head).replaceAll("\r\n", "\n");

  const fields: string[] = [];
  for (const line of s.split("\n")) {
    if (line === "") continue;
    if ((line[0] === " " || line[0] === "\t") && fields.length > 0) {
      fields[fields.length - 1] += " " + trimExplicitBinary(line);
      continue;
    }
    fields.push(line);
  }
  let subject = "";
  let from = "";
  for (const f of fields) {
    const i = f.indexOf(":");
    if (i < 0) continue;
    const name = trimExplicitBinary(f.slice(0, i)).toLowerCase();
    const value = f.slice(i + 1);
    if (name === "subject" && subject === "") subject = decodeWords(value);
    else if (name === "from" && from === "") from = bareAddress(decodeWords(value), trimExplicit);
  }
  return { subject, from };
}

// ---------------------------------------------------------------------------
// Stages 5-9: HTML strip, entities, whitespace, trim, join
// ---------------------------------------------------------------------------

const scriptRe = /<script[^>]*>.*?<\/script>/gis;
const styleRe = /<style[^>]*>.*?<\/style>/gis;
const tagRe = /<[^>]+>/gs;
const wsRe = /[\u0020\u0009\u00a0]+/g;

/**
 * The five closing/void tags that become a newline BEFORE the generic tag rule.
 * The list is exactly v1's: short, because it was grown from real bank mail
 * rather than from the HTML spec. Case-SENSITIVE, exactly these five.
 */
const BLOCK_TAGS = ["<br>", "<br/>", "</p>", "</tr>", "</div>"];

function stripHTML(s: string): string {
  let out = s.replace(scriptRe, " ").replace(styleRe, " ");
  for (const t of BLOCK_TAGS) out = out.replaceAll(t, "\n");
  return out.replace(tagRe, "\n");
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const entityRe = /&(?:nbsp|amp|lt|gt|quot|#39);/g;

/**
 * Decodes exactly six entities in ONE left-to-right pass that never rescans
 * what it just emitted.
 *
 * The obvious spelling — six chained `.replace(/&x;/g, …)` calls — is WRONG and
 * wrong in a way no small test catches: `&amp;lt;` must normalize to `&lt;`,
 * and a chain produces `<`, because the second pass sees the `&` the first one
 * emitted. Go uses strings.Replacer, which has exactly the single-pass
 * semantics; one regex alternation with a lookup is the JavaScript equivalent.
 */
function decodeEntities(s: string): string {
  return s.replace(entityRe, (m) => ENTITIES[m]!);
}

/** Stages 6-9. */
function collapse(s: string): string {
  const decoded = decodeEntities(s).replace(wsRe, " ");
  const lines: string[] = [];
  for (const l of decoded.split("\n")) {
    const t = trimExplicit(l);
    if (t !== "") lines.push(t);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

const pad = (n: number, w: number): string => `${n}`.padStart(w, "0");

/** RFC 3339 in UTC with no fractional seconds, matching Go's time.RFC3339. */
function formatRFC3339UTC(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
    `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}Z`
  );
}

/**
 * Runs the given normalizer version over a raw RFC822 message.
 *
 * `receivedAt` is the mailbox arrival time as an RFC 3339 string, used as
 * `emailDate` whenever no inner forwarded Date is recoverable.
 *
 * Throws {@link UnknownVersionError}, {@link NoTextPartError} or
 * {@link UnsupportedCharsetError}.
 */
export function normalize(version: number, raw: Uint8Array, receivedAt: string): NormalizeResult {
  if (version !== CURRENT_VERSION) throw new UnknownVersionError(version);

  const ex = extract(raw);

  // Stages 5-9. Only an HTML leaf is stripped; a text/plain leaf and the raw
  // fallback reach the entity decoder as-is, exactly as v1 does.
  const body = ex.part === "html" ? stripHTML(ex.body) : ex.body;
  const text = collapse(body);

  // Stage 10.
  const fwd = unwrapForward(ex.from, ex.subject, text);

  const parsed = fwd.date === "" ? null : parseForwardDate(fwd.date);
  const received = new Date(receivedAt);
  return {
    text: fwd.body,
    partUsed: ex.part,
    charset: ex.charset,
    subject: fwd.subject,
    from: fwd.from,
    forwarded: fwd.found,
    emailDate: formatRFC3339UTC(parsed ?? received),
    dateSource: parsed !== null ? "forward_header" : "received",
  };
}
