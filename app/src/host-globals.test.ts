/**
 * `app/src` may not reach for a host global that Hermes does not have.
 *
 * `app/tsconfig.json` has `@types/bun` in scope — it has to, because
 * `client/src/platform.ts` genuinely calls `new Bun.CryptoHasher(...)` and
 * nothing that imports the seam would type-check without it. The side effect is
 * that `Buffer`, `process` and `Bun` are all *typed* inside `app/src`, where
 * none of them exist at runtime, so the type system will happily wave through
 * `Buffer.from(x)` in a screen and Hermes will throw on it.
 *
 * TypeScript cannot express "these globals exist in that file but not this
 * one", so the rule is measured here instead: every `.ts`/`.tsx` file under
 * `src/` is read and matched against the host globals, with `src/platform/` —
 * the seam's own implementation, and the only place a Node import belongs —
 * exempt.
 *
 * This is the same shape as the v1 harness's `audit.mjs`: a checker that reads
 * the laid-out result rather than trusting the source's intent. And, per that
 * codebase's rule, a deliberate exception must be taught to the checker in the
 * same commit rather than left to make it cry wolf.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL(".", import.meta.url).pathname;

/**
 * `src/platform/` implements the seam — Node's `zlib` and `crypto` are what it
 * is checked against. Nothing else is exempt.
 *
 * `*.test.ts` is skipped as a category, and that is a judgement rather than a
 * convenience: a test file never enters the Metro graph (nothing imports one),
 * it runs under Bun, and a rule that forbade `node:fs` in a test would forbid
 * this checker from reading the tree.
 */
const EXEMPT_DIRS = ["platform"];
const isTest = (rel: string) => rel.endsWith(".test.ts") || rel.endsWith(".test.tsx");

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "Bun global", re: /\bBun\s*\./ },
  { name: "Buffer", re: /\bBuffer\s*\./ },
  { name: "process.*", re: /\bprocess\s*\.(env|argv|exit|platform)\b/ },
  { name: 'node: import', re: /from\s+["']node:[a-z]+["']/ },
  { name: "bun: import", re: /from\s+["']bun:[a-z]+["']/ },
  { name: "__dirname / __filename", re: /\b__(dirname|filename)\b/ },
];

function walk(dir: string, rel = ""): { path: string; rel: string }[] {
  const out: { path: string; rel: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (EXEMPT_DIRS.includes(r)) continue;
      out.push(...walk(abs, r));
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
      out.push({ path: abs, rel: r });
    }
  }
  return out;
}

describe("app/src does not use host globals Hermes lacks", () => {
  const files = walk(SRC).filter((f) => !isTest(f.rel));

  // A checker that found no files to check is a checker that passes for the
  // wrong reason — this is the same "true by construction" trap the project's
  // rules call out, and it is the one a directory rename would spring.
  test("the walk actually found source files", () => {
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => f.rel.startsWith("app/"))).toBe(true);
    expect(files.some((f) => f.rel.startsWith("db/"))).toBe(true);
    expect(files.some((f) => f.rel.startsWith("screens/"))).toBe(true);
    expect(files.every((f) => !isTest(f.rel))).toBe(true);
  });

  // And that it can still see a violation when one is there.
  test("the patterns match what they claim to match", () => {
    const sample = 'const a = Buffer.from(x);\nimport { z } from "node:zlib";\nprocess.env.HOME;\nBun.file("x");\n';
    const hits = FORBIDDEN.filter((f) => f.re.test(sample)).map((f) => f.name);
    expect(hits.sort()).toEqual(["Bun global", "Buffer", "node: import", "process.*"].sort());
  });

  test("no file outside src/platform reaches for one", () => {
    const violations: string[] = [];
    for (const f of files) {
      const src = readFileSync(f.path, "utf8");
      for (const rule of FORBIDDEN) {
        if (rule.re.test(src)) violations.push(`${f.rel}: ${rule.name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
