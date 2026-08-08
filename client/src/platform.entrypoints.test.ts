/**
 * The guard for the one rule `platform.registry.ts` creates and nothing else
 * enforces: AN ENTRYPOINT THAT CAN REACH THE SEAM INSTALLS ITS PLATFORM.
 *
 * # Why this test exists
 *
 * Splitting the registry out of `platform.ts` (so a browser can call
 * `setPlatform` without dragging `node:zlib`/`node:crypto` into its bundle)
 * took away the transitive `setPlatform(bunPlatform)` that every host process
 * used to get for free from `store/store.ts`, `wire/op.ts` and seven others.
 * The install is now explicit at each place a program starts.
 *
 * That arrangement was enforced by a doc paragraph and a runtime throw — never
 * a compile error — and it leaked twice within a day of landing.
 * `scripts/gen-fixtures.ts`, a documented `package.json` script, died at
 * `encodeBlobOps`. `scripts/crossexec.ts` was worse: it reaches the seam only
 * through `norm/mime.ts`'s RFC 2047 handling of a **non-UTF-8** encoded word,
 * so it runs clean on a synthetic corpus and, on the real one, catches the
 * throw and files every affected message as a normalizer *disagreement*. A
 * silent, systematic false positive in the tool whose whole job is to certify
 * the two executors agree. Neither script is a test and neither was on anybody's
 * list of entrypoints; there is nothing stopping the next one, so this is the
 * list, checked mechanically.
 *
 * # What it checks, and why it is not simply "every script installs one"
 *
 * For every `.ts` under `scripts/` and every `.ts` a `package.json` script
 * runs: if its runtime import graph reaches a module that CALLS `platform()`,
 * that graph must also reach `src/platform.ts` — the only module that calls
 * `setPlatform` on load.
 *
 * The reachability condition is the point. A blanket "add the import
 * everywhere" would flag `gen-fx-conformance.ts` and `crossexec-tmpl.ts`, which
 * genuinely cannot touch the seam (the first imports nothing but types, the
 * second only the template executor), and a checker that cries wolf gets
 * ignored — which would cost exactly the protection this is for. It fires on
 * the two scripts that were really broken, and it will fire on the day one of
 * the quiet two grows an import that reaches the seam.
 *
 * `import type` is skipped, because it is erased at runtime. Not a detail:
 * `gen-fx-conformance.ts` reaches `wire/op` and `replay/replay` ONLY through
 * `import type`, so a walker that counted them would judge it on edges that do
 * not exist in the emitted program.
 *
 * `bun test` entries are exempt — `bunfig.toml`'s `[test] preload` installs the
 * platform for every test process, and deliberately does not apply to `bun run`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const CLIENT_DIR = resolve(import.meta.dir, "..");
/** The only module that calls `setPlatform` on load. */
const INSTALLER = join(CLIENT_DIR, "src/platform.ts");
const REGISTRY = join(CLIENT_DIR, "src/platform.registry.ts");

/**
 * Source with comments removed.
 *
 * Load-bearing, not tidiness: `platform.registry.ts`'s doc comment contains the
 * literal text `import { platform } from "../platform"` while explaining why
 * nothing does that any more, and several modules explain their install in
 * prose. A walker that read comments would follow edges that do not exist.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Every module specifier `src` imports AT RUNTIME. Static `import` and
 * `export ... from` only; bare specifiers (`node:fs`, `ulid`) come back too and
 * are dropped by the resolver, which cannot place them.
 */
export function runtimeImports(src: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\n;}])\s*(import|export)\b([^'"]*?)(['"])([^'"]+)\3/g;
  for (const m of stripComments(src).matchAll(re)) {
    const kind = m[1] as string;
    const clause = m[2] as string;
    // `import type { X } from "y"` is erased. A mixed
    // `import { type X, y } from "z"` is NOT — only the leading keyword counts.
    if (/^\s*type\s/.test(clause)) continue;
    const hasFrom = /\bfrom\s*$/.test(clause);
    // A bare `import "./x"` (the form every install in this repo uses) has an
    // empty clause. Anything else needs a `from`, or it is a string literal
    // that merely follows the word `export`.
    if (!hasFrom && !(kind === "import" && clause.trim() === "")) continue;
    out.push(m[4] as string);
  }
  return out;
}

/** A relative specifier as a real file, trying the extensions Bun would. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** Every file reachable from `entry` through runtime imports, including it. */
export function moduleGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of runtimeImports(src)) {
      const next = resolveSpec(file, spec);
      if (next !== null) stack.push(next);
    }
  }
  return [...seen];
}

/**
 * Whether a module CALLS `platform()` — i.e. would throw without an install.
 *
 * `platform.ts` and `platform.registry.ts` are excluded: they *define* and
 * re-export the function, and counting a definition as a use would make every
 * graph a seam user and the whole check vacuous.
 */
function usesSeam(file: string): boolean {
  if (file === INSTALLER || file === REGISTRY) return false;
  try {
    return /\bplatform\(\)/.test(stripComments(readFileSync(file, "utf8")));
  } catch {
    return false;
  }
}

const rel = (p: string): string => relative(CLIENT_DIR, p);

/** `null` when the entry is fine, otherwise the sentence explaining it. */
function auditEntry(what: string, file: string): string | null {
  const graph = moduleGraph(file);
  const seamUsers = graph.filter(usesSeam).map(rel).sort();
  if (seamUsers.length === 0) return null; // cannot reach the seam at all
  if (graph.includes(INSTALLER)) return null;
  const up = "../".repeat(rel(file).split("/").length - 1);
  return (
    `${what} can reach platform() but never reaches src/platform.ts, ` +
    `so it will throw "no Platform installed".\n` +
    `  entry:       ${rel(file)}\n` +
    `  reaches:     ${seamUsers.join(", ")}\n` +
    `  It may throw only on an input that happens to hit the seam — that is how\n` +
    `  scripts/crossexec.ts stayed broken through a clean run.\n` +
    `  Fix, as the first import in ${rel(file)}:\n` +
    `      import "${up}src/platform";\n` +
    `  See src/platform.registry.ts for why this is not automatic.`
  );
}

function listScripts(): string[] {
  const dir = join(CLIENT_DIR, "scripts");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(dir, f))
    .sort();
}

function packageJsonEntries(): { name: string; file: string }[] {
  const pkg = JSON.parse(readFileSync(join(CLIENT_DIR, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const out: { name: string; file: string }[] = [];
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (/^bun\s+test\b/.test(command)) continue; // covered by bunfig's [test] preload
    const m = /(?:^|\s)((?:\.\/)?(?:src|scripts)\/[\w./-]+\.tsx?)(?:\s|$)/.exec(command);
    if (m === null) continue;
    const file = join(CLIENT_DIR, (m[1] as string).replace(/^\.\//, ""));
    if (existsSync(file)) out.push({ name, file });
  }
  return out;
}

/**
 * Who may import `platform.ts` for its VALUE.
 *
 * Every entry is host-only and unreachable from a browser or Hermes. Anything
 * else importing it puts `node:zlib`/`node:crypto` in the module graph, and a
 * Vite build over that graph fails with `"gzipSync" is not exported by
 * "__vite-browser-external"`.
 *
 * `platform.test.ts` and `platform.web.test.ts` test the module itself.
 */
const MAY_IMPORT_INSTALLER = new Set([
  "cli/main.ts",
  "store/open.ts",
  "store/file.ts",
  "store/driver.ts",
  "platform.test.ts",
  "platform.web.test.ts",
  // Phase 3's key material. Both files import `bunPlatform` for the same reason
  // `platform.web.test.ts` does: the property under test is that a blob wrapped
  // on one host unwraps on the other, and that cannot be checked from one side.
  // Tests are never in a browser bundle.
  "crypto/keys.test.ts",
  "crypto/phrase.test.ts",
]);

/** Every `client/src` file, recursively. */
function allSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...allSources(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("nothing browser-reachable imports platform.ts", () => {
  /**
   * The regression this pins is not hypothetical: `replay/snapshot.ts` imported
   * `../platform` and was missed when the other nine were repointed, because
   * nothing in the browser graph reached it. It stayed invisible until
   * `net/engine.ts` — which imports it — was wired into the PWA, and then the
   * whole bundle failed. A grep is what missed it, so this is not a grep.
   */
  test("only the host-only entrypoints import it, and they do it for the side effect", () => {
    const offenders: string[] = [];
    for (const file of allSources(join(CLIENT_DIR, "src"))) {
      if (file === INSTALLER) continue;
      const src = readFileSync(file, "utf8");
      const importsIt = runtimeImports(src).some((spec) => resolveSpec(file, spec) === INSTALLER);
      if (!importsIt) continue;
      const name = relative(join(CLIENT_DIR, "src"), file);
      if (!MAY_IMPORT_INSTALLER.has(name)) offenders.push(name);
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `these import src/platform.ts, which drags node:zlib/node:crypto into any bundle\n` +
          `  that reaches them and fails a Vite build:\n` +
          offenders.map((o) => `      src/${o}`).join("\n") +
          `\n  Import "../platform.registry" for the platform() seam instead. Only a\n` +
          `  host-only entrypoint may import src/platform.ts, to INSTALL the platform;\n` +
          `  add it to MAY_IMPORT_INSTALLER here if that is genuinely what it is.`,
    ).toEqual([]);
  });

  test("the allowlist has no dead entries", () => {
    for (const name of MAY_IMPORT_INSTALLER) {
      expect(existsSync(join(CLIENT_DIR, "src", name)), `${name} is allowlisted but does not exist`).toBe(true);
    }
  });
});

describe("every entrypoint that can reach the seam installs a Platform", () => {
  test("the walker is honest about what it measures", () => {
    // If any of these drift, every assertion below is vacuous.
    expect(moduleGraph(join(CLIENT_DIR, "src/cli/main.ts"))).toContain(INSTALLER);
    expect(moduleGraph(join(CLIENT_DIR, "src/wire/op.ts"))).not.toContain(INSTALLER);
    // The two seams that actually broke a script.
    expect(usesSeam(join(CLIENT_DIR, "src/wire/op.ts"))).toBe(true);
    expect(usesSeam(join(CLIENT_DIR, "src/norm/mime.ts"))).toBe(true);
    // A definition is not a use.
    expect(usesSeam(REGISTRY)).toBe(false);
    expect(usesSeam(INSTALLER)).toBe(false);
  });

  test("import type is not counted, because it is erased at runtime", () => {
    expect(runtimeImports(`import type { A } from "./a";`)).toEqual([]);
    expect(runtimeImports(`import { type A, b } from "./a";`)).toEqual(["./a"]);
    expect(runtimeImports(`import "./a";`)).toEqual(["./a"]);
    expect(runtimeImports(`export { a } from "./a";`)).toEqual(["./a"]);
    expect(runtimeImports(`export const a = "./not-an-import";`)).toEqual([]);
    expect(runtimeImports(`// import "./commented";\nimport "./real";`)).toEqual(["./real"]);
  });

  const scripts = listScripts();
  const entries = packageJsonEntries();

  test("there is something to check", () => {
    expect(scripts.length).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const file of scripts) {
    test(rel(file), () => {
      const problem = auditEntry(`the script ${rel(file)}`, file);
      expect(problem ?? "ok").toBe("ok");
    });
  }

  for (const { name, file } of entries) {
    test(`package.json script "${name}"`, () => {
      const problem = auditEntry(`the "${name}" package.json script`, file);
      expect(problem ?? "ok").toBe("ok");
    });
  }
});
