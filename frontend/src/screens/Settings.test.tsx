import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings, pctsValid } from "./Settings";
import { ToastProvider } from "../components/Toast";
import type { BudgetConfig } from "../api/types";

const budget: BudgetConfig = { monthly_income: 1500000, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/budget")) return new Response(JSON.stringify(budget));
    if (url === "/api/settings") return new Response(JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85 }));
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Settings /></ToastProvider></QueryClientProvider>);
}

describe("pctsValid", () => {
  it("accepts 50/30/20 and rejects others", () => {
    expect(pctsValid(0.5, 0.3, 0.2)).toBe(true);
    expect(pctsValid(0.5, 0.5, 0.2)).toBe(false);
  });
});

describe("Settings", () => {
  it("shows income in AED and splits as whole percents", async () => {
    wrap();
    expect((await screen.findByLabelText(/monthly income/i) as HTMLInputElement).value).toBe("15000");
    expect((screen.getByLabelText(/need %/i) as HTMLInputElement).value).toBe("50");
  });
});
