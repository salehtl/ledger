/**
 * The provider registry — instructions only, and provably nothing else.
 *
 * The registry exists because the forwarding step used to be four hardcoded
 * Gmail sentences, which were wrong for everybody else. It is deliberately the
 * *weakest* thing that fixes that: a table of copy. The tests below are mostly
 * about what it must NOT become — a source of truth about a message, or an input
 * to a trust decision.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { GENERIC, PROVIDERS, providerFor } from "./providers";

describe("the provider registry", () => {
  it("gives every provider a label and at least one step", () => {
    for (const p of [...PROVIDERS, GENERIC]) {
      expect(p.id).not.toBe("");
      expect(p.label).not.toBe("");
      expect(p.steps.length).toBeGreaterThan(0);
      for (const step of p.steps) expect(step.trim()).not.toBe("");
    }
  });

  it("has no duplicate ids, and GENERIC is not one of the pickable ones", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(GENERIC.id);
  });

  /**
   * The finding that made the registry necessary: iCloud sends no code at all.
   * A screen that waits for one is a promise the flow cannot keep.
   */
  it("records that iCloud sends no confirmation code", () => {
    expect(providerFor("icloud").needsConfirmation).toBe(false);
  });

  /**
   * `needsConfirmation: false` is a claim the next screen ACTS on — it removes
   * the code affordance — so it is set only where there is evidence. Everything
   * else is `true`, which costs a user an affordance they may not need and never
   * strands one who does.
   */
  it("defaults to expecting a confirmation everywhere the evidence is not in", () => {
    for (const p of [...PROVIDERS, GENERIC]) {
      if (p.id === "icloud") continue;
      expect(p.needsConfirmation).toBe(true);
    }
  });

  /**
   * Microsoft 365 / Exchange Online blocks external auto-forwarding by default
   * as an anti-BEC control an administrator owns. Said BEFORE the user tries.
   */
  it("warns that a work Outlook account may be unable to forward at all", () => {
    const caveat = providerFor("outlook").caveat ?? "";
    expect(caveat).not.toBe("");
    expect(caveat.toLowerCase()).toMatch(/administrator|work or school/);
  });

  /**
   * The steps and the caveat used to contradict each other: step 2 said "turn on
   * forwarding and enter the address above", which forwards the WHOLE mailbox,
   * and the caveat below then retracted it by explaining that a Rule is what
   * sends only the bank's mail. A user who follows numbered steps follows the
   * numbered steps. The Rule IS the step now.
   */
  it("puts iCloud's Rule in the steps rather than in a caveat that retracts them", () => {
    const icloud = providerFor("icloud");
    const steps = icloud.steps.join(" ").toLowerCase();
    expect(steps).toMatch(/rule/);
    expect(steps).toMatch(/bank/);
    // The instruction that forwarded everything must not be a step any more.
    expect(steps).not.toMatch(/turn on forwarding/);
    // And the caveat still says why, so the whole-mailbox setting is not simply
    // discovered by a user who goes looking for "Forwarding".
    expect((icloud.caveat ?? "").toLowerCase()).toMatch(/whole mailbox/);
  });

  it("names Proton's paid-plan restriction rather than letting a user find it", () => {
    expect(providerFor("proton").caveat ?? "").not.toBe("");
  });

  it("answers an unknown id with GENERIC rather than throwing or guessing", () => {
    expect(providerFor("fastmail")).toBe(GENERIC);
    expect(providerFor("")).toBe(GENERIC);
    expect(providerFor("gmail").id).toBe("gmail");
  });

  /**
   * THE constraint. The provider a user tapped is UI state: it decides which
   * sentences are on the glass and nothing else. If it ever reached the trust
   * path it would be an attacker-influenceable input to a decision the server's
   * signature verification is supposed to own alone — "I said I use Gmail" must
   * never make a message from `google.com` any more trusted than it was.
   *
   * Asserted over source text because that is the only form of "nothing reads
   * it" a test can check: these modules cannot read what they cannot import.
   */
  it("is unreachable from every module that decides trust", () => {
    const trustPath = [
      "src/v2/verificationCode.ts",
      "src/v2/onboardingIO.ts",
      "src/v2/onboarding.ts",
      "src/screens/onboarding/Verification.tsx",
    ];
    for (const file of trustPath) {
      const src = readFileSync(resolve(process.cwd(), file), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(imports.filter((s) => s.endsWith("/providers") || s === "./providers")).toEqual([]);
    }
  });
});
