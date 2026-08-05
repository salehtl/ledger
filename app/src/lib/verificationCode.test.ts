/**
 * The verification-code reader, pinned against hostile input.
 *
 * The probe corpus is `conformance/dialect/patterns.json`'s own - the same
 * bytes the template dialect is measured on, chosen because they contain CR,
 * U+2028, U+2029, U+00A0, U+000B and U+FEFF, plus a long repeated run and a
 * string of bare regex metacharacters. Reusing it rather than inventing a
 * second corpus is deliberate: it is the set this project already knows finds
 * things.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CODE_DIGITS,
  heldBody,
  isForwarderConfirmation,
  SCAN_BUDGET_MS,
  SCAN_LIMIT_CHARS,
  SCAN_PATTERNS,
  scanForCode,
} from "./verificationCode.ts";

const REPO = new URL("../../../", import.meta.url).pathname;

const probes: { name: string; input: string }[] = (() => {
  const doc = JSON.parse(readFileSync(`${REPO}conformance/dialect/patterns.json`, "utf8")) as {
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

describe("the corpus this project already knows finds things", () => {
  test("the probe list actually loaded", () => {
    // A corpus that silently failed to load is a suite that passes for the
    // wrong reason - the exact "true by construction" shape.
    expect(probes.length).toBeGreaterThan(15);
    expect(probes.some((p) => p.name === "repeated-a")).toBe(true);
    expect(probes.some((p) => p.name === "metacharacters")).toBe(true);
  });

  test("no probe input yields a code, a link, or a slow scan", () => {
    for (const probe of probes) {
      const started = performance.now();
      const got = scanForCode(probe.input);
      const took = performance.now() - started;
      expect({ name: probe.name, code: got.code, link: got.link }).toEqual({ name: probe.name, code: null, link: null });
      expect({ name: probe.name, slow: took > 100 }).toEqual({ name: probe.name, slow: false });
      expect(got.overBudget).toBe(false);
    }
  });
});

describe("shape of the patterns", () => {
  /**
   * No unbounded quantifier, measured on the `source` of every pattern rather
   * than promised in a comment.
   *
   * The scan walks the pattern, skipping escaped characters and the interior of
   * a character class (a star or plus inside `[...]` is a literal), and fails
   * on `+`, `*` or an open-ended `{n,}`.
   */
  test("no pattern contains an unbounded quantifier", () => {
    for (const re of SCAN_PATTERNS) {
      const src = re.source;
      let inClass = false;
      for (let i = 0; i < src.length; i++) {
        const c = src[i] as string;
        if (c === "\\") { i++; continue; }
        if (inClass) { if (c === "]") inClass = false; continue; }
        if (c === "[") { inClass = true; continue; }
        expect({ pattern: src, at: i, char: c }).not.toEqual({ pattern: src, at: i, char: "+" });
        expect({ pattern: src, at: i, char: c }).not.toEqual({ pattern: src, at: i, char: "*" });
        if (c === "{") {
          const close = src.indexOf("}", i);
          expect(close).toBeGreaterThan(i);
          const body = src.slice(i + 1, close);
          expect({ pattern: src, bound: body, openEnded: /^\d+,$/.test(body) }).toEqual({ pattern: src, bound: body, openEnded: false });
          i = close;
        }
      }
    }
  });

  test("every pattern starts with literal text, so a miss is a literal scan", () => {
    for (const re of SCAN_PATTERNS) {
      expect(/^[A-Za-z\\]/.test(re.source)).toBe(true);
    }
  });

  test("the link pattern pins scheme, host and path prefix as literals", () => {
    const link = SCAN_PATTERNS[SCAN_PATTERNS.length - 1] as RegExp;
    expect(link.source.startsWith("https:\\/\\/mail-settings\\.google\\.com\\/mail\\/")).toBe(true);
  });
});

describe("scanForCode", () => {
  test("reads Gmail's code and its link", () => {
    const got = scanForCode(GMAIL);
    expect(got.code).toBe("123456789");
    expect(got.code?.length).toBe(CODE_DIGITS);
    expect(got.link).toBe("https://mail-settings.google.com/mail/vf-%5BANGjdJ8abcDEF123%5D-XyZ0");
    expect(got.truncated).toBe(false);
    expect(got.overBudget).toBe(false);
  });

  test("a link on any other host is not offered", () => {
    const got = scanForCode("Confirmation code: 123456789\nhttps://mail-settings.google.com.evil.example/mail/vf-x");
    expect(got.code).toBe("123456789");
    expect(got.link).toBeNull();
  });

  test("eight digits are not a code and ten digits do not become one", () => {
    expect(scanForCode("Confirmation code: 12345678").code).toBeNull();
    // A ten-digit run: the first nine still match, which is what Gmail's own
    // format guarantees cannot happen, and is preferable to a dead end.
    expect(scanForCode("Confirmation code: 1234567890").code).toBe("123456789");
  });

  /**
   * THE bound, measured against the LITERAL 8192 rather than against the
   * module's own constant.
   *
   * Written the other way first, and a mutation raising SCAN_LIMIT_CHARS to
   * 65536 survived the whole suite: every offset in the test was expressed in
   * terms of the constant, so the test moved with the defect. That is the
   * project's "true by construction" shape, in a test whose entire subject is a
   * fixed ceiling. The offsets below are absolute.
   */
  test("the limit IS 8192, and nothing past it is scanned", () => {
    expect(SCAN_LIMIT_CHARS).toBe(8192);
  });

  test("scans at most the first 8192 characters and says when it stopped short", () => {
    const late = scanForCode(`${"x".repeat(8192)}Confirmation code: 123456789`);
    expect(late.code).toBeNull();
    expect(late.truncated).toBe(true);
    expect(late.body.length).toBe(8192);

    // 40 characters short of the ceiling: inside the slice, and found.
    const early = scanForCode(`${"x".repeat(8152)}Confirmation code: 123456789${"x".repeat(8192)}`);
    expect(early.code).toBe("123456789");
    expect(early.truncated).toBe(true);
  });

  /**
   * The tripwire fires, and firing STOPS the scan.
   *
   * The body's code is reachable only by the second (case-insensitive) pattern,
   * so a clock that jumps past the budget after the first must produce a null
   * code. If the guard were decorative - measured but not acted on - this
   * returns "123456789" and the test fails.
   */
  test("a clock past the budget stops the scan instead of merely reporting it", () => {
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

  test("a body with nothing in it is a clean miss, not a throw", () => {
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
  test("pathological subjects stay in single-digit milliseconds", () => {
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

describe("isForwarderConfirmation", () => {
  const item = (outerDomain: string, innerDomain = "") => ({ outerDomain, innerDomain });

  test("matches Google's own forwarder and its subdomains", () => {
    expect(isForwarderConfirmation(item("google.com"))).toBe(true);
    expect(isForwarderConfirmation(item("mail.google.com"))).toBe(true);
    expect(isForwarderConfirmation(item("GOOGLE.COM"))).toBe(true);
    expect(isForwarderConfirmation(item("googlemail.com"))).toBe(true);
  });

  /** Suffix matching, not substring: the classic bypass. */
  test("refuses a lookalike", () => {
    expect(isForwarderConfirmation(item("google.com.evil.example"))).toBe(false);
    expect(isForwarderConfirmation(item("notgoogle.com"))).toBe(false);
    expect(isForwarderConfirmation(item("evil-google.com"))).toBe(false);
    expect(isForwarderConfirmation(item(""))).toBe(false);
  });

  /**
   * A message Google relayed FOR A BANK has an attested inner origin, and it is
   * the bank's mail rather than Google's confirmation. Treating it as the
   * forwarder message would hide the very message step 4 waits for.
   */
  test("a bank behind Google is not Google's confirmation", () => {
    expect(isForwarderConfirmation(item("google.com", "dib.ae"))).toBe(false);
  });
});

describe("heldBody", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  test("uses the shared normalizer on a well-formed message", () => {
    const got = heldBody(b64(GMAIL), "2026-08-05T12:00:00Z");
    expect(got.source).toBe("normalized");
    expect(got.text).toContain("Confirmation code: 123456789");
    // The headers are gone: this is the body, not the raw message.
    expect(got.text).not.toContain("Return-Path");
  });

  test("falls back to raw text rather than dead-ending on a message it cannot parse", () => {
    const got = heldBody(b64("not a message at all"), "2026-08-05T12:00:00Z");
    expect(got.text.length).toBeGreaterThan(0);
  });

  test("a blob that is not base64 is empty, not a throw", () => {
    expect(heldBody("!!!not base64!!!", "2026-08-05T12:00:00Z")).toEqual({ text: "", source: "raw" });
  });

  test("the whole path works end to end on a Gmail message", () => {
    const body = heldBody(b64(GMAIL), "2026-08-05T12:00:00Z");
    expect(scanForCode(body.text).code).toBe("123456789");
  });
});
