import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { Settings } from "./Settings";

const calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings") {
      if (init?.method === "PUT") {
        calls.push({ url, method: "PUT", body: JSON.parse(init.body as string) });
        return new Response("{}");
      }
      return new Response(JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85 }));
    }
    if (url === "/api/budget") return new Response(JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }));
    return new Response("[]");
  }));
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider><Settings /></ToastProvider></QueryClientProvider>);
}

describe("Settings categorization", () => {
  it("renders the auto-categorize switch reflecting current state", async () => {
    wrap();
    const toggle = await screen.findByLabelText(/auto-categorize/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("PUTs the new value when toggled off", async () => {
    wrap();
    const toggle = await screen.findByLabelText(/auto-categorize/i);
    fireEvent.click(toggle);
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && (c.body as { auto_categorize: boolean }).auto_categorize === false)).toBe(true));
  });
});
