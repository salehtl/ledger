import { expect, test } from "bun:test";
import { closeSync, openSync, readSync } from "node:fs";

/**
 * A literal NUL byte in a source file makes both `grep` and `git` classify that
 * file as BINARY. `grep` then prints nothing and exits 1 with no warning, and
 * `git diff` renders `Bin 9166 -> 11811 bytes` instead of a diff. The file is
 * still perfectly valid TypeScript/Go, so nothing else complains — it simply
 * disappears from every tool anyone uses to read the codebase.
 *
 * That has cost this project five times:
 *
 *   1. `client/src/replay/snapshot.ts` hid a module from TWO grep-based audits
 *      of `platform` importers, until a later task made it reachable and the
 *      whole PWA build failed on `node:zlib`.
 *   2. `web/src/v2/queries.ts` rendered as binary in a code review, hiding
 *      `useReviewSource`/`useReviewFeed` — a screen's entire data path.
 *   3. `web/src/v2/deviceEnrolment.ts` did the same to a digest domain constant.
 *   4. `web/src/screens/settings/RecoverWritePanel.test.tsx` hid an entire TEST
 *      FILE from a security review, producing a FALSE finding ("there is no
 *      test for this") that was reported to the operator as fact.
 *   5. A sweep found three more, all converted in the commit that added this test.
 *
 * Every one was fixed the same way, and it is the only fix: write the byte as
 * the escape `\x00`. The runtime string is unchanged — `"a\x00b"` and a literal
 * are the same three code points — but the FILE is plain ASCII, so grep and
 * git see it again. This test is what stops a sixth.
 */

/** Repo root, resolved from this file rather than from the runner's cwd. */
const root = new URL("../../../", import.meta.url).pathname;

/**
 * The trees a NUL is a defect in. Everything here is hand-written source.
 * `frontend/`, `app/`, `spike/` and `conformance/` are deliberately out of
 * scope: they hold image assets and binary conformance blobs whose whole
 * purpose is to contain arbitrary bytes.
 */
const ROOTS = ["client/src", "web/src", "internal", "cmd"];

/**
 * Build output only — never source. Kept as an explicit, short list rather than
 * a pattern like `**\/dist/**`, because a broad pattern is exactly how a source
 * file would slip back through: these two directories are `vite build` output
 * committed as Go `embed.FS` artifacts (fonts, .wasm, .jpg), and nothing else
 * under the scanned roots is exempt. `node_modules` and `dist-types` are listed
 * for the same reason even though neither is tracked.
 */
const EXCLUDED = [
  "internal/web/dist/",
  "internal/v2/webui/dist/",
  "node_modules/",
  "dist-types/",
];

/** Tracked paths under ROOTS, minus EXCLUDED. NUL-delimited, so odd names survive. */
function trackedFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--", ...ROOTS], { cwd: root, stderr: "pipe" });
  if (!out.success) throw new Error(`git ls-files failed in ${root}: ${out.stderr.toString()}`);
  return out.stdout
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "" && !EXCLUDED.some((e) => p.startsWith(e) || p.includes(`/${e}`)));
}

/**
 * Chunked, not `readFileSync`: the scanned roots include multi-megabyte
 * embedded artifacts and Go test corpora, and this runs on every `bun test`.
 * A 64 KiB window means peak memory is one buffer no matter how large the tree
 * grows, and the common case (no NUL) still reads each file exactly once.
 */
const CHUNK = 64 * 1024;
const buf = Buffer.allocUnsafe(CHUNK);

function hasNul(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) return false;
      if (buf.subarray(0, n).includes(0)) return true;
    }
  } finally {
    closeSync(fd);
  }
}

test("no tracked source file contains a literal NUL byte", () => {
  const files = trackedFiles();
  // A collapsed glob or a bad cwd would silently scan nothing and pass.
  expect(files.length).toBeGreaterThan(100);

  const offenders = files.filter((p) => hasNul(`${root}${p}`));
  expect(
    offenders,
    offenders.length === 0
      ? ""
      : `These files contain a literal NUL byte, which makes grep and git treat them as BINARY ` +
        `— grep silently finds nothing in them and git diff shows "Bin ... bytes" instead of a diff:\n` +
        offenders.map((p) => `  ${p}`).join("\n") +
        `\n\nFix: replace the literal NUL with the escape \\x00 (e.g. "a\\x00b"). ` +
        `The runtime string is byte-identical — this changes only the file's spelling, not its value. ` +
        `Find the byte with:  grep -naU -P '\\x00' <file>`,
  ).toEqual([]);
});
