import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AiUsagePage } from "./AiUsagePage";
import * as client from "../../api/client";
import { ToastProvider } from "../../components/Toast";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{ui}</ToastProvider></QueryClientProvider>);
}

beforeEach(() => {
  // Mock getJSON (used for /api/settings) AND getAIUsage (which calls getJSON via a
  // local reference inside client.ts that a getJSON spy would NOT intercept).
  vi.spyOn(client, "getJSON").mockImplementation(async (url: string) => {
    if (url === "/api/settings")
      return { auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ingest_silence_days: 3, ai_key_present: true, ai_spend_cap_musd: 5_000_000, ai_cap_latched: true } as any;
    return {} as any;
  });
  vi.spyOn(client, "getAIUsage").mockResolvedValue({
    count_30d: 2, cost_30d_musd: 1_900_000, count_all: 5, cost_all_musd: 190_000_000, recent: [],
  } as any);
});

describe("AiUsagePage", () => {
  it("shows the latched banner and 30-day cost", async () => {
    wrap(<AiUsagePage onClose={() => {}} />);
    expect(await screen.findByText(/auto-disabled/i)).toBeInTheDocument();
    expect(await screen.findByText("$1.90")).toBeInTheDocument();
  });
});
