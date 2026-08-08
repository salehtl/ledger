/**
 * The raw private key material never outlives the call it was handed to —
 * including on the failure paths, which are the ordinary ones.
 *
 * # Why this is its own file, and not a case inside `keys.test.ts`
 *
 * Same reason as `keys.offline.test.ts`: this is a property somebody has to be
 * able to FIND before they change one of these functions, and the two defects
 * it pins were both introduced by an edit that had no idea it was in scope.
 *
 * # The shape of the defect, twice
 *
 * `AccountKeys` holds three raw private keys as `Uint8Array`s. Every function
 * that receives one is expected to destroy it, because it is the only other
 * copy — once the keys are installed, the durable form is a pair of
 * non-extractable `CryptoKey` handles and there is deliberately no way back to
 * bytes.
 *
 * Both defects were the same mistake: the zeroing sat on the SUCCESS path, as a
 * trailing pair of statements, and every early exit walked past it.
 *
 *   1. `establishAccountKeys` — the user backs out of the confirmation, or the
 *      publication call fails. Fixed once, with a try/catch.
 *   2. `recoverAccountKeys` — `authorize` is a network call that
 *      `RecoverWritePanel` already expects to fail, and `installAccountKeys`
 *      throws outright on WebKit before 17.4. Both left three live keys in the
 *      frame. Missed on the first pass precisely because the sibling had just
 *      been fixed.
 *
 * The fix that closes the class rather than the instances is in
 * `installAccountKeys` itself: a `finally`, so the caller's `AccountKeys` is
 * destroyed however that call ends, and every caller can treat one call as the
 * end of the raw bytes' life.
 *
 * # What `zero` is and is not
 *
 * It is not a guarantee — a JavaScript engine may have copied the buffer during
 * a GC move and nothing here can reach that copy. It bounds how long the LIVE
 * allocation holds a key, which is what a devtools heap snapshot and a
 * `JSON.stringify` of application state actually see.
 */

import { describe, expect, it, vi } from "vitest";
import { generateAccountKeys, wrapAccountKeys } from "@ledger/client/crypto/keys";
import { generatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";
import { installAccountKeys, memoryKeyVault, recoverAccountKeys, type KeyVault } from "./keys";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FAST = { t: 1, m: 64, p: 1 } as const;
const DEAD = "00".repeat(32);

/** Every private half of `keys`, as hex, for one assertion per key. */
const material = (keys: { ingestPriv: Uint8Array; dek: Uint8Array; recoverySeed: Uint8Array }) => ({
  ingestPriv: webPlatform.toHex(keys.ingestPriv),
  dek: webPlatform.toHex(keys.dek),
  recoverySeed: webPlatform.toHex(keys.recoverySeed),
});

/** A vault that cannot be written to — a spent quota, or no IndexedDB at all. */
const brokenVault = (): KeyVault => ({
  read: async () => null,
  write: async () => {
    throw new Error("QuotaExceededError");
  },
  clear: async () => {},
});

describe("installAccountKeys", () => {
  it("destroys the caller's key material on success", async () => {
    const keys = generateAccountKeys(webPlatform);
    await installAccountKeys(ACCOUNT, keys, memoryKeyVault());
    expect(material(keys)).toEqual({ ingestPriv: DEAD, dek: DEAD, recoverySeed: DEAD });
  });

  // The `finally`. Before it, a device that could not write to IndexedDB kept
  // three live private keys in the frame — and it is the device least able to
  // do anything about that, because it also stored nothing.
  it("destroys it when the vault write fails", async () => {
    const keys = generateAccountKeys(webPlatform);
    await expect(installAccountKeys(ACCOUNT, keys, brokenVault())).rejects.toThrow();
    expect(material(keys)).toEqual({ ingestPriv: DEAD, dek: DEAD, recoverySeed: DEAD });
  });

  // The other await in that function: `importKey`, which throws outright on a
  // browser whose WebCrypto has no X25519 — WebKit before 17.4, a device this
  // product targets.
  it("destroys it when WebCrypto refuses the key", async () => {
    const keys = generateAccountKeys(webPlatform);
    const importKey = vi.spyOn(crypto.subtle, "importKey").mockRejectedValue(new Error("NotSupportedError: X25519"));
    try {
      await expect(installAccountKeys(ACCOUNT, keys, memoryKeyVault())).rejects.toThrow();
    } finally {
      importKey.mockRestore();
    }
    expect(material(keys)).toEqual({ ingestPriv: DEAD, dek: DEAD, recoverySeed: DEAD });
  });
});

describe("recoverAccountKeys", () => {
  /** A published account and the phrase that opens it. */
  async function published() {
    const phrase = generatePhrase(webPlatform);
    const keys = generateAccountKeys(webPlatform);
    const ingestPub = Uint8Array.from(keys.ingestPub);
    const recoveryPub = Uint8Array.from(keys.recoveryPub);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
    return { phrase, published: { ingestPub, recoveryPub, wrapped, keyVersion: 1 } };
  }

  /**
   * The one observable handle on the material this function unwraps for itself:
   * the signer it hands to `authorize` closes over a copy of the recovery seed,
   * so calling it AFTER the function has settled reports whether that copy was
   * destroyed. A live signer would be a working enrolment authorizer sitting in
   * a closure for the life of the tab.
   */
  const escapedSignerIsDead = (sign: (m: Uint8Array) => Uint8Array): boolean => {
    const msg = webPlatform.utf8Encode("probe");
    return webPlatform.toHex(sign(msg)) === webPlatform.toHex(webPlatform.ed25519Sign(new Uint8Array(32), msg));
  };

  // The ordinary failure: the enrolment call is refused or the connection
  // drops. `RecoverWritePanel` catches exactly this and renders it as "those
  // words did not open your account".
  it("destroys the authorizer when the enrolment fails, and stores nothing", async () => {
    const { phrase, published: pub } = await published();
    const vault = memoryKeyVault();
    let escaped: ((m: Uint8Array) => Uint8Array) | null = null;

    await expect(
      recoverAccountKeys({
        accountId: ACCOUNT,
        phrase,
        published: pub,
        vault,
        authorize: async (sign) => {
          escaped = sign;
          throw new Error("403");
        },
      }),
    ).rejects.toThrow("403");

    expect(escapedSignerIsDead(escaped!)).toBe(true);
    expect(await vault.read()).toBeNull();
  });

  // And when the failure comes AFTER the enrolment succeeded — the vault write,
  // or WebCrypto — the same must hold. This is the path the fix-round review
  // found: only the seed copy had a `finally`.
  it("destroys everything when the install fails after a successful enrolment", async () => {
    const { phrase, published: pub } = await published();
    let escaped: ((m: Uint8Array) => Uint8Array) | null = null;
    let authorized = false;

    await expect(
      recoverAccountKeys({
        accountId: ACCOUNT,
        phrase,
        published: pub,
        vault: brokenVault(),
        authorize: async (sign) => {
          escaped = sign;
          sign(webPlatform.utf8Encode("the real enrolment"));
          authorized = true;
        },
      }),
    ).rejects.toThrow();

    expect(authorized).toBe(true);
    expect(escapedSignerIsDead(escaped!)).toBe(true);
  });

  it("destroys the authorizer on the happy path too", async () => {
    const { phrase, published: pub } = await published();
    let escaped: ((m: Uint8Array) => Uint8Array) | null = null;
    await recoverAccountKeys({
      accountId: ACCOUNT,
      phrase,
      published: pub,
      vault: memoryKeyVault(),
      authorize: async (sign) => {
        escaped = sign;
      },
    });
    expect(escapedSignerIsDead(escaped!)).toBe(true);
  });
});
