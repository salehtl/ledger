import { describe, expect, it } from "vitest";
import { ensureProjection, PROJECTION_VERSION } from "@ledger/client/replay/projection";
import type { CategoryDef } from "@ledger/client/replay/state";
import type { SqlDriver } from "@ledger/client/store/driver";

import { openBrowserDriver } from "../db/driver";
import { categoryDefinedOps, categoryMapping, readCategoryDefs, retireCategoryOps } from "./categories";
import { budgetMappingFor, DEFAULT_BUDGET_MAPPING, sqlBudgetSource } from "./budget";

async function blank(): Promise<SqlDriver> {
  const db = await openBrowserDriver(`categories-${crypto.randomUUID()}`);
  ensureProjection(db);
  db.prepare(
    `INSERT INTO projection_meta (id,version,cursor_hot,cursor_cold,home_currency,complete) VALUES (1,${PROJECTION_VERSION},'0','0','AED',1)`,
  ).run();
  return db;
}

function define(db: SqlDriver, ord: number, def: CategoryDef): void {
  db.prepare("INSERT INTO category (id,ord,name,kind,bucket,color,active) VALUES (?,?,?,?,?,?,?)").run(
    def.id, ord, def.name, def.kind, def.bucket, def.color, def.active ? 1 : 0,
  );
}

const GYM: CategoryDef = { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: true };

describe("readCategoryDefs", () => {
  it("with NO category_defined ops, an account has no definitions at all", async () => {
    // The backwards-compatibility guarantee, asserted first: an account that
    // never opens the manager is in exactly the state it was in before these
    // ops existed, and every consumer's default stands in for the absence.
    const db = await blank();
    expect(readCategoryDefs(db)).toEqual([]);
    expect(budgetMappingFor(db)).toEqual(DEFAULT_BUDGET_MAPPING);
  });

  it("reads definitions in fold order, retired ones included", async () => {
    const db = await blank();
    define(db, 0, GYM);
    define(db, 1, { id: "c2", name: "Therapy", kind: "spending", bucket: "need", color: "#7b35b8", active: false });
    define(db, 2, { id: "c3", name: "Transfer", kind: "excluded", bucket: null, color: null, active: true });
    expect(readCategoryDefs(db).map((c) => c.name)).toEqual(["Gym", "Therapy", "Transfer"]);
    // Retired is a row, not an absence — history depends on it.
    expect(readCategoryDefs(db)[1]?.active).toBe(false);
  });
});

describe("categoryMapping", () => {
  it("buckets a user's own spending categories, retired ones too", () => {
    const mapping = categoryMapping([
      GYM,
      { id: "c2", name: "Therapy", kind: "spending", bucket: "need", color: null, active: false },
      { id: "c3", name: "Transfer", kind: "excluded", bucket: null, color: null, active: true },
      { id: "c4", name: "Salary", kind: "income", bucket: null, color: null, active: true },
    ]);
    // Retired categories keep their bucket: a transaction categorised "Therapy"
    // before it was retired still counts as a need.
    expect(mapping).toEqual({ gym: "need", therapy: "need" });
  });

  it("a later definition of the same id wins, including a moved bucket", () => {
    const mapping = categoryMapping([{ ...GYM, bucket: "want" }]);
    expect(mapping).toEqual({ gym: "want" });
  });
});

describe("budgetMappingFor", () => {
  it("layers the user's categories over the built-in table without replacing it", async () => {
    const db = await blank();
    define(db, 0, GYM);
    const mapping = budgetMappingFor(db);
    expect(mapping.categories["gym"]).toBe("need");
    expect(mapping.categories["groceries"]).toBe("need"); // still the built-in table
    expect(mapping.fallback).toBeNull();
  });

  it("lets a user move a built-in name into a different bucket", async () => {
    const db = await blank();
    define(db, 0, { id: "c9", name: "Dining", kind: "spending", bucket: "need", color: null, active: true });
    // "dining" is a `want` in DEFAULT_BUDGET_MAPPING; the user's own definition
    // is the one that counts, or the manager would be a control that does not
    // control anything.
    expect(budgetMappingFor(db).categories["dining"]).toBe("need");
  });
});

describe("a retired category and the money already filed under it", () => {
  it("still counts in its bucket after it is retired", async () => {
    const db = await blank();
    define(db, 0, GYM);
    db.prepare(
      `INSERT INTO txn (id,ingest_id,amount_minor,currency,direction,posted_at,merchant_raw,last4,category,
        needs_review,provenance,amount_home_minor,unparsed,tier,parse_error,superseded_by,possible_duplicate_of,version)
       VALUES ('t1',?, '5000','AED','debit','2026-08-01T00:00:00.000Z','FITNESS FIRST','1234','Gym',0,'ingest','5000',0,'template',NULL,NULL,NULL,1)`,
    ).run("t1".padEnd(64, "a"));

    expect(sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z")).buckets).toEqual({
      need: 5000n, want: 0n, saving: 0n,
    });

    // Retire it. The picker will stop offering it; the money must not move.
    db.prepare("UPDATE category SET active = 0 WHERE id = 'c1'").run();
    const after = sqlBudgetSource(db).read(Date.parse("2026-08-20T00:00:00Z"));
    expect(after.buckets).toEqual({ need: 5000n, want: 0n, saving: 0n });
    expect(after.unassigned).toBe(0n);
  });
});

describe("categoryDefinedOps", () => {
  it("authors one op carrying the whole record — a definition, not a patch", () => {
    expect(categoryDefinedOps(GYM)).toEqual([
      {
        type: "category_defined",
        payload: { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: true },
      },
    ]);
  });

  it("refuses the two shapes the fold refuses, rather than authoring an anomaly", () => {
    expect(() => categoryDefinedOps({ ...GYM, bucket: null })).toThrow(/bucket/);
    expect(() =>
      categoryDefinedOps({ id: "c4", name: "Salary", kind: "income", bucket: "need", color: null, active: true }),
    ).toThrow(/bucket/);
    expect(() => categoryDefinedOps({ ...GYM, name: "  " })).toThrow(/name/);
  });

  it("retiring re-states the definition with active: false — there is no delete", () => {
    // The whole reason history survives: a retirement is a definition, so the
    // name, kind and bucket a transaction was filed under are still readable.
    expect(retireCategoryOps(GYM)).toEqual([
      {
        type: "category_defined",
        payload: { id: "c1", name: "Gym", kind: "spending", bucket: "need", color: null, active: false },
      },
    ]);
  });
});
