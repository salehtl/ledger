import type { SqlDriver } from "@ledger/client/store/driver.ts";
import { TXN_COLUMNS, decodeTxnRow, projectionIsUsable, readAnomalies, readForks, readMeta, readRates, readRules } from "@ledger/client/replay/projection.ts";
import type { Split, Txn } from "@ledger/client/replay/state.ts";
import { EXPORT_CHUNK, exportFileName, renderExport, writeExport, type ExportFormat, type ExportReport, type ExportSource } from "../lib/export.ts";

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is not a non-negative safe integer`);
  return value;
}

/** A complete, independently-counted export view over the current projection. */
export function sqlExportSource(db: SqlDriver, generatedAt: string): ExportSource {
  if (!projectionIsUsable(db)) throw new Error("the local projection is not complete; sync before exporting");
  const meta = readMeta(db)!;
  const countRow = db.prepare("SELECT count(*) AS n FROM txn").all()[0] as Record<string, unknown>;
  return {
    generatedAt, homeCurrency: meta.homeCurrency, cursorHot: meta.cursorHot, cursorCold: meta.cursorCold,
    txnCount: integer(countRow["n"], "transaction count"),
    rules: [...readRules(db).values()], rates: readRates(db), forks: readForks(db), anomalies: readAnomalies(db),
    *txnChunks(): Iterable<readonly Txn[]> {
      let after = "";
      for (;;) {
        const rows = db.prepare(`SELECT ${TXN_COLUMNS} FROM txn WHERE id > ? ORDER BY id LIMIT ?`).all(after, EXPORT_CHUNK) as Record<string, unknown>[];
        if (rows.length === 0) return;
        const ids = rows.map((r) => String(r["id"]));
        const splitRows = db.prepare(`SELECT txn_id, idx, category, amount_minor FROM txn_split WHERE txn_id IN (${ids.map(() => "?").join(",")}) ORDER BY txn_id, idx`).all(...ids) as Record<string, unknown>[];
        const splits = new Map<string, Split[]>();
        for (const r of splitRows) {
          const id = String(r["txn_id"]); const list = splits.get(id) ?? [];
          if (typeof r["category"] !== "string" || typeof r["amount_minor"] !== "string") throw new Error("invalid projected split");
          list.push({ category: r["category"], amount_minor: BigInt(r["amount_minor"]) }); splits.set(id, list);
        }
        yield rows.map((r) => decodeTxnRow(r, splits.get(String(r["id"])) ?? []));
        after = ids[ids.length - 1] as string;
      }
    },
  };
}

export interface ExportFileIO { open(name: string): { uri: string; write(bytes: Uint8Array): void; close(): void }; share(uri: string, format: ExportFormat): Promise<void>; }

export async function exportAndShare(source: ExportSource, format: ExportFormat, io: ExportFileIO, between: (chunk: number) => Promise<void> = () => new Promise((r) => setTimeout(r, 0))): Promise<ExportReport & { uri: string }> {
  const file = io.open(exportFileName(format, source.generatedAt));
  const encoder = new TextEncoder();
  let closed = false;
  try {
    const report = await writeExport(renderExport(source, format), (piece) => file.write(encoder.encode(piece)), { between });
    file.close(); closed = true;
    await io.share(file.uri, format);
    return { ...report, uri: file.uri };
  } catch (error) { if (!closed) file.close(); throw error; }
}
