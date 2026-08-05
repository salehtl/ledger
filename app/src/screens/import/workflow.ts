import type { OpSpec } from "@ledger/client/outbox/outbox.ts";
import { parseCSV, type RawRow } from "@ledger/client/importer/csv.ts";
import { normalizeRows, type NormalizeResult, type NormalizedImportRow } from "@ledger/client/importer/normalize.ts";
import type { ImportMap } from "@ledger/client/importer/map.ts";
import { sha256 } from "../../platform/hash.ts";
import { toHex } from "../../platform/bytes.ts";

export const IMPORT_PREVIEW_ROWS = 20;
export const IMPORT_BLOB_TARGET_BYTES = 900_000;

export interface ImportPreview { headers: string[]; raw: RawRow[]; results: NormalizeResult[] }
export interface ImportPlan { specs: OpSpec[]; errors: NormalizeResult[]; estimatedBlobs: number }
export interface ImportIO { enqueueMany(specs: readonly OpSpec[]): void; newId(): string; yieldToUI(): Promise<void>; onProgress?(completed: number, total: number): void }

export function previewCSV(text: string, map: ImportMap): ImportPreview {
  const parsed = parseCSV(text);
  const raw = parsed.rows.slice(0, IMPORT_PREVIEW_ROWS);
  return { headers: parsed.headers, raw, results: normalizeRows(raw, map) };
}

function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }

export function importedIngestID(fileIdentity: string, rowIndex: number): string {
  return toHex(sha256(utf8(`csv-import\u0000${fileIdentity}\u0000${rowIndex}`)));
}

export function importSpec(row: NormalizedImportRow, id: string, fileIdentity: string): OpSpec {
  return {
    type: "txn_ingested", entity: { kind: "txn", id }, parentVersion: null, ingestId: importedIngestID(fileIdentity, row.rowIndex),
    payload: { amount_minor: row.amountMinor.toString(10), currency: row.currency, direction: row.direction,
      posted_at: row.postedAt, merchant_raw: row.merchantRaw, last4: "", category: row.category,
      needs_review: true, tier: "none" },
  };
}

/** Conservative packing estimate; the real Client re-measures encoded ops before sealing. */
export function estimatedBlobCount(specs: readonly OpSpec[]): number {
  let blobs = 0, bytes = 0;
  for (const spec of specs) {
    const size = utf8(JSON.stringify(spec)).byteLength + 256;
    if (bytes === 0 || bytes + size > IMPORT_BLOB_TARGET_BYTES) { blobs++; bytes = size; } else bytes += size;
  }
  return blobs;
}

export function planImport(text: string, map: ImportMap, newId: () => string): ImportPlan {
  const results = normalizeRows(parseCSV(text).rows, map);
  const fileIdentity = toHex(sha256(utf8(text)));
  const specs = results.flatMap((r) => r.ok ? [importSpec(r.row, newId(), fileIdentity)] : []);
  return { specs, errors: results.filter((r) => !r.ok), estimatedBlobs: estimatedBlobCount(specs) };
}

/** Enqueues in responsive chunks; Outbox/Client coalesces these ops into capped blobs. */
export async function commitImport(plan: ImportPlan, io: ImportIO, chunk = 250): Promise<void> {
  for (let i = 0; i < plan.specs.length; i += chunk) {
    const batch = plan.specs.slice(i, i + chunk);
    io.enqueueMany(batch);
    io.onProgress?.(i + batch.length, plan.specs.length);
    if (i + chunk < plan.specs.length) await io.yieldToUI();
  }
}
