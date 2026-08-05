import { describe, expect, test } from "bun:test";
import type { Txn } from "@ledger/client/replay/state.ts";
import { MAX_RETAINED_TXNS, retainTxnWindow } from "./transactions.ts";

describe("transaction render window", () => {
  test("evicts old pages instead of retaining the account", () => { const rows = Array.from({ length: MAX_RETAINED_TXNS + 50 }, (_, id) => ({ id: String(id) } as Txn)); expect(retainTxnWindow(rows.slice(0, MAX_RETAINED_TXNS), rows.slice(MAX_RETAINED_TXNS), false).map((r) => r.id)).toEqual(rows.slice(50).map((r) => r.id)); });
});
