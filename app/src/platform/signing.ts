/**
 * Ed25519 for Hermes, from `@noble/curves`.
 *
 * The import specifier is copied from `spike/phase0/replay-app/crypto.ts` —
 * `@noble/curves` 2.x is `@noble/curves/ed25519.js`, with the extension.
 *
 * **There is no `verify` here, and that is deliberate.** `client/src`'s seam
 * has no `ed25519Verify` because the client never verifies a signature:
 * `verifyChain`, `verifyHashList` and `verifyFetchedRange` are SHA-256 linkage
 * only, and a blob signature gates writer *registration*, server-side. Adding a
 * verify here would look like it was being used.
 *
 * Note on Hermes performance: this is pure-JS BigInt arithmetic, and Hermes'
 * BigInt is slower than V8's. It is used once per push (signing a checkpoint),
 * not per blob, so it is not on the hot path — but if that ever changes, the
 * native module in `app/modules/ledger-crypto/` is where it belongs.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * There is no seed-length guard in this file, and its absence is measured
 * rather than assumed.
 *
 * A `if (priv.length !== 32) throw` wrapper was written here first. A mutation
 * removing it survived the whole suite, because `@noble/curves` validates
 * identically and with a message that is at least as good:
 *
 *   `"secretKey" expected Uint8Array of length 32, got length=31`
 *
 * (measured against `ed25519.getPublicKey` and `ed25519.sign` at 0, 31 and 33
 * bytes — every entry point below reaches one of the two). A guard no test can
 * distinguish from its absence is not defence in depth, it is a second place
 * for the rule to be written down and later disagree.
 */

/** A fresh keypair. `priv` is the 32-byte seed, `pub` the 32-byte public key. */
export function ed25519GenerateKey(randomBytes: (n: number) => Uint8Array): { priv: Uint8Array; pub: Uint8Array } {
  // Seeded from the injected RNG rather than `@noble`'s own `randomSecretKey`,
  // which reaches for `globalThis.crypto.getRandomValues`. Hermes has no
  // `crypto` global, so on-device that path throws at key generation — the one
  // moment where a fallback to anything weaker would be catastrophic.
  const priv = randomBytes(32);
  return { priv, pub: ed25519.getPublicKey(priv) };
}

/** The public key for a 32-byte seed. */
export function ed25519PublicKey(priv: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(priv);
}

/** PureEdDSA over `msg`. 64 bytes out, deterministic. */
export function ed25519Sign(priv: Uint8Array, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, priv);
}
