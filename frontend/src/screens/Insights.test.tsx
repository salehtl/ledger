import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Insights } from "./Insights";
import type { CategorySpend, MonthlyTotal, Summary } from "../api/types";

const cats: CategorySpend[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 210000 },
  { category_id: 2, name: "Dining", bucket: "want", spent: 80000 },
];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 290000, income: 1500000 }];
const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [], recent: [],
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Insights scope={{ kind: "month", period: "2026-06" }} /></QueryClientProvider>);
}

describe("Insights", () => {
  it("shows the focus month and the comparative summary", async () => {
    wrap();
    expect(await screen.findByText("Jun 2026")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
  it("lists categories by spend with the biggest-changes block", async () => {
    wrap();
    // "Groceries" appears in both the donut legend and the category list.
    expect((await screen.findAllByText("Groceries")).length).toBeGreaterThan(0);
    expect(screen.getByText("Biggest changes")).toBeInTheDocument();
    expect(screen.getByText("By category")).toBeInTheDocument();
  });
});
