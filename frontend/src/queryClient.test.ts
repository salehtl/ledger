import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { persistQueryClientSave, persistQueryClientRestore } from "@tanstack/react-query-persist-client";
import { persister, PERSIST_MAX_AGE } from "./queryClient";

// The sync-storage persister throttles writes, so wait for the write to land
// rather than assuming it is synchronous.
async function waitForPersist() {
  for (let i = 0; i < 50; i++) {
    if (window.localStorage.getItem("ledger-query-cache")) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("cache was never persisted to localStorage");
}

describe("query cache persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("survives a simulated cold relaunch: a fresh client restores prior data", async () => {
    // Session 1: load some data and persist it (as happens while the app runs).
    const first = new QueryClient({ defaultOptions: { queries: { gcTime: PERSIST_MAX_AGE } } });
    first.setQueryData(["summary"], { spent: 4200 });
    await persistQueryClientSave({ queryClient: first, persister });
    await waitForPersist();

    // Session 2: a brand-new client, as after the PWA is closed and relaunched
    // offline. Without persistence this cache would be empty; with it, the last
    // loaded data is restored so the offline banner actually has data to show.
    const second = new QueryClient();
    await persistQueryClientRestore({ queryClient: second, persister, maxAge: PERSIST_MAX_AGE });
    expect(second.getQueryData(["summary"])).toEqual({ spent: 4200 });
  });

  it("drops cache older than the max age instead of showing very stale money", async () => {
    const first = new QueryClient({ defaultOptions: { queries: { gcTime: PERSIST_MAX_AGE } } });
    first.setQueryData(["summary"], { spent: 4200 });
    await persistQueryClientSave({ queryClient: first, persister });
    await waitForPersist();

    const second = new QueryClient();
    await persistQueryClientRestore({ queryClient: second, persister, maxAge: 0 });
    expect(second.getQueryData(["summary"])).toBeUndefined();
  });
});
