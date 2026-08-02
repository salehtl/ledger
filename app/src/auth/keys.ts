/**
 * Key material: where it is kept, under which Keychain class, and under what
 * name.
 *
 * Everything here is pure so `bun test` can run it. The `expo-secure-store`
 * binding that uses it is in `native.ts`.
 *
 * # What goes in the Keychain, and what does not
 *
 * Two values, both from `client/src/store/sqlite.ts`'s `SecretStore` contract:
 * the session bearer token (`SECRET_SESSION`) and each writer's Ed25519
 * **private** seed (`SECRET_WRITER + <writer id>`). Plus one this file adds:
 * this install's `writer_id`, which is not secret but must live and die with
 * the key it names — a device holding a key under one id and announcing
 * another is a device whose blobs nobody can verify.
 *
 * Spec §3.4 is explicit that the device identity key is in the **device**
 * Keychain and **not synced**. It is not the device *wrap* key, which is
 * synced and is Phase 3's problem.
 *
 * # The accessibility class, and why this one
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
 *
 *  - `..._THIS_DEVICE_ONLY` is the non-negotiable half: without it the item is
 *    included in an encrypted iCloud backup and can be restored onto a
 *    different phone, which is precisely the "not synced" the spec forbids.
 *  - `WHEN_UNLOCKED` over `AFTER_FIRST_UNLOCK` because nothing in Phase 2
 *    needs to read either value while the device is locked. Push is
 *    content-free (§3.8): the notification carries nothing, the user taps it,
 *    the app comes to the foreground, and the device is unlocked by
 *    definition. `AFTER_FIRST_UNLOCK` would widen the window in which a device
 *    seized while locked-but-once-unlocked yields the writer key, and buys
 *    nothing this phase spends.
 *
 * **The iOS deployment-target floor is still undecided** (`NEEDS-SALEH.md` §8,
 * plan open item 10) and it is what governs this choice, so the choice is
 * stated rather than assumed: both constants above have existed since iOS 4
 * and neither is at risk from any plausible floor, so this is safe at any
 * target and does not block on that decision. The one that *would* have been
 * floor-sensitive is `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`, which is rejected
 * for a different reason — on a device with no passcode the item cannot be
 * written at all, so an alpha with no passcode could not sign in and would see
 * a Keychain error rather than an explanation.
 *
 * **If background sync while locked is ever wanted**, the session token — and
 * only the session token — moves to `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
 * The writer key does not follow it: signing must require a foreground user.
 *
 * # The write that no transaction covers
 *
 * `sqliteStore.save()` writes the Keychain **first** and the database second
 * (`client/src/store/sqlite.ts:208-226`), and `Store.transaction` cannot cover
 * the first of those. That ordering is the safe one for the common case: a
 * crash between them leaves an orphan secret, which `load()` ignores because
 * it only reads `d` for writers the state names.
 *
 * One direction is **not** safe, and it is worth knowing before wiring
 * anything: `save()` also *clears* the private half of any writer the new
 * state has dropped. If that save is inside a transaction that later rolls
 * back, the database keeps the writer and the Keychain has lost its key —
 * `decodeState` then refuses the state with "writer X has no usable key" and
 * the device needs re-enrolment. It is narrow (it needs a writer removal and a
 * rollback in the same save) and it is not this task's to fix — `client/src`
 * belongs to Task 5 — but a caller that removes writers inside a transaction
 * should know it is the one destructive, non-rollbackable write in the store.
 */

import { SECRET_SESSION, SECRET_WRITER } from "@ledger/client/store/sqlite.ts";
import type { SecretStore } from "@ledger/client/store/store.ts";

/**
 * The Keychain class, as a name rather than as an imported constant, so this
 * module stays free of native imports and a test on this box can still assert
 * which one was chosen. `native.ts` maps it, and `keys.test.ts` reads
 * `native.ts` as text to check that it maps it to this one and to nothing else.
 */
export const KEYCHAIN_ACCESSIBILITY = "WHEN_UNLOCKED_THIS_DEVICE_ONLY";

/** This install's writer id. Not secret; kept beside the key it names. */
export const SECRET_WRITER_ID = "writer_id";

/**
 * `expo-secure-store` refuses any key outside `/^[\w.-]+$/`
 * (`expo-secure-store/build/SecureStore.js:152`), and the `SecretStore`
 * contract hands it names it never agreed to: `SECRET_WRITER` is
 * `"writer_key:"` and a **colon is not in that set**. Unescaped, the first
 * `save()` after enrolment throws `Invalid key provided to SecureStore` on a
 * device — and nowhere else, because every other `SecretStore` in the tree is
 * a map or a file.
 */
const KEYCHAIN_KEY_RE = /^[\w.-]+$/;

/** Characters that survive unescaped. `_` is deliberately NOT among them. */
const SAFE = /^[A-Za-z0-9.-]$/;

/**
 * Escapes a `SecretStore` name into a legal Keychain key, **injectively**.
 *
 * The escape is `_` followed by two lower-case hex digits, per UTF-8 byte, for
 * every character that is not `[A-Za-z0-9.-]` — including `_` itself, which is
 * why the mapping is reversible and therefore injective. A naive
 * `replace(/:/g, "_")` is not: it maps `writer_key:X` and `writer_key_X` onto
 * one key, and those are two different writers' private seeds landing in one
 * Keychain slot. That is a silent key swap, which on this system means signing
 * blobs with a key the roster does not name.
 */
export function keychainKeyFor(name: string): string {
  if (name === "") throw new Error("a SecretStore name may not be empty");
  let out = "";
  for (const ch of name) {
    if (SAFE.test(ch)) {
      out += ch;
      continue;
    }
    for (const b of utf8Bytes(ch)) out += `_${b.toString(16).padStart(2, "0")}`;
  }
  // Belt and braces: the escape cannot produce an illegal key, and if a future
  // edit to SAFE makes it possible, this throws here rather than inside a
  // native module with no context.
  if (!KEYCHAIN_KEY_RE.test(out)) throw new Error(`escaped Keychain key is still illegal: ${JSON.stringify(out)}`);
  return out;
}

function utf8Bytes(ch: string): number[] {
  const cp = ch.codePointAt(0) as number;
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

/**
 * Mirrors `writers_writer_id_charset` (`00003_writers.sql:32`,
 * `^[A-Za-z0-9._-]{1,64}$`) and `auth.validWriterID`.
 *
 * Checked here as well as there because a writer id ends up inside signed
 * registration messages and blob AAD, where a surprise is a security question
 * rather than a data-quality one — and because the server answers every
 * registration rejection with the same bodyless 403, so an id the database
 * would refuse presents on the phone as "registration rejected" with nothing
 * to act on.
 */
export function isValidWriterId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id);
}

/**
 * This install's writer id, minted once and kept forever.
 *
 * A **stable per-install** value: not per user and not per sign-in. Two
 * accounts on one phone share it (they are the same device), and one account
 * on two phones has two — which is the shape `writer_checkpoint` and the
 * roster are built around.
 *
 * It is written **before** it is returned, for the same reason
 * `Client.ensureWriterKey` persists before returning: an id used to enrol and
 * then lost to a crashed process is a writer the server knows about and this
 * device can never sign for again.
 *
 * A stored id that no longer satisfies the charset is a **refusal**, not a
 * re-mint: re-minting silently abandons an enrolled writer, and the honest
 * failure is louder and recoverable.
 */
export function ensureWriterId(secrets: SecretStore, mint: () => string): string {
  const held = secrets.get(SECRET_WRITER_ID);
  if (held !== null && held !== "") {
    if (!isValidWriterId(held)) {
      throw new Error(
        `the stored writer id ${JSON.stringify(held.slice(0, 80))} is not a legal writer id; ` +
          `the server would refuse it, and re-minting one would abandon an enrolled writer`,
      );
    }
    return held;
  }
  const minted = mint();
  if (!isValidWriterId(minted)) throw new Error(`minted writer id ${JSON.stringify(minted)} is not a legal writer id`);
  secrets.set(SECRET_WRITER_ID, minted);
  return minted;
}

/**
 * Every Keychain name this app owns, for a wipe.
 *
 * Enumerated from the state rather than guessed: the writers are whichever
 * ones the store recorded. Callers pass the ids they know; there is no
 * "list everything" on `SecretStore` and inventing one would mean a second
 * source of truth for what a device holds.
 */
export function keychainNames(writerIds: readonly string[]): string[] {
  return [SECRET_SESSION, SECRET_WRITER_ID, ...writerIds.map((id) => `${SECRET_WRITER}${id}`)];
}
