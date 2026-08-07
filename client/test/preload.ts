/**
 * Installs the host `Platform` for every `bun test` process.
 *
 * # Why this file exists
 *
 * The registry moved out of `platform.ts` into `platform.registry.ts` so a
 * browser can call `setPlatform` without dragging `node:zlib`/`node:crypto`
 * into its bundle (see that module's doc). The cost is that `platform.ts` — and
 * therefore the guarded `setPlatform(bunPlatform)` at the bottom of it — is no
 * longer imported by `wire/op.ts`, `store/store.ts` and the seven other modules
 * that used to pull it in transitively. Host entrypoints now install it
 * themselves: `cli/main.ts`, `store/open.ts`, `store/file.ts`, `store/driver.ts`
 * and the child scripts the outbox and engine tests spawn.
 *
 * A test file is an entrypoint too, and there are 36 of them. Without this,
 * `bun test` as a whole still passed — some file in the run imports a store and
 * installs the platform for everybody, because every file shares one process —
 * while `bun test src/wire/op.test.ts` ON ITS OWN failed 22 of 35 tests with
 * "no Platform installed". A suite that is green in bulk and red one file at a
 * time is worse than one that is simply red: running a single file is what
 * anybody does while actually working on it.
 *
 * # `[test] preload`, deliberately not a top-level one
 *
 * `bunfig.toml` puts this under `[test]`, so it applies to `bun test` and NOT
 * to `bun run`. That matters: `outbox.test.ts` and `engine.test.ts` write child
 * programs and `Bun.spawn(["bun", "run", ...])` them, and those children are the
 * only thing in this repo that proves a fresh process can still start. A
 * top-level preload would install the platform for them too and hide exactly
 * the failure this whole change had to be checked against — the three
 * subprocess tests that caught the missing install in the first place.
 */

import "../src/platform";
