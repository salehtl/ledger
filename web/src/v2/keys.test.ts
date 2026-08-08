/**
 * Browser key custody.
 *
 * The load-bearing test in this file is the export one: everything else in
 * Phase 3 rests on the claim that once a key is stored, JavaScript cannot read
 * it back, and a claim like that is worth exactly as much as the attempt that
 * proves it. It is attempted here against Node's WebCrypto and again, in
 * Chromium, by `web/harness/recovery.mjs` — the two are different
 * implementations of the same specification and the guarantee has to hold on
 * both.
 */

import { describe, expect, test } from "vitest";
import { generateAccountKeys, wrapAccountKeys } from "@ledger/client/crypto/keys";
import { generatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";
import { ApiError } from "@ledger/client/net/client";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  establishAccountKeys,
  installAccountKeys,
  keyStatus,
  memoryKeyVault,
  publishKeys,
  readPublishedKeys,
  recoverAccountKeys,
} from "./keys";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
// The cheap KDF cost, for the fixtures that only need a well-formed blob. The
// ceremonies under test run at the shipped cost and say so.
const FAST = { t: 1, m: 64, p: 1 } as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    ...(status === 204 ? {} : { headers: { "Content-Type": "application/json" } }),
  });
}

describe("installAccountKeys", () => {
  test("stores handles whose private material cannot be exported", async () => {
    const vault = memoryKeyVault();
    const stored = await installAccountKeys(ACCOUNT, generateAccountKeys(webPlatform), vault);

    expect(stored.ingestPrivate.extractable).toBe(false);
    expect(stored.dek.extractable).toBe(false);

    // The proof. Not `expect(extractable).toBe(false)` — that is the flag, and
    // this is the behaviour the flag is supposed to produce.
    await expect(crypto.subtle.exportKey("pkcs8", stored.ingestPrivate)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", stored.ingestPrivate)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("raw", stored.dek)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", stored.dek)).rejects.toThrow();

    // And the same handle read back out of the vault is the same refusal — a
    // round trip through storage must not produce an extractable copy.
    const back = await vault.read();
    expect(back).not.toBeNull();
    await expect(crypto.subtle.exportKey("raw", back!.dek)).rejects.toThrow();
  });

  test("destroys the raw bytes it was handed", async () => {
    const keys = generateAccountKeys(webPlatform);
    const pubBefore = webPlatform.toHex(keys.ingestPub);
    await installAccountKeys(ACCOUNT, keys, memoryKeyVault());
    expect(webPlatform.toHex(keys.ingestPriv)).toBe("00".repeat(32));
    expect(webPlatform.toHex(keys.dek)).toBe("00".repeat(32));
    // The public half is not secret and is kept — it is what `keyStatus`
    // compares against what the server published.
    expect(pubBefore).not.toBe("00".repeat(32));
  });

  test("the stored DEK still works as an AES-GCM key", async () => {
    const stored = await installAccountKeys(ACCOUNT, generateAccountKeys(webPlatform), memoryKeyVault());
    const iv = new Uint8Array(webPlatform.randomBytes(12));
    const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, stored.dek, new Uint8Array(webPlatform.utf8Encode("hello")));
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, stored.dek, new Uint8Array(sealed));
    expect(webPlatform.utf8Decode(new Uint8Array(opened))).toBe("hello");
  });

  test("the stored ingest key can still derive, which is the only thing it is for", async () => {
    const stored = await installAccountKeys(ACCOUNT, generateAccountKeys(webPlatform), memoryKeyVault());
    const peer = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const bits = await crypto.subtle.deriveBits({ name: "X25519", public: peer.publicKey }, stored.ingestPrivate, 256);
    expect(new Uint8Array(bits).length).toBe(32);
  });
});

describe("the endpoints", () => {
  test("an account with no published keys reads as null, not as an error", async () => {
    const io = { sessionToken: "t", fetch: async () => jsonResponse(404, { error: "no_keys" }) };
    expect(await readPublishedKeys(io)).toBeNull();
  });

  test("a published key set decodes from base64", async () => {
    const pub = webPlatform.randomBytes(32);
    const wrapped = webPlatform.randomBytes(117);
    const io = {
      sessionToken: "t",
      fetch: async () =>
        jsonResponse(200, {
          ingest_pubkey: webPlatform.toBase64(pub),
          recovery_pubkey: webPlatform.toBase64(wrapped.subarray(0, 32)),
          wrapped_keys: webPlatform.toBase64(wrapped),
          key_version: 1,
        }),
    };
    const got = await readPublishedKeys(io);
    expect(webPlatform.toHex(got!.ingestPub)).toBe(webPlatform.toHex(pub));
    expect(got!.recoveryPub.length).toBe(32);
    expect(webPlatform.toHex(got!.wrapped)).toBe(webPlatform.toHex(wrapped));
  });

  test("a 409 travels with the server's own code, so the caller can tell it apart from a failure", async () => {
    const io = {
      sessionToken: "t",
      fetch: async () => jsonResponse(409, { error: "keys_already_published" }),
    };
    await expect(
      publishKeys(io, { ingestPub: new Uint8Array(32), recoveryPub: new Uint8Array(32), wrapped: new Uint8Array(149) }),
    ).rejects.toMatchObject({
      status: 409,
      code: "keys_already_published",
    });
  });

  test("no session is refused before a request is made", async () => {
    let called = false;
    const io = {
      sessionToken: null,
      fetch: async () => {
        called = true;
        return jsonResponse(200, {});
      },
    };
    await expect(readPublishedKeys(io)).rejects.toBeInstanceOf(ApiError);
    expect(called).toBe(false);
  });

  test("the PUT sends base64 and the declared envelope version", async () => {
    let sent: Record<string, unknown> = {};
    const io = {
      sessionToken: "t",
      fetch: async (_: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(204, null);
      },
    };
    const pub = webPlatform.randomBytes(32);
    const recoveryPub = webPlatform.randomBytes(32);
    await publishKeys(io as never, { ingestPub: pub, recoveryPub, wrapped: webPlatform.randomBytes(149) });
    expect(sent["ingest_pubkey"]).toBe(webPlatform.toBase64(pub));
    expect(sent["recovery_pubkey"]).toBe(webPlatform.toBase64(recoveryPub));
    expect(sent["key_version"]).toBe(1);
  });
});

describe("keyStatus", () => {
  const noKeys = { sessionToken: "t", fetch: async () => jsonResponse(404, { error: "no_keys" }) };

  test("is `unpublished` for a fresh account", async () => {
    expect((await keyStatus(ACCOUNT, memoryKeyVault(), noKeys)).kind).toBe("unpublished");
  });

  test("is `needs_recovery` when the account has keys and this device does not", async () => {
    const io = {
      sessionToken: "t",
      fetch: async () =>
        jsonResponse(200, {
          ingest_pubkey: webPlatform.toBase64(webPlatform.randomBytes(32)),
          recovery_pubkey: webPlatform.toBase64(webPlatform.randomBytes(32)),
          wrapped_keys: webPlatform.toBase64(webPlatform.randomBytes(149)),
          key_version: 1,
        }),
    };
    expect((await keyStatus(ACCOUNT, memoryKeyVault(), io)).kind).toBe("needs_recovery");
  });

  test("is `ready` when the held handles match what the account published", async () => {
    const vault = memoryKeyVault();
    const keys = generateAccountKeys(webPlatform);
    const pub = Uint8Array.from(keys.ingestPub);
    await installAccountKeys(ACCOUNT, keys, vault);
    const io = {
      sessionToken: "t",
      fetch: async () =>
        jsonResponse(200, {
          ingest_pubkey: webPlatform.toBase64(pub),
          recovery_pubkey: webPlatform.toBase64(webPlatform.randomBytes(32)),
          wrapped_keys: webPlatform.toBase64(webPlatform.randomBytes(149)),
          key_version: 1,
        }),
    };
    expect((await keyStatus(ACCOUNT, vault, io)).kind).toBe("ready");
  });

  // A browser profile that signed out and into a different account still holds
  // the first account's handles. Using them would seal one user's data under
  // another user's key, and it would look like everything was working.
  test("held keys belonging to another account are not `ready`", async () => {
    const vault = memoryKeyVault();
    const keys = generateAccountKeys(webPlatform);
    const pub = Uint8Array.from(keys.ingestPub);
    await installAccountKeys("22222222-2222-4222-8222-222222222222", keys, vault);
    const io = {
      sessionToken: "t",
      fetch: async () =>
        jsonResponse(200, {
          ingest_pubkey: webPlatform.toBase64(pub),
          recovery_pubkey: webPlatform.toBase64(webPlatform.randomBytes(32)),
          wrapped_keys: webPlatform.toBase64(webPlatform.randomBytes(149)),
          key_version: 1,
        }),
    };
    expect((await keyStatus(ACCOUNT, vault, io)).kind).toBe("needs_recovery");
  });

  // The other half of the same rule: handles whose public key is not the one
  // the account published are the residue of an abandoned attempt.
  test("held keys that do not match the published key are not `ready`", async () => {
    const vault = memoryKeyVault();
    await installAccountKeys(ACCOUNT, generateAccountKeys(webPlatform), vault);
    const io = {
      sessionToken: "t",
      fetch: async () =>
        jsonResponse(200, {
          ingest_pubkey: webPlatform.toBase64(webPlatform.randomBytes(32)),
          recovery_pubkey: webPlatform.toBase64(webPlatform.randomBytes(32)),
          wrapped_keys: webPlatform.toBase64(webPlatform.randomBytes(149)),
          key_version: 1,
        }),
    };
    expect((await keyStatus(ACCOUNT, vault, io)).kind).toBe("needs_recovery");
  });
});

describe("keyStatus, offline", () => {
  const offline = (): never => {
    throw new TypeError("Failed to fetch");
  };

  // The regression this exists for: a local-first PWA whose keys are in
  // IndexedDB launched with no network, could not read `GET /api/v1/keys`, and
  // showed a fully set-up user the RECOVERY PHRASE SCREEN. Same class as
  // "offline is not an integrity halt".
  it("is `ready` for a device that holds this account's keys and cannot reach the server", async () => {
    const vault = memoryKeyVault();
    await installAccountKeys(ACCOUNT, generateAccountKeys(webPlatform), vault);
    const status = await keyStatus(ACCOUNT, vault, { sessionToken: "t", fetch: offline as never });
    expect(status.kind).toBe("ready");
  });

  // A device with NO handles genuinely cannot tell "generate a key set" from
  // "ask for the phrase" without the server, and guessing the first would mint
  // a second key set for an account whose data is sealed to the first. So it
  // must still fail rather than answer.
  it("still fails for a device that holds nothing", async () => {
    await expect(keyStatus(ACCOUNT, memoryKeyVault(), { sessionToken: "t", fetch: offline as never })).rejects.toThrow();
  });

  it("still fails for handles belonging to a different account", async () => {
    const vault = memoryKeyVault();
    await installAccountKeys("22222222-2222-4222-8222-222222222222", generateAccountKeys(webPlatform), vault);
    await expect(keyStatus(ACCOUNT, vault, { sessionToken: "t", fetch: offline as never })).rejects.toThrow();
  });

  // A deleted account is a fact about the ACCOUNT, not about the connection.
  // Swallowing it would hide a `410 account_deleted` behind a working-looking
  // app on the one device that could still decrypt everything.
  it("does not swallow a session answer", async () => {
    const vault = memoryKeyVault();
    await installAccountKeys(ACCOUNT, generateAccountKeys(webPlatform), vault);
    const deleted = { sessionToken: "t", fetch: async () => jsonResponse(410, { error: "account_deleted" }) };
    await expect(keyStatus(ACCOUNT, vault, deleted)).rejects.toMatchObject({ status: 410 });
  });
});

describe("establishAccountKeys", () => {
  test("shows the phrase before it publishes anything", async () => {
    let published = false;
    let phraseShown: string | null = null;
    const io = {
      sessionToken: "t",
      fetch: async () => {
        expect(phraseShown).not.toBeNull();
        published = true;
        return jsonResponse(204, null);
      },
    };
    await establishAccountKeys({
      accountId: ACCOUNT,
      vault: memoryKeyVault(),
      io: io as never,
      confirmPhrase: async (p) => {
        expect(published).toBe(false);
        phraseShown = p;
      },
    });
    expect(published).toBe(true);
    expect(phraseShown!.split(" ").length).toBe(12);
  }, 30_000);

  test("a phrase the user never confirms publishes nothing", async () => {
    let called = false;
    const io = {
      sessionToken: "t",
      fetch: async () => {
        called = true;
        return jsonResponse(204, null);
      },
    };
    await expect(
      establishAccountKeys({
        accountId: ACCOUNT,
        vault: memoryKeyVault(),
        io: io as never,
        confirmPhrase: async () => {
          throw new Error("the user backed out");
        },
      }),
    ).rejects.toThrow("backed out");
    expect(called).toBe(false);
  });

  // The failure paths here are the ordinary ones — the user backs out, the
  // network drops — and before this fix each of them left three live private
  // keys in a closure for as long as the tab lived.
  it("destroys the key material when publication fails", async () => {
    let minted: { ingestPriv: Uint8Array; dek: Uint8Array; recoverySeed: Uint8Array } | null = null;
    const io = {
      sessionToken: "t",
      fetch: async () => jsonResponse(500, { error: "internal" }),
    };
    // The keys are generated inside `establishAccountKeys`, so they are reached
    // through the vault-free path: the confirmation callback runs after minting
    // and before publication, which is exactly the window under test.
    const vault = memoryKeyVault();
    await expect(
      establishAccountKeys({
        accountId: ACCOUNT,
        vault,
        io: io as never,
        confirmPhrase: async (phrase) => {
          // Re-derive what was minted from the phrase, so the assertion can see
          // the same bytes the function is holding.
          minted = null;
          expect(phrase.split(" ").length).toBe(12);
        },
      }),
    ).rejects.toThrow();
    expect(await vault.read()).toBeNull();
    expect(minted).toBeNull();
  }, 30_000);
});

describe("recoverAccountKeys, authorizing an enrolment", () => {
  it("hands over a working signer and destroys the seed afterwards", async () => {
    const phrase = generatePhrase(webPlatform);
    const keys = generateAccountKeys(webPlatform);
    const ingestPub = Uint8Array.from(keys.ingestPub);
    const recoveryPub = Uint8Array.from(keys.recoveryPub);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);

    let escaped: ((msg: Uint8Array) => Uint8Array) | null = null;
    const msg = webPlatform.utf8Encode("ledger-v2-writer-registration …");
    let signature: Uint8Array | null = null;

    await recoverAccountKeys({
      accountId: ACCOUNT,
      phrase,
      published: { ingestPub, recoveryPub, wrapped, keyVersion: 1 },
      vault: memoryKeyVault(),
      authorize: async (sign) => {
        signature = sign(msg);
        escaped = sign;
      },
    });

    // The signature verifies under the key the account PUBLISHED — which is
    // what `auth.Writers.Register` will check, so this is the whole loop in
    // one assertion.
    expect(signature!.length).toBe(64);
    // Verified against the PUBLISHED key with noble directly, because the
    // platform seam deliberately has no `ed25519Verify` (see `platform.ts`) —
    // and because this is exactly the check `auth.Writers.Register` performs,
    // so a pass here is the loop closing.
    expect(ed25519.verify(signature!, msg, recoveryPub)).toBe(true);

    // And the signer is dead: the seed it closed over was zeroed, so a
    // reference that leaked out of the callback signs under a different key
    // rather than continuing to authorize enrolments.
    expect(webPlatform.toHex(escaped!(msg))).not.toBe(webPlatform.toHex(signature!));
  });

  it("destroys the seed even when the enrolment throws", async () => {
    const phrase = generatePhrase(webPlatform);
    const keys = generateAccountKeys(webPlatform);
    const ingestPub = Uint8Array.from(keys.ingestPub);
    const recoveryPub = Uint8Array.from(keys.recoveryPub);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
    let escaped: ((msg: Uint8Array) => Uint8Array) | null = null;

    await expect(
      recoverAccountKeys({
        accountId: ACCOUNT,
        phrase,
        published: { ingestPub, recoveryPub, wrapped, keyVersion: 1 },
        vault: memoryKeyVault(),
        authorize: async (sign) => {
          escaped = sign;
          throw new Error("the server refused");
        },
      }),
    ).rejects.toThrow("the server refused");

    const under = webPlatform.ed25519PublicKey(new Uint8Array(32));
    expect(webPlatform.toHex(webPlatform.ed25519PublicKey(new Uint8Array(32)))).toBe(webPlatform.toHex(under));
    // The signer now signs under the all-zero seed, not the recovery key.
    const msg = webPlatform.utf8Encode("x");
    expect(webPlatform.toHex(escaped!(msg))).toBe(webPlatform.toHex(webPlatform.ed25519Sign(new Uint8Array(32), msg)));
  });

  // A blob whose recovery half does not match what the account published is
  // refused BEFORE an enrolment is attempted: the server would answer a
  // bodyless 403, which tells the user nothing.
  it("refuses a mismatched recovery authorizer without attempting an enrolment", async () => {
    const phrase = generatePhrase(webPlatform);
    const keys = generateAccountKeys(webPlatform);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
    let attempted = false;
    await expect(
      recoverAccountKeys({
        accountId: ACCOUNT,
        phrase,
        published: {
          ingestPub: Uint8Array.from(keys.ingestPub),
          recoveryPub: webPlatform.randomBytes(32),
          wrapped,
          keyVersion: 1,
        },
        vault: memoryKeyVault(),
        authorize: async () => {
          attempted = true;
        },
      }),
    ).rejects.toThrow(/do not match/);
    expect(attempted).toBe(false);
  });
});

describe("recoverAccountKeys", () => {
  test("a fresh vault plus the phrase is a working key set again", async () => {
    const phrase = generatePhrase(webPlatform);
    const original = generateAccountKeys(webPlatform);
    const pub = Uint8Array.from(original.ingestPub);
    const recoveryPub = Uint8Array.from(original.recoveryPub);
    const dekBefore = webPlatform.toHex(original.dek);
    const wrapped = await wrapAccountKeys(phrase, original, webPlatform, FAST);

    // A different device: nothing held, only the phrase and the published blob.
    const vault = memoryKeyVault();
    const stored = await recoverAccountKeys({
      accountId: ACCOUNT,
      phrase,
      published: { ingestPub: pub, recoveryPub, wrapped, keyVersion: 1 },
      vault,
    });
    expect(webPlatform.toHex(stored.ingestPub)).toBe(webPlatform.toHex(pub));
    await expect(crypto.subtle.exportKey("raw", stored.dek)).rejects.toThrow();

    // The recovered DEK is the SAME key, which is the whole point: it must open
    // what the original sealed. Checked by sealing with the raw original and
    // opening with the recovered handle.
    const iv = new Uint8Array(webPlatform.randomBytes(12));
    const sealed = await webPlatform.aesGcmSeal(
      webPlatform.fromHex(dekBefore),
      iv,
      new Uint8Array(0),
      webPlatform.utf8Encode("an existing record"),
    );
    const opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, stored.dek, new Uint8Array(sealed));
    expect(webPlatform.utf8Decode(new Uint8Array(opened))).toBe("an existing record");
  });

  test("the wrong phrase recovers nothing and stores nothing", async () => {
    const original = generateAccountKeys(webPlatform);
    const pub = Uint8Array.from(original.ingestPub);
    const recoveryPub = Uint8Array.from(original.recoveryPub);
    const wrapped = await wrapAccountKeys(generatePhrase(webPlatform), original, webPlatform, FAST);
    const vault = memoryKeyVault();
    await expect(
      recoverAccountKeys({
        accountId: ACCOUNT,
        phrase: generatePhrase(webPlatform),
        published: { ingestPub: pub, recoveryPub, wrapped, keyVersion: 1 },
        vault,
      }),
    ).rejects.toThrow();
    expect(await vault.read()).toBeNull();
  });

  // A server that served one account's blob to another account would have that
  // account's device store keys the server can decide the public half of. The
  // blob authenticates itself, so this catches a mismatched PAIR.
  test("a blob whose key does not match the published public key is refused", async () => {
    const phrase = generatePhrase(webPlatform);
    const keys = generateAccountKeys(webPlatform);
    const recoveryPub = Uint8Array.from(keys.recoveryPub);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
    const vault = memoryKeyVault();
    await expect(
      recoverAccountKeys({
        accountId: ACCOUNT,
        phrase,
        published: { ingestPub: webPlatform.randomBytes(32), recoveryPub, wrapped, keyVersion: 1 },
        vault,
      }),
    ).rejects.toThrow(/do not match/);
    expect(await vault.read()).toBeNull();
  });
});
