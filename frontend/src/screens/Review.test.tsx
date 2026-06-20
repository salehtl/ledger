import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Review } from "./Review";
import type { Scope } from "../lib/scope";

// fetch mock: needs-review txns vary by the `from` query param so we can prove
// the deck re-renders for a different scope; categories return one entry.
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/categories")) {
        return new Response(JSON.stringify([{ ID: 1, Name: "Groceries", Kind: "expense", Bucket: "need", IsActive: true }]));
      }
      if (url.includes("/api/transactions")) {
        const txn = (merchant: string) => ({
          ID: merchant.length, PostedAt: "2026-06-10T00:00:00Z", AmountFils: 1000, Currency: "AED",
          Direction: "debit", MerchantRaw: merchant, Status: "needs_review", Confidence: 0, Source: "",
          CategoryID: null, CategoryName: "", Bucket: "",
        });
        if (url.includes("from=2026-06-01")) return new Response(JSON.stringify([txn("JUNE SHOP")]));
        if (url.includes("from=2026-05-01")) return new Response(JSON.stringify([txn("MAY SHOP")]));
        return new Response("[]"); // empty scope
      }
      return new Response("[]");
    }),
  );
}

function wrap(scope: Scope) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Review scope={scope} /></QueryClientProvider>);
}

beforeEach(() => stubFetch());

describe("Review screen", () => {
  it("queries scoped needs-review transactions", async () => {
    wrap({ kind: "month", period: "2026-06" });
    const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).includes("/api/transactions?status=needs_review&from=2026-06-01&to=2026-06-32"),
        ),
      ).toBe(true),
    );
  });

  it("shows a scope-aware empty state when nothing needs review", async () => {
    wrap({ kind: "month", period: "2026-03" }); // fetch returns [] for this month
    expect(await screen.findByText(/everything in mar 2026 is categorized/i)).toBeInTheDocument();
  });

  it("re-renders the deck when the scope changes", async () => {
    const { rerender } = wrap({ kind: "month", period: "2026-06" });
    expect(await screen.findByText("JUNE SHOP")).toBeInTheDocument();

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(<QueryClientProvider client={qc}><Review scope={{ kind: "month", period: "2026-05" }} /></QueryClientProvider>);
    expect(await screen.findByText("MAY SHOP")).toBeInTheDocument();
    expect(screen.queryByText("JUNE SHOP")).not.toBeInTheDocument();
  });
});
