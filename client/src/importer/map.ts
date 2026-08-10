import type { RawRow } from "./csv";

export interface ColumnMap { date: string; description: string; amount?: string; debit?: string; credit?: string; category?: string }
export interface ImportMap { columns: ColumnMap; categories?: Record<string, string>; dateFormat: "02/01/2006" | "01/02/2006" | "2006-01-02"; currency: string; directionMode: "sign" | "columns"; skipZeroAmounts?: boolean }

export function validateMap(m: ImportMap): string[] {
  const e: string[] = [];
  if (!m.columns.date) e.push("A date column is required.");
  if (!m.columns.description) e.push("A description column is required.");
  if (m.directionMode === "sign" && !m.columns.amount) e.push("An amount column is required for signed amounts.");
  if (m.directionMode === "columns" && (!m.columns.debit || !m.columns.credit)) e.push("Debit and credit columns are required.");
  if (!/^[A-Z]{3}$/.test(m.currency)) e.push("Currency must be a 3-letter uppercase code.");
  return e;
}

/** Exact decimal-to-minor conversion, half away from zero, never a float. */
export function parseAmount(raw: RawRow, m: ImportMap): { amountMinor: bigint; direction: "debit" | "credit" } {
  const parse = (source: string): bigint => {
    const v = source.trim().replace(/,/g, "");
    const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(v);
    if (!match) throw new Error(`invalid amount ${JSON.stringify(v)}`);
    const frac = match[3] ?? "";
    const cents = BigInt(match[2]!) * 100n + BigInt((frac + "00").slice(0, 2));
    const round = (frac[2] ?? "0") >= "5" ? 1n : 0n;
    const minor = cents + round;
    if (minor > 9_223_372_036_854_775_807n) throw new Error("amount exceeds int64 minor units");
    return (match[1] === "-" ? -1n : 1n) * minor;
  };
  if (m.directionMode === "sign") {
    const value = raw[m.columns.amount!] ?? "";
    if (value.trim() === "") throw new Error(`amount column ${JSON.stringify(m.columns.amount)} is empty`);
    const signed = parse(value);
    return { amountMinor: signed < 0n ? -signed : signed, direction: signed < 0n ? "debit" : "credit" };
  }
  const debit = (raw[m.columns.debit!] ?? "").trim();
  const credit = (raw[m.columns.credit!] ?? "").trim();
  if (debit !== "" && parse(debit) !== 0n) return { amountMinor: abs(parse(debit)), direction: "debit" };
  if (credit !== "" && parse(credit) !== 0n) return { amountMinor: abs(parse(credit)), direction: "credit" };
  throw new Error("both debit and credit columns are empty or zero");
}
const abs = (n: bigint): bigint => n < 0n ? -n : n;

export function parseImportDate(value: string, format: ImportMap["dateFormat"]): string {
  const parts = value.trim().split("-").length === 3 ? value.trim().split("-") : value.trim().split("/");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) throw new Error(`invalid date ${JSON.stringify(value.trim())}`);
  const [y, month, day] = format === "2006-01-02" ? [parts[0], parts[1], parts[2]] : format === "02/01/2006" ? [parts[2], parts[1], parts[0]] : [parts[2], parts[0], parts[1]];
  const iso = `${y!.padStart(4, "0")}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}T00:00:00.000Z`;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== iso) throw new Error(`invalid date ${JSON.stringify(value.trim())}`);
  return iso;
}
