/**
 * The export, and the one test that actually holds it: the round trip.
 *
 * The importer and the exporter are the same person's work, so "it looks right"
 * proves nothing. Every claim below goes out through `exportCSV` and back in
 * through `planImport` with the map `importMapForExport` produces — and the
 * transactions on both ends are built by folding real ops, never by hand, so a
 * disagreement between the two shows up as a different transaction rather than
 * as a different string.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { OpSpec } from "@ledger/client/outbox/outbox";
import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { fold, INGEST_WRITER_ID, type LogEntry } from "@ledger/client/replay/replay";
import type { Txn } from "@ledger/client/replay/state";
import { validateOp, type Op } from "@ledger/client/wire/op";

import {
  csvField,
  exportCSV,
  exportFileName,
  exportRow,
  importMapForExport,
  minorToDecimal,
  signedAmount,
} from "./exportFile";
import { importTxnOps, newIngestID, planImport, type ImportMap } from "./importFile";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const HASH = "b".repeat(64);

const SOURCE_MAP: ImportMap = {
  columns: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
  dateFormat: "2006-01-02",
  currency: "AED",
  directionMode: "sign",
};

beforeAll(() => {
  setPlatform(webPlatform);
});

let counter = 0;
const newID = (): string => `export-${++counter}`;

function opOf(spec: OpSpec, n: number): Op {
  const op: Op = {
    v: 1,
    type: spec.type as Op["type"],
    op_id: `op-${n}`,
    authored_at: "2026-08-09T12:00:00.000Z",
    parent_version: spec.parentVersion ?? null,
    payload: spec.payload,
    ...(spec.entity === undefined ? {} : { entity: spec.entity }),
    ...(spec.ingestId === undefined ? {} : { ingest_id: spec.ingestId }),
  };
  validateOp(op);
  return op;
}

/** The transactions a CSV becomes, through the real importer and the real fold. */
function ledgerFrom(text: string, map: ImportMap = SOURCE_MAP): Txn[] {
  const plan = planImport(text, map);
  const built = importTxnOps({ plan, fileSha256: HASH, newID, ingestID: newIngestID });
  if (!built.ok) throw new Error(`the batch was refused: ${built.reason}`);
  const log: LogEntry[] = [
    { op: opOf({ type: "home_currency_set", payload: { currency: "AED" }, parentVersion: null }, 0), seq: 1n, writer_id: INGEST_WRITER_ID },
    ...built.specs.map((s, i) => ({ op: opOf(s, i + 1), seq: BigInt(i + 2), writer_id: DEVICE })),
  ];
  return [...fold(log).txns.values()];
}

/** What a statement row says, stripped of everything the export does not carry. */
function statement(t: Txn) {
  return {
    day: t.posted_at.slice(0, 10),
    merchant: t.merchant_raw,
    amount: t.amount_minor,
    currency: t.currency,
    direction: t.direction,
    category: t.category,
  };
}

const HOSTILE =
  "Date,Description,Amount,Category\r\n" +
  "2026-08-03,CORNER COFFEE,-0.05,Eating out\r\n" +
  '2026-08-04,"CARREFOUR, MALL","-1,234.56",Groceries\r\n' +
  '2026-08-05,"HE SAID ""HI""",-9.99,\r\n' +
  "2026-08-06,SALARY,90071992547409.93,Income\r\n";

describe("the round trip", () => {
  it("exports a ledger and imports it back to the same transactions", () => {
    const before = ledgerFrom(HOSTILE);
    const text = exportCSV(before);
    const map = importMapForExport(before);
    expect(map).not.toBeNull();

    const after = ledgerFrom(text, map!);

    expect(after).toHaveLength(before.length);
    expect(after.map(statement)).toEqual(before.map(statement));
  });

  it("keeps fils exactly, including a value a float would mangle", () => {
    const before = ledgerFrom(HOSTILE);
    const after = ledgerFrom(exportCSV(before), importMapForExport(before)!);

    // 9,007,199,254,740,993 fils — one past Number.MAX_SAFE_INTEGER. A float
    // round trip returns ...992, and this is the assertion that catches it.
    expect(after.map((t) => t.amount_minor).sort()).toEqual(before.map((t) => t.amount_minor).sort());
    expect(before.some((t) => t.amount_minor === 9007199254740993n)).toBe(true);
    expect(after.some((t) => t.amount_minor === 9007199254740993n)).toBe(true);
    // 5 fils, the other end of the range, where a naive formatter drops a zero.
    expect(after.some((t) => t.amount_minor === 5n)).toBe(true);
  });

  it("keeps a merchant with a comma and a quote in it", () => {
    const before = ledgerFrom(HOSTILE);
    const after = ledgerFrom(exportCSV(before), importMapForExport(before)!);
    const names = after.map((t) => t.merchant_raw);
    expect(names).toContain("CARREFOUR, MALL");
    expect(names).toContain('HE SAID "HI"');
  });

  it("keeps direction — spending stays spending, income stays income", () => {
    const before = ledgerFrom(HOSTILE);
    const after = ledgerFrom(exportCSV(before), importMapForExport(before)!);
    expect(after.filter((t) => t.direction === "credit").map((t) => t.merchant_raw)).toEqual(["SALARY"]);
    expect(after.filter((t) => t.direction === "debit")).toHaveLength(3);
  });

  it("keeps a category, and keeps an empty one empty", () => {
    const before = ledgerFrom(HOSTILE);
    const after = ledgerFrom(exportCSV(before), importMapForExport(before)!);
    expect(after.find((t) => t.merchant_raw === "CORNER COFFEE")?.category).toBe("Eating out");
    const blank = after.find((t) => t.merchant_raw === 'HE SAID "HI"')!;
    expect(blank.category).toBeNull();
    expect(blank.needs_review).toBe(true);
  });
});

describe("what the file says", () => {
  it("leads with the six columns a person can read", () => {
    expect(exportCSV([]).trim()).toBe("Date,Description,Amount,Currency,Direction,Category");
  });

  it("writes the day, the signed amount, and the direction in words", () => {
    const t = ledgerFrom("Date,Description,Amount,Category\r\n2026-08-03,CORNER COFFEE,-12.50,Eating out\r\n")[0]!;
    expect(exportRow(t)).toEqual(["2026-08-03", "CORNER COFFEE", "-12.50", "AED", "Spending", "Eating out"]);
  });

  it("quotes only the fields that need it", () => {
    expect(csvField("CORNER COFFEE")).toBe("CORNER COFFEE");
    expect(csvField("CARREFOUR, MALL")).toBe('"CARREFOUR, MALL"');
    expect(csvField('HE SAID "HI"')).toBe('"HE SAID ""HI"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });

  it("leaves a superseded row out — it is retained in the app, not in the statement", () => {
    const rows = ledgerFrom("Date,Description,Amount\r\n2026-08-03,CORNER COFFEE,-12.50\r\n2026-08-04,SALARY,9000.00\r\n");
    const withReplaced = [{ ...rows[0]!, superseded_by: "some-other-id" }, rows[1]!];
    const text = exportCSV(withReplaced);
    expect(text).not.toContain("CORNER COFFEE");
    expect(text).toContain("SALARY");
  });

  it("names the file by the day it was made", () => {
    expect(exportFileName(new Date("2026-08-09T22:00:00Z"))).toBe("ledger-2026-08-09.csv");
  });
});

describe("money formatting", () => {
  it("is a digit-string slice, never arithmetic", () => {
    expect(minorToDecimal(0n)).toBe("0.00");
    expect(minorToDecimal(5n)).toBe("0.05");
    expect(minorToDecimal(50n)).toBe("0.50");
    expect(minorToDecimal(1250n)).toBe("12.50");
    expect(minorToDecimal(123456789n)).toBe("1234567.89");
    // No thousands separator: the importer strips commas, but a separator here
    // would be a formatting choice riding into a data file.
    expect(minorToDecimal(9007199254740993n)).toBe("90071992547409.93");
  });

  it("puts the minus on spending and nothing on income", () => {
    expect(signedAmount({ amount_minor: 1250n, direction: "debit" })).toBe("-12.50");
    expect(signedAmount({ amount_minor: 1250n, direction: "credit" })).toBe("12.50");
  });
});

describe("a ledger in more than one currency", () => {
  it("names each row's currency, and refuses to claim the file has one", () => {
    const rows = ledgerFrom("Date,Description,Amount\r\n2026-08-03,CORNER COFFEE,-12.50\r\n");
    const mixed = [rows[0]!, { ...rows[0]!, id: "other", currency: "USD" }];
    // The column is still right for a human reading the spreadsheet…
    expect(exportCSV(mixed)).toContain("USD");
    // …and there is no single-currency map that could read it back, so none is
    // offered. `ImportMap` carries one currency for a whole file.
    expect(importMapForExport(mixed)).toBeNull();
  });
});
