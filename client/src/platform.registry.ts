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
 * # The rule this creates: AN ENTRYPOINT INSTALLS ITS PLATFORM
 *
 * `platform.ts` self-installs `bunPlatform` at the bottom of the file, guarded
 * on the builtins actually existing. That used to reach every host process for
 * free, because `store/store.ts`, `net/client.ts`, `wire/*.ts` and five others
 * imported `platform.ts` on the way to anything useful. They import THIS module
 * now, so it does not.
 *
 * The install is therefore explicit wherever a program starts:
 * `cli/main.ts`; `store/open.ts`, `store/file.ts` and `store/driver.ts` (all
 * host-only already, and the door the child programs `outbox.test.ts` and
 * `engine.test.ts` spawn come in through); `test/preload.ts` for `bun test`;
 * and `initV2` in `web/src/v2/session.ts` for the browser. (The retired Expo
 * client installed a Hermes one in `app/src/platform/index.ts`; it went with
 * `app/` on 2026-08-10 and is preserved at tag app-expo-final.)
 *
 * A new entrypoint that forgets gets a runtime "no Platform installed" from the
 * first hash it takes, not a compile error. Nothing enforces this — it is a
 * convention, and this paragraph is where it is written down.
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
