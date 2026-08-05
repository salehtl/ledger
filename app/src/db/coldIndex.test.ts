import { expect, test } from "bun:test";

import { bunDriver } from "@ledger/client/store/driver.ts";
import { sqliteColdBodyIndex } from "./coldIndex.ts";

test("the production cold index persists lookups and prunes by numeric seq", () => {
  const db = bunDriver(":memory:");
  const first = sqliteColdBodyIndex(db);
  first.put("a".repeat(64), 9n);
  first.put("b".repeat(64), 10n);

  const reopened = sqliteColdBodyIndex(db);
  expect(reopened.get("a".repeat(64))).toBe(9n);
  expect(reopened.get("b".repeat(64))).toBe(10n);
  reopened.deleteBefore(10n);
  expect(reopened.get("a".repeat(64))).toBeNull();
  expect(reopened.get("b".repeat(64))).toBe(10n);
  db.close();
});
