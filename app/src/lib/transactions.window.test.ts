import { describe, expect, test } from "bun:test";
import type { Txn } from "@ledger/client/replay/state.ts";
import { advanceTxnWindow, MAX_RETAINED_TXNS, prependTxnWindow, retainTxnWindow, type TxnWindow } from "./transactions.ts";

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

/**
 * The single-row boundary the screen test cannot reach.
 *
 * `TransactionsScreen.rn-test.tsx` drives the real down -> up -> down walk, and
 * that is where the composition is proved. But every page there is exactly
 * `TXN_PAGE_SIZE` rows, so every eviction is 50 rows at a time and a one-row
 * skip is invisible to it — a length-arithmetic mutation (`- 1`) survived the
 * whole screen suite. One row is the interesting boundary precisely because it
 * is the one a user would never notice: this module's header names the same
 * failure for the cursor tiebreak ("loses exactly one of them and loses it
 * quietly").
 */
describe("advanceTxnWindow: the cursor and the rows move together", () => {
  const at = (id: number): Txn => ({ id: String(id), posted_at: `2026-01-01T00:00:${String(id).padStart(2, "0")}Z` } as Txn);

  test("a prepend that evicts a SINGLE row still rewinds the cursor to the new bottom", () => {
    const full = Array.from({ length: MAX_RETAINED_TXNS }, (_, i) => at(i + 1));
    const bottom = full[MAX_RETAINED_TXNS - 1] as Txn;
    const prev: TxnWindow = { rows: full, cursor: { posted_at: bottom.posted_at, id: bottom.id }, exhausted: true };
    // Exactly one newer row comes back, so exactly one row falls off the tail.
    const got = advanceTxnWindow(prev, { rows: [at(0)], next: null }, "prepend");
    const newBottom = full[MAX_RETAINED_TXNS - 2] as Txn;
    expect(got.rows.length).toBe(MAX_RETAINED_TXNS);
    expect(got.rows[got.rows.length - 1]?.id).toBe(newBottom.id);
    expect(got.cursor).toEqual({ posted_at: newBottom.posted_at, id: newBottom.id });
    // And the one row that fell off is below the window again, so the list has
    // NOT seen everything.
    expect(got.exhausted).toBe(false);
  });

  test("a prepend that evicts nothing leaves the cursor and the exhausted flag exactly as they were", () => {
    const prev: TxnWindow = { rows: [at(5), at(4)], cursor: null, exhausted: true };
    const got = advanceTxnWindow(prev, { rows: [at(7), at(6)], next: null }, "prepend");
    expect(got.rows.map((r) => r.id)).toEqual(["7", "6", "5", "4"]);
    expect(got.cursor).toBeNull();
    expect(got.exhausted).toBe(true);
  });

  test("append and replace take the cursor from the page, and only the page", () => {
    const prev: TxnWindow = { rows: [at(9)], cursor: { posted_at: "x", id: "x" }, exhausted: false };
    const next = { posted_at: at(8).posted_at, id: "8" };
    expect(advanceTxnWindow(prev, { rows: [at(8)], next }, "append")).toEqual({ rows: [at(9), at(8)], cursor: next, exhausted: false });
    expect(advanceTxnWindow(prev, { rows: [at(8)], next: null }, "replace")).toEqual({ rows: [at(8)], cursor: null, exhausted: true });
  });
});
