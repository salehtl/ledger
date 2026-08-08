/**
 * Browser custody of the account's key material, and the two endpoints it rides
 * on.
 *
 * # The one rule this module exists to enforce
 *
 * After a key is stored, **its private material is not readable from
 * JavaScript**. `client/src/crypto/keys.ts` deals in raw bytes because it has to
 * — a wrapped blob is bytes and Argon2id takes bytes — and those bytes live for
 * the few milliseconds between generating (or unwrapping) a key set and
 * {@link installAccountKeys} importing it.
 *
 * What is *stored* is a non-extractable AES-GCM `CryptoKey` (the DEK), put in
 * IndexedDB by structured clone, plus the X25519 ingest private key **sealed
 * under that DEK**. `crypto.subtle.exportKey` on the DEK throws; the ingest key
 * at rest is ciphertext. `keys.test.ts` proves both rather than asserting them
 * in a comment.
 *
 * # Why the ingest key is sealed rather than stored as a handle
 *
 * It used to be a second non-extractable handle, and that shape does not survive
 * WebKit: **WebKit writes an X25519 `CryptoKey` into IndexedDB, reports success,
 * completes the transaction, and then returns `null` for that record forever**
 * (`structuredClone` of the same key throws `Unable to deserialize data`). An
 * AES-GCM handle and an ECDH P-256 handle both persist; only X25519 vanishes. So
 * every iPhone published a key set it could never read back, `keyStatus`
 * answered `needs_recovery` on every launch, and typing the phrase re-ran the
 * same successful write into the same hole — a closed loop through a path where
 * nothing failed. See `.superpowers/sdd/2026-08-08-phase3-crypto/`.
 *
 * The sealed shape keeps the guarantee: the private bytes at rest are ciphertext
 * under a key JavaScript cannot export, {@link openIngestPrivate} imports them
 * into a non-extractable handle at point of use, and the plaintext is zeroed
 * before that function returns. The DEK is the root of custody either way, so
 * this adds no new trust — it moves one key behind the other.
 *
 * **What that is and is not worth, plainly.** It is weaker than the iOS Keychain
 * the native design assumed: a `CryptoKey` cannot be read, but any script
 * running on this origin can USE it, so an XSS is a decryption oracle even
 * though it is not a key theft. Spec §2's breach inventory has to say so —
 * Apple leaves the threat model and XSS enters it. What it does buy is real: a
 * stolen browser profile directory, an extension reading `localStorage`, a
 * devtools heap snapshot, and any `JSON.stringify` of application state all
 * yield nothing, and that is the class of loss a browser actually suffers.
 *
 * # Why the store is injectable and the vault interface is tiny
 *
 * jsdom has no IndexedDB, so the tests drive a memory vault with the same three
 * methods; the IndexedDB one is exercised in a real browser by
 * `web/harness/recovery.mjs`, which is also where the non-extractability proof
 * runs against Chromium rather than against Node's WebCrypto — and by
 * `web/harness/vault.mjs`, which runs the round trip in **WebKit** as well.
 * Chromium-only was the shape of the miss: the harness was green for months
 * while every iOS device was broken.
 *
 * # This module changes no data path
 *
 * Phase 3 Task 1 mints keys, publishes a public half and stores handles. Nothing
 * is sealed with them yet: at the end of this task the system still stores
 * plaintext. Tasks 2 and 3 are what reach for {@link StoredKeys}.
 */

import { ApiError, NetworkError } from "@ledger/client/net/client";
import { webPlatform } from "@ledger/client/platform.web";
import {
  ACCOUNT_KEY_VERSION,
  generateAccountKeys,
  unwrapAccountKeys,
  wrapAccountKeys,
  zero,
  type AccountKeys,
} from "@ledger/client/crypto/keys";
import { generatePhrase } from "@ledger/client/crypto/phrase";
import { sessionAnswerOf } from "./halt";

/**
 * The account's keys as this device holds them.
 *
 * `ingestPub` is bytes because it is not a secret and everything that wants it
 * wants it as bytes. The DEK is a handle and there is no accessor that turns it
 * back into bytes, by construction. The ingest private key is ciphertext, and
 * the only thing that opens it is {@link openIngestPrivate}.
 *
 * Every field of this is structured-cloneable in every browser this ships to —
 * which is the property the previous shape lacked, and lacked silently.
 */
export interface StoredKeys {
  /** The account these belong to. A device that signs into another account must not reuse them. */
  accountId: string;
  /** X25519 public, 32 bytes. Published; the server seals to it. */
  ingestPub: Uint8Array;
  /**
   * The X25519 private key in PKCS#8, sealed under {@link dek} with
   * {@link accountId} as associated data. 64 bytes: 48 of key, 16 of tag.
   */
  ingestPrivSealed: Uint8Array;
  /** The 12-byte nonce {@link ingestPrivSealed} was sealed with. */
  ingestPrivIv: Uint8Array;
  /** AES-256-GCM, non-extractable, usable only for `encrypt`/`decrypt`. */
  dek: CryptoKey;
}

/** Where {@link StoredKeys} live. Three methods, so a test double is honest rather than partial. */
export interface KeyVault {
  read(): Promise<StoredKeys | null>;
  write(keys: StoredKeys): Promise<void>;
  clear(): Promise<void>;
}

/** AES-GCM nonce length, in bytes. The one every other seal in this codebase uses. */
const IV_BYTES = 12;

/**
 * What the sealed ingest key is bound to.
 *
 * The account id, so a row lifted out of one account's vault and dropped into
 * another's does not open — the same rule `keyStatus` enforces on the plaintext
 * fields, applied where an attacker who can write IndexedDB cannot edit around
 * it.
 */
function aadFor(accountId: string): Uint8Array {
  return webPlatform.utf8Encode(`ledger-v2-ingest-key\x00${accountId}`);
}

/** The PKCS#8 prelude for a raw X25519 private key: SEQUENCE, v0, OID 1.3.101.110, OCTET STRING(0x20). */
const PKCS8_X25519_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

/**
 * Imports a freshly minted or freshly unwrapped key set into non-extractable
 * handles, and **destroys the raw bytes it was given**.
 *
 * The caller's `AccountKeys` is left zeroed on purpose: it is the only other
 * copy, and leaving it live would mean the guarantee this module makes held for
 * IndexedDB and not for the variable three frames up the stack. `zero` is not a
 * guarantee either — a GC may have moved the buffer — and it still bounds how
 * long the live allocation holds a key, which is what a heap snapshot sees.
 */
export async function installAccountKeys(accountId: string, keys: AccountKeys, vault: KeyVault): Promise<StoredKeys> {
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + keys.ingestPriv.length);
  try {
    pkcs8.set(PKCS8_X25519_PREFIX, 0);
    pkcs8.set(keys.ingestPriv, PKCS8_X25519_PREFIX.length);

    // `false` is the whole point of this function.
    const dek = await subtle().importKey("raw", toBuffer(keys.dek), "AES-GCM", false, ["encrypt", "decrypt"]);

    // Imported and thrown away, purely to fail HERE on a browser whose WebCrypto
    // has no X25519 (WebKit before 17.4). Without it that browser would store a
    // sealed blob it can never import, and would discover it at the first
    // decrypt instead of during the ceremony that can still say so.
    await subtle().importKey("pkcs8", toBuffer(pkcs8), { name: "X25519" }, false, ["deriveBits"]);

    const ingestPrivIv = Uint8Array.from(webPlatform.randomBytes(IV_BYTES));
    const ingestPrivSealed = new Uint8Array(
      await subtle().encrypt(
        { name: "AES-GCM", iv: toBuffer(ingestPrivIv), additionalData: toBuffer(aadFor(accountId)) },
        dek,
        toBuffer(pkcs8),
      ),
    );

    const stored: StoredKeys = {
      accountId,
      ingestPub: Uint8Array.from(keys.ingestPub),
      ingestPrivSealed,
      ingestPrivIv,
      dek,
    };
    await vault.write(stored);
    return stored;
  } finally {
    // A `finally`, not a trailing pair of calls, because the two awaits above
    // both fail on ordinary devices rather than exotic ones: `importKey` throws
    // where WebCrypto has no X25519 (WebKit before 17.4), and `vault.write`
    // throws where IndexedDB is unavailable or the quota is spent. The caller's
    // `AccountKeys` is the only other copy of this material, so it is destroyed
    // on EVERY exit — which is also what lets every caller treat one call as the
    // end of the raw bytes' life instead of each guarding it again.
    zero(pkcs8);
    zero(keys.ingestPriv);
    zero(keys.dek);
    // The recovery authorizer is NOT stored — it is derivable from the phrase
    // and is needed for one enrolment — so this is the end of its life here too.
    zero(keys.recoverySeed);
  }
}

/**
 * Opens the ingest private key, for the moment it is used.
 *
 * The returned handle is **non-extractable and `deriveBits`-only** — the ingest
 * key opens sealed mail and signs nothing, so a wider usage list would be a
 * capability nothing asks for. The plaintext PKCS#8 exists only inside this
 * function and is zeroed before it returns, so the raw private bytes are never
 * reachable from application state, a heap snapshot or a `JSON.stringify`.
 *
 * Call it where the key is needed and let the handle go. Holding one for the
 * life of the tab is not wrong, but it is not better either: the DEK that opens
 * it is sitting in the same vault.
 */
export async function openIngestPrivate(keys: StoredKeys): Promise<CryptoKey> {
  const opened = await subtle().decrypt(
    { name: "AES-GCM", iv: toBuffer(keys.ingestPrivIv), additionalData: toBuffer(aadFor(keys.accountId)) },
    keys.dek,
    toBuffer(keys.ingestPrivSealed),
  );
  const pkcs8 = new Uint8Array(opened);
  try {
    return await subtle().importKey("pkcs8", toBuffer(pkcs8), { name: "X25519" }, false, ["deriveBits"]);
  } finally {
    zero(pkcs8);
  }
}

// ---------------------------------------------------------------------------
// The vaults
// ---------------------------------------------------------------------------

/** The IndexedDB database the handles live in. Its own, not the sql.js one — see below. */
export const KEY_VAULT_DB = "ledger-v2-keys";
const KEY_VAULT_STORE = "keys";
const KEY_VAULT_ROW = "account";

/**
 * The real vault.
 *
 * A **separate database** from the sql.js driver's `ledger-v2`, deliberately.
 * The driver exports and rewrites its whole record on every flush, and a bug
 * there — or a `deleteBrowserDatabase` during a sign-out — must not be able to
 * take the account's keys with it as a side effect. Two databases means
 * "wipe the local projection" and "destroy the only copy of the keys" are two
 * operations, and only one of them is reachable by accident.
 */
export function indexedDbKeyVault(dbName = KEY_VAULT_DB): KeyVault {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(KEY_VAULT_STORE)) req.result.createObjectStore(KEY_VAULT_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
      req.onblocked = () => reject(new Error("the key vault is blocked by another tab"));
    });

  /**
   * Resolves on `transaction.oncomplete`, never on `request.onsuccess`.
   *
   * `onsuccess` means the store accepted the operation; `oncomplete` means the
   * transaction was committed. Resolving on the former reports a write as
   * durable while it can still abort — the same class of "reported durable
   * before it was" that the vault's silent data loss belongs to, even though it
   * was not the cause of it. For a `get` the two fire in that order anyway, so
   * one helper serves both modes.
   */
  const tx = async <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(KEY_VAULT_STORE, mode);
        let result: T;
        const request = run(transaction.objectStore(KEY_VAULT_STORE));
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error("key vault request failed"));
        transaction.oncomplete = () => resolve(result);
        transaction.onerror = () => reject(transaction.error ?? new Error("key vault transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("key vault transaction aborted"));
      });
    } finally {
      db.close();
    }
  };

  return {
    async read(): Promise<StoredKeys | null> {
      const row = await tx<unknown>("readonly", (s) => s.get(KEY_VAULT_ROW) as IDBRequest<unknown>);
      return decodeStored(row);
    },
    /**
     * Writes, then **reads the record back and uses it**, and throws if it does
     * not come back whole.
     *
     * This is not belt and braces. WebKit accepted an X25519 `CryptoKey` here,
     * completed the transaction, and returned `null` for the record on every
     * later read — so `installAccountKeys` resolved, the account published a key
     * set, and the device could never open it. A store that can accept a write
     * and lose it must not be able to look like success: that is what turned a
     * browser limitation into a loop with no error in it.
     *
     * The check is a real use, not a shape test. `openIngestPrivate` decrypts
     * under the DEK that came back out of storage and imports the result, so a
     * DEK that survived as a husk, a truncated blob and a row that decodes but
     * does not work all fail here — where the ceremony can still say so.
     */
    async write(keys: StoredKeys): Promise<void> {
      await tx("readwrite", (s) => s.put(keys, KEY_VAULT_ROW) as IDBRequest<IDBValidKey>);
      const back = decodeStored(await tx<unknown>("readonly", (s) => s.get(KEY_VAULT_ROW) as IDBRequest<unknown>));
      if (back === null || back.accountId !== keys.accountId || !sameBytes(back.ingestPub, keys.ingestPub)) {
        throw new Error("this browser accepted the key write and lost it: the key vault cannot store keys here");
      }
      try {
        await openIngestPrivate(back);
      } catch (err) {
        throw new Error(
          `this browser stored the keys but cannot read them back: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    async clear(): Promise<void> {
      await tx("readwrite", (s) => s.delete(KEY_VAULT_ROW) as IDBRequest<undefined>);
    },
  };
}

/**
 * A vault that keeps handles in memory for the life of the tab.
 *
 * Not only test scaffolding: `indexedDB` is genuinely absent in Safari private
 * browsing and in a storage-partitioned embed, and the same judgement the sql.js
 * driver already makes applies — an account that works until the tab closes
 * beats an app that cannot open. It is honest about it: nothing here claims to
 * persist, and a user in that state has their recovery phrase, which is the only
 * durable copy there ever was.
 */
export function memoryKeyVault(): KeyVault {
  let held: StoredKeys | null = null;
  return {
    read: async () => held,
    write: async (keys) => {
      held = keys;
    },
    clear: async () => {
      held = null;
    },
  };
}

/** The vault this browser can actually use. */
export function browserKeyVault(dbName = KEY_VAULT_DB): KeyVault {
  return typeof indexedDB === "undefined" ? memoryKeyVault() : indexedDbKeyVault(dbName);
}

/**
 * Refuses a row that is not a complete key set rather than half-applying it.
 *
 * A partial row means the previous write was interrupted, and the safe reading
 * of that is "this device has no keys" — which routes the user to the recovery
 * screen, where their phrase repairs it. Treating it as a usable key set would
 * produce a `CryptoKey` of `undefined` somewhere much further away.
 *
 * A row in the OLD shape — an `ingestPrivate` handle and no sealed blob — is
 * refused by the same rule, and that is the whole migration. There is no way to
 * convert one: the old handle is non-extractable by design, so its bytes cannot
 * be re-sealed. Those devices take the recovery path, which is a screen and
 * twelve words, and their published key set is untouched — nothing is re-keyed.
 */
function decodeStored(v: unknown): StoredKeys | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r["accountId"] !== "string" || r["accountId"] === "") return null;
  if (!(r["ingestPub"] instanceof Uint8Array) || r["ingestPub"].length !== 32) return null;
  if (!(r["ingestPrivSealed"] instanceof Uint8Array) || r["ingestPrivSealed"].length === 0) return null;
  if (!(r["ingestPrivIv"] instanceof Uint8Array) || r["ingestPrivIv"].length !== IV_BYTES) return null;
  if (!isCryptoKey(r["dek"])) return null;
  return {
    accountId: r["accountId"],
    ingestPub: r["ingestPub"],
    ingestPrivSealed: r["ingestPrivSealed"],
    ingestPrivIv: r["ingestPrivIv"],
    dek: r["dek"],
  };
}

// `instanceof CryptoKey` is not available in every environment this runs in
// (Node's WebCrypto exposes the class under a different global in some
// versions), so the check is structural on the two fields nothing else has.
function isCryptoKey(v: unknown): v is CryptoKey {
  if (typeof v !== "object" || v === null) return false;
  const k = v as { type?: unknown; algorithm?: unknown; extractable?: unknown };
  return typeof k.type === "string" && typeof k.algorithm === "object" && typeof k.extractable === "boolean";
}

// ---------------------------------------------------------------------------
// The endpoints
// ---------------------------------------------------------------------------

/** What the server holds for an account, or `null` when it holds nothing yet. */
export interface PublishedKeys {
  ingestPub: Uint8Array;
  /** The Ed25519 authorizer `auth.Writers.Register` accepts. Not a secret. */
  recoveryPub: Uint8Array;
  wrapped: Uint8Array;
  keyVersion: number;
}

export interface KeysIO {
  sessionToken: string | null;
  server?: string;
  fetch?: typeof fetch;
}

/**
 * `GET /api/v1/keys`.
 *
 * `null` for an account that has published nothing — a real state, not a
 * failure: every account made before Phase 3 is in it, and it is the branch
 * between "generate a new key set" and "ask for the recovery phrase".
 */
export async function readPublishedKeys(io: KeysIO): Promise<PublishedKeys | null> {
  const res = await call(io, "GET", null);
  if (res === null) return null;
  const body = res as {
    ingest_pubkey?: unknown;
    recovery_pubkey?: unknown;
    wrapped_keys?: unknown;
    key_version?: unknown;
  };
  if (
    typeof body.ingest_pubkey !== "string" ||
    typeof body.recovery_pubkey !== "string" ||
    typeof body.wrapped_keys !== "string"
  ) {
    throw new ApiError(200, "", "", "GET /api/v1/keys: unreadable response");
  }
  return {
    ingestPub: webPlatform.fromBase64(body.ingest_pubkey),
    recoveryPub: webPlatform.fromBase64(body.recovery_pubkey),
    wrapped: webPlatform.fromBase64(body.wrapped_keys),
    keyVersion: typeof body.key_version === "number" ? body.key_version : ACCOUNT_KEY_VERSION,
  };
}

/** `PUT /api/v1/keys`. A 409 travels as an {@link ApiError} carrying `keys_already_published`. */
export async function publishKeys(
  io: KeysIO,
  keys: { ingestPub: Uint8Array; recoveryPub: Uint8Array; wrapped: Uint8Array },
): Promise<void> {
  await call(io, "PUT", {
    ingest_pubkey: webPlatform.toBase64(keys.ingestPub),
    recovery_pubkey: webPlatform.toBase64(keys.recoveryPub),
    wrapped_keys: webPlatform.toBase64(keys.wrapped),
    key_version: ACCOUNT_KEY_VERSION,
  });
}

async function call(io: KeysIO, method: "GET" | "PUT", body: unknown): Promise<unknown> {
  const token = io.sessionToken;
  if (token === null || token === "") throw new ApiError(401, "unauthorized", "", `${method} /api/v1/keys: no session`);
  const doFetch = io.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const path = `${io.server ?? ""}/api/v1/keys`;

  let res: Response;
  try {
    res = await doFetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === null ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new NetworkError(`${method} /api/v1/keys: ${err instanceof Error ? err.message : String(err)}`, err);
  }

  const text = await res.text();
  if (res.status === 404 && method === "GET") return null;
  if (!res.ok) {
    let code = "";
    let detail = "";
    try {
      const e = JSON.parse(text) as { error?: string; detail?: string };
      code = e.error ?? "";
      detail = e.detail ?? "";
    } catch {
      detail = text.slice(0, 200);
    }
    throw new ApiError(res.status, code, detail, `${method} /api/v1/keys: ${res.status} ${code}`);
  }
  if (text === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(res.status, "", text.slice(0, 200), `${method} /api/v1/keys: unreadable response`);
  }
}

// ---------------------------------------------------------------------------
// The two ceremonies
// ---------------------------------------------------------------------------

/** What a device has to do next about keys. Derived, never stored — see `onboarding.ts`'s header. */
export type KeyStatus =
  /** This device holds usable handles for this account. Nothing to do. */
  | { kind: "ready"; keys: StoredKeys }
  /** The account has published nothing. This device must mint a key set and a phrase. */
  | { kind: "unpublished" }
  /** The account has keys and this device does not. Only the recovery phrase can fix it. */
  | { kind: "needs_recovery"; published: PublishedKeys };

/**
 * Which of the three states this device is in.
 *
 * The account id is compared, not just presence: a browser profile that signed
 * out and into a DIFFERENT account still holds the first account's handles, and
 * using them would seal that user's data under a stranger's key.
 */
export async function keyStatus(accountId: string, vault: KeyVault, io: KeysIO): Promise<KeyStatus> {
  const held = await vault.read();

  let published: PublishedKeys | null;
  try {
    published = await readPublishedKeys(io);
  } catch (err) {
    /*
     * # Offline is not "this device has no keys"
     *
     * This is a local-first PWA whose keys are sitting in IndexedDB. Before
     * this branch, a launch with no network threw here, `boot`'s
     * `keysReadyOrFalse` swallowed it to `false`, the milestone walk collapsed
     * to `invited`, and a fully set-up user was shown the RECOVERY PHRASE
     * SCREEN — asking for the twelve words they wrote down months ago because
     * a fetch failed. It could not mint a second key set (this function throws
     * rather than answering `unpublished`, which is what kept that safe), but
     * "your keys are gone" is close to the worst thing this product can say to
     * someone whose keys are one function call away.
     *
     * So: handles for THIS account, plus no answer from the server, reads as
     * `ready`. That is the honest local answer — the device really can decrypt
     * — and it is the same judgement `boot.ts` already makes for a sync that
     * could not run, which is not an integrity halt.
     *
     * A device with NO handles still rethrows: it genuinely cannot tell
     * "generate a key set" from "ask for the phrase" without the server, and
     * guessing the first would be the catastrophic guess. The recovery step
     * renders "ledger could not reach the server" for that case.
     *
     * A 401/410 is NOT swallowed — it travels, because it is a fact about the
     * account rather than about the connection, and hiding a deleted account
     * behind a working-looking app is the failure `address.ts` already names.
     */
    if (held !== null && held.accountId === accountId && sessionAnswerOf(err) === null) {
      return { kind: "ready", keys: held };
    }
    throw err;
  }

  if (published === null) {
    // Held handles for an account that has published nothing are the residue of
    // an abandoned attempt, and they are not what the server will seal to.
    return { kind: "unpublished" };
  }
  if (held !== null && held.accountId === accountId && sameBytes(held.ingestPub, published.ingestPub)) {
    return { kind: "ready", keys: held };
  }
  return { kind: "needs_recovery", published };
}

/**
 * The onboarding ceremony: mint a phrase and a key set, wrap, publish, install.
 *
 * The order is chosen so a failure is never silent data loss. The blob is
 * published BEFORE the handles are installed, because a device holding keys the
 * server has never seen is a device whose mail will arrive sealed to nothing;
 * the reverse — a published blob no device holds — is repaired by typing the
 * phrase, which the user has just been shown.
 *
 * `onPhrase` is called with the phrase before anything is published, and the
 * caller is expected not to resolve it until the user has confirmed they wrote
 * it down. It is a callback rather than a return value for exactly that reason:
 * the phrase must be on the glass before the account depends on it.
 */
export async function establishAccountKeys(args: {
  accountId: string;
  vault: KeyVault;
  io: KeysIO;
  /** Awaited before publication. Resolve it when the user has confirmed the phrase. */
  confirmPhrase: (phrase: string) => Promise<void>;
}): Promise<StoredKeys> {
  const phrase = generatePhrase(webPlatform);
  const keys = generateAccountKeys(webPlatform);
  try {
    await args.confirmPhrase(phrase);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform);
    await publishKeys(args.io, { ingestPub: keys.ingestPub, recoveryPub: keys.recoveryPub, wrapped });
    // INSIDE the try, and `await`ed rather than returned bare: `installAccountKeys`
    // throws on a browser whose WebCrypto has no X25519 (WebKit before 17.4),
    // and a bare `return` of the promise would settle after this frame's catch
    // had been passed by, leaving three live keys behind on exactly the device
    // least able to do anything about it.
    return await installAccountKeys(args.accountId, keys, args.vault);
  } catch (err) {
    // The raw private material is destroyed on EVERY exit, not only the happy
    // one. `installAccountKeys` zeroes it on success; before this, a failed or
    // abandoned publication left three live keys in a closure for as long as
    // the tab did — and the failure paths here are the ordinary ones (the user
    // backs out, the network drops), not the exotic ones.
    zero(keys.ingestPriv);
    zero(keys.dek);
    zero(keys.recoverySeed);
    throw err;
  }
}

/**
 * The recovery ceremony: the phrase, the published blob, and nothing else.
 *
 * This is what a browser with cleared site data runs. It needs no other device,
 * no email and nothing the operator holds — because the operator holds nothing
 * that would help, which is the fact the onboarding copy has to state plainly.
 */
export async function recoverAccountKeys(args: {
  accountId: string;
  phrase: string;
  published: PublishedKeys;
  vault: KeyVault;
  /**
   * Run with the account's recovery authorizer, before the seed is destroyed.
   *
   * This is how a browser with cleared site data becomes able to WRITE again:
   * `auth.Writers.Register` accepts a signature from this key in place of one
   * from an enrolled device, so the caller uses it to enrol a writer and then
   * has no further use for it — which is why it is a callback rather than a
   * returned value. The seed is zeroed in the `finally` below whether the
   * enrolment succeeded, failed or was never attempted, so no code path leaves
   * a live copy of an authorizer behind.
   */
  authorize?: (sign: (msg: Uint8Array) => Uint8Array) => Promise<void>;
}): Promise<StoredKeys> {
  const keys = await unwrapAccountKeys(args.phrase, args.published.wrapped, webPlatform);
  // The blob authenticates itself, so these cannot fail for a phrase that
  // opened it — unless the server served a blob belonging to another account,
  // which is exactly what they are here to catch. The recovery half matters as
  // much as the ingest half: a mismatched authorizer is an enrolment the server
  // refuses with a bodyless 403, which is unactionable, so it is caught here
  // where it can be named.
  if (
    !sameBytes(keys.ingestPub, args.published.ingestPub) ||
    !sameBytes(keys.recoveryPub, args.published.recoveryPub)
  ) {
    zero(keys.ingestPriv);
    zero(keys.dek);
    zero(keys.recoverySeed);
    throw new Error("the recovered keys do not match the public keys this account published");
  }

  // Everything past the unwrap is guarded, because everything past the unwrap
  // can fail on an ORDINARY path and both failures leave three live private
  // keys in this frame otherwise:
  //
  //   - `authorize` is a network call. `RecoverWritePanel` already catches its
  //     rejection and renders it as "those words did not open your account", so
  //     a dropped connection or a server refusal is the expected case, not the
  //     exotic one.
  //   - `installAccountKeys` throws on a browser whose WebCrypto has no X25519
  //     — WebKit before 17.4, which is a real device this product targets.
  //
  // The seed COPY had a `finally` and the three originals did not, which is the
  // same defect `establishAccountKeys` was fixed for one round earlier, left
  // standing in its sibling.
  try {
    if (args.authorize !== undefined) {
      // A COPY of the seed, so the closure keeps working after
      // `keys.recoverySeed` is zeroed by `installAccountKeys` below — and so
      // this function owns the only lifetime that matters.
      const seed = Uint8Array.from(keys.recoverySeed);
      try {
        await args.authorize((msg) => webPlatform.ed25519Sign(seed, msg));
      } finally {
        zero(seed);
      }
    }
    return await installAccountKeys(args.accountId, keys, args.vault);
  } catch (err) {
    // `installAccountKeys` zeroes these on success; this is the only other exit.
    zero(keys.ingestPriv);
    zero(keys.dek);
    zero(keys.recoverySeed);
    throw err;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    throw new Error(
      "this browser cannot store keys safely: crypto.subtle is unavailable, " +
        "which usually means the page is not being served over HTTPS",
    );
  }
  return crypto.subtle;
}

// The typed array, not a detached `ArrayBuffer` — see `platform.aead.ts`'s
// `toBuffer` for why the difference is load bearing under jsdom.
function toBuffer(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b);
}
