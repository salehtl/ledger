// Metro configuration for the ledger v2 app.
//
// Three things this file exists to do, none of them cosmetic:
//
//  1. **Resolve `client/src` from outside `app/`.** `app/` imports the Phase 1
//     client library in place — never a copy. A copy would silently diverge
//     from the conformance suite that guards it, and that suite is the only
//     thing keeping the TypeScript executor in step with the Go one.
//  2. **Stub the host builtins `client/src` still imports.** `platform.ts`
//     imports `node:zlib`/`node:crypto` statically so that Bun, `tsc` and Metro
//     all accept the file. On the device those imports must resolve to nothing,
//     which is exactly what `platform.ts`'s auto-install measures for: with
//     them stubbed, `typeof gzipSync === "function"` is false, `bunPlatform` is
//     NOT installed, and `platform()` throws until `app/src/platform` installs
//     the React Native one.
//  3. **Make "the CLI is never bundled" true by construction.** `client/src/cli`
//     is Phase 1's exit-test instrument: `process.argv`, `process.exit`,
//     `import.meta.main`. The plan says it is out of scope for the app; a
//     resolver that throws is the difference between that being a rule and
//     being a hope.
//
// Note `disableHierarchicalLookup`. Without it, a bare `import "ulid"` inside
// `client/src/net/client.ts` resolves to `client/node_modules/ulid` — a second
// copy of a package that mints `op_id`s, which are identities. One copy, in
// `app/node_modules`, pinned in `app/package.json`.

const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);

// `client/src` lives above the project root, so Metro has to watch it.
config.watchFolders = [repoRoot];

config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

// The host-only specifiers `client/src` still imports statically. Mapped to an
// empty module rather than a polyfill: every one of them is behind a runtime
// guard that must FAIL on the device.
const HOST_ONLY = new Set([
  "node:zlib", // client/src/platform.ts    — bunPlatform's gzip
  "node:crypto", // client/src/platform.ts    — bunPlatform's Ed25519
  "node:fs", // client/src/store/open.ts  — fileStore's 0600 chmod
  "node:path", // client/src/store/{file,open}.ts
  "bun:sqlite", // client/src/store/driver.ts — bunDriver; app uses expoDriver
]);

const EMPTY_MODULE = { type: "empty" };

// `<repo>/client/src/cli/…` — the one directory that must never enter the graph.
const CLI_DIR = path.resolve(repoRoot, "client", "src", "cli") + path.sep;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (HOST_ONLY.has(moduleName)) return EMPTY_MODULE;

  const resolution = context.resolveRequest(context, moduleName, platform);

  if (resolution && resolution.type === "sourceFile" && resolution.filePath.startsWith(CLI_DIR)) {
    throw new Error(
      `metro: ${moduleName} resolves into client/src/cli (${resolution.filePath}), which is Phase 1's ` +
        `CLI instrument and is not bundleable — it uses process.argv, process.exit and import.meta.main. ` +
        `Import the library module directly instead of going through client/src/cli.`,
    );
  }

  return resolution;
};

module.exports = config;
