/**
 * The React Native {@link Platform}, assembled from the four pure modules
 * beside this one plus an injected source of randomness.
 *
 * # Why the RNG is a parameter
 *
 * Everything else in `app/src/platform/` is pure JavaScript and runs under Bun
 * exactly as it runs under Hermes, which is what lets `platform.test.ts` in
 * this directory run the seam's whole contract on this box instead of only on a
 * device. `expo-crypto` is the one native dependency, so it is injected here
 * and supplied in `index.ts`. The alternative — importing `expo-crypto` in this
 * file — would make the entire implementation untestable outside a simulator,
 * which is how a module ends up written, green and never actually exercised.
 *
 * The RNG is NOT optional and has no default. A default would be a place for a
 * `Math.random` fallback to hide, and this RNG seeds Ed25519 keys and the ULID
 * that becomes every `op_id`.
 */

import type { Platform } from "@ledger/client/platform.ts";

import { fromBase64, fromHex, toBase64, toHex, utf8Decode, utf8Encode } from "./bytes.ts";
import { gunzip, gzip } from "./gzip.ts";
import { sha256 } from "./hash.ts";
import { ed25519GenerateKey, ed25519PublicKey, ed25519Sign } from "./signing.ts";

/** The two primitives only the host can provide. */
export interface RandomSource {
  /** A cryptographically random v4 UUID. */
  randomUUID(): string;
  /** `n` cryptographically random bytes. */
  randomBytes(n: number): Uint8Array;
}

/** Builds the React Native `Platform`. Pure — see the header for why. */
export function createPlatform(random: RandomSource): Platform {
  return {
    sha256,
    gzip,
    gunzip,
    ed25519GenerateKey: () => ed25519GenerateKey((n) => random.randomBytes(n)),
    ed25519PublicKey,
    ed25519Sign,
    randomUUID: () => random.randomUUID(),
    randomBytes: (n) => random.randomBytes(n),
    toHex,
    fromHex,
    toBase64,
    fromBase64,
    utf8Encode,
    utf8Decode,
  };
}
