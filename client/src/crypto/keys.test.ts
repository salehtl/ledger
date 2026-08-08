/**
 * The account key material and the wrapped blob's contract.
 *
 * The wrapped blob is stored on the server and is the only copy of the account's
 * keys that ever leaves a device, so the properties under test are the ones that
 * decide whether a real financial history is recoverable: it is opaque without
 * the phrase, it is bound to its own parameters, and what one host wrapped the
 * other unwraps to the same bytes.
 */

import { describe, expect, test } from "bun:test";
import { bunPlatform } from "../platform";
import { webPlatform } from "../platform.web";
import {
  ACCOUNT_KEY_VERSION,
  KDF_ARGON2ID,
  MAX_WRAPPED_BYTES,
  WRAPPED_HEADER_BYTES,
  WRAP_KDF_PARAMS,
  WrapError,
  generateAccountKeys,
  unwrapAccountKeys,
  wrapAccountKeys,
  wrappedBlobParams,
} from "./keys";
import { generatePhrase } from "./phrase";

const P = bunPlatform;

// Cheap parameters for the tests that do not care what the KDF costs. Argon2id
// at the shipped parameters is ~1s per call and there are dozens of calls here;
// the ones that must run at the real settings say so.
const FAST = { t: 1, m: 64, p: 1 } as const;

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("generateAccountKeys", () => {
  test("produces a 32-byte X25519 private key whose public half is derived, and a 32-byte DEK", () => {
    const k = generateAccountKeys(P);
    expect(k.ingestPriv.length).toBe(32);
    expect(k.ingestPub.length).toBe(32);
    expect(k.dek.length).toBe(32);
    expect(k.recoverySeed.length).toBe(32);
    expect(k.recoveryPub.length).toBe(32);
    expect(P.toHex(P.x25519PublicKey(k.ingestPriv))).toBe(P.toHex(k.ingestPub));
    expect(P.toHex(P.ed25519PublicKey(k.recoverySeed))).toBe(P.toHex(k.recoveryPub));
  });

  test("the DEK is not the ingest key, and two accounts share nothing", () => {
    const a = generateAccountKeys(P);
    const b = generateAccountKeys(P);
    expect(P.toHex(a.dek)).not.toBe(P.toHex(a.ingestPriv));
    expect(P.toHex(a.recoverySeed)).not.toBe(P.toHex(a.dek));
    expect(P.toHex(a.recoverySeed)).not.toBe(P.toHex(a.ingestPriv));
    expect(P.toHex(a.recoverySeed)).not.toBe(P.toHex(b.recoverySeed));
    expect(P.toHex(a.dek)).not.toBe(P.toHex(b.dek));
    expect(P.toHex(a.ingestPriv)).not.toBe(P.toHex(b.ingestPriv));
  });

  test("the DEK is a usable AES-256-GCM key", async () => {
    const k = generateAccountKeys(P);
    const nonce = P.randomBytes(12);
    const sealed = await P.aesGcmSeal(k.dek, nonce, new Uint8Array(0), P.utf8Encode("hello"));
    expect(P.utf8Decode(await P.aesGcmOpen(k.dek, nonce, new Uint8Array(0), sealed))).toBe("hello");
  });
});

describe("wrapAccountKeys", () => {
  test("round-trips both keys exactly", async () => {
    const keys = generateAccountKeys(P);
    const blob = await wrapAccountKeys(PHRASE, keys, P, FAST);
    const back = await unwrapAccountKeys(PHRASE, blob, P);
    expect(P.toHex(back.ingestPriv)).toBe(P.toHex(keys.ingestPriv));
    expect(P.toHex(back.ingestPub)).toBe(P.toHex(keys.ingestPub));
    expect(P.toHex(back.dek)).toBe(P.toHex(keys.dek));
    expect(P.toHex(back.recoverySeed)).toBe(P.toHex(keys.recoverySeed));
    expect(P.toHex(back.recoveryPub)).toBe(P.toHex(keys.recoveryPub));
  });

  // The property the whole recovery-authorised enrolment rests on: a phrase
  // written down on one device reproduces a signing key the SERVER already
  // knows the public half of. If this drifted, a recovered device would present
  // a signature under a key nobody authorised and be refused — which is exactly
  // the dead end this key exists to remove.
  test("the recovery key round-trips as a working Ed25519 signer", async () => {
    const keys = generateAccountKeys(P);
    const pub = Uint8Array.from(keys.recoveryPub);
    const blob = await wrapAccountKeys(PHRASE, keys, P, FAST);
    const back = await unwrapAccountKeys(PHRASE, blob, P);
    const msg = P.utf8Encode("ledger-v2-writer-registration\x00…");
    const sig = P.ed25519Sign(back.recoverySeed, msg);
    expect(sig.length).toBe(64);
    expect(P.toHex(P.ed25519PublicKey(back.recoverySeed))).toBe(P.toHex(pub));
  });

  // The blob is stored on a server the user is being asked to trust with
  // ciphertext only. If any key byte appeared in it, everything downstream of
  // this phase would be theatre.
  test("no byte run of either key appears in the blob", async () => {
    const keys = generateAccountKeys(P);
    const blob = await wrapAccountKeys(PHRASE, keys, P, FAST);
    const hex = P.toHex(blob);
    expect(hex).not.toContain(P.toHex(keys.ingestPriv));
    expect(hex).not.toContain(P.toHex(keys.dek));
    expect(hex).not.toContain(P.toHex(keys.recoverySeed));
    // Not even a quarter of one: a framing bug that leaked the first eight
    // bytes would pass the two checks above.
    expect(hex).not.toContain(P.toHex(keys.ingestPriv.subarray(0, 8)));
    expect(hex).not.toContain(P.toHex(keys.dek.subarray(0, 8)));
    expect(hex).not.toContain(P.toHex(keys.recoverySeed.subarray(0, 8)));
  });

  test("the same keys wrap to different blobs every time", async () => {
    const keys = generateAccountKeys(P);
    const a = await wrapAccountKeys(PHRASE, keys, P, FAST);
    const b = await wrapAccountKeys(PHRASE, keys, P, FAST);
    expect(P.toHex(a)).not.toBe(P.toHex(b));
  });

  test("is small enough for the column that holds it", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    expect(blob.length).toBeLessThanOrEqual(MAX_WRAPPED_BYTES);
    expect(blob.length).toBe(WRAPPED_HEADER_BYTES + 97 + 16);
  });

  test("normalizes the phrase, so how it was typed does not matter", async () => {
    const keys = generateAccountKeys(P);
    const blob = await wrapAccountKeys(`  ${PHRASE.toUpperCase()} `, keys, P, FAST);
    const back = await unwrapAccountKeys(PHRASE, blob, P);
    expect(P.toHex(back.dek)).toBe(P.toHex(keys.dek));
  });

  test("refuses a phrase that is not a recovery phrase, rather than wrapping under it", async () => {
    const keys = generateAccountKeys(P);
    expect(wrapAccountKeys("hunter2", keys, P, FAST)).rejects.toThrow();
    // Twelve real words that fail the checksum: the case a typo produces.
    const words = PHRASE.split(" ");
    [words[0], words[1]] = [words[1]!, words[0]!];
    expect(wrapAccountKeys(words.join(" "), keys, P, FAST)).rejects.toThrow();
  });
});

describe("unwrapAccountKeys", () => {
  test("the wrong phrase is a refusal and never wrong key material", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    const other = generatePhrase(P);
    expect(unwrapAccountKeys(other, blob, P)).rejects.toThrow(WrapError);
  });

  test("a flipped bit anywhere in the blob is a refusal", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    for (let i = 0; i < blob.length; i++) {
      const corrupt = Uint8Array.from(blob);
      corrupt[i] = (corrupt[i]! ^ 0x01) & 0xff;
      expect(unwrapAccountKeys(PHRASE, corrupt, P)).rejects.toThrow(WrapError);
    }
  });

  // The reason the header is the AEAD's associated data rather than a plain
  // prefix: an attacker who could rewrite `m` down to 8 KiB would turn a
  // memory-hard KDF into a trivially searchable one, on a blob they hold.
  test("the KDF parameters are authenticated, so they cannot be weakened", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    const weakened = Uint8Array.from(blob);
    // The memory cost is a big-endian uint32 at offset 2.
    weakened[2] = 0;
    weakened[3] = 0;
    weakened[4] = 0;
    weakened[5] = 8;
    expect(unwrapAccountKeys(PHRASE, weakened, P)).rejects.toThrow(WrapError);
  });

  test("an unknown envelope version is refused by name, not decoded", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    const future = Uint8Array.from(blob);
    future[0] = 99;
    expect(unwrapAccountKeys(PHRASE, future, P)).rejects.toThrow(/version 99/);
  });

  test("an unknown KDF is refused by name", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    const future = Uint8Array.from(blob);
    future[1] = 7;
    expect(unwrapAccountKeys(PHRASE, future, P)).rejects.toThrow(/key derivation/i);
  });

  test("a truncated blob is refused rather than read past its end", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    for (const cut of [0, 1, 10, WRAPPED_HEADER_BYTES, WRAPPED_HEADER_BYTES + 15, blob.length - 1]) {
      expect(unwrapAccountKeys(PHRASE, blob.subarray(0, cut), P)).rejects.toThrow(WrapError);
    }
  });

  test("an absurd memory cost is refused before it is attempted", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P, FAST);
    const huge = Uint8Array.from(blob);
    // 4 GiB in KiB.
    huge[2] = 0x00;
    huge[3] = 0x40;
    huge[4] = 0x00;
    huge[5] = 0x00;
    expect(unwrapAccountKeys(PHRASE, huge, P)).rejects.toThrow(/memory/i);
  });
});

describe("cross-host", () => {
  // The property recovery depends on: a phrase written down beside a browser
  // that wrapped the keys must unwrap them anywhere this library runs.
  test("what webPlatform wrapped, bunPlatform unwraps, and the reverse", async () => {
    const keys = generateAccountKeys(webPlatform);
    const byWeb = await wrapAccountKeys(PHRASE, keys, webPlatform, FAST);
    const onBun = await unwrapAccountKeys(PHRASE, byWeb, bunPlatform);
    expect(P.toHex(onBun.ingestPriv)).toBe(P.toHex(keys.ingestPriv));
    expect(P.toHex(onBun.dek)).toBe(P.toHex(keys.dek));
    expect(P.toHex(onBun.recoveryPub)).toBe(P.toHex(keys.recoveryPub));

    const byBun = await wrapAccountKeys(PHRASE, keys, bunPlatform, FAST);
    const onWeb = await unwrapAccountKeys(PHRASE, byBun, webPlatform);
    expect(P.toHex(onWeb.ingestPub)).toBe(P.toHex(keys.ingestPub));
  });
});

describe("the shipped parameters", () => {
  // A wrong parameter here is a real weakness rather than a detail, so the
  // numbers are pinned: a change has to be made deliberately, in a commit that
  // edits this expectation and says why.
  test("are Argon2id at 64 MiB, 3 passes, 1 lane, 32 bytes out", () => {
    expect(WRAP_KDF_PARAMS).toEqual({ t: 3, m: 65536, p: 1 });
  });

  test("are what a blob written with the defaults declares", async () => {
    const blob = await wrapAccountKeys(PHRASE, generateAccountKeys(P), P);
    expect(wrappedBlobParams(blob)).toEqual({
      version: ACCOUNT_KEY_VERSION,
      kdf: KDF_ARGON2ID,
      t: 3,
      m: 65536,
      p: 1,
    });
    // And it still round-trips at the real cost — the only test here that pays
    // for two full Argon2id runs.
    expect((await unwrapAccountKeys(PHRASE, blob, P)).dek.length).toBe(32);
  }, 30_000);
});
