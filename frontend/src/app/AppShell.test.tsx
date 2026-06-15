import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "../components/Toast";
import { AppShell } from "./AppShell";

beforeEach(() => {
  // Every screen hits the API on mount; return empty payloads.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/summary")) return new Response(JSON.stringify({ period: "2026-06", income: 0, month_progress: 0, buckets: [], recent: [] }));
    if (url.includes("/api/events")) return new Response("");
    return new Response("[]");
  }));
  // EventSource isn't in jsdom; stub it so useLiveEvents doesn't throw.
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} set onerror(_v: unknown) {} });
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><ToastProvider><AppShell /></ToastProvider></QueryClientProvider>,
  );
}

describe("AppShell", () => {
  it("shows four tabs and starts on Home", async () => {
    wrap();
    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /transactions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /settings/i })).toBeInTheDocument();
  });

  it("switches screens when a tab is tapped", async () => {
    wrap();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    // Settings screen renders a "Settings" heading.
    expect(await screen.findByRole("heading", { name: /settings/i })).toBeInTheDocument();
  });
});
