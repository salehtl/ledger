/**
 * "Download my data" — the export half of the alpha consent promise.
 *
 * `docs/alpha-consent.md` tells every alpha user they may access, export and
 * delete their data, "all of which are available in the app". Deletion and
 * access exist. This is export, and until it landed that sentence was not true.
 *
 * # It reads the projection this device holds, and says so
 *
 * There is no server route and there cannot be one: the op log is sealed, so
 * the server holds ciphertext it cannot assemble into a statement. The file is
 * built here, from the local SQLite projection, page by page — the same keyset
 * walk the transaction list uses, so a large ledger does not load itself into
 * one array twice.
 *
 * That makes the scope a real question, and the screen answers it out loud: a
 * device that has not finished a sync holds part of the ledger, and an export
 * from it is part of the ledger. Saying "your data" over a partial download
 * would be the same defect as a silent partial import.
 */

import { useCallback, useMemo, useState } from "react";

import type { Txn } from "@ledger/client/replay/state";

import { Button } from "../components/ui/Button";
import { InfoTip } from "../components/ui/InfoTip";
import { useV2 } from "../v2/BootGate";
import { useTxnSource } from "../v2/queries";
import { exportable, exportCSV, exportFileName } from "../v2/sources/exportFile";
import { EMPTY_FILTERS, type TxnCursor, type TxnSource } from "../v2/sources/transactions";

/** Rows per page of the walk. Bounded so one query never holds a whole ledger. */
const PAGE = 500;

export interface ExportDataProps {
  /** Injected in tests; defaults to this device's projection. */
  source?: TxnSource;
  now?: () => Date;
  /** Injected in tests — jsdom has no download. */
  saveAs?: (fileName: string, text: string) => void;
}

/** Every live transaction, walked in pages rather than read in one go. */
export function readAllTxns(source: TxnSource): Txn[] {
  const out: Txn[] = [];
  let after: TxnCursor | null = null;
  for (;;) {
    const page: { rows: Txn[]; next: TxnCursor | null } = source.list(EMPTY_FILTERS, { limit: PAGE, after });
    out.push(...page.rows);
    if (page.next === null || page.rows.length === 0) return out;
    after = page.next;
  }
}

function browserSave(fileName: string, text: string): void {
  // `text/csv` with an explicit charset: a spreadsheet that guesses Latin-1
  // renders an Arabic merchant name as mojibake.
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportData({ source: injected, now = () => new Date(), saveAs = browserSave }: ExportDataProps) {
  const runtime = useV2();
  const fallback = useTxnSource();
  const source = injected ?? fallback;
  const [done, setDone] = useState("");
  const [error, setError] = useState("");

  /**
   * Whether this device has ever finished a sync.
   *
   * `lastCompletedAt` is the coordinator's, republished by the gate. A device
   * that has never completed one may hold nothing, or may hold a stale part of
   * the log — either way the export would be partial, and a person downloading
   * "their data" has to be told which of the two they are getting.
   */
  const synced = runtime?.sync.lastCompletedAt ?? null;

  // What will be IN the file, not what is in the projection: a count that
  // included the rows the export leaves out would be a number the downloaded
  // file contradicts.
  const count = useMemo(() => (source === null ? 0 : readAllTxns(source).filter(exportable).length), [source]);

  const download = useCallback((): void => {
    if (source === null) return;
    setError("");
    try {
      const rows = readAllTxns(source).filter(exportable);
      saveAs(exportFileName(now()), exportCSV(rows));
      setDone(`${rows.length} transaction${rows.length === 1 ? "" : "s"} saved.`);
    } catch {
      setError("The file could not be saved. Try again.");
    }
  }, [source, saveAs, now]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed text-muted">
        Saves your transactions as a CSV file you can open in a spreadsheet. The file is built on this device and
        never uploaded.
      </p>

      <p className="text-sm text-fg" data-testid="export-scope">
        {synced === null
          ? "This device has not finished a sync yet, so this may not be your whole ledger."
          : "This exports what this device holds, which is everything it has synced."}{" "}
        <InfoTip about="what is in the file" testId="export-tip">
          Date, description, amount, currency, spending or income, and category. Replaced rows, split parts and
          messages ledger could not read are left out, so each transaction appears once.
        </InfoTip>
      </p>

      <p className="text-sm text-muted tnum" data-testid="export-count">
        {count} transaction{count === 1 ? "" : "s"} on this device.
      </p>

      {error !== "" && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {done !== "" && (
        <p role="status" data-testid="export-done" className="text-sm text-fg">
          {done}
        </p>
      )}

      <Button variant="secondary" data-testid="export-download" disabled={source === null} onClick={download}>
        Download my data
      </Button>
      {source === null && <p className="text-xs text-muted">Sign in to download your ledger.</p>}
    </div>
  );
}
