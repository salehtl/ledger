import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

// How long a persisted cache entry is trusted for offline display. The offline
// banner warns the user this data may be stale; beyond this window we drop it
// rather than resurface very old money figures on a cold relaunch.
export const PERSIST_MAX_AGE = 1000 * 60 * 60 * 24; // 24h

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Keep entries in the cache (and thus eligible for persistence) long
      // enough to survive a cold relaunch. The default 5min gcTime would evict
      // them, leaving an offline restore with nothing to show.
      gcTime: PERSIST_MAX_AGE,
      refetchOnWindowFocus: false,
    },
  },
});

// Persist the react-query cache to localStorage so that relaunching the PWA
// offline restores the last loaded data instead of booting empty. localStorage
// is synchronous and simple; guard for non-browser (test/SSR) environments.
export const persister = createSyncStoragePersister({
  key: "ledger-query-cache",
  storage: typeof window === "undefined" ? undefined : window.localStorage,
});
