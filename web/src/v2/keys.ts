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
 * {@link installAccountKeys} importing it. What is *stored* is a pair of
 * non-extractable `CryptoKey` handles, put in IndexedDB by structured clone.
 * `crypto.subtle.exportKey` on either of them throws, and
 * `keys.test.ts` proves it rather than asserting it in a comment.
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
 * runs against Chromium rather than against Node's WebCrypto.
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

/**
 * The account's keys as this device holds them.
 *
 * `ingestPub` is bytes because it is not a secret and everything that wants it
 * wants it as bytes. The other two are handles and there is no accessor that
 * turns them back into bytes, by construction.
 */
export interface StoredKeys {
  /** The account these belong to. A device that signs into another account must not reuse them. */
  accountId: string;
  /** X25519 public, 32 bytes. Published; the server seals to it. */
  ingestPub: Uint8Array;
  /** X25519 private, non-extractable, usable only for `deriveBits`. */
  ingestPrivate: CryptoKey;
  /** AES-256-GCM, non-extractable, usable only for `encrypt`/`decrypt`. */
  dek: CryptoKey;
}

/** Where {@link StoredKeys} live. Three methods, so a test double is honest rather than partial. */
export interface KeyVault {
  read(): Promise<StoredKeys | null>;
  write(keys: StoredKeys): Promise<void>;
  clear(): Promise<void>;
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
  pkcs8.set(PKCS8_X25519_PREFIX, 0);
  pkcs8.set(keys.ingestPriv, PKCS8_X25519_PREFIX.length);

  // `false` is the whole point of this function. `deriveBits` only: the ingest
  // key opens sealed mail and signs nothing, so a wider usage list would be a
  // capability nothing asks for.
  const ingestPrivate = await subtle().importKey("pkcs8", toBuffer(pkcs8), { name: "X25519" }, false, ["deriveBits"]);
  const dek = await subtle().importKey("raw", toBuffer(keys.dek), "AES-GCM", false, ["encrypt", "decrypt"]);
  zero(pkcs8);

  const stored: StoredKeys = { accountId, ingestPub: Uint8Array.from(keys.ingestPub), ingestPrivate, dek };
  await vault.write(stored);

  zero(keys.ingestPriv);
  zero(keys.dek);
  return stored;
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

  const tx = async <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(KEY_VAULT_STORE, mode);
        const request = run(transaction.objectStore(KEY_VAULT_STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("key vault request failed"));
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
    async write(keys: StoredKeys): Promise<void> {
      await tx("readwrite", (s) => s.put(keys, KEY_VAULT_ROW) as IDBRequest<IDBValidKey>);
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
 */
function decodeStored(v: unknown): StoredKeys | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r["accountId"] !== "string" || r["accountId"] === "") return null;
  if (!(r["ingestPub"] instanceof Uint8Array) || r["ingestPub"].length !== 32) return null;
  if (!isCryptoKey(r["ingestPrivate"]) || !isCryptoKey(r["dek"])) return null;
  return {
    accountId: r["accountId"],
    ingestPub: r["ingestPub"],
    ingestPrivate: r["ingestPrivate"],
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
  const body = res as { ingest_pubkey?: unknown; wrapped_keys?: unknown; key_version?: unknown };
  if (typeof body.ingest_pubkey !== "string" || typeof body.wrapped_keys !== "string") {
    throw new ApiError(200, "", "", "GET /api/v1/keys: unreadable response");
  }
  return {
    ingestPub: webPlatform.fromBase64(body.ingest_pubkey),
    wrapped: webPlatform.fromBase64(body.wrapped_keys),
    keyVersion: typeof body.key_version === "number" ? body.key_version : ACCOUNT_KEY_VERSION,
  };
}

/** `PUT /api/v1/keys`. A 409 travels as an {@link ApiError} carrying `keys_already_published`. */
export async function publishKeys(io: KeysIO, keys: { ingestPub: Uint8Array; wrapped: Uint8Array }): Promise<void> {
  await call(io, "PUT", {
    ingest_pubkey: webPlatform.toBase64(keys.ingestPub),
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
  const published = await readPublishedKeys(io);
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
  await args.confirmPhrase(phrase);
  const wrapped = await wrapAccountKeys(phrase, keys, webPlatform);
  await publishKeys(args.io, { ingestPub: keys.ingestPub, wrapped });
  return installAccountKeys(args.accountId, keys, args.vault);
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
}): Promise<StoredKeys> {
  const keys = await unwrapAccountKeys(args.phrase, args.published.wrapped, webPlatform);
  // The blob authenticates itself, so this cannot fail for a phrase that opened
  // it — unless the server served a blob belonging to another account, which is
  // exactly what it is here to catch.
  if (!sameBytes(keys.ingestPub, args.published.ingestPub)) {
    zero(keys.ingestPriv);
    zero(keys.dek);
    throw new Error("the recovered keys do not match the public key this account published");
  }
  return installAccountKeys(args.accountId, keys, args.vault);
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
