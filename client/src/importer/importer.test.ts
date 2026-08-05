import { expect, test } from "bun:test";
import { parseCSV } from "./csv";
import { parseAmount, type ImportMap } from "./map";
import { normalizeRows } from "./normalize";
import vectors from "../../../conformance/import/vectors.json";

const map: ImportMap = { columns: { date: "Date", description: "Description", amount: "Amount", category: "Category" }, dateFormat: "02/01/2006", currency: "AED", directionMode: "sign", categories: { Food: "Groceries" } };

test("CSV handles quoted commas, quotes and newlines", () => {
  const got = parseCSV('Date,Description,Amount\r\n01/08/2026,"A, ""shop""",-12.34\r\n02/08/2026,"two\nlines",5\n');
  expect(got.rows).toHaveLength(2); expect(got.rows[0]?.Description).toBe('A, "shop"'); expect(got.rows[1]?.Description).toBe("two\nlines");
});

test("normalization is exact bigint money and maps categories", () => {
  const huge = "90071992547409.93";
  expect(parseAmount({ Amount: huge }, map)).toEqual({ amountMinor: 9007199254740993n, direction: "credit" });
  const result = normalizeRows([{ Date: "03/08/2026", Description: " Market ", Amount: "-1,234.565", Category: "Food" }], map)[0]!;
  expect(result).toEqual({ ok: true, row: { rowIndex: 1, postedAt: "2026-08-03T00:00:00.000Z", merchantRaw: "Market", amountMinor: 123457n, currency: "AED", direction: "debit", category: "Groceries" } });
});

test("shared Go/TypeScript import conformance vectors", () => {
  for (const vector of vectors) {
    const rawMap = vector.map;
    // Spread rather than assign: `categories` is absent from most vectors, and
    // exactOptionalPropertyTypes refuses an explicit `undefined` for it.
    const m: ImportMap = { columns: rawMap.columns, ...("categories" in rawMap ? { categories: rawMap.categories } : {}), dateFormat: rawMap.date_format as ImportMap["dateFormat"], currency: rawMap.currency, directionMode: rawMap.direction_mode as ImportMap["directionMode"] };
    const result = normalizeRows([vector.raw], m)[0]!;
    if ("error" in vector) { expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toContain(vector.error); continue; }
    expect(result.ok).toBe(true);
    if (result.ok) expect({ posted_at: result.row.postedAt.replace(".000Z", "Z"), merchant_raw: result.row.merchantRaw, amount_minor: result.row.amountMinor.toString(10), currency: result.row.currency, direction: result.row.direction, category: result.row.category ?? "" }).toEqual(vector.expected as { posted_at: string; merchant_raw: string; amount_minor: string; currency: string; direction: "debit" | "credit"; category: string });
  }
});
