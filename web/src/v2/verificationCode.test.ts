/**
 * The verification-code reader, pinned against hostile input.
 *
 * Ported from `app/src/lib/verificationCode.test.ts` (the Expo app is retired on
 * this branch) and then extended for the provider-agnostic rework: recognition
 * by user choice rather than by a Google domain list, and a link host taken from
 * the message's own VERIFIED signing domain rather than from a literal in the
 * pattern.
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

import type { QuarantineItem } from "./onboardingIO";
import {
  CODE_DIGITS,
  confirmationTask,
  couldBeConfirmation,
  heldBody,
  linkPattern,
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

const GOOGLE = "google.com";

/** The Gmail body scanned with the host Gmail's own confirmation links live on. */
const gmailScan = () => scanForCode(GMAIL, { linkHost: GOOGLE });

// ---------------------------------------------------------------------------
// Task 1 — recognition by choice, not by a domain list
// ---------------------------------------------------------------------------

describe("couldBeConfirmation", () => {
  const item = (outerDomain: string, innerDomain = "", dkim = "pass", arc = "pass") => ({
    outerDomain,
    innerDomain,
    dkim,
    arc,
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

  /** Compared as `=== "pass"`, so a verdict this build failed to read never qualifies. */
  it("refuses a message no signature verified", () => {
    expect(couldBeConfirmation(item("google.com", "", "fail", "none"))).toBe(false);
    expect(couldBeConfirmation(item("google.com", "", "none", "none"))).toBe(false);
    expect(couldBeConfirmation(item("google.com", "", "", ""))).toBe(false);
  });

  /** Either signature alone is enough — they are alternatives, not a pair. */
  it("qualifies on DKIM alone, and on ARC alone", () => {
    expect(couldBeConfirmation(item("google.com", "", "pass", "none"))).toBe(true);
    expect(couldBeConfirmation(item("google.com", "", "none", "pass"))).toBe(true);
  });

  /**
   * THE live bug, 2026-08-09, which blocked the operator out of his own app.
   *
   * Gmail's forwarding confirmation is sent DIRECT from google.com: dkim=pass,
   * arc=pass, and `attested=false`, because attestation means "a bank is visible
   * BEHIND a relay" and a direct message has no relay. The old predicate began
   * `if (!item.attested) return null`, so the one message onboarding cannot
   * proceed without was the one message it refused to offer. Shape taken from the
   * real held row.
   */
  it("qualifies Gmail's own confirmation, which is direct and therefore unattested", () => {
    const realShape = { outerDomain: "google.com", innerDomain: "", dkim: "pass", arc: "pass" };
    expect(couldBeConfirmation(realShape)).toBe(true);
    expect(verifiedOuterDomain(realShape)).toBe("google.com");
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
    const pass = { dkim: "pass", arc: "pass" };
    expect(verifiedOuterDomain({ outerDomain: "Mail.Google.COM.", ...pass })).toBe("mail.google.com");
    expect(verifiedOuterDomain({ outerDomain: "unverified:dib.ae", ...pass })).toBeNull();
    expect(verifiedOuterDomain({ outerDomain: "dib.ae", dkim: "fail", arc: "none" })).toBeNull();
    expect(verifiedOuterDomain({ outerDomain: "", ...pass })).toBeNull();
  });

  /** Not a hostname, so nothing built from it could be one either. */
  it("refuses anything that is not a bare hostname", () => {
    for (const d of ["dib.ae/evil", "dib.ae:8080", "a@dib.ae", "dib ae", "dib.ae?x", `${"a".repeat(254)}.ae`]) {
      expect({ d, got: verifiedOuterDomain({ outerDomain: d, dkim: "pass", arc: "pass" }) }).toEqual({ d, got: null });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2 — a link host taken from the signature, not from the body
// ---------------------------------------------------------------------------

describe("the link host comes from the caller, never from the body", () => {
  it("returns a link on the verified host", () => {
    expect(gmailScan().link).toBe("https://mail-settings.google.com/mail/vf-%5BANGjdJ8abcDEF123%5D-XyZ0");
  });

  it("returns a link on the verified domain itself, not only a subdomain", () => {
    const got = scanForCode("Confirmation code: 123456\nhttps://fastmail.com/settings/forward/abc", {
      linkHost: "fastmail.com",
    });
    expect(got.link).toBe("https://fastmail.com/settings/forward/abc");
  });

  /** Ordering must not decide it: the first URL in the body is the attacker's. */
  it("ignores a link on a different host even when it comes first", () => {
    const body = [
      "https://evil.example/mail/steal",
      "https://mail-settings.google.com.evil.example/mail/steal",
      "https://evil-google.com/mail/steal",
      "https://google.com@evil.example/mail/steal",
      "https://mail-settings.google.com/mail/real",
    ].join("\n");
    expect(scanForCode(body, { linkHost: GOOGLE }).link).toBe("https://mail-settings.google.com/mail/real");
  });

  it("refuses a lookalike when it is the only link in the body", () => {
    for (const url of [
      "https://evil-google.com/mail/x",
      "https://google.com.evil.example/mail/x",
      "https://google.com@evil.example/mail/x",
      "http://mail-settings.google.com/mail/x",
      "https://notgoogle.com/mail/x",
    ]) {
      expect({ url, link: scanForCode(url, { linkHost: GOOGLE }).link }).toEqual({ url, link: null });
    }
  });

  /**
   * The dot is the one metacharacter a LEGAL host always contains, so it is the
   * one that proves the escaping: unescaped, `google.com` matches `googleXcom`.
   */
  it("escapes the dots in a legal host", () => {
    expect(scanForCode("https://googleXcom/mail/x", { linkHost: GOOGLE }).link).toBeNull();
    expect(scanForCode("https://mail-settingsXgoogle.com/mail/x", { linkHost: GOOGLE }).link).toBeNull();
  });

  /** The host is escaped into the pattern, so a metacharacter is text or nothing. */
  it("escapes a host rather than interpreting it", () => {
    const hostile = "a+b.example";
    // Escaped: the literal string does not appear, so nothing matches...
    expect(scanForCode("https://ab.example/x", { linkHost: hostile }).link).toBeNull();
    expect(scanForCode("https://aaab.example/x", { linkHost: hostile }).link).toBeNull();
    // ...and the host is refused outright as a non-hostname anyway.
    expect(scanForCode("https://a+b.example/x", { linkHost: hostile }).link).toBeNull();
  });

  it("returns no link at all when there is no verified host to pin it to", () => {
    for (const host of ["", "   ", "unverified:google.com"]) {
      const got = scanForCode(GMAIL, { linkHost: host });
      expect({ host, link: got.link }).toEqual({ host, link: null });
      // The code is still read, and the raw body is still offered.
      expect(got.code).toBe("123456789");
      expect(got.body.length).toBeGreaterThan(0);
    }
  });
});

describe("codes beyond Gmail's exact wording", () => {
  it("reads the wordings providers actually use, at the lengths they use", () => {
    const cases: [string, string | null][] = [
      ["Confirmation code: 123456789", "123456789"],
      ["confirmation code is 4821", "4821"],
      ["Your verification code is 90210", "90210"],
      ["Security code: 314159", "314159"],
      ["Confirm your request: 1234", "1234"],
    ];
    for (const [body, want] of cases) {
      expect({ body, code: scanForCode(body, { linkHost: "" }).code }).toEqual({ body, code: want });
    }
  });

  it("holds the run to a bounded range at both ends", () => {
    expect(CODE_DIGITS).toEqual({ min: 4, max: 12 });
    expect(scanForCode("Confirmation code: 123", { linkHost: "" }).code).toBeNull();
    // Thirteen digits: the first twelve still match, which is preferable to a
    // dead end and is what the bound means.
    expect(scanForCode("Confirmation code: 1234567890123", { linkHost: "" }).code).toBe("123456789012");
  });

  it("does not invent a code out of a bare number", () => {
    expect(scanForCode("Your balance is 123456", { linkHost: "" }).code).toBeNull();
    // The gap between the anchor and the digits is bounded too.
    expect(scanForCode(`Confirmation code${"·".repeat(40)}123456`, { linkHost: "" }).code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2 Step 5 — the shape of every pattern, measured
// ---------------------------------------------------------------------------

/**
 * A pattern's `source`, split into the tokens the rules are about.
 *
 * Groups are TRANSPARENT: `(` `)` `(?:` contribute nothing, so the class inside
 * a capture group counts as adjacent to the class before it — which is exactly
 * the pair that matters (`[^0-9]{0,16}([0-9]{4,12})`) and exactly the pair a
 * naive scanner would miss.
 */
interface Token {
  kind: "class" | "literal";
  /** The class source including brackets, e.g. `[^0-9]`. Empty for a literal. */
  source: string;
  /** `{n,m}`, `?`, or "" — the quantifier attached to this token. */
  quantifier: string;
}

function tokenize(src: string): { tokens: Token[]; problems: string[] } {
  const tokens: Token[] = [];
  const problems: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (c === "\\") {
      tokens.push({ kind: "literal", source: src.slice(i, i + 2), quantifier: "" });
      i++;
      continue;
    }
    if (c === "+" || c === "*") {
      problems.push(`unbounded quantifier ${c} at ${String(i)}`);
      continue;
    }
    if (c === "{") {
      const close = src.indexOf("}", i);
      if (close < 0) {
        problems.push(`unterminated bound at ${String(i)}`);
        continue;
      }
      const body = src.slice(i + 1, close);
      if (/^\d+,$/.test(body)) problems.push(`open-ended bound {${body}} at ${String(i)}`);
      const last = tokens[tokens.length - 1];
      if (last !== undefined) last.quantifier = `{${body}}`;
      i = close;
      continue;
    }
    if (c === "[") {
      let j = i + 1;
      if (src[j] === "^") j++;
      if (src[j] === "]") j++;
      while (j < src.length && src[j] !== "]") {
        if (src[j] === "\\") j++;
        j++;
      }
      if (j >= src.length) {
        problems.push(`unterminated class at ${String(i)}`);
        break;
      }
      tokens.push({ kind: "class", source: src.slice(i, j + 1), quantifier: "" });
      i = j;
      continue;
    }
    // Groups are transparent; `?` after a group or token is a bounded quantifier.
    if (c === "(") {
      if (src.startsWith("(?:", i)) i += 2;
      continue;
    }
    if (c === ")") continue;
    if (c === "?") {
      const last = tokens[tokens.length - 1];
      if (last !== undefined) last.quantifier = "?";
      continue;
    }
    tokens.push({ kind: "literal", source: c, quantifier: "" });
  }
  return { tokens, problems };
}

/** A probe alphabet wide enough to catch the overlaps that matter. */
const ALPHABET = Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCharCode(0x20 + i)).concat([
  "\n",
  "\r",
  "\t",
  " ",
  " ",
  "é",
]);

function members(classSource: string): Set<string> {
  const re = new RegExp(`^${classSource}$`);
  return new Set(ALPHABET.filter((ch) => re.test(ch)));
}

/** Every rule from the module header, applied to one pattern's source. */
function shapeProblems(src: string): string[] {
  const { tokens, problems } = tokenize(src);

  // Rule 1: a literal anchor.
  if (!/^[A-Za-z\\]/.test(src)) problems.push("does not start with literal text");

  // Rule 3: no quantified class adjacent to a class it intersects.
  for (let i = 0; i < tokens.length - 1; i++) {
    const a = tokens[i] as Token;
    const b = tokens[i + 1] as Token;
    if (a.kind !== "class" || b.kind !== "class") continue;
    if (a.quantifier === "" && b.quantifier === "") continue;
    const shared = [...members(a.source)].filter((ch) => members(b.source).has(ch));
    if (shared.length > 0) {
      problems.push(`${a.source}${a.quantifier} is adjacent to ${b.source}${b.quantifier} and they overlap`);
    }
  }
  return problems;
}

describe("the shape of every pattern, measured rather than asserted in a comment", () => {
  it("holds for every pattern this module will run", () => {
    for (const re of SCAN_PATTERNS) {
      expect({ pattern: re.source, problems: shapeProblems(re.source) }).toEqual({
        pattern: re.source,
        problems: [],
      });
    }
  });

  /**
   * The checker can fail. Without this the suite above is a green light for
   * "nothing was checked" — the exact true-by-construction shape this project
   * keeps finding.
   */
  it("fails on each shape it exists to reject", () => {
    expect(shapeProblems("Code[a-z]+")).toContain("unbounded quantifier + at 9");
    expect(shapeProblems("Code[a-z]*")).toContain("unbounded quantifier * at 9");
    expect(shapeProblems("Code[a-z]{2,}")).toContain("open-ended bound {2,} at 9");
    expect(shapeProblems("[a-z]{0,8}Code")).toContain("does not start with literal text");
    // The overlap rule, including through a capture group.
    expect(shapeProblems("Code[a-z]{0,8}[a-z0-9]{1,4}")).toEqual([
      "[a-z]{0,8} is adjacent to [a-z0-9]{1,4} and they overlap",
    ]);
    expect(shapeProblems("Code[^0-9]{0,16}([^a-z]{1,4})")).toEqual([
      "[^0-9]{0,16} is adjacent to [^a-z]{1,4} and they overlap",
    ]);
    // And it does NOT cry wolf on the disjoint pair the module is built on.
    expect(shapeProblems("Code[^0-9]{0,16}([0-9]{4,12})")).toEqual([]);
  });

  /**
   * The link pattern is BUILT, so its shape depends on the host it was built
   * from. A host that reached the pattern unescaped would show up here as a
   * quantifier, which is why the exported set carries a metacharacter probe.
   */
  it("holds for a link pattern built from a hostile host", () => {
    for (const host of ["a+b.example", "a*b.example", "a{1,9}b.example", "(a|b).example", "[a-z].example"]) {
      const built = linkPattern(host);
      expect({ host, built: built === null }).toEqual({ host, built: true });
    }
    // Built from a legal host, the shape still holds.
    expect(shapeProblems((linkPattern("mail-settings.google.com") as RegExp).source)).toEqual([]);
  });

  it("pins scheme and path separator as literals in the built pattern", () => {
    const src = (linkPattern(GOOGLE) as RegExp).source;
    expect(src.startsWith("https:\\/\\/")).toBe(true);
    expect(src).toContain("google\\.com\\/");
  });
});

// ---------------------------------------------------------------------------
// The bounds
// ---------------------------------------------------------------------------

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
      const got = scanForCode(probe.input, { linkHost: GOOGLE });
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
    const got = gmailScan();
    expect(got.code).toBe("123456789");
    expect(got.truncated).toBe(false);
    expect(got.overBudget).toBe(false);
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
    const late = scanForCode(`${"x".repeat(8192)}Confirmation code: 123456789`, { linkHost: GOOGLE });
    expect(late.code).toBeNull();
    expect(late.truncated).toBe(true);
    expect(late.body.length).toBe(8192);

    const early = scanForCode(`${"x".repeat(8152)}Confirmation code: 123456789${"x".repeat(8192)}`, {
      linkHost: GOOGLE,
    });
    expect(early.code).toBe("123456789");
    expect(early.truncated).toBe(true);
  });

  /**
   * The tripwire fires, and firing STOPS the scan. The body's code is reachable
   * only by a later pattern, so a clock that jumps past the budget after the
   * first must produce a null code. If the guard were decorative this returns
   * a code and the test fails.
   */
  it("stops the scan on a clock past the budget instead of merely reporting it", () => {
    const body = "Security code ... 123456789";
    expect(scanForCode(body, { linkHost: GOOGLE }).code).toBe("123456789");

    let calls = 0;
    const jumpy = () => {
      calls += 1;
      return calls <= 2 ? 0 : SCAN_BUDGET_MS + 1;
    };
    const got = scanForCode(body, { linkHost: GOOGLE, now: jumpy });
    expect(got.code).toBeNull();
    expect(got.overBudget).toBe(true);
    expect(got.link).toBeNull();
  });

  it("treats a body with nothing in it as a clean miss, not a throw", () => {
    const bom = String.fromCharCode(0xfeff);
    for (const body of ["", "   ", "Confirmation code:", bom]) {
      const got = scanForCode(body, { linkHost: GOOGLE });
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
      ["subdomain soup", `https://${"a.".repeat(2000)}google.com/mail/x`],
      ["dotted labels", `https://${"a.".repeat(4000)}`],
      ["digit soup", "1234567 ".repeat(1000)],
    ];
    for (const [name, body] of hostile) {
      const started = performance.now();
      scanForCode(body, { linkHost: GOOGLE });
      const took = performance.now() - started;
      expect({ name, slow: took > 50 }).toEqual({ name, slow: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Task 4 — the pieces, composed: which held message, which link, one answer
// ---------------------------------------------------------------------------

describe("confirmationTask", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const GMAIL_CONFIRM_BODY = GMAIL;

  /** A full held row with the live Gmail confirmation's shape as the default. */
  function heldItem(over: Partial<QuarantineItem>): QuarantineItem {
    return {
      id: "held-1",
      ingestId: "ing-1",
      receivedAt: "2026-08-09T12:00:00Z",
      expiresAt: "2026-09-08T12:00:00Z",
      warnedAt: null,
      deleteAfter: null,
      outerDomain: "google.com",
      innerDomain: "",
      attested: false,
      attestedBy: "",
      dkim: "pass",
      arc: "pass",
      sizeBucket: 1,
      ...over,
    };
  }

  it("finds the newest confirmation and its pinned link", () => {
    const items = [
      heldItem({ id: "old", receivedAt: "2026-08-09T10:00:00Z", outerDomain: "google.com", dkim: "pass", arc: "pass", blob: b64(GMAIL_CONFIRM_BODY) }),
      heldItem({ id: "new", receivedAt: "2026-08-09T15:15:34Z", outerDomain: "google.com", dkim: "pass", arc: "pass", blob: b64(GMAIL_CONFIRM_BODY) }),
      heldItem({ id: "bank", innerDomain: "dib.ae", attested: true }), // never a candidate
    ];
    const task = confirmationTask(items);
    expect(task?.itemId).toBe("new");
    expect(task?.url).toMatch(/^https:\/\/([a-z0-9-]+\.){0,4}google\.com\//);
  });

  it("returns null when nothing could be a confirmation", () => {
    expect(confirmationTask([heldItem({ outerDomain: "gmail.com", dkim: "fail", arc: "none" })])).toBeNull();
  });

  /**
   * The scan runs with the item's VERIFIED domain as the pinned host, so an
   * attacker's link in the same body — even one that comes first — is never the
   * url. A composition that scanned unpinned would return `evil.example` here.
   */
  it("never offers an attacker's link, even when it comes first in the body", () => {
    const body = [
      "Confirmation code: 123456",
      "https://evil.example/mail/steal",
      "https://mail-settings.google.com/mail/real",
    ].join("\n");
    const task = confirmationTask([heldItem({ blob: b64(body) })]);
    expect(task?.url).toBe("https://mail-settings.google.com/mail/real");
    expect(task?.code).toBe("123456");
  });

  /**
   * A row fetched without its blob still names the task: the screen falls back
   * to opening held mail, and a null here would be a dead end instead.
   */
  it("still names the task when the held row carries no blob", () => {
    expect(confirmationTask([heldItem({ outerDomain: "Google.COM." })])).toEqual({
      domain: "google.com",
      url: null,
      code: null,
      itemId: "held-1",
    });
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
    expect(scanForCode(body.text, { linkHost: GOOGLE }).code).toBe("123456789");
  });
});
