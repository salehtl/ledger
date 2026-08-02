/**
 * The two resolver rules in `metro.config.js`, exercised directly.
 *
 * `bun run bundle` proves the graph builds; it cannot prove *why*. These two
 * rules are the ones whose failure is silent:
 *
 *  - If `node:zlib` and `node:crypto` ever resolve to something real,
 *    `client/src/platform.ts` installs `bunPlatform` on the device — and
 *    `bunPlatform` would then be the active implementation, hashing with a
 *    `Bun` that does not exist, failing at first use with a message about
 *    `CryptoHasher` rather than about configuration.
 *  - The CLI ban is the plan's "true by construction" requirement for
 *    `client/src/cli`. A rule nobody executes is a comment.
 *
 * The context is faked, because the real one is Metro's and building it needs
 * a running bundler. What is under test is this file's own logic, not Metro's.
 */

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const config = require("../metro.config.js") as {
  watchFolders: string[];
  resolver: {
    nodeModulesPaths: string[];
    disableHierarchicalLookup: boolean;
    resolveRequest: (context: unknown, moduleName: string, platform: string | null) => unknown;
  };
};

const APP_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");

/** A context whose default resolver returns whatever the test wants next. */
function contextResolvingTo(filePath: string) {
  return {
    resolveRequest: () => ({ type: "sourceFile", filePath }),
  };
}

describe("metro.config.js", () => {
  test("watches the repo root so client/src is in the graph", () => {
    expect(config.watchFolders).toEqual([REPO_ROOT]);
  });

  test("resolves node_modules only from app/, so there is one copy of ulid", () => {
    // `ulid` mints every `op_id`, and an `op_id` is an identity. Hierarchical
    // lookup would find `client/node_modules/ulid` first when resolving from
    // inside `client/src`, giving the bundle a second copy.
    expect(config.resolver.nodeModulesPaths).toEqual([resolve(APP_ROOT, "node_modules")]);
    expect(config.resolver.disableHierarchicalLookup).toBe(true);
  });

  for (const spec of ["node:zlib", "node:crypto", "node:fs", "node:path", "bun:sqlite"]) {
    test(`${spec} resolves to an empty module`, () => {
      const ctx = contextResolvingTo("/should/not/be/consulted");
      expect(config.resolver.resolveRequest(ctx, spec, "ios")).toEqual({ type: "empty" });
    });
  }

  test("a specifier that is not host-only is passed through untouched", () => {
    const target = resolve(REPO_ROOT, "client", "src", "replay", "replay.ts");
    const ctx = contextResolvingTo(target);
    expect(config.resolver.resolveRequest(ctx, "@ledger/client/replay/replay.ts", "ios")).toEqual({
      type: "sourceFile",
      filePath: target,
    });
  });

  test("anything resolving into client/src/cli fails the build", () => {
    const ctx = contextResolvingTo(resolve(REPO_ROOT, "client", "src", "cli", "main.ts"));
    expect(() => config.resolver.resolveRequest(ctx, "@ledger/client/cli/main.ts", "ios")).toThrow(/client\/src\/cli/);
  });

  test("the ban is on the cli directory, not on the substring 'cli'", () => {
    // `client/src/invariants/check.ts` contains "cli" inside "client"; a
    // substring rule would ban the whole library.
    const target = resolve(REPO_ROOT, "client", "src", "invariants", "check.ts");
    const ctx = contextResolvingTo(target);
    expect(config.resolver.resolveRequest(ctx, "@ledger/client/invariants/check.ts", "ios")).toEqual({
      type: "sourceFile",
      filePath: target,
    });
  });
});
