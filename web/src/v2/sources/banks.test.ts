import { describe, expect, it } from "vitest";
import { ensureProjection, PROJECTION_VERSION } from "@ledger/client/replay/projection";
import type { SqlDriver } from "@ledger/client/store/driver";

import { activeBanks, bankDeclaredOps, readDeclaredBanks, sqlBanksSource } from "./banks";

async function blank(): Promise<SqlDriver> {
  const { openBrowserDriver } = await import("../db/driver");
  const db = await openBrowserDriver(`banks-${crypto.randomUUID()}`);
  ensureProjection(db);
  db.prepare(
    `INSERT INTO projection_meta (id,version,cursor_hot,cursor_cold,home_currency,complete) VALUES (1,${PROJECTION_VERSION},'0','0','AED',1)`,
  ).run();
  return db;
}

function declare(db: SqlDriver, ord: number, bank: string, active: boolean): void {
  db.prepare("INSERT INTO bank (name,ord,active) VALUES (?,?,?)").run(bank, ord, active ? 1 : 0);
}

describe("readDeclaredBanks", () => {
  it("with NO bank_declared ops, an account has declared nothing", async () => {
    // The backwards-compatibility guarantee: an account from before these ops
    // reads as an empty set rather than as a guessed one.
    const db = await blank();
    expect(readDeclaredBanks(db)).toEqual([]);
    expect(activeBanks(readDeclaredBanks(db))).toEqual([]);
  });

  it("reads declarations in fold order, retired ones included", async () => {
    const db = await blank();
    declare(db, 0, "dib", true);
    declare(db, 1, "enbd", false);
    declare(db, 2, "other", true);
    expect(readDeclaredBanks(db)).toEqual([
      { bank: "dib", active: true },
      { bank: "enbd", active: false },
      { bank: "other", active: true },
    ]);
    // Retired is a row, not an absence: it is what a restore toggles back.
    expect(activeBanks(readDeclaredBanks(db))).toEqual(["dib", "other"]);
  });

  it("is empty rather than wrong while the projection is unusable", async () => {
    const db = await blank();
    declare(db, 0, "dib", true);
    db.prepare("UPDATE projection_meta SET complete = 0 WHERE id = 1").run();
    expect(sqlBanksSource(db).read()).toEqual([]);
  });
});

describe("bankDeclaredOps", () => {
  it("authors one op per bank, carrying the bank and its active flag", () => {
    expect(bankDeclaredOps("dib", true)).toEqual([{ type: "bank_declared", payload: { bank: "dib", active: true } }]);
    expect(bankDeclaredOps("dib", false)).toEqual([{ type: "bank_declared", payload: { bank: "dib", active: false } }]);
  });

  it("folds the name with the same grammar the server enforces", () => {
    // The stored form is what the server would store, so a picker and a typed
    // name cannot produce two rows for one bank.
    expect(bankDeclaredOps("  Dubai  Islamic  ", true)).toEqual([
      { type: "bank_declared", payload: { bank: "dubai islamic", active: true } },
    ]);
  });

  it("refuses a name the grammar cannot store rather than writing a permanent bad row", () => {
    expect(() => bankDeclaredOps("Mashreq (UAE)", true)).toThrow();
    expect(() => bankDeclaredOps("   ", true)).toThrow();
  });
});
