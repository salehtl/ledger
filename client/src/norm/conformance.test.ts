/**
 * The cross-executor conformance runner.
 *
 * Everything in conformance/normalizer/ was produced by the GO normalizer. This
 * file runs the TypeScript one over the same bytes and demands the same answer.
 * A disagreement fails `bun test`, which fails scripts/v2-check.sh, which is
 * this repository's build — that is what "disagreement fails the build" means
 * with no CI service.
 *
 * Two fixture families, and the distinction matters:
 *
 *   - `*.json` — 37 cases of REAL bank mail, byte-exact original RFC822 cut
 *     from the operator's own 7,002-message v1 corpus by an explicit id list.
 *     Four are marked DERIVED: a real message mutated in exactly one named way,
 *     because the corpus holds no natural sample of the shape.
 *   - `edge-cases.json` — 88 SYNTHETIC cases for the input classes the corpus
 *     contains zero of: quoted-printable leniency, malformed base64, unknown
 *     charsets and transfer encodings, broken MIME trees, header recovery.
 *     Real mail cannot pin those, and an unpinned class is where two
 *     implementations quietly drift apart.
 *
 * Expectations are LITERAL — base64 of the exact bytes Go produced — never
 * derived by running some shared helper over the input. A conformance harness
 * that recomputes the expectation cannot see a defect in the thing it is
 * checking.
 */

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { normalize, NoTextPartError, CURRENT_VERSION, versions, UnknownVersionError } from "./norm.ts";

const dir = `${import.meta.dir}/../../../conformance/normalizer`;

const b64ToBytes = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "base64"));
const utf8ToB64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Shows the first difference of two long strings, so a 4 KB Arabic body is readable. */
function firstDiff(got: string, want: string): string {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  const lo = Math.max(0, i - 40);
  const win = (s: string) => JSON.stringify(s.slice(lo, i + 40));
  return `first difference at index ${i}\n got ${win(got)}\nwant ${win(want)}`;
}

// ---------------------------------------------------------------------------
// The corpus fixtures
// ---------------------------------------------------------------------------

interface CorpusCase {
  name: string;
  normalizer_version: number;
  received_at: string;
  raw_base64: string;
  expect_text_base64: string;
  expect_part: string;
  expect_charset: string;
  expect_subject_base64: string;
  expect_from_base64: string;
  expect_forwarded: boolean;
  expect_email_date: string;
  expect_date_source: string;
}

const corpusFiles = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "edge-cases.json")
  .sort();

test("the corpus fixture set has not quietly shrunk", () => {
  expect(corpusFiles.length).toBeGreaterThanOrEqual(30);
});

for (const file of corpusFiles) {
  const c = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")) as CorpusCase;
  test(`normalizer conformance: ${c.name}`, () => {
    const got = normalize(c.normalizer_version, b64ToBytes(c.raw_base64), c.received_at);
    if (utf8ToB64(got.text) !== c.expect_text_base64) {
      throw new Error(`text mismatch: ${firstDiff(got.text, new TextDecoder().decode(b64ToBytes(c.expect_text_base64)))}`);
    }
    expect(got.partUsed).toBe(c.expect_part as typeof got.partUsed);
    expect(got.charset).toBe(c.expect_charset);
    expect(utf8ToB64(got.subject)).toBe(c.expect_subject_base64);
    expect(utf8ToB64(got.from)).toBe(c.expect_from_base64);
    expect(got.forwarded).toBe(c.expect_forwarded);
    expect(got.dateSource).toBe(c.expect_date_source as typeof got.dateSource);
    expect(got.emailDate).toBe(c.expect_email_date);
  });
}

// ---------------------------------------------------------------------------
// The synthetic edge cases
// ---------------------------------------------------------------------------

interface EdgeCase {
  name: string;
  class: string;
  note?: string;
  raw_base64: string;
  expect_error: string;
  expect_text_base64: string;
  expect_part: string;
  expect_charset: string;
  expect_subject_base64: string;
  expect_from_base64: string;
  expect_forwarded: boolean;
  expect_email_date: string;
  expect_date_source: string;
}

const edgeDoc = JSON.parse(readFileSync(`${dir}/edge-cases.json`, "utf8")) as {
  normalizer_version: number;
  received_at: string;
  cases: EdgeCase[];
};

test("every input class the corpus lacks is still covered", () => {
  const classes = new Set(edgeDoc.cases.map((c) => c.class));
  for (const required of ["quoted-printable", "base64", "transfer-encoding", "charset", "structure", "headers", "stages", "forward"]) {
    expect(classes).toContain(required);
  }
  // The raw-body fallback is the one behaviour v2 adds over v1 that no corpus
  // message exercises (0 of 7,002 fail to parse), so its absence would be
  // invisible everywhere else.
  expect(edgeDoc.cases.some((c) => c.expect_part === "raw")).toBe(true);
  expect(edgeDoc.cases.some((c) => c.expect_error === "no_text_part")).toBe(true);
  // The mutation guards. Each of these was added because a plausible defect
  // survived the whole 7,002-message corpus AND the rest of the fixture set:
  // real mail simply never exercises them.
  for (const guard of [
    "fwd-date-zone-token-is-stripped",
    "fwd-date-iso8601-is-not-a-layout",
    "fwd-date-no-at-keyword-is-not-a-layout",
    "html-block-tag-pass-precedes-generic-rule",
  ]) {
    expect(edgeDoc.cases.map((c) => c.name)).toContain(guard);
  }
});

for (const c of edgeDoc.cases) {
  test(`normalizer edge case: ${c.name}`, () => {
    const raw = b64ToBytes(c.raw_base64);
    if (c.expect_error === "no_text_part") {
      expect(() => normalize(edgeDoc.normalizer_version, raw, edgeDoc.received_at)).toThrow(NoTextPartError);
      return;
    }
    const got = normalize(edgeDoc.normalizer_version, raw, edgeDoc.received_at);
    if (utf8ToB64(got.text) !== c.expect_text_base64) {
      throw new Error(`text mismatch: ${firstDiff(got.text, new TextDecoder().decode(b64ToBytes(c.expect_text_base64)))}`);
    }
    expect(got.partUsed).toBe(c.expect_part as typeof got.partUsed);
    expect(got.charset).toBe(c.expect_charset);
    expect(utf8ToB64(got.subject)).toBe(c.expect_subject_base64);
    expect(utf8ToB64(got.from)).toBe(c.expect_from_base64);
    expect(got.forwarded).toBe(c.expect_forwarded);
    expect(got.dateSource).toBe(c.expect_date_source as typeof got.dateSource);
    expect(got.emailDate).toBe(c.expect_email_date);
  });
}

// ---------------------------------------------------------------------------
// The interface itself
// ---------------------------------------------------------------------------

test("an unknown version is an error, and old versions are never dropped", () => {
  expect(versions()).toEqual([1]);
  expect(CURRENT_VERSION).toBe(1);
  expect(() => normalize(2, new Uint8Array(0), "2026-08-01T00:00:00Z")).toThrow(UnknownVersionError);
  expect(() => normalize(0, new Uint8Array(0), "2026-08-01T00:00:00Z")).toThrow(UnknownVersionError);
});

test("the result carries nothing that could be mistaken for a verified identity", () => {
  // Result.from and Result.subject are CONTENT: for an inline forward they come
  // out of the body. The trusted-lane gate reads the ARC/DKIM signing domain and
  // nothing from this module, and the shape of the result is what keeps that
  // honest — there is no field a reviewer could mistake for an identity claim.
  const raw = Buffer.from(
    "From: a@b.c\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbody\r\n",
    "utf8",
  );
  const got = normalize(CURRENT_VERSION, Uint8Array.from(raw), "2026-08-01T00:00:00Z");
  expect(Object.keys(got).sort()).toEqual(
    ["charset", "dateSource", "emailDate", "forwarded", "from", "partUsed", "subject", "text"],
  );
});
