import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, test } from "vitest";

import {
  BANK_NAME_RULE,
  MAX_BANK_NAME_BYTES,
  isDeclarableBankID,
  normalizeBankName,
  supportedMatch,
} from "./bank";

/**
 * The client half of the client/server bank-name conformance suite.
 *
 * `internal/v2/admin/waitlist_test.go`'s
 * `TestTheClientAndServerAgreeOnWhatABankNameIs` drives the SAME file through
 * `admin.NormalizeBank`. That shared fixture is the whole mechanism: the two
 * grammars drifted once — the client measuring 64 code points and accepting any
 * punctuation, the server measuring 64 bytes and accepting four marks — and the
 * gap was a `400 invalid_bank` a user hit on the onboarding step that gates
 * every later step, reported to them as "Try again."
 *
 * Reading the fixture from Go's own `testdata/` rather than copying it here is
 * deliberate. A copy is two files that agree until someone edits one, which is
 * precisely the failure being fixed.
 *
 * This half used to live in the retired Expo client's `app/src/lib/bank.test.ts`
 * (preserved at tag `app-expo-final`). It moved here when `app/` was removed on
 * 2026-08-10, because the gate has to sit on the client that ships — and
 * `web/src/v2/bank.ts` is that client now.
 */
interface BankCase {
  name: string;
  input: string;
  ok: boolean;
  normalized?: string;
}

// Three levels up from `web/src/v2/` is the repo root — the same hop count
// app's test made from `app/src/lib/`.
//
// `import.meta.dirname`, NOT `new URL("...", import.meta.url)`: Vite rewrites
// that second form at transform time into an asset URL served off the dev
// server (`http://localhost:3000/@fs/...`), so `fileURLToPath` gets an `http:`
// URL and throws. `import.meta.dirname` is left alone and is a real path.
const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "internal",
  "v2",
  "admin",
  "testdata",
  "bank_names.json",
);
const cases: BankCase[] = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: BankCase[] }).cases;

describe("bank name grammar: the client agrees with the server", () => {
  test("the shared fixture exercises both verdicts", () => {
    // A table of only-accepted (or only-refused) cases cannot say where the
    // boundary is; it would pass against a `normalizeBankName` that returned a
    // constant. Both sides populated is what makes every case below able to
    // fail. The Go half asserts the same thing over the same file.
    const accepted = cases.filter((c) => c.ok).length;
    expect(accepted).toBeGreaterThanOrEqual(5);
    expect(cases.length - accepted).toBeGreaterThanOrEqual(5);
  });

  for (const c of cases) {
    test(`${c.ok ? "accepts" : "refuses"}: ${c.name}`, () => {
      const got = normalizeBankName(c.input);
      if (c.ok) {
        expect({ case: c.name, got }).toEqual({ case: c.name, got: { ok: true, bank: c.normalized } });
      } else {
        expect({ case: c.name, ok: got.ok }).toEqual({ case: c.name, ok: false });
        // Every refusal has to tell the user what IS allowed. A refusal that
        // does not is the "Could not add that bank. Try again." this replaces.
        if (!got.ok) expect(got.reason.length).toBeGreaterThan(0);
      }
    });
  }
});

describe("the refusal is actionable, not just correct", () => {
  test("a name with punctuation outside the grammar names the rule", () => {
    const got = normalizeBankName("Mashreq (UAE)");
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("unreachable");
    expect(got.reason).toContain(BANK_NAME_RULE);
    // And the rule says what to type instead, not merely what went wrong.
    expect(BANK_NAME_RULE).toContain("Mashreq");
  });

  test("the length refusal reports BYTES, because that is what the server counts", () => {
    // 33 x U+00E9 is 33 code points and 66 bytes: it passes a code-point check
    // and fails the server's. The message has to be about the measure that
    // actually decided, or the user shortens by one character and fails again.
    const got = normalizeBankName("é".repeat(33));
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("unreachable");
    expect(got.reason).toContain("66 bytes");
    expect(MAX_BANK_NAME_BYTES).toBe(64);
  });

  test("the empty field is a different sentence from a malformed one", () => {
    const empty = normalizeBankName("   ");
    const malformed = normalizeBankName("Mashreq (UAE)");
    expect(empty.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    if (empty.ok || malformed.ok) throw new Error("unreachable");
    expect(empty.reason).not.toBe(malformed.reason);
  });
});

/**
 * The one known divergence, pinned so it stays known.
 *
 * Go's `strings.ToLower` is Unicode's SIMPLE case mapping and JavaScript's
 * `toLowerCase` is the FULL one. U+0130 (Turkish dotted capital I) folds to
 * `i` in Go and to `i` + U+0307 in JavaScript, so the server would store
 * `istanbul bank` and the client refuses it. The direction is the safe one —
 * the client is stricter, so the user gets an instantly-correctable message
 * with the rule on it rather than a 400 they cannot act on, and the bank step's
 * "Continue without adding it" is still there regardless. Recorded here rather
 * than left to be rediscovered.
 */
test("known residual: the client is stricter than the server for U+0130", () => {
  expect([..."İ".toLowerCase()].length).toBe(2);
  expect(normalizeBankName("İstanbul Bank").ok).toBe(false);
});

describe("isDeclarableBankID", () => {
  it("accepts the ids the published templates actually use", () => {
    for (const id of ["dib", "enbd", "adcb", "fab", "mashreq", "rakbank"]) {
      expect(isDeclarableBankID(id)).toBe(true);
    }
  });

  it("refuses an id the waitlist grammar cannot store — the one that THREW", () => {
    // `bankDeclaredOps("adib_uae")` throws, and a throw inside an onClick
    // unmounts the tree: there is no error boundary in web/src.
    expect(normalizeBankName("adib_uae").ok).toBe(false);
    expect(isDeclarableBankID("adib_uae")).toBe(false);
  });

  it("refuses an id that only survives by being CHANGED, which is the quiet one", () => {
    // "DIB" folds to "dib", so the declared key stops matching the row it came
    // from: two rows for one bank, and the ticked one cannot be unticked.
    expect(normalizeBankName("DIB")).toEqual({ ok: true, bank: "dib" });
    expect(isDeclarableBankID("DIB")).toBe(false);
    expect(isDeclarableBankID("dubai  islamic")).toBe(false);
  });
});

describe("supportedMatch", () => {
  const supported = ["dib", "enbd"];

  it("matches a typed display name onto the id already on the list", () => {
    expect(supportedMatch("dubai islamic bank", supported)).toBe("dib");
    expect(supportedMatch("dib", supported)).toBe("dib");
  });

  it("is null for a bank that really is not supported", () => {
    expect(supportedMatch("mashreq", supported)).toBeNull();
  });
});
