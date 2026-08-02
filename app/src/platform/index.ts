/**
 * Installs the React Native {@link Platform} into `client/src`'s seam.
 *
 * **Import this once, first, before anything from `@ledger/client` is called.**
 * `app/index.ts` does it at the top of the entry file. `client/src/platform.ts`
 * auto-installs `bunPlatform` only when `node:zlib`, `node:crypto` and `Bun`
 * are all really present — under Metro they are stubbed to empty modules
 * (`metro.config.js`), so the registry starts empty and `platform()` throws a
 * sentence naming this file until `setPlatform` below has run.
 *
 * This is the only module in `app/src/platform/` that touches a native module,
 * which is what keeps the other four testable under `bun test` on this box.
 */

import * as Crypto from "expo-crypto";

import { setPlatform } from "@ledger/client/platform.ts";

import { createPlatform } from "./platform.ts";

export { createPlatform } from "./platform.ts";
export type { RandomSource } from "./platform.ts";

/**
 * `ulid` picks its PRNG the first time it is called, and it picks badly on
 * Hermes.
 *
 * `client/src/net/client.ts:1090` calls `ulid()` to mint every `op_id`, and
 * `op_id` is an identity — two offline devices minting the same one is a fork
 * that nothing downstream can distinguish from a replay. `ulid`'s `detectPrng`
 * looks for `globalThis.crypto.getRandomValues`, then for Node's `crypto`
 * module, and if it finds neither it prints `"secure crypto unusable, falling
 * back to insecure Math.random()!"` to the console and carries on with
 * `Math.random`. React Native has no `crypto` global and Expo's winter runtime
 * does not add one (it ships `fetch`, `FormData`, `TextDecoder`, `URL` — no
 * WebCrypto), so on Hermes that fallback is the path taken.
 *
 * Installing the global here, backed by `expo-crypto`, makes `detectPrng` take
 * its first and best branch. It is done before `setPlatform` so that no
 * `client/src` code can run in between.
 *
 * The alternative the plan describes — passing an explicit PRNG into `ulid` —
 * needs a change to `client/src/net/client.ts`, which is not one of the four
 * edits to `client/src` this phase permits. If that seam is ever opened, this
 * polyfill should be revisited rather than left as a second mechanism.
 */
function installWebCryptoRandom(): void {
  const g = globalThis as { crypto?: { getRandomValues?: unknown } };
  if (typeof g.crypto?.getRandomValues === "function") return;

  const impl = { getRandomValues: Crypto.getRandomValues };
  if (g.crypto === undefined) {
    Object.defineProperty(globalThis, "crypto", { value: impl, configurable: true, writable: true });
  } else {
    g.crypto.getRandomValues = Crypto.getRandomValues;
  }
}

installWebCryptoRandom();

setPlatform(
  createPlatform({
    randomUUID: () => Crypto.randomUUID(),
    randomBytes: (n) => Crypto.getRandomBytes(n),
  }),
);
