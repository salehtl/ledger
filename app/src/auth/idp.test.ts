import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  APPLE_REAUTH_GAP,
  GOOGLE_IOS_CLIENT_ID,
  IDP_APPLE,
  IDP_GOOGLE,
  IdTokenShapeError,
  MAX_ID_TOKEN_BYTES,
  NONCE_BYTES,
  NonceMismatchError,
  SCOPES,
  checkNonceClaim,
  decodeIdTokenClaims,
  expectedNonceClaim,
  googleConfig,
  googleRedirectUri,
  newNonce,
  observedNonceShape,
  reversedClientId,
  runIdpFlow,
  type IdpAuthenticator,
  type Idp,
} from "./idp.ts";
import { fromBase64, toBase64, utf8Encode } from "../platform/bytes.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A compact JWS with the given payload. The signature is never looked at. */
function jwt(payload: Record<string, unknown>): string {
  const head = b64url(utf8Encode(JSON.stringify({ alg: "RS256", kid: "test" })));
  const body = b64url(utf8Encode(JSON.stringify(payload)));
  return `${head}.${body}.${b64url(new Uint8Array([1, 2, 3]))}`;
}

function fakeRandom(fill: number): (n: number) => Uint8Array {
  return (n) => new Uint8Array(n).fill(fill);
}

// ---------------------------------------------------------------------------

describe("provider ids and scopes", () => {
  test("the provider ids are spelled the way internal/v2/auth/idp.go spells them", () => {
    // idp.go:70-71. A mismatch is a 400 bad_request on every sign-in, and the
    // server deliberately does not answer 401 for it, so nothing else in the
    // stack would report the typo.
    expect(IDP_APPLE).toBe("apple");
    expect(IDP_GOOGLE).toBe("google");
  });

  test("both providers ask for identity scopes only — no Gmail data scope", () => {
    // Two providers, not one: a fixture with one of something cannot tell
    // "the rule holds" from "the rule was applied once".
    for (const idp of [IDP_APPLE, IDP_GOOGLE] as Idp[]) {
      const scopes = SCOPES[idp];
      expect(scopes).toContain("openid");
      expect(scopes).toContain("email");
      for (const s of scopes) {
        expect(s).not.toContain("googleapis.com");
        expect(s).not.toContain("gmail");
        // Any absolute URL scope is a Google API scope; identity scopes are
        // bare words. This catches a scope nobody thought to name here.
        expect(s.startsWith("http")).toBe(false);
      }
    }
  });
});

describe("nonces", () => {
  test("a nonce is standard base64 of 32 bytes — the encoding the challenge endpoints hand out", () => {
    const n = newNonce(fakeRandom(0));
    expect(fromBase64(n)).toHaveLength(NONCE_BYTES);
    // Standard base64, not base64url: api/addresses.go re-encodes the decoded
    // challenge with StdEncoding and compares against THAT string.
    expect(newNonce((k) => new Uint8Array(k).fill(0xfb))).toContain("+");
  });

  test("the nonce comes from the injected source, and two calls differ", () => {
    let i = 0;
    const rng = (n: number) => new Uint8Array(n).fill(i++);
    expect(newNonce(rng)).not.toBe(newNonce(rng));
  });

  test("a source that returns the wrong length is refused rather than padded", () => {
    expect(() => newNonce(() => new Uint8Array(16))).toThrow(/16 bytes/);
  });

  test("Apple's claim is the hex SHA-256 of the nonce; Google's is the nonce", () => {
    // The vector is SHA-256("abc"), the same one src/screens/Shell.tsx checks
    // the platform seam against, so this cannot pass because sha256 is stubbed.
    expect(expectedNonceClaim(IDP_APPLE, "abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(expectedNonceClaim(IDP_GOOGLE, "abc")).toBe("abc");
  });

  test("Apple's expected claim is never the nonce itself — the per-provider rule, pinned", () => {
    // If a later commit makes this fail, either Apple stopped hashing or
    // somebody "fixed" the client to send the hash as the challenge — and the
    // second one is a forged challenge, not a fix.
    //
    // The server-side half of this rule is auth.nonceClaimFor, pinned against
    // the same published vector by TestNonceClaimIsComparedPerProvider. The two
    // must not drift: this claim is what Apple returns, that comparison is what
    // accepts it, and an Apple account's address rotation needs both.
    const challenge = newNonce(fakeRandom(7));
    expect(expectedNonceClaim(IDP_APPLE, challenge)).not.toBe(challenge);
    expect(APPLE_REAUTH_GAP).toContain("SHA-256");
  });

  test("the observed shape is measured, so a device log can settle which reading is true", () => {
    const n = newNonce(fakeRandom(3));
    expect(observedNonceShape(n, n)).toBe("raw");
    expect(observedNonceShape(n, expectedNonceClaim(IDP_APPLE, n))).toBe("sha256hex");
    expect(observedNonceShape(n, "something else")).toBe("other");
    expect(observedNonceShape(n, undefined)).toBe("other");
    expect(observedNonceShape(n, 42)).toBe("other");
  });
});

describe("id token decoding, which is not verification", () => {
  test("reads the payload of a well-formed compact JWS", () => {
    expect(decodeIdTokenClaims(jwt({ sub: "u1", email: "a@b.c" }))["email"]).toBe("a@b.c");
  });

  test("refuses anything that is not three base64url segments", () => {
    // Each of these must fail ON THE SEGMENT COUNT, which is why the message is
    // matched and not just the class: a four-segment token whose payload
    // happens to be well formed decodes perfectly well if the count is not
    // checked, and every other guard in this function would wave it through.
    const good = b64url(utf8Encode(JSON.stringify({ sub: "u1" })));
    expect(() => decodeIdTokenClaims(`aa.${good}`)).toThrow(/segments/);
    expect(() => decodeIdTokenClaims(`aa.${good}.cc.dd`)).toThrow(/segments/);
    expect(() => decodeIdTokenClaims(`aa.${good}.cc.dd.ee`)).toThrow(/segments/);
    expect(() => decodeIdTokenClaims("a..c")).toThrow(IdTokenShapeError);
    // Standard base64 padding is NOT base64url; accepting it would mean two
    // spellings of one token.
    expect(() => decodeIdTokenClaims("aa.YWJj=.cc")).toThrow(IdTokenShapeError);
    expect(() => decodeIdTokenClaims("aa.YWJ+.cc")).toThrow(IdTokenShapeError);
  });

  test("refuses an oversized token before decoding a byte of it", () => {
    const huge = `a.${"A".repeat(MAX_ID_TOKEN_BYTES)}.c`;
    expect(() => decodeIdTokenClaims(huge)).toThrow(/cap is/);
  });

  test("refuses a payload that is not a JSON object", () => {
    const wrap = (s: string) => `aa.${b64url(utf8Encode(s))}.cc`;
    expect(() => decodeIdTokenClaims(wrap("[1,2]"))).toThrow(/not a JSON object/);
    expect(() => decodeIdTokenClaims(wrap("null"))).toThrow(/not a JSON object/);
    expect(() => decodeIdTokenClaims(wrap('"a string"'))).toThrow(/not a JSON object/);
    expect(() => decodeIdTokenClaims(wrap("{oops"))).toThrow(/not JSON/);
  });

  test("a segment whose length is impossible for base64 is refused", () => {
    expect(() => decodeIdTokenClaims("aa.AAAAA.cc")).toThrow(IdTokenShapeError);
  });

  test("base64URL is decoded, not standard base64 — the 62nd and 63rd characters differ", () => {
    // A hand-built vector, because the payloads a test writes by hand are all
    // plain ASCII and their base64 never reaches index 62 or 63. This one does:
    // `x~xx?` puts `~` and `?` at the third byte of their groups, which is the
    // only place ASCII can produce `+` and `/` in standard base64 — and
    // therefore `-` and `_` in base64url.
    //
    // Without the translation, `fromBase64` refuses these characters outright
    // (it is strict on purpose), so every real Apple or Google token — whose
    // payloads are long enough to hit both routinely — would be rejected as
    // malformed and sign-in would fail 100% of the time on a device and 0% of
    // the time here.
    const segment = "eyJub25jZSI6Inh-eHg_Iiwic3ViIjoidTEifQ";
    expect(segment).toContain("-");
    expect(segment).toContain("_");
    const claims = decodeIdTokenClaims(`aa.${segment}.cc`);
    expect(claims["nonce"]).toBe("x~xx?");
    expect(claims["sub"]).toBe("u1");
  });
});

describe("checkNonceClaim", () => {
  const nonce = newNonce(fakeRandom(9));

  test("accepts Apple's hashed claim and Google's raw claim", () => {
    expect(checkNonceClaim(IDP_APPLE, nonce, jwt({ nonce: expectedNonceClaim(IDP_APPLE, nonce) }))["nonce"]).toBeString();
    expect(checkNonceClaim(IDP_GOOGLE, nonce, jwt({ nonce }))["nonce"]).toBe(nonce);
  });

  test("rejects each provider's claim presented in the other's shape", () => {
    // The crossing matters: accepting a raw claim from Apple would mean the
    // client cannot tell a bound token from an unbound one, and accepting a
    // hashed claim from Google would mean accepting a value we never sent.
    expect(() => checkNonceClaim(IDP_APPLE, nonce, jwt({ nonce }))).toThrow(NonceMismatchError);
    expect(() => checkNonceClaim(IDP_GOOGLE, nonce, jwt({ nonce: expectedNonceClaim(IDP_APPLE, nonce) }))).toThrow(
      NonceMismatchError,
    );
  });

  test("the error names the shape that was observed", () => {
    try {
      checkNonceClaim(IDP_APPLE, nonce, jwt({ nonce }));
      throw new Error("expected a mismatch");
    } catch (e) {
      expect(e).toBeInstanceOf(NonceMismatchError);
      expect((e as NonceMismatchError).shape).toBe("raw");
    }
  });

  test("a missing nonce claim is a mismatch, not an accept", () => {
    expect(() => checkNonceClaim(IDP_GOOGLE, nonce, jwt({ sub: "u1" }))).toThrow(NonceMismatchError);
  });

  test("a nonce claim for a DIFFERENT sign-in is refused", () => {
    const other = newNonce(fakeRandom(10));
    expect(() => checkNonceClaim(IDP_GOOGLE, nonce, jwt({ nonce: other }))).toThrow(NonceMismatchError);
  });
});

describe("Google configuration — the placeholder that is deliberately absent", () => {
  test("the client id and app.json's URL scheme agree, whichever way they are set", () => {
    // The failure this guards is specific: a plausible placeholder in ONE of
    // the two places builds, installs and launches, and fails only when a
    // finger lands on the button. Neither can be filled alone.
    const appJson = JSON.parse(readFileSync(new URL("../../app.json", import.meta.url).pathname, "utf8")) as {
      expo?: { ios?: { infoPlist?: { CFBundleURLTypes?: { CFBundleURLSchemes?: string[] }[] } } };
    };
    const schemes = (appJson.expo?.ios?.infoPlist?.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
    const googleSchemes = schemes.filter((s) => s.startsWith("com.googleusercontent.apps."));

    if (GOOGLE_IOS_CLIENT_ID === null) {
      expect(googleSchemes).toEqual([]);
    } else {
      expect(googleSchemes).toEqual([reversedClientId(GOOGLE_IOS_CLIENT_ID)]);
    }
  });

  test("googleConfig() is null while the client id is absent, so a caller must branch", () => {
    const cfg = googleConfig();
    if (GOOGLE_IOS_CLIENT_ID === null) {
      expect(cfg).toBeNull();
    } else {
      expect(cfg?.clientId).toBe(GOOGLE_IOS_CLIENT_ID);
      expect(cfg?.redirectUri).toBe(googleRedirectUri(GOOGLE_IOS_CLIENT_ID));
      expect(cfg?.scopes).toEqual(SCOPES[IDP_GOOGLE]);
    }
  });

  test("the reversed client id swaps the two halves", () => {
    expect(reversedClientId("123456-abcdef.apps.googleusercontent.com")).toBe(
      "com.googleusercontent.apps.123456-abcdef",
    );
    expect(googleRedirectUri("123456-abcdef.apps.googleusercontent.com")).toBe(
      "com.googleusercontent.apps.123456-abcdef:/oauth2redirect",
    );
  });

  test("something that is not a Google client id is refused rather than reversed", () => {
    expect(() => reversedClientId("nope")).toThrow(/not a Google client id/);
    expect(() => reversedClientId("")).toThrow(/not a Google client id/);
    // The suffix alone has an empty client half, which would produce the scheme
    // `com.googleusercontent.apps.` — a scheme every Google app would match.
    expect(() => reversedClientId(".apps.googleusercontent.com")).toThrow(/not a Google client id/);
  });
});

describe("runIdpFlow", () => {
  function authenticator(idp: Idp, cred: { idToken: string; email: string | null }): IdpAuthenticator & { saw: string[] } {
    const saw: string[] = [];
    return {
      idp,
      saw,
      isAvailable: async () => true,
      authenticate: async (nonce: string) => {
        saw.push(nonce);
        return cred;
      },
    };
  }

  test("passes the nonce straight through to the provider", async () => {
    const nonce = newNonce(fakeRandom(1));
    const a = authenticator(IDP_GOOGLE, { idToken: jwt({ nonce }), email: "x@y.z" });
    await runIdpFlow(a, nonce);
    expect(a.saw).toEqual([nonce]);
  });

  test("falls back to the token's email claim, because Apple returns it exactly once", () => {
    const nonce = newNonce(fakeRandom(2));
    const a = authenticator(IDP_APPLE, {
      idToken: jwt({ nonce: expectedNonceClaim(IDP_APPLE, nonce), email: "relay@privaterelay.appleid.com" }),
      email: null,
    });
    return runIdpFlow(a, nonce).then((got) => {
      expect(got.email).toBe("relay@privaterelay.appleid.com");
      expect(got.nonce).toBe(nonce);
    });
  });

  test("a token bound to another nonce never reaches the caller", async () => {
    const nonce = newNonce(fakeRandom(4));
    const a = authenticator(IDP_GOOGLE, { idToken: jwt({ nonce: "someone else's" }), email: null });
    await expect(runIdpFlow(a, nonce)).rejects.toBeInstanceOf(NonceMismatchError);
  });
});
