/**
 * The `Platform` registry, and nothing else.
 *
 * # Why this is not in `platform.ts`
 *
 * `platform.ts` holds both the registry AND {@link bunPlatform}, which
 * statically imports `node:zlib` and `node:crypto`. That is fine on Bun and on
 * Node, and it is fatal in a browser bundle: Vite externalizes a `node:`
 * builtin and Rollup then fails the build with `"gzipSync" is not exported by
 * "__vite-browser-external"`. So a browser entrypoint cannot reach
 * `setPlatform` through `platform.ts` — which is exactly what it needs at boot,
 * to install `webPlatform` (`platform.web.ts`) before anything reaches the seam.
 *
 * Splitting the four lines of registry out into a module with NO imports at all
 * gives the browser a legal door to the same singleton. `platform.ts`
 * re-exports both functions, so every existing `import { platform } from
 * "../platform"` keeps working, keeps auto-installing `bunPlatform` on Bun, and
 * observes the same `active` variable — there is exactly one registry, and this
 * file is it.
 *
 * The `Platform` INTERFACE deliberately stays in `platform.ts`: it is a type,
 * so importing it costs a browser bundle nothing (the import is erased), and
 * moving it would churn every consumer for no gain.
 */

import type { Platform } from "./platform";

let active: Platform | undefined;

/**
 * Installs the implementation every call site will use. The app calls this at
 * module load, before anything reaches the seam.
 */
export function setPlatform(p: Platform): void {
  active = p;
}

/** The installed implementation. Throws if none has been installed. */
export function platform(): Platform {
  if (active === undefined) {
    throw new Error("no Platform installed: call setPlatform() before using the client library on this runtime");
  }
  return active;
}
