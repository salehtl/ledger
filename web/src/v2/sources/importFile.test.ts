/**
 * Bulk import, at the op layer.
 *
 * Every test that claims an import "works" folds the ops through the real
 * `fold` + `project`, so what is asserted is what replay does with them rather
 * than what this file believes the payload means. The op is also run through
 * `validateOp` first, exactly as the outbox would, so a payload replay would
 * refuse fails here instead of folding to silence.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { OpSpec } from "@ledger/client/outbox/outbox";
import { setPlatform } from "@ledger/client/platform.registry";
import { webPlatform } from "@ledger/client/platform.web";
import { fold, INGEST_WRITER_ID, type LogEntry } from "@ledger/client/replay/replay";
import type { State } from "@ledger/client/replay/state";
import { validateOp, type Op } from "@ledger/client/wire/op";

import {
  detectColumns,
  fileDigest,
  importTxnOps,
  MAX_IMPORT_ROWS,
  newIngestID,
  planImport,
  type ImportMap,
} from "./importFile";

const DEVICE = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);

/** `02/01/2006` is Go's day-first reference layout, which is what the library speaks. */
const MAP: ImportMap = {
  columns: { date: "Date", description: "Description", amount: "Amount", category: "Category" },
  dateFormat: "02/01/2006",
  currency: "AED",
  directionMode: "sign",
};

beforeAll(() => {
  setPlatform(webPlatform);
});

let counter = 0;
const newID = (): string => `import-${++counter}`;

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

function foldSpecs(specs: readonly OpSpec[], writer: string = DEVICE): State {
  const log: LogEntry[] = [
    { op: opOf({ type: "home_currency_set", payload: { currency: "AED" }, parentVersion: null }, 0), seq: 1n, writer_id: INGEST_WRITER_ID },
    ...specs.map((s, i) => ({ op: opOf(s, i + 1), seq: BigInt(i + 2), writer_id: writer })),
  ];
  return fold(log);
}

/** A quoted field with an embedded comma, a quoted thousands separator, and an uncategorised row. */
const CLEAN =
  "Date,Description,Amount,Category\r\n" +
  "03/08/2026,CORNER COFFEE,-12.50,Eating out\r\n" +
  '04/08/2026,"CARREFOUR, MALL","-1,234.56",Groceries\r\n' +
  "05/08/2026,SALARY,9000.00,\r\n";

function specsFor(text: string): OpSpec[] {
  const plan = planImport(text, MAP);
  const built = importTxnOps({ plan, fileSha256: HASH, newID, ingestID: newIngestID });
  if (!built.ok) throw new Error(`the batch was refused: ${built.reason}`);
  return built.specs;
}

describe("a malformed file", () => {
  it("authors ZERO ops — one bad row refuses the whole batch", () => {
    // Row 2's date is not a date. Rows 1 and 3 are perfectly good, and that is
    // the point: an op is permanent, so a partial import is the failure.
    const text =
      "Date,Description,Amount\r\n" +
      "03/08/2026,CORNER COFFEE,-12.50\r\n" +
      "not-a-date,CARREFOUR,-9.00\r\n" +
      "05/08/2026,SALARY,9000.00\r\n";
    const plan = planImport(text, MAP);

    expect(plan.rows).toHaveLength(2);
    expect(plan.problems).toHaveLength(1);
    expect(plan.problems[0]?.rowIndex).toBe(2);
    expect(plan.authorable).toBe(false);

    const built = importTxnOps({ plan, fileSha256: HASH, newID });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toContain("nothing was imported");
    // And there is no other door: the result carries no specs at all.
    expect(built).not.toHaveProperty("specs");
  });

  it("authors zero ops for a zero amount, which replay refuses as invalid_payload", () => {
    const plan = planImport("Date,Description,Amount\r\n03/08/2026,REFUND,0.00\r\n", MAP);
    expect(plan.problems[0]?.error).toContain("zero");
    expect(importTxnOps({ plan, fileSha256: HASH, newID }).ok).toBe(false);
  });

  it("authors zero ops for a header-only file", () => {
    const plan = planImport("Date,Description,Amount\r\n", MAP);
    expect(plan.authorable).toBe(false);
    expect(importTxnOps({ plan, fileSha256: HASH, newID }).ok).toBe(false);
  });

  it("authors zero ops when the map names a column the file does not have", () => {
    const plan = planImport(CLEAN, { ...MAP, columns: { ...MAP.columns, amount: "Total" } });
    expect(plan.authorable).toBe(false);
    expect(importTxnOps({ plan, fileSha256: HASH, newID }).ok).toBe(false);
  });

  it("authors zero ops without a file fingerprint", () => {
    const plan = planImport(CLEAN, MAP);
    expect(plan.authorable).toBe(true);
    expect(importTxnOps({ plan, fileSha256: "", newID }).ok).toBe(false);
  });

  it("authors zero ops past the per-batch cap", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `0${(i % 9) + 1}/08/2026,SHOP ${i},-1.00`);
    const plan = planImport(`Date,Description,Amount\r\n${rows.join("\r\n")}\r\n`, MAP);
    expect(plan.overCap).toBe(true);
    const built = importTxnOps({ plan, fileSha256: HASH, newID });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toContain("import it in parts");
  });
});

describe("a good file", () => {
  it("folds into transactions with exact money and the file's own dates", () => {
    const state = foldSpecs(specsFor(CLEAN));
    const rows = [...state.txns.values()].sort((a, b) => a.posted_at.localeCompare(b.posted_at));

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ merchant_raw: "CORNER COFFEE", amount_minor: 1250n, direction: "debit", currency: "AED" });
    // 1,234.56 — the thousands separator is stripped, not parsed as a decimal.
    expect(rows[1]).toMatchObject({ merchant_raw: "CARREFOUR, MALL", amount_minor: 123456n, direction: "debit" });
    // A signed file's positive value is income, and the day is the file's day
    // in UTC — `03/08/2026` day-first is 3 August, never 8 March.
    expect(rows[2]).toMatchObject({ merchant_raw: "SALARY", amount_minor: 900000n, direction: "credit" });
    expect(rows[0]?.posted_at).toBe("2026-08-03T00:00:00.000Z");
  });

  it("sends an uncategorised row to review and leaves a categorised one alone", () => {
    const rows = [...foldSpecs(specsFor(CLEAN)).txns.values()];
    const salary = rows.find((r) => r.merchant_raw === "SALARY")!;
    const coffee = rows.find((r) => r.merchant_raw === "CORNER COFFEE")!;
    expect(salary.needs_review).toBe(true);
    expect(salary.category).toBeNull();
    expect(coffee.needs_review).toBe(false);
    expect(coffee.category).toBe("Eating out");
  });

  it("carries the file hash and the row index as the audit trail", () => {
    const specs = specsFor(CLEAN);
    expect(specs[0]?.payload).toMatchObject({ entry_method: "import", source_file_sha256: HASH, source_row_index: 1 });
    expect(specs[2]?.payload).toMatchObject({ source_row_index: 3 });
    // The row index is the FILE's numbering, so a refused row does not shift the
    // ones after it. Nothing here claims to be bank-verified.
    for (const s of specs) expect(s.payload).not.toHaveProperty("verified_origin_domain");
  });

  it("takes its provenance from the writer, never from entry_method", () => {
    const specs = specsFor(CLEAN);
    expect([...foldSpecs(specs, DEVICE).txns.values()][0]?.provenance).toBe("user");
    // The identical payload under the ingest writer id folds as ingest. So
    // `entry_method: "import"` buys nothing; the writer decides.
    expect([...foldSpecs(specs, INGEST_WRITER_ID).txns.values()][0]?.provenance).toBe("ingest");
  });

  it("gives every row its own random ingest id, so a repeated row is a NOTICE and not a drop", () => {
    const twice =
      "Date,Description,Amount\r\n" +
      "03/08/2026,CORNER COFFEE,-12.50\r\n" +
      "03/08/2026,CORNER COFFEE,-12.50\r\n";
    const specs = specsFor(twice);
    expect(new Set(specs.map((s) => s.ingestId)).size).toBe(2);

    const state = foldSpecs(specs);
    // Both rows are in the ledger — two identical coffees on one day are two
    // coffees — and the SECOND one points at the first through the fingerprint
    // index, which is the dedup surface the review queue reads.
    expect(state.txns.size).toBe(2);
    const rows = [...state.txns.values()];
    expect(rows[1]?.possible_duplicate_of).toBe(rows[0]?.id);
  });

  it("packs each row into its own op, one per file row", () => {
    expect(specsFor(CLEAN)).toHaveLength(3);
    expect(specsFor(CLEAN).every((s) => s.type === "txn_ingested" && s.parentVersion === null)).toBe(true);
  });
});

describe("debit and credit columns", () => {
  const twoColumn: ImportMap = {
    columns: { date: "Date", description: "Narrative", debit: "Debit", credit: "Credit" },
    dateFormat: "2006-01-02",
    currency: "AED",
    directionMode: "columns",
  };

  it("reads an unsigned two-column statement without inverting anything", () => {
    const text = "Date,Narrative,Debit,Credit\r\n2026-08-03,CORNER COFFEE,12.50,\r\n2026-08-04,SALARY,,9000.00\r\n";
    const plan = planImport(text, twoColumn);
    expect(plan.authorable).toBe(true);
    const rows = [...foldSpecs(specsFor2(plan)).txns.values()];
    expect(rows[0]).toMatchObject({ direction: "debit", amount_minor: 1250n });
    expect(rows[1]).toMatchObject({ direction: "credit", amount_minor: 900000n });
  });

  function specsFor2(plan: ReturnType<typeof planImport>): OpSpec[] {
    const built = importTxnOps({ plan, fileSha256: HASH, newID, ingestID: newIngestID });
    if (!built.ok) throw new Error(built.reason);
    return built.specs;
  }
});

describe("column detection", () => {
  it("guesses from the file's own headers and prefers two columns when both are there", () => {
    const got = detectColumns(["Value Date", "Narrative", "Debit", "Credit", "Balance"]);
    expect(got.directionMode).toBe("columns");
    expect(got.columns).toMatchObject({ date: "Value Date", description: "Narrative", debit: "Debit", credit: "Credit" });
  });

  it("falls back to a single signed amount column", () => {
    const got = detectColumns(["Date", "Description", "Amount", "Category"]);
    expect(got.directionMode).toBe("sign");
    expect(got.columns).toMatchObject({ date: "Date", description: "Description", amount: "Amount", category: "Category" });
  });

  it("guesses nothing it cannot see — an unrecognisable header row yields empty names, not a wrong one", () => {
    const got = detectColumns(["col1", "col2", "col3"]);
    expect(got.columns.date).toBe("");
    expect(got.columns.description).toBe("");
  });
});

describe("the file fingerprint", () => {
  it("is 64 hex characters over the BYTES and changes with the content", () => {
    const a = fileDigest(new TextEncoder().encode(CLEAN));
    const b = fileDigest(new TextEncoder().encode(`${CLEAN}05/08/2026,X,-1.00\r\n`));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
