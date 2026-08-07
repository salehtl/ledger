/**
 * The v2 query keys, and the one invalidation a finished sync performs.
 *
 * # react-query is a re-render bus here, not a cache
 *
 * In v1 every screen's data came from an HTTP call and react-query was the
 * cache in front of it. In v2 the data is already on the device: the sync
 * engine folds the log and writes the SQLite projection, and a screen's
 * `queryFn` is a synchronous-ish read of that projection. The cache is the
 * projection. What react-query still earns its place doing is telling a React
 * tree that the projection changed, which is what {@link invalidateAfterSync}
 * is for.
 *
 * That is why **the persister must not be mounted over these keys** (see
 * `main.tsx`). Two independent reasons, either of which is sufficient:
 *
 *  - `createSyncStoragePersister` serialises with `JSON.stringify`, and
 *    `JSON.stringify(1n)` **throws** — money is `int64` minor units carried as
 *    `bigint` all the way from `client/src/replay/state.ts`. A persister that
 *    was taught to survive that (a replacer emitting `"12345"`) is worse, not
 *    better: it silently round-trips money back as a string or, with a naive
 *    reviver, as a lossy `number`.
 *  - Persisting a copy of the projection into `localStorage` would give the app
 *    a second, staler source of truth for exactly the data whose whole design
 *    is that there is one.
 *
 * # One root, so one call invalidates everything
 *
 * Every key begins with {@link V2_QUERY_ROOT}. react-query matches keys by
 * prefix, so `invalidateQueries({ queryKey: [V2_QUERY_ROOT] })` reaches every
 * v2 query and nothing else — which matters while v1 screens are still mounted
 * alongside (Tasks 8–10 retire them). An enumerated list of keys here would be
 * a second place to update every time a screen is added, and the failure mode
 * of forgetting is a screen that never refreshes after a sync.
 */

import type { QueryClient } from "@tanstack/react-query";

/** The prefix every v2 query key carries. */
export const V2_QUERY_ROOT = "v2";

/** A transaction list's scope, as the projection reads it. */
export interface TxnFilter {
  from?: string;
  to?: string;
  status?: string;
}

export const v2Keys = {
  /** Everything. What {@link invalidateAfterSync} invalidates. */
  all: [V2_QUERY_ROOT] as const,
  /** The 50/30/20 read for one period, e.g. `"2026-08"`. */
  budget: (period: string) => [V2_QUERY_ROOT, "budget", period] as const,
  transactions: (filter: TxnFilter) =>
    [V2_QUERY_ROOT, "transactions", filter.from ?? "", filter.to ?? "", filter.status ?? ""] as const,
  review: () => [V2_QUERY_ROOT, "review"] as const,
  quarantine: () => [V2_QUERY_ROOT, "quarantine"] as const,
  /** `GET /api/v1/address` — server truth, not the projection. */
  address: () => [V2_QUERY_ROOT, "address"] as const,
} as const;

/**
 * Everything the projection feeds, marked stale.
 *
 * Called after a sync settles rather than after each phase: the projection is
 * rewritten chunk by chunk and `projection_meta.complete` is 0 until the last
 * one lands, so a mid-sync invalidation would refetch rows the engine has
 * already declared unusable.
 */
export function invalidateAfterSync(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: v2Keys.all });
}
