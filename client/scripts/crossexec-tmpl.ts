/**
 * The cross-executor corpus differ for the TEMPLATE EXECUTOR.
 *
 * Reads what the Go executor produced for every (published template, corpus
 * message) pair (written by internal/v2/tmpl TestWriteCrossExecutorTemplates),
 * runs the TypeScript executor over the same inputs, and reports every field
 * that disagrees.
 *
 * This exists because the committed conformance set samples 500 messages per
 * template out of 6,868 — and a suite that only covers the cases someone
 * thought to pick is precisely the suite that agrees on 6,929 messages and
 * disagrees on the one that matters. The fixtures are the regression net that
 * runs on every build; this is the evidence that the net is in the right place.
 *
 *   S=/scratch
 *   LEDGER_CORPUS_DB=$S/corpus.db LEDGER_CROSSEXEC_OUT=$S/go-templates.jsonl \
 *     go test ./internal/v2/tmpl/ -run TestWriteCrossExecutorTemplates -timeout 20m
 *   (cd client && bun run scripts/crossexec-tmpl.ts $S/go-templates.jsonl)
 *
 * Exits non-zero on any disagreement.
 */

import { compileDefinition, type Compiled, type Definition, type Extraction } from "../src/tmpl/exec.ts";

interface Row {
  template: string;
  definition_base64: string;
  id: number;
  subject_base64: string;
  normalized_body_base64: string;
  expect: {
    matched: boolean;
    error: string;
    amount_minor: string;
    currency: string;
    direction: string;
    posted_at: string;
    merchant: string;
    last4: string;
    is_transfer: boolean;
    empty_groups: string[];
  };
}

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: bun run scripts/crossexec-tmpl.ts <go-templates.jsonl>");
  process.exit(2);
}

const fromB64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

const counts: Record<string, number> = {};
const examples: Record<string, string[]> = {};
const note = (kind: string, where: string, detail?: string): void => {
  counts[kind] = (counts[kind] ?? 0) + 1;
  const seen = (examples[kind] ??= []);
  if (seen.length < 5) seen.push(detail === undefined ? where : `${where}: ${detail}`);
};

/** Compiled once per template, not once per row: the corpus has 6,868 rows per DIB template. */
const compiled = new Map<string, Compiled>();
function forTemplate(r: Row): Compiled {
  const have = compiled.get(r.template);
  if (have !== undefined) return have;
  const d = JSON.parse(fromB64(r.definition_base64)) as Definition;
  const c = compileDefinition(d);
  compiled.set(r.template, c);
  return c;
}

let rows = 0;
let matched = 0;
const text = await Bun.file(path).text();
for (const line of text.split("\n")) {
  if (line === "") continue;
  const r = JSON.parse(line) as Row;
  rows++;
  const where = `${r.template}/${r.id}`;

  let got: Extraction;
  try {
    got = forTemplate(r).execute(fromB64(r.subject_base64), fromB64(r.normalized_body_base64));
  } catch (e) {
    note("threw", where, String(e));
    continue;
  }
  if (got.matched) matched++;

  const cmp: [string, unknown, unknown][] = [
    ["matched", got.matched, r.expect.matched],
    ["error", got.error, r.expect.error],
    ["amount_minor", got.amount_minor.toString(), r.expect.amount_minor],
    ["currency", got.currency, r.expect.currency],
    ["direction", got.direction, r.expect.direction],
    ["posted_at", got.posted_at, r.expect.posted_at],
    ["merchant", got.merchant, r.expect.merchant],
    ["last4", got.last4, r.expect.last4],
    ["is_transfer", got.is_transfer, r.expect.is_transfer],
    ["empty_groups", got.empty_groups.join("|"), r.expect.empty_groups.join("|")],
  ];
  for (const [field, ts, go] of cmp) {
    if (ts !== go) note(field, where, `go ${JSON.stringify(go)} / ts ${JSON.stringify(ts)}`);
  }
}

console.log(`${rows} rows, ${matched} matched by the TypeScript executor`);
const kinds = Object.keys(counts).sort();
if (kinds.length === 0) {
  console.log("no disagreements");
  process.exit(0);
}
for (const k of kinds) {
  console.log(`\n${k}: ${counts[k]}`);
  for (const e of examples[k] ?? []) console.log(`  ${e}`);
}
process.exit(1);
