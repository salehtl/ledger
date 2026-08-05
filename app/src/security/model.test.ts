import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deviceIdentity, DORMANT_NOTICE, PLAINTEXT_DISCLOSURE, SECURITY_SLOTS } from "./model.ts";

describe("dormant key UX", () => {
  test("fingerprints the public half independently and never exposes the private seed", () => { const pub = Buffer.from(Array.from({ length: 32 }, (_, i) => i)); const x = pub.toString("base64url"); const identity = deviceIdentity({ writerId: "phone-a", writers: new Map([["phone-a", { x, d: "PRIVATE-MUST-NOT-APPEAR" }]]) }); const want = createHash("sha256").update(pub).digest("hex").match(/.{1,4}/g)!.join(" "); expect(identity).toEqual({ writerId: "phone-a", fingerprint: want }); expect(JSON.stringify(identity)).not.toContain("PRIVATE"); });
  test("does not invent identity when writer selection and roster disagree", () => { expect(deviceIdentity({ writerId: null, writers: new Map() })).toBeNull(); expect(deviceIdentity({ writerId: "lost", writers: new Map() })).toBeNull(); });
  test("every future slot is explicitly dormant and no fake recovery material exists", () => { expect(SECURITY_SLOTS.map((s) => s.title)).toEqual(["Recovery phrase", "Recovery passphrase (optional)", "Verify another device"]); expect(DORMANT_NOTICE).toContain("not encrypted at rest"); expect(PLAINTEXT_DISCLOSURE).toContain("operator can read it"); expect(PLAINTEXT_DISCLOSURE).toContain("has not been decided"); expect(SECURITY_SLOTS.find((s) => s.id === "phrase")!.explanation).toContain("No phrase exists"); });
});

describe("crypto remains unreachable from the Phase 2 product blob path", () => {
  test("the product reader is pinned to plaintext v1 and imports neither ENC_V2 nor native crypto", () => { const blob = readFileSync(resolve(import.meta.dir, "../../../client/src/wire/blob.ts"), "utf8"); expect(blob).toMatch(/export const VERSION = 1;/); expect(blob).not.toContain("ENC_V2"); expect(blob).not.toContain("ledger-crypto"); expect(blob).not.toMatch(/from ["'].*bench/); });
  test("preview and production do not enable the bench build flag", () => { const eas = JSON.parse(readFileSync(resolve(import.meta.dir, "../../eas.json"), "utf8")); for (const profile of ["preview", "production"]) expect(eas.build[profile].env?.EXPO_PUBLIC_BENCH).toBeUndefined(); });
});
