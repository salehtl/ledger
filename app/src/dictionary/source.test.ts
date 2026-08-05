import { describe, expect, test } from "bun:test";
import { bunDriver } from "@ledger/client/store/driver.ts";
import { sqliteDictionarySource } from "./source.ts";

describe("device dictionary", () => {
  test("persists deltas, removes retractions, and matches exact before contains", async () => {
    const db = bunDriver(":memory:"); let round = 0;
    const source = sqliteDictionarySource({ db, server: "https://ledger.test", token: () => "session", submitter: { submit: async () => {} }, fetch: async () => new Response(JSON.stringify(round++ === 0 ? { version: "1", entries: [{ pattern: "market", match: "contains", category: "General" }, { pattern: "city market", match: "exact", category: "Groceries" }], removed: [] } : { version: "2", entries: [], removed: [{ pattern: "city market", match: "exact", category: "Groceries" }] }), { status: 200, headers: { "content-type": "application/json" } }) });
    await source.sync(); expect(source.version()).toBe(1n); expect(source.categoryFor("City Market")).toBe("Groceries");
    await source.sync(); expect(source.version()).toBe(2n); expect(source.categoryFor("City Market")).toBe("General"); db.close();
  });
});
