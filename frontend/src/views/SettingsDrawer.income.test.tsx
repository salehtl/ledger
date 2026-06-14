import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsDrawer } from "./SettingsDrawer";
import type { BudgetConfig } from "../api/types";

const budget: BudgetConfig = {
  monthly_income: 1500000, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2,
  income_source: "config", freeze_history: false,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SettingsDrawer income", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/budget") return new Response(JSON.stringify(budget));
      return new Response("[]");
    }));
  });
  it("displays monthly income in AED, not raw fils", async () => {
    wrap(<SettingsDrawer onClose={() => {}} />);
    const input = await screen.findByLabelText(/monthly income/i) as HTMLInputElement;
    expect(input.value).toBe("15000"); // 1,500,000 fils -> 15000 AED
  });
  it("shows budget splits as whole percents", async () => {
    wrap(<SettingsDrawer onClose={() => {}} />);
    const need = await screen.findByLabelText(/need %/i) as HTMLInputElement;
    expect(need.value).toBe("50");
  });
});
