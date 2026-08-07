/**
 * The verification-code reader, pinned against hostile input.
 *
 * Ported from `app/src/lib/verificationCode.test.ts` (the Expo app is retired on
 * this branch) and extended for the provider-agnostic rework: recognition by
 * user choice rather than by a Google domain list.
 *
 * The probe corpus is `conformance/dialect/patterns.json`'s own — the same bytes
 * the template dialect is measured on, chosen because they contain CR, U+2028,
 * U+2029, U+00A0, U+000B and U+FEFF, plus a long repeated run and a string of
 * bare regex metacharacters. Reusing it rather than inventing a second corpus is
 * deliberate: it is the set this project already knows finds things.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODE_DIGITS,
  couldBeConfirmation,
  heldBody,
  SCAN_BUDGET_MS,
  SCAN_LIMIT_CHARS,
  SCAN_PATTERNS,
  scanForCode,
  verifiedOuterDomain,
} from "./verificationCode";

/** vitest runs from `web/`; the corpus is the repo's, one level up. */
const CORPUS = resolve(process.cwd(), "../conformance/dialect/patterns.json");

const probes: { name: string; input: string }[] = (() => {
  const doc = JSON.parse(readFileSync(CORPUS, "utf8")) as {
    probe_inputs: { name: string; input_base64?: string }[];
  };
  return doc.probe_inputs.map((p) => ({
    name: p.name,
    input: Buffer.from(p.input_base64 ?? "", "base64").toString("utf8"),
  }));
})();

const GMAIL = [
  "Return-Path: <forwarding-noreply@google.com>",
  "From: Gmail Team <forwarding-noreply@google.com>",
  "Subject: (#123456789) Gmail Forwarding Confirmation - Receive Mail from you@example.com",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "you@example.com has requested to automatically forward mail to your email address.",
  "",
  "Confirmation code: 123456789",
  "",
  "To allow it, click the link below:",
  "https://mail-settings.google.com/mail/vf-%5BANGjdJ8abcDEF123%5D-XyZ0",
  "",
].join("\r\n");

// ---------------------------------------------------------------------------
// Task 1 — recognition by choice, not by a domain list
// ---------------------------------------------------------------------------

describe("couldBeConfirmation", () => {
  const item = (outerDomain: string, innerDomain = "", attested = true) => ({
    outerDomain,
    innerDomain,
    attested,
  });

  it("qualifies a Google-sealed message with no inner origin", () => {
    expect(couldBeConfirmation(item("google.com"))).toBe(true);
    expect(couldBeConfirmation(item("mail.google.com"))).toBe(true);
  });

  /**
   * THE bug this replaces. `isForwarderConfirmation` required a Google domain,
   * so a Fastmail, Proton, Yahoo or iCloud confirmation was invisible — the user
   * sat on "Waiting for Google's confirmation" forever with the message already
   * held one component away.
   */
  it("qualifies any other verified provider just the same", () => {
    for (const d of ["fastmail.com", "icloud.com", "protonmail.ch", "yahoo.com", "mx.bank.example"]) {
      expect({ d, ok: couldBeConfirmation(item(d)) }).toEqual({ d, ok: true });
    }
  });

  /** An envelope-derived name the sender asserted and nothing checked. */
  it("refuses an unverified: domain in either spelling", () => {
    expect(couldBeConfirmation(item("unverified:google.com"))).toBe(false);
    expect(couldBeConfirmation(item("UNVERIFIED:google.com"))).toBe(false);
    expect(couldBeConfirmation(item(""))).toBe(false);
    expect(couldBeConfirmation(item("   "))).toBe(false);
  });

  /** Decoded as `=== true`, so a field this build failed to read never qualifies. */
  it("refuses a message nothing attested", () => {
    expect(couldBeConfirmation(item("google.com", "", false))).toBe(false);
  });

  /**
   * An attested inner origin means the CONTENT was signed by someone the outer
   * hop only relayed — a bank behind a forwarder. That is the bank's mail, and
   * it has its own control.
   */
  it("refuses a message with an inner origin", () => {
    expect(couldBeConfirmation(item("google.com", "dib.ae"))).toBe(false);
    expect(couldBeConfirmation(item("google.com", " dib.ae "))).toBe(false);
  });
});

describe("verifiedOuterDomain", () => {
  it("is the folded outer domain when, and only when, it is verified", () => {
    expect(verifiedOuterDomain({ outerDomain: "Mail.Google.COM.", attested: true })).toBe("mail.google.com");
    expect(verifiedOuterDomain({ outerDomain: "unverified:dib.ae", attested: true })).toBeNull();
    expect(verifiedOuterDomain({ outerDomain: "dib.ae", attested: false })).toBeNull();
    expect(verifiedOuterDomain({ outerDomain: "", attested: true })).toBeNull();
  });

  /** Not a hostname, so nothing built from it could be one either. */
  it("refuses anything that is not a bare hostname", () => {
    for (const d of ["dib.ae/evil", "dib.ae:8080", "a@dib.ae", "dib ae", "dib.ae?x", `${"a".repeat(254)}.ae`]) {
      expect({ d, got: verifiedOuterDomain({ outerDomain: d, attested: true }) }).toEqual({ d, got: null });
    }
  });
});

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

describe("shape of the patterns", () => {
  /**
   * No unbounded quantifier, measured on the `source` of every pattern rather
   * than promised in a comment. The scan walks the pattern, skipping escaped
   * characters and the interior of a character class (a star or plus inside
   * `[...]` is a literal), and fails on `+`, `*` or an open-ended `{n,}`.
   */
  it("contains no unbounded quantifier", () => {
    for (const re of SCAN_PATTERNS) {
      const src = re.source;
      let inClass = false;
      for (let i = 0; i < src.length; i++) {
        const c = src[i] as string;
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
        expect({ pattern: src, at: i, char: c }).not.toEqual({ pattern: src, at: i, char: "+" });
        expect({ pattern: src, at: i, char: c }).not.toEqual({ pattern: src, at: i, char: "*" });
        if (c === "{") {
          const close = src.indexOf("}", i);
          expect(close).toBeGreaterThan(i);
          const body = src.slice(i + 1, close);
          expect({ pattern: src, bound: body, openEnded: /^\d+,$/.test(body) }).toEqual({
            pattern: src,
            bound: body,
            openEnded: false,
          });
          i = close;
        }
      }
    }
  });

  it("starts every pattern with literal text, so a miss is a literal scan", () => {
    for (const re of SCAN_PATTERNS) {
      expect({ pattern: re.source, literal: /^[A-Za-z\\]/.test(re.source) }).toEqual({
        pattern: re.source,
        literal: true,
      });
    }
  });
});

describe("the corpus this project already knows finds things", () => {
  it("actually loaded", () => {
    // A corpus that silently failed to load is a suite that passes for the
    // wrong reason — the exact "true by construction" shape.
    expect(probes.length).toBeGreaterThan(15);
    expect(probes.some((p) => p.name === "repeated-a")).toBe(true);
    expect(probes.some((p) => p.name === "metacharacters")).toBe(true);
  });

  it("yields no code, no link, and no slow scan on any probe", () => {
    for (const probe of probes) {
      const started = performance.now();
      const got = scanForCode(probe.input);
      const took = performance.now() - started;
      expect({ name: probe.name, code: got.code, link: got.link }).toEqual({
        name: probe.name,
        code: null,
        link: null,
      });
      expect({ name: probe.name, slow: took > 100 }).toEqual({ name: probe.name, slow: false });
      expect(got.overBudget).toBe(false);
    }
  });
});

describe("scanForCode", () => {
  it("reads Gmail's code and its link", () => {
    const got = scanForCode(GMAIL);
    expect(got.code).toBe("123456789");
    expect(got.code?.length).toBe(CODE_DIGITS);
    expect(got.link).toBe("https://mail-settings.google.com/mail/vf-%5BANGjdJ8abcDEF123%5D-XyZ0");
    expect(got.truncated).toBe(false);
    expect(got.overBudget).toBe(false);
  });

  it("does not offer a link on any other host", () => {
    const got = scanForCode("Confirmation code: 123456789\nhttps://mail-settings.google.com.evil.example/mail/vf-x");
    expect(got.code).toBe("123456789");
    expect(got.link).toBeNull();
  });

  /**
   * THE bound, measured against the LITERAL 8192 rather than against the
   * module's own constant: written the other way first, a mutation raising
   * SCAN_LIMIT_CHARS to 65536 survived the whole suite.
   */
  it("the limit IS 8192", () => {
    expect(SCAN_LIMIT_CHARS).toBe(8192);
  });

  it("scans at most the first 8192 characters and says when it stopped short", () => {
    const late = scanForCode(`${"x".repeat(8192)}Confirmation code: 123456789`);
    expect(late.code).toBeNull();
    expect(late.truncated).toBe(true);
    expect(late.body.length).toBe(8192);

    const early = scanForCode(`${"x".repeat(8152)}Confirmation code: 123456789${"x".repeat(8192)}`);
    expect(early.code).toBe("123456789");
    expect(early.truncated).toBe(true);
  });

  /**
   * The tripwire fires, and firing STOPS the scan. The body's code is reachable
   * only by the second (case-insensitive) pattern, so a clock that jumps past
   * the budget after the first must produce a null code. If the guard were
   * decorative this returns a code and the test fails.
   */
  it("stops the scan on a clock past the budget instead of merely reporting it", () => {
    const body = "CONFIRMATION CODE ... 123456789";
    expect(scanForCode(body).code).toBe("123456789");

    let calls = 0;
    const jumpy = () => {
      calls += 1;
      return calls <= 2 ? 0 : SCAN_BUDGET_MS + 1;
    };
    const got = scanForCode(body, jumpy);
    expect(got.code).toBeNull();
    expect(got.overBudget).toBe(true);
    expect(got.link).toBeNull();
  });

  it("treats a body with nothing in it as a clean miss, not a throw", () => {
    const bom = String.fromCharCode(0xfeff);
    for (const body of ["", "   ", "Confirmation code:", bom]) {
      const got = scanForCode(body);
      expect(got.code).toBeNull();
      expect(got.body).toBe(body);
    }
  });

  /**
   * Adversarial timing, on the shapes that broke this project before: a long
   * run of the literal anchor with no digits after it, a long repeated
   * character, and a run of bare metacharacters. All are subjects that FAIL,
   * which is the case a backtracking engine pays for.
   */
  it("keeps pathological subjects in single-digit milliseconds", () => {
    const hostile: [string, string][] = [
      ["repeated anchor", "Confirmation code ".repeat(600)],
      ["anchor then non-digits", `Confirmation code ${"a".repeat(SCAN_LIMIT_CHARS)}`],
      ["repeated a", "a".repeat(SCAN_LIMIT_CHARS)],
      ["metacharacters", "a.b [x] (y) {z} \\ | ^ $ -".repeat(400)],
      ["near-link", `https://mail-settings.google.com/mail/${"%".repeat(SCAN_LIMIT_CHARS)}`],
      ["digit soup", "1234567 ".repeat(1000)],
    ];
    for (const [name, body] of hostile) {
      const started = performance.now();
      scanForCode(body);
      const took = performance.now() - started;
      expect({ name, slow: took > 50 }).toEqual({ name, slow: false });
    }
  });
});

describe("heldBody", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("uses the shared normalizer on a well-formed message", () => {
    const got = heldBody(b64(GMAIL), "2026-08-05T12:00:00Z");
    expect(got.source).toBe("normalized");
    expect(got.text).toContain("Confirmation code: 123456789");
    // The headers are gone: this is the body, not the raw message.
    expect(got.text).not.toContain("Return-Path");
  });

  it("falls back to raw text rather than dead-ending on a message it cannot parse", () => {
    const got = heldBody(b64("not a message at all"), "2026-08-05T12:00:00Z");
    expect(got.text.length).toBeGreaterThan(0);
  });

  it("treats a blob that is not base64 as empty, not a throw", () => {
    expect(heldBody("!!!not base64!!!", "2026-08-05T12:00:00Z")).toEqual({ text: "", source: "raw" });
  });

  it("works end to end on a Gmail message", () => {
    const body = heldBody(b64(GMAIL), "2026-08-05T12:00:00Z");
    expect(scanForCode(body.text).code).toBe("123456789");
  });
});
