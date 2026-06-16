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
      return new Response(JSON.stringify({ auto_categorize: true, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85, ai_key_present: true }));
    }
    if (url === "/api/categorize/status") {
      return new Response(JSON.stringify({ status: "idle", processed: 0, total: 0 }));
    }
    if (url === "/api/categorize/run" && init?.method === "POST") {
      calls.push({ url, method: "POST", body: init.body ? JSON.parse(init.body as string) : null });
      return new Response(JSON.stringify({ started: true }));
    }
    if (url === "/api/categorize/stop" && init?.method === "POST") {
      calls.push({ url, method: "POST", body: null });
      return new Response(JSON.stringify({ stopped: true }));
    }
    if (url === "/api/budget") return new Response(JSON.stringify({ monthly_income: 0, need_pct: 0.5, want_pct: 0.3, saving_pct: 0.2, income_source: "config", freeze_history: false }));
    if (url === "/api/rules") return new Response(JSON.stringify([{ ID: 5, MatchType: "contains", Pattern: "spinneys", CategoryID: 1, Priority: 100, Source: "manual", IsActive: true }]));
    if (/^\/api\/rules\/\d+\/active$/.test(url) && init?.method === "PUT") {
      calls.push({ url, method: "PUT", body: JSON.parse(init.body as string) });
      return new Response("{}");
    }
    if (url === "/api/categories") return new Response(JSON.stringify([]));
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
    expect((await screen.findByLabelText(/ai auto-accept/i) as HTMLInputElement).disabled).toBe(true);
  });

  it("PUTs the new value when toggled off", async () => {
    wrap();
    const toggle = await screen.findByLabelText(/auto-categorize/i);
    fireEvent.click(toggle);
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PUT" && c.url === "/api/settings");
      expect(call).toBeDefined();
      expect(call!.body).toEqual({ auto_categorize: false, ai_enabled: false, ai_auto_accept: false, ai_threshold: 0.85 });
    });
  });

  it("shows the AI key status from the server", async () => {
    wrap();
    expect(await screen.findByText(/anthropic api key/i)).toBeInTheDocument();
    expect(screen.getByText(/^loaded$/i)).toBeInTheDocument();
  });

  it("starts a scoped categorization run", async () => {
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: /^run$/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url === "/api/categorize/run" && c.method === "POST");
      expect(call).toBeDefined();
      const body = call!.body as { from: string; to: string };
      expect(body.from).toMatch(/^\d{4}-\d{2}-01$/);
      expect(body.to).toMatch(/^\d{4}-\d{2}-32$/);
    });
  });

  it("toggles a rule's active state via PUT /api/rules/{id}/active", async () => {
    wrap();
    const ruleSwitch = await screen.findByLabelText(/rule 5 active/i) as HTMLInputElement;
    expect(ruleSwitch.checked).toBe(true);
    fireEvent.click(ruleSwitch);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/rules/5/active" && c.method === "PUT" && (c.body as { active: boolean }).active === false)).toBe(true));
  });
});
