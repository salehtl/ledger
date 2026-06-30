import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Home } from "./Home";
import type { Summary, CategorySpend, MonthlyTotal } from "../api/types";

const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [
    { bucket: "need", target: 300000, spent: 210000, remaining: 90000, pct_used: 0.7, projection: 300000 },
    { bucket: "want", target: 200000, spent: 180000, remaining: 20000, pct_used: 0.9, projection: 240000 },
    { bucket: "saving", target: 100000, spent: 92000, remaining: 8000, pct_used: 0.92, projection: 100000 },
  ],
  recent: [
    { ID: 1, PostedAt: "2026-06-10", AmountFils: 5000, Currency: "AED", Direction: "debit", MerchantRaw: "SPINNEYS", Status: "confirmed", Confidence: 0, Source: "email", CategoryID: 1, CategoryName: "Groceries", Bucket: "need", Kind: "spending", BucketSnapshot: "" },
  ],
};
const cats: CategorySpend[] = [{ category_id: 1, name: "Groceries", bucket: "need", spent: 210000 }];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 482000, income: 1500000 }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Home /></QueryClientProvider>);
}

describe("Home", () => {
  it("shows the spent-this-month hero and budget", async () => {
    wrap();
    // 482000 fils => 4,820.00; 600000 => 6,000.00
    // findAllByText because the DonutChart center also renders the same value
    expect(await screen.findByText("Spent this month")).toBeInTheDocument();
    expect(screen.getAllByText(/4,820\.00/).length).toBeGreaterThan(0); // spent
    expect(screen.getByText(/6,000\.00/)).toBeInTheDocument(); // budget
  });

  it("surfaces pace: projection and an over-pace verdict", async () => {
    wrap();
    // projection 640000 > 600000 budget → over pace; want bucket also projects over
    expect((await screen.findAllByText("Over pace")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Projected/)).toBeInTheDocument();
    expect(screen.getByText(/50% of month gone/)).toBeInTheDocument();
  });

  it("lists the recent transactions", async () => {
    wrap();
    expect(await screen.findByText("SPINNEYS")).toBeInTheDocument();
  });

  it("aggregates over a multi-month range", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
      if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
      return new Response("[]");
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Home scope={{ kind: "range", from: "2026-03", to: "2026-06" }} />
      </QueryClientProvider>,
    );
    // Hero reflects the span, and the summary request carries from/to so the
    // server sums every month rather than just the latest.
    expect(await screen.findByText(/Mar–Jun 2026/)).toBeInTheDocument();
    expect(calls.some((u) => u.includes("from=2026-03") && u.includes("to=2026-06"))).toBe(true);
    // Pace/projection stay scoped to the live current month, not a span.
    expect(screen.queryByText(/Projected/)).not.toBeInTheDocument();
  });
});
