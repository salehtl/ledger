// frontend/src/views/Dashboard.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "./Dashboard";
import type { Summary } from "../api/types";

const summary: Summary = {
  period: "2026-06", income: 1500000, month_progress: 0.5,
  buckets: [{ bucket: "need", target: 750000, spent: 100000, remaining: 650000, pct_used: 0.13, projection: 200000 }],
  recent: [],
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("Dashboard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(summary))));
  });
  it("shows an empty state when there are no recent transactions", async () => {
    wrap(<Dashboard />);
    expect(await screen.findByText(/no recent activity/i)).toBeInTheDocument();
  });
  it("renders the income header", async () => {
    wrap(<Dashboard />);
    expect(await screen.findByText(/income/i)).toBeInTheDocument();
  });
  it("shows error state when /api/summary fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("err", { status: 500 })));
    wrap(<Dashboard />);
    expect(await screen.findByText(/couldn't load summary/i)).toBeInTheDocument();
  });
});
