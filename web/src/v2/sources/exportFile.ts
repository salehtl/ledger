/**
 * "Download my data": the ledger this device holds, as a CSV a person can read.
 *
 * # Why this exists at all
 *
 * `docs/alpha-consent.md` promises every alpha user the right to *access,
 * export and delete* their data, "all of which are available in the app".
 * Deletion shipped; access exists; export did not exist anywhere. A
 * countersigned promise is repaired by building the thing, not by rewording it.
 *
 * # It is written HERE, and it could not be written anywhere else
 *
 * The op log is sealed. The server holds ciphertext and cannot assemble a
 * statement even if it were asked to. So the export is built from the local
 * projection, in the browser, and never leaves it unless the user saves it.
 *
 * # Money is a bigint the whole way
 *
 * {@link minorToDecimal} turns `1250n` into `"12.50"` by slicing a digit string
 * — no division, no `Number`, nothing that could round. That is the same rule
 * `importFile.ts` reads back with, which is what makes the round trip exact
 * rather than approximately exact.
 *
 * # The round trip is a real contract, and one part of it is lossy on purpose
 *
 * `exportCSV` output, read back through {@link importMapForExport} and
 * `planImport`, produces the same merchant, amount, currency, direction and
 * category. The **time of day is not carried**: the Date column is the posting
 * DAY, because a statement in a spreadsheet is read by day and because every
 * period filter in the app already reads `substr(posted_at, 1, 10)`. A row
 * re-imported from an export therefore lands at midnight UTC on its own day.
 * That is stated in the module and asserted in the tests rather than discovered.
 *
 * # What it deliberately leaves out
 *
 *   - **Superseded rows.** They are retained and inspectable in the app (§2:
 *     nothing is dropped), but they are not the ledger, and a statement that
 *     listed both a row and the re-read that replaced it would double every
 *     corrected transaction.
 *   - **Rows no tier could read** (`unparsed`). They carry no amount, no
 *     currency and no direction — a statement line reading `0.00` for a message
 *     nobody has read yet would be a transaction that never happened, and the
 *     importer refuses a zero amount for the same reason. They stay in the app,
 *     in the review queue, which is where they can actually be acted on.
 *   - **Splits, notes, fork notices, duplicate pointers, ids and versions.**
 *     This is a statement, not a database dump. A column nobody can act on in a
 *     spreadsheet is noise, and the split parts would not sum to anything a
 *     reader could check against the parent row.
 *   - **The home-currency conversion.** `amount_home_minor` is a snapshot taken
 *     at a rate that may since have been corrected; exporting it beside the real
 *     amount would put two different numbers for one purchase in one row.
 */

import type { Txn } from "@ledger/client/replay/state";

import type { ImportMap } from "./importFile";

/** The columns, in order. Chosen to be readable in a spreadsheet, not complete. */
export const EXPORT_HEADERS = ["Date", "Description", "Amount", "Currency", "Direction", "Category"] as const;

/**
 * `1250n` → `"12.50"`, exactly, for any int64.
 *
 * A digit-string slice rather than arithmetic: `Number(minor) / 100` is a float
 * the moment it is written, and this codebase's whole money rule is that a float
 * never touches an amount. The two decimal places are unconditional, so the
 * importer's `^[0-9]+\.[0-9]{2}$`-shaped reader takes it back without a special
 * case.
 */
export function minorToDecimal(minor: bigint): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString(10).padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * The Amount column: signed, minus for money out.
 *
 * The Direction column beside it says the same thing in words for a human. The
 * SIGN is what the importer reads (`directionMode: "sign"`), because that is the
 * one shape the library can take back losslessly — its two-column mode needs two
 * columns of money, which is a worse spreadsheet.
 */
export function signedAmount(t: Pick<Txn, "amount_minor" | "direction">): string {
  return `${t.direction === "debit" ? "-" : ""}${minorToDecimal(t.amount_minor)}`;
}

/** One RFC-4180 field: quoted only when it has to be, doubled quotes inside. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.split('"').join('""')}"` : value;
}

/** A row a spreadsheet shows, in the header order above. */
export function exportRow(t: Txn): string[] {
  return [
    // The posting DAY. See the header for why the time of day is not carried.
    t.posted_at.slice(0, 10),
    t.merchant_raw,
    signedAmount(t),
    t.currency,
    t.direction === "debit" ? "Spending" : "Income",
    t.category ?? "",
  ];
}

/**
 * Whether a row belongs in a statement.
 *
 * Superseded and unparsed rows are filtered HERE rather than by the caller, so
 * every caller exports the same ledger — a screen that forgot the filter would
 * quietly double every corrected row.
 */
export function exportable(t: Txn): boolean {
  return t.superseded_by === null && !t.unparsed;
}

/** The whole file, `\r\n`-terminated as RFC 4180 says. */
export function exportCSV(rows: readonly Txn[]): string {
  const lines = [EXPORT_HEADERS.map(csvField).join(",")];
  for (const t of rows) {
    if (!exportable(t)) continue;
    lines.push(exportRow(t).map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * The map that reads an export back, or `null` when one file cannot.
 *
 * `ImportMap` carries ONE currency for the whole file — the library's shape, and
 * a true one, because a statement file does not say what currency it is in. An
 * export from a multi-currency ledger names each row's currency in its own
 * column for a human, and cannot be re-imported as a single batch. Returning
 * `null` says so rather than picking one currency and mislabelling the rest.
 */
export function importMapForExport(rows: readonly Txn[]): ImportMap | null {
  const currencies = new Set(rows.filter(exportable).map((t) => t.currency));
  if (currencies.size !== 1) return null;
  return {
    columns: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
    dateFormat: "2006-01-02",
    currency: [...currencies][0]!,
    directionMode: "sign",
  };
}

/** `ledger-2026-08-09.csv`. Dated, because a folder ends up with several. */
export function exportFileName(now: Date): string {
  return `ledger-${now.toISOString().slice(0, 10)}.csv`;
}
