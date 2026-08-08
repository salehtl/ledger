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

import { useMemo } from "react";
import { useQuery, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { CategoryDef, Rule } from "@ledger/client/replay/state";

import { useV2 } from "./BootGate";
import { sqlBanksSource, type BanksSource, type DeclaredBank } from "./sources/banks";
import { sqlBudgetSource, type BudgetSnapshot, type BudgetSource } from "./sources/budget";
import {
  mergeMoney,
  sqlReviewSource,
  type ForkItem,
  type Lane,
  type LaneCounts,
  type ReviewItem,
  type ReviewMoney,
  type ReviewSource,
} from "./sources/review";
import {
  sqlInsightsSource,
  type DrillPage,
  type DrillTarget,
  type InsightsSnapshot,
  type InsightsSource,
} from "./sources/insights";
import {
  sqlTxnSource,
  type TxnFacets,
  type TxnFilters,
  type TxnPage,
  type TxnSource,
} from "./sources/transactions";

/** The prefix every v2 query key carries. */
export const V2_QUERY_ROOT = "v2";

/**
 * A transaction list's scope, as the projection reads it.
 *
 * The three original fields are the shell's own vocabulary (its scope selector
 * hands every list screen a `from`/`to`, and the segmented control a status).
 * `extra` carries the rest of a {@link TxnFilters} — the chips and the merchant
 * query — already serialised, because a key has to be a stable, comparable
 * value and a `readonly (string | null)[]` inside one is neither.
 */
export interface TxnFilter {
  from?: string;
  to?: string;
  status?: string;
  extra?: string;
  limit?: number;
}

export const v2Keys = {
  /** Everything. What {@link invalidateAfterSync} invalidates. */
  all: [V2_QUERY_ROOT] as const,
  /**
   * The 50/30/20 read. `period` is `"all"` today: the projection holds no
   * per-period plan (see `sources/budget.ts`), so the snapshot is over the
   * whole log. The argument stays because a period op would reinstate it.
   */
  budget: (period: string) => [V2_QUERY_ROOT, "budget", period] as const,
  /**
   * The Insights read for one month. Unlike {@link v2Keys.budget}, `period` is
   * real here: the breakdown IS bounded by a month, and the trailing flow chart
   * is part of the same pass, so the periods it plots are in the key too.
   */
  insights: (period: string, trend: readonly string[]) =>
    [V2_QUERY_ROOT, "insights", period, trend.join(",")] as const,
  /** One breakdown row's transactions. `target` is serialised, so the key is comparable. */
  insightsDrill: (period: string, target: string, limit: number) =>
    [V2_QUERY_ROOT, "insights", "drill", period, target, limit] as const,
  transactions: (filter: TxnFilter) =>
    [
      V2_QUERY_ROOT,
      "transactions",
      filter.from ?? "",
      filter.to ?? "",
      filter.status ?? "",
      filter.extra ?? "",
      filter.limit ?? 0,
    ] as const,
  /** The chip values a filter strip may offer, drawn from the projection. */
  facets: () => [V2_QUERY_ROOT, "facets"] as const,
  /**
   * The review family. Nothing queries this key itself; it is what an answered
   * card invalidates, and react-query matches by prefix, so it reaches every
   * lane below it.
   */
  review: () => [V2_QUERY_ROOT, "review"] as const,
  /** One lane's whole feed: its page, the counts, the categories and the rules. */
  reviewLane: (lane: string) => [V2_QUERY_ROOT, "review", lane] as const,
  quarantine: () => [V2_QUERY_ROOT, "quarantine"] as const,
  /**
   * The category grid and the materialised rules, which any screen that can
   * author a categorisation needs. Not under `review`: the review deck and the
   * transaction list both read it, and nesting it under one screen's family
   * would make the other's invalidation look accidental.
   */
  categories: () => [V2_QUERY_ROOT, "categories"] as const,
  /**
   * The banks the user declared, from the projection. Not under `categories`:
   * they are a different question with a different author, and one screen's
   * invalidation reaching the other would be accidental.
   */
  banks: () => [V2_QUERY_ROOT, "banks"] as const,
  /**
   * `GET /api/v1/templates` — which banks ledger can READ. Server truth, and a
   * different question from which banks the user declared.
   */
  templates: () => [V2_QUERY_ROOT, "templates"] as const,
  /** `GET /api/v1/address` — server truth, not the projection. */
  address: () => [V2_QUERY_ROOT, "address"] as const,
} as const;

/**
 * The stable part of a {@link TxnFilters} that {@link TxnFilter.extra} carries.
 *
 * Sorted within each dimension, so two filter objects that select the same
 * things produce the same key however the user got there — an unstable key
 * refetches forever, and here "refetch" means "re-run the SQL and hand React a
 * new array identity", which restarts the list's entrance animation.
 */
export function serializeFilters(f: TxnFilters): string {
  const dims = [
    [...f.directions].sort().join(","),
    [...f.categories].map((c) => (c === null ? "\u0000null" : c)).sort().join(","),
    [...f.currencies].sort().join(","),
    [...f.provenance].sort().join(","),
    [...f.flags].sort().join(","),
    f.query.trim(),
    f.includeSuperseded ? "1" : "0",
  ];
  return dims.join("|");
}

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

// ---------------------------------------------------------------------------
// The sources, and the queries over them
//
// A screen never opens the database itself and never calls `useQuery` with an
// HTTP `queryFn`. It asks for a source — which is `null` when this tree has no
// v2 runtime — and hands it to one of the hooks below.
//
// **`null` is not a fallback.** `useV2()` returns null wherever the gate is
// absent, and a screen that answered that by fetching `/api/summary` would look
// entirely correct in a test while reading a different database over a
// different protocol; `ledgerd` does not even serve those routes. So the
// sources go null, every query below is disabled, and the screen renders its
// disconnected state. There is no path from here to the v1 client.
// ---------------------------------------------------------------------------

/**
 * The transaction source over this device's projection, or `null` with no v2
 * runtime.
 *
 * `injected` is the test seam — the same one `app/src/screens/transactions`
 * uses — so a screen test can hand over a source built on a real in-memory
 * projection rather than standing up the whole boot gate.
 */
export function useTxnSource(injected?: TxnSource): TxnSource | null {
  const runtime = useV2();
  const driver = runtime?.handle.driver ?? null;
  return useMemo(() => {
    if (injected !== undefined) return injected;
    return driver === null ? null : sqlTxnSource(driver);
  }, [injected, driver]);
}

/**
 * The review source over this device's projection, or `null` with no v2 runtime.
 *
 * `null` is not a fallback and there is no path from here to v1: the screen
 * renders its disconnected state, exactly as `Home` and `Transactions` do. What
 * would be dangerous — and what `useV2OrThrow`'s doc warns about — is answering
 * a missing runtime by fetching `/api/transactions?status=needs_review`, which
 * looks correct in a test while reading a different database over a protocol
 * `ledgerd` does not serve. This screen makes no HTTP call at all, and
 * `Review.test.tsx` asserts it.
 */
export function useReviewSource(injected?: ReviewSource): ReviewSource | null {
  const runtime = useV2();
  const driver = runtime?.handle.driver ?? null;
  return useMemo(() => {
    if (injected !== undefined) return injected;
    return driver === null ? null : sqlReviewSource(driver);
  }, [injected, driver]);
}

/** The 50/30/20 source over this device's projection, or `null`. See {@link useTxnSource}. */
export function useBudgetSource(injected?: BudgetSource): BudgetSource | null {
  const runtime = useV2();
  const driver = runtime?.handle.driver ?? null;
  return useMemo(() => {
    if (injected !== undefined) return injected;
    return driver === null ? null : sqlBudgetSource(driver);
  }, [injected, driver]);
}

/** The declared-banks source over this device's projection, or `null`. See {@link useTxnSource}. */
export function useBanksSource(injected?: BanksSource): BanksSource | null {
  const runtime = useV2();
  const driver = runtime?.handle.driver ?? null;
  return useMemo(() => {
    if (injected !== undefined) return injected;
    return driver === null ? null : sqlBanksSource(driver);
  }, [injected, driver]);
}

/** The Insights source over this device's projection, or `null`. See {@link useTxnSource}. */
export function useInsightsSource(injected?: InsightsSource): InsightsSource | null {
  const runtime = useV2();
  const driver = runtime?.handle.driver ?? null;
  return useMemo(() => {
    if (injected !== undefined) return injected;
    return driver === null ? null : sqlInsightsSource(driver);
  }, [injected, driver]);
}

/**
 * `staleTime: Infinity` on every read below, deliberately.
 *
 * The projection only changes when a sync writes it, and the coordinator calls
 * {@link invalidateAfterSync} when it does. Any other refetch trigger — mount,
 * window focus, reconnect — would re-run the SQL and hand React new array
 * identities for rows that did not change, which restarts the list's entrance
 * animation for no reason.
 */
const PROJECTION_QUERY = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

export function useBudgetSnapshot(source: BudgetSource | null): UseQueryResult<BudgetSnapshot> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.budget("all"),
    // `Date.now()` is read inside the queryFn rather than closed over in the
    // key: `historyDays` moves once a day, and a key that carried the clock
    // would miss the cache on every render.
    queryFn: () => source!.read(Date.now()),
    enabled: source !== null,
  });
}

/**
 * One month of Insights, in a single pass of the projection.
 *
 * One query rather than four, for the reason {@link useReviewFeed} gives: the
 * headline, the breakdown, the movers and the flow chart are one screen, and
 * four keys would let the hero render against a different pass than the bars
 * beneath it.
 */
export function useInsightsSnapshot(
  source: InsightsSource | null,
  period: string,
  trendPeriods: readonly string[],
): UseQueryResult<InsightsSnapshot> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.insights(period, trendPeriods),
    queryFn: () => source!.read(period, trendPeriods),
    enabled: source !== null,
  });
}

/**
 * A stable key for a drill target. `null` is a real category ("uncategorized")
 * and has to be distinguishable from the empty string, hence the sentinel.
 */
function serializeDrillTarget(t: DrillTarget): string {
  if (t.type === "merchant") return `merchant:${t.merchant}`;
  if (t.type === "bucket") return `bucket:${t.bucket}`;
  return `category:${t.category === null ? " null" : t.category}`;
}

/** The transactions behind one breakdown row. See `sources/insights.ts`'s `DrillPage`. */
export function useInsightsDrill(
  source: InsightsSource | null,
  period: string,
  target: DrillTarget,
  limit: number,
): UseQueryResult<DrillPage> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.insightsDrill(period, serializeDrillTarget(target), limit),
    queryFn: () => source!.drill(period, target, limit),
    enabled: source !== null,
  });
}

/** Everything the review screen renders, read in one pass. */
export interface ReviewFeed {
  counts: LaneCounts;
  items: ReviewItem[];
  forks: ForkItem[];
  money: ReviewMoney;
  categories: string[];
  /** The user's own definitions — what the grid offers, and what it withholds. */
  categoryDefs: CategoryDef[];
  rules: Rule[];
}

/**
 * The feed for a set of lanes, dealt in the order they are given.
 *
 * Everything under one key rather than a query per read, because they are one
 * screen: separate keys would give the deck several independent loading states
 * and let the badge render against a different pass of the projection than the
 * list under it.
 *
 * The lanes' pages are read **in order, one after another**, not in parallel.
 * The order the deck deals its cards is the lanes' precedence order, and it is
 * the same order every read — a `Promise.all` would leave the deck's contents up
 * to which query settled first.
 */
export function useReviewFeed(source: ReviewSource | null, lanes: readonly Lane[]): UseQueryResult<ReviewFeed> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.reviewLane(lanes.join("+")),
    queryFn: async (): Promise<ReviewFeed> => {
      const items: ReviewItem[] = [];
      const moneys: ReviewMoney[] = [];
      for (const lane of lanes) {
        if (lane !== "forks") items.push(...(await source!.page(lane)));
        moneys.push(await source!.money(lane));
      }
      const [counts, forks, categories, categoryDefs, rules] = await Promise.all([
        source!.counts(),
        source!.forks(),
        source!.categories(),
        source!.categoryDefs(),
        source!.rules(),
      ]);
      return { counts, items, forks, money: mergeMoney(moneys), categories, categoryDefs, rules };
    },
    enabled: source !== null,
  });
}

/** Everything a categorisation control needs that is not the transaction itself. */
export interface CategoryChoices {
  /** The categories this user actually uses, most-used first. */
  categories: string[];
  /** The categories this user DEFINED, retired ones included. Different question. */
  categoryDefs: CategoryDef[];
  /** Every materialised rule, so a merchant categorised twice does not write the same rule twice. */
  rules: Rule[];
}

/**
 * The category grid and the rule set, for a screen that can author a
 * categorisation but is not the review deck.
 *
 * Two reads under one key rather than two queries, for the reason
 * {@link useReviewFeed} states: they are one control, and two keys would let the
 * grid render against a different pass of the projection than the rule
 * write-back is deduplicated against.
 */
export function useCategoryChoices(source: ReviewSource | null): UseQueryResult<CategoryChoices> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.categories(),
    queryFn: async (): Promise<CategoryChoices> => {
      const [categories, categoryDefs, rules] = await Promise.all([
        source!.categories(),
        source!.categoryDefs(),
        source!.rules(),
      ]);
      return { categories, categoryDefs, rules };
    },
    enabled: source !== null,
  });
}

export function useTxnList(source: TxnSource | null, filters: TxnFilters, limit: number): UseQueryResult<TxnPage> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.transactions({
      from: filters.from,
      to: filters.to,
      extra: serializeFilters(filters),
      limit,
    }),
    queryFn: () => source!.list(filters, { limit, after: null }),
    enabled: source !== null,
  });
}

export function useTxnFacets(source: TxnSource | null): UseQueryResult<TxnFacets> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.facets(),
    queryFn: () => source!.facets(),
    enabled: source !== null,
  });
}

/**
 * Every declaration the log holds, RETIRED ONES INCLUDED — the picker filters,
 * this does not, for the same reason `useCategoryChoices` hands over retired
 * definitions: Settings has to be able to bring one back.
 */
export function useDeclaredBanks(source: BanksSource | null): UseQueryResult<DeclaredBank[]> {
  return useQuery({
    ...PROJECTION_QUERY,
    queryKey: v2Keys.banks(),
    queryFn: () => source!.read(),
    enabled: source !== null,
  });
}

/** The home currency the log set, or `null` while none has been chosen. */
export function useHomeCurrency(source: TxnSource | null): string | null {
  const q = useQuery({
    ...PROJECTION_QUERY,
    queryKey: [V2_QUERY_ROOT, "home-currency"] as const,
    queryFn: () => source!.homeCurrency(),
    enabled: source !== null,
  });
  return q.data ?? null;
}
