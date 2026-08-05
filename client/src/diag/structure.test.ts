import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { structureShape, structureSig } from "./structure.ts";

const root = `${import.meta.dir}/../../../`;
interface Vector { name: string; source: string; sig: string }
const manifest = JSON.parse(readFileSync(`${root}conformance/structure/manifest.json`, "utf8")) as {
  schema_version: number;
  cases: Vector[];
};

test("the Go-authored real-message conformance corpus has at least 200 cases", () => {
  expect(manifest.schema_version).toBe(1);
  expect(manifest.cases.length).toBeGreaterThanOrEqual(200);
  expect(new Set(manifest.cases.map((c) => c.name)).size).toBe(manifest.cases.length);
});

test("TypeScript StructureSig agrees with Go over every real corpus message", () => {
  const documents = new Map<string, Map<string, string>>();
  for (const vector of manifest.cases) {
    let cases = documents.get(vector.source);
    if (cases === undefined) {
      const doc = JSON.parse(readFileSync(`${root}${vector.source}`, "utf8")) as {
        cases: { name: string; normalized_body_base64: string }[];
      };
      cases = new Map(doc.cases.map((c) => [c.name, c.normalized_body_base64]));
      documents.set(vector.source, cases);
    }
    const encoded = cases.get(vector.name);
    if (encoded === undefined) throw new Error(`${vector.name} is absent from ${vector.source}`);
    const body = Buffer.from(encoded, "base64").toString("utf8");
    expect(structureSig(body), vector.name).toBe(vector.sig);
  }
});

test("same layout ignores values while changed layout changes the signature", () => {
  const a = "المبلغ\nAED 250.00\nالدفع الى\nCARREFOUR";
  const b = "المبلغ\nAED 9,912.45\nالدفع الى\nSPINNEYS ABU DHABI";
  const different = "Debit Amount:\nAED 250.00";
  expect(structureSig(a)).toBe(structureSig(b));
  expect(structureSig(a)).not.toBe(structureSig(different));
});

test("the preimage shape retains no input letter, digit, or number", () => {
  const shape = structureShape("Dear SALEH, AED 1,234.56 at CARREFOUR البطاقة ٤٥٦٧ БАНК Москва 中国银行 ½");
  for (const ch of shape) {
    if (["0", "A", "B", "C"].includes(ch)) continue;
    expect(/[\p{L}\p{N}]/u.test(ch), `shape leaked ${JSON.stringify(ch)} in ${JSON.stringify(shape)}`).toBeFalse();
  }
  for (const secret of ["SALEH", "CARREFOUR", "234", "Москва", "中国银行"]) expect(shape).not.toContain(secret);
});

test("line endings, padding, word count, number formatting, marks, and bidi controls are stable", () => {
  const want = structureSig("Amount:\nAED 250.00");
  for (const value of [
    "Amount:\r\nAED 250.00", "Amount:\rAED 250.00", "Amount:  \nAED   250.00   ",
    "\n  Amount:\nAED 250.00", "Amount:\n\tAED\t250.00",
  ]) expect(structureSig(value)).toBe(want);
  expect(structureSig("CARREFOUR")).toBe(structureSig("SPINNEYS ABU DHABI MALL"));
  expect(structureSig("AED 250.00")).toBe(structureSig("AED 1,234,567.89"));
  expect(structureSig("٤٥٦")).toBe(structureSig("456"));
  expect(structureSig("مَرْحَبًا")).toBe(structureSig("مرحبا"));
  expect(structureSig("‏AED 250.00‎")).toBe(structureSig("AED 250.00"));
});

test("only the first 4096 UTF-8 bytes of shape affect the digest, on a rune boundary", () => {
  const prefix = "Amount: 250.00\n".repeat(2_000);
  expect(structureSig(`${prefix}TAIL`)).toBe(structureSig(`${prefix}!!!DIFFERENT!!!`));
  expect(structureSig("Amount:\nAED 250.00")).not.toBe(structureSig("Amount:\nAED 250.00\nExtra:\nX"));
  expect(() => new TextEncoder().encode(structureShape("…".repeat(4_000)))).not.toThrow();
  expect(new TextEncoder().encode(structureShape("…".repeat(4_000))).byteLength).toBeLessThanOrEqual(4_096);
});
