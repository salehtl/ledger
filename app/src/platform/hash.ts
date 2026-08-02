/**
 * SHA-256 for Hermes, from `@noble/hashes`.
 *
 * The import specifier is copied from `spike/phase0/replay-app/crypto.ts`,
 * which is where the same major was first made to resolve under Metro:
 * `@noble/hashes` 2.x moved to `.js`-suffixed subpaths, and writing
 * `@noble/hashes/sha256` from memory produces a resolution error that reads
 * like a bundler misconfiguration.
 */

import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/** SHA-256. Returns a fresh 32-byte array that never aliases its input. */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}
