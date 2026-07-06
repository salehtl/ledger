import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { useIngestHealth } from "./useIngestHealth";

describe("useIngestHealth", () => {
  it("opts into refetchOnWindowFocus despite the app-wide default being off", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "ok", db: "ok" }))));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);

    renderHook(() => useIngestHealth(), { wrapper });

    const query = qc.getQueryCache().find({ queryKey: ["health"] });
    // `options` is typed as core QueryOptions, which omits the observer-level
    // refetchOnWindowFocus flag — but react-query merges and stores it on the
    // same object at runtime, so read it through an untyped view.
    const options = query?.options as { refetchOnWindowFocus?: boolean } | undefined;
    expect(options?.refetchOnWindowFocus).toBe(true);
  });
});
