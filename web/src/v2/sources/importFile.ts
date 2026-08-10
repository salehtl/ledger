/**
 * Bulk import: a file the user exported from their bank becomes ops.
 *
 * # Nothing here is a second parser
 *
 * `client/src/importer/` already holds the RFC-4180 reader, the column map, the
 * exact integer minor-unit money and the cross-language conformance vectors, and
 * it is the only thing that reads a row. This file is the layer between that
 * library and the outbox: it decides *whether a batch may be authored at all*,
 * and it builds the payloads.
 *
 * # Validate the WHOLE file, then author, or author nothing
 *
 * An op is permanent on every device the user owns. A loop that authored rows as
 * it read them would, on a file whose 800th row is malformed, leave 799 ops in
 * the log and a screen apologising — and there is no delete. So
 * {@link planImport} normalizes every row first and {@link importTxnOps} refuses
 * the batch if *any* row failed. The user sees the failures and fixes the file.
 *
 * # The op is `txn_ingested`, not a type of its own
 *
 * The same argument `manualTxnPayload` makes: a new op type costs
 * `SCHEMA_VERSION` 4, and a v3 device meeting a v4 op raises
 * `UnknownNewerVersionError`, which halts that device's WHOLE sync. So the
 * provenance rides as **optional payload keys** — `entry_method: "import"`, plus
 * the source file's hash and the row's index, which are the audit trail for
 * "where did this row come from". Nothing reads them for authority: replay
 * derives provenance from the WRITER (`replay.ts`, `MONEY_OWNED`), and a payload
 * key a client writes freely could never be evidence of anything.
 *
 * # Dedup is replay's fingerprint index, and the ingest id is RANDOM
 *
 * Exactly as hand entry does it ({@link newIngestID}). A content-hashed ingest
 * id would make a second identical row a `duplicate_ingest` anomaly and DROP it
 * — and two identical coffees on one day are two coffees. Replay's
 * `byFingerprint` index raises `possible_duplicate_of` as a *notice* on rows
 * sharing `last4|amount|direction|merchant|day`, which is how re-importing an
 * overlapping statement surfaces: visibly, in the review queue, never as a
 * silent drop and never as a silent double-count.
 */

import { parseCSV, type RawRow } from "@ledger/client/importer/csv";
import { validateMap, type ColumnMap, type ImportMap } from "@ledger/client/importer/map";
import { normalizeRows, type NormalizedImportRow } from "@ledger/client/importer/normalize";
import type { OpSpec } from "@ledger/client/outbox/outbox";
import { webPlatform } from "@ledger/client/platform.web";

export type { ImportMap, ColumnMap, NormalizedImportRow };

/** The `entry_method` an imported op carries. A label, never an authority. */
export const IMPORT_ENTRY_METHOD = "import";

/**
 * The per-batch ceiling on ops.
 *
 * Not a performance number — `client/src/importer/packing.test.ts` measures the
 * production packer at 3,683 rows without trouble. It is a blast-radius number:
 * this is the one screen in the app that turns one tap into thousands of
 * permanent ops, and a user who picked the wrong file should meet a refusal
 * rather than a log. A statement longer than this is imported a period at a
 * time, which is also how banks export them.
 */
export const MAX_IMPORT_ROWS = 2_000;

/** Where a row was refused, and why, in the file's own row numbering. */
export interface RowProblem {
  /** 1-based, counting the header as row 0 — the number a spreadsheet shows. */
  rowIndex: number;
  error: string;
}

/**
 * What the preview shows and what the author reads. Never a partial success:
 * `problems` non-empty means no op will be built from any of it.
 */
export interface ImportPlan {
  headers: readonly string[];
  rows: readonly NormalizedImportRow[];
  problems: readonly RowProblem[];
  /** The file had more rows than {@link MAX_IMPORT_ROWS}. */
  overCap: boolean;
  /** True only when a batch could be authored from this plan as it stands. */
  authorable: boolean;
}

/** hex sha256 of the file's BYTES, so the audit trail names the file, not its text. */
export function fileDigest(bytes: Uint8Array): string {
  let out = "";
  for (const b of webPlatform.sha256(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * A fresh ingest id: sha256 of a random UUID, per row.
 *
 * `validateOp` requires 64 lower-case hex on every `txn_ingested`, because
 * `state.ts:fingerprint` keys an unparsed row as `unparsed|${ingest_id}` and
 * leans on hex being unable to contain a `|`. See the header for why it is
 * random and never a hash of the row.
 */
export function newIngestID(): string {
  return fileDigest(new TextEncoder().encode(webPlatform.randomUUID()));
}

/**
 * The column names this file's headers suggest, and nothing about any bank.
 *
 * **There are no bank presets in this build.** Inventing a column layout for an
 * export nobody here has seen would be a preset that silently maps the wrong
 * column onto `amount`, and the user would confirm a preview built from that
 * mistake. So the guess is made from the file the user actually supplied — every
 * value comes from its own header row — and the mapping screen is always shown
 * with the guess filled in and every field editable. When a real export is in
 * hand, a named preset goes in this file and the mapping screen becomes the
 * fallback rather than the path.
 */
export function detectColumns(headers: readonly string[]): { columns: ColumnMap; directionMode: ImportMap["directionMode"] } {
  const find = (...wants: string[]): string => {
    for (const want of wants) {
      const hit = headers.find((h) => h.trim().toLowerCase() === want);
      if (hit !== undefined) return hit;
    }
    for (const want of wants) {
      const hit = headers.find((h) => h.trim().toLowerCase().includes(want));
      if (hit !== undefined) return hit;
    }
    return "";
  };
  const debit = find("debit", "withdrawal", "money out", "paid out");
  const credit = find("credit", "deposit", "money in", "paid in");
  const amount = find("amount", "value");
  const columns: ColumnMap = {
    date: find("transaction date", "value date", "date", "posted"),
    description: find("description", "narrative", "details", "merchant", "particulars", "remarks"),
    ...(amount === "" ? {} : { amount }),
    ...(debit === "" ? {} : { debit }),
    ...(credit === "" ? {} : { credit }),
  };
  const category = find("category");
  if (category !== "") columns.category = category;
  // Two columns beat one signed column when both are present: a statement that
  // ships Debit and Credit usually leaves both unsigned, and reading one of them
  // as signed would file every payment as income.
  return { columns, directionMode: debit !== "" && credit !== "" ? "columns" : "sign" };
}

/**
 * A refusal the importer's own normalizer cannot make, because it does not know
 * what replay will accept.
 *
 * `decodeTxnPayload` refuses a parsed row whose amount is zero — "zero is not
 * money movement" — as an `invalid_payload` anomaly, which would be a row the
 * user watched a preview promise and then never saw. So it is refused here,
 * where it is still a fixable line in a file.
 */
function payloadProblem(row: NormalizedImportRow): string {
  if (row.amountMinor <= 0n) return "amount is zero; a transaction moves money";
  if (!/^[A-Z]{3}$/.test(row.currency)) return `currency ${JSON.stringify(row.currency)} is not a 3-letter code`;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(row.postedAt)) return `date ${JSON.stringify(row.postedAt)} is not a date`;
  if (row.merchantRaw === "") return "description is empty";
  return "";
}

/** Reads the file text and normalizes every row. Throws only on unreadable CSV. */
export function planImport(text: string, map: ImportMap): ImportPlan {
  const { headers, rows } = parseCSV(text);
  const configErrors = validateMap(map);
  if (configErrors.length > 0) {
    return { headers, rows: [], problems: [{ rowIndex: 0, error: configErrors.join(" ") }], overCap: false, authorable: false };
  }
  return planRows(headers, rows, map);
}

function planRows(headers: readonly string[], raw: readonly RawRow[], map: ImportMap): ImportPlan {
  const rows: NormalizedImportRow[] = [];
  const problems: RowProblem[] = [];
  for (const result of normalizeRows(raw, map)) {
    if (!result.ok) {
      problems.push({ rowIndex: result.rowIndex, error: result.error });
      continue;
    }
    const problem = payloadProblem(result.row);
    if (problem !== "") {
      problems.push({ rowIndex: result.row.rowIndex, error: problem });
      continue;
    }
    rows.push(result.row);
  }
  const overCap = rows.length + problems.length > MAX_IMPORT_ROWS;
  if (rows.length === 0 && problems.length === 0) {
    problems.push({ rowIndex: 0, error: "This file has a header row and no transactions." });
  }
  return { headers, rows, problems, overCap, authorable: problems.length === 0 && !overCap && rows.length > 0 };
}

export interface ImportOpsArgs {
  plan: ImportPlan;
  /** hex sha256 of the file's bytes, from {@link fileDigest}. */
  fileSha256: string;
  /** A ULID source — `newEntityID`. Injected so a test can pin ids. */
  newID: () => string;
  /** Injected so a test can pin ingest ids. Defaults to {@link newIngestID}. */
  ingestID?: () => string;
}

export type ImportOpsResult = { ok: true; specs: OpSpec[] } | { ok: false; reason: string };

/**
 * The batch, or the reason there is no batch. Never a partial one.
 *
 * Every refusal below is also visible in the preview the user just read; they
 * are repeated here because this is the function that can actually author, and a
 * check that lives only on a screen is a check a second caller skips.
 */
export function importTxnOps(args: ImportOpsArgs): ImportOpsResult {
  const { plan } = args;
  if (!/^[0-9a-f]{64}$/.test(args.fileSha256)) return { ok: false, reason: "The file could not be fingerprinted, so nothing was imported." };
  if (plan.overCap) {
    return {
      ok: false,
      reason: `That file has more than ${MAX_IMPORT_ROWS.toLocaleString("en")} rows. Export a shorter period and import it in parts.`,
    };
  }
  if (plan.problems.length > 0) {
    return { ok: false, reason: `${plan.problems.length} row${plan.problems.length === 1 ? "" : "s"} could not be read, so nothing was imported.` };
  }
  if (plan.rows.length === 0) return { ok: false, reason: "There is nothing to import." };
  const ingest = args.ingestID ?? newIngestID;
  return {
    ok: true,
    specs: plan.rows.map((row) => ({
      type: "txn_ingested" as const,
      entity: { kind: "txn" as const, id: args.newID() },
      parentVersion: null,
      ingestId: ingest(),
      payload: {
        // A decimal STRING, not a JSON number: `JSON.parse` of a number is a
        // float64, so an int64 amount would round on the way through the wire.
        amount_minor: row.amountMinor.toString(10),
        currency: row.currency,
        direction: row.direction,
        posted_at: row.postedAt,
        merchant_raw: row.merchantRaw,
        last4: "",
        category: row.category,
        // A row with no category is a review item, which is what replay would
        // default to anyway; stated rather than implied.
        needs_review: row.category === null,
        unparsed: false,
        tier: "none",
        entry_method: IMPORT_ENTRY_METHOD,
        // The audit trail. Optional keys, read by nothing, needing no version
        // bump — see the header.
        source_file_sha256: args.fileSha256,
        source_row_index: row.rowIndex,
      },
    })),
  };
}
