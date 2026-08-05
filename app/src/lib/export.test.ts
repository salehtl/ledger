import { describe, expect, test } from "bun:test";

import { MAX_MINOR, parseAmountDraft } from "./money.ts";
import type { Anomaly, Rule, Txn } from "@ledger/client/replay/state.ts";

import {
  CSV_COLUMNS,
  EXPORT_CHUNK,
  EXPORT_OMISSIONS,
  csvField,
  decimalMinor,
  exportFileName,
  renderExport,
  writeExport,
  type ExportSource,
} from "./export.ts";

// ---------------------------------------------------------------------------
// Fixtures — hostile on purpose (v1's harness lesson: bugs hide in the happy
// path). A merchant with a comma, a quote, a newline and a leading `=`; an
// amount at int64 max; an unparsed row; a null category; a null FX snapshot.
// ---------------------------------------------------------------------------

function txn(over: Partial<Txn> & Pick<Txn, "id">): Txn {
  return {
    ingest_id: `ing-${over.id}`,
    amount_minor: 1234n,
    currency: "AED",
    direction: "debit",
    posted_at: "2026-07-13T10:00:00.000Z",
    merchant_raw: "CARREFOUR",
    last4: "4321",
    category: "Groceries",
    needs_review: false,
    unparsed: false,
    tier: "template",
    parse_error: null,
    provenance: "ingest",
    amount_home_minor: 1234n,
    splits: [],
    superseded_by: null,
    possible_duplicate_of: null,
    version: 1,
    ...over,
  };
}

const HOSTILE_MERCHANT = '=cmd|" /C calc"!A0, "SPAR"\nSECOND LINE';

const TXNS: Txn[] = [
  txn({ id: "t1" }),
  txn({
    id: "t2",
    merchant_raw: HOSTILE_MERCHANT,
    amount_minor: MAX_MINOR,
    currency: "USD",
    direction: "credit",
    category: null,
    amount_home_minor: null,
    needs_review: true,
    provenance: "user",
    tier: "none",
  }),
  txn({
    id: "t3",
    amount_minor: 0n,
    currency: "",
    direction: "",
    unparsed: true,
    tier: "none",
    parse_error: "no_template_matched",
    category: null,
    amount_home_minor: null,
    needs_review: true,
  }),
  txn({
    id: "t4",
    amount_minor: 900n,
    splits: [
      { category: "Dining", amount_minor: 300n },
      { category: "Drinks; and, things", amount_minor: 600n },
    ],
    superseded_by: "op-sup-1",
  }),
];

const RULES: Rule[] = [{ pattern: "carrefour", match: "contains", category: "Groceries", priority: 10, version: 1 }];
const ANOMALIES: Anomaly[] = [{ kind: "split_sum", detail: "parts do not sum", at_seq: 42n }];

function source(rows: readonly Txn[] = TXNS, chunk = EXPORT_CHUNK): ExportSource {
  return {
    generatedAt: "2026-08-02T09:00:00.000Z",
    homeCurrency: "AED",
    cursorHot: 991n,
    cursorCold: 12n,
    txnCount: rows.length,
    txnChunks: function* () {
      for (let i = 0; i < rows.length; i += chunk) yield rows.slice(i, i + chunk);
    },
    rules: RULES,
    rates: new Map<string, bigint | null>([
      ["USD", 3_672_500n],
      ["EUR", null],
    ]),
    forks: [],
    anomalies: ANOMALIES,
  };
}

async function collect(src: ExportSource, format: "csv" | "json"): Promise<string> {
  let out = "";
  await writeExport(renderExport(src, format), (s) => {
    out += s;
  });
  return out;
}

// ---------------------------------------------------------------------------
// 1. Money. The whole reason this file is not three lines of JSON.stringify.
// ---------------------------------------------------------------------------

describe("decimalMinor — bigint money into a file a user keeps", () => {
  test("int64 max round-trips as an EXACT string, not an approximation", () => {
    // The plan's gate, asserted on the string rather than on a parsed value.
    expect(decimalMinor(MAX_MINOR)).toBe("92233720368547758.07");
  });

  test("a float serializer would get that wrong, so the assertion above can fail", () => {
    // The measurement that makes the gate mean something: if this file ever
    // reached for Number(), THIS is the string it would write.
    const viaFloat = (Number(MAX_MINOR) / 100).toFixed(2);
    expect(viaFloat).not.toBe(decimalMinor(MAX_MINOR));
    expect(viaFloat).toBe("92233720368547760.00");
  });

  test("small, zero and sub-unit values keep both digits", () => {
    expect(decimalMinor(0n)).toBe("0.00");
    expect(decimalMinor(5n)).toBe("0.05");
    expect(decimalMinor(50n)).toBe("0.50");
    expect(decimalMinor(100n)).toBe("1.00");
    expect(decimalMinor(1234n)).toBe("12.34");
  });

  test("no grouping separators — a file is parsed, not read", () => {
    expect(decimalMinor(123_456_789n)).toBe("1234567.89");
  });

  test("negatives print with an ASCII hyphen, not the display minus", () => {
    // formatMinor() uses U+2212 for the glass. A file must stay machine-readable.
    expect(decimalMinor(-1234n)).toBe("-12.34");
  });

  test("every value survives a round trip through an INDEPENDENT parser", () => {
    // parseAmountDraft is Task 18's, written against a different spec sentence
    // and by a different hand. Round-tripping through the inverse of my own
    // expression would prove only that I can undo myself.
    const values = [
      0n,
      1n,
      99n,
      100n,
      101n,
      999_999n,
      1_000_000n,
      9_007_199_254_740_993n, // one past Number.MAX_SAFE_INTEGER
      MAX_MINOR,
    ];
    for (const v of values) {
      const parsed = parseAmountDraft(decimalMinor(v));
      expect(parsed.kind).toBe("ok");
      if (parsed.kind === "ok") expect(parsed.minor).toBe(v);
    }
  });

  test("a thousand pseudo-random magnitudes round-trip too", () => {
    // Deterministic LCG: a fixed seed, so a failure is reproducible.
    let seed = 0x2f6e2b1n;
    for (let i = 0; i < 1000; i++) {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      const v = seed % (MAX_MINOR + 1n);
      const parsed = parseAmountDraft(decimalMinor(v));
      if (parsed.kind !== "ok" || parsed.minor !== v) {
        throw new Error(`round trip failed at ${v.toString(10)} -> ${decimalMinor(v)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. CSV framing
// ---------------------------------------------------------------------------

describe("csvField", () => {
  test("plain text is untouched", () => {
    expect(csvField("CARREFOUR")).toBe("CARREFOUR");
  });

  test("commas, quotes and newlines are quoted and doubled, RFC 4180", () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
  });

  test("a formula-shaped field is neutralised before it is quoted", () => {
    // Merchant strings come out of email. A spreadsheet evaluates a cell that
    // begins =, +, - or @, so an export is a code-execution path into the
    // user's own Numbers/Excel unless this is done.
    for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(csvField(`${lead}SUM(A1)`).startsWith("'") || csvField(`${lead}SUM(A1)`).startsWith(`"'`)).toBe(true);
    }
    expect(csvField("=1+1")).toBe("'=1+1");
  });

  test("a number is never neutralised — the guard must not corrupt money", () => {
    expect(csvField("92233720368547758.07")).toBe("92233720368547758.07");
    expect(csvField("0.00")).toBe("0.00");
  });
});

describe("the CSV export", () => {
  test("its header is the column list, once, in order", async () => {
    const csv = await collect(source(), "csv");
    const lines = csv.split("\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(csv.split("\n").filter((l) => l === CSV_COLUMNS.join(",")).length).toBe(1);
  });

  test("money lands as an exact decimal string in the file itself", async () => {
    const csv = await collect(source(), "csv");
    expect(csv).toContain("92233720368547758.07");
    expect(csv).not.toContain("92233720368547760");
  });

  test("the hostile merchant cannot break the row structure", async () => {
    const csv = await collect(source(), "csv");
    // The embedded newline is inside quotes, so a naive line count would be
    // wrong — parse properly and demand exactly one record per transaction.
    expect(csvRecords(csv).length).toBe(TXNS.length + 1);
  });

  test("an unparsed row says so rather than reporting a zero-dirham purchase", async () => {
    const rows = csvRecords(await collect(source(), "csv"));
    const t3 = rows.find((r) => r[CSV_COLUMNS.indexOf("id")] === "t3");
    expect(t3?.[CSV_COLUMNS.indexOf("unparsed")]).toBe("true");
    expect(t3?.[CSV_COLUMNS.indexOf("amount")]).toBe("");
    expect(t3?.[CSV_COLUMNS.indexOf("direction")]).toBe("");
  });

  test("splits are summarised in one cell and named as a summary", async () => {
    const rows = csvRecords(await collect(source(), "csv"));
    const t4 = rows.find((r) => r[CSV_COLUMNS.indexOf("id")] === "t4");
    expect(t4?.[CSV_COLUMNS.indexOf("splits")]).toBe("Dining=3.00; Drinks; and, things=6.00");
    expect(EXPORT_OMISSIONS.csv.join(" ")).toContain("split");
  });
});

// ---------------------------------------------------------------------------
// 3. JSON
// ---------------------------------------------------------------------------

describe("the JSON export", () => {
  test("it is valid JSON however many chunks it was written in", async () => {
    const whole = await collect(source(TXNS, 999), "json");
    const chunked = await collect(source(TXNS, 1), "json");
    expect(whole).toBe(chunked);
    expect(() => JSON.parse(whole) as unknown).not.toThrow();
  });

  test("money is a string everywhere, and the minor units are carried exactly", async () => {
    const doc = JSON.parse(await collect(source(), "json")) as Record<string, any>;
    const t2 = (doc["transactions"] as any[]).find((t) => t.id === "t2");
    expect(t2.amount_minor).toBe("9223372036854775807");
    expect(t2.amount).toBe("92233720368547758.07");
    // Nothing anywhere in the document is a JSON number that came from money.
    expect(typeof t2.amount_minor).toBe("string");
    expect(typeof t2.amount).toBe("string");
  });

  test("a bigint reaching JSON.stringify unhandled would throw, so this is not luck", () => {
    expect(() => JSON.stringify({ a: 1n })).toThrow();
  });

  test("rates, rules, anomalies and the home currency are all in it", async () => {
    const doc = JSON.parse(await collect(source(), "json")) as Record<string, any>;
    expect(doc["home_currency"]).toBe("AED");
    expect(doc["rules"]).toHaveLength(1);
    expect(doc["rates"]).toEqual([
      { currency: "USD", rate_micro: "3672500" },
      { currency: "EUR", rate_micro: null },
    ]);
    expect(doc["anomalies"]).toEqual([{ kind: "split_sum", detail: "parts do not sum", at_seq: "42" }]);
  });

  test("superseded rows are kept — §2 says nothing is dropped", async () => {
    const doc = JSON.parse(await collect(source(), "json")) as Record<string, any>;
    expect((doc["transactions"] as any[]).find((t) => t.id === "t4").superseded_by).toBe("op-sup-1");
  });

  test("the manifest states what the file is NOT, in the file", async () => {
    const doc = JSON.parse(await collect(source(), "json")) as Record<string, any>;
    const m = doc["ledger_export"];
    expect(m.format).toBe("json");
    expect(m.generated_at).toBe("2026-08-02T09:00:00.000Z");
    expect(m.transaction_count).toBe(TXNS.length);
    expect(m.omits).toEqual([...EXPORT_OMISSIONS.json]);
    // The two that matter most: it is not the op log, and it is not the mail.
    expect(m.omits.join(" ")).toContain("op log");
    expect(m.omits.join(" ")).toContain("email");
  });

  test("the counted transactions are the written transactions", async () => {
    // A count taken from the same loop that writes the rows would be true by
    // construction. This one comes from the source and is checked against the
    // parsed document.
    const doc = JSON.parse(await collect(source(), "json")) as Record<string, any>;
    expect((doc["transactions"] as any[]).length).toBe(doc["ledger_export"].transaction_count);
  });
});

// ---------------------------------------------------------------------------
// 4. The thing that keeps a 3,683-row export off the JS thread
// ---------------------------------------------------------------------------

describe("writeExport chunks and yields", () => {
  test("it awaits `between` once per chunk, and the yield really is awaited", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => txn({ id: `x${i}` }));
    const order: string[] = [];
    let yields = 0;
    const report = await writeExport(
      renderExport(source(rows, 250), "csv"),
      () => {
        order.push("write");
      },
      {
        between: async () => {
          yields++;
          order.push("yield");
          await Promise.resolve();
        },
      },
    );
    expect(yields).toBeGreaterThan(0);
    expect(report.chunks).toBe(yields + 1);
    // Interleaved, not all-writes-then-all-yields.
    expect(order.indexOf("yield")).toBeLessThan(order.lastIndexOf("write"));
  });

  test("it does not write past a chunk boundary until `between` resolves", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => txn({ id: `x${i}` }));
    const writes: string[] = [];
    let release!: () => void;
    const boundary = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writing = writeExport(
      renderExport(source(rows, 1), "csv"),
      (piece) => {
        writes.push(piece);
      },
      { between: () => boundary },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toHaveLength(2); // header plus the first transaction chunk

    release();
    await writing;
    expect(writes).toHaveLength(3);
  });

  test("no single piece handed to the sink holds the whole export", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => txn({ id: `x${i}` }));
    let biggest = 0;
    let total = 0;
    await writeExport(renderExport(source(rows, 250), "csv"), (s) => {
      biggest = Math.max(biggest, s.length);
      total += s.length;
    });
    expect(biggest).toBeLessThan(total / 2);
  });

  test("the report's byte count is measured at the sink, not predicted", async () => {
    let bytes = 0;
    const report = await writeExport(renderExport(source(), "json"), (s) => {
      bytes += new TextEncoder().encode(s).length;
    });
    expect(report.bytes).toBe(bytes);
  });

  test("EXPORT_CHUNK is the 250 the rest of the app uses", () => {
    expect(EXPORT_CHUNK).toBe(250);
  });
});

describe("exportFileName", () => {
  test("it carries the date and the right extension", () => {
    expect(exportFileName("csv", "2026-08-02T09:00:00.000Z")).toBe("ledger-2026-08-02.csv");
    expect(exportFileName("json", "2026-08-02T09:00:00.000Z")).toBe("ledger-2026-08-02.json");
  });

  test("it never produces a path separator, whatever it is handed", () => {
    expect(exportFileName("csv", "../../etc/passwd")).not.toContain("/");
  });
});

// ---------------------------------------------------------------------------
// A minimal RFC 4180 reader, so the CSV assertions above read a parsed record
// rather than a `split("\n")` that the fixture is designed to defeat.
// ---------------------------------------------------------------------------

function csvRecords(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      out.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}
