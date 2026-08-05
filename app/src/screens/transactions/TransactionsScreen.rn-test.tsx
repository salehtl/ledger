import { act, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { Txn } from "@ledger/client/replay/state.ts";

import { ThemeProvider } from "../../app/Theme.tsx";
import { MAX_RETAINED_ROWS, PAGE_SIZE, TransactionsScreen } from "./TransactionsScreen.tsx";
import type { TxnSource } from "./source.ts";
import type { TxnCursor, TxnFilters, TxnPageOptions } from "../../lib/transactions.ts";

/**
 * The screen-level proof for the recritic's Task 18 finding: front-eviction
 * on a forward-only cursor made scrolled-past rows unrecoverable.
 * `transactions.test.ts` and `transactions.window.test.ts` prove the query
 * and the pure window helpers are individually correct, with a full mutation
 * pass on both; this file proves the SCREEN actually WIRES `FlatList`'s
 * `onEndReached`/`onStartReached` to that recovery path through a real
 * render — "written, tested green, never wired" (AGENT-RULES) applies to a
 * wiring gap exactly as much as to a missing implementation.
 *
 * There is no `UNSAFE_getByType` in this project's `@testing-library/
 * react-native` (its `TestInstance` only documents host elements), but
 * `getByTestId("txn-list")` resolves to the element `FlatList`/
 * `VirtualizedList` actually spread ALL of their incoming props onto —
 * `onEndReached`, `onStartReached`, `data`, `getItemCount`, etc. are present
 * on `.props` verbatim. That is used here to invoke the exact callbacks
 * `TransactionsScreen` handed to the real `FlatList`, not a reimplementation
 * of them. The element is re-queried after every interaction rather than
 * captured once, because each state update produces a new element with a
 * fresh closure over `rows`/`cursor` — reusing a stale reference would call
 * the OLD closure and never advance past the second page.
 */

function txn(id: string, minutesAgo: number): Txn {
  const anchor = Date.UTC(2026, 0, 1, 0, 0, 0);
  const at = new Date(anchor - minutesAgo * 60_000).toISOString();
  return {
    id,
    ingest_id: id.padEnd(64, "a"),
    amount_minor: 1000n,
    currency: "AED",
    direction: "debit",
    posted_at: at,
    merchant_raw: `Merchant ${id}`,
    last4: "1234",
    category: "groceries",
    needs_review: false,
    unparsed: false,
    tier: "template",
    parse_error: null,
    provenance: "ingest",
    amount_home_minor: 1000n,
    splits: [],
    superseded_by: null,
    possible_duplicate_of: null,
    version: 1,
  };
}

/**
 * A hand-rolled keyset source, NOT `sqlTxnSource` — jest-expo has no
 * `bun:sqlite`, so this is a plain in-memory mirror of the real cursor
 * semantics `buildTxnQuery` implements (posted_at DESC, id DESC tiebreak,
 * `<`/`>` per direction, limit+1 hasMore probe). Its correctness is not what
 * this file tests — `transactions.test.ts` already proves that against the
 * real SQL — this file's job is only to prove the SCREEN calls it right.
 */
function fakeSource(all: readonly Txn[]): TxnSource {
  const sorted = [...all].sort((a, b) => (a.posted_at !== b.posted_at ? (a.posted_at < b.posted_at ? 1 : -1) : a.id < b.id ? 1 : -1));
  const cmp = (t: Txn, c: TxnCursor, dir: "older" | "newer"): boolean =>
    dir === "older"
      ? t.posted_at < c.posted_at || (t.posted_at === c.posted_at && t.id < c.id)
      : t.posted_at > c.posted_at || (t.posted_at === c.posted_at && t.id > c.id);
  return {
    list(_filters: TxnFilters, opts: TxnPageOptions) {
      const dir = opts.direction ?? "older";
      let pool = opts.after === null ? sorted : sorted.filter((t) => cmp(t, opts.after as TxnCursor, dir));
      if (dir === "newer") pool = [...pool].reverse();
      const hasMore = pool.length > opts.limit;
      let page = pool.slice(0, opts.limit);
      if (dir === "newer") page = [...page].reverse();
      const boundary = dir === "newer" ? page[0] : page[page.length - 1];
      return { rows: page, next: hasMore && boundary !== undefined ? { posted_at: boundary.posted_at, id: boundary.id } : null };
    },
    read: () => null,
    forks: () => [],
    facets: () => ({ categories: [], currencies: [] }),
    homeCurrency: () => "AED",
    edit: () => ({ ok: false, errors: ["unused"] }),
    split: () => ({ ok: false, errors: ["unused"] }),
    recomputeHome: () => ({ ok: false, error: "unused" }),
  };
}

async function pressEndReached(): Promise<void> {
  const list = screen.getByTestId("txn-list");
  await act(async () => {
    (list.props["onEndReached"] as () => void)();
  });
}

async function pressStartReached(): Promise<void> {
  const list = screen.getByTestId("txn-list");
  await act(async () => {
    (list.props["onStartReached"] as () => void)();
  });
}

/**
 * The retained window, straight from `FlatList`'s own `data` prop rather
 * than from the rendered DOM. `FlatList` only ever mounts a small window of
 * ROWS around the current (untouched, in this harness) scroll position —
 * `initialNumToRender` — regardless of how many are in `rows` state, so
 * "is `txn-row-X` in the tree" does not track eviction/recovery at all.
 * `data` is the actual state array `TransactionsScreen` computed, unfiltered
 * by that windowing, which is what this fix's correctness lives or dies on.
 */
function retainedIds(): string[] {
  const list = screen.getByTestId("txn-list");
  return (list.props["data"] as Txn[]).map((t) => t.id);
}

it("scrolling down evicts the newest rows from the front, and scrolling back up recovers them exactly", async () => {
  // More than MAX_RETAINED_ROWS so the bound actually bites, and enough rows
  // that recovery needs more than one onStartReached call.
  const total = MAX_RETAINED_ROWS + PAGE_SIZE * 2;
  const all = Array.from({ length: total }, (_, i) => txn(`t${String(i).padStart(4, "0")}`, i));
  const source = fakeSource(all);
  const newest = all[0] as Txn;
  const oldest = all[total - 1] as Txn;

  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <ThemeProvider>
        <TransactionsScreen source={source} onOpen={() => {}} nowIso="2026-01-01T00:00:00.000Z" />
      </ThemeProvider>
    </SafeAreaProvider>,
  );

  await waitFor(() => expect(retainedIds()).toContain(newest.id));

  // Page down until the retained window exceeds MAX_RETAINED_ROWS: the
  // newest row must be evicted from the front, exactly the bug this fix
  // targets. `total / PAGE_SIZE` pages is the exact number needed to exhaust
  // the fixture; a couple extra confirm `onEndReached` is a safe no-op once
  // `cursor` goes null.
  const pagesDown = Math.ceil(total / PAGE_SIZE) + 2;
  for (let i = 0; i < pagesDown; i++) {
    // eslint-disable-next-line no-await-in-loop
    await pressEndReached();
  }

  await waitFor(() => expect(retainedIds()).not.toContain(newest.id));
  const evicted = retainedIds();
  expect(evicted.length).toBeLessThanOrEqual(MAX_RETAINED_ROWS);
  expect(evicted).toContain(oldest.id);
  // The tail — the end the user just scrolled to — is exactly what
  // `retainTxnWindow` kept: the oldest MAX_RETAINED_ROWS rows, in order.
  expect(evicted).toEqual(all.slice(-MAX_RETAINED_ROWS).map((t) => t.id));

  // Scroll back up: each onStartReached recovers one PAGE_SIZE-sized page of
  // what was evicted, so it takes more than one call to bring the original
  // top row back — this is what proves the recovery is real paging, not a
  // single lucky refetch.
  const pagesUp = Math.ceil(MAX_RETAINED_ROWS / PAGE_SIZE) + 2;
  for (let i = 0; i < pagesUp; i++) {
    // eslint-disable-next-line no-await-in-loop
    await pressStartReached();
  }

  await waitFor(() => expect(retainedIds()).toContain(newest.id));
  // The recovered window is bounded exactly like the evicted one was, and it
  // is the newest MAX_RETAINED_ROWS rows now — the mirror image of `evicted`.
  expect(retainedIds()).toEqual(all.slice(0, MAX_RETAINED_ROWS).map((t) => t.id));
});

it("onStartReached is a safe no-op when nothing was ever evicted (fresh list, top row already the newest)", async () => {
  const all = Array.from({ length: PAGE_SIZE - 5 }, (_, i) => txn(`t${String(i).padStart(4, "0")}`, i));
  const source = fakeSource(all);
  const newest = all[0] as Txn;

  await render(
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <ThemeProvider>
        <TransactionsScreen source={source} onOpen={() => {}} nowIso="2026-01-01T00:00:00.000Z" />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(retainedIds()).toContain(newest.id));

  await pressStartReached();
  await pressStartReached();

  // Nothing above the newest row exists to recover; the retained window and
  // its order must be unchanged, and no error state must appear.
  expect(retainedIds()).toEqual(all.map((t) => t.id));
  expect(screen.queryByTestId("txn-error")).toBeNull();
});
