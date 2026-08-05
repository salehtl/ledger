import { describe, expect, test } from "bun:test";
import type { Txn } from "@ledger/client/replay/state.ts";
import { MAX_RETAINED_TXNS, prependTxnWindow, retainTxnWindow } from "./transactions.ts";

describe("transaction render window", () => {
  test("evicts old pages instead of retaining the account", () => { const rows = Array.from({ length: MAX_RETAINED_TXNS + 50 }, (_, id) => ({ id: String(id) } as Txn)); expect(retainTxnWindow(rows.slice(0, MAX_RETAINED_TXNS), rows.slice(MAX_RETAINED_TXNS), false).map((r) => r.id)).toEqual(rows.slice(50).map((r) => r.id)); });

  test("prependTxnWindow is the mirror of retainTxnWindow: it evicts the TAIL, not the head", () => {
    // If this evicted from the front like retainTxnWindow does, prepending
    // recovered rows would immediately throw them away again — the exact bug
    // this function exists to fix. Bound stays MAX_RETAINED_TXNS either way.
    const rows = Array.from({ length: MAX_RETAINED_TXNS + 50 }, (_, id) => ({ id: String(id) } as Txn));
    const kept = rows.slice(50); // simulates what retainTxnWindow left after eviction
    const recovered = rows.slice(0, 50); // the 50 newest rows retainTxnWindow dropped
    const got = prependTxnWindow(kept, recovered);
    expect(got.length).toBe(MAX_RETAINED_TXNS);
    // The newest (recovered) rows are back at the front, and the tail — the
    // oldest rows, farthest from where the user was scrolling back up TO — is
    // what paid for the bound.
    expect(got.map((r) => r.id)).toEqual(rows.slice(0, MAX_RETAINED_TXNS).map((r) => r.id));
  });

  test("prependTxnWindow below the bound keeps everything, in newest-first order", () => {
    const previous: Txn[] = [{ id: "b" } as Txn, { id: "a" } as Txn];
    const newer: Txn[] = [{ id: "d" } as Txn, { id: "c" } as Txn];
    expect(prependTxnWindow(previous, newer).map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
  });
});
