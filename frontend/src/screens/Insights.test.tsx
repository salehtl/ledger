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
  buckets: [], recent: [], project_excluded: 0,
};
const monthTxns: Txn[] = [
  {
    ID: 1, PostedAt: "2026-06-10T12:00:00Z", AmountFils: 5000, AmountAedFils: 5000, Currency: "AED",
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
    if (url.includes("/api/reports/networth")) return new Response(JSON.stringify({ months: [] }));
    if (url.includes("/api/reports/income-expense")) {
      return new Response(JSON.stringify({ months: [], rows: [], net_by_month_fils: [] }));
    }
    if (url.includes("/api/reports/age-of-money")) {
      return new Response(JSON.stringify({ age_days: 24, sample_size: 10 }));
    }
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
  it("offers the analyze-by lens and lists categories by default", async () => {
    wrap();
    expect(await screen.findByText("Analyze by")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merchants" })).toBeInTheDocument();
    // default lens = categories → category rows are shown
    expect(screen.getByText("Groceries")).toBeInTheDocument();
    expect(screen.getByText("Dining")).toBeInTheDocument();
    // the biggest-changes (top movers) block is still present
    expect(screen.getByText("Biggest changes")).toBeInTheDocument();
  });
  it("switches the lens to Merchants and ranks merchants", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Merchants" }));
    expect(await screen.findByRole("button", { name: /see transactions for Deliveroo/i })).toBeInTheDocument();
  });
  it("opens the drill-down sheet when a bucket is tapped", async () => {
    wrap();
    const wantsButtons = await screen.findAllByRole("button", { name: /Wants/ });
    fireEvent.click(wantsButtons[0]);
    // The drill-down sheet shows the bucket's transaction (title + row).
    expect((await screen.findAllByText("Deliveroo")).length).toBeGreaterThan(0);
  });

  it("shows the reports entry tiles with their stats", async () => {
    wrap();
    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Net worth/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Income v expense/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Spending trends/ })).toBeInTheDocument();
    // The age-of-money stat lands on its tile once the query resolves.
    expect(await screen.findByText("24 days")).toBeInTheDocument();
    expect(screen.getByText(/last 10 spends/)).toBeInTheDocument();
  });

  it("a still-loading report tile shows a loading stat, not the empty dash", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
      if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
      if (url.includes("/api/summary")) return new Response(JSON.stringify(summary));
      if (url.includes("/api/transactions")) return new Response(JSON.stringify(monthTxns));
      if (url.includes("/api/categories")) return new Response(JSON.stringify([]));
      if (url.includes("/api/budget")) return new Response(JSON.stringify(budget));
      if (url.includes("/api/reports/networth")) return new Response(JSON.stringify({ months: [] }));
      // Age of money never resolves: its tile must read as loading.
      if (url.includes("/api/reports/age-of-money")) return new Promise<Response>(() => {});
      return new Response("[]");
    }));
    wrap();
    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("loading…")).toBeInTheDocument();
    // The loaded not-computable copy must not appear while the query is open.
    expect(screen.queryByText("needs more history")).not.toBeInTheDocument();
  });

  it("a tile opens the full-screen reports drill-in", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /Age of money/ }));
    // Reports content mounts over Insights (trends header meta is unique to it).
    expect(await screen.findByText("year over year")).toBeInTheDocument();
    expect(await screen.findByText("No balance check-ins yet")).toBeInTheDocument();
  });

  it("still renders the buckets lens and its labels when a bucket is over budget", async () => {
    // summary.buckets carries pct_used for the focus month; "want" at/over its
    // target should thread through to a solid density on both the hero split
    // (ComparativeSummary) and the buckets-lens row (LensBreakdown) without
    // breaking rendering or dropping the bucket's visible text label.
    const overBudgetSummary: Summary = {
      ...summary,
      buckets: [
        { bucket: "need", target: 300000, spent: 210000, remaining: 90000, pct_used: 0.7, projection: 300000 },
        { bucket: "want", target: 100000, spent: 130000, remaining: -30000, pct_used: 1.3, projection: 130000 },
        { bucket: "saving", target: 100000, spent: 10000, remaining: 90000, pct_used: 0.1, projection: 10000 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/insights/categories")) return new Response(JSON.stringify(cats));
      if (url.includes("/api/insights/trend")) return new Response(JSON.stringify(trend));
      if (url.includes("/api/summary")) return new Response(JSON.stringify(overBudgetSummary));
      if (url.includes("/api/transactions")) return new Response(JSON.stringify(monthTxns));
      if (url.includes("/api/categories")) return new Response(JSON.stringify([]));
      if (url.includes("/api/budget")) return new Response(JSON.stringify(budget));
      return new Response("[]");
    }));
    wrap();
    // Hero legend (ComparativeSummary) still names every bucket.
    expect((await screen.findAllByText("Wants")).length).toBeGreaterThan(0);
    // Switch to the buckets lens; its row label survives too.
    fireEvent.click(await screen.findByRole("button", { name: "Buckets" }));
    expect((await screen.findAllByText("Wants")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Needs")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("Savings")).length).toBeGreaterThan(0);
  });
});
