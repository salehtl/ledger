import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

const defaultSettings = { auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ai_key_present: true };
let ratesResponse: { rates: { currency: string; rate: number; updated_at: string }[]; missing: string[] } = {
  rates: [{ currency: "USD", rate: 3.6725, updated_at: "2026-07-01" }],
  missing: ["EUR"],
};

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/settings") return new Response(JSON.stringify(defaultSettings));
  if (url === "/api/categorize/status") return new Response(JSON.stringify({ status: "idle", processed: 0, total: 0, failed: 0, error: "" }));
  if (url === "/api/budget") return new Response(JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }));
  if (url === "/api/rules") return new Response(JSON.stringify([]));
  if (url === "/api/categories") return new Response(JSON.stringify([]));
  if (url === "/api/rates") return new Response(JSON.stringify(ratesResponse));
  if (/^\/api\/rates\/[A-Z]+$/.test(url) && init?.method === "PUT") return new Response("{}");
  if (/^\/api\/rates\/[A-Z]+$/.test(url) && init?.method === "DELETE") return new Response("{}");
  return new Response("[]");
});

beforeEach(() => {
  fetchMock.mockClear();
  ratesResponse = {
    rates: [{ currency: "USD", rate: 3.6725, updated_at: "2026-07-01" }],
    missing: ["EUR"],
  };
  vi.stubGlobal("fetch", fetchMock);
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Settings /></ToastProvider></QueryClientProvider>);
}

describe("Settings currency rates", () => {
  it("lists configured rates and missing currencies", async () => {
    renderSettings();
    expect(await screen.findByText("Currency Rates")).toBeInTheDocument();
    expect(await screen.findByText("USD")).toBeInTheDocument();
    expect(await screen.findByDisplayValue("3.6725")).toBeInTheDocument();
    expect(await screen.findByText(/EUR/)).toBeInTheDocument(); // missing-rate warning row
    expect(screen.getByText(/no rate configured/i)).toBeInTheDocument();
  });

  it("saves a rate via PUT /api/rates/{code}", async () => {
    renderSettings();
    const input = await screen.findByDisplayValue("3.6725");
    fireEvent.change(input, { target: { value: "3.68" } });
    fireEvent.click(screen.getByRole("button", { name: /save usd/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/rates/USD", expect.objectContaining({ method: "PUT" }));
    });
  });
});
