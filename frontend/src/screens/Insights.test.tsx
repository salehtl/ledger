import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Insights } from "./Insights";
import { ToastProvider } from "../components/Toast";
import type { CategorySpend, MonthlyTotal, Summary, Txn, BudgetConfig } from "../api/types";

const cats: CategorySpend[] = [
  { category_id: 1, name: "Groceries", bucket: "need", spent: 210000 },
  { category_id: 2, name: "Dining", bucket: "want", spent: 80000 },
];
const trend: MonthlyTotal[] = [{ period: "2026-06", spent: 290000, income: 1500000 }];
const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [], recent: [],
};
const monthTxns: Txn[] = [
  {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 5000, Currency: "AED",
    Direction: "debit", MerchantRaw: "Deliveroo", Status: "confirmed", Confidence: 1,
    Source: "email", CategoryID: 2, CategoryName: "Dining", Bucket: "want",
    Kind: "spending", BucketSnapshot: "want",
  },
];
const budget: BudgetConfig = {
  monthly_income: 1500000, need_pct: 50, want_pct: 30, saving_pct: 20,
  income_source: "fixed", freeze_history: false,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
    if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
    if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
    if (url.includes("/api/transactions")) return new Response(JSON.stringify(monthTxns));
    if (url.includes("/api/categories")) return new Response(JSON.stringify([]));
    if (url.includes("/api/budget")) return new Response(JSON.stringify(budget));
    return new Response("[]");
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <Insights scope={{ kind: "month", period: "2026-06" }} />
      </ToastProvider>
    </QueryClientProvider>
  );
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
  it("shows the Top merchants card and opens the drill-down sheet when a bucket is tapped", async () => {
    wrap();
    // Wait for top merchants card to appear (requires monthTxns to load)
    expect(await screen.findByText(/top merchants/i)).toBeInTheDocument();
    // Tap the first "Wants" bucket row (in ComparativeSummary) to open the drill-down sheet
    const wantsButtons = await screen.findAllByRole("button", { name: /Wants/ });
    fireEvent.click(wantsButtons[0]);
    // The drill-down sheet should show the transaction (may appear in multiple places)
    expect((await screen.findAllByText("Deliveroo")).length).toBeGreaterThan(0);
  });
});
