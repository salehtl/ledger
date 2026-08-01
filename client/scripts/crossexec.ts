/**
 * The cross-executor corpus differ.
 *
 * Reads what the Go normalizer produced for every message in the operator's v1
 * mail corpus (written by internal/v2/norm TestWriteCrossExecutorCorpus), runs
 * the TypeScript normalizer over the same bytes, and reports every field that
 * disagrees.
 *
 * This exists because the committed conformance set is 37 real messages out of
 * 7,002 — 0.5% — and a suite that only covers the cases someone thought to pick
 * is precisely the suite that agrees on 6,997 messages and disagrees on the one
 * that matters. The fixtures are the regression net that runs on every build;
 * this is the evidence that the net is in the right place.
 *
 *   S=/scratch
 *   LEDGER_CORPUS_DB=$S/corpus.db LEDGER_CROSSEXEC_OUT=$S/go-corpus.jsonl \
 *     go test ./internal/v2/norm/ -run TestWriteCrossExecutorCorpus -timeout 20m
 *   (cd client && bun run scripts/crossexec.ts $S/go-corpus.jsonl)
 *
 * Exits non-zero on any disagreement.
 */

import { normalize, NoTextPartError, UnsupportedCharsetError, CURRENT_VERSION } from "../src/norm/norm.ts";

interface Row {
  id: number;
  received_at: string;
  raw_base64: string;
  error: string;
  text_base64: string;
  part: string;
  charset: string;
  subject_base64: string;
  from_base64: string;
  forwarded: boolean;
  email_date: string;
  date_source: string;
}

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: bun run scripts/crossexec.ts <go-corpus.jsonl>");
  process.exit(2);
}

const utf8ToB64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Where two strings first differ, with a readable window around it. */
function firstDiff(got: string, want: string): string {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  const lo = Math.max(0, i - 50);
  const win = (s: string) => JSON.stringify(s.slice(lo, i + 50));
  return `at index ${i} of ${got.length}/${want.length}\n    go   ${win(want)}\n    ts   ${win(got)}`;
}

const counts: Record<string, number> = {};
const examples: Record<string, number[]> = {};
const note = (kind: string, id: number, detail?: string) => {
  counts[kind] = (counts[kind] ?? 0) + 1;
  (examples[kind] ??= []).push(id);
  if (detail !== undefined && counts[kind]! <= 3) console.error(`  [${kind}] id ${id}: ${detail}`);
};

let total = 0;
const stream = Bun.file(path).stream();
const decoder = new TextDecoder();
let pending = "";

const handle = (line: string) => {
  if (line.trim() === "") return;
  const r = JSON.parse(line) as Row;
  total++;
  const raw = Uint8Array.from(Buffer.from(r.raw_base64, "base64"));

  let got;
  try {
    got = normalize(CURRENT_VERSION, raw, r.received_at);
  } catch (e) {
    if (e instanceof NoTextPartError) {
      if (r.error !== "no_text_part") note("ts_threw_no_text_part", r.id, `go said ${JSON.stringify(r.error)}`);
      return;
    }
    if (e instanceof UnsupportedCharsetError) {
      note("ts_unsupported_charset", r.id, e.message);
      return;
    }
    note("ts_threw_unexpected", r.id, `${(e as Error).name}: ${(e as Error).message}`);
    return;
  }
  if (r.error !== "") {
    note("go_errored_ts_did_not", r.id, `go: ${r.error}`);
    return;
  }
  if (utf8ToB64(got.text) !== r.text_base64) {
    note("text", r.id, firstDiff(got.text, Buffer.from(r.text_base64, "base64").toString("utf8")));
  }
  if (got.partUsed !== r.part) note("part", r.id, `go ${r.part} / ts ${got.partUsed}`);
  if (got.charset !== r.charset) note("charset", r.id, `go ${r.charset} / ts ${got.charset}`);
  if (utf8ToB64(got.subject) !== r.subject_base64) {
    note("subject", r.id, firstDiff(got.subject, Buffer.from(r.subject_base64, "base64").toString("utf8")));
  }
  if (utf8ToB64(got.from) !== r.from_base64) {
    note("from", r.id, `go ${JSON.stringify(Buffer.from(r.from_base64, "base64").toString("utf8"))} / ts ${JSON.stringify(got.from)}`);
  }
  if (got.forwarded !== r.forwarded) note("forwarded", r.id, `go ${r.forwarded} / ts ${got.forwarded}`);
  if (got.emailDate !== r.email_date) note("email_date", r.id, `go ${r.email_date} / ts ${got.emailDate}`);
  if (got.dateSource !== r.date_source) note("date_source", r.id, `go ${r.date_source} / ts ${got.dateSource}`);
};

for await (const chunk of stream) {
  pending += decoder.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = pending.indexOf("\n")) >= 0) {
    handle(pending.slice(0, nl));
    pending = pending.slice(nl + 1);
  }
}
handle(pending);

const kinds = Object.keys(counts).sort();
console.log(`\ncrossexec: ${total} messages compared`);
if (kinds.length === 0) {
  console.log("crossexec: 0 disagreements — the two executors are byte-identical on the whole corpus");
  process.exit(0);
}
for (const k of kinds) {
  console.log(`  ${k}: ${counts[k]}  ids: ${examples[k]!.slice(0, 15).join(", ")}${examples[k]!.length > 15 ? ", …" : ""}`);
}
process.exit(1);
