/**
 * Argon2id for the platform seam.
 *
 * Like `platform.aead.ts` this has ONE implementation shared by both hosts, and
 * for a blunter reason: `node:crypto` has no Argon2, so there is no second
 * implementation to cross-check against even in principle. `@noble/hashes` is
 * already a dependency of both `client/` and `web/`, and RFC 9106 §5.3's
 * published vector — checked in `platform.test.ts` AND in `platform.web.test.ts`
 * — is what pins it.
 *
 * The reason this file exists rather than the two seams each calling noble
 * directly is the parameter mapping below: RFC 9106 calls the optional
 * associated data `ad` and noble calls it `personalization`, and a seam that
 * spelled that translation twice is a seam with two chances to spell it
 * differently.
 */

import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import type { Argon2idParams } from "./platform";

export function argon2idOf(password: Uint8Array, salt: Uint8Array, params: Argon2idParams): Uint8Array {
  return nobleArgon2id(password, salt, {
    t: params.t,
    m: params.m,
    p: params.p,
    dkLen: params.dkLen,
    ...(params.key === undefined ? {} : { key: params.key }),
    ...(params.ad === undefined ? {} : { personalization: params.ad }),
  });
}
