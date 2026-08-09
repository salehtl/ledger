/**
 * Import a statement file.
 *
 * # Everything happens on this device
 *
 * The file is read with `FileReader`, parsed by `client/src/importer`, and
 * turned into ops by `v2/sources/importFile.ts`. No row is ever uploaded: the
 * server sees sealed ops and nothing else, and after sealing it could not read
 * them if it wanted to. The screen says so, because a user handing over a bank
 * statement deserves to be told where it goes.
 *
 * # The preview is the consent, so it comes BEFORE any op exists
 *
 * `importTxnOps` is not called until the user has seen the row count, the
 * totals, a sample of the rows and every refusal the file produced — and it
 * refuses the whole batch if there is a single refusal left. An op is permanent
 * on every device the user owns; there is no undo to fall back on, so the
 * check is in front.
 *
 * # There are no bank presets, and the screen does not pretend otherwise
 *
 * The column guess comes from the file's own header row (`detectColumns`), never
 * from knowledge of a bank whose export nobody here has seen. So the mapping
 * fields are always shown, always editable, and the copy asks the user to check
 * them. A preset that quietly mapped the wrong column onto the amount would be
 * confirmed by a user reading a preview built from the same mistake.
 */

import { useCallback, useMemo, useState } from "react";

import { newEntityID } from "@ledger/client/net/client";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { Input, Select } from "../components/ui/Field";
import { InfoTip } from "../components/ui/InfoTip";
import { SectionLabel } from "../components/ui/SectionLabel";
import { formatMoney } from "../lib/minorMoney";
import { authoredBy, recordAuthored } from "../v2/authored";
import {
  detectColumns,
  fileDigest,
  importTxnOps,
  MAX_IMPORT_ROWS,
  planImport,
  type ColumnMap,
  type ImportMap,
  type ImportPlan,
} from "../v2/sources/importFile";
import { useHomeCurrency, useTxnSource, v2Keys } from "../v2/queries";
import { useWriter, type Writer } from "../v2/writer";
import { useQueryClient } from "@tanstack/react-query";

/** How many rows the preview table shows. The rest are counted, not listed. */
const PREVIEW_ROWS = 8;
/** How many refusals are spelled out before the list is summarised. */
const PREVIEW_PROBLEMS = 10;

export interface ImportFileProps {
  /** Injected in tests; defaults to the boot gate's outbox. */
  writer?: Writer;
  /** Injected in tests so a file need not come from a real `<input>`. */
  readFile?: (file: File) => Promise<Uint8Array>;
  /** Called after a batch is appended, so a caller can leave the screen. */
  onDone?: (count: number) => void;
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function ImportFile({ writer: injectedWriter, readFile = readFileBytes, onDone }: ImportFileProps) {
  const writer = useWriter(injectedWriter);
  const source = useTxnSource();
  const homeCurrency = useHomeCurrency(source);
  const qc = useQueryClient();

  const [fileName, setFileName] = useState("");
  const [text, setText] = useState("");
  const [digest, setDigest] = useState("");
  const [headers, setHeaders] = useState<readonly string[]>([]);
  const [map, setMap] = useState<ImportMap | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  // Bumped to remount the file input, which is the only way to clear one.
  const [inputKey, setInputKey] = useState(0);

  const pick = useCallback(
    async (file: File | undefined): Promise<void> => {
      if (file === undefined) return;
      setError("");
      setDone("");
      try {
        const bytes = await readFile(file);
        // UTF-8 with a BOM is what a spreadsheet writes; `parseCSV` would carry
        // the BOM into the first header name and then never find that column.
        const decoded = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
        const guess = detectColumns(parseHeaders(decoded));
        setFileName(file.name);
        setText(decoded);
        setDigest(fileDigest(bytes));
        setHeaders(parseHeaders(decoded));
        setMap({
          columns: guess.columns,
          dateFormat: "2006-01-02",
          currency: homeCurrency ?? "AED",
          directionMode: guess.directionMode,
        });
      } catch (e) {
        setMap(null);
        setError(e instanceof Error ? `That file could not be read: ${e.message}` : "That file could not be read.");
      }
    },
    [readFile, homeCurrency],
  );

  const plan: ImportPlan | null = useMemo(() => {
    if (map === null || text === "") return null;
    try {
      return planImport(text, map);
    } catch (e) {
      return { headers, rows: [], problems: [{ rowIndex: 0, error: e instanceof Error ? e.message : "unreadable" }], overCap: false, authorable: false };
    }
  }, [map, text, headers]);

  const totals = useMemo(() => {
    let debit = 0n;
    let credit = 0n;
    for (const row of plan?.rows ?? []) {
      if (row.direction === "debit") debit += row.amountMinor;
      else credit += row.amountMinor;
    }
    return { debit, credit };
  }, [plan]);

  const commit = useCallback(async (): Promise<void> => {
    if (plan === null || writer === null) return;
    setBusy(true);
    setError("");
    try {
      const built = importTxnOps({ plan, fileSha256: digest, newID: newEntityID });
      if (!built.ok) {
        setError(built.reason);
        return;
      }
      // One durable write for the whole batch, or none of it — the same
      // all-or-nothing the plan promised.
      writer.enqueueMany(built.specs);
      // The transaction list reads the same per-writer store, so imported rows
      // are visible there before the next sync folds them.
      const authored = authoredBy(writer);
      for (const spec of built.specs) {
        const id = spec.entity?.id;
        if (id !== undefined) recordAuthored(authored, id, [spec]);
      }
      setDone(`${built.specs.length} transaction${built.specs.length === 1 ? "" : "s"} added to your ledger.`);
      setText("");
      setMap(null);
      setFileName("");
      setInputKey((n) => n + 1);
      await qc.invalidateQueries({ queryKey: v2Keys.all });
      // Not awaited: the ops are durable the moment they are queued, and a
      // screen that stalled on the network would be unusable offline.
      writer.flush().catch(() => undefined);
      onDone?.(built.specs.length);
    } finally {
      setBusy(false);
    }
  }, [plan, writer, digest, qc, onDone]);

  const setColumn = (key: keyof ColumnMap, value: string) =>
    setMap((m) => (m === null ? m : { ...m, columns: { ...m.columns, [key]: value } }));

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted">
        Export a CSV from your bank and add it here. The file is read on this device — no row is uploaded, and
        ledger's server never sees it.
      </p>

      <div>
        <label className="block text-sm" htmlFor="import-file">
          Statement file (CSV)
          <Input
            id="import-file"
            key={inputKey}
            type="file"
            accept=".csv,text/csv,text/plain"
            data-testid="import-file"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </label>
        {fileName !== "" && <p className="mt-1 text-xs text-muted break-all">{fileName}</p>}
      </div>

      {error !== "" && (
        <p role="alert" data-testid="import-error" className="text-sm text-bad">
          {error}
        </p>
      )}

      {done !== "" && (
        <p role="status" data-testid="import-done" className="text-sm text-fg">
          {done}
        </p>
      )}

      {map !== null && (
        <>
          <Card>
            <div className="flex items-center gap-1">
              <SectionLabel>Columns</SectionLabel>
              <InfoTip about="column matching" testId="import-columns-tip">
                ledger guesses these from your file's own header row. It ships no saved layout for any bank, so check
                them before you import.
              </InfoTip>
            </div>
            <p className="mt-1 text-sm text-muted">Check each one against your file.</p>

            <div className="mt-3 space-y-3">
              <ColumnField id="import-date" label="Date" headers={headers} value={map.columns.date} onChange={(v) => setColumn("date", v)} />
              <ColumnField
                id="import-description"
                label="Description"
                headers={headers}
                value={map.columns.description}
                onChange={(v) => setColumn("description", v)}
              />

              <label className="block text-sm" htmlFor="import-direction-mode">
                How the file shows money in and out
                <Select
                  id="import-direction-mode"
                  value={map.directionMode}
                  onChange={(e) => setMap({ ...map, directionMode: e.target.value as ImportMap["directionMode"] })}
                >
                  <option value="sign">One amount column, minus for spending</option>
                  <option value="columns">Separate debit and credit columns</option>
                </Select>
              </label>

              {map.directionMode === "sign" ? (
                <ColumnField id="import-amount" label="Amount" headers={headers} value={map.columns.amount ?? ""} onChange={(v) => setColumn("amount", v)} />
              ) : (
                <>
                  <ColumnField id="import-debit" label="Debit (money out)" headers={headers} value={map.columns.debit ?? ""} onChange={(v) => setColumn("debit", v)} />
                  <ColumnField id="import-credit" label="Credit (money in)" headers={headers} value={map.columns.credit ?? ""} onChange={(v) => setColumn("credit", v)} />
                </>
              )}

              <ColumnField
                id="import-category"
                label="Category (optional)"
                headers={headers}
                value={map.columns.category ?? ""}
                onChange={(v) => setColumn("category", v)}
                allowNone
              />

              <label className="block text-sm" htmlFor="import-date-format">
                Date format
                <Select id="import-date-format" value={map.dateFormat} onChange={(e) => setMap({ ...map, dateFormat: e.target.value as ImportMap["dateFormat"] })}>
                  <option value="2006-01-02">2026-08-03 (year first)</option>
                  <option value="02/01/2006">03/08/2026 (day first)</option>
                  <option value="01/02/2006">08/03/2026 (month first)</option>
                </Select>
              </label>

              <label className="block text-sm" htmlFor="import-currency">
                Currency
                <Input
                  id="import-currency"
                  value={map.currency}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  onChange={(e) => setMap({ ...map, currency: e.target.value.toUpperCase() })}
                />
              </label>
              <p className="text-xs text-muted">
                A statement file does not say which currency it is in, so every row is imported in this one.
              </p>
            </div>
          </Card>

          {plan !== null && (
            <div data-testid="import-preview">
            <Card>
              <SectionLabel>Preview</SectionLabel>
              <p className="mt-1 text-sm text-fg">
                {plan.rows.length} row{plan.rows.length === 1 ? "" : "s"} ready
                {plan.problems.length > 0 ? `, ${plan.problems.length} that cannot be read` : ""}.
              </p>
              <p className="mt-1 text-sm text-muted tnum">
                Out {formatMoney(totals.debit, map.currency)} · In {formatMoney(totals.credit, map.currency)}
              </p>

              {plan.overCap && (
                <p role="alert" className="mt-2 text-sm text-bad">
                  That is more than {MAX_IMPORT_ROWS.toLocaleString("en")} rows. Export a shorter period and import it
                  in parts.
                </p>
              )}

              {plan.problems.length > 0 && (
                <div className="mt-3">
                  <p className="text-sm font-semibold text-bad">Nothing will be imported until these are fixed.</p>
                  <ul data-testid="import-problems" className="mt-1 space-y-1 text-xs text-muted">
                    {plan.problems.slice(0, PREVIEW_PROBLEMS).map((p) => (
                      <li key={`${p.rowIndex}-${p.error}`}>
                        Row {p.rowIndex}: {p.error}
                      </li>
                    ))}
                    {plan.problems.length > PREVIEW_PROBLEMS && <li>…and {plan.problems.length - PREVIEW_PROBLEMS} more.</li>}
                  </ul>
                </div>
              )}

              {plan.rows.length > 0 && (
                <ul className="mt-3 divide-y divide-border">
                  {plan.rows.slice(0, PREVIEW_ROWS).map((row) => (
                    <li key={row.rowIndex} className="flex items-baseline justify-between gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-fg">{row.merchantRaw}</span>
                        <span className="block text-xs text-muted tnum">
                          {row.postedAt.slice(0, 10)}
                          {row.category === null ? " · no category" : ` · ${row.category}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-fg tnum">
                        {row.direction === "debit" ? "−" : "+"}
                        {formatMoney(row.amountMinor, row.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {plan.rows.length > PREVIEW_ROWS && (
                <p className="mt-2 text-xs text-muted">…and {plan.rows.length - PREVIEW_ROWS} more.</p>
              )}
            </Card>
            </div>
          )}

          <p className="text-sm leading-relaxed text-muted">
            Imported rows are marked as added by you, and each one records this file's fingerprint and its row number.
            A row that matches one you already have is flagged in Review — nothing is dropped and nothing is merged.
          </p>

          <Button
            variant="primary"
            data-testid="import-commit"
            disabled={busy || writer === null || plan === null || !plan.authorable}
            onClick={() => void commit()}
          >
            {plan !== null && plan.authorable ? `Import ${plan.rows.length} transaction${plan.rows.length === 1 ? "" : "s"}` : "Nothing to import yet"}
          </Button>
          {writer === null && <p className="text-xs text-muted">Sign in to add transactions to your ledger.</p>}
        </>
      )}
    </div>
  );
}

/** The header row alone, so the mapping fields can be offered before any row is read. */
function parseHeaders(text: string): string[] {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i]!;
    if (quoted) {
      if (ch === '"' && firstLine[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      out.push(field.trim());
      field = "";
    } else field += ch;
  }
  out.push(field.replace(/\r$/, "").trim());
  return out.filter((h) => h !== "");
}

function ColumnField({
  id,
  label,
  headers,
  value,
  onChange,
  allowNone = false,
}: {
  id: string;
  label: string;
  headers: readonly string[];
  value: string;
  onChange: (value: string) => void;
  allowNone?: boolean;
}) {
  return (
    <label className="block text-sm" htmlFor={id}>
      {label}
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allowNone ? "Not in this file" : "Pick a column"}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </label>
  );
}
