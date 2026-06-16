import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

const calls: { url: string; method: string }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/settings") return new Response(JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ai_key_present: true }));
    if (url === "/api/budget") return new Response(JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }));
    if (url === "/api/rules") return new Response(JSON.stringify([]));
    if (url === "/api/categories") return new Response(JSON.stringify([]));
    if (url === "/api/transactions") return new Response(JSON.stringify([{ ID: 1 }, { ID: 2 }, { ID: 3 }]));
    if (url === "/api/categorization/clear" && method === "POST") {
      calls.push({ url, method });
      return new Response(JSON.stringify({ cleared: 3 }));
    }
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Settings /></ToastProvider></QueryClientProvider>);
}

describe("Settings danger zone", () => {
  it("opens a confirm dialog showing the affected count", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /clear all categorization/i }));
    // Dialog mentions how many transactions are affected.
    expect(await screen.findByText(/3 transactions/i)).toBeInTheDocument();
    // Nothing posted yet — just opening the dialog.
    expect(calls.some((c) => c.url === "/api/categorization/clear")).toBe(false);
  });

  it("POSTs the clear and toasts on confirm", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /clear all categorization/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/categorization/clear" && c.method === "POST")).toBe(true));
    expect(await screen.findByText(/cleared 3 transactions/i)).toBeInTheDocument();
  });
});
